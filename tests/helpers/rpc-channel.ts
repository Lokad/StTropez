import assert from "node:assert/strict";
import type { RpcTransport } from "../../src/protocol/json-rpc.ts";

/** A duplex transport with microtask delivery and one subscriber per endpoint. */
export function channel() {
    type Listener = Parameters<RpcTransport["subscribe"]>[0];
    const listeners: (Listener | undefined)[] = [undefined, undefined];
    const messages: unknown[][] = [[], []];
    let closed = false;
    const ports = [0, 1].map(index => Object.freeze({
        send: (text: string) => {
            if (closed) throw new Error("Closed transport");
            messages[index]!.push(JSON.parse(text));
            queueMicrotask(() => { if (!closed) listeners[1 - index]?.message(text); });
        },
        subscribe: (listener: Listener) => {
            assert.equal(listeners[index], undefined);
            listeners[index] = listener;
            return () => { if (listeners[index] === listener) listeners[index] = undefined; };
        },
        dispose: () => {
            if (closed) return;
            closed = true;
            for (const listener of listeners) listener?.close(new Error("Closed transport"));
            listeners.fill(undefined);
        },
    } satisfies RpcTransport));
    return { left: ports[0]!, right: ports[1]!, messages, listeners: () => listeners.filter(Boolean).length };
}
