import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { CancellationTokenSource, InitializeRequest, InitializedNotification, RegistrationRequest, ResponseError } from "vscode-languageserver-protocol/node.js";
import type { InitializeParams, InitializeResult } from "vscode-languageserver-protocol/node.js";
import type { RpcTransport } from "../src/protocol/json-rpc.ts";
import type { JsonValue } from "../src/protocol/wire.ts";
import { referencePeer } from "./fixtures/protocol/reference-peer.ts";
import { channel } from "./helpers/rpc-channel.ts";

import { JsonRpcConnection } from "../src/protocol/json-rpc.ts";
import { RpcError, rpcCodes } from "../src/protocol/wire.ts";

function clock() {
    const timers = new Set<() => void>();
    return { schedule: (_ms: number, fn: () => void) => { timers.add(fn); return () => { timers.delete(fn); }; },
        fire: () => { for (const fn of [...timers]) { timers.delete(fn); fn(); } }, count: () => timers.size };
}
function raw() {
    let listener: Parameters<RpcTransport["subscribe"]>[0] | undefined, disposed = 0; const sent: unknown[] = [];
    const port: RpcTransport = { send: text => { sent.push(JSON.parse(text)); }, subscribe: next => { listener = next; return () => { listener = undefined; }; }, dispose: () => { disposed++; } };
    return { port, sent, receive: (message: unknown) => listener?.message(JSON.stringify(message)), text: (text: string) => listener?.message(text), disposed: () => disposed };
}
const flush = async () => { await setImmediate(); await setImmediate(); };

test("suppressed cancellation notifications still reject locally and release deadlines", async () => {
    const wire = raw(), timer = clock(), errors: Error[] = [];
    let mode: "suppress" | "throw" | "allow" = "suppress";
    const rpc = new JsonRpcConnection(wire.port, { schedule: timer.schedule, onError: error => errors.push(error),
        notifyCancellation: () => { if (mode === "throw") throw new Error("policy failure"); return mode === "allow"; } });
    try {
        const first = rpc.request("custom/first"), cancelled = assert.rejects(first.result, error => error instanceof RpcError && error.code === rpcCodes.requestCancelled);
        first.cancel(); await cancelled; assert.equal(timer.count(), 0); assert.equal(wire.sent.length, 1);
        const second = rpc.request("custom/deadline"), timedOut = assert.rejects(second.result, error => error instanceof RpcError && error.code === rpcCodes.timeout);
        timer.fire(); await timedOut; assert.equal(timer.count(), 0); assert.equal(wire.sent.length, 2);
        mode = "throw"; const third = rpc.request("custom/policy"), rejected = assert.rejects(third.result, RpcError); third.cancel(); await rejected;
        assert.equal(wire.sent.length, 3); assert.equal(errors[0]!.message, "policy failure"); assert.equal(timer.count(), 0);
        mode = "allow"; const last = rpc.request("custom/normal"), ending = assert.rejects(last.result, RpcError); last.cancel(); await ending;
        assert.deepEqual(wire.sent.at(-1), { jsonrpc: "2.0", method: "$/cancelRequest", params: { id: last.id } });
        assert.equal(rpc.snapshot().pendingRequests, 0); assert.equal(timer.count(), 0);
    } finally { rpc.dispose(); }
});

test("RPC JSON node limits follow the message budget and accept large bounded replies", async t => {
    const wire = raw(), timer = clock(), rpc = new JsonRpcConnection(wire.port, { schedule: timer.schedule });
    t.after(() => rpc.dispose());
    // 100,001 JSON values in the result, within the pilot's 512 KB corpus.
    const items = Array.from({ length: 50_000 }, (_, i) => [i]);
    const call = rpc.request("items");
    let received: unknown; void call.result.then(value => { received = value; }, error => { received = error; });
    wire.receive({ jsonrpc: "2.0", id: call.id, result: items }); await flush();
    assert.equal(rpc.snapshot().pendingRequests, 0); assert.equal(timer.count(), 0);
    assert.deepEqual(received, items); assert.equal(Object.isFrozen(received), true); assert.equal(Object.isFrozen((received as object[])[0]), true);
    rpc.notify("items", items); assert.deepEqual(wire.sent.at(-1), { jsonrpc: "2.0", method: "items", params: items });
});

test("over-budget response envelopes reject their known calls immediately without replying to responses", async t => {
    const wire = raw(), timer = clock(), failures: Error[] = [], rpc = new JsonRpcConnection(wire.port, {
        schedule: timer.schedule, maxJsonNodes: 64, onError: error => { failures.push(error); } });
    t.after(() => rpc.dispose());
    const unrelated = rpc.request("unrelated"); void unrelated.result.catch(() => {});
    for (const batch of [false, true]) {
        const first = rpc.request("large"), second = batch ? rpc.request("also-large") : undefined, rejected: unknown[] = [];
        const calls = [first, ...(second ? [second] : [])];
        calls.forEach(call => { void call.result.catch(error => { rejected.push(error); }); });
        const replies = calls.map(call => ({ jsonrpc: "2.0", id: call.id, result: Array(100).fill(0) })), sent = wire.sent.length;
        wire.receive(batch ? replies : replies[0]); await flush();
        assert.equal(rpc.snapshot().pendingRequests, 1); assert.equal(timer.count(), 1); assert.equal(rejected.length, calls.length);
        assert.ok(rejected.every(error => error instanceof RpcError && /JSON.*limit/.test(error.message)));
        assert.equal(wire.sent.length, sent); assert.equal(rpc.snapshot().disposed, false);
    }
    assert.throws(() => rpc.notify("large", Array(100).fill(0)), /bounded JSON/);
    wire.receive({ jsonrpc: "2.0", id: unrelated.id, result: "still usable" }); assert.equal(await unrelated.result, "still usable");
    assert.equal(timer.count(), 0); assert.deepEqual(failures, []);
    const deep = rpc.request("deep"); let depthError: unknown; void deep.result.catch(error => { depthError = error; });
    let nested: unknown = null; for (let i = 0; i < 70; i++) nested = [nested];
    wire.receive({ jsonrpc: "2.0", id: deep.id, result: nested }); await flush();
    assert.ok(depthError instanceof RpcError); assert.equal(timer.count(), 0); assert.equal(rpc.snapshot().disposed, false);
    const overflow = rpc.request("numeric-result");
    const rejected = assert.rejects(overflow.result, error => error instanceof RpcError && error.code === rpcCodes.invalidRequest);
    wire.text(`{"jsonrpc":"2.0","id":${overflow.id},"result":1e400}`);
    await rejected;
    const sent = wire.sent.length;
    wire.receive([{ jsonrpc: "2.0", method: "note", params: Array(100).fill(0) },
        { jsonrpc: "2.0", method: "host/work", id: "incoming", params: Array(100).fill(0) }]); await flush();
    assert.equal(failures.length, 1); assert.equal(wire.sent.length, sent + 1);
    assert.deepEqual(wire.sent.at(-1), [{ jsonrpc: "2.0", id: "incoming", error: { code: -32600, message: "RPC JSON structure exceeds the configured node limit or nesting limit." } }]);
    for (const maxJsonNodes of [0, -1, NaN, Infinity, 1.5]) {
        const invalid = raw();
        assert.throws(() => new JsonRpcConnection(invalid.port, { schedule: timer.schedule, maxJsonNodes }), /Invalid RPC limits/);
        assert.equal(invalid.disposed(), 1);
    }
    const excessBatch = rpc.request("batch"), closed = assert.rejects(excessBatch.result, /batch exceeds/);
    wire.receive(Array(129).fill({ jsonrpc: "2.0", id: excessBatch.id, result: null })); await closed;
    assert.equal(timer.count(), 0); assert.equal(rpc.snapshot().disposed, true);
});

test("uncorrelated RPC errors are reported while successful late responses remain harmless", async t => {
    const wire = raw(), timer = clock(), failures: Error[] = [], rpc = new JsonRpcConnection(wire.port, { schedule: timer.schedule, onError: error => { failures.push(error); } });
    t.after(() => rpc.dispose());
    const call = rpc.request("current"), sent = wire.sent.length;
    void call.result.catch(() => {});
    for (const id of [null, "unknown", call.id + 1]) wire.receive({ jsonrpc: "2.0", id, error: { code: -32700, message: "Peer failure", data: { id } } });
    wire.receive({ jsonrpc: "2.0", id: call.id + 1, result: "late" }); await flush();
    assert.equal(failures.length, 3); assert.ok(failures.every(error => error instanceof RpcError && error.code === -32700 && error.message === "Peer failure"));
    assert.equal(wire.sent.length, sent); assert.equal(rpc.snapshot().pendingRequests, 1);
    wire.receive({ jsonrpc: "2.0", id: call.id, result: "current" }); assert.equal(await call.result, "current"); rpc.dispose();
});

test("reference3.17.5 peer interoperates bidirectionally with standard LSP envelopes and out-of-order responses", async t => {
    const wire = channel(), timer = clock(), rpc = new JsonRpcConnection(wire.left, { schedule: timer.schedule }), peer = referencePeer(wire.right);
    t.after(() => { rpc.dispose(); peer.dispose(); }); let initialized = false;
    peer.onRequest(InitializeRequest.type, (params: InitializeParams): InitializeResult => {
        assert.deepEqual(params.capabilities.general?.positionEncodings, ["utf-16"]);
        return { capabilities: { positionEncoding: "utf-16", textDocumentSync: 2 }, serverInfo: { name: "Generic fixture" } };
    }); peer.onNotification(InitializedNotification.type, () => { initialized = true; });
    peer.listen();
    const init = await rpc.request(InitializeRequest.method, { processId: null, rootUri: "host+fixture:scope/document", capabilities: { general: { positionEncodings: ["utf-16"] } } }).result;
    assert.deepEqual(init, { capabilities: { positionEncoding: "utf-16", textDocumentSync: 2 }, serverInfo: { name: "Generic fixture" } }); assert.equal(Object.isFrozen(init), true);
    rpc.notify(InitializedNotification.method, {}); await flush(); assert.equal(initialized, true);
    rpc.onRequest(RegistrationRequest.method, params => { assert.deepEqual(params, { registrations: [{ id: "hover", method: "textDocument/hover", registerOptions: { documentSelector: [{ scheme: "host+fixture" }] } }] }); return null; });
    await peer.sendRequest(RegistrationRequest.type, { registrations: [{ id: "hover", method: "textDocument/hover", registerOptions: { documentSelector: [{ scheme: "host+fixture" }] } }] });
    let release!: (value: JsonValue) => void; peer.onRequest("fixture/slow", () => new Promise<JsonValue>(resolve => { release = resolve; })); peer.onRequest("fixture/fast", () => "second");
    const slow = rpc.request("fixture/slow"), fast = rpc.request("fixture/fast"); assert.equal(await fast.result, "second"); release("first"); assert.equal(await slow.result, "first");
    assert.equal(timer.count(), 0); assert.equal(rpc.snapshot().pendingRequests, 0); rpc.dispose(); peer.dispose(); assert.equal(wire.listeners(), 0);
});

test("outbound cancellation interoperates with the reference peer and late responses cannot retarget another request", async t => {
    const wire = channel(), timer = clock(), rpc = new JsonRpcConnection(wire.left, { schedule: timer.schedule }), peer = referencePeer(wire.right);
    t.after(() => { rpc.dispose(); peer.dispose(); }); let cancelled = false;
    peer.onRequest("fixture/hold", (_params: unknown, token) => new Promise((_resolve, reject) => { token.onCancellationRequested(() => { cancelled = true; reject(new ResponseError(-32800, "Cancelled")); }); })); peer.listen();
    const call = rpc.request("fixture/hold", {}), rejection = assert.rejects(call.result, (e: unknown) => e instanceof RpcError && e.code === -32800);
    await flush(); call.cancel(); await rejection; await flush(); assert.equal(cancelled, true); assert.equal(timer.count(), 0);
    peer.onRequest("fixture/next", () => "new"); assert.equal(await rpc.request("fixture/next").result, "new"); assert.equal(rpc.snapshot().pendingRequests, 0);
});

test("reference-initiated cancellation reaches host handlers and returns a cancellation response", async t => {
    const wire = channel(), timer = clock(), rpc = new JsonRpcConnection(wire.left, { schedule: timer.schedule }), peer = referencePeer(wire.right);
    t.after(() => { rpc.dispose(); peer.dispose(); }); let cancelled = false;
    rpc.onRequest("host/hold", (_params, context) => new Promise((_resolve, reject) => { context.onCancel(() => { cancelled = true; reject(new Error("Stopped")); }); })); peer.listen();
    const token = new CancellationTokenSource(), pending = peer.sendRequest("host/hold", {}, token.token), rejection = assert.rejects(pending, (e: unknown) => e instanceof ResponseError && e.code === -32800);
    await flush(); token.cancel(); await rejection; token.dispose(); assert.equal(cancelled, true); assert.equal(rpc.snapshot().incomingRequests, 0);
});

test("JSON-RPC batches preserve ids, notifications have no responses and malformed input has protocol errors", async () => {
    const wire = raw(), timer = clock(), rpc = new JsonRpcConnection(wire.port, { schedule: timer.schedule }); let notified = 0;
    rpc.onRequest("add", params => { assert.ok(params && typeof params === "object" && "a" in params && "b" in params); return Number(params.a) + Number(params.b); });
    rpc.onNotification("note", () => { notified++; });
    wire.receive([{ jsonrpc: "2.0", id: "sum", method: "add", params: { a: 2, b: 3 } }, { jsonrpc: "2.0", method: "note" }, { jsonrpc: "2.0", id: 9, method: "missing" }, 7]); await flush();
    assert.deepEqual(wire.sent, [[{ jsonrpc: "2.0", id: "sum", result: 5 }, { jsonrpc: "2.0", id: 9, error: { code: -32601, message: "Method not found" } }, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }]]); assert.equal(notified, 1);
    wire.receive([{ jsonrpc: "2.0", method: "note" }]); await flush(); assert.equal(wire.sent.length, 1);
    wire.text("{"); wire.receive([]); wire.receive({ jsonrpc: "2.0", id: 3, method: "add", params: null }); await flush();
    assert.deepEqual(wire.sent.slice(1), [{ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }, { jsonrpc: "2.0", id: 3, error: { code: -32602, message: "Invalid params" } }]); rpc.dispose();
});

test("deadlines, capacity and teardown bound outstanding work, including throwing cleanup callbacks", async () => {
    const wire = raw(), timer = clock(), failures: Error[] = [];
    const rpc = new JsonRpcConnection(wire.port, { schedule: (ms, fn) => { const stop = timer.schedule(ms, fn); return () => { stop(); throw new Error("Host timer cleanup failed"); }; }, maxPending: 2, onError: error => { failures.push(error); } });
    const first = rpc.request("hold"), firstDone = assert.rejects(first.result, (e: unknown) => e instanceof RpcError && e.code === -32098);
    const second = rpc.request("hold"), secondDone = assert.rejects(second.result, (e: unknown) => e instanceof RpcError && e.code === -32098); assert.throws(() => rpc.request("hold"), /Too many/);
    timer.fire(); await Promise.all([firstDone, secondDone]); assert.equal(timer.count(), 0); assert.equal(failures.length, 2);
    const third = rpc.request("hold"), thirdDone = assert.rejects(third.result, /closed/); rpc.dispose(); await thirdDone;
    assert.deepEqual(rpc.snapshot(), { disposed: true, pendingRequests: 0, incomingRequests: 0, requestHandlers: 0, notificationHandlers: 0 }); assert.equal(wire.disposed(), 1); assert.equal(timer.count(), 0);
});

test("cancelled ids and malformed responses cannot resolve fresh requests or leave pending ownership", async () => {
    const wire = raw(), timer = clock(), rpc = new JsonRpcConnection(wire.port, { schedule: timer.schedule });
    const old = rpc.request("old"), oldDone = assert.rejects(old.result, /cancelled/); old.cancel(); await oldDone;
    const next = rpc.request("next"); wire.receive({ jsonrpc: "2.0", id: old.id, result: "late" }); await flush(); assert.equal(rpc.snapshot().pendingRequests, 1);
    wire.receive({ jsonrpc: "2.0", id: next.id, result: "current" }); assert.equal(await next.result, "current");
    const bad = rpc.request("bad"), badDone = assert.rejects(bad.result, /Invalid RPC response/); wire.receive({ jsonrpc: "2.0", id: bad.id, result: null, error: { code: -1, message: "contradiction" } }); await badDone;
    assert.equal(rpc.snapshot().disposed, true); assert.equal(timer.count(), 0); assert.equal(wire.disposed(), 1);
});

test("queued incoming work cannot run after cancellation or connection disposal", async () => {
    const wire = raw(), timer = clock(), rpc = new JsonRpcConnection(wire.port, { schedule: timer.schedule }); let commits = 0;
    rpc.onRequest("host/edit", () => { commits++; return { applied: true }; });
    wire.receive({ jsonrpc: "2.0", id: "cancelled-edit", method: "host/edit" });
    wire.receive({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: "cancelled-edit" } }); await flush();
    assert.equal(commits, 0); assert.deepEqual(wire.sent, [{ jsonrpc: "2.0", id: "cancelled-edit", error: { code: -32800, message: "Request cancelled." } }]);
    wire.receive({ jsonrpc: "2.0", id: "closed-edit", method: "host/edit" }); rpc.dispose(); await flush();
    assert.equal(commits, 0); assert.equal(wire.sent.length, 1); assert.equal(rpc.snapshot().incomingRequests, 0); assert.equal(timer.count(), 0);
    const fresh = raw(), next = new JsonRpcConnection(fresh.port, { schedule: timer.schedule });
    next.onNotification("stop", () => next.dispose()); next.onNotification("stop", () => { commits++; });
    fresh.receive({ jsonrpc: "2.0", method: "stop" }); assert.equal(commits, 0); assert.equal(next.snapshot().notificationHandlers, 0);
});
