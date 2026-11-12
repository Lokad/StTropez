import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { TextDocument } from "vscode-languageserver-protocol/node.js";
import type { DidOpenTextDocumentParams, DidChangeTextDocumentParams, DidCloseTextDocumentParams } from "vscode-languageserver-protocol/node.js";
import { referencePeer } from "../examples/protocol/reference-peer.ts";
import { Workspace } from "../src/core/workspace.ts";
import type { LspFeature, LspRequestContext, RpcScheduler, RpcTransport } from "../src/protocol/index.ts";
const { LspWorkspace, createLspCommandRunner, createLspSignatureClient, createLspLinkClient, createLspColorClient, RpcError } = await import(process.env.STTROPEZ_PROTOCOL_TEST_MODULE ?? "../src/protocol/index.ts") as typeof import("../src/protocol/index.ts");
const settled = async () => { await setImmediate(); await setImmediate(); };
const latch = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
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

function fixture(t: test.TestContext, extra: Readonly<{ maxDocumentUnits?: number; features?: readonly LspFeature[] }> = {}) {
    const workspace = new Workspace(), source = workspace.createTextResource({ scope: "generic", resource: "source", variant: "working" }, "Source", { value: "a😀\r\nsource" }),
        companion = workspace.createTextResource({ scope: "generic", resource: "companion", variant: "working" }, "Companion", { value: "companion" });
    const timers = new Set<ReturnType<typeof setTimeout>>(), errors: string[] = [], peers: ReturnType<typeof peer>[] = [];
    const schedule: RpcScheduler = (ms, callback) => { const timer = setTimeout(() => { timers.delete(timer); callback(); }, ms); timers.add(timer); return () => { clearTimeout(timer); timers.delete(timer); }; };
    function peer() {
        type Listener = Parameters<RpcTransport["subscribe"]>[0]; const listeners: (Listener | undefined)[] = [undefined, undefined]; let closed = false;
        const ports = [0, 1].map(index => ({ send(text: string): void { assert.equal(this, ports[index]); if (closed) throw Error("Closed transport"); queueMicrotask(() => { if (!closed) listeners[1 - index]?.message(text); }); },
            subscribe(listener: Listener): () => void { assert.equal(this, ports[index]); listeners[index] = listener; return () => { if (listeners[index] === listener) listeners[index] = undefined; }; },
            dispose: () => { if (closed) return; closed = true; for (const listener of listeners) listener?.close(Error("Closed")); listeners.fill(undefined); } }));
        const rpc = referencePeer(ports[1]!), documents = new Map<string, TextDocument>(), events: { method: string; uri?: string }[] = [];
        rpc.onRequest("initialize", () => { events.push({ method: "initialize" }); return { capabilities: { positionEncoding: "utf-16", textDocumentSync: 2, hoverProvider: true, definitionProvider: true, executeCommandProvider: { commands: ["test.edit"] } } }; });
        rpc.onNotification("textDocument/didOpen", (p: DidOpenTextDocumentParams) => { assert.ok(!documents.has(p.textDocument.uri)); documents.set(p.textDocument.uri, TextDocument.create(p.textDocument.uri, p.textDocument.languageId, p.textDocument.version, p.textDocument.text)); events.push({ method: "open", uri: p.textDocument.uri }); });
        rpc.onNotification("textDocument/didChange", (p: DidChangeTextDocumentParams) => { const before = documents.get(p.textDocument.uri)!; let text = before.getText();
            for (const change of p.contentChanges) { assert.ok("range" in change); text = TextDocument.applyEdits(TextDocument.create(before.uri, before.languageId, before.version, text), [{ range: change.range, newText: change.text }]); }
            documents.set(before.uri, TextDocument.create(before.uri, before.languageId, p.textDocument.version, text)); events.push({ method: "change", uri: before.uri }); });
        rpc.onNotification("textDocument/didClose", (p: DidCloseTextDocumentParams) => { assert.ok(documents.delete(p.textDocument.uri)); events.push({ method: "close", uri: p.textDocument.uri }); });
        rpc.onRequest("test/barrier", () => null); rpc.onRequest("textDocument/definition", () => []); rpc.onRequest("textDocument/hover", () => ({ contents: "shared provider" }));
        rpc.listen(); return { rpc, documents, events, transport: ports[0]! };
    }
    const provider = new LspWorkspace(workspace, { ...extra, features: extra.features ?? ["textDocument/hover", "textDocument/definition", "workspace/executeCommand"], applyEdit: true, diagnostics: true, schedule,
        connect: async () => { const next = peer(); peers.push(next); return next.transport; },
        documentInfo: doc => ({ uri: `host+opaque:workspace/${encodeURIComponent(doc.resourceId)}`, languageId: "generic-language" }), onError: error => errors.push(error.message) });
    t.after(async () => { provider.dispose(); await settled(); for (const peer of peers) peer.rpc.dispose(); for (const timer of timers) clearTimeout(timer); });
    const edit = (id = source.documentId, insert = "!") => { const doc = workspace.document(id); assert.equal(workspace.edit({ documentId: id, expectedRevision: doc.revision, edits: [{ from: doc.buffer.length, to: doc.buffer.length, insert }], origin: "human" }).applied, true); };
    return { workspace, provider, source, companion, peers, errors, timers, edit };
}

test("provider scopes share one initialize, binding and incremental stream while retaining independent participation", async t => {
    const f = fixture(t), a = f.provider.createScope(), b = f.provider.createScope(), c = f.provider.createScope();
    assert.equal(f.peers.length, 0); const left = a.attachDocument(f.source.documentId), right = b.attachDocument(f.source.documentId), other = c.attachDocument(f.companion.documentId);
    assert.equal(f.workspace.diagnostics().leases, 2); await Promise.all([a.connect(), b.connect(), c.connect()]); await a.request("test/barrier").result;
    assert.equal(f.peers.length, 1); const peer = f.peers[0]!, uri = left.getSnapshot().uri;
    assert.equal(peer.events.filter(e => e.method === "initialize").length, 1); assert.equal(peer.events.filter(e => e.method === "open").length, 2);
    assert.equal(left.getSnapshot(), right.getSnapshot()); const old = b.synchronized(right)!;
    f.edit(); f.edit(f.source.documentId, "second"); f.edit(f.companion.documentId); assert.equal(old.isCurrent(), false); assert.equal(old.isBindingCurrent!(), true); assert.equal(b.synchronized(right), undefined);
    await Promise.all([a.flush(), b.flush(), c.flush()]); await a.request("test/barrier").result;
    assert.equal(peer.events.filter(e => e.method === "change" && e.uri === uri).length, 1);
    assert.equal(peer.documents.get(uri)!.getText(), "a😀\r\nsource!second"); assert.equal(peer.documents.get(other.getSnapshot().uri)!.getText(), "companion!");
    a.dispose(); await b.flush(); assert.equal(peer.events.filter(e => e.method === "close" && e.uri === uri).length, 0); assert.ok(b.synchronized(right)!.isCurrent());
    right.close(); await b.flush(); await c.request("test/barrier").result; assert.equal(peer.events.filter(e => e.method === "close" && e.uri === uri).length, 1);
    assert.equal(old.isBindingCurrent!(), false);
    assert.equal(f.provider.snapshot().documents, 1); f.provider.dispose(); await settled();
    assert.equal(f.workspace.diagnostics().leases, 0); assert.equal(f.workspace.diagnostics().subscriptions, 0); assert.equal(f.provider.snapshot().scopes, 0);
    assert.equal(f.provider.snapshot().created, 1); assert.equal(f.provider.snapshot().terminated, 1); assert.equal(f.provider.snapshot().protocol.pendingRequests, 0); assert.deepEqual(f.errors, []);
});

test("closing one feature cancels only its pending request and leaves the other view/provider usable", async t => {
    const f = fixture(t), hover = f.provider.createScope(), navigation = f.provider.createScope(), entered = latch<void>(), answer = latch<unknown>();
    const a = hover.attachDocument(f.source.documentId), b = navigation.attachDocument(f.source.documentId); await hover.connect();
    f.peers[0]!.rpc.onRequest("textDocument/hover", () => { entered.resolve(); return answer.promise; });
    const request = hover.requestDocument("textDocument/hover", a, index => ({ position: index.at(1) })), rejected = assert.rejects(request.result, error => error instanceof RpcError && error.code === -32800);
    await entered.promise; hover.dispose(); await rejected;
    assert.deepEqual(await navigation.requestDocument("textDocument/definition", b, index => ({ position: index.at(1) })).result, []);
    answer.resolve({ contents: "late" }); await settled(); assert.equal(f.provider.snapshot().created, 1); assert.equal(f.provider.snapshot().terminated, 0);
    assert.equal(f.provider.state.getSnapshot().phase, "ready"); assert.equal(f.provider.snapshot().documents, 1); assert.deepEqual(f.errors, []);
});

test("one reconnect reopens latest shared snapshots once and invalidates old captures without replay", async t => {
    const f = fixture(t), a = f.provider.createScope(), b = f.provider.createScope(), doc = a.attachDocument(f.source.documentId); b.attachDocument(f.source.documentId); b.attachDocument(f.companion.documentId);
    await a.connect(); const before = a.synchronized(doc)!; f.provider.disconnect(); f.edit(); await f.provider.connect(); await b.request("test/barrier").result;
    assert.equal(before.isCurrent(), false); assert.equal(before.isBindingCurrent!(), false); assert.equal(f.peers.length, 2); const peer = f.peers[1]!;
    assert.equal(peer.events.filter(e => e.method === "initialize").length, 1); assert.equal(peer.events.filter(e => e.method === "open").length, 2);
    assert.equal(peer.events.filter(e => e.method === "change").length, 0); assert.equal(peer.documents.get(doc.getSnapshot().uri)!.getText(), "a😀\r\nsource!");
    assert.ok(a.synchronized(doc)!.isCurrent()); assert.equal(f.provider.snapshot().created, 2); assert.equal(f.provider.snapshot().terminated, 1);
});

test("command review is exclusive and cancellation quarantines uncorrelated edits without disconnecting readers", async t => {
    const f = fixture(t), a = f.provider.createScope(), b = f.provider.createScope(), entered = latch<void>(), cancelled = latch<void>(), decision = latch<{ applied: boolean }>();
    const doc = a.attachDocument(f.source.documentId); b.attachDocument(f.source.documentId); let context: LspRequestContext | undefined, wrongOwner = 0;
    a.onRequest("workspace/applyEdit", async (_value, captured) => { context = captured; const stop = captured.onCancel(() => cancelled.resolve()); entered.resolve(); try { return await decision.promise; } finally { stop(); } });
    b.onRequest("workspace/applyEdit", () => { wrongOwner++; return { applied: true }; }); await a.connect();
    const peer = f.peers[0]!; peer.rpc.onRequest("workspace/executeCommand", async () => peer.rpc.sendRequest("workspace/applyEdit", { edit: { changes: {} } }));
    const call = a.requestCommand("test.edit"), rejected = assert.rejects(call.result, error => error instanceof RpcError && error.code === -32800); await entered.promise;
    assert.ok(context!.isCurrent()); assert.throws(() => b.requestCommand("test.edit"), RpcError);
    assert.deepEqual(await b.requestDocument("textDocument/definition", b.attachDocument(f.source.documentId), index => ({ position: index.at(0) })).result, []);
    call.cancel(); await rejected; await cancelled.promise; assert.equal(context!.isCurrent(), false); decision.resolve({ applied: false }); await settled();
    assert.equal(f.provider.snapshot().commandQuarantined, true); assert.equal(f.provider.state.getSnapshot().commandRequiresReconnect, true); assert.equal(f.provider.state.getSnapshot().commandAvailable, false); assert.throws(() => b.requestCommand("test.edit"), RpcError);
    assert.deepEqual(await peer.rpc.sendRequest("workspace/applyEdit", { edit: { changes: {} } }), { applied: false, failureReason: "No available captured command review intent." });
    assert.equal(wrongOwner, 0); assert.equal(f.provider.state.getSnapshot().phase, "ready"); assert.equal(f.provider.snapshot().terminated, 0);
    assert.ok(b.synchronized(b.attachDocument(f.source.documentId))!.isCurrent()); assert.equal(doc.getSnapshot().buffer.length, "a😀\r\nsource".length);
    await f.provider.reconnect(); assert.equal(f.provider.snapshot().commandQuarantined, false); assert.equal(f.provider.state.getSnapshot().commandAvailable, true);
    f.peers[1]!.rpc.onRequest("workspace/executeCommand", () => "done"); const next = b.requestCommand("test.edit"); assert.equal(await next.result, "done"); assert.equal(next.isCurrent(), true);
});

test("a rejected oversized update expires associations but preserves unrelated documents and local text", async t => {
    const f = fixture(t, { maxDocumentUnits: 16 }), a = f.provider.createScope(), b = f.provider.createScope(), doc = a.attachDocument(f.source.documentId); b.attachDocument(f.companion.documentId); await a.connect();
    const captured = a.synchronized(doc)!; f.edit(f.source.documentId, "x".repeat(32)); assert.equal(captured.isCurrent(), false); await settled();
    assert.equal(a.synchronized(doc), undefined); assert.equal(f.provider.snapshot().documents, 1); assert.equal(f.provider.state.getSnapshot().phase, "ready");
    assert.equal(f.workspace.document(f.source.documentId).buffer.length, "a😀\r\nsource".length + 32); assert.equal(f.errors.length, 1);
    assert.deepEqual(await b.requestDocument("textDocument/definition", b.attachDocument(f.companion.documentId), index => ({ position: index.at(0) })).result, []);
});

test("shared diagnostic placement preserves unknown freshness and expires on editing, reconnect and URI reuse", async t => {
    const f = fixture(t), a = f.provider.createScope(), b = f.provider.createScope(), left = a.attachDocument(f.source.documentId), right = b.attachDocument(f.source.documentId);
    const first = a.observeDiagnostics(left), second = b.observeDiagnostics(right); await a.connect();
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
    f.edit(); assert.equal(uncertain.isCurrent(), false); assert.equal(first.getSnapshot().status, "expired"); assert.equal(first.getSnapshot().result, null);
    await a.flush(); await send({ ...message, diagnostics: [{ range: { start: { line: 100, character: 0 }, end: { line: 100, character: 4 } }, message: "outside" }] });
    assert.equal(first.getSnapshot().result!.items[0]!.placement, "out-of-bounds"); assert.equal(first.getSnapshot().result!.items[0]!.from, null);
    const beforeReconnect = first.getSnapshot(); await f.provider.reconnect(); assert.equal(beforeReconnect.isCurrent(), false); assert.equal(first.getSnapshot().status, "expired");
    await send(message); const beforeReuse = first.getSnapshot(); left.close(); right.close(); await settled();
    const replacement = a.attachDocument(f.source.documentId); await a.flush(); assert.equal(beforeReuse.isCurrent(), false);
    assert.equal(a.observeDiagnostics(replacement).getSnapshot().status, "empty"); assert.equal(first.getSnapshot().status, "expired");
    const buffer = f.workspace.document(f.source.documentId).buffer; assert.equal(buffer.slice(0, buffer.length), "a😀\r\nsource!"); assert.deepEqual(f.errors, []);
});

test("command reservation blocks competing preparation before sync and preserves reads during recovery", async t => {
    const f = fixture(t), a = f.provider.createScope(), b = f.provider.createScope(), doc = a.attachDocument(f.source.documentId); b.attachDocument(f.source.documentId); await a.connect();
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
    await assert.rejects(second.run("test.edit", [], scope("B")), RpcError); assert.equal(prepared, 1); assert.equal(f.provider.state.getSnapshot().phase, "ready");
    await f.provider.reconnect(); f.peers[1]!.rpc.onRequest("workspace/executeCommand", () => "done"); await second.run("test.edit", [], scope("B"));
    const buffer = f.workspace.document(f.source.documentId).buffer; assert.equal(buffer.slice(0, buffer.length), "a😀\r\nsourceAB"); assert.equal(prepared, 2);
    const reservation = b.reserveCommand(); assert.equal(reservation.isCurrent(), true); reservation.release(); assert.equal(f.provider.state.getSnapshot().commandAvailable, true);
    assert.equal(f.provider.state.getSnapshot().commandRequiresReconnect, false); assert.ok(a.synchronized(doc)!.isCurrent()); assert.deepEqual(f.errors, []);
});

test("disposing a custom-request scope expires its context and settles a hanging handler without disconnecting peers", { timeout: 3000 }, async t => {
    const f = fixture(t), a = f.provider.createScope(), b = f.provider.createScope(), entered = latch<void>(), notice = latch<void>(), answer = latch<string>();
    const document = b.attachDocument(f.source.documentId); let context: LspRequestContext | undefined;
    a.onRequest("host/custom", async (_value, captured) => { context = captured; captured.onCancel(() => notice.resolve()); entered.resolve(); return answer.promise; });
    await b.connect(); const request = f.peers[0]!.rpc.sendRequest("host/custom", {});
    const rejected = assert.rejects(request, (error: unknown) => error instanceof Error && "code" in error && error.code === -32800);
    await entered.promise; assert.equal(context!.isCurrent(), true); a.dispose(); await rejected; await notice.promise;
    assert.equal(context!.isCurrent(), false); assert.equal(context!.cancelled, true); answer.resolve("late"); await settled();
    assert.deepEqual(await b.requestDocument("textDocument/definition", document, index => ({ position: index.at(0) })).result, []);
    assert.equal(f.provider.snapshot().protocol.incomingRequests, 0); assert.equal(f.provider.snapshot().terminated, 0); assert.deepEqual(f.errors, []);
});
