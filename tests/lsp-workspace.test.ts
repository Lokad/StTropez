import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { highlightClient } from "../src/protocol/lsp-highlights.ts";
import { hoverClient } from "../src/protocol/lsp-hover.ts";
import { colorClient, linkClient, signatureClient } from "../src/protocol/lsp-language.ts";
import { TextDocument } from "vscode-languageserver-protocol/node.js";
import type { DidOpenTextDocumentParams, DidChangeTextDocumentParams, DidCloseTextDocumentParams } from "vscode-languageserver-protocol/node.js";
import { referencePeer } from "./fixtures/protocol/reference-peer.ts";
import type { LspWorkspaceOptions, LspRequestContext, RpcScheduler, RpcTransport } from "../src/protocol/index.ts";
import { Workspace } from "../src/index.ts";
import { LspWorkspace, createLspCommandRunner, createLspFoldingClient, RpcError } from "../src/protocol/index.ts";
import { latch } from "./helpers/latch.ts";
import { bufferReads } from "./buffer-reads.ts";
const settled = async () => { await setImmediate(); await setImmediate(); };

test("a pending hover and its result survive unrelated capability changes", async t => {
    const f = fixture(t), client = hoverClient(f.provider);
    t.after(client.dispose);
    await f.provider.connect();
    const peer = f.peers[0]!.rpc, received = latch<void>(), reply = latch<unknown>();
    peer.onRequest("textDocument/hover", () => { received.resolve(); return reply.promise; });
    const pending = client.run({ document: f.workspace.document(f.source.id), offset: 0 }).result;
    await received.promise;
    const registration = { id: "extra", method: "textDocument/definition", registerOptions: { documentSelector: null } };
    await peer.sendRequest("client/registerCapability", { registrations: [registration] });
    reply.resolve({ contents: "hover text" });
    const hover = await pending;
    assert.ok(hover);
    assert.ok(hover.isCurrent());
    await peer.sendRequest("client/unregisterCapability", { unregisterations: [{ id: "extra", method: registration.method }] });
    assert.ok(hover.isCurrent());
    const sameFeature = { ...registration, method: "textDocument/hover" };
    await peer.sendRequest("client/registerCapability", { registrations: [sameFeature] });
    assert.equal(hover.isCurrent(), false);
    await peer.sendRequest("client/unregisterCapability", { unregisterations: [{ id: "extra", method: sameFeature.method }] });
    assert.equal(hover.isCurrent(), false);
});

test("binding captures read local revisions across request cancellation and expire with provider authority", async t => {
    const f = fixture(t), scope = f.provider.createScope(), handle = scope.attachDocument(f.source.id);
    t.after(scope.dispose); await scope.ensureConnected(); await scope.flush([handle]);
    const exact = scope.synchronized(handle)!, binding = scope.captureBinding(handle)!, owner = f.provider.snapshot();
    assert.equal(binding.getSnapshot(), f.workspace.document(f.source.id)); scope.cancel();
    assert.equal(exact.isCurrent(), false); assert.equal(binding.getSnapshot(), f.workspace.document(f.source.id));
    const before = handle.getSnapshot(), stop = f.workspace.observeDocument(f.source.id).subscribe(() => {
        assert.equal(binding.getSnapshot(), f.workspace.document(f.source.id)); assert.equal(handle.getSnapshot(), before);
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
    const f = fixture(t, { features: ["textDocument/signatureHelp"] }), client = signatureClient(f.provider); t.after(client.dispose);
    for (const resource of [f.source, f.companion]) {
        const title = resource.metadata.getSnapshot().title;
        f.workspace.setDocumentLanguage(resource.id, { uri: `custom:/${title}`, languageId: title });
    }
    const source = f.workspace.document(f.source.id), other = f.workspace.document(f.companion.id);
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
    const pending = client.run({ document: source, offset: 1 }).result; void pending.catch(() => {}); await entered.promise;
    const owner = f.provider.snapshot(), workspace = f.workspace.diagnostics(), events = [...peer.events];
    for (const document of [other, source, other]) assert.deepEqual(client.options(document)[0]!.triggerCharacters, [document === source ? "(" : "["]);
    await settled(); assert.equal(requests, 1); assert.deepEqual(f.provider.snapshot(), owner); assert.deepEqual(f.workspace.diagnostics(), workspace); assert.deepEqual(peer.events, events);
    answer.resolve({ signatures: [{ label: "call(value)" }] }); const result = await pending; assert.ok(result); assert.ok(result.isCurrent());
    const completed = f.provider.snapshot(); assert.deepEqual(client.options(other)[0]!.triggerCharacters, ["["]);
    assert.ok(result.isCurrent()); assert.deepEqual(f.provider.snapshot(), completed); assert.deepEqual(peer.events, events);
    f.workspace.setDocumentLanguage(other.id, null); assert.deepEqual(client.options(f.workspace.document(other.id)), []);
    assert.throws(() => client.options(other), error => error instanceof RpcError && error.code === -32801);
    f.workspace.setDocumentLanguage(other.id, other.language);
    f.edit(other.id); assert.throws(() => client.options(other), error => error instanceof RpcError && error.code === -32801);
    assert.ok(result.isCurrent()); assert.deepEqual(peer.events, events);
    await peer.rpc.sendRequest("client/unregisterCapability", { unregisterations: [{ id: "other-signature", method: "textDocument/signatureHelp" }] });
    assert.deepEqual(observed, []); assert.deepEqual(client.options(f.workspace.document(other.id)), []);
    assert.equal(result.isCurrent(), false, "Registration changes still retire captured feature authority.");
    await f.provider.reconnect(); const reconnected = f.provider.snapshot(), reconnectedEvents = [...f.peers[1]!.events];
    assert.deepEqual(client.options(source), []); assert.deepEqual(f.provider.snapshot(), reconnected); assert.deepEqual(f.peers[1]!.events, reconnectedEvents); assert.deepEqual(f.errors, []);
});

test("signature retriggers preserve the last resolved context through a cancelled reply without crossing document or provider authority", async t => {
    const f = fixture(t, { features: ["textDocument/signatureHelp"] }),
        client = signatureClient(f.provider); t.after(client.dispose);
    await f.provider.connect(); const peer = f.peers[0]!, entered = latch<void>(), held = latch<unknown>(); t.after(() => held.resolve(null));
    const contexts: { isRetrigger: boolean; activeSignatureHelp?: unknown }[] = []; let pause = false;
    const help = (label: string) => ({ signatures: [{ label }], activeSignature: 0 });
    const overloads = { signatures: [{ label: "first()" }, { label: "second()" }], activeSignature: 0 };
    let response: unknown = overloads;
    const register = () => f.peers.at(-1)!.rpc.sendRequest("client/registerCapability", { registrations: [{ id: "signature", method: "textDocument/signatureHelp", registerOptions: { documentSelector: null } }] });
    const handler = (params: { context: typeof contexts[number] }) => { contexts.push(params.context); if (pause) { pause = false; entered.resolve(); return held.promise; } return response; };
    peer.rpc.onRequest("textDocument/signatureHelp", handler); await register();
    const run = (id = f.source.id, isRetrigger = true, activeSignatureHelp?: ReturnType<typeof help>) => client.run({ document: f.workspace.document(id), offset: 0, context: { triggerKind: 3, isRetrigger, ...(activeSignatureHelp ? { activeSignatureHelp } : {}) } }).result;
    const initial = await run(f.source.id, false); assert.equal(contexts.at(-1)!.activeSignatureHelp, undefined);
    assert.ok(initial); assert.ok(initial.selectOverload(initial.signatures[1]!));
    pause = true; f.edit(); const pending = run(), rejected = assert.rejects(pending); await entered.promise;
    assert.deepEqual(contexts.at(-1)!.activeSignatureHelp, { ...overloads, activeSignature: 1 });
    assert.equal(initial.selectOverload(initial.signatures[0]!), false);
    f.edit(); response = help("latest"); await run(); await rejected;
    assert.deepEqual(contexts.at(-1)!.activeSignatureHelp, { ...overloads, activeSignature: 1 });
    held.resolve(help("late")); await settled(); await run(); assert.deepEqual(contexts.at(-1)!.activeSignatureHelp, help("latest"));
    await run(f.companion.id); assert.equal(contexts.at(-1)!.activeSignatureHelp, undefined);
    f.workspace.setDocumentLanguage(f.companion.id, { uri: "fixture:replacement", languageId: "fixture" });
    const replacement = f.provider.createScope(); replacement.attachDocument(f.companion.id);
    await run(f.companion.id); assert.equal(contexts.at(-1)!.activeSignatureHelp, undefined); replacement.dispose();
    await run(f.companion.id, true, help("host choice")); assert.deepEqual(contexts.at(-1)!.activeSignatureHelp, help("host choice"));
    client.cancel(); await run(f.companion.id); assert.equal(contexts.at(-1)!.activeSignatureHelp, undefined);
    const context = { triggerKind: 3 as const, isRetrigger: true }, captured = client.run({ document: f.workspace.document(f.companion.id), offset: 0, context });
    context.isRetrigger = false; await captured.result;
    assert.equal(contexts.at(-1)!.isRetrigger, true); assert.deepEqual(contexts.at(-1)!.activeSignatureHelp, help("latest"));
    await peer.rpc.sendRequest("client/unregisterCapability", { unregisterations: [{ id: "signature", method: "textDocument/signatureHelp" }] }); await register();
    await run(f.companion.id); assert.equal(contexts.at(-1)!.activeSignatureHelp, undefined);
    await f.provider.reconnect(); f.peers[1]!.rpc.onRequest("textDocument/signatureHelp", handler); await register();
    await run(f.companion.id); assert.equal(contexts.at(-1)!.activeSignatureHelp, undefined);
    response = null; await run(f.companion.id); response = help("after empty"); await run(f.companion.id);
    assert.equal(contexts.at(-1)!.activeSignatureHelp, undefined);
    const wide = { ...help("wide"), data: "" }; wide.data = "x".repeat(131072 - JSON.stringify(wide).length); response = wide;
    await run(f.companion.id); response = help("bounded"); await run(f.companion.id);
    assert.equal(contexts.at(-1)!.activeSignatureHelp, undefined, "An optional inherited context must fit the complete advisory bound.");
    await run(f.companion.id, false); assert.equal(contexts.at(-1)!.activeSignatureHelp, undefined); assert.deepEqual(f.errors, []);
});
test("occurrences require current dynamic authority through withdrawal and reconnect", async t => {
    const f = fixture(t, { features: ["textDocument/documentHighlight"] }), client = highlightClient(f.provider); t.after(client.dispose);
    await f.provider.connect();
    const register = async () => {
        const peer = f.peers.at(-1)!; peer.rpc.onRequest("textDocument/documentHighlight", () => [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, kind: 3 }]);
        await peer.rpc.sendRequest("client/registerCapability", { registrations: [{ id: "occurrences", method: "textDocument/documentHighlight", registerOptions: { documentSelector: [{ language: "generic-language" }] } }] });
    };
    const run = () => client.run({ document: f.workspace.document(f.source.id), offset: 0 }).result;
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
    const run = () => client.run({ document: f.workspace.document(f.source.id) }).result;
    await assert.rejects(run(), error => error instanceof RpcError && error.code === -32601);
    await register(); const first = await run(); assert.equal(first.ranges.length, 1);
    await f.peers[0]!.rpc.sendRequest("client/unregisterCapability", { unregisterations: [{ id: "folds", method: "textDocument/foldingRange" }] });
    assert.equal(first.isCurrent(), false); await assert.rejects(run(), error => error instanceof RpcError && error.code === -32601);
    await register(); const second = await run(); await f.provider.reconnect(); assert.equal(second.isCurrent(), false);
    await assert.rejects(run(), error => error instanceof RpcError && error.code === -32601); await register(); assert.equal((await run()).isCurrent(), true);
});
test("selected language clients share one binding and decode their independent results", async t => {
    const { f, signature, links, colors, rgba, doc } = await languageFixture(t);
    const [help, linkBatch, colorBatch] = await Promise.all([signature.run({ document: doc, offset: 1 }).result, links.run({ document: doc }).result, colors.run({ document: doc }).result]);
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
    const [help, linkBatch, colorBatch] = await Promise.all([signature.run({ document: doc, offset: 1 }).result, links.run({ document: doc }).result, colors.run({ document: doc }).result]);
    const preparing = latch<void>(), resume = latch<void>(), picker = new AbortController();
    const replaced = colorBatch.presentations(colorBatch.items[0]!, rgba, async () => { preparing.resolve(); await resume.promise; }, cancel => {
        picker.signal.addEventListener("abort", cancel);
        return () => picker.signal.removeEventListener("abort", cancel);
    });
    const dismissed = assert.rejects(replaced, error => error instanceof RpcError && error.code === -32800);
    await preparing.promise; picker.abort(); await dismissed;
    assert.equal(colors.isBusy(), false); assert.equal(colorBatch.isCurrent(), true);
    assert.equal((await colorBatch.presentations(colorBatch.items[0]!, rgba))[0]!.label, "red");
    resume.resolve(); await settled();
    assert.equal(peer.sent.filter(method => method === "textDocument/colorPresentation").length, 1);
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
    const batch = await links.run({ document: doc }).result; let resolutions = 0;
    peer.rpc.onRequest("documentLink/resolve", () => { resolutions++; return {}; });
    f.edit(); assert.equal(batch.isCurrent(), false);
    await assert.rejects(batch.resolve(batch.items[0]!), error => error instanceof RpcError && error.code === -32801);
    assert.equal(resolutions, 0);
});

test("signature capability removal expires its result and prevents further dispatch", async t => {
    const { f, peer, signature, links, doc } = await languageFixture(t);
    const help = await signature.run({ document: doc, offset: 1 }).result;
    await peer.rpc.sendRequest("client/unregisterCapability", { unregisterations: [{ id: "language-0", method: "textDocument/signatureHelp" }] });
    assert.equal(help!.isCurrent(), false);
    await assert.rejects(signature.run({ document: doc, offset: 1 }).result, error => error instanceof RpcError && error.code === -32601);
    assert.equal((await links.run({ document: f.workspace.document(doc.id) }).result).items.length, 1);
});

async function languageFixture(t: test.TestContext) {
    const f = fixture(t, { features: ["textDocument/signatureHelp", "textDocument/documentLink", "textDocument/documentColor", "textDocument/colorPresentation"] }); await f.provider.connect(); const peer = f.peers[0]!;
    await peer.rpc.sendRequest("client/registerCapability", { registrations: ["textDocument/signatureHelp", "textDocument/documentLink", "textDocument/documentColor"].map((method, i) => ({ id: `language-${i}`, method, registerOptions: { documentSelector: null, ...(i === 1 ? { resolveProvider: true } : {}) } })) });
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, rgba = { red: 1, green: 0, blue: 0, alpha: .5 };
    peer.rpc.onRequest("textDocument/signatureHelp", () => { return { signatures: [{ label: "call(value)", parameters: [{ label: "value" }] }], activeParameter: 0 }; });
    peer.rpc.onRequest("textDocument/documentLink", () => [{ range, data: { token: 1 } }]); peer.rpc.onRequest("documentLink/resolve", (item: object) => ({ ...item, target: "host+opaque:%2F unknown" }));
    peer.rpc.onRequest("textDocument/documentColor", () => [{ range, color: rgba }]);
    peer.rpc.onRequest("textDocument/colorPresentation", () => [{ label: "red", textEdit: { range, newText: "#f00" }, additionalTextEdits: [{ range: { start: { line: 1, character: 6 }, end: { line: 1, character: 6 } }, newText: "!" }] }]);
    const signature = signatureClient(f.provider), links = linkClient(f.provider), colors = colorClient(f.provider); t.after(() => { signature.dispose(); links.dispose(); colors.dispose(); });
    return { f, peer, signature, links, colors, rgba, doc: f.workspace.document(f.source.id) };
}

function fixture(t: test.TestContext, extra: Partial<Pick<LspWorkspaceOptions,
    "maxDocumentUnits" | "features" | "schedule" | "rpc">> = {}) {
    const workspace = new Workspace(), source = workspace.createTextResource({ scope: "generic", resource: "source", variant: "working" }, "Source", {
        value: "a😀\r\nsource",
        language: { uri: "host+opaque:workspace/source", languageId: "generic-language" },
    }),
        companion = workspace.createTextResource({ scope: "generic", resource: "companion", variant: "working" }, "Companion", {
            value: "companion",
            language: { uri: "host+opaque:workspace/companion", languageId: "generic-language" },
        });
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
        onError: error => errors.push(error.message) });
    t.after(async () => { provider.dispose(); await settled(); for (const peer of peers) peer.rpc.dispose(); for (const timer of timers) clearTimeout(timer); });
    const edit = (id = source.id, insert = "!") => { const doc = workspace.document(id); assert.equal(workspace.edit({ documentId: id, expectedRevision: doc.revision, edits: [{ from: doc.buffer.length, to: doc.buffer.length, insert }], origin: "human" }).applied, true); };
    return { workspace, provider, source, companion, peers, errors, timers, edit };
}

test("workspace batches and grouped history retain bounded wire edits; skipped revisions and reconnect stay exact", async t => {
    const f = fixture(t), id = f.source.id, initial = f.workspace.document(id), text = "row 😀\r\n".repeat(10_000);
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
        const doc = f.workspace.document(id), far = doc.buffer.offsetAt(9_998) + 2 + step;
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

test("a connected workspace reads individual edits only when the compact change exceeds the message limit", async t => {
    const row = "😀xxx" + "\0".repeat(32) + "\r\n";
    const rows = 512, half = row.repeat(rows / 2);
    const edits = Array.from({ length: rows }, (_, i) => ({
        from: i * row.length + 3, to: i * row.length + 4, insert: "y",
    }));
    for (const [maxMessageUnits, expectedRanges] of [[160_000, 1], [60_000, rows]] as const) {
        const f = fixture(t, { rpc: { maxMessageUnits } });
        const id = f.source.id, initial = f.workspace.document(id);
        f.workspace.edit({ documentId: id, expectedRevision: initial.revision, origin: "human",
            edits: [{ from: 0, to: initial.buffer.length, insert: half }] });
        const scope = f.provider.createScope(), binding = scope.attachDocument(id);
        await scope.ensureConnected();
        f.edit(id, half);
        await scope.flush();
        const before = f.workspace.document(id);
        assert.ok(f.workspace.edit({ documentId: id, expectedRevision: before.revision, origin: "human", edits }).applied);
        const after = f.workspace.document(id), reads = bufferReads(before.buffer);
        await Promise.resolve();
        assert.equal(binding.getSnapshot().buffer, after.buffer);
        assert.deepEqual(bufferReads(before.buffer), reads);
        await scope.flush();
        await scope.request("test/barrier").result;
        if (expectedRanges === 1) {
            assert.ok(bufferReads(before.buffer).sliceUnits - reads.sliceUnits < row.length * 4,
                "Sending a single range must not scan the old text at every edit boundary.");
        }
        const peer = f.peers[0]!;
        assert.equal(peer.changes.at(-1)!.contentChanges.length, expectedRanges);
        assert.ok(peer.documents.get(binding.getSnapshot().uri)!.getText() === (half + half).replaceAll("xxx", "xyx"));
        assert.deepEqual(f.errors, []);
    }
});

test("feature scopes wait for their captured project without flushing unrelated bindings", async t => {
    const queued = new Set<() => void>(); let blocked = false;
    const f = fixture(t, { schedule: (ms, callback) => {
        if (blocked && ms === 0) { queued.add(callback); return () => { queued.delete(callback); }; }
        const timer = setTimeout(callback, ms); return () => clearTimeout(timer);
    } }), client = hoverClient(f.provider), other = f.provider.createScope(); t.after(client.dispose);
    const run = () => client.run({ document: f.workspace.document(f.source.id), offset: 0 }).result;
    await run(); blocked = true; f.edit(f.companion.id, "large\n".repeat(10_000)); other.attachDocument(f.companion.id);
    let completed = false, flushed = false;
    void run().then(() => { completed = true; }, () => {}); void other.flush().then(() => { flushed = true; }, () => {});
    await settled(); await other.request("test/barrier").result;
    assert.equal(completed, true, "The feature's preparation barrier must cover only its captured documents."); assert.equal(flushed, false);
    blocked = false; for (const callback of queued) callback(); queued.clear(); await other.flush();
    assert.equal(flushed, true); assert.deepEqual(f.errors, []);
    blocked = true; const released = other.attachDocument(f.source.id); f.edit();
    const waiting = other.flush([released]), expired = assert.rejects(waiting, error => error instanceof RpcError && error.code === -32801);
    released.dispose(); // The hover client still retains the shared binding.
    blocked = false; for (const callback of queued) callback(); queued.clear(); await expired;
});

test("provider scopes share one initialize, binding and incremental stream while retaining independent participation", async t => {
    const f = fixture(t), a = f.provider.createScope(), b = f.provider.createScope(), c = f.provider.createScope();
    assert.equal(f.peers.length, 0); const left = a.attachDocument(f.source.id), right = b.attachDocument(f.source.id), other = c.attachDocument(f.companion.id);
    assert.equal(f.workspace.diagnostics().leases, 2); await Promise.all([a.ensureConnected(), b.ensureConnected(), c.ensureConnected()]); await a.request("test/barrier").result;
    assert.equal(f.peers.length, 1); const peer = f.peers[0]!, uri = left.getSnapshot().uri;
    assert.equal(peer.events.filter(e => e.method === "initialize").length, 1); assert.equal(peer.events.filter(e => e.method === "open").length, 2);
    assert.equal(left.getSnapshot(), right.getSnapshot()); const old = b.synchronized(right)!, identity = right.getSnapshot();
    assert.equal(b.isDocumentCurrent(right, identity), true); assert.equal(a.isDocumentCurrent(right, identity), false);
    f.edit(); f.edit(f.source.id, "second"); f.edit(f.companion.id); assert.equal(old.isCurrent(), false); assert.equal(old.isBindingCurrent!(), true); assert.equal(b.synchronized(right), undefined);
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
    assert.throws(() => peer.transport.send("{}"), /Closed transport/);
    assert.equal(f.provider.snapshot().protocol.pendingRequests, 0); assert.deepEqual(f.errors, []);
});

test("closing one feature cancels only its pending request and leaves the other view/provider usable", async t => {
    const f = fixture(t), hover = f.provider.createScope(), navigation = f.provider.createScope(), entered = latch<void>(), answer = latch<unknown>();
    const a = hover.attachDocument(f.source.id), b = navigation.attachDocument(f.source.id); await hover.ensureConnected();
    f.peers[0]!.rpc.onRequest("textDocument/hover", () => { entered.resolve(); return answer.promise; });
    const request = hover.requestDocument("textDocument/hover", a, index => ({ position: index.at(1) })), rejected = assert.rejects(request.result, error => error instanceof RpcError && error.code === -32800);
    await entered.promise; hover.dispose(); await rejected;
    assert.deepEqual(await navigation.requestDocument("textDocument/definition", b, index => ({ position: index.at(1) })).result, []);
    answer.resolve({ contents: "late" }); await settled();
    assert.equal(f.provider.getSnapshot().phase, "ready"); assert.equal(f.provider.snapshot().documents, 1); assert.deepEqual(f.errors, []);
});

test("scope cancellation retains handlers and participation while expiring only its requests", async t => {
    const f = fixture(t), a = f.provider.createScope(), b = f.provider.createScope(), entered = latch<void>(), answer = latch<unknown>();
    t.after(() => answer.resolve(null)); const doc = a.attachDocument(f.source.id); b.attachDocument(f.source.id);
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
    assert.throws(() => a.attachDocument(f.source.id), RpcError); await b.request("test/barrier").result;
});

test("owner shutdown flushes latest text, retains participation and silences cancellation after shutdown", async t => {
    const f = fixture(t), a = f.provider.createScope(), b = f.provider.createScope(), doc = a.attachDocument(f.source.id);
    b.attachDocument(f.source.id); await a.ensureConnected(); const exact = a.synchronized(doc)!, peer = f.peers[0]!;
    const stopping = latch<void>(), finish = latch<null>(), commandEntered = latch<void>(), commandAnswer = latch<unknown>();
    t.after(() => { finish.resolve(null); commandAnswer.resolve(null); });
    peer.rpc.onRequest("workspace/executeCommand", () => { commandEntered.resolve(); return commandAnswer.promise; });
    peer.rpc.onRequest("shutdown", () => { stopping.resolve(); return finish.promise; });
    const command = a.requestCommand("test.edit"), rejected = assert.rejects(command.result, RpcError); await commandEntered.promise;
    f.edit(); const closing = f.provider.shutdown(); await stopping.promise;
    assert.equal(peer.documents.get(doc.getSnapshot().uri)!.getText(), "a😀\r\nsource!");
    assert.equal(f.provider.getSnapshot().phase, "stopping"); assert.equal(exact.isCurrent(), false);
    assert.throws(() => b.request("test/barrier"), RpcError); await assert.rejects(b.ensureConnected(), RpcError);
    f.edit(f.source.id, "offline"); a.cancel(); await rejected; b.dispose(); await settled();
    assert.deepEqual(peer.sent.slice(peer.sent.indexOf("shutdown") + 1), []);
    finish.resolve(null); await closing; await settled(); assert.deepEqual(peer.sent.slice(-2), ["shutdown", "exit"]);
    assert.equal(f.provider.getSnapshot().phase, "disconnected"); assert.equal(f.provider.snapshot().scopes, 1);
    assert.equal(f.provider.snapshot().documents, 1); assert.equal(f.workspace.diagnostics().leases, 1); assert.equal(f.provider.snapshot().commandQuarantined, false);
    await a.ensureConnected(); const next = f.peers[1]!; await a.request("test/barrier").result;
    assert.equal(next.documents.get(doc.getSnapshot().uri)!.getText(), "a😀\r\nsource!offline"); assert.ok(a.synchronized(doc)!.isCurrent());
    assert.equal(next.events.filter(event => event.method === "open").length, 1); assert.equal(next.sent.includes("workspace/executeCommand"), false);
    commandAnswer.resolve("late"); await settled(); await a.request("test/barrier").result;
    a.dispose(); await settled(); assert.equal(f.workspace.diagnostics().leases, 0);
});

test("owner shutdown failure and disposal cannot close a replacement connection", async t => {
    const f = fixture(t), scope = f.provider.createScope(); scope.attachDocument(f.source.id); await scope.ensureConnected();
    f.peers[0]!.rpc.onRequest("shutdown", () => "invalid");
    await assert.rejects(f.provider.shutdown(), /Invalid LSP shutdown result/); assert.equal(f.provider.getSnapshot().phase, "disconnected");
    assert.equal(f.peers[0]!.sent.includes("exit"), false); assert.equal(f.workspace.diagnostics().leases, 1);
    await scope.ensureConnected(); const entered = latch<void>(), late = latch<null>(); t.after(() => late.resolve(null));
    f.peers[1]!.rpc.onRequest("shutdown", () => { entered.resolve(); return late.promise; });
    const shutdown = f.provider.shutdown(), rejected = assert.rejects(shutdown, RpcError); await entered.promise;
    await f.provider.reconnect(); await rejected; late.resolve(null); await settled();
    assert.equal(f.provider.getSnapshot().phase, "ready");
    for (const previous of f.peers.slice(0, 2)) assert.throws(() => previous.transport.send("{}"), /Closed transport/);
    assert.equal(f.peers[2]!.sent.includes("exit"), false); await scope.request("test/barrier").result;
    const disposing = latch<void>(); f.peers[2]!.rpc.onRequest("shutdown", () => { disposing.resolve(); return new Promise(() => {}); });
    const pending = f.provider.shutdown(), cancelled = assert.rejects(pending, RpcError); await disposing.promise; f.provider.dispose(); await cancelled; await settled();
    assert.equal(f.provider.getSnapshot().phase, "disposed"); assert.equal(f.provider.snapshot().scopes, 0); assert.equal(f.workspace.diagnostics().leases, 0);
});

test("one reconnect reopens latest shared snapshots once and invalidates old captures without replay", async t => {
    const f = fixture(t), a = f.provider.createScope(), b = f.provider.createScope();
    const doc = a.attachDocument(f.source.id), companion = b.attachDocument(f.companion.id);
    b.attachDocument(f.source.id);
    await a.ensureConnected();
    const before = a.synchronized(doc)!;
    f.provider.disconnect();
    f.edit();
    f.edit(f.companion.id);
    const source = f.workspace.document(f.source.id), other = f.workspace.document(f.companion.id);
    const sourceReads = bufferReads(source.buffer), otherReads = bufferReads(other.buffer);
    companion.update(companion.getSnapshot().revision, other.revision, other.buffer);
    await Promise.resolve();
    assert.equal(doc.getSnapshot().buffer, source.buffer);
    assert.equal(companion.getSnapshot().buffer, other.buffer);
    assert.deepEqual(bufferReads(source.buffer), sourceReads, "Offline synchronization only needs the latest buffer.");
    assert.deepEqual(bufferReads(other.buffer), otherReads, "An explicit offline update also skips wire edits.");
    await f.provider.connect();
    await b.request("test/barrier").result;
    assert.equal(before.isCurrent(), false); assert.equal(before.isBindingCurrent!(), false); assert.equal(f.peers.length, 2); const peer = f.peers[1]!;
    assert.equal(peer.events.filter(e => e.method === "initialize").length, 1); assert.equal(peer.events.filter(e => e.method === "open").length, 2);
    assert.equal(peer.events.filter(e => e.method === "change").length, 0); assert.equal(peer.documents.get(doc.getSnapshot().uri)!.getText(), "a😀\r\nsource!");
    assert.equal(peer.documents.get(companion.getSnapshot().uri)!.getText(), "companion!");
    assert.ok(a.synchronized(doc)!.isCurrent());
});

test("command review is exclusive and cancellation quarantines uncorrelated edits without disconnecting readers", async t => {
    const f = fixture(t), a = f.provider.createScope(), b = f.provider.createScope(), entered = latch<void>(), cancelled = latch<void>(), decision = latch<{ applied: boolean }>();
    const doc = a.attachDocument(f.source.id); b.attachDocument(f.source.id); let context: LspRequestContext | undefined;
    await a.ensureConnected();
    const reservation = a.reserveCommand(async (_value, captured) => { context = captured; const stop = captured.onCancel(() => cancelled.resolve()); entered.resolve(); try { return await decision.promise; } finally { stop(); } });
    assert.throws(() => a.requestCommand("test.edit"), RpcError);
    const peer = f.peers[0]!;
    const finish = latch<void>();
    peer.rpc.onRequest("workspace/executeCommand", async () => {
        await peer.rpc.sendRequest("workspace/applyEdit", { edit: { changes: {} } });
        await finish.promise;
        return "done";
    });
    const call = reservation.requestCommand("test.edit"), rejected = assert.rejects(call.result, error => error instanceof RpcError && error.code === -32800); await entered.promise;
    assert.ok(context!.isCurrent()); assert.throws(() => b.requestCommand("test.edit"), RpcError);
    assert.deepEqual(await b.requestDocument("textDocument/definition", b.attachDocument(f.source.id), index => ({ position: index.at(0) })).result, []);
    call.cancel(); await rejected; await cancelled.promise; assert.equal(context!.isCurrent(), false); decision.resolve({ applied: false }); await settled();
    assert.equal(f.provider.snapshot().commandQuarantined, true); assert.equal(f.provider.getSnapshot().commandRequiresReconnect, true); assert.equal(f.provider.getSnapshot().commandAvailable, false); assert.throws(() => b.requestCommand("test.edit"), RpcError);
    assert.deepEqual(await peer.rpc.sendRequest("workspace/applyEdit", { edit: { changes: {} } }), { applied: false, failureReason: "No available captured command review intent." });
    assert.equal(f.provider.getSnapshot().phase, "ready");
    assert.ok(b.synchronized(b.attachDocument(f.source.id))!.isCurrent()); assert.equal(doc.getSnapshot().buffer.length, "a😀\r\nsource".length);
    const epoch = f.provider.getSnapshot().epoch;
    const available = latch<void>();
    const stop = f.provider.subscribe(() => { if (f.provider.getSnapshot().commandAvailable) available.resolve(); });
    finish.resolve();
    await available.promise;
    stop();
    assert.equal(f.provider.getSnapshot().epoch, epoch);
    assert.equal(f.provider.snapshot().commandQuarantined, false);
    const next = b.requestCommand("test.edit");
    assert.equal(await next.result, "done");
    assert.equal(next.isCurrent(), true);
});

test("a rejected oversized update expires associations but preserves unrelated documents and local text", async t => {
    const f = fixture(t, { maxDocumentUnits: 16 }), a = f.provider.createScope(), b = f.provider.createScope(), doc = a.attachDocument(f.source.id); b.attachDocument(f.companion.id); await a.ensureConnected();
    const captured = a.synchronized(doc)!; f.edit(f.source.id, "x".repeat(32)); assert.equal(captured.isCurrent(), false); await settled();
    assert.equal(a.synchronized(doc), undefined); assert.equal(f.provider.snapshot().documents, 1); assert.equal(f.provider.getSnapshot().phase, "ready");
    assert.equal(f.workspace.document(f.source.id).buffer.length, "a😀\r\nsource".length + 32); assert.equal(f.errors.length, 1);
    assert.deepEqual(await b.requestDocument("textDocument/definition", b.attachDocument(f.companion.id), index => ({ position: index.at(0) })).result, []);
    const resource = f.source.id;
    const ownership = f.workspace.diagnostics();
    assert.throws(() => a.attachDocument(resource), /document size limit/);
    assert.equal(f.workspace.diagnostics().leases, ownership.leases);
    assert.ok(f.workspace.undo({ documentId: resource, expectedRevision: f.workspace.document(resource).revision }).applied);
    const retry = a.attachDocument(resource);
    await a.flush([retry]);
    const reply = await a.requestDocument("textDocument/hover", retry, index => ({ position: index.at(0) })).result;
    assert.deepEqual(reply, { contents: "shared provider" });
});

test("shared diagnostic placement preserves unknown freshness and expires on reconnect and URI reuse", async t => {
    const f = fixture(t), a = f.provider.createScope(), b = f.provider.createScope(), left = a.attachDocument(f.source.id), right = b.attachDocument(f.source.id);
    const first = a.observeDiagnostics(left), second = b.observeDiagnostics(right); await a.ensureConnected();
    const send = async (value: unknown) => { f.peers.at(-1)!.rpc.sendNotification("textDocument/publishDiagnostics", value); await a.request("test/barrier").result; };
    const capture = a.synchronized(left)!, range = { start: { line: 1, character: 0 }, end: { line: 1, character: 6 } };
    const message = { uri: capture.document.uri, diagnostics: [{ range, message: "shared warning" }] };
    await send({ ...message, version: capture.version }); const verified = first.getSnapshot();
    assert.equal(verified, second.getSnapshot()); assert.equal(verified.result!.freshness, "versioned"); assert.equal(verified.result!.revision, f.workspace.document(f.source.id).revision);
    await send({ ...message, version: capture.version + 1 });
    assert.equal(first.getSnapshot(), verified);
    await send({ ...message, diagnostics: [
        { range, message: "partial batch" },
        { range: { start: range.end, end: range.start }, message: "invalid" }
    ] });
    assert.equal(first.getSnapshot(), verified);
    await send({ ...message, uri: "host+opaque:unknown" });
    assert.equal(first.getSnapshot(), verified);
    await send(message); const uncertain = first.getSnapshot(); assert.equal(uncertain.result!.version, null); assert.equal(uncertain.result!.revision, null);
    assert.equal(uncertain.result!.snapshotRevision, capture.document.revision); assert.equal(uncertain.result!.items[0]!.from, 5); assert.equal(uncertain.isCurrent(), true);
    f.edit(); assert.equal(uncertain.isCurrent(), false); assert.equal(uncertain.isPlacementCurrent(), false);
    assert.equal(first.getSnapshot().status, "pending"); assert.equal(first.getSnapshot().result!.items[0]!.from, 5);
    await a.flush(); await send({ ...message, diagnostics: [{ range: { start: { line: 100, character: 0 }, end: { line: 100, character: 4 } }, message: "outside" }] });
    assert.equal(first.getSnapshot().result!.items[0]!.placement, "out-of-bounds"); assert.equal(first.getSnapshot().result!.items[0]!.from, null);
    const beforeReconnect = first.getSnapshot(); await f.provider.reconnect(); assert.equal(beforeReconnect.isCurrent(), false); assert.equal(first.getSnapshot().status, "expired");
    const delayed = { ...message, version: a.synchronized(left)!.version };
    await send(delayed);
    f.edit(f.source.id, "?");
    const beforeReuse = first.getSnapshot();
    assert.equal(beforeReuse.status, "pending"); assert.equal(beforeReuse.isPlacementCurrent(), true); left.dispose(); right.dispose(); await settled();
    const buffer = f.workspace.document(f.source.id).buffer; assert.equal(buffer.slice(0, buffer.length), "a😀\r\nsource!?"); assert.deepEqual(f.errors, []);
    f.workspace.releaseResource(f.source.id, true);
    assert.throws(() => f.workspace.document(f.source.id), /released/);
    assert.equal(beforeReuse.isCurrent(), false); assert.equal(beforeReuse.isPlacementCurrent(), false); assert.equal(verified.isCurrent(), false);
    const file = f.workspace.createTextResource({ scope: "generic", resource: "replacement", variant: "working" },
        "Replacement", {
            value: "new\nsource",
            language: { uri: message.uri, languageId: capture.document.languageId },
        });
    const replacement = a.attachDocument(file.id);
    await a.flush();
    const rebound = a.observeDiagnostics(replacement);
    await send(delayed);
    assert.equal(rebound.getSnapshot().status, "empty", "A late warning belongs to the closed document.");
    await send({ ...message, version: a.synchronized(replacement)!.version, diagnostics: [{ range, message: "new warning" }] });
    assert.deepEqual(rebound.getSnapshot().result!.items.map(item => item.message), ["new warning"]);
    assert.equal(first.getSnapshot().status, "expired");
});

test("pending diagnostics map consecutive edits and undo without renewing provider authority", async t => {
    const f = fixture(t), scope = f.provider.createScope(), binding = scope.attachDocument(f.source.id), state = scope.observeDiagnostics(binding);
    await scope.ensureConnected(); const capture = scope.synchronized(binding)!;
    const send = async (diagnostics: unknown[], version = capture.version) => {
        f.peers.at(-1)!.rpc.sendNotification("textDocument/publishDiagnostics", { uri: capture.document.uri, version, diagnostics });
        await scope.request("test/barrier").result;
    };
    const range = (line: number, start: number, end: number) => ({ start: { line, character: start }, end: { line, character: end } });
    await send([{ range: range(1, 0, 6), message: "word" }, { range: range(1, 2, 2), message: "point" }, { range: range(100, 0, 1), message: "unplaced" }]);
    const fresh = state.getSnapshot(), initial = fresh.result!;
    const edit = (from: number, to: number, insert: string) => {
        const doc = f.workspace.document(f.source.id);
        assert.equal(f.workspace.edit({ documentId: doc.id, expectedRevision: doc.revision, edits: [{ from, to, insert }], origin: "human" }).applied, true);
    };
    const check = (from: number, to: number) => {
        const pending = state.getSnapshot(); assert.equal(pending.status, "pending"); assert.equal(pending.isCurrent(), false); assert.equal(pending.isPlacementCurrent(), true);
        assert.equal(pending.lastReport, initial);
        assert.equal(pending.result!.snapshotRevision, f.workspace.document(f.source.id).revision);
        assert.equal(pending.result!.version, initial.version); assert.equal(pending.result!.revision, initial.revision);
        assert.deepEqual(pending.result!.items.map(item => [item.from, item.to]), [[from, to], [from + 2, from + 2], [null, null]]);
        assert.equal(pending.result!.items[0]!.range, initial.items[0]!.range); assert.ok(Object.isFrozen(pending.result!.items));
        return pending;
    };
    edit(0, 0, "head\r\n"); const first = check(11, 17); assert.equal(fresh.isCurrent(), false); assert.equal(fresh.isPlacementCurrent(), false);
    edit(0, 0, "😀"); check(13, 19); assert.equal(first.isPlacementCurrent(), false);
    const undo = () => { assert.equal(f.workspace.undo({ documentId: f.source.id, expectedRevision: f.workspace.document(f.source.id).revision }).applied, true); };
    undo(); check(11, 17); undo(); check(5, 11);
    assert.deepEqual(initial.items.map(item => [item.from, item.to]), [[5, 11], [7, 7], [null, null]], "Retained snapshots never mutate.");
    await scope.flush();
    const beforeStale = state.getSnapshot();
    await send([]);
    assert.equal(state.getSnapshot(), beforeStale);
    edit(5, 11, "replacement"); assert.deepEqual(state.getSnapshot().result!.items.map(item => item.message), ["unplaced"]);
    assert.equal(state.getSnapshot().lastReport, initial, "Deleting a range clears its underline but keeps the provider message.");
    undo(); assert.deepEqual(state.getSnapshot().result!.items.map(item => item.message), ["unplaced"], "Undo cannot resurrect invalidated provider ranges.");
    const beforeReconnect = state.getSnapshot(); await f.provider.reconnect();
    assert.equal(beforeReconnect.isPlacementCurrent(), false); assert.equal(state.getSnapshot().status, "expired");
    await scope.flush(); await send([], scope.synchronized(binding)!.version);
    assert.equal(state.getSnapshot().status, "current"); assert.equal(state.getSnapshot().isCurrent(), true); assert.deepEqual(state.getSnapshot().result!.items, []);
    const beforeLoad = state.getSnapshot(), load = f.workspace.beginLoad(f.source);
    assert.equal(load.accept({ value: "replacement source" }), true); await scope.flush();
    assert.equal(beforeLoad.isPlacementCurrent(), false); assert.equal(state.getSnapshot().status, "expired"); assert.equal(state.getSnapshot().result, null);
    assert.equal(state.getSnapshot().lastReport, null);
});

test("feature requests require explicit reconnect after transport loss", async t => {
    const f = fixture(t), client = hoverClient(f.provider); t.after(client.dispose);
    const run = () => client.run({ document: f.workspace.document(f.source.id), offset: 0 }).result;
    await run(); f.peers[0]!.transport.dispose(); await settled();
    for (let i = 0; i < 3; i++) await assert.rejects(run(), /explicit.*connect/i);
    assert.equal(f.peers.length, 1); await f.provider.reconnect(); await run(); assert.equal(f.peers.length, 2);
});

test("command reservation blocks competing preparation before sync and preserves reads during recovery", async t => {
    const f = fixture(t), a = f.provider.createScope(), b = f.provider.createScope(), doc = a.attachDocument(f.source.id); b.attachDocument(f.source.id); await a.ensureConnected();
    const first = createLspCommandRunner(a), second = createLspCommandRunner(a), entered = latch<void>(), answer = latch<string>(); let prepared = 0;
    t.after(() => { first.dispose(); second.dispose(); });
    const scope = (insert: string) => ({ snapshots: () => [f.workspace.document(f.source.id)], isCurrent: () => true,
        prepare: () => { prepared++; f.edit(f.source.id, insert); }, review: async () => ({ applied: false }) });
    await assert.rejects(second.run("test.edit", ["x".repeat(8193)], scope("B")), RangeError); assert.equal(prepared, 0);
    f.peers[0]!.rpc.onRequest("workspace/executeCommand", () => { entered.resolve(); return answer.promise; });
    const pending = first.run("test.edit", [], scope("A")), rejected = assert.rejects(pending, error => error instanceof RpcError && error.code === -32800);
    await assert.rejects(second.run("test.edit", [], scope("B")), RpcError); assert.equal(prepared, 1); await entered.promise;
    assert.deepEqual(await b.requestDocument("textDocument/definition", b.attachDocument(f.source.id), index => ({ position: index.at(0) })).result, []);
    first.dispose(); await rejected;
    await assert.rejects(second.run("test.edit", [], scope("B")), RpcError); assert.equal(prepared, 1); assert.equal(f.provider.getSnapshot().phase, "ready");
    await f.provider.reconnect(); f.peers[1]!.rpc.onRequest("workspace/executeCommand", () => "done"); await second.run("test.edit", [], scope("B"));
    answer.resolve("late");
    const buffer = f.workspace.document(f.source.id).buffer; assert.equal(buffer.slice(0, buffer.length), "a😀\r\nsourceAB"); assert.equal(prepared, 2);
    const reservation = b.reserveCommand(); assert.equal(reservation.isCurrent(), true); reservation.release(); assert.equal(f.provider.getSnapshot().commandAvailable, true);
    assert.equal(f.provider.getSnapshot().commandRequiresReconnect, false); assert.ok(a.synchronized(doc)!.isCurrent()); assert.deepEqual(f.errors, []);
});

test("disposing a custom-request scope expires its context and settles a hanging handler without disconnecting peers", { timeout: 3000 }, async t => {
    const f = fixture(t), a = f.provider.createScope(), b = f.provider.createScope(), entered = latch<void>(), notice = latch<void>(), answer = latch<string>();
    const document = b.attachDocument(f.source.id); let context: LspRequestContext | undefined;
    a.onRequest("host/custom", async (_value, captured) => { context = captured; captured.onCancel(() => notice.resolve()); entered.resolve(); return answer.promise; });
    await b.ensureConnected(); const request = f.peers[0]!.rpc.sendRequest("host/custom", {});
    const rejected = assert.rejects(request, (error: unknown) => error instanceof Error && "code" in error && error.code === -32800);
    await entered.promise; assert.equal(context!.isCurrent(), true); a.dispose(); await rejected; await notice.promise;
    assert.equal(context!.isCurrent(), false); assert.equal(context!.cancelled, true); answer.resolve("late"); await settled();
    assert.deepEqual(await b.requestDocument("textDocument/definition", document, index => ({ position: index.at(0) })).result, []);
    assert.equal(f.provider.snapshot().protocol.incomingRequests, 0); assert.deepEqual(f.errors, []);
});
