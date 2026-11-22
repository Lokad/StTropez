import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { TextDocument, ResponseError, RegistrationRequest, UnregistrationRequest, CancellationTokenSource } from "vscode-languageserver-protocol/node.js";
import type { InitializeParams, InitializeResult, DidOpenTextDocumentParams, DidChangeTextDocumentParams, DidCloseTextDocumentParams } from "vscode-languageserver-protocol/node.js";
import { referencePeer } from "../fixtures/protocol/reference-peer.ts";
import { channel } from "./helpers/rpc-channel.ts";
import type { RpcScheduler, RpcTransport } from "../src/protocol/json-rpc.ts";
import type { LspSessionOptions, LspRequestContext } from "../src/protocol/index.ts";

import { TextBuffer } from "../src/index.ts";
import { LspSession, RpcError } from "../src/protocol/index.ts";
const settled = async () => { await setImmediate(); await setImmediate(); };
function fixture(t: test.TestContext, capabilities: InitializeResult["capabilities"] = { positionEncoding: "utf-16", textDocumentSync: 2, hoverProvider: true }) {
    const timers = new Set<ReturnType<typeof setTimeout>>(), peers: ReturnType<typeof peer>[] = [];
    const schedule: RpcScheduler = (ms, fn) => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); return () => { clearTimeout(timer); timers.delete(timer); }; };
    function peer() {
        const wire = channel(), rpc = referencePeer(wire.right), documents = new Map<string, TextDocument>(), events: string[] = [];
        let initialize: InitializeParams | undefined;
        rpc.onRequest("initialize", (params: InitializeParams): InitializeResult => { initialize = params; events.push("initialize"); return { capabilities }; });
        rpc.onNotification("initialized", () => { events.push("initialized"); });
        rpc.onRequest("shutdown", () => { events.push("shutdown"); return null; }); rpc.onNotification("exit", () => { events.push("exit"); });
        rpc.onNotification("textDocument/didOpen", (params: DidOpenTextDocumentParams) => { const doc = params.textDocument; assert.ok(events.includes("initialized")); assert.ok(!documents.has(doc.uri)); documents.set(doc.uri, TextDocument.create(doc.uri, doc.languageId, doc.version, doc.text)); events.push("open"); });
        rpc.onNotification("textDocument/didChange", (params: DidChangeTextDocumentParams) => { const before = documents.get(params.textDocument.uri)!; assert.ok(before); assert.ok(params.textDocument.version > before.version);
            let text = before.getText(); for (const change of params.contentChanges) { assert.ok("range" in change, "Ordinary synchronization must be incremental"); text = TextDocument.applyEdits(TextDocument.create(before.uri, before.languageId, before.version, text), [{ range: change.range, newText: change.text }]); }
            documents.set(before.uri, TextDocument.create(before.uri, before.languageId, params.textDocument.version, text)); events.push("change"); });
        rpc.onNotification("textDocument/didClose", (params: DidCloseTextDocumentParams) => { assert.ok(documents.delete(params.textDocument.uri)); events.push("close"); });
        rpc.listen(); return { rpc, wire, documents, events, initialize: () => initialize };
    }
    const connect: LspSessionOptions["connect"] = async () => { const next = peer(); peers.push(next); return next.wire.left; };
    t.after(() => { for (const next of peers) { next.rpc.dispose(); next.wire.left.dispose(); } for (const timer of timers) clearTimeout(timer); });
    return { connect, schedule, peers, timers };
}
const input = (text = "a😀\r\nb\rc\n", uri = "host+fixture://project/scope/doc%20one.ts", resourceId = "resource:one", revision = 40) =>
    ({ uri, resourceId, documentId: resourceId + ":working", revision, languageId: "typescript", buffer: TextBuffer.from(text) });

test("initialize advertises installed features for this connection and keeps explicit limits across reconnect", async t => {
    for (const limited of [false, true]) {
        const host = fixture(t), session = new LspSession({ ...host, ...(limited ? { features: ["textDocument/hover"], diagnostics: false } as const : {}) });
        t.after(() => session.dispose());
        const firstPane = session.retainFeatures("textDocument/hover", "textDocument/publishDiagnostics");
        const opening = session.connect();
        const secondPane = session.retainFeatures("textDocument/hover", "textDocument/documentLink");
        await opening;
        const capabilities = () => host.peers.at(-1)!.initialize()!.capabilities;
        assert.ok(capabilities().textDocument?.hover);
        assert.equal(!!capabilities().textDocument?.documentLink, !limited);
        assert.equal(!!capabilities().textDocument?.publishDiagnostics, !limited);
        assert.equal(capabilities().workspace, undefined);

        firstPane(); firstPane();
        const old = session.getSnapshot().clientFeatures;
        assert.ok(Object.isFrozen(old));
        const later = session.retainFeatures("textDocument/rename");
        assert.equal(session.getSnapshot().clientFeatures, old);
        assert.equal(capabilities().textDocument?.rename, undefined);
        session.disconnect(); await session.connect();
        assert.ok(capabilities().textDocument?.hover);
        assert.equal(capabilities().textDocument?.publishDiagnostics, undefined);
        assert.equal(!!capabilities().textDocument?.rename, !limited);
        secondPane(); later();
        session.disconnect(); await session.connect();
        assert.equal(!!capabilities().textDocument?.hover, limited);
        assert.equal(capabilities().textDocument?.documentLink, undefined);
        assert.equal(capabilities().textDocument?.rename, undefined);
        assert.equal(capabilities().workspace, undefined);
    }
});

test("unbound capability queries share selectors and synchronization policy without binding or sending documents", async t => {
    const host = fixture(t, { positionEncoding: "utf-16", textDocumentSync: 0,
        colorProvider: { id: "static-color", documentSelector: [{ language: "typescript", pattern: "**/*.ts" }], workDoneProgress: true } });
    let paths = 0;
    const session = new LspSession({ ...host, features: ["textDocument/documentColor"], pathForUri: uri => { paths++; return `/${uri.slice(uri.indexOf(":") + 1).toLowerCase()}.ts`; } });
    t.after(() => session.dispose()); const first = { uri: "host+fixture:MAIN", languageId: "typescript" }, other = { uri: "host+fixture:OTHER", languageId: "typescript" };
    assert.deepEqual(session.queryFeatureOptions("textDocument/documentColor", first), []); assert.equal(host.peers.length, 0);
    await session.connect(); const peer = host.peers[0]!;
    assert.deepEqual(session.queryFeatureOptions("textDocument/documentColor", first), []);
    await peer.rpc.sendRequest("client/registerCapability", { registrations: [
        { id: "open", method: "textDocument/didOpen", registerOptions: { documentSelector: [{ language: "typescript" }] } },
        { id: "change", method: "textDocument/didChange", registerOptions: { documentSelector: [{ language: "typescript" }], syncKind: 2 } },
        { id: "definition", method: "textDocument/documentColor", registerOptions: { documentSelector: [{ pattern: "**/other.ts" }], workDoneProgress: false } }
    ] });
    const before = session.snapshotOwnership(), messages = peer.wire.messages[0]!.length;
    assert.equal(session.queryFeatureOptions("textDocument/documentColor", first).length, 1);
    const options = session.queryFeatureOptions("textDocument/documentColor", other); assert.deepEqual(options.map(value => value.workDoneProgress), [true, false]);
    assert.ok(Object.isFrozen(options)); assert.ok(options.every(Object.isFrozen));
    assert.deepEqual(session.queryFeatureOptions("textDocument/documentColor", { ...first, languageId: "other" }), []);
    assert.throws(() => session.queryFeatureOptions("textDocument/documentColor", { ...first, uri: "relative" }), TypeError);
    assert.deepEqual(session.snapshotOwnership(), before); assert.equal(peer.wire.messages[0]!.length, messages);
    const document = session.bindDocument({ ...input(), ...other }); await session.flush();
    assert.deepEqual(session.featureOptions("textDocument/documentColor", document), options); const cachedPaths = paths;
    assert.deepEqual(session.queryFeatureOptions("textDocument/documentColor", other), options); assert.equal(paths, cachedPaths);
    assert.equal(session.canRequest("textDocument/documentColor", document), true);
    await peer.rpc.sendRequest("client/unregisterCapability", { unregisterations: [{ id: "change", method: "textDocument/didChange" }] });
    assert.deepEqual(session.queryFeatureOptions("textDocument/documentColor", other), []); assert.equal(session.canRequest("textDocument/documentColor", document), false);
    session.disconnect(); await session.connect(); assert.deepEqual(session.queryFeatureOptions("textDocument/documentColor", first), []);
    session.dispose(); assert.deepEqual(session.queryFeatureOptions("textDocument/documentColor", other), []);
});

test("document synchronization waits exclude unrelated work and expire changed captures", async t => {
    const host = fixture(t), queued = new Set<() => void>(); let blocked = false;
    const session = new LspSession({ ...host, features: ["textDocument/hover"], schedule: (ms, callback) => {
        if (blocked && ms === 0) { queued.add(callback); return () => { queued.delete(callback); }; } return host.schedule(ms, callback);
    } }); t.after(() => session.dispose());
    const small = session.bindDocument(input("small")); await session.connect(); const peer = host.peers[0]!;
    peer.rpc.onRequest("textDocument/hover", () => null); peer.rpc.onRequest("fixture/barrier", () => null);
    blocked = true; session.bindDocument(input("large\n".repeat(10_000), "fixture:large", "large"));
    let read = false, flushed = false;
    const request = session.requestDocument("textDocument/hover", small, () => ({})); void request.result.then(() => { read = true; }, () => {});
    void session.flush().then(() => { flushed = true; }, () => {});
    await settled(); await session.request("fixture/barrier").result;
    assert.equal(read, true, "A synchronized document must not wait for an unrelated queued open."); assert.equal(flushed, false);
    small.update(40, 41, TextBuffer.from("changed"));
    const waiting = session.requestDocument("textDocument/hover", small, () => ({}));
    const expired = assert.rejects(waiting.result, error => error instanceof RpcError && error.code === -32801);
    small.update(41, 42, TextBuffer.from("newer")); await expired;
    blocked = false; for (const callback of queued) callback(); queued.clear(); await session.flush();
    assert.equal(flushed, true); assert.equal(session.snapshotOwnership().pendingDocumentRequests, 0);
});

test("indexing batches checkpoints, makes progress during edits and reuses its index on reconnect", async t => {
    const host = fixture(t), buffers = [TextBuffer.from("line\r\n".repeat(20_000))]; let time = 0, clockStep = 4, turns = 0, edits = 0, hops = 0;
    let document: ReturnType<InstanceType<typeof LspSession>["bindDocument"]> | undefined;
    const session = new LspSession({ ...host, now: () => time += clockStep,
        schedule: (ms, callback) => { if (ms === 0) hops++; return host.schedule(ms, () => {
            if (document && ms === 0 && ++turns > 1 && edits < 20) {
                const previous = buffers.at(-1)!, next = previous.replace(previous.length, previous.length, "x"); buffers.push(next);
                document.update(40 + edits, 41 + edits, next); edits++;
            }
            callback();
        }); } }); t.after(() => session.dispose());
    document = session.bindDocument({ ...input(), buffer: buffers[0]! }); await session.connect(); await settled();
    assert.ok(edits > 0 && edits < 20, "Indexing must finish while new edits are still arriving.");
    assert.equal(host.peers[0]!.documents.get(document.getSnapshot().uri)!.getText(), buffers.at(-1)!.slice(0, buffers.at(-1)!.length));
    assert.ok(buffers.reduce((units, buffer) => units + buffer.readMetrics().sliceUnits, 0) < buffers[0]!.length * 4, "Retain indexed text instead of restarting its scan.");
    const current = buffers.at(-1)!, before = current.readMetrics().sliceUnits; document = undefined;
    session.disconnect(); await session.connect(); await settled();
    assert.ok(current.readMetrics().sliceUnits - before <= current.length + 64, "Reconnect exports text once without rescanning its line index.");
    clockStep = 0; const beforeHops = hops;
    session.bindDocument(input("abcdefghij\n".repeat(272_000), "fixture:batched", "batched")); await session.flush();
    assert.ok(hops - beforeHops >= 2 && hops - beforeHops <= 8, "A stopped clock still bounds work, without one timer hop per 16K units.");
});

test("an encoded document failure is isolated, reported once and retried after a new revision", async t => {
    const host = fixture(t), errors: Error[] = [], session = new LspSession({ ...host, features: ["textDocument/hover"], rpc: { maxMessageUnits: 4096 }, onError: error => { errors.push(error); } });
    t.after(() => session.dispose());
    const tooLarge = session.bindDocument(input("\u0000".repeat(1000), "fixture:large", "large")), small = session.bindDocument(input("small", "fixture:small", "small"));
    await session.connect(); await settled(); const peer = host.peers[0]!;
    assert.equal(session.getSnapshot().phase, "ready"); assert.equal(errors.length, 1); assert.match(errors[0]!.message, /configured limit/);
    assert.equal(session.synchronized(tooLarge), undefined); assert.equal(peer.documents.has("fixture:large"), false);
    peer.rpc.onRequest("textDocument/hover", () => ({ contents: "healthy" }));
    assert.deepEqual(await session.requestDocument("textDocument/hover", small, () => ({})).result, { contents: "healthy" });
    await assert.rejects(session.requestDocument("textDocument/hover", tooLarge, () => ({})).result, /configured limit/);
    small.update(40, 41, TextBuffer.from("still small")); await session.flush(); assert.equal(errors.length, 1);
    tooLarge.update(40, 41, TextBuffer.from("repaired")); await session.flush(); await settled(); assert.equal(peer.documents.get("fixture:large")!.getText(), "repaired");
    tooLarge.update(41, 42, TextBuffer.from("\u0000".repeat(1000))); await session.flush(); await settled();
    assert.equal(peer.documents.has("fixture:large"), false); assert.equal(errors.length, 2); assert.ok(session.synchronized(small));
});

test("batch range overhead falls back before sending when the host message or JSON-node limit requires it", async t => {
    for (const rpc of [{ maxMessageUnits: 4096 }, { maxJsonNodes: 128 }]) {
        const host = fixture(t), errors: Error[] = [], session = new LspSession({ ...host, rpc, onError: error => errors.push(error) }); t.after(() => session.dispose());
        const initial = input("abcdefghij\n".repeat(100)), document = session.bindDocument(initial); await session.connect();
        const edits = Array.from({ length: 60 }, (_, i) => ({ from: i * 11 + 2, to: i * 11 + 2, insert: "!" }));
        const edit = initial.buffer.apply(edits);
        document.update(40, 41, edit.buffer, edits); await session.flush(); await settled();
        const peer = host.peers[0]!, changes = (peer.wire.messages[0] as { method: string; params: DidChangeTextDocumentParams }[]).filter(message => message.method === "textDocument/didChange");
        assert.equal(changes.length, 1); assert.equal(changes[0]!.params.contentChanges.length, 1);
        assert.equal(peer.documents.get(initial.uri)!.getText(), edit.buffer.slice(0, edit.buffer.length));
        assert.deepEqual(peer.events.filter(event => event === "close"), []); assert.deepEqual(errors, []); assert.ok(session.synchronized(document));
        session.dispose();
    }
});

test("released notification methods recover capacity and do not retain installed dispatchers", async t => {
    const host = fixture(t), session = new LspSession(host); t.after(() => session.dispose()); await session.connect();
    let delivered = 0;
    for (let i = 0; i < 256; i++) { const stop = session.onNotification(`fixture/note${i}`, () => { delivered++; }); stop(); stop(); }
    const stale = session.onNotification("fixture/reused", () => { delivered += 100; }); stale();
    const stop = session.onNotification("fixture/reused", () => { delivered++; }); stale();
    host.peers[0]!.rpc.sendNotification("fixture/reused", {}); await settled(); assert.equal(delivered, 1);
    stop(); session.disconnect(); await session.connect(); host.peers[1]!.rpc.sendNotification("fixture/reused", {}); await settled(); assert.equal(delivered, 1);
});

test("an edit queued at pump completion schedules another synchronization turn", async t => {
    const host = fixture(t); let hook: (() => void) | undefined;
    const session = new LspSession({ ...host, connect: async context => { const port = await host.connect(context);
        return { ...port, send: text => { port.send(text); if (hook && text.includes('"textDocument/didChange"')) { const work = hook; hook = undefined; queueMicrotask(work); } } }; } });
    t.after(() => session.dispose()); const document = session.bindDocument(input("initial")); await session.connect();
    hook = () => document.update(41, 42, TextBuffer.from("second")); document.update(40, 41, TextBuffer.from("first"));
    await session.flush(); await settled();
    assert.equal(session.synchronized(document)?.document.revision, 42);
    assert.equal(host.peers[0]!.documents.get(document.getSnapshot().uri)!.getText(), "second");
    assert.equal(session.snapshotOwnership().scheduledTasks, 0);
});

test("a binding closed synchronously while its open is sent still receives exactly one close", async t => {
    const host = fixture(t); let document: ReturnType<InstanceType<typeof LspSession>["bindDocument"]>;
    const session = new LspSession({ ...host, connect: async context => { const port = await host.connect(context);
        return { ...port, send: text => { port.send(text); if (JSON.parse(text).method === "textDocument/didOpen") document.dispose(); } }; } });
    t.after(() => session.dispose()); document = session.bindDocument(input("closed during send")); await session.connect();
    const peer = host.peers[0]!; peer.rpc.onRequest("fixture/barrier", () => null); await session.request("fixture/barrier").result;
    assert.deepEqual(peer.events.slice(-2), ["open", "close"]); assert.equal(peer.documents.size, 0);
    assert.equal(session.snapshotOwnership().documents, 0); assert.equal(session.snapshotOwnership().remoteDocuments, 0); assert.equal(session.snapshotOwnership().scheduledTasks, 0);
});

test("reference peer receives ordered initialization and exact coalesced UTF-16 incremental versions", async t => {
    const host = fixture(t), session = new LspSession({ ...host, features: ["textDocument/hover"] }); t.after(() => session.dispose());
    const initial = input(), document = session.bindDocument(initial); assert.equal(session.synchronized(document), undefined); await session.connect(); await settled(); const peer = host.peers[0]!, firstCapture = session.synchronized(document)!;
    assert.equal(firstCapture.maxDocumentUnits, 3 * 1024 * 1024);
    assert.equal(firstCapture.document, document.getSnapshot()); assert.equal(firstCapture.version, 1); assert.equal(firstCapture.isCurrent(), true);
    assert.deepEqual(peer.initialize()?.capabilities.general?.positionEncodings, ["utf-16"]); assert.equal(peer.initialize()?.capabilities.textDocument?.synchronization?.dynamicRegistration, true);
    assert.deepEqual(peer.events, ["initialize", "initialized", "open"]); assert.equal(peer.documents.get(initial.uri)?.getText(), "a😀\r\nb\rc\n");
    const next = initial.buffer.replace(4, 5, ""), latest = next.replace(1, 1, "prefix\r\n"); document.update(40, 45, next); document.update(45, 51, latest);
    assert.equal(firstCapture.isCurrent(), false); assert.equal(session.synchronized(document), undefined);
    await session.flush(); await settled(); assert.equal(peer.documents.get(initial.uri)?.getText(), latest.slice(0, latest.length)); assert.equal(peer.documents.get(initial.uri)?.version, 2);
    document.update(51, 52, latest); await session.flush(); await settled(); assert.equal(peer.documents.get(initial.uri)?.version, 3);
    assert.equal(initial.buffer.readMetrics().textExports + latest.readMetrics().textExports, 0);
    document.dispose(); const replacement = session.bindDocument(input("replacement", initial.uri, "resource:two", 0)); document.dispose(); assert.throws(() => document.update(52, 53, latest), error => error instanceof RpcError && error.code === -32801);
    await session.flush(); await settled(); assert.equal(peer.documents.get(initial.uri)?.getText(), "replacement"); assert.deepEqual(peer.events.slice(-2), ["close", "open"]); replacement.dispose(); await session.flush(); await settled();
    session.dispose(); replacement.dispose(); assert.deepEqual(session.snapshotOwnership(), { documents: 0, remoteDocuments: 0, registrations: 0, subscriptions: 0, scheduledTasks: 0, pendingDocumentRequests: 0, pendingRequests: 0, incomingRequests: 0 }); assert.equal(host.timers.size, 0);
});

test("documentation formats are opt-in and declare the supported parser without HTML tags", async t => {
    for (const markdownDocumentation of [false, true]) {
        const host = fixture(t), session = new LspSession({ ...host, features: ["textDocument/hover", "textDocument/signatureHelp"], markdownDocumentation });
        t.after(() => session.dispose()); await session.connect();
        const capabilities = host.peers[0]!.initialize()!.capabilities, formats = markdownDocumentation ? ["markdown", "plaintext"] : ["plaintext"];
        assert.deepEqual(capabilities.textDocument?.hover?.contentFormat, formats);
        assert.deepEqual(capabilities.textDocument?.signatureHelp?.signatureInformation?.documentationFormat, formats);
        assert.deepEqual(capabilities.general?.markdown, markdownDocumentation ? { parser: "sttropez-documentation-subset", version: "1", allowedTags: [] } : undefined);
    }
});

test("dynamic registrations validate atomically, select documents and withdraw capabilities", async t => {
    const host = fixture(t, {}), session = new LspSession({ ...host, features: ["textDocument/hover"] }); t.after(() => session.dispose());
    const documents = ["host+fixture:/src/sampleAa.ts", "host+fixture:/deep/test/sample_z.js", "host+fixture:/src/sample1a.ts", "other:/src/sampleAa.ts", "host+fixture:/other/sampleAa.ts"].map(uri => session.bindDocument(input("text", uri, uri)));
    await session.connect(); const peer = host.peers[0]!, selector = [{ scheme: "host+fixture", language: "typescript", pattern: "**/{src,test}/sample[!0-9]?.{ts,js}" }];
    const registration = (id: string, method: string, extra = {}) => ({ id, method, registerOptions: { documentSelector: selector, ...extra } });
    await assert.rejects(peer.rpc.sendRequest(RegistrationRequest.method, { registrations: [registration("valid", "textDocument/didOpen"), registration("bad", "textDocument/didChange", { syncKind: 1 })] }), error => error instanceof ResponseError && error.code === -32602);
    assert.equal(session.getSnapshot().registrations.length, 0);
    await peer.rpc.sendRequest(RegistrationRequest.type, { registrations: [registration("open", "textDocument/didOpen"), registration("change", "textDocument/didChange", { syncKind: 2 }), registration("hover", "textDocument/hover")] });
    await session.flush(); await settled(); assert.equal(peer.documents.size, 2); assert.deepEqual(documents.map(doc => session.canRequest("textDocument/hover", doc)), [true, true, false, false, false]);
    const immutable = session.getSnapshot(); assert.equal(Object.isFrozen(immutable.registrations[0]?.registerOptions), true);
    await assert.rejects(peer.rpc.sendRequest(UnregistrationRequest.type, { unregisterations: [{ id: "hover", method: "textDocument/rename" }] }), error => error instanceof ResponseError && error.code === -32602);
    assert.equal(session.getSnapshot(), immutable);
    await peer.rpc.sendRequest(UnregistrationRequest.type, { unregisterations: [{ id: "hover", method: "textDocument/hover" }, { id: "change", method: "textDocument/didChange" }] }); await session.flush(); await settled();
    assert.equal(peer.documents.size, 0); assert.equal(session.canRequest("textDocument/hover", documents[0]!), false); assert.equal(immutable.registrations.length, 3);
    await assert.rejects(peer.rpc.sendRequest(RegistrationRequest.type, { registrations: [registration("notebook", "textDocument/hover", { documentSelector: [{ notebook: "fixture" }] })] }), error => error instanceof ResponseError && error.code === -32602);
});

test("ordinary edits visit one binding and reuse selector results until registration or binding identity changes", async t => {
    const host = fixture(t, { foldingRangeProvider: { documentSelector: [{ language: "typescript", pattern: "**/*.ts" }] } }); let paths = 0;
    const session = new LspSession({ ...host, features: ["textDocument/foldingRange", "textDocument/completion"], pathForUri: uri => { paths++; return uri.slice(uri.indexOf(":") + 1); } });
    t.after(() => session.dispose());
    const documents = Array.from({ length: 100 }, (_, i) => session.bindDocument(input("text", `fixture:/source/${i}.${i === 99 ? "txt" : "ts"}`, `resource:${i}`)));
    await session.connect(); const peer = host.peers[0]!; peer.rpc.onRequest("fixture/barrier", () => null);
    const drain = async () => { await session.flush(); await session.request("fixture/barrier").result; };
    const registrations = (language: string) => ["didOpen", "didChange", "completion"].map(method => ({ id: method, method: `textDocument/${method}`,
        registerOptions: { documentSelector: [{ language, pattern: "**/*.ts" }], ...(method === "didChange" ? { syncKind: 2 } : {}) } }));
    await peer.rpc.sendRequest("client/registerCapability", { registrations: registrations("typescript") }); await drain();
    assert.equal(peer.documents.size, 99);
    for (const doc of documents) { session.canRequest("textDocument/foldingRange", doc); session.featureOptions("textDocument/completion", doc); }
    paths = 0; let visits = 0;
    // Count the existing synchronization-policy owner, not elapsed time on a shared test host.
    const syncs = Reflect.get(session, "syncs") as (...args: unknown[]) => boolean;
    Reflect.set(session, "syncs", (...args: unknown[]) => { visits++; return syncs.apply(session, args); });
    try {
        const doc = documents[0]!; doc.update(40, 41, doc.getSnapshot().buffer.replace(0, 0, "edited "));
        await drain(); const editPolicyVisits = visits;
        assert.ok(visits <= 3, `An ordinary edit visited synchronization policy ${visits} times.`);
        for (const doc of documents) { session.canRequest("textDocument/foldingRange", doc); session.featureOptions("textDocument/completion", doc); }
        assert.equal(paths, 0); assert.equal(peer.events.filter(event => event === "change").length, 1);
        assert.equal(peer.documents.get(doc.getSnapshot().uri)!.getText(), "edited text");
        t.diagnostic(JSON.stringify({ bindings: documents.length, editPolicyVisits, selectorPaths: paths }));
    } finally { Reflect.set(session, "syncs", syncs); }
    const old = documents[0]!, uri = old.getSnapshot().uri; old.dispose();
    const replacement = session.bindDocument({ ...input("replacement", uri, "new-resource", 0), languageId: "plain" });
    await drain(); assert.equal(peer.documents.has(uri), false); assert.equal(session.canRequest("textDocument/completion", replacement), false);
    assert.throws(() => old.update(41, 42, TextBuffer.from("stale")), RpcError);
    await peer.rpc.sendRequest("client/unregisterCapability", { unregisterations: registrations("typescript").map(({ id, method }) => ({ id, method })) });
    await peer.rpc.sendRequest("client/registerCapability", { registrations: registrations("plain") }); await drain();
    assert.equal(peer.documents.size, 1); assert.equal(peer.documents.get(uri)!.getText(), "replacement");
    assert.equal(session.canRequest("textDocument/completion", replacement), true); assert.equal(session.canRequest("textDocument/foldingRange", replacement), false);
    session.disconnect(); await session.connect(); await settled(); assert.equal(host.peers[1]!.documents.size, 0);
    assert.equal(session.canRequest("textDocument/completion", replacement), false);
});

test("registration changes during indexing reconcile the latest snapshot without losing the pending close or rebuilding its index", async t => {
    const host = fixture(t, {}), queued = new Set<() => void>(); let blocked = false, time = 0;
    const session = new LspSession({ ...host, now: () => time += 4, schedule: (ms, callback) => {
        if (blocked && ms === 0) { queued.add(callback); return () => { queued.delete(callback); }; } return host.schedule(ms, callback);
    } }); t.after(() => session.dispose());
    const initial = input("small"), document = session.bindDocument(initial); await session.connect(); const peer = host.peers[0]!;
    peer.rpc.onRequest("fixture/barrier", () => null);
    const change = { id: "change", method: "textDocument/didChange", registerOptions: { documentSelector: null, syncKind: 2 } };
    await peer.rpc.sendRequest("client/registerCapability", { registrations: [{ id: "open", method: "textDocument/didOpen", registerOptions: { documentSelector: null } }, change] });
    await session.flush(); await session.request("fixture/barrier").result; assert.equal(peer.documents.get(initial.uri)!.getText(), "small");
    blocked = true; const large = TextBuffer.from("line\r\n".repeat(40_000)); document.update(40, 41, large);
    const start = queued.values().next().value!; queued.delete(start); start(); await settled(); assert.equal(queued.size, 1);
    await peer.rpc.sendRequest("client/unregisterCapability", { unregisterations: [{ id: change.id, method: change.method }] });
    blocked = false; for (const callback of queued) callback(); queued.clear(); await session.flush(); await session.request("fixture/barrier").result;
    assert.equal(peer.documents.size, 0); assert.equal(peer.events.filter(event => event === "change").length, 0); assert.equal(session.synchronized(document), undefined);
    const reads = large.readMetrics().sliceUnits;
    await peer.rpc.sendRequest("client/registerCapability", { registrations: [change] }); await session.flush(); await session.request("fixture/barrier").result;
    assert.ok(large.readMetrics().sliceUnits - reads <= large.length, "Restoring synchronization should reuse the completed index and export the current text once.");
    assert.equal(peer.documents.get(initial.uri)!.getText(), large.slice(0, large.length)); assert.deepEqual(peer.events.slice(-2), ["close", "open"]);
    assert.equal(session.synchronized(document)!.document.revision, 41); assert.equal(session.snapshotOwnership().scheduledTasks, 0);
});

test("code-action resolve options follow matching registrations and immutable negotiated capabilities", async t => {
    const host = fixture(t, { positionEncoding: "utf-16", textDocumentSync: 2, codeActionProvider: false }), session = new LspSession({ ...host, features: ["textDocument/codeAction"], workspaceEdits: true }); t.after(() => session.dispose());
    const document = session.bindDocument(input()), other = session.bindDocument({ ...input("other", "other:document", "other"), languageId: "plain" }); await session.connect(); await session.flush(); const peer = host.peers[0]!;
    assert.deepEqual(peer.initialize()!.capabilities.textDocument!.codeAction!.resolveSupport!.properties, ["edit"]); assert.equal(peer.initialize()!.capabilities.workspace!.workspaceEdit!.documentChanges, true); assert.equal(peer.initialize()!.capabilities.workspace!.applyEdit, undefined);
    assert.deepEqual(session.featureOptions("textDocument/codeAction", document), []);
    await peer.rpc.sendRequest("client/registerCapability", { registrations: [{ id: "actions", method: "textDocument/codeAction", registerOptions: { documentSelector: [{ language: "typescript", scheme: "host+fixture" }], resolveProvider: true } }] });
    const options = session.featureOptions("textDocument/codeAction", document); assert.equal(options[0]!.resolveProvider, true); assert.equal(Object.isFrozen(options), true); assert.equal(Object.isFrozen(options[0]), true); assert.deepEqual(session.featureOptions("textDocument/codeAction", other), []);
    const capture = session.synchronized(document)!; await peer.rpc.sendRequest("client/unregisterCapability", { unregisterations: [{ id: "actions", method: "textDocument/codeAction" }] });
    assert.equal(capture.isCurrent(), false); assert.deepEqual(session.featureOptions("textDocument/codeAction", document), []);
});

test("signature/link/color negotiation honors static selectors and one color registration grants both related requests", async t => {
    const host = fixture(t, { positionEncoding: "utf-16", textDocumentSync: 2, colorProvider: { id: "static-color", documentSelector: [{ language: "other" }] }, signatureHelpProvider: { triggerCharacters: ["("], retriggerCharacters: [","] }, documentLinkProvider: { resolveProvider: true } });
    const session = new LspSession({ ...host, features: ["textDocument/signatureHelp", "textDocument/documentLink", "textDocument/documentColor", "textDocument/colorPresentation"] }); t.after(() => session.dispose());
    const document = session.bindDocument(input()); await session.connect(); const peer = host.peers[0]!, caps = peer.initialize()!.capabilities.textDocument!;
    assert.equal(caps.signatureHelp?.contextSupport, true); assert.equal(caps.signatureHelp?.signatureInformation?.activeParameterSupport, true); assert.equal(caps.documentLink?.tooltipSupport, true); assert.equal(caps.colorProvider?.dynamicRegistration, true);
    assert.equal("documentColor" in caps, false); assert.equal("colorPresentation" in caps, false); assert.equal(session.canRequest("textDocument/documentColor", document), false); assert.equal(session.canRequest("textDocument/colorPresentation", document), false);
    assert.equal(session.featureOptions("textDocument/documentLink", document)[0]!.resolveProvider, true);
    await peer.rpc.sendRequest("client/registerCapability", { registrations: [{ id: "dynamic-color", method: "textDocument/documentColor", registerOptions: { documentSelector: [{ language: "typescript" }] } }] });
    assert.equal(session.canRequest("textDocument/documentColor", document), true); assert.equal(session.canRequest("textDocument/colorPresentation", document), true); const capture = session.synchronized(document)!;
    await peer.rpc.sendRequest("client/unregisterCapability", { unregisterations: [{ id: "dynamic-color", method: "textDocument/documentColor" }] });
    assert.equal(session.canRequest("textDocument/colorPresentation", document), false); assert.equal(capture.isCurrent(), false);
});
test("workspace commands require advertised bounded options, reject stale registrations and never replay", async t => {
    const host = fixture(t, { positionEncoding: "utf-16", textDocumentSync: 2, executeCommandProvider: { commands: ["status"] } }), session = new LspSession({ ...host, features: ["workspace/executeCommand"] }); t.after(() => session.dispose()); await session.connect(); const peer = host.peers[0]!;
    let finish: ((value: unknown) => void) | undefined, executed = 0;
    peer.rpc.onRequest("workspace/executeCommand", (params: { command: string }) => { executed++; return params.command === "status" ? { ok: true } : new Promise(resolve => { finish = resolve; }); });
    assert.deepEqual(session.commandNames(), ["status"]); assert.equal(Object.isFrozen(session.commandNames()), true); assert.equal(peer.initialize()!.capabilities.workspace!.executeCommand!.dynamicRegistration, true);
    assert.deepEqual(await session.requestCommand("status", [{ opaque: "😀" }]).result, { ok: true }); assert.throws(() => session.requestCommand("unknown"), error => error instanceof RpcError && error.code === -32601); assert.throws(() => session.requestCommand("status", ["x".repeat(8193)]), /limit/); assert.equal(executed, 1);
    await peer.rpc.sendRequest("client/registerCapability", { registrations: [{ id: "commands", method: "workspace/executeCommand", registerOptions: { commands: ["review"] } }] });
    const call = session.requestCommand("review"); const rejected = assert.rejects(call.result, error => error instanceof RpcError && error.code === -32801); await settled();
    await peer.rpc.sendRequest("client/unregisterCapability", { unregisterations: [{ id: "commands", method: "workspace/executeCommand" }] }); assert.equal(call.isCurrent(), false); finish!({ late: true }); await rejected;
    await assert.rejects(peer.rpc.sendRequest("client/registerCapability", { registrations: [{ id: "valid", method: "workspace/executeCommand", registerOptions: { commands: ["first"] } }, { id: "invalid", method: "workspace/executeCommand", registerOptions: { commands: [42] } }] })); assert.equal(session.getSnapshot().registrations.length, 0);
    await assert.rejects(peer.rpc.sendRequest("client/registerCapability", { registrations: [{ id: "selector", method: "workspace/executeCommand", registerOptions: { commands: ["bad"], documentSelector: null } }] }));
    session.disconnect(); await session.connect(); assert.deepEqual(session.commandNames(), ["status"]); assert.equal(executed, 2); assert.equal(host.peers[1]!.wire.messages[0]!.some(value => (value as { method?: string }).method === "workspace/executeCommand"), false);
});

test("applyEdit is advertised only with a handler and cancelled review requests receive one terminal reply", async t => {
    const host = fixture(t), session = new LspSession({ ...host, applyEdit: true }); t.after(() => session.dispose()); await assert.rejects(session.connect(), /handler/); assert.equal(host.peers.length, 0);
    let context: LspRequestContext | undefined, cancellations = 0;
    session.onRequest("workspace/applyEdit", (_params, incoming) => { context = incoming; return new Promise(resolve => { incoming.onCancel(() => { cancellations++; resolve({ applied: false }); }); }); });
    await session.connect(); const peer = host.peers[0]!; assert.equal(peer.initialize()!.capabilities.workspace!.applyEdit, true); assert.equal(peer.initialize()!.capabilities.workspace!.workspaceEdit!.failureHandling, "transactional");
    const cancellation = new CancellationTokenSource(), request = peer.rpc.sendRequest("workspace/applyEdit", { label: "captured", edit: {} }, cancellation.token), rejected = assert.rejects(request, error => error instanceof ResponseError && error.code === -32800); await settled(); assert.equal(context!.isCurrent(), true);
    cancellation.cancel(); await rejected; await settled(); assert.equal(context!.isCurrent(), false); assert.equal(cancellations, 1); assert.equal(session.snapshotOwnership().incomingRequests, 0);
    assert.equal(peer.wire.messages[0]!.filter(value => (value as { error?: { code: number } }).error?.code === -32800).length, 1); cancellation.dispose();
});

test("document requests reject stale revisions, capability withdrawal, URI reuse and cancellation", async t => {
    const host = fixture(t), session = new LspSession({ ...host, features: ["textDocument/hover"] }); t.after(() => session.dispose()); const document = session.bindDocument(input()); await session.connect();
    const peer = host.peers[0]!, releases: ((value: unknown) => void)[] = []; let cancellations = 0, requests = 0;
    let received: (() => void) | undefined; const receipt = () => new Promise<void>(resolve => { received = resolve; });
    peer.rpc.onRequest("textDocument/hover", (_params, token) => new Promise(resolve => { requests++; token.onCancellationRequested(() => { cancellations++; resolve(null); }); releases.push(resolve); received?.(); received = undefined; }));
    const request = () => session.requestDocument("textDocument/hover", document, index => ({ position: index.at(1) }));
    const firstReceived = receipt(), first = request(), firstRejected = assert.rejects(first.result, error => error instanceof RpcError && error.code === -32801); await firstReceived;
    const old = document.getSnapshot(); document.update(old.revision, old.revision + 1, old.buffer.replace(0, 0, "new")); releases.shift()!({ contents: "old" }); await firstRejected;
    const secondReceived = receipt(), second = request(), secondRejected = assert.rejects(second.result, error => error instanceof RpcError && error.code === -32801); await secondReceived;
    await peer.rpc.sendRequest(RegistrationRequest.type, { registrations: [{ id: "hover-extra", method: "textDocument/hover", registerOptions: { documentSelector: null } }] }); releases.shift()!(null); await secondRejected;
    const third = request(), cancelled = assert.rejects(third.result, error => error instanceof RpcError && error.code === -32800); third.cancel(); await cancelled; assert.equal(requests, 2);
    const fourthReceived = receipt(), fourth = request(), fourthRejected = assert.rejects(fourth.result, error => error instanceof RpcError && error.code === -32800); await fourthReceived; fourth.cancel(); await fourthRejected; await settled(); assert.equal(cancellations, 1); releases.shift();
    const fifthReceived = receipt(), fifth = request(), fifthRejected = assert.rejects(fifth.result, error => error instanceof RpcError && error.code === -32801); await fifthReceived; document.dispose(); session.bindDocument(input("replacement", old.uri, "different-resource")); releases.shift()!(null); await fifthRejected;
});

test("reconnect reopens current captures, clears registrations and never replays commands", async t => {
    const host = fixture(t), session = new LspSession({ ...host, features: ["textDocument/hover"] }); t.after(() => session.dispose()); const initial = input(), document = session.bindDocument(initial);
    let handled = 0; const remove = session.onRequest("host/custom", () => { handled++; return { ok: true }; }); await session.connect(); const first = host.peers[0]!;
    await first.rpc.sendRequest(RegistrationRequest.type, { registrations: [{ id: "temporary", method: "textDocument/hover", registerOptions: { documentSelector: null } }] });
    first.rpc.onRequest("fixture/command", () => new Promise(() => {})); const call = session.request("fixture/command", { captured: initial.resourceId }), rejected = assert.rejects(call.result, error => error instanceof RpcError && error.code === -32097); await settled();
    session.disconnect(); await rejected; const latest = initial.buffer.replace(0, 0, "offline"); document.update(initial.revision, 99, latest); await session.connect(); await settled();
    const second = host.peers[1]!; assert.equal(second.documents.get(initial.uri)?.getText(), latest.slice(0, latest.length)); assert.equal(second.documents.get(initial.uri)?.version, 1); assert.equal(session.getSnapshot().registrations.length, 0);
    assert.equal(second.wire.messages[0]!.some(value => (value as { method?: string }).method === "fixture/command"), false);
    assert.deepEqual(await second.rpc.sendRequest("host/custom", {}), { ok: true }); assert.equal(handled, 1); remove();
    session.onRequest("host/custom", () => "replacement"); assert.equal(await second.rpc.sendRequest("host/custom", {}), "replacement");
    session.dispose(); remove(); assert.equal(first.wire.listeners() + second.wire.listeners(), 0);
});

test("opening cancellation owns late transports and failed UTF-16/full-sync negotiation stays disconnected", async t => {
    let resolve!: (transport: RpcTransport) => void, cancellations = 0; const timers = new Set<ReturnType<typeof setTimeout>>();
    const schedule: RpcScheduler = (ms, fn) => { const timer = setTimeout(fn, ms); timers.add(timer); return () => { clearTimeout(timer); timers.delete(timer); }; };
    const session = new LspSession({ schedule, connect: context => { context.onCancel(() => { cancellations++; }); return new Promise(yes => { resolve = yes; }); } });
    const opening = session.connect(), rejected = assert.rejects(opening, error => error instanceof RpcError && error.code === -32097); await settled(); session.disconnect(); await rejected;
    const wire = channel(); resolve(wire.left); await settled(); assert.throws(() => wire.right.send("{}"), /Closed/); assert.equal(cancellations, 1); assert.equal(timers.size, 0); session.dispose();
    for (const capabilities of [{ positionEncoding: "utf-8", textDocumentSync: 2 }, { textDocumentSync: 1 }, { textDocumentSync: { openClose: true, change: 1 } }] as const) {
        const host = fixture(t, capabilities), refused = new LspSession(host); await assert.rejects(refused.connect(), /UTF-16|incremental|synchronization/); assert.equal(refused.getSnapshot().phase, "disconnected"); refused.dispose();
    }
});

test("shutdown ordering, listener isolation and explicit disposal release all session ownership", async t => {
    const errors: Error[] = [], host = fixture(t), session = new LspSession({ ...host, onError: error => { errors.push(error); } });
    session.subscribe(() => { assert.throws(() => session.bindDocument(input()), /Reentrant/); throw new Error("Listener failure"); }); session.subscribe(() => {});
    session.bindDocument(input()); await session.connect(); const peer = host.peers[0]!;
    await session.shutdown(); await settled(); assert.deepEqual(peer.events.slice(0, 3), ["initialize", "initialized", "open"]);
    assert.ok(peer.wire.messages[0]!.some(value => (value as { method?: string }).method === "exit")); assert.ok(peer.events.includes("shutdown"));
    const methods = peer.wire.messages[0]!.map(value => (value as { method?: string }).method); assert.deepEqual(methods.slice(-2), ["shutdown", "exit"]);
    session.dispose(); assert.ok(errors.length >= 3);
    assert.equal(session.getSnapshot().phase, "disposed"); assert.equal(session.snapshotOwnership().subscriptions, 0); assert.equal(host.timers.size, 0);
});

test("large opening plans cancel at a cooperative boundary and limits refuse changes before retaining them", async t => {
    const host = fixture(t); let watching = false, zeros = 0, time = 0, planned!: () => void;
    const paused = new Promise<void>(resolve => { planned = resolve; });
    const session = new LspSession({ ...host, now: () => time += 4, maxDocuments: 2, maxDocumentUnits: 200_000, maxTotalUnits: 200_010,
        schedule: (ms, callback) => { if (watching && ms === 0 && ++zeros === 2) planned(); return host.schedule(ms, callback); } }); t.after(() => session.dispose());
    await session.connect(); const initial = input("x\r\n".repeat(50_000)), document = session.bindDocument(initial); watching = true;
    session.bindDocument(input("tiny", "fixture:small", "small")); assert.throws(() => session.bindDocument(input("third", "fixture:extra", "extra")), /limit/);
    assert.throws(() => document.update(40, 41, TextBuffer.from("x".repeat(200_001))), /limit/); assert.equal(document.getSnapshot().revision, 40);
    const syncing = session.flush(), rejected = assert.rejects(syncing, error => error instanceof RpcError && error.code === -32097); await paused; session.disconnect(); await rejected;
    assert.equal(host.peers[0]!.events.includes("open"), false); assert.equal(session.snapshotOwnership().scheduledTasks, 0);
    watching = false; document.update(40, 42, initial.buffer.replace(0, 1, "current")); await session.connect(); await settled();
    assert.equal(session.synchronized(document)!.maxDocumentUnits, 200_000);
    assert.equal(host.peers[1]!.documents.get(initial.uri)?.getText().startsWith("current\r\n"), true); assert.equal(session.snapshotOwnership().remoteDocuments, 2);
});

test("local edits retain useful indexing while URI replacement cancels obsolete ownership", async t => {
    for (const replacement of [false, true]) {
        const host = fixture(t); let change: (() => void) | undefined, turns = 0, time = 0;
        const session = new LspSession({ ...host, now: () => time += 4, schedule: (ms, callback) => host.schedule(ms, () => { if (change && ms === 0 && ++turns === 2) { const apply = change; change = undefined; apply(); } callback(); }) }); t.after(() => session.dispose());
        const initial = input("small"), original = session.bindDocument(initial); await session.connect(); await settled();
        const large = TextBuffer.from("line\r\n".repeat(40_000)), edits = [{ from: 0, to: 4, insert: "current" }], latest = large.apply(edits).buffer; let current = original;
        change = () => { if (replacement) { original.dispose(); current = session.bindDocument(input("replacement", initial.uri, "other-resource", 0)); }
            else original.update(41, 42, latest, edits); };
        original.update(40, 41, large); await session.flush(); await settled(); const peer = host.peers[0]!;
        if (replacement) assert.ok(large.readMetrics().sliceUnits < 16500, "A replaced binding stops after its first bounded chunk.");
        else assert.ok(latest.readMetrics().sliceUnits < latest.length + 128, "A newer revision reuses completed indexing and exports only its final wire delta.");
        assert.equal(session.synchronized(current)?.document, current.getSnapshot());
        if (replacement) { assert.deepEqual(peer.events.slice(-2), ["close", "open"]); assert.equal(peer.documents.get(initial.uri)?.getText(), "replacement"); assert.equal(peer.documents.get(initial.uri)?.version, 1); }
        else { assert.equal(peer.documents.get(initial.uri)?.getText(), latest.slice(0, latest.length)); assert.equal(peer.documents.get(initial.uri)?.version, 2); }
        session.dispose();
    }
});
