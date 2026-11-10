import { JsonRpcConnection, RpcError } from "../../src/protocol/index.ts";
import type { JsonValue } from "../../src/protocol/index.ts";
import { openWebSocketTransport } from "../../src/browser/lsp-websocket.ts";

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
const fixture = Object.freeze({ ready: true, exercise, binaryRejection, abortOpening });
window.protocolFixture = fixture; document.getElementById("state")!.textContent = "Ready";
declare global { interface Window { protocolFixture: typeof fixture } }
