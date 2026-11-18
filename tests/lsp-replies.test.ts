import test from "node:test";
import assert from "node:assert/strict";
import type { Page, WebSocketRoute } from "@playwright/test";
import { holdLspReplies } from "./helpers/lsp-replies.ts";

test("held LSP replies and cancellation belong to their connection and end at release", async () => {
    let route!: (socket: WebSocketRoute) => void, fences = 0;
    const page = {
        async routeWebSocket(_url: string, handler: typeof route) { route = handler; },
        async evaluate() { fences++; },
    } as unknown as Page;
    const held = await holdLspReplies(page, "codeAction/resolve");
    const connection = () => {
        let outgoing!: (message: string) => void, incoming!: (message: string) => void;
        const received: string[] = [], forwarded: string[] = [];
        const server = { onMessage: (handler: typeof incoming) => { incoming = handler; }, send: (message: string) => { forwarded.push(message); } };
        route({ connectToServer: () => server, onMessage: (handler: typeof outgoing) => { outgoing = handler; },
            send: (message: string) => { received.push(message); } } as unknown as WebSocketRoute);
        return { request: (value: unknown) => outgoing(JSON.stringify(value)), response: (value: unknown) => incoming(JSON.stringify(value)), received, forwarded };
    };
    const first = connection(), second = connection(), request = { jsonrpc: "2.0", id: 7, method: "codeAction/resolve" };
    const reply = (origin: string) => JSON.stringify({ jsonrpc: "2.0", id: 7, result: { origin } });
    const cancel = { jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 7 } };
    held.hold(); first.request(request); first.response(JSON.parse(reply("first")));
    assert.equal(held.waiting(), true); assert.deepEqual(first.received, []);
    second.request(request); second.request(cancel);
    assert.equal(held.cancelled(), false);
    second.response(JSON.parse(reply("second")));
    assert.deepEqual(second.received, [reply("second")]); assert.deepEqual(first.received, []);
    first.request(cancel); assert.equal(held.cancelled(), true);
    await held.release();
    assert.deepEqual(first.received, [reply("first")]); assert.deepEqual(second.received, [reply("second")]);
    assert.equal(held.waiting(), false); assert.equal(fences, 1);
    first.request(request); first.response(JSON.parse(reply("reused")));
    assert.deepEqual(first.received, [reply("first"), reply("reused")]); assert.equal(held.waiting(), false);
    assert.deepEqual(first.forwarded, [request, cancel, request].map(value => JSON.stringify(value)));
    assert.deepEqual(second.forwarded, [request, cancel].map(value => JSON.stringify(value)));
});
