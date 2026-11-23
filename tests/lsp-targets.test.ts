import test from "node:test";
import assert from "node:assert/strict";
import { clientFixture, protocol, settled } from "./helpers/lsp-client.ts";
import { latch } from "./helpers/latch.ts";
import type { DocumentId } from "../src/index.ts";
import type { LspTargetSource, LspTargetContext } from "../src/protocol/index.ts";
const { createLspNavigationClient, createLspRenameClient, createLspActionClient, RpcError, ProtocolDecodeError } = protocol;
const uri = "host+opaque:unopened%2Fmodule";
const range = { start: { line: 0, character: 6 }, end: { line: 0, character: 10 } };
const stale = (error: unknown) => error instanceof RpcError && error.code === -32801;
const cancelled = (error: unknown) => error instanceof RpcError && error.code === -32800;
function retained(f: ReturnType<typeof clientFixture>, addressed = uri) {
    f.workspace.setDocumentLanguage(f.other.documentId, { uri: addressed, languageId: "generic" });
    let released = 0;
    const value = { document: f.workspace.document(f.other.documentId), release: () => { released++; } } satisfies LspTargetSource;
    return { get released() { return released; }, value };
}

test("a large unopened target yields with a stopped clock and cancels an outstanding index turn", async t => {
    const line = "amount\r\n😀\r", lines = Math.ceil(524288 / line.length), text = line.repeat(lines) + "end";
    const tail = { start: { line: lines * 2 - 1, character: 0 }, end: { line: lines * 2 - 1, character: 2 } };
    const parked = latch<void>();
    let loading = false, hold = false, turns = 0, cancelledTurn = false, releases = 0;
    const f = clientFixture(t, undefined, async () => {
        loading = true;
        return { text, languageId: "generic", release: () => { releases++; } };
    }, { now: () => 0, schedule(ms, run) {
        if (loading && ms === 0) {
            turns++;
            if (hold) { parked.resolve(); return () => { cancelledTurn = true; }; }
        }
        const timer = setTimeout(run, ms); return () => clearTimeout(timer);
    } });
    const client = createLspNavigationClient(f.provider); t.after(client.dispose);
    f.peer.onRequest("textDocument/definition", () => [{ uri, range: tail }]);
    const lookup = () => client.run({ document: f.document(), offset: 0, kind: "definition" });
    const answer = await lookup().result, location = answer.locations[0]!;
    assert.equal(turns, 1); assert.equal(location.target.document.buffer.slice(location.from, location.to), "😀");
    client.cancel(); await settled(); assert.equal(answer.isCurrent(), false); assert.equal(releases, 1);
    loading = false; hold = true;
    const call = lookup(), rejected = assert.rejects(call.result, cancelled);
    await parked.promise; call.cancel(); await rejected; await settled();
    assert.equal(cancelledTurn, true); assert.equal(releases, 2);
    client.dispose(); await settled(); assert.equal(f.workspace.diagnostics().leases, 0);
});

test("reference loads overlap within a bound, preserve wire order and release siblings of a declined URI", async t => {
    const firstFour = latch<void>(), gates = Array.from({ length: 6 }, () => latch<void>());
    const started: number[] = [], released: number[] = [];
    let decline = false;
    const f = clientFixture(t, undefined, async addressed => {
        const id = Number(addressed.slice(-1)); started.push(id);
        if (started.length === 4) firstFour.resolve();
        await gates[id]!.promise;
        if (decline && id === 1) return;
        return { text: "const name", languageId: "generic", release: () => { released.push(id); } };
    });
    const client = createLspNavigationClient(f.provider); t.after(client.dispose);
    const order = [0, 1, 2, 3, 4, 5, 0];
    f.peer.onRequest("textDocument/references", () => order.map(id => ({ uri: uri + id, range })));
    const lookup = () => client.run({ document: f.document(), offset: 0, kind: "references" }).result;
    const result = lookup(); await firstFour.promise;
    assert.deepEqual(started, [0, 1, 2, 3]);
    for (const id of [3, 2, 5, 4, 1, 0]) { gates[id]!.resolve(); await settled(); }
    assert.deepEqual((await result).locations.map(item => item.target.document.uri), order.map(id => uri + id));
    assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
    client.cancel(); await settled(); assert.deepEqual(released.sort(), [0, 1, 2, 3, 4, 5]);

    decline = true; released.length = started.length = 0;
    for (let i = 0; i < 6; i++) gates[i] = latch<void>();
    const refused = assert.rejects(lookup(), /target is unavailable/);
    gates[1]!.resolve(); await refused;
    for (const gate of gates) gate.resolve();
    await settled(); assert.deepEqual(started, [0, 1, 2, 3]); assert.deepEqual(released.sort(), [0, 2, 3]);
    client.dispose(); await settled(); assert.equal(f.workspace.diagnostics().leases, 0);
});

test("read-only target text survives an opened view and cannot supply editable workspace contents", async t => {
    let releases = 0;
    const f = clientFixture(t, undefined, async () => ({ text: "first\rline 😀", languageId: "generic", release: () => { releases++; } }));
    const navigation = createLspNavigationClient(f.provider), rename = createLspRenameClient(f.provider);
    t.after(() => { navigation.dispose(); rename.dispose(); });
    const source = f.document(), targetRange = { start: { line: 1, character: 5 }, end: { line: 1, character: 7 } };
    f.peer.onRequest("textDocument/definition", () => [{ uri, range: targetRange }]);
    const result = await navigation.run({ document: source, offset: 0, kind: "definition" }).result, location = result.locations[0]!;
    const id = location.target.document.documentId as DocumentId, doc = f.workspace.document(id);
    assert.equal(doc.buffer.slice(location.from, location.to), "😀"); assert.equal(doc.language?.uri, uri);
    assert.ok(!f.workspace.getSnapshot().documents.includes(doc)); assert.equal(f.sent("textDocument/didOpen").length, 1);
    const view = f.workspace.createDocumentView(id);
    navigation.cancel(); await settled(); assert.equal(releases, 1); assert.equal(f.workspace.document(id), doc);
    assert.deepEqual(f.workspace.edit({ documentId: id, expectedRevision: 0, origin: "human", edits: [{ from: 0, to: 0, insert: "!" }] }), { applied: false, reason: "read-only" });
    view.dispose(); await settled(); assert.throws(() => f.workspace.document(id));
    f.peer.onRequest("textDocument/rename", () => ({ changes: { [uri]: [{ range, newText: "new" }] } }));
    await assert.rejects(rename.run({ document: source, offset: 0, newName: "new" }).result, /requires a project document/); assert.equal(releases, 2);
});

test("target checks visit the captured project once per pass and retain independent target guards", async t => {
    const leases: ReturnType<typeof retained>[] = [];
    const f = clientFixture(t, undefined, async () => { const lease = retained(f); leases.push(lease); return { text: lease.value.document.buffer, languageId: "generic", release: lease.value.release }; }),
        client = createLspNavigationClient(f.provider); t.after(client.dispose);
    const resources = [f.source, ...Array.from({ length: 19 }, (_, i) => f.workspace.createTextResource(
        { scope: "project", resource: `${i}`, variant: "working" }, `Source ${i}`, { value: "source" }, undefined, { language: { uri: `generic:extra/${i}`, languageId: "generic" } }))];
    const snapshots = resources.map(resource => f.workspace.document(resource.documentId));
    f.peer.onRequest("textDocument/references", () => Array.from({ length: 40 }, (_, i) => ({ uri: `${uri}/${i}`, range })));
    let visits = 0; const observe = f.workspace.observeDocument;
    Reflect.set(f.workspace, "observeDocument", (...args: Parameters<typeof observe>) => { visits++; return observe.apply(f.workspace, args); });
    t.after(() => Reflect.set(f.workspace, "observeDocument", observe));
    const result = await client.run({ document: f.document(), project: snapshots, offset: 0, kind: "references" }).result, loadingVisits = visits; visits = 0;
    assert.equal(result.isCurrent(), true); assert.equal(visits, resources.length);
    assert.ok(loadingVisits < 12 * resources.length * leases.length, `Loading repeatedly visited the whole captured project: ${loadingVisits}`);
    t.diagnostic(JSON.stringify({ documents: resources.length, targets: leases.length, loadingVisits, currentVisits: visits }));
    const target = result.locations[0]!.target; assert.equal(target.isCurrent(), true);
    const before = f.document(); f.edit(); assert.notEqual(f.document().revision, before.revision);
    assert.equal(result.isCurrent(), false); assert.equal(target.isCurrent(), false);
    client.cancel(); await settled(); assert.equal(leases.length, 40); assert.ok(leases.every(lease => lease.released === 1));
});

test("navigation resolves an opaque target once without synchronizing it, and retains its independent revision", async t => {
    let calls = 0, context: LspTargetContext | undefined, lease: ReturnType<typeof retained> | undefined;
    const f = clientFixture(t, undefined, async (addressed, captured) => { calls++; context = captured; assert.equal(addressed, uri); lease = retained(f);
        return lease.value; });
    const client = createLspNavigationClient(f.provider); t.after(client.dispose);
    f.peer.onRequest("textDocument/definition", () => [1, 2].map(() => ({ targetUri: uri, targetRange: range, targetSelectionRange: range, originSelectionRange: range })));
    const source = f.document(), call = client.prepareDefinition({ document: source, offset: 6 });
    const preview = await call.result; call.cancel();
    assert.deepEqual(preview.originRange, { from: 6, to: 10 }); assert.equal(preview.hasTargets, true); assert.equal(calls, 0);
    const [result, same] = await Promise.all([preview.resolve(), preview.resolve()]);
    assert.equal(result, same); assert.equal(f.sent("textDocument/definition").length, 1);
    assert.equal(calls, 1); assert.equal(result.locations.length, 2); assert.equal(context!.purpose, "navigation");
    assert.equal(context!.source!.documentId, source.id); assert.equal(result.locations[0]!.target.document.documentId, f.other.documentId);
    assert.equal(result.locations[0]!.from, 6); assert.equal(f.sent("textDocument/didOpen").length, 1); assert.equal(result.isCurrent(), true);
    const doc = f.workspace.document(f.other.documentId);
    f.workspace.edit({ documentId: doc.id, expectedRevision: doc.revision, edits: [{ from: 0, to: 0, insert: "changed " }], origin: "human" });
    assert.equal(result.isCurrent(), false); client.cancel(); await settled(); assert.equal(lease!.released, 1); assert.equal(f.workspace.diagnostics().leases, 1);
    client.dispose(); await settled(); assert.equal(f.workspace.diagnostics().leases, 0);
});

test("target cancellation and deferred release failures are reported without stopping cleanup", async t => {
    let context!: LspTargetContext, lease!: ReturnType<typeof retained>;
    const f = clientFixture(t, undefined, async (_uri, captured) => {
        context = captured; context.onCancel(async () => { throw new Error("Target cancellation failure"); }); lease = retained(f);
        return { ...lease.value, release: async () => { lease.value.release(); throw new Error("Target release failure"); } };
    });
    const client = createLspNavigationClient(f.provider); t.after(client.dispose);
    f.peer.onRequest("textDocument/definition", () => [{ uri, range }]); const source = f.document();
    await client.run({ document: source, offset: 6, kind: "definition" }).result; client.cancel();
    context.onCancel(() => { throw new Error("Late target cancellation failure"); }); await settled();
    assert.deepEqual(f.errors.splice(0).sort(), ["Late target cancellation failure", "Target cancellation failure", "Target release failure"]);
    assert.equal(lease.released, 1); assert.equal(f.workspace.diagnostics().leases, 1); assert.equal(f.provider.getSnapshot().phase, "ready");
    client.dispose(); await settled(); assert.equal(f.workspace.diagnostics().leases, 0);
});

for (const stop of ["cancel", "dispose", "supersede", "disconnect"] as const) test(`${stop} settles target loading promptly and releases a late host result exactly once`, async t => {
    const entered = latch<void>(), answer = latch<LspTargetSource>(); let cancellations = 0;
    const f = clientFixture(t, undefined, async (_uri, context) => { context.onCancel(() => cancellations++); entered.resolve(); return answer.promise; });
    const client = createLspNavigationClient(f.provider); t.after(client.dispose);
    f.peer.onRequest("textDocument/definition", () => [{ uri, range }]); const source = f.document();
    const call = client.run({ document: source, offset: 6, kind: "definition" }), rejected = assert.rejects(call.result, cancelled); await entered.promise;
    const lease = retained(f);
    if (stop === "disconnect") f.provider.disconnect();
    else if (stop === "supersede") { f.peer.onRequest("textDocument/definition", () => []); assert.equal((await client.run({ document: source, offset: 0, kind: "definition" }).result).isCurrent(), true); }
    else if (stop === "cancel") call.cancel();
    else client.dispose();
    await rejected; assert.equal(cancellations, 1); answer.resolve(lease.value); await settled(); assert.equal(lease.released, 1);
    client.dispose(); await settled(); assert.equal(f.workspace.diagnostics().leases, 0);
});

test("source edits and mismatched target identities reject a loaded result without publishing it", async t => {
    const entered = latch<void>(), answer = latch<LspTargetSource>();
    const f = clientFixture(t, undefined, async () => { entered.resolve(); return answer.promise; }), client = createLspNavigationClient(f.provider); t.after(client.dispose);
    f.peer.onRequest("textDocument/definition", () => [{ uri, range }]); const source = f.document();
    const pending = client.run({ document: source, offset: 6, kind: "definition" }).result, rejected = assert.rejects(pending, stale); await entered.promise;
    const lease = retained(f); f.edit(); answer.resolve(lease.value); await rejected; await settled(); assert.equal(lease.released, 1);
    const other = clientFixture(t, undefined, async () => retained(other, "wrong:uri").value), next = createLspNavigationClient(other.provider); t.after(next.dispose);
    other.peer.onRequest("textDocument/definition", () => [{ uri, range }]); const origin = other.document();
    await assert.rejects(next.run({ document: origin, offset: 0, kind: "definition" }).result, /does not match/); await settled(); assert.equal(other.workspace.diagnostics().leases, 0);
});

test("malformed location and edit tails reject before any host loading", async t => {
    let loads = 0; const f = clientFixture(t, undefined, async () => { loads++; return undefined; });
    const navigation = createLspNavigationClient(f.provider), rename = createLspRenameClient(f.provider); t.after(() => { navigation.dispose(); rename.dispose(); });
    const source = f.document();
    f.peer.onRequest("textDocument/definition", () => [{ uri, range }, { uri, range: { start: { line: -1, character: 0 }, end: range.end } }]);
    await assert.rejects(navigation.run({ document: source, offset: 0, kind: "definition" }).result, ProtocolDecodeError);
    f.peer.onRequest("textDocument/rename", () => ({ changes: { [uri]: [{ range, newText: "value" }, { range, newText: 42 }] } }));
    await assert.rejects(rename.run({ document: source, offset: 0, newName: "value" }).result, ProtocolDecodeError); assert.equal(loads, 0);
});

test("rename and resolved actions retain unloaded null-version edit targets through atomic host application", async t => {
    const purposes: string[] = [], leases: ReturnType<typeof retained>[] = [];
    const f = clientFixture(t, undefined, async (_uri, context) => { purposes.push(context.purpose); const lease = retained(f); leases.push(lease); return lease.value; });
    const rename = createLspRenameClient(f.provider), actions = createLspActionClient(f.provider); t.after(() => { rename.dispose(); actions.dispose(); });
    const source = f.document(), edit = { documentChanges: [{ textDocument: { uri, version: null }, edits: [{ range: { ...range, end: { line: 0, character: 11 } }, newText: "omega" }] }] };
    f.peer.onRequest("textDocument/rename", () => edit);
    const plan = await rename.run({ document: source, offset: 6, newName: "omega" }).result; assert.equal(plan.isCurrent(), true);
    f.workspace.editDocuments(plan.documents.map(item => ({ documentId: f.other.documentId, expectedRevision: item.target.document.revision, edits: item.edits, origin: "human" })));
    assert.equal(f.workspace.document(f.other.documentId).text(), "gamma omega"); assert.equal(plan.isCurrent(), false);
    rename.cancel(); await settled(); assert.equal(leases[0]!.released, 1);
    f.peer.onRequest("textDocument/codeAction", () => [{ title: "lazy", data: { key: 1 } }]);
    f.peer.onRequest("codeAction/resolve", (value: object) => ({ ...value, edit }));
    const batch = await actions.run({ document: source, from: 6, to: 10 }).result, action = await batch.resolve(batch.actions[0]!);
    assert.equal(action.edit!.documents[0]!.target.version, null); assert.deepEqual(purposes, ["edit", "edit"]);
    actions.cancel(); await settled(); assert.equal(action.edit!.isCurrent(), false); assert.equal(leases[1]!.released, 1);
});

test("a closed target cannot satisfy an invented wire version or bypass read-only host authority", async t => {
    const f = clientFixture(t, undefined, async () => retained(f).value), client = createLspRenameClient(f.provider); t.after(client.dispose);
    const source = f.document();
    f.peer.onRequest("textDocument/rename", () => ({ documentChanges: [{ textDocument: { uri, version: 1 }, edits: [{ range, newText: "new" }] }] }));
    await assert.rejects(client.run({ document: source, offset: 6, newName: "new" }).result, stale); await settled(); assert.equal(f.workspace.diagnostics().leases, 0);
    f.workspace.setCapabilities(f.other.id, { ...f.other.metadata.getSnapshot().capabilities, edit: [] });
    f.peer.onRequest("textDocument/rename", () => ({ changes: { [uri]: [{ range, newText: "new" }], [source.language!.uri]: [{ range, newText: "new" }] } }));
    const plan = await client.run({ document: source, offset: 6, newName: "new" }).result;
    const applied = f.workspace.editDocuments(plan.documents.map(item => ({ documentId: item.target.document.documentId as typeof source.id,
        expectedRevision: item.target.document.revision, edits: item.edits, origin: "human" })));
    assert.equal(applied.applied, false);
    assert.equal(f.document(), source); assert.equal(f.workspace.document(f.other.documentId).text(), "gamma delta");
});

test("server-proposed edits resolve through the same host policy and release targets after the decision", async t => {
    let context: LspTargetContext | undefined, lease: ReturnType<typeof retained> | undefined;
    const f = clientFixture(t, undefined, async (_uri, captured) => { context = captured; lease = retained(f); return lease.value; });
    const client = createLspActionClient(f.provider); t.after(client.dispose); const source = f.document();
    f.peer.onRequest("textDocument/codeAction", () => [{ title: "command", command: "fixture.command" }]);
    f.peer.onRequest("workspace/executeCommand", async () => f.peer.sendRequest("workspace/applyEdit", { edit: { changes: { [uri]: [{ range, newText: "new" }] } } }));
    const batch = await client.run({ document: source, from: 6, to: 10 }).result;
    const receipt = await batch.execute(batch.actions[0]!, { snapshots: () => [f.document()], isCurrent: () => true,
        review: async (request, context) => { assert.equal(request.edit.documents[0]!.target.document.uri, uri);
            context.onCancel(() => { throw new Error("Review cancellation failure"); }); return { applied: false, failureReason: "Host declined" }; } });
    assert.deepEqual(receipt.decision, { applied: false, failureReason: "Host declined" }); assert.equal(context!.source, null); assert.equal(context!.purpose, "edit");
    await settled(); assert.equal(lease!.released, 1); assert.deepEqual(f.errors.splice(0), ["Review cancellation failure"]);
});
