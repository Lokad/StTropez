import { JsonRpcConnection, RpcError, LspSession } from "../../src/protocol/index.ts";
import type { JsonValue } from "../../src/protocol/index.ts";
import { TextBuffer } from "../../src/core/text-buffer.ts";
import { openWebSocketTransport } from "../../src/browser/lsp-websocket.ts";
import { mountDocumentation } from "../../src/browser/index.ts";

const url = new URL("/lsp-fixture", location.href); url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
const timers = new Set<number>();
const schedule = (ms: number, callback: () => void) => { const timer = window.setTimeout(() => { timers.delete(timer); callback(); }, ms); timers.add(timer);
    return () => { clearTimeout(timer); timers.delete(timer); }; };
async function connect() { return new JsonRpcConnection(await openWebSocketTransport(url.href), { schedule }); }
async function exercise() {
    const rpc = await connect(); let notice: unknown;
    try {
        rpc.onRequest("host/echo", params => params); rpc.onNotification("fixture/notice", params => { notice = params; });
        const initialization = await rpc.request("initialize", { processId: null, rootUri: null, capabilities: { general: { positionEncodings: ["utf-16"] } } }).result;
        rpc.notify("initialized", {});
        const payload = { uri: "host+fixture:scope/Δ😀", text: "first\r\nΔ😀 é\r\nlast", position: { line: 1, character: 3 } };
        const echoed = await rpc.request("fixture/echo", payload).result, roundtrip = await rpc.request("fixture/roundtrip", payload).result;
        await rpc.request("fixture/notice", payload).result;
        let rejection = 0; try { await rpc.request("fixture/fail").result; } catch (error) { if (!(error instanceof RpcError)) throw error; rejection = error.code; }
        const hold = rpc.request("fixture/hold", {}), held = hold.result.then(() => false, error => error instanceof RpcError && error.code === -32800);
        const before = await rpc.request("fixture/state").result; hold.cancel(); const cancelled = await held, after = await rpc.request("fixture/state").result;
        const pending = rpc.request("fixture/hold", {}), stopped = pending.result.then(() => false, () => true);
        await rpc.request("fixture/state").result; rpc.notify("fixture/disconnect"); const disconnected = await stopped;
        const released = rpc.snapshot();
        const fresh = await connect(); let reconnect: JsonValue;
        try { reconnect = await fresh.request("fixture/echo", { fresh: true }).result; } finally { fresh.dispose(); }
        return { initialization, payload, echoed, roundtrip, notice, rejection, before, after, cancelled, disconnected, released, reconnect, timers: timers.size };
    } finally { rpc.dispose(); }
}
async function binaryRejection() {
    const rpc = await connect(); let reason = "";
    try { const call = rpc.request("fixture/hold", {}); const failed = call.result.then(() => "unexpected result", error => (error as Error).message);
        await rpc.request("fixture/state").result; rpc.notify("fixture/binary"); reason = await failed; return { reason, snapshot: rpc.snapshot(), timers: timers.size };
    } finally { rpc.dispose(); }
}
async function abortOpening() {
    const abort = new AbortController(); const opening = openWebSocketTransport(url.href, { signal: abort.signal }); abort.abort();
    try { await opening; return false; } catch (error) { return error instanceof DOMException && error.name === "AbortError"; }
}
async function sessionJourney(large: boolean) {
    const session = new LspSession({ schedule, connect: context => {
        const abort = new AbortController(), stop = context.onCancel(() => abort.abort());
        return openWebSocketTransport(url.href, { signal: abort.signal }).finally(stop);
    }, features: ["textDocument/hover"], initializationOptions: { fixtureDynamic: true } });
    const uri = "host+fixture://project/scope/Δ%20😀.ts", text = large ? "sample 😀 raw text row\r\n".repeat(100_000) : "a😀\r\nb\rc\n";
    const buffer = TextBuffer.from(text), document = session.bindDocument({ uri, languageId: "fixture", resourceId: "fixture:resource", documentId: "fixture:working", revision: 100, buffer });
    session.onRequest("host/echo", params => params);
    const register = () => session.request("fixture/register", { registrations: [{ id: "hover", method: "textDocument/hover", registerOptions: { documentSelector: [{ scheme: "host+fixture", pattern: "**/*.ts" }] } }] }).result;
    try {
        const opening = performance.now(); await session.connect(); const openMs = performance.now() - opening;
        const before = buffer.readMetrics().sliceUnits, from = large ? buffer.offsetAt(50_000) + 10 : buffer.offsetAt(1) + 1;
        const next = buffer.replace(from, from, "Q\r\n"), started = performance.now(); document.update(100, 107, next); const enqueueMs = performance.now() - started;
        await session.flush();
        const remote = await session.request("fixture/document", { uri, from: Math.max(0, from - 8), to: from + 14 }).result, syncMs = performance.now() - started;
        const boundedReads = { before: buffer.readMetrics().sliceUnits - before, after: next.readMetrics().sliceUnits, exports: buffer.readMetrics().textExports + next.readMetrics().textExports };
        await register(); const available = session.canRequest("textDocument/hover", document);
        const hover = await session.requestDocument("textDocument/hover", document, index => ({ position: index.at(from) })).result;
        await session.request("fixture/unregister", { unregisterations: [{ id: "hover", method: "textDocument/hover" }] }).result;
        const withdrawn = !session.canRequest("textDocument/hover", document), custom = await session.request("fixture/roundtrip", { uri, extension: "host-owned" }).result;
        const hold = session.request("fixture/hold", {}), rejected = hold.result.then(() => false, () => true);
        const disconnected = new Promise<void>(resolve => { const stop = session.state.subscribe(() => { if (session.state.getSnapshot().phase === "disconnected") { stop(); resolve(); } }); });
        session.notify("fixture/disconnect"); await rejected; await disconnected;
        const offline = next.replace(0, 0, "offline\r\n"); document.update(107, 110, offline); await session.connect();
        const reopened = await session.request("fixture/document", { uri, from: 0, to: 20 }).result;
        const fresh = session.state.getSnapshot().registrations.length === 0 && !session.canRequest("textDocument/hover", document);
        await session.shutdown(); session.dispose();
        return { uri, length: next.length, expectedSample: next.slice(Math.max(0, from - 8), Math.min(next.length, from + 14)), remote, boundedReads, available, hover, withdrawn, custom, fresh, reopened,
            expectedReopened: offline.slice(0, 20), ownership: session.snapshotOwnership(), timers: timers.size,
            diagnostic: { openMs, enqueueMs, syncMs, scope: "single document-session action; enqueue is not an input handler or display latency" } };
    } finally { session.dispose(); }
}
const fixture = Object.freeze({ ready: true, exercise, binaryRejection, abortOpening, sessionJourney, mountDocumentation });
window.protocolFixture = fixture; document.getElementById("state")!.textContent = "Ready";
declare global { interface Window { protocolFixture: typeof fixture } }
