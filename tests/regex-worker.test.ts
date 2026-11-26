import test from "node:test";
import assert from "node:assert/strict";
import { regexProtocolVersion as version } from "../src/protocol/regex.ts";
import type { RegexReply } from "../src/protocol/regex.ts";

test("the worker transfers a complete result and reports failure at the captured request", async t => {
    const globals = ["addEventListener", "postMessage"] as const;
    const descriptors = globals.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
    let receive: (event: MessageEvent<unknown>) => void;
    const messages: RegexReply[] = [];
    Object.defineProperty(globalThis, "addEventListener", { configurable: true,
        value: (_type: string, listener: typeof receive) => { receive = listener; } });
    Object.defineProperty(globalThis, "postMessage", { configurable: true, value: (data: RegexReply, options?: StructuredSerializeOptions) => {
        messages.push(structuredClone(data, options));
        if (data.operation !== "regex-error") assert.equal(data.offsets.buffer.byteLength, 0);
    } });
    t.after(() => { for (const [index, name] of globals.entries()) {
        const descriptor = descriptors[index];
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
    } });
    await import("../src/browser/regex-worker.ts");
    const request = { version, id: 5, source: 5, revision: 12, text: "ab", length: 2, pattern: ".", matchCase: true };
    receive!(new MessageEvent("message", { data: request }));
    assert.deepEqual(messages.splice(0), [{ id: 5, revision: 12, version, operation: "regex-matches", offsets: Uint32Array.of(0, 1, 1, 2) }]);
    const matching = t.mock.method(String.prototype, "matchAll", () => { throw new Error("Injected native execution failure"); });
    receive!(new MessageEvent("message", { data: { ...request, source: 6, id: 6 } }));
    matching.mock.restore();
    assert.deepEqual(messages, [{ id: 6, revision: 12, version, operation: "regex-error", invalidPattern: false,
        message: "Regex search failed; editing remains available." }]);
});
