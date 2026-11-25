import test from "node:test";
import assert from "node:assert/strict";
import { actionClient } from "../src/protocol/lsp-actions.ts";
import { highlightClient } from "../src/protocol/lsp-highlights.ts";
import { hoverClient } from "../src/protocol/lsp-hover.ts";
import { colorClient, linkClient, signatureClient } from "../src/protocol/lsp-language.ts";
import { navigationClient } from "../src/protocol/lsp-navigation.ts";
import { renameClient } from "../src/protocol/lsp-rename.ts";
import { clientFixture, protocol, settled } from "./helpers/lsp-client.ts";
import { latch } from "./helpers/latch.ts";
import type { DocumentSnapshot } from "../src/core/workspace.ts";
import type { LspPrepare } from "../src/protocol/index.ts";
import { createLspClient, retainLspDocument } from "../src/protocol/lsp-client.ts";
const { RpcError } = protocol;
const stale = (error: unknown) => error instanceof RpcError && error.code === -32801;
const cancelled = (error: unknown) => error instanceof RpcError && error.code === -32800;

test("features sharing a mounted scope cancel independently and capture only their own project", { timeout: 5000 }, async t => {
    const f = clientFixture(t);
    const owner = retainLspDocument(f.provider, f.source.documentId);
    const hover = createLspClient(owner, "textDocument/hover");
    const navigation = createLspClient(owner, "textDocument/definition");
    t.after(() => { hover.dispose(); navigation.dispose(); owner.dispose(); });
    const document = f.document();
    const project = [document, f.workspace.document(f.other.documentId)];
    const params = () => ({ position: { line: 0, character: 0 } });
    const runHover = (prepare?: LspPrepare) =>
        hover.request({ document, prepare }, "textDocument/hover", params, reply => reply);
    const runNavigation = () =>
        navigation.request({ document, project }, "textDocument/definition", params, reply => reply);

    const received = latch<void>();
    const answer = latch<null>();
    f.peer.onRequest("textDocument/definition", () => { received.resolve(); return answer.promise; });
    const pending = runNavigation();
    await received.promise;
    const prepared = latch<Parameters<LspPrepare>[0]>();
    const finish = latch<void>();
    const retired = runHover(async access => {
        prepared.resolve(access);
        await finish.promise;
    });
    const access = await prepared.promise;
    const customReply = latch<null>();
    f.peer.onRequest("test/custom", () => customReply.promise);
    const custom = access.request("test/custom");
    const interrupted = Promise.all([assert.rejects(custom.result, cancelled), assert.rejects(retired.result, cancelled)]);
    retired.cancel();
    await interrupted;
    assert.throws(() => access.request("test/late"), cancelled);
    finish.resolve();
    customReply.resolve(null);
    const single = await runHover().result;
    assert.deepEqual([...single.captures.keys()], ["generic:source"]);
    assert.equal(f.provider.snapshot().scopes, 1);
    assert.equal(f.provider.snapshot().documentParticipants, 2);
    answer.resolve(null);
    const both = await pending.result;
    assert.deepEqual([...both.captures.keys()], ["generic:source", "generic:other"]);
    assert.equal(single.isCurrent(), true);

    const waiting = latch<void>();
    const last = latch<null>();
    const wire = latch<void>();
    f.peer.onRequest("textDocument/definition", () => { wire.resolve(); return last.promise; });
    const a = runHover(async () => { waiting.resolve(); await last.promise; });
    const b = runNavigation();
    await Promise.all([waiting.promise, wire.promise]);
    const closed = Promise.all([assert.rejects(a.result, cancelled), assert.rejects(b.result, cancelled)]);
    owner.dispose();
    await closed;
    last.resolve(null);
    assert.equal(f.provider.snapshot().scopes, 0);
    assert.equal(f.provider.snapshot().documentParticipants, 0);
    assert.equal(f.sent("test/late").length, 0);
});

test("public feature handles share read-only options, busy state and disposal", async t => {
    type Fixture = ReturnType<typeof clientFixture>;
    const cases = [
        ["hover", (f: Fixture) => { const client = hoverClient(f.provider); return { client, run: () => client.run({ document: f.document(), offset: 0 }).result }; }],
        ["foldingRange", (f: Fixture) => { const client = protocol.createLspFoldingClient(f.provider); return { client, run: () => client.run({ document: f.document() }).result }; }],
        ["documentHighlight", (f: Fixture) => { const client = highlightClient(f.provider); return { client, run: () => client.run({ document: f.document(), offset: 0 }).result }; }],
        ["definition", (f: Fixture) => { const client = navigationClient(f.provider); return { client, run: () => client.run({ document: f.document(), offset: 0, kind: "definition" }).result }; }],
        ["rename", (f: Fixture) => { const client = renameClient(f.provider); return { client, run: () => client.run({ document: f.document(), offset: 0, newName: "next" }).result }; }],
        ["codeAction", (f: Fixture) => { const client = actionClient(f.provider); return { client, run: () => client.run({ document: f.document(), from: 0, to: 0 }).result }; }],
        ["signatureHelp", (f: Fixture) => { const client = signatureClient(f.provider); return { client, run: () => client.run({ document: f.document(), offset: 0 }).result }; }],
        ["documentLink", (f: Fixture) => { const client = linkClient(f.provider); return { client, run: () => client.run({ document: f.document() }).result }; }],
        ["documentColor", (f: Fixture) => { const client = colorClient(f.provider); return { client, run: () => client.run({ document: f.document() }).result }; }]
    ] as const;
    for (const [name, create] of cases) await t.test(name, async t => {
        const f = clientFixture(t), { client, run } = create(f), entered = latch<void>(), answer = latch<unknown>();
        t.after(() => { answer.resolve(null); client.dispose(); });
        assert.ok(Object.isFrozen(client)); assert.equal(client.isBusy(), false); assert.deepEqual(client.options(f.document()), []);
        let notifications = 0; const stop = client.subscribe(() => { notifications++; }); t.after(stop);
        await f.provider.connect(); const before = f.provider.snapshot();
        const options = client.options(f.document()); assert.equal(options.length, 1); assert.ok(Object.isFrozen(options));
        assert.deepEqual(f.provider.snapshot(), before); assert.equal(f.workspace.diagnostics().leases, 0);
        f.peer.onRequest(`textDocument/${name}`, () => { entered.resolve(); return answer.promise; });
        const pending = run(); void pending.catch(() => {}); assert.equal(client.isBusy(), true); await entered.promise;
        const busy = f.provider.snapshot(); assert.equal(client.options(f.workspace.document(f.other.documentId)).length, 1);
        assert.equal(client.isBusy(), true); assert.deepEqual(f.provider.snapshot(), busy);
        answer.resolve(name === "documentColor" ? [] : null); await pending; assert.equal(client.isBusy(), false); assert.ok(notifications > 0);
        client.cancel(); client.dispose(); client.dispose(); assert.equal(client.isBusy(), false); assert.equal(client.snapshot().disposed, true);
        assert.throws(() => client.options(f.document()), /disposed/); assert.throws(() => client.subscribe(() => {}), /disposed/);
        await settled(); assert.equal(f.provider.snapshot().documents, 0); assert.equal(f.workspace.diagnostics().leases, 0);
    });
});

test("multi-method handles query their declared methods and reject another client's method", async t => {
    const f = clientFixture(t), navigation = navigationClient(f.provider), color = colorClient(f.provider);
    t.after(() => { navigation.dispose(); color.dispose(); }); await f.provider.connect();
    assert.equal(navigation.options(f.document(), "textDocument/references").length, 1);
    assert.equal(color.options(f.document(), "textDocument/colorPresentation").length, 1);
    // @ts-expect-error Navigation does not expose another client's options.
    assert.throws(() => navigation.options(f.document(), "textDocument/rename"), TypeError);
    assert.equal(f.provider.snapshot().documents, 0);
});

test("subscribers observe busy request and follow-up work on unchanged documents", async t => {
    const f = clientFixture(t), client = linkClient(f.provider); t.after(client.dispose);
    const wire = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, data: { token: 1 } };
    f.peer.onRequest("textDocument/documentLink", () => [wire]);
    const run = () => client.run({ document: f.document() }).result;
    await run(); await settled();
    const observed: boolean[] = [], stop = client.subscribe(() => { observed.push(client.isBusy()); }); t.after(stop);
    const entered = latch<void>(), answer = latch<unknown>(); t.after(() => answer.resolve([]));
    f.peer.onRequest("textDocument/documentLink", () => { entered.resolve(); return answer.promise; });
    const pending = run(); await entered.promise; await settled(); assert.deepEqual(observed, [true]);
    answer.resolve([wire]); const batch = await pending;
    assert.deepEqual(observed, [true, false]); observed.length = 0;
    const resolving = latch<void>(), resolved = latch<unknown>(); t.after(() => resolved.resolve(null));
    f.peer.onRequest("documentLink/resolve", () => { resolving.resolve(); return resolved.promise; });
    const follow = batch.resolve(batch.items[0]!); await resolving.promise; await settled();
    assert.deepEqual(observed, [true]); resolved.resolve({ ...wire, target: "host:target" }); await follow;
    assert.deepEqual(observed, [true, false]);
});

test("queued busy delivery permits cancellation and suppresses disposed work without replacing its capture", async t => {
    const f = clientFixture(t), client = hoverClient(f.provider); t.after(client.dispose);
    await client.run({ document: f.document(), offset: 0 }).result; await settled();
    const observed: boolean[] = []; let cancel = true;
    const stop = client.subscribe(() => { observed.push(client.isBusy()); if (cancel && client.isBusy()) client.cancel(); }); t.after(stop);
    const call = client.run({ document: f.document(), offset: 0 }); await assert.rejects(call.result, cancelled); await settled();
    assert.equal(observed[0], true); assert.equal(observed.at(-1), false); assert.equal(client.isBusy(), false);
    assert.equal(f.sent("textDocument/hover").length, 1, "The cancelled capture never dispatches another request.");
    cancel = false; observed.length = 0;
    const disposed = client.run({ document: f.document(), offset: 6 }); client.dispose(); await assert.rejects(disposed.result, cancelled); await settled();
    assert.deepEqual(observed, []); assert.equal(f.provider.snapshot().documents, 0);
});

test("a held project reply cannot rebind a source whose URI changed", async t => {
    const f = clientFixture(t),
        client = navigationClient(f.provider); t.after(client.dispose);
    const resources = [f.source, f.other, ...Array.from({ length: 48 }, (_, i) => f.workspace.createTextResource(
        { scope: "project", resource: `${i}`, variant: "working" }, `Source ${i}`, { value: "source" }, undefined, { language: { uri: `generic:extra/${i}`, languageId: "generic" } }))];
    const snapshots = () => resources.map(resource => f.workspace.document(resource.documentId));
    const run = () => client.run({ document: f.document(), project: snapshots(), offset: 0, kind: "references" }).result;
    f.peer.onRequest("textDocument/references", () => []);
    const result = await run(); assert.equal(result.isCurrent(), true);
    const entered = latch<void>(), reply = latch<unknown>(); t.after(() => reply.resolve([]));
    f.peer.onRequest("textDocument/references", () => { entered.resolve(); return reply.promise; });
    const pending = run(), rejected = assert.rejects(pending, error => stale(error) || cancelled(error)); await entered.promise;
    f.workspace.setDocumentLanguage(f.source.documentId, { uri: "generic:renamed", languageId: "generic" });
    const replacement = f.provider.createScope(); t.after(replacement.dispose);
    const binding = replacement.attachDocument(f.source.documentId); await replacement.flush([binding]); reply.resolve([]); await rejected;
    assert.equal(result.isCurrent(), false); assert.equal(binding.getSnapshot().uri, "generic:renamed");
    assert.equal(f.provider.snapshot().documents, 1, "Validation must not reattach the expired captured project.");
});

test("actions forward immutable diagnostic metadata only for matching current versions and placed overlapping ranges", async t => {
    const f = clientFixture(t), control = f.provider.createScope(); t.after(control.dispose);
    const binding = control.attachDocument(f.source.documentId); await control.ensureConnected();
    const client = actionClient(f.provider); t.after(client.dispose);
    const diagnostics = control.observeDiagnostics(binding);
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
        await client.run({ document: f.document(), from, to }).result;
        return (f.sent("textDocument/codeAction").at(-1)!.params as { context: { diagnostics: unknown[] } }).context.diagnostics;
    };
    await send(capture.version); assert.equal(diagnostics.getSnapshot().status, "current"); assert.deepEqual(await run(), [diagnostic]); assert.deepEqual(await run(0, 1), []);
    await send(undefined); assert.deepEqual(await run(), []); // Fresh placement is not a known provider version.
    await send(capture.version); f.edit();
    const pending = control.observeDiagnostics(binding).getSnapshot(); assert.equal(pending.status, "pending");
    assert.equal(pending.isPlacementCurrent(), true); assert.equal(pending.isCurrent(), false); assert.equal(pending.result!.items[0]!.from, 13);
    assert.deepEqual(await run(13, 17), []); assert.equal(control.observeDiagnostics(binding).getSnapshot().status, "pending");
});

test("a new hover invalidates a completed result on the same unchanged document", async t => {
    const f = clientFixture(t), client = hoverClient(f.provider); t.after(client.dispose);
    const first = client.run({ document: f.document(), offset: 0 }), a = await first.result;
    first.cancel(); // A view may release a completed call while retaining its published result.
    assert.equal(a!.isCurrent(), true);
    const b = await client.run({ document: f.document(), offset: 6 }).result;
    assert.equal(a!.isCurrent(), false); assert.equal(b!.isCurrent(), true);
    first.cancel(); assert.equal(b!.isCurrent(), true);
    assert.equal(f.sent("textDocument/didOpen").length, 1);
});
test("hover supersession cancels obsolete wire work promptly and old cancellation cannot affect its replacement", async t => {
    const f = clientFixture(t), client = hoverClient(f.provider), entered = latch<void>(), answer = latch<unknown>();
    t.after(() => { answer.resolve({ contents: "cleanup" }); client.dispose(); }); let calls = 0;
    f.peer.onRequest("textDocument/hover", () => ++calls === 1 ? (entered.resolve(), answer.promise) : ({ contents: "replacement" }));
    const first = client.run({ document: f.document(), offset: 0 }), rejected = assert.rejects(first.result, cancelled); await entered.promise;
    assert.equal(client.isBusy(), true);
    const next = await client.run({ document: f.document(), offset: 6 }).result; await rejected; first.cancel(); await settled();
    assert.equal(client.isBusy(), false);
    assert.equal(f.sent("$/cancelRequest").length, 1); assert.equal(f.provider.snapshot().protocol.pendingRequests, 0); assert.equal(next!.isCurrent(), true);
    answer.resolve({ contents: "late" }); await settled(); assert.equal(next!.text, "replacement");
});
test("cancelling delayed connection settles the feature without disconnecting another scope", async t => {
    const opening = latch<void>(), f = clientFixture(t, () => opening.promise), client = hoverClient(f.provider);
    t.after(() => { opening.resolve(); client.dispose(); });
    const control = f.provider.createScope(); control.attachDocument(f.source.documentId); t.after(control.dispose);
    const call = client.run({ document: f.document(), offset: 6 }); let result: unknown;
    const observed = call.result.catch(error => { result = error; });
    call.cancel(); await settled(); assert.ok(cancelled(result)); assert.equal(f.provider.snapshot().documentParticipants, 2);
    client.dispose(); assert.equal(f.provider.snapshot().documentParticipants, 1);
    opening.resolve(); await control.ensureConnected(); await observed;
    assert.equal(control.synchronized(control.attachDocument(f.source.documentId))!.isCurrent(), true);
});
test("a document edit during delayed connection rejects the original position before dispatch", async t => {
    const opening = latch<void>(), f = clientFixture(t, () => opening.promise), client = hoverClient(f.provider); t.after(() => { opening.resolve(); client.dispose(); });
    const call = client.run({ document: f.document(), offset: 6 }), rejected = assert.rejects(call.result, stale);
    f.edit(); opening.resolve(); await rejected; assert.equal(f.sent("textDocument/hover").length, 0);
});
test("superseding delayed preparation and switching documents leaves only the new capture current", async t => {
    const f = clientFixture(t), client = hoverClient(f.provider), entered = latch<void>(), prepared = latch<void>(); t.after(() => { prepared.resolve(); client.dispose(); });
    const call = client.run({ document: f.document(), offset: 6, prepare: async () => { entered.resolve(); await prepared.promise; } }), rejected = assert.rejects(call.result, cancelled); await entered.promise;
    const next = await client.run({ document: f.workspace.document(f.other.documentId), offset: 0 }).result; await rejected;
    assert.equal(next!.isCurrent(), true); assert.equal(f.provider.snapshot().documents, 1); assert.equal(f.sent("textDocument/hover").length, 1);
    prepared.resolve(); await settled(); assert.equal(f.sent("textDocument/hover").length, 1);
});
for (const feature of ["hover", "navigation", "rename", "actions"] as const) test(`${feature} rejects preparation edits before interpreting captured positions against newer text`, async t => {
    const f = clientFixture(t), doc = f.document();
    const prepare: LspPrepare = async scope => { f.edit(); await scope.flush(); };
    const client = feature === "hover" ? hoverClient(f.provider) : feature === "navigation" ? navigationClient(f.provider) : feature === "rename" ? renameClient(f.provider) : actionClient(f.provider);
    t.after(client.dispose);
    const run = (snapshot: DocumentSnapshot, hook: LspPrepare | undefined) => feature === "hover" ? (client as ReturnType<typeof hoverClient>).run({ document: snapshot, offset: 6, prepare: hook }).result
        : feature === "navigation" ? (client as ReturnType<typeof navigationClient>).run({ document: snapshot, offset: 6, kind: "definition", includeDeclaration: true, prepare: hook }).result
        : feature === "rename" ? (client as ReturnType<typeof renameClient>).run({ document: snapshot, offset: 6, newName: "renamed", prepare: hook }).result
        : (client as ReturnType<typeof actionClient>).run({ document: snapshot, from: 6, to: 10, prepare: hook }).result;
    await assert.rejects(run(doc, prepare), stale); await settled();
    const method = feature === "navigation" ? "textDocument/definition" : feature === "actions" ? "textDocument/codeAction" : `textDocument/${feature}`;
    assert.equal(f.sent(method).length, 0); assert.equal(f.provider.snapshot().protocol.pendingRequests, 0); assert.equal(f.workspace.diagnostics().leases, 0);
    assert.equal((await run(f.document(), undefined))?.isCurrent(), true);
});
test("a changed project target is rejected even when the origin and its position are unchanged", async t => {
    const f = clientFixture(t), client = navigationClient(f.provider); t.after(client.dispose);
    const source = f.document(), target = f.workspace.document(f.other.documentId);
    await assert.rejects(client.run({ document: source, project: [source, target], offset: 6, kind: "definition", includeDeclaration: true, prepare: async () => {
        f.workspace.edit({ documentId: target.id, expectedRevision: target.revision, edits: [{ from: 0, to: 0, insert: "changed " }], origin: "human" });
    } }).result, stale);
    assert.equal(f.document(), source);
    f.edit();
    await assert.rejects(client.run({ document: source, project: [f.document()], offset: 6, kind: "definition" }).result, stale);
    assert.equal(f.sent("textDocument/definition").length, 0);
});
test("action resolution rejects a changed project before sending captured lazy data", async t => {
    const f = clientFixture(t), client = actionClient(f.provider); t.after(client.dispose);
    f.peer.onRequest("textDocument/codeAction", () => [{ title: "lazy", data: { token: 1 } }]);
    f.peer.onRequest("codeAction/resolve", (value: object) => ({ ...value, edit: { changes: {} } }));
    const doc = f.document(), result = await client.run({ document: doc, from: 6, to: 10 }).result;
    assert.ok((await result.resolve(result.actions[0]!)).edit);
    await assert.rejects(result.resolve(result.actions[0]!, async () => { f.edit(); }), stale);
    assert.equal(f.sent("codeAction/resolve").length, 1); assert.equal(result.isCurrent(), false); await settled(); assert.equal(f.workspace.diagnostics().leases, 0);
});
test("confirmed action preparation may deliberately edit and synchronize through its separate host policy", async t => {
    const f = clientFixture(t), client = actionClient(f.provider); t.after(client.dispose);
    f.peer.onRequest("textDocument/codeAction", () => [{ title: "command", command: "fixture.command", arguments: [{ opaque: "unchanged" }] }]);
    const doc = f.document(), result = await client.run({ document: doc, from: 6, to: 10 }).result;
    await result.execute(result.actions[0]!, { snapshots: () => [f.document()], isCurrent: () => true, prepare: () => { f.edit(); }, review: async () => ({ applied: false }) });
    assert.equal(f.sent("workspace/executeCommand").length, 1); assert.equal(result.isCurrent(), false); assert.equal(result.commandCurrent(), true);
    assert.deepEqual((f.sent("workspace/executeCommand")[0]!.params as { arguments: unknown }).arguments, [{ opaque: "unchanged" }]);
});
test("disposal settles hanging preparation, releases participation and leaves an independent client useful", async t => {
    const f = clientFixture(t), client = hoverClient(f.provider), other = hoverClient(f.provider), entered = latch<void>(), prepared = latch<void>();
    t.after(() => { prepared.resolve(); client.dispose(); other.dispose(); });
    const call = client.run({ document: f.document(), offset: 0, prepare: async () => { entered.resolve(); await prepared.promise; } }); let error: unknown;
    const observed = call.result.catch(value => { error = value; }); await entered.promise; client.dispose(); client.dispose(); await settled();
    assert.ok(cancelled(error)); assert.equal(f.provider.snapshot().documents, 0);
    const valid = await other.run({ document: f.document(), offset: 6 }).result; assert.equal(valid!.isCurrent(), true); prepared.resolve(); await observed;
    other.dispose(); await settled(); assert.equal(f.workspace.diagnostics().leases, 0); assert.equal(f.provider.snapshot().protocol.pendingRequests, 0);
});
