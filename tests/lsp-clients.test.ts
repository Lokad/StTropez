import test from "node:test";
import assert from "node:assert/strict";
import { clientFixture, latch, protocol, settled } from "./helpers/lsp-client.ts";
import type { DocumentSnapshot } from "../src/core/workspace.ts";
import type { LspPrepare } from "../src/protocol/index.ts";
const { createLspHoverClient, createLspNavigationClient, createLspRenameClient, createLspActionClient, RpcError } = protocol;
const stale = (error: unknown) => error instanceof RpcError && error.code === -32801;
const cancelled = (error: unknown) => error instanceof RpcError && error.code === -32800;

test("request validation binds a project once and never replaces a captured URI during a held reply", async t => {
    let mappings = 0, version = 0;
    const f = clientFixture(t, undefined, undefined, doc => { mappings++; return { uri: `generic:${version}/${doc.resourceId}`, languageId: "generic" }; }),
        client = createLspNavigationClient(f.provider); t.after(client.dispose);
    const resources = [f.source, f.other, ...Array.from({ length: 48 }, (_, i) => f.workspace.createTextResource(
        { scope: "project", resource: `${i}`, variant: "working" }, `Source ${i}`, { value: "source" }))];
    const snapshots = () => resources.map(resource => f.workspace.document(resource.documentId));
    const run = () => client.run(snapshots(), f.source.documentId, 0, "references");
    f.peer.onRequest("textDocument/references", () => []); await run(); mappings = 0;
    const result = await run(); assert.equal(mappings, resources.length); assert.equal(result.isCurrent(), true);
    t.diagnostic(JSON.stringify({ documents: resources.length, requestMappings: mappings }));
    const entered = latch<void>(), reply = latch<unknown>(); t.after(() => reply.resolve([]));
    f.peer.onRequest("textDocument/references", () => { entered.resolve(); return reply.promise; });
    const pending = run(), rejected = assert.rejects(pending, error => stale(error) || cancelled(error)); await entered.promise;
    version++; const replacement = f.provider.createScope(); t.after(replacement.dispose);
    const binding = replacement.attachDocument(f.source.documentId); await replacement.flush([binding]); reply.resolve([]); await rejected;
    assert.equal(result.isCurrent(), false); assert.equal(binding.getSnapshot().uri, `generic:1/${f.source.id}`);
    assert.equal(f.provider.snapshot().documents, 1, "Validation must not reattach the expired captured project.");
});

test("actions forward immutable diagnostic metadata only for matching current versions and placed overlapping ranges", async t => {
    const f = clientFixture(t), client = createLspActionClient(f.provider), control = f.provider.createScope(); t.after(() => { client.dispose(); control.dispose(); });
    const binding = control.attachDocument(f.source.documentId); await control.connect();
    assert.deepEqual((f.sent("initialize")[0]!.params as { capabilities: { textDocument: { publishDiagnostics: unknown } } }).capabilities.textDocument.publishDiagnostics,
        { versionSupport: true, relatedInformation: true, tagSupport: { valueSet: [1, 2] }, codeDescriptionSupport: true, dataSupport: true });
    const capture = control.synchronized(binding)!, range = { start: { line: 0, character: 6 }, end: { line: 0, character: 10 } };
    const diagnostic = { range, message: "Check beta", code: "generic/check", source: "fixture", severity: 2,
        codeDescription: { href: "host-help:check" }, tags: [1, 99], data: { key: [null, 42] },
        relatedInformation: [{ location: { uri: "host:unopened", range }, message: "Related" }] };
    const send = async (version: number | undefined) => {
        await f.peer.sendNotification("textDocument/publishDiagnostics", { uri: capture.document.uri, ...(version === undefined ? {} : { version }), diagnostics: [diagnostic,
            { range: { start: { line: 50, character: 0 }, end: { line: 50, character: 1 } }, message: "Unplaced" }] }); await settled();
    };
    const run = async (from = 6, to = 10) => {
        await client.run([f.document()], f.source.documentId, from, to);
        return (f.sent("textDocument/codeAction").at(-1)!.params as { context: { diagnostics: unknown[] } }).context.diagnostics;
    };
    await send(capture.version); assert.deepEqual(await run(), [diagnostic]); assert.deepEqual(await run(0, 1), []);
    await send(undefined); assert.deepEqual(await run(), []); // Fresh placement is not a known provider version.
    await send(capture.version); f.edit(); assert.deepEqual(await run(), []);
});

test("a new hover invalidates a completed result on the same unchanged document", async t => {
    const f = clientFixture(t), client = createLspHoverClient(f.provider); t.after(client.dispose);
    const first = client.run(f.document(), 0), a = await first.result;
    first.cancel(); // A view may release a completed call while retaining its published result.
    assert.equal(a!.isCurrent(), true);
    const b = await client.run(f.document(), 6).result;
    assert.equal(a!.isCurrent(), false); assert.equal(b!.isCurrent(), true);
    first.cancel(); assert.equal(b!.isCurrent(), true);
    assert.equal(f.sent("textDocument/didOpen").length, 1);
});
test("hover supersession cancels obsolete wire work promptly and old cancellation cannot affect its replacement", async t => {
    const f = clientFixture(t), client = createLspHoverClient(f.provider), entered = latch<void>(), answer = latch<unknown>();
    t.after(() => { answer.resolve({ contents: "cleanup" }); client.dispose(); }); let calls = 0;
    f.peer.onRequest("textDocument/hover", () => ++calls === 1 ? (entered.resolve(), answer.promise) : ({ contents: "replacement" }));
    const first = client.run(f.document(), 0), rejected = assert.rejects(first.result, cancelled); await entered.promise;
    const next = await client.run(f.document(), 6).result; await rejected; first.cancel(); await settled();
    assert.equal(f.sent("$/cancelRequest").length, 1); assert.equal(f.provider.snapshot().protocol.pendingRequests, 0); assert.equal(next!.isCurrent(), true);
    answer.resolve({ contents: "late" }); await settled(); assert.equal(next!.text, "replacement");
});
test("cancelling delayed connection settles the feature without disconnecting another scope", async t => {
    const opening = latch<void>(), f = clientFixture(t, () => opening.promise), client = createLspHoverClient(f.provider);
    t.after(() => { opening.resolve(); client.dispose(); });
    const control = f.provider.createScope(); control.attachDocument(f.source.documentId); t.after(control.dispose);
    const call = client.run(f.document(), 6); let result: unknown;
    const observed = call.result.catch(error => { result = error; });
    call.cancel(); await settled(); assert.ok(cancelled(result)); assert.equal(f.provider.snapshot().documentParticipants, 1);
    opening.resolve(); await control.connect(); await observed;
    assert.equal(f.provider.snapshot().created, 1); assert.equal(control.synchronized(control.attachDocument(f.source.documentId))!.isCurrent(), true);
});
test("a document edit during delayed connection rejects the original position before dispatch", async t => {
    const opening = latch<void>(), f = clientFixture(t, () => opening.promise), client = createLspHoverClient(f.provider); t.after(() => { opening.resolve(); client.dispose(); });
    const call = client.run(f.document(), 6), rejected = assert.rejects(call.result, stale);
    f.edit(); opening.resolve(); await rejected; assert.equal(f.sent("textDocument/hover").length, 0);
});
test("superseding delayed preparation and switching documents leaves only the new capture current", async t => {
    const f = clientFixture(t), client = createLspHoverClient(f.provider), entered = latch<void>(), prepared = latch<void>(); t.after(() => { prepared.resolve(); client.dispose(); });
    const call = client.run(f.document(), 6, async () => { entered.resolve(); await prepared.promise; }), rejected = assert.rejects(call.result, cancelled); await entered.promise;
    const next = await client.run(f.workspace.document(f.other.documentId), 0).result; await rejected;
    assert.equal(next!.isCurrent(), true); assert.equal(f.provider.snapshot().documents, 1); assert.equal(f.sent("textDocument/hover").length, 1);
    prepared.resolve(); await settled(); assert.equal(f.sent("textDocument/hover").length, 1);
});
for (const feature of ["hover", "navigation", "rename", "actions"] as const) test(`${feature} rejects preparation edits before interpreting captured positions against newer text`, async t => {
    const f = clientFixture(t), doc = f.document();
    const prepare: LspPrepare = async scope => { f.edit(); await scope.flush(); };
    const client = feature === "hover" ? createLspHoverClient(f.provider) : feature === "navigation" ? createLspNavigationClient(f.provider) : feature === "rename" ? createLspRenameClient(f.provider) : createLspActionClient(f.provider);
    t.after(client.dispose);
    const run = (snapshot: DocumentSnapshot, hook: LspPrepare | undefined) => feature === "hover" ? (client as ReturnType<typeof createLspHoverClient>).run(snapshot, 6, hook).result
        : feature === "navigation" ? (client as ReturnType<typeof createLspNavigationClient>).run([snapshot], snapshot.id, 6, "definition", true, hook)
        : feature === "rename" ? (client as ReturnType<typeof createLspRenameClient>).run([snapshot], snapshot.id, 6, "renamed", hook)
        : (client as ReturnType<typeof createLspActionClient>).run([snapshot], snapshot.id, 6, 10, hook);
    await assert.rejects(run(doc, prepare), stale); await settled();
    const method = feature === "navigation" ? "textDocument/definition" : feature === "actions" ? "textDocument/codeAction" : `textDocument/${feature}`;
    assert.equal(f.sent(method).length, 0); assert.equal(f.provider.snapshot().protocol.pendingRequests, 0); assert.equal(f.workspace.diagnostics().leases, 0);
    assert.equal((await run(f.document(), undefined))?.isCurrent(), true);
});
test("a changed project target is rejected even when the origin and its position are unchanged", async t => {
    const f = clientFixture(t), client = createLspNavigationClient(f.provider); t.after(client.dispose);
    const source = f.document(), target = f.workspace.document(f.other.documentId);
    await assert.rejects(client.run([source, target], source.id, 6, "definition", true, async () => {
        f.workspace.edit({ documentId: target.id, expectedRevision: target.revision, edits: [{ from: 0, to: 0, insert: "changed " }], origin: "human" });
    }), stale);
    assert.equal(f.document(), source); assert.equal(f.sent("textDocument/definition").length, 0);
});
test("action resolution rejects a changed project before sending captured lazy data", async t => {
    const f = clientFixture(t), client = createLspActionClient(f.provider); t.after(client.dispose);
    f.peer.onRequest("textDocument/codeAction", () => [{ title: "lazy", data: { token: 1 } }]);
    f.peer.onRequest("codeAction/resolve", (value: object) => ({ ...value, edit: { changes: {} } }));
    const doc = f.document(), result = await client.run([doc], doc.id, 6, 10);
    assert.ok((await result.resolve(result.actions[0]!)).edit);
    await assert.rejects(result.resolve(result.actions[0]!, async () => { f.edit(); }), stale);
    assert.equal(f.sent("codeAction/resolve").length, 1); assert.equal(result.isCurrent(), false); await settled(); assert.equal(f.workspace.diagnostics().leases, 0);
});
test("confirmed action preparation may deliberately edit and synchronize through its separate host policy", async t => {
    const f = clientFixture(t), client = createLspActionClient(f.provider); t.after(client.dispose);
    f.peer.onRequest("textDocument/codeAction", () => [{ title: "command", command: "fixture.command", arguments: [{ opaque: "unchanged" }] }]);
    const doc = f.document(), result = await client.run([doc], doc.id, 6, 10);
    await result.execute(result.actions[0]!, { snapshots: () => [f.document()], isCurrent: () => true, prepare: () => { f.edit(); }, review: async () => ({ applied: false }) });
    assert.equal(f.sent("workspace/executeCommand").length, 1); assert.equal(result.isCurrent(), false); assert.equal(result.commandCurrent(), true);
    assert.deepEqual((f.sent("workspace/executeCommand")[0]!.params as { arguments: unknown }).arguments, [{ opaque: "unchanged" }]);
});
test("disposal settles hanging preparation, releases participation and leaves an independent client useful", async t => {
    const f = clientFixture(t), client = createLspHoverClient(f.provider), other = createLspHoverClient(f.provider), entered = latch<void>(), prepared = latch<void>();
    t.after(() => { prepared.resolve(); client.dispose(); other.dispose(); });
    const call = client.run(f.document(), 0, async () => { entered.resolve(); await prepared.promise; }); let error: unknown;
    const observed = call.result.catch(value => { error = value; }); await entered.promise; client.dispose(); client.dispose(); await settled();
    assert.ok(cancelled(error)); assert.equal(f.provider.snapshot().documents, 0);
    const valid = await other.run(f.document(), 6).result; assert.equal(valid!.isCurrent(), true); prepared.resolve(); await observed;
    other.dispose(); await settled(); assert.equal(f.workspace.diagnostics().leases, 0); assert.equal(f.provider.snapshot().protocol.pendingRequests, 0);
});
