import test from "node:test";
import assert from "node:assert/strict";
import { clientFixture, protocol, settled } from "./helpers/lsp-client.ts";
import { latch } from "./helpers/latch.ts";
import type { LspResolvedTarget, LspTargetContext } from "../src/protocol/index.ts";
const { createLspNavigationClient, createLspRenameClient, createLspActionClient, LspLineIndex, RpcError, ProtocolDecodeError } = protocol;
const uri = "host+opaque:unopened%2Fmodule";
const range = { start: { line: 0, character: 6 }, end: { line: 0, character: 10 } };
const stale = (error: unknown) => error instanceof RpcError && error.code === -32801;
const cancelled = (error: unknown) => error instanceof RpcError && error.code === -32800;
async function retained(f: ReturnType<typeof clientFixture>, addressed = uri) {
    const document = f.workspace.document(f.other.documentId), lease = f.workspace.acquire(document.resourceId);
    const metadata = f.other.metadata.getSnapshot(), index = await LspLineIndex.create(document.buffer, settled); let released = 0;
    return { get released() { return released; }, value: Object.freeze({ target: Object.freeze({
        document: Object.freeze({ uri: addressed, languageId: "generic", resourceId: document.resourceId, documentId: document.id, revision: document.revision, buffer: document.buffer }), index, version: null,
        isCurrent: () => !released && f.workspace.document(document.id) === document && f.other.metadata.getSnapshot() === metadata,
    }), release: () => { released++; lease.release(); } }) satisfies LspResolvedTarget };
}

test("target checks visit the captured project once per pass and retain independent target guards", async t => {
    const leases: Awaited<ReturnType<typeof retained>>[] = [];
    const f = clientFixture(t, undefined, async addressed => { const lease = await retained(f, addressed); leases.push(lease); return lease.value; }),
        client = createLspNavigationClient(f.provider); t.after(client.dispose);
    const resources = [f.source, ...Array.from({ length: 19 }, (_, i) => f.workspace.createTextResource(
        { scope: "project", resource: `${i}`, variant: "working" }, `Source ${i}`, { value: "source" }))];
    const snapshots = resources.map(resource => f.workspace.document(resource.documentId));
    f.peer.onRequest("textDocument/references", () => Array.from({ length: 40 }, (_, i) => ({ uri: `${uri}/${i}`, range })));
    let visits = 0; const observe = f.workspace.observeDocument;
    Reflect.set(f.workspace, "observeDocument", (...args: Parameters<typeof observe>) => { visits++; return observe.apply(f.workspace, args); });
    t.after(() => Reflect.set(f.workspace, "observeDocument", observe));
    const result = await client.run(snapshots, f.source.documentId, 0, "references"), loadingVisits = visits; visits = 0;
    assert.equal(result.isCurrent(), true); assert.equal(visits, resources.length);
    assert.ok(loadingVisits < 12 * resources.length * leases.length, `Loading repeatedly visited the whole captured project: ${loadingVisits}`);
    t.diagnostic(JSON.stringify({ documents: resources.length, targets: leases.length, loadingVisits, currentVisits: visits }));
    const target = result.locations[0]!.target; assert.equal(target.isCurrent(), true);
    const before = f.document(); f.edit(); assert.notEqual(f.document().revision, before.revision);
    assert.equal(result.isCurrent(), false); assert.equal(target.isCurrent(), false);
    client.cancel(); await settled(); assert.equal(leases.length, 40); assert.ok(leases.every(lease => lease.released === 1));
});

test("navigation resolves an opaque target once without synchronizing it, and retains its independent revision", async t => {
    let calls = 0, context: LspTargetContext | undefined, lease: Awaited<ReturnType<typeof retained>> | undefined;
    const f = clientFixture(t, undefined, async (addressed, captured) => { calls++; context = captured; assert.equal(addressed, uri); lease = await retained(f);
        return { ...lease.value, target: { ...lease.value.target, isCurrent: () => captured.isCurrent() && lease!.value.target.isCurrent() } }; });
    const client = createLspNavigationClient(f.provider); t.after(client.dispose);
    f.peer.onRequest("textDocument/definition", () => [{ uri, range }, { uri, range }]);
    const source = f.document(), result = await client.run([source], source.id, 6, "definition");
    assert.equal(calls, 1); assert.equal(result.locations.length, 2); assert.equal(context!.purpose, "navigation");
    assert.equal(context!.source!.documentId, source.id); assert.equal(result.locations[0]!.target.document.documentId, f.other.documentId);
    assert.equal(result.locations[0]!.from, 6); assert.equal(f.sent("textDocument/didOpen").length, 1); assert.equal(result.isCurrent(), true);
    const doc = f.workspace.document(f.other.documentId);
    f.workspace.edit({ documentId: doc.id, expectedRevision: doc.revision, edits: [{ from: 0, to: 0, insert: "changed " }], origin: "human" });
    assert.equal(result.isCurrent(), false); client.cancel(); await settled(); assert.equal(lease!.released, 1); assert.equal(f.workspace.diagnostics().leases, 1);
    client.dispose(); await settled(); assert.equal(f.workspace.diagnostics().leases, 0);
});

test("target cancellation and deferred release failures are reported without stopping cleanup", async t => {
    let context!: LspTargetContext, lease!: Awaited<ReturnType<typeof retained>>;
    const f = clientFixture(t, undefined, async (_uri, captured) => {
        context = captured; context.onCancel(async () => { throw new Error("Target cancellation failure"); }); lease = await retained(f);
        return { ...lease.value, release: async () => { lease.value.release(); throw new Error("Target release failure"); } };
    });
    const client = createLspNavigationClient(f.provider); t.after(client.dispose);
    f.peer.onRequest("textDocument/definition", () => [{ uri, range }]); const source = f.document();
    await client.run([source], source.id, 6, "definition"); client.cancel();
    context.onCancel(() => { throw new Error("Late target cancellation failure"); }); await settled();
    assert.deepEqual(f.errors.splice(0).sort(), ["Late target cancellation failure", "Target cancellation failure", "Target release failure"]);
    assert.equal(lease.released, 1); assert.equal(f.workspace.diagnostics().leases, 1); assert.equal(f.provider.state.getSnapshot().phase, "ready");
    client.dispose(); await settled(); assert.equal(f.workspace.diagnostics().leases, 0);
});

for (const stop of ["cancel", "dispose", "supersede", "disconnect"] as const) test(`${stop} settles target loading promptly and releases a late host result exactly once`, async t => {
    const entered = latch<void>(), answer = latch<LspResolvedTarget>(); let cancellations = 0;
    const f = clientFixture(t, undefined, async (_uri, context) => { context.onCancel(() => cancellations++); entered.resolve(); return answer.promise; });
    const client = createLspNavigationClient(f.provider); t.after(client.dispose);
    f.peer.onRequest("textDocument/definition", () => [{ uri, range }]); const source = f.document();
    const pending = client.run([source], source.id, 6, "definition"), rejected = assert.rejects(pending, cancelled); await entered.promise;
    const lease = await retained(f);
    if (stop === "disconnect") f.provider.disconnect();
    else if (stop === "supersede") { f.peer.onRequest("textDocument/definition", () => []); assert.equal((await client.run([source], source.id, 0, "definition")).isCurrent(), true); }
    else client[stop]();
    await rejected; assert.equal(cancellations, 1); answer.resolve(lease.value); await settled(); assert.equal(lease.released, 1);
    client.dispose(); await settled(); assert.equal(f.workspace.diagnostics().leases, 0);
});

test("source edits and mismatched target identities reject a loaded result without publishing it", async t => {
    const entered = latch<void>(), answer = latch<LspResolvedTarget>();
    const f = clientFixture(t, undefined, async () => { entered.resolve(); return answer.promise; }), client = createLspNavigationClient(f.provider); t.after(client.dispose);
    f.peer.onRequest("textDocument/definition", () => [{ uri, range }]); const source = f.document();
    const pending = client.run([source], source.id, 6, "definition"), rejected = assert.rejects(pending, stale); await entered.promise;
    const lease = await retained(f); f.edit(); answer.resolve(lease.value); await rejected; await settled(); assert.equal(lease.released, 1);
    const other = clientFixture(t, undefined, async () => (await retained(other, "wrong:uri")).value), next = createLspNavigationClient(other.provider); t.after(next.dispose);
    other.peer.onRequest("textDocument/definition", () => [{ uri, range }]); const origin = other.document();
    await assert.rejects(next.run([origin], origin.id, 0, "definition"), /does not match/); await settled(); assert.equal(other.workspace.diagnostics().leases, 0);
});

test("malformed location and edit tails reject before any host loading", async t => {
    let loads = 0; const f = clientFixture(t, undefined, async () => { loads++; return undefined; });
    const navigation = createLspNavigationClient(f.provider), rename = createLspRenameClient(f.provider); t.after(() => { navigation.dispose(); rename.dispose(); });
    const source = f.document();
    f.peer.onRequest("textDocument/definition", () => [{ uri, range }, { uri, range: { start: { line: -1, character: 0 }, end: range.end } }]);
    await assert.rejects(navigation.run([source], source.id, 0, "definition"), ProtocolDecodeError);
    f.peer.onRequest("textDocument/rename", () => ({ changes: { [uri]: [{ range, newText: "value" }, { range, newText: 42 }] } }));
    await assert.rejects(rename.run([source], source.id, 0, "value"), ProtocolDecodeError); assert.equal(loads, 0);
});

test("rename and resolved actions retain unloaded null-version edit targets through atomic host application", async t => {
    const purposes: string[] = [], leases: Awaited<ReturnType<typeof retained>>[] = [];
    const f = clientFixture(t, undefined, async (_uri, context) => { purposes.push(context.purpose); const lease = await retained(f); leases.push(lease); return lease.value; });
    const rename = createLspRenameClient(f.provider), actions = createLspActionClient(f.provider); t.after(() => { rename.dispose(); actions.dispose(); });
    const source = f.document(), edit = { documentChanges: [{ textDocument: { uri, version: null }, edits: [{ range: { ...range, end: { line: 0, character: 11 } }, newText: "omega" }] }] };
    f.peer.onRequest("textDocument/rename", () => edit);
    const plan = await rename.run([source], source.id, 6, "omega"); assert.equal(plan.isCurrent(), true);
    f.workspace.editDocuments(plan.documents.map(item => ({ documentId: f.other.documentId, expectedRevision: item.target.document.revision, edits: item.edits, origin: "human" })));
    assert.equal(f.workspace.document(f.other.documentId).text(), "gamma omega"); assert.equal(plan.isCurrent(), false);
    rename.cancel(); await settled(); assert.equal(leases[0]!.released, 1);
    f.peer.onRequest("textDocument/codeAction", () => [{ title: "lazy", data: { key: 1 } }]);
    f.peer.onRequest("codeAction/resolve", (value: object) => ({ ...value, edit }));
    const batch = await actions.run([source], source.id, 6, 10), action = await batch.resolve(batch.actions[0]!);
    assert.equal(action.edit!.documents[0]!.target.version, null); assert.deepEqual(purposes, ["edit", "edit"]);
    actions.cancel(); await settled(); assert.equal(action.edit!.isCurrent(), false); assert.equal(leases[1]!.released, 1);
});

test("a closed target cannot satisfy an invented wire version or bypass read-only host authority", async t => {
    const f = clientFixture(t, undefined, async () => (await retained(f)).value), client = createLspRenameClient(f.provider); t.after(client.dispose);
    const source = f.document();
    f.peer.onRequest("textDocument/rename", () => ({ documentChanges: [{ textDocument: { uri, version: 1 }, edits: [{ range, newText: "new" }] }] }));
    await assert.rejects(client.run([source], source.id, 6, "new"), stale); await settled(); assert.equal(f.workspace.diagnostics().leases, 0);
    f.workspace.setCapabilities(f.other.id, { ...f.other.metadata.getSnapshot().capabilities, edit: [] });
    f.peer.onRequest("textDocument/rename", () => ({ changes: { [uri]: [{ range, newText: "new" }], [`generic:${source.resourceId}`]: [{ range, newText: "new" }] } }));
    const plan = await client.run([source], source.id, 6, "new");
    const applied = f.workspace.editDocuments(plan.documents.map(item => ({ documentId: item.target.document.documentId as typeof source.id,
        expectedRevision: item.target.document.revision, edits: item.edits, origin: "human" })));
    assert.equal(applied.applied, false);
    assert.equal(f.document(), source); assert.equal(f.workspace.document(f.other.documentId).text(), "gamma delta");
});

test("server-proposed edits resolve through the same host policy and release targets after the decision", async t => {
    let context: LspTargetContext | undefined, lease: Awaited<ReturnType<typeof retained>> | undefined;
    const f = clientFixture(t, undefined, async (_uri, captured) => { context = captured; lease = await retained(f); return lease.value; });
    const client = createLspActionClient(f.provider); t.after(client.dispose); const source = f.document();
    f.peer.onRequest("textDocument/codeAction", () => [{ title: "command", command: "fixture.command" }]);
    f.peer.onRequest("workspace/executeCommand", async () => f.peer.sendRequest("workspace/applyEdit", { edit: { changes: { [uri]: [{ range, newText: "new" }] } } }));
    const batch = await client.run([source], source.id, 6, 10);
    const receipt = await batch.execute(batch.actions[0]!, { snapshots: () => [f.document()], isCurrent: () => true,
        review: async (request, context) => { assert.equal(request.edit.documents[0]!.target.document.uri, uri);
            context.onCancel(() => { throw new Error("Review cancellation failure"); }); return { applied: false, failureReason: "Host declined" }; } });
    assert.deepEqual(receipt.decision, { applied: false, failureReason: "Host declined" }); assert.equal(context!.source, null); assert.equal(context!.purpose, "edit");
    await settled(); assert.equal(lease!.released, 1); assert.deepEqual(f.errors.splice(0), ["Review cancellation failure"]);
});
