import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { TextDocument } from "vscode-languageserver-protocol/node.js";
import type { DidOpenTextDocumentParams, DidChangeTextDocumentParams, DidCloseTextDocumentParams } from "vscode-languageserver-protocol/node.js";
import { referencePeer } from "../fixtures/protocol/reference-peer.ts";
import type { LspFeature, LspRequestContext, LspWorkspaceOptions, RpcScheduler, RpcTransport } from "../src/protocol/index.ts";
import { Workspace } from "../src/index.ts";
import { LspWorkspace, createLspHoverClient, createLspCommandRunner, createLspSignatureClient, createLspLinkClient, createLspColorClient, createLspFoldingClient, createLspHighlightClient, RpcError } from "../src/protocol/index.ts";
import { latch } from "./helpers/latch.ts";
const settled = async () => { await setImmediate(); await setImmediate(); };

test("binding captures read local revisions across request cancellation and expire with provider authority", async t => {
    const f = fixture(t), scope = f.provider.createScope(), handle = scope.attachDocument(f.source.documentId);
    t.after(scope.dispose); await scope.ensureConnected(); await scope.flush([handle]);
    const exact = scope.synchronized(handle)!, binding = scope.captureBinding(handle)!, owner = f.provider.snapshot();
    assert.equal(binding.getSnapshot(), f.workspace.document(f.source.documentId)); scope.cancel();
    assert.equal(exact.isCurrent(), false); assert.equal(binding.getSnapshot(), f.workspace.document(f.source.documentId));
    const before = handle.getSnapshot(), stop = f.workspace.observeDocument(f.source.documentId).subscribe(() => {
        assert.equal(binding.getSnapshot(), f.workspace.document(f.source.documentId)); assert.equal(handle.getSnapshot(), before);
    }); t.after(stop); f.edit(); stop(); assert.deepEqual(f.provider.snapshot(), owner);
    await scope.flush([handle]); await f.peers[0]!.rpc.sendRequest("client/registerCapability", {
        registrations: [{ id: "hover", method: "textDocument/hover", registerOptions: { documentSelector: null } }] });
    assert.equal(binding.getSnapshot(), undefined);
    const registered = scope.captureBinding(handle)!; assert.ok(registered.getSnapshot());
    await f.provider.reconnect(); await scope.flush([handle]); assert.equal(registered.getSnapshot(), undefined);
    const reconnected = scope.captureBinding(handle)!; assert.ok(reconnected.getSnapshot());
    scope.dispose(); assert.equal(reconnected.getSnapshot(), undefined); await settled(); assert.equal(f.workspace.diagnostics().leases, 0);
});

test("feature options for other documents preserve pending and completed captures without acquiring participation", async t => {
    let excludeCompanion = false, policyError: Error | undefined;
    const f = fixture(t, { features: ["textDocument/signatureHelp"], documentInfo: doc => {
        if (doc.title === "Companion") { if (policyError) throw policyError; if (excludeCompanion) return; }
        return { uri: `custom:/${doc.title}`, languageId: doc.title };
    } }), client = createLspSignatureClient(f.provider); t.after(client.dispose);
    const source = f.workspace.document(f.source.documentId), other = f.workspace.document(f.companion.documentId);
    const beforeConnect = f.provider.snapshot(); assert.deepEqual(client.options(other), []); assert.deepEqual(f.provider.snapshot(), beforeConnect);
    await f.provider.connect(); const peer = f.peers[0]!;
    let observed: readonly Readonly<Record<string, unknown>>[] = [];
    const stop = f.provider.subscribe(() => { observed = client.options(f.workspace.document(other.id)); }); t.after(stop);
    await peer.rpc.sendRequest("client/registerCapability", { registrations: [
        { id: "source-signature", method: "textDocument/signatureHelp", registerOptions: { documentSelector: [{ language: "Source" }], triggerCharacters: ["("] } },
        { id: "other-signature", method: "textDocument/signatureHelp", registerOptions: { documentSelector: [{ language: "Companion" }], triggerCharacters: ["["] } }
    ] });
    assert.deepEqual(observed[0]!.triggerCharacters, ["["]); assert.equal(f.provider.snapshot().documents, 0); assert.equal(f.workspace.diagnostics().leases, 0);
    const entered = latch<void>(), answer = latch<unknown>(); let requests = 0;
    t.after(() => answer.resolve(null)); peer.rpc.onRequest("textDocument/signatureHelp", () => { requests++; entered.resolve(); return answer.promise; });
    const pending = client.run(source, 1).result; void pending.catch(() => {}); await entered.promise;
    const owner = f.provider.snapshot(), workspace = f.workspace.diagnostics(), events = [...peer.events];
    for (const document of [other, source, other]) assert.deepEqual(client.options(document)[0]!.triggerCharacters, [document === source ? "(" : "["]);
    await settled(); assert.equal(requests, 1); assert.deepEqual(f.provider.snapshot(), owner); assert.deepEqual(f.workspace.diagnostics(), workspace); assert.deepEqual(peer.events, events);
    answer.resolve({ signatures: [{ label: "call(value)" }] }); const result = await pending; assert.ok(result); assert.ok(result.isCurrent());
    const completed = f.provider.snapshot(); assert.deepEqual(client.options(other)[0]!.triggerCharacters, ["["]);
    assert.ok(result.isCurrent()); assert.deepEqual(f.provider.snapshot(), completed); assert.deepEqual(peer.events, events);
    excludeCompanion = true; assert.deepEqual(client.options(other), []); excludeCompanion = false;
    policyError = new TypeError("Host document mapping failed."); assert.throws(() => client.options(other), error => error === policyError); policyError = undefined;
    f.edit(other.id); assert.throws(() => client.options(other), error => error instanceof RpcError && error.code === -32801);
    assert.ok(result.isCurrent()); assert.deepEqual(peer.events, events);
    await peer.rpc.sendRequest("client/unregisterCapability", { unregisterations: [{ id: "other-signature", method: "textDocument/signatureHelp" }] });
    assert.deepEqual(observed, []); assert.deepEqual(client.options(f.workspace.document(other.id)), []);
    assert.equal(result.isCurrent(), false, "Registration changes still retire captured feature authority.");
    await f.provider.reconnect(); const reconnected = f.provider.snapshot(), reconnectedEvents = [...f.peers[1]!.events];
    assert.deepEqual(client.options(source), []); assert.deepEqual(f.provider.snapshot(), reconnected); assert.deepEqual(f.peers[1]!.events, reconnectedEvents); assert.deepEqual(f.errors, []);
});

test("signature retriggers preserve the last resolved context through a cancelled reply without crossing document or provider authority", async t => {
    let uriVersion = 0;
    const f = fixture(t, { features: ["textDocument/signatureHelp"], documentInfo: doc => ({ uri: `fixture:${uriVersion}/${doc.resourceId}`, languageId: "fixture" }) }),
        client = createLspSignatureClient(f.provider); t.after(client.dispose);
    await f.provider.connect(); const peer = f.peers[0]!, entered = latch<void>(), held = latch<unknown>(); t.after(() => held.resolve(null));
    const contexts: { isRetrigger: boolean; activeSignatureHelp?: unknown }[] = []; let pause = false;
    const help = (label: string) => ({ signatures: [{ label }], activeSignature: 0 }); let response: unknown = help("initial");
    const register = () => f.peers.at(-1)!.rpc.sendRequest("client/registerCapability", { registrations: [{ id: "signature", method: "textDocument/signatureHelp", registerOptions: { documentSelector: null } }] });
    const handler = (params: { context: typeof contexts[number] }) => { contexts.push(params.context); if (pause) { pause = false; entered.resolve(); return held.promise; } return response; };
    peer.rpc.onRequest("textDocument/signatureHelp", handler); await register();
    const run = (id = f.source.documentId, isRetrigger = true, activeSignatureHelp?: ReturnType<typeof help>) => client.run(f.workspace.document(id), 0,
        { triggerKind: 3, isRetrigger, ...(activeSignatureHelp ? { activeSignatureHelp } : {}) }).result;
    await run(f.source.documentId, false); assert.equal(contexts.at(-1)!.activeSignatureHelp, undefined);
    pause = true; f.edit(); const pending = run(), rejected = assert.rejects(pending); await entered.promise;
    assert.deepEqual(contexts.at(-1)!.activeSignatureHelp, help("initial"));
    f.edit(); response = help("latest"); await run(); await rejected;
    assert.deepEqual(contexts.at(-1)!.activeSignatureHelp, help("initial"));
    held.resolve(help("late")); await settled(); await run(); assert.deepEqual(contexts.at(-1)!.activeSignatureHelp, help("latest"));
    await run(f.companion.documentId); assert.equal(contexts.at(-1)!.activeSignatureHelp, undefined);
    uriVersion++; const replacement = f.provider.createScope(); replacement.attachDocument(f.companion.documentId);
    await run(f.companion.documentId); assert.equal(contexts.at(-1)!.activeSignatureHelp, undefined); replacement.dispose();
    await run(f.companion.documentId, true, help("host choice")); assert.deepEqual(contexts.at(-1)!.activeSignatureHelp, help("host choice"));
    client.cancel(); await run(f.companion.documentId); assert.equal(contexts.at(-1)!.activeSignatureHelp, undefined);
    const context = { triggerKind: 3 as const, isRetrigger: true }, captured = client.run(f.workspace.document(f.companion.documentId), 0, context);
    context.isRetrigger = false; await captured.result;
    assert.equal(contexts.at(-1)!.isRetrigger, true); assert.deepEqual(contexts.at(-1)!.activeSignatureHelp, help("latest"));
    await peer.rpc.sendRequest("client/unregisterCapability", { unregisterations: [{ id: "signature", method: "textDocument/signatureHelp" }] }); await register();
    await run(f.companion.documentId); assert.equal(contexts.at(-1)!.activeSignatureHelp, undefined);
    await f.provider.reconnect(); f.peers[1]!.rpc.onRequest("textDocument/signatureHelp", handler); await register();
    await run(f.companion.documentId); assert.equal(contexts.at(-1)!.activeSignatureHelp, undefined);
    response = null; await run(f.companion.documentId); response = help("after empty"); await run(f.companion.documentId);
    assert.equal(contexts.at(-1)!.activeSignatureHelp, undefined);
    const wide = { ...help("wide"), data: "" }; wide.data = "x".repeat(131072 - JSON.stringify(wide).length); response = wide;
    await run(f.companion.documentId); response = help("bounded"); await run(f.companion.documentId);
    assert.equal(contexts.at(-1)!.activeSignatureHelp, undefined, "An optional inherited context must fit the complete advisory bound.");
    await run(f.companion.documentId, false); assert.equal(contexts.at(-1)!.activeSignatureHelp, undefined); assert.deepEqual(f.errors, []);
});
test("occurrences require current dynamic authority through withdrawal and reconnect", async t => {
    const f = fixture(t, { features: ["textDocument/documentHighlight"] }), client = createLspHighlightClient(f.provider); t.after(client.dispose);
    await f.provider.connect();
    const register = async () => {
        const peer = f.peers.at(-1)!; peer.rpc.onRequest("textDocument/documentHighlight", () => [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, kind: 3 }]);
        await peer.rpc.sendRequest("client/registerCapability", { registrations: [{ id: "occurrences", method: "textDocument/documentHighlight", registerOptions: { documentSelector: [{ language: "generic-language" }] } }] });
    };
    const run = () => client.run(f.workspace.document(f.source.documentId), 0).result;
    await assert.rejects(run(), error => error instanceof RpcError && error.code === -32601);
    await register(); const first = await run(); assert.equal(first.items.length, 1);
    await f.peers[0]!.rpc.sendRequest("client/unregisterCapability", { unregisterations: [{ id: "occurrences", method: "textDocument/documentHighlight" }] });
    assert.equal(first.isCurrent(), false); await assert.rejects(run(), error => error instanceof RpcError && error.code === -32601);
    await register(); const second = await run(); await f.provider.reconnect(); assert.equal(second.isCurrent(), false);
    await assert.rejects(run(), error => error instanceof RpcError && error.code === -32601); await register(); assert.equal((await run()).isCurrent(), true);
});
test("folding honors dynamic capability withdrawal and requires fresh authority after reconnect", async t => {
    const f = fixture(t, { features: ["textDocument/foldingRange"] }), client = createLspFoldingClient(f.provider); t.after(client.dispose);
    await f.provider.connect();
    const register = async () => {
        const peer = f.peers.at(-1)!; peer.rpc.onRequest("textDocument/foldingRange", () => [{ startLine: 0, endLine: 1 }]);
        await peer.rpc.sendRequest("client/registerCapability", { registrations: [{ id: "folds", method: "textDocument/foldingRange", registerOptions: { documentSelector: [{ language: "generic-language" }] } }] });
    };
    const run = () => client.run(f.workspace.document(f.source.documentId)).result;
    await assert.rejects(run(), error => error instanceof RpcError && error.code === -32601);
    await register(); const first = await run(); assert.equal(first.ranges.length, 1);
    await f.peers[0]!.rpc.sendRequest("client/unregisterCapability", { unregisterations: [{ id: "folds", method: "textDocument/foldingRange" }] });
    assert.equal(first.isCurrent(), false); await assert.rejects(run(), error => error instanceof RpcError && error.code === -32601);
    await register(); const second = await run(); await f.provider.reconnect(); assert.equal(second.isCurrent(), false);
    await assert.rejects(run(), error => error instanceof RpcError && error.code === -32601); await register(); assert.equal((await run()).isCurrent(), true);
});
test("selected language clients share one binding and decode their independent results", async t => {
    const { f, signature, links, colors, rgba, doc } = await languageFixture(t);
    const [help, linkBatch, colorBatch] = await Promise.all([signature.run(doc, 1).result, links.run(doc), colors.run(doc)]);
    assert.equal(help!.signatures[0]!.activeParameter, 0);
    assert.equal((await linkBatch.resolve(linkBatch.items[0]!)).target, "host+opaque:%2F unknown");
    const choices = await colorBatch.presentations(colorBatch.items[0]!, rgba), after = doc.buffer.apply(choices[0]!.edits).buffer;
    assert.equal(after.slice(0, after.length), "#f00😀\r\nsource!");
    assert.equal(f.provider.snapshot().documents, 1); assert.equal(f.provider.snapshot().documentParticipants, 3);
    assert.equal(f.peers[0]!.events.filter(event => event.method === "open").length, 1);
    signature.dispose(); links.dispose(); colors.dispose(); await settled();
    assert.equal(f.provider.snapshot().scopes, 0); assert.equal(f.provider.snapshot().documents, 0); assert.equal(f.workspace.diagnostics().leases, 0);
});

test("cancelling a lazy color presentation leaves independent language results current", async t => {
    const { peer, signature, links, colors, rgba, doc } = await languageFixture(t);
    const [help, linkBatch, colorBatch] = await Promise.all([signature.run(doc, 1).result, links.run(doc), colors.run(doc)]);
    const entered = latch<void>(), late = latch<unknown>(); t.after(() => late.resolve([]));
    peer.rpc.onRequest("textDocument/colorPresentation", () => { entered.resolve(); return late.promise; });
    const pending = colorBatch.presentations(colorBatch.items[0]!, rgba);
    const rejected = assert.rejects(pending, error => error instanceof RpcError && error.code === -32800);
    await entered.promise; colors.cancel(); await rejected;
    late.resolve([{ label: "late" }]); await settled();
    assert.equal(colorBatch.isCurrent(), false); assert.equal(linkBatch.isCurrent(), true); assert.equal(help!.isCurrent(), true);
});

test("editing expires a captured document link before lazy resolution dispatch", async t => {
    const { f, peer, links, doc } = await languageFixture(t);
    const batch = await links.run(doc); let resolutions = 0;
    peer.rpc.onRequest("documentLink/resolve", () => { resolutions++; return {}; });
    f.edit(); assert.equal(batch.isCurrent(), false);
    await assert.rejects(batch.resolve(batch.items[0]!), error => error instanceof RpcError && error.code === -32801);
    assert.equal(resolutions, 0);
});

test("signature capability removal expires its result and prevents further dispatch", async t => {
    const { f, peer, signature, links, doc } = await languageFixture(t);
    const help = await signature.run(doc, 1).result;
    await peer.rpc.sendRequest("client/unregisterCapability", { unregisterations: [{ id: "language-0", method: "textDocument/signatureHelp" }] });
    assert.equal(help!.isCurrent(), false);
    await assert.rejects(signature.run(doc, 1).result, error => error instanceof RpcError && error.code === -32601);
    assert.equal((await links.run(f.workspace.document(doc.id))).items.length, 1);
});

async function languageFixture(t: test.TestContext) {
    const f = fixture(t, { features: ["textDocument/signatureHelp", "textDocument/documentLink", "textDocument/documentColor", "textDocument/colorPresentation"] }); await f.provider.connect(); const peer = f.peers[0]!;
    await peer.rpc.sendRequest("client/registerCapability", { registrations: ["textDocument/signatureHelp", "textDocument/documentLink", "textDocument/documentColor"].map((method, i) => ({ id: `language-${i}`, method, registerOptions: { documentSelector: null, ...(i === 1 ? { resolveProvider: true } : {}) } })) });
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, rgba = { red: 1, green: 0, blue: 0, alpha: .5 };
    peer.rpc.onRequest("textDocument/signatureHelp", () => { return { signatures: [{ label: "call(value)", parameters: [{ label: "value" }] }], activeParameter: 0 }; });
    peer.rpc.onRequest("textDocument/documentLink", () => [{ range, data: { token: 1 } }]); peer.rpc.onRequest("documentLink/resolve", (item: object) => ({ ...item, target: "host+opaque:%2F unknown" }));
    peer.rpc.onRequest("textDocument/documentColor", () => [{ range, color: rgba }]);
    peer.rpc.onRequest("textDocument/colorPresentation", () => [{ label: "red", textEdit: { range, newText: "#f00" }, additionalTextEdits: [{ range: { start: { line: 1, character: 6 }, end: { line: 1, character: 6 } }, newText: "!" }] }]);
    const signature = createLspSignatureClient(f.provider), links = createLspLinkClient(f.provider), colors = createLspColorClient(f.provider); t.after(() => { signature.dispose(); links.dispose(); colors.dispose(); });
    return { f, peer, signature, links, colors, rgba, doc: f.workspace.document(f.source.documentId) };
}

function fixture(t: test.TestContext, extra: Readonly<{ maxDocumentUnits?: number; features?: readonly LspFeature[]; schedule?: RpcScheduler; documentInfo?: LspWorkspaceOptions["documentInfo"] }> = {}) {
    const workspace = new Workspace(), source = workspace.createTextResource({ scope: "generic", resource: "source", variant: "working" }, "Source", { value: "a😀\r\nsource" }),
        companion = workspace.createTextResource({ scope: "generic", resource: "companion", variant: "working" }, "Companion", { value: "companion" });
    const timers = new Set<ReturnType<typeof setTimeout>>(), errors: string[] = [], peers: ReturnType<typeof peer>[] = [];
    const schedule: RpcScheduler = (ms, callback) => { const timer = setTimeout(() => { timers.delete(timer); callback(); }, ms); timers.add(timer); return () => { clearTimeout(timer); timers.delete(timer); }; };
    function peer() {
        type Listener = Parameters<RpcTransport["subscribe"]>[0]; const listeners: (Listener | undefined)[] = [undefined, undefined], sent: string[] = []; let closed = false;
        const ports = [0, 1].map(index => ({ send(text: string): void { assert.equal(this, ports[index]); if (closed) throw Error("Closed transport"); if (!index) { const method: unknown = JSON.parse(text).method; if (typeof method === "string") sent.push(method); } queueMicrotask(() => { if (!closed) listeners[1 - index]?.message(text); }); },
            subscribe(listener: Listener): () => void { assert.equal(this, ports[index]); listeners[index] = listener; return () => { if (listeners[index] === listener) listeners[index] = undefined; }; },
            dispose: () => { if (closed) return; closed = true; for (const listener of listeners) listener?.close(Error("Closed")); listeners.fill(undefined); } }));
        const rpc = referencePeer(ports[1]!), documents = new Map<string, TextDocument>(), events: { method: string; uri?: string }[] = [], changes: DidChangeTextDocumentParams[] = [];
        rpc.onRequest("initialize", () => { events.push({ method: "initialize" }); return { capabilities: { positionEncoding: "utf-16", textDocumentSync: 2, hoverProvider: true, definitionProvider: true, executeCommandProvider: { commands: ["test.edit"] } } }; });
        rpc.onNotification("textDocument/didOpen", (p: DidOpenTextDocumentParams) => { assert.ok(!documents.has(p.textDocument.uri)); documents.set(p.textDocument.uri, TextDocument.create(p.textDocument.uri, p.textDocument.languageId, p.textDocument.version, p.textDocument.text)); events.push({ method: "open", uri: p.textDocument.uri }); });
        rpc.onNotification("textDocument/didChange", (p: DidChangeTextDocumentParams) => { changes.push(p); const before = documents.get(p.textDocument.uri)!; let text = before.getText();
            for (const change of p.contentChanges) { assert.ok("range" in change); text = TextDocument.applyEdits(TextDocument.create(before.uri, before.languageId, before.version, text), [{ range: change.range, newText: change.text }]); }
            documents.set(before.uri, TextDocument.create(before.uri, before.languageId, p.textDocument.version, text)); events.push({ method: "change", uri: before.uri }); });
        rpc.onNotification("textDocument/didClose", (p: DidCloseTextDocumentParams) => { assert.ok(documents.delete(p.textDocument.uri)); events.push({ method: "close", uri: p.textDocument.uri }); });
        rpc.onRequest("test/barrier", () => null); rpc.onRequest("textDocument/definition", () => []); rpc.onRequest("textDocument/hover", () => ({ contents: "shared provider" }));
        rpc.listen(); return { rpc, documents, events, changes, sent, transport: ports[0]! };
    }
    const provider = new LspWorkspace(workspace, { ...extra, features: extra.features ?? ["textDocument/hover", "textDocument/definition", "workspace/executeCommand"], applyEdit: true, diagnostics: true, schedule: extra.schedule ?? schedule,
        connect: async () => { const next = peer(); peers.push(next); return next.transport; },
        documentInfo: extra.documentInfo ?? (doc => ({ uri: `host+opaque:workspace/${encodeURIComponent(doc.resourceId)}`, languageId: "generic-language" })), onError: error => errors.push(error.message) });
    t.after(async () => { provider.dispose(); await settled(); for (const peer of peers) peer.rpc.dispose(); for (const timer of timers) clearTimeout(timer); });
    const edit = (id = source.documentId, insert = "!") => { const doc = workspace.document(id); assert.equal(workspace.edit({ documentId: id, expectedRevision: doc.revision, edits: [{ from: doc.buffer.length, to: doc.buffer.length, insert }], origin: "human" }).applied, true); };
    return { workspace, provider, source, companion, peers, errors, timers, edit };
}

test("workspace batches and grouped history retain bounded wire edits; skipped revisions and reconnect stay exact", async t => {
    const f = fixture(t), id = f.source.documentId, initial = f.workspace.document(id), text = "row 😀\r\n".repeat(100_000);
    f.workspace.edit({ documentId: id, expectedRevision: initial.revision, edits: [{ from: 0, to: initial.buffer.length, insert: text }], origin: "human" });
    const scope = f.provider.createScope(), binding = scope.attachDocument(id); await scope.ensureConnected();
    const uri = binding.getSnapshot().uri, peer = f.peers[0]!;
    const verify = async (bounded: boolean) => {
        await scope.flush(); await scope.request("test/barrier").result;
        const doc = f.workspace.document(id), changes = peer.changes.at(-1)!.contentChanges;
        assert.equal(peer.documents.get(uri)!.getText(), doc.buffer.slice(0, doc.buffer.length));
        if (bounded) { assert.equal(changes.length, 2); assert.ok(changes.reduce((sum, change) => sum + change.text.length, 0) < 32); }
    };
    const type = (insert: string, step: number) => {
        const doc = f.workspace.document(id), far = doc.buffer.offsetAt(99_998) + 2 + step;
        assert.equal(f.workspace.edit({ documentId: id, expectedRevision: doc.revision, origin: "human", history: { kind: "typing", group: "batch" },
            edits: [{ from: 2 + step, to: 2 + step, insert }, { from: far, to: far, insert }] }).applied, true);
    };
    type("a", 0); await verify(true); type("b", 1); await verify(true);
    assert.equal(f.workspace.undo({ documentId: id, expectedRevision: f.workspace.document(id).revision }).applied, true); await verify(true);
    assert.equal(peer.documents.get(uri)!.getText(), text);
    assert.equal(f.workspace.redo({ documentId: id, expectedRevision: f.workspace.document(id).revision }).applied, true); await verify(true);
    const acknowledged = f.workspace.document(id), version = peer.documents.get(uri)!.version, updates = peer.changes.length;
    assert.equal(f.workspace.undo({ documentId: id, expectedRevision: acknowledged.revision }).applied, true);
    assert.equal(f.workspace.redo({ documentId: id, expectedRevision: f.workspace.document(id).revision }).applied, true);
    const restored = f.workspace.document(id);
    assert.equal(restored.buffer, acknowledged.buffer); assert.equal(restored.revision, acknowledged.revision + 2);
    await verify(false);
    assert.equal(peer.changes.length, updates + 1); assert.equal(peer.documents.get(uri)!.version, version + 1);
    assert.deepEqual(peer.changes.at(-1)!.contentChanges, [], "A new revision of the acknowledged buffer advances the wire version without copying text.");
    const count = peer.changes.length; f.edit(id, "first"); f.edit(id, "second"); await verify(false);
    assert.equal(peer.changes.length, count + 1, "Skipped local revisions still coalesce into one exact wire update.");
    f.provider.disconnect(); f.edit(id, "offline"); await f.provider.connect(); await scope.request("test/barrier").result;
    const reopened = f.peers[1]!, doc = f.workspace.document(id);
    assert.equal(reopened.changes.length, 0); assert.equal(reopened.documents.get(uri)!.getText(), doc.buffer.slice(0, doc.buffer.length)); assert.deepEqual(f.errors, []);
});

test("feature scopes wait for their captured project without flushing unrelated bindings", async t => {
    const queued = new Set<() => void>(); let blocked = false;
    const f = fixture(t, { schedule: (ms, callback) => {
        if (blocked && ms === 0) { queued.add(callback); return () => { queued.delete(callback); }; }
        const timer = setTimeout(callback, ms); return () => clearTimeout(timer);
    } }), client = createLspHoverClient(f.provider), other = f.provider.createScope(); t.after(client.dispose);
    const run = () => client.run(f.workspace.document(f.source.documentId), 0).result;
    await run(); blocked = true; f.edit(f.companion.documentId, "large\n".repeat(10_000)); other.attachDocument(f.companion.documentId);
    let completed = false, flushed = false;
    void run().then(() => { completed = true; }, () => {}); void other.flush().then(() => { flushed = true; }, () => {});
    await settled(); await other.request("test/barrier").result;
    assert.equal(completed, true, "The feature's preparation barrier must cover only its captured documents."); assert.equal(flushed, false);
    blocked = false; for (const callback of queued) callback(); queued.clear(); await other.flush();
    assert.equal(flushed, true); assert.deepEqual(f.errors, []);
    blocked = true; const released = other.attachDocument(f.source.documentId); f.edit();
    const waiting = other.flush([released]), expired = assert.rejects(waiting, error => error instanceof RpcError && error.code === -32801);
    released.dispose(); // The hover client still retains the shared binding.
    blocked = false; for (const callback of queued) callback(); queued.clear(); await expired;
});

test("provider scopes share one initialize, binding and incremental stream while retaining independent participation", async t => {
    const f = fixture(t), a = f.provider.createScope(), b = f.provider.createScope(), c = f.provider.createScope();
    assert.equal(f.peers.length, 0); const left = a.attachDocument(f.source.documentId), right = b.attachDocument(f.source.documentId), other = c.attachDocument(f.companion.documentId);
    assert.equal(f.workspace.diagnostics().leases, 2); await Promise.all([a.ensureConnected(), b.ensureConnected(), c.ensureConnected()]); await a.request("test/barrier").result;
    assert.equal(f.peers.length, 1); const peer = f.peers[0]!, uri = left.getSnapshot().uri;
    assert.equal(peer.events.filter(e => e.method === "initialize").length, 1); assert.equal(peer.events.filter(e => e.method === "open").length, 2);
    assert.equal(left.getSnapshot(), right.getSnapshot()); const old = b.synchronized(right)!, identity = right.getSnapshot();
    assert.equal(b.isDocumentCurrent(right, identity), true); assert.equal(a.isDocumentCurrent(right, identity), false);
    f.edit(); f.edit(f.source.documentId, "second"); f.edit(f.companion.documentId); assert.equal(old.isCurrent(), false); assert.equal(old.isBindingCurrent!(), true); assert.equal(b.synchronized(right), undefined);
    assert.equal(right.getSnapshot(), identity, "The binding has not received the deferred Workspace update yet.");
    assert.equal(b.isDocumentCurrent(right, identity), false, "An unflushed edit must invalidate a read-only identity check.");
    await Promise.all([a.flush(), b.flush(), c.flush()]); await a.request("test/barrier").result;
    assert.equal(peer.events.filter(e => e.method === "change" && e.uri === uri).length, 1);
    assert.equal(peer.documents.get(uri)!.getText(), "a😀\r\nsource!second"); assert.equal(peer.documents.get(other.getSnapshot().uri)!.getText(), "companion!");
    a.dispose(); await b.flush(); assert.equal(peer.events.filter(e => e.method === "close" && e.uri === uri).length, 0); assert.ok(b.synchronized(right)!.isCurrent());
    right.dispose(); await b.flush(); await c.request("test/barrier").result; assert.equal(peer.events.filter(e => e.method === "close" && e.uri === uri).length, 1);
    assert.equal(old.isBindingCurrent!(), false);
    assert.equal(b.isDocumentCurrent(right, identity), false);
    assert.equal(f.provider.snapshot().documents, 1); f.provider.dispose(); await settled();
    assert.equal(f.workspace.diagnostics().leases, 0); assert.equal(f.workspace.diagnostics().subscriptions, 0); assert.equal(f.provider.snapshot().scopes, 0);
    assert.equal(f.provider.snapshot().created, 1); assert.equal(f.provider.snapshot().terminated, 1); assert.equal(f.provider.snapshot().protocol.pendingRequests, 0); assert.deepEqual(f.errors, []);
});

test("closing one feature cancels only its pending request and leaves the other view/provider usable", async t => {
    const f = fixture(t), hover = f.provider.createScope(), navigation = f.provider.createScope(), entered = latch<void>(), answer = latch<unknown>();
    const a = hover.attachDocument(f.source.documentId), b = navigation.attachDocument(f.source.documentId); await hover.ensureConnected();
    f.peers[0]!.rpc.onRequest("textDocument/hover", () => { entered.resolve(); return answer.promise; });
    const request = hover.requestDocument("textDocument/hover", a, index => ({ position: index.at(1) })), rejected = assert.rejects(request.result, error => error instanceof RpcError && error.code === -32800);
    await entered.promise; hover.dispose(); await rejected;
    assert.deepEqual(await navigation.requestDocument("textDocument/definition", b, index => ({ position: index.at(1) })).result, []);
    answer.resolve({ contents: "late" }); await settled(); assert.equal(f.provider.snapshot().created, 1); assert.equal(f.provider.snapshot().terminated, 0);
    assert.equal(f.provider.getSnapshot().phase, "ready"); assert.equal(f.provider.snapshot().documents, 1); assert.deepEqual(f.errors, []);
});

test("scope cancellation retains handlers and participation while expiring only its requests", async t => {
    const f = fixture(t), a = f.provider.createScope(), b = f.provider.createScope(), entered = latch<void>(), answer = latch<unknown>();
    t.after(() => answer.resolve(null)); const doc = a.attachDocument(f.source.documentId); b.attachDocument(f.source.documentId);
    a.onRequest("host/retained", () => "still registered"); await a.ensureConnected();
    const exact = a.synchronized(doc)!, peer = f.peers[0]!, before = f.provider.snapshot();
    peer.rpc.onRequest("test/held", () => { entered.resolve(); return answer.promise; });
    const call = a.request("test/held"), rejected = assert.rejects(call.result, error => error instanceof RpcError && error.code === -32800);
    await entered.promise; a.cancel(); await rejected;
    assert.equal(exact.isCurrent(), false); assert.equal(f.provider.getSnapshot().phase, "ready");
    assert.equal(f.provider.snapshot().documentParticipants, before.documentParticipants); assert.equal(f.workspace.diagnostics().leases, 1);
    assert.equal(await peer.rpc.sendRequest("host/retained"), "still registered");
    await b.request("test/barrier").result; await a.request("test/barrier").result;
    a.dispose(); a.dispose(); a.cancel(); assert.equal(f.provider.snapshot().documentParticipants, 1);
    assert.throws(() => a.attachDocument(f.source.documentId), RpcError); assert.equal(f.provider.snapshot().terminated, 0);
});

test("owner shutdown flushes latest text, retains participation and silences cancellation after shutdown", async t => {
    const f = fixture(t), a = f.provider.createScope(), b = f.provider.createScope(), doc = a.attachDocument(f.source.documentId);
    b.attachDocument(f.source.documentId); await a.ensureConnected(); const exact = a.synchronized(doc)!, peer = f.peers[0]!;
    const stopping = latch<void>(), finish = latch<null>(), commandEntered = latch<void>(), commandAnswer = latch<unknown>();
    t.after(() => { finish.resolve(null); commandAnswer.resolve(null); });
    peer.rpc.onRequest("workspace/executeCommand", () => { commandEntered.resolve(); return commandAnswer.promise; });
    peer.rpc.onRequest("shutdown", () => { stopping.resolve(); return finish.promise; });
    const command = a.requestCommand("test.edit"), rejected = assert.rejects(command.result, RpcError); await commandEntered.promise;
    f.edit(); const closing = f.provider.shutdown(); await stopping.promise;
    assert.equal(peer.documents.get(doc.getSnapshot().uri)!.getText(), "a😀\r\nsource!");
    assert.equal(f.provider.getSnapshot().phase, "stopping"); assert.equal(exact.isCurrent(), false);
    assert.throws(() => b.request("test/barrier"), RpcError); await assert.rejects(b.ensureConnected(), RpcError);
    f.edit(f.source.documentId, "offline"); a.cancel(); await rejected; b.dispose(); await settled();
    assert.deepEqual(peer.sent.slice(peer.sent.indexOf("shutdown") + 1), []);
    finish.resolve(null); await closing; await settled(); assert.deepEqual(peer.sent.slice(-2), ["shutdown", "exit"]);
    assert.equal(f.provider.getSnapshot().phase, "disconnected"); assert.equal(f.provider.snapshot().scopes, 1);
    assert.equal(f.provider.snapshot().documents, 1); assert.equal(f.workspace.diagnostics().leases, 1); assert.equal(f.provider.snapshot().commandQuarantined, false);
    await a.ensureConnected(); const next = f.peers[1]!; await a.request("test/barrier").result;
    assert.equal(next.documents.get(doc.getSnapshot().uri)!.getText(), "a😀\r\nsource!offline"); assert.ok(a.synchronized(doc)!.isCurrent());
    assert.equal(next.events.filter(event => event.method === "open").length, 1); assert.equal(next.sent.includes("workspace/executeCommand"), false);
    commandAnswer.resolve("late"); await settled(); assert.equal(f.provider.snapshot().created, 2); assert.equal(f.provider.snapshot().terminated, 1);
    a.dispose(); await settled(); assert.equal(f.workspace.diagnostics().leases, 0);
});

test("owner shutdown failure and disposal cannot close a replacement connection", async t => {
    const f = fixture(t), scope = f.provider.createScope(); scope.attachDocument(f.source.documentId); await scope.ensureConnected();
    f.peers[0]!.rpc.onRequest("shutdown", () => "invalid");
    await assert.rejects(f.provider.shutdown(), /Invalid LSP shutdown result/); assert.equal(f.provider.getSnapshot().phase, "disconnected");
    assert.equal(f.peers[0]!.sent.includes("exit"), false); assert.equal(f.workspace.diagnostics().leases, 1);
    await scope.ensureConnected(); const entered = latch<void>(), late = latch<null>(); t.after(() => late.resolve(null));
    f.peers[1]!.rpc.onRequest("shutdown", () => { entered.resolve(); return late.promise; });
    const shutdown = f.provider.shutdown(), rejected = assert.rejects(shutdown, RpcError); await entered.promise;
    await f.provider.reconnect(); await rejected; late.resolve(null); await settled();
    assert.equal(f.provider.getSnapshot().phase, "ready"); assert.equal(f.provider.snapshot().terminated, 2);
    assert.equal(f.peers[2]!.sent.includes("exit"), false); await scope.request("test/barrier").result;
    const disposing = latch<void>(); f.peers[2]!.rpc.onRequest("shutdown", () => { disposing.resolve(); return new Promise(() => {}); });
    const pending = f.provider.shutdown(), cancelled = assert.rejects(pending, RpcError); await disposing.promise; f.provider.dispose(); await cancelled; await settled();
    assert.equal(f.provider.getSnapshot().phase, "disposed"); assert.equal(f.provider.snapshot().scopes, 0); assert.equal(f.workspace.diagnostics().leases, 0);
});

test("one reconnect reopens latest shared snapshots once and invalidates old captures without replay", async t => {
    const f = fixture(t), a = f.provider.createScope(), b = f.provider.createScope(), doc = a.attachDocument(f.source.documentId); b.attachDocument(f.source.documentId); b.attachDocument(f.companion.documentId);
    await a.ensureConnected(); const before = a.synchronized(doc)!; f.provider.disconnect(); f.edit(); await f.provider.connect(); await b.request("test/barrier").result;
    assert.equal(before.isCurrent(), false); assert.equal(before.isBindingCurrent!(), false); assert.equal(f.peers.length, 2); const peer = f.peers[1]!;
    assert.equal(peer.events.filter(e => e.method === "initialize").length, 1); assert.equal(peer.events.filter(e => e.method === "open").length, 2);
    assert.equal(peer.events.filter(e => e.method === "change").length, 0); assert.equal(peer.documents.get(doc.getSnapshot().uri)!.getText(), "a😀\r\nsource!");
    assert.ok(a.synchronized(doc)!.isCurrent()); assert.equal(f.provider.snapshot().created, 2); assert.equal(f.provider.snapshot().terminated, 1);
});

test("command review is exclusive and cancellation quarantines uncorrelated edits without disconnecting readers", async t => {
    const f = fixture(t), a = f.provider.createScope(), b = f.provider.createScope(), entered = latch<void>(), cancelled = latch<void>(), decision = latch<{ applied: boolean }>();
    const doc = a.attachDocument(f.source.documentId); b.attachDocument(f.source.documentId); let context: LspRequestContext | undefined, wrongOwner = 0;
    a.onRequest("workspace/applyEdit", async (_value, captured) => { context = captured; const stop = captured.onCancel(() => cancelled.resolve()); entered.resolve(); try { return await decision.promise; } finally { stop(); } });
    b.onRequest("workspace/applyEdit", () => { wrongOwner++; return { applied: true }; }); await a.ensureConnected();
    const peer = f.peers[0]!; peer.rpc.onRequest("workspace/executeCommand", async () => peer.rpc.sendRequest("workspace/applyEdit", { edit: { changes: {} } }));
    const call = a.requestCommand("test.edit"), rejected = assert.rejects(call.result, error => error instanceof RpcError && error.code === -32800); await entered.promise;
    assert.ok(context!.isCurrent()); assert.throws(() => b.requestCommand("test.edit"), RpcError);
    assert.deepEqual(await b.requestDocument("textDocument/definition", b.attachDocument(f.source.documentId), index => ({ position: index.at(0) })).result, []);
    call.cancel(); await rejected; await cancelled.promise; assert.equal(context!.isCurrent(), false); decision.resolve({ applied: false }); await settled();
    assert.equal(f.provider.snapshot().commandQuarantined, true); assert.equal(f.provider.getSnapshot().commandRequiresReconnect, true); assert.equal(f.provider.getSnapshot().commandAvailable, false); assert.throws(() => b.requestCommand("test.edit"), RpcError);
    assert.deepEqual(await peer.rpc.sendRequest("workspace/applyEdit", { edit: { changes: {} } }), { applied: false, failureReason: "No available captured command review intent." });
    assert.equal(wrongOwner, 0); assert.equal(f.provider.getSnapshot().phase, "ready"); assert.equal(f.provider.snapshot().terminated, 0);
    assert.ok(b.synchronized(b.attachDocument(f.source.documentId))!.isCurrent()); assert.equal(doc.getSnapshot().buffer.length, "a😀\r\nsource".length);
    await f.provider.reconnect(); assert.equal(f.provider.snapshot().commandQuarantined, false); assert.equal(f.provider.getSnapshot().commandAvailable, true);
    f.peers[1]!.rpc.onRequest("workspace/executeCommand", () => "done"); const next = b.requestCommand("test.edit"); assert.equal(await next.result, "done"); assert.equal(next.isCurrent(), true);
});

test("a rejected oversized update expires associations but preserves unrelated documents and local text", async t => {
    const f = fixture(t, { maxDocumentUnits: 16 }), a = f.provider.createScope(), b = f.provider.createScope(), doc = a.attachDocument(f.source.documentId); b.attachDocument(f.companion.documentId); await a.ensureConnected();
    const captured = a.synchronized(doc)!; f.edit(f.source.documentId, "x".repeat(32)); assert.equal(captured.isCurrent(), false); await settled();
    assert.equal(a.synchronized(doc), undefined); assert.equal(f.provider.snapshot().documents, 1); assert.equal(f.provider.getSnapshot().phase, "ready");
    assert.equal(f.workspace.document(f.source.documentId).buffer.length, "a😀\r\nsource".length + 32); assert.equal(f.errors.length, 1);
    assert.deepEqual(await b.requestDocument("textDocument/definition", b.attachDocument(f.companion.documentId), index => ({ position: index.at(0) })).result, []);
});

test("shared diagnostic placement preserves unknown freshness and expires on reconnect and URI reuse", async t => {
    const f = fixture(t), a = f.provider.createScope(), b = f.provider.createScope(), left = a.attachDocument(f.source.documentId), right = b.attachDocument(f.source.documentId);
    const first = a.observeDiagnostics(left), second = b.observeDiagnostics(right); await a.ensureConnected();
    const send = async (value: unknown) => { f.peers.at(-1)!.rpc.sendNotification("textDocument/publishDiagnostics", value); await a.request("test/barrier").result; };
    const capture = a.synchronized(left)!, range = { start: { line: 1, character: 0 }, end: { line: 1, character: 6 } };
    const message = { uri: capture.document.uri, diagnostics: [{ range, message: "shared warning" }] };
    await send({ ...message, version: capture.version }); const verified = first.getSnapshot();
    assert.equal(verified, second.getSnapshot()); assert.equal(verified.result!.freshness, "versioned"); assert.equal(verified.result!.revision, f.workspace.document(f.source.documentId).revision);
    await send({ ...message, version: capture.version + 1 }); assert.equal(first.getSnapshot().result, verified.result); assert.equal(first.getSnapshot().stale, 1);
    await send({ ...message, diagnostics: [{ range: { start: range.end, end: range.start }, message: "invalid" }] }); assert.equal(first.getSnapshot().invalid, 1);
    await send({ ...message, uri: "host+opaque:unknown" }); assert.equal(f.provider.snapshot().unknownDiagnosticUris, 1); assert.equal(first.getSnapshot().result, verified.result);
    await send(message); const uncertain = first.getSnapshot(); assert.equal(uncertain.result!.version, null); assert.equal(uncertain.result!.revision, null);
    assert.equal(uncertain.result!.snapshotRevision, capture.document.revision); assert.equal(uncertain.result!.items[0]!.from, 5); assert.equal(uncertain.isCurrent(), true);
    f.edit(); assert.equal(uncertain.isCurrent(), false); assert.equal(uncertain.isPlacementCurrent(), false);
    assert.equal(first.getSnapshot().status, "pending"); assert.equal(first.getSnapshot().result!.items[0]!.from, 5);
    await a.flush(); await send({ ...message, diagnostics: [{ range: { start: { line: 100, character: 0 }, end: { line: 100, character: 4 } }, message: "outside" }] });
    assert.equal(first.getSnapshot().result!.items[0]!.placement, "out-of-bounds"); assert.equal(first.getSnapshot().result!.items[0]!.from, null);
    const beforeReconnect = first.getSnapshot(); await f.provider.reconnect(); assert.equal(beforeReconnect.isCurrent(), false); assert.equal(first.getSnapshot().status, "expired");
    await send(message); f.edit(f.source.documentId, "?"); const beforeReuse = first.getSnapshot();
    assert.equal(beforeReuse.status, "pending"); assert.equal(beforeReuse.isPlacementCurrent(), true); left.dispose(); right.dispose(); await settled();
    const replacement = a.attachDocument(f.source.documentId); await a.flush(); assert.equal(beforeReuse.isCurrent(), false);
    assert.equal(a.observeDiagnostics(replacement).getSnapshot().status, "empty"); assert.equal(first.getSnapshot().status, "expired");
    const buffer = f.workspace.document(f.source.documentId).buffer; assert.equal(buffer.slice(0, buffer.length), "a😀\r\nsource!?"); assert.deepEqual(f.errors, []);
    replacement.dispose(); await settled(); f.workspace.releaseResource(f.source.id, true);
    assert.throws(() => f.workspace.document(f.source.documentId), /released/);
    assert.equal(beforeReuse.isCurrent(), false); assert.equal(beforeReuse.isPlacementCurrent(), false); assert.equal(verified.isCurrent(), false);
});

test("pending diagnostics map consecutive edits and undo without renewing provider authority", async t => {
    const f = fixture(t), scope = f.provider.createScope(), binding = scope.attachDocument(f.source.documentId), state = scope.observeDiagnostics(binding);
    await scope.ensureConnected(); const capture = scope.synchronized(binding)!;
    const send = async (diagnostics: unknown[], version = capture.version) => {
        f.peers.at(-1)!.rpc.sendNotification("textDocument/publishDiagnostics", { uri: capture.document.uri, version, diagnostics });
        await scope.request("test/barrier").result;
    };
    const range = (line: number, start: number, end: number) => ({ start: { line, character: start }, end: { line, character: end } });
    await send([{ range: range(1, 0, 6), message: "word" }, { range: range(1, 2, 2), message: "point" }, { range: range(100, 0, 1), message: "unplaced" }]);
    const fresh = state.getSnapshot(), initial = fresh.result!;
    const edit = (from: number, to: number, insert: string) => {
        const doc = f.workspace.document(f.source.documentId);
        assert.equal(f.workspace.edit({ documentId: doc.id, expectedRevision: doc.revision, edits: [{ from, to, insert }], origin: "human" }).applied, true);
    };
    const check = (from: number, to: number) => {
        const pending = state.getSnapshot(); assert.equal(pending.status, "pending"); assert.equal(pending.isCurrent(), false); assert.equal(pending.isPlacementCurrent(), true);
        assert.equal(pending.result!.snapshotRevision, f.workspace.document(f.source.documentId).revision);
        assert.equal(pending.result!.version, initial.version); assert.equal(pending.result!.revision, initial.revision);
        assert.deepEqual(pending.result!.items.map(item => [item.from, item.to]), [[from, to], [from + 2, from + 2], [null, null]]);
        assert.equal(pending.result!.items[0]!.range, initial.items[0]!.range); assert.ok(Object.isFrozen(pending.result!.items));
        return pending;
    };
    edit(0, 0, "head\r\n"); const first = check(11, 17); assert.equal(fresh.isCurrent(), false); assert.equal(fresh.isPlacementCurrent(), false);
    edit(0, 0, "😀"); check(13, 19); assert.equal(first.isPlacementCurrent(), false);
    const undo = () => { assert.equal(f.workspace.undo({ documentId: f.source.documentId, expectedRevision: f.workspace.document(f.source.documentId).revision }).applied, true); };
    undo(); check(11, 17); undo(); check(5, 11);
    assert.deepEqual(initial.items.map(item => [item.from, item.to]), [[5, 11], [7, 7], [null, null]], "Retained snapshots never mutate.");
    await scope.flush(); const beforeStale = state.getSnapshot().result;
    await send([]); assert.equal(state.getSnapshot().result, beforeStale); assert.equal(state.getSnapshot().stale, 1);
    edit(5, 11, "replacement"); assert.deepEqual(state.getSnapshot().result!.items.map(item => item.message), ["unplaced"]);
    undo(); assert.deepEqual(state.getSnapshot().result!.items.map(item => item.message), ["unplaced"], "Undo cannot resurrect invalidated provider ranges.");
    const beforeReconnect = state.getSnapshot(); await f.provider.reconnect();
    assert.equal(beforeReconnect.isPlacementCurrent(), false); assert.equal(state.getSnapshot().status, "expired");
    await scope.flush(); await send([], scope.synchronized(binding)!.version);
    assert.equal(state.getSnapshot().status, "current"); assert.equal(state.getSnapshot().isCurrent(), true); assert.deepEqual(state.getSnapshot().result!.items, []);
    assert.equal(f.workspace.document(f.source.documentId).buffer.diagnostics().textExports, 0);
    const beforeLoad = state.getSnapshot(), load = f.workspace.operations.beginLoad(f.source);
    assert.equal(load.accept({ value: "replacement source" }), true); await scope.flush();
    assert.equal(beforeLoad.isPlacementCurrent(), false); assert.equal(state.getSnapshot().status, "expired"); assert.equal(state.getSnapshot().result, null);
});

test("feature requests require explicit reconnect after transport loss", async t => {
    const f = fixture(t), client = createLspHoverClient(f.provider); t.after(client.dispose);
    const run = () => client.run(f.workspace.document(f.source.documentId), 0).result;
    await run(); f.peers[0]!.transport.dispose(); await settled();
    for (let i = 0; i < 3; i++) await assert.rejects(run(), /explicit.*connect/i);
    assert.equal(f.peers.length, 1); await f.provider.reconnect(); await run(); assert.equal(f.peers.length, 2);
});

test("command reservation blocks competing preparation before sync and preserves reads during recovery", async t => {
    const f = fixture(t), a = f.provider.createScope(), b = f.provider.createScope(), doc = a.attachDocument(f.source.documentId); b.attachDocument(f.source.documentId); await a.ensureConnected();
    const first = createLspCommandRunner(a), second = createLspCommandRunner(b), entered = latch<void>(), answer = latch<string>(); let prepared = 0;
    t.after(() => { first.dispose(); second.dispose(); });
    const scope = (insert: string) => ({ snapshots: () => [f.workspace.document(f.source.documentId)], isCurrent: () => true,
        prepare: () => { prepared++; f.edit(f.source.documentId, insert); }, review: async () => ({ applied: false }) });
    await assert.rejects(second.run("test.edit", ["x".repeat(8193)], scope("B")), RangeError); assert.equal(prepared, 0);
    f.peers[0]!.rpc.onRequest("workspace/executeCommand", () => { entered.resolve(); return answer.promise; });
    const pending = first.run("test.edit", [], scope("A")), rejected = assert.rejects(pending, error => error instanceof RpcError && error.code === -32800);
    await assert.rejects(second.run("test.edit", [], scope("B")), RpcError); assert.equal(prepared, 1); await entered.promise;
    assert.deepEqual(await b.requestDocument("textDocument/definition", b.attachDocument(f.source.documentId), index => ({ position: index.at(0) })).result, []);
    first.dispose(); await rejected; answer.resolve("late"); await settled();
    await assert.rejects(second.run("test.edit", [], scope("B")), RpcError); assert.equal(prepared, 1); assert.equal(f.provider.getSnapshot().phase, "ready");
    await f.provider.reconnect(); f.peers[1]!.rpc.onRequest("workspace/executeCommand", () => "done"); await second.run("test.edit", [], scope("B"));
    const buffer = f.workspace.document(f.source.documentId).buffer; assert.equal(buffer.slice(0, buffer.length), "a😀\r\nsourceAB"); assert.equal(prepared, 2);
    const reservation = b.reserveCommand(); assert.equal(reservation.isCurrent(), true); reservation.release(); assert.equal(f.provider.getSnapshot().commandAvailable, true);
    assert.equal(f.provider.getSnapshot().commandRequiresReconnect, false); assert.ok(a.synchronized(doc)!.isCurrent()); assert.deepEqual(f.errors, []);
});

test("disposing a custom-request scope expires its context and settles a hanging handler without disconnecting peers", { timeout: 3000 }, async t => {
    const f = fixture(t), a = f.provider.createScope(), b = f.provider.createScope(), entered = latch<void>(), notice = latch<void>(), answer = latch<string>();
    const document = b.attachDocument(f.source.documentId); let context: LspRequestContext | undefined;
    a.onRequest("host/custom", async (_value, captured) => { context = captured; captured.onCancel(() => notice.resolve()); entered.resolve(); return answer.promise; });
    await b.ensureConnected(); const request = f.peers[0]!.rpc.sendRequest("host/custom", {});
    const rejected = assert.rejects(request, (error: unknown) => error instanceof Error && "code" in error && error.code === -32800);
    await entered.promise; assert.equal(context!.isCurrent(), true); a.dispose(); await rejected; await notice.promise;
    assert.equal(context!.isCurrent(), false); assert.equal(context!.cancelled, true); answer.resolve("late"); await settled();
    assert.deepEqual(await b.requestDocument("textDocument/definition", document, index => ({ position: index.at(0) })).result, []);
    assert.equal(f.provider.snapshot().protocol.incomingRequests, 0); assert.equal(f.provider.snapshot().terminated, 0); assert.deepEqual(f.errors, []);
});
