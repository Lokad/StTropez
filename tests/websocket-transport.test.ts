import test from "node:test";
import assert from "node:assert/strict";
import { openWebSocketTransport } from "../src/browser/lsp-websocket.ts";
import type { WebSocketTransportOptions } from "../src/browser/lsp-websocket.ts";

class Socket {
    readyState = 0; bufferedAmount = 0; sent: string[] = []; closed: number[] = [];
    listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
    onSend: (() => void) | undefined;
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        const set = this.listeners.get(type) ?? new Set(); set.add(listener); this.listeners.set(type, set);
    }
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        const set = this.listeners.get(type); set?.delete(listener); if (!set?.size) this.listeners.delete(type);
    }
    emit(type: string) { const event = new Event(type); for (const listener of [...this.listeners.get(type) ?? []]) {
        if (typeof listener === "function") listener(event); else listener.handleEvent(event);
    } }
    open() { this.readyState = 1; this.emit("open"); }
    send(text: string) { this.sent.push(text); this.onSend?.(); }
    close(code: number) {
        if (code !== 1000 && (code < 3000 || code > 4999)) throw new DOMException("Invalid browser close code", "InvalidAccessError");
        this.closed.push(code); this.readyState = 3; this.emit("close");
    }
    create = () => this as unknown as WebSocket;
}

test("pre-protocol text is captured and sent once before the transport can send JSON-RPC", async () => {
    for (const ready of [false, true]) for (const preProtocolMessage of [undefined, "", "host handshake 😀"]) {
        const socket = new Socket(); if (ready) socket.readyState = 1;
        const options = { create: socket.create, ...(preProtocolMessage === undefined ? {} : { preProtocolMessage }) };
        const opening = openWebSocketTransport("ws://fixture", options);
        options.preProtocolMessage = "changed after opening";
        if (!ready) { assert.deepEqual(socket.sent, []); socket.open(); } socket.emit("open");
        const transport = await opening; let closed = 0;
        const stop = transport.subscribe({ message: () => {}, close: () => { closed++; } });
        transport.send('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
        assert.deepEqual(socket.sent, [...(preProtocolMessage === undefined ? [] : [preProtocolMessage]), '{"jsonrpc":"2.0","id":1,"method":"initialize"}']);
        transport.dispose(); transport.dispose(); stop(); assert.equal(closed, 1); assert.deepEqual(socket.closed, [1000]); assert.equal(socket.listeners.size, 0);
    }
});

test("pre-protocol validation and backpressure reject opening without leaking an owned socket", async () => {
    let created = 0; const create = () => { created++; return new Socket().create(); };
    for (const preProtocolMessage of [null, {}, 42]) await assert.rejects(openWebSocketTransport("ws://fixture", { create, preProtocolMessage } as unknown as WebSocketTransportOptions), TypeError);
    await assert.rejects(openWebSocketTransport("ws://fixture", { create, preProtocolMessage: "1234", maxMessageUnits: 3 }), RangeError);
    await assert.rejects(openWebSocketTransport("ws://fixture", { create, preProtocolMessage: "界", maxBufferedBytes: 2 }), RangeError);
    assert.equal(created, 0);
    const socket = new Socket(); socket.bufferedAmount = 2;
    const opening = openWebSocketTransport("ws://fixture", { create: socket.create, preProtocolMessage: "界", maxBufferedBytes: 4 });
    const rejected = assert.rejects(opening, /message\/buffer limit/); socket.open(); await rejected;
    assert.deepEqual(socket.sent, []); assert.deepEqual(socket.closed, [4009]); assert.equal(socket.listeners.size, 0);
});

test("pre-protocol send failure, cancellation and opening timeout release the pending connection", async t => {
    for (const outcome of ["throw", "cancel", "close"] as const) {
        const socket = new Socket(), abort = new AbortController();
        socket.onSend = () => { if (outcome === "throw") throw new Error("Fixture send failed"); if (outcome === "cancel") abort.abort(); else socket.close(1000); };
        const opening = openWebSocketTransport("ws://fixture", { create: socket.create, signal: abort.signal, preProtocolMessage: "host handshake" });
        const rejected = assert.rejects(opening); socket.open(); await rejected;
        assert.deepEqual(socket.sent, ["host handshake"]); assert.equal(socket.listeners.size, 0); assert.equal(socket.closed.length, 1);
    }
    const socket = new Socket(), abort = new AbortController();
    const opening = openWebSocketTransport("ws://fixture", { create: socket.create, signal: abort.signal, preProtocolMessage: "not sent" });
    const rejected = assert.rejects(opening, { name: "AbortError" }); abort.abort(); socket.open(); await rejected;
    assert.deepEqual(socket.sent, []); assert.equal(socket.listeners.size, 0);
    await assert.rejects(openWebSocketTransport("ws://fixture", { signal: abort.signal, create: () => { throw new Error("Must not create a socket"); }, preProtocolMessage: "not sent" }), { name: "AbortError" });
    t.mock.timers.enable({ apis: ["setTimeout"] }); const timed = new Socket();
    const timeout = openWebSocketTransport("ws://fixture", { create: timed.create, preProtocolMessage: "not sent", openTimeoutMs: 10 });
    const expired = assert.rejects(timeout, /opening timed out/); t.mock.timers.tick(10); await expired;
    assert.deepEqual(timed.sent, []); assert.equal(timed.listeners.size, 0); assert.deepEqual(timed.closed, [1000]);
});
