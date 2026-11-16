import test from "node:test";
import assert from "node:assert/strict";
import { regexProtocolVersion } from "../src/protocol/regex.ts";

test("worker failures retain capture identity and bounded wire decoding preserves stale continuation guards", async t => {
    const messages: unknown[] = [], globals = ["addEventListener", "postMessage"] as const;
    const descriptors = globals.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
    let receive: (event: MessageEvent<unknown>) => void;
    Object.defineProperty(globalThis, "addEventListener", { configurable: true, value: (_type: string, listener: typeof receive) => { receive = listener; } });
    Object.defineProperty(globalThis, "postMessage", { configurable: true, value: (data: string) => messages.push(JSON.parse(data)) });
    t.after(() => { for (const [index, name] of globals.entries()) {
        const descriptor = descriptors[index]; if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    } });
    await import("../src/browser/regex-worker.ts");
    const send = (operation: string, fields: Record<string, unknown> = {}) => receive(new MessageEvent("message", { data: JSON.stringify({ operation, id: 5, revision: 12, ...fields }) }));
    const first = (): unknown => messages[0];
    send("regex-start", { version: regexProtocolVersion, source: 1, length: 0, pattern: ".", matchCase: true }); messages.length = 0;
    const matching = t.mock.method(String.prototype, "matchAll", () => { throw new Error("Injected native execution failure"); });
    send("regex-run"); matching.mock.restore();
    assert.deepEqual(messages, [{ operation: "regex-error", id: 5, revision: 12, message: "Regex search failed; editing remains available." }]);
    messages.length = 0; send("regex-run"); send("regex-continue"); assert.deepEqual(messages, []);
    send("regex-start", { version: regexProtocolVersion, source: 2, id: 6, length: 0, pattern: ".", matchCase: true }); messages.length = 0;
    send("regex-run", { id: 6 }); assert.deepEqual(messages, [{ operation: "regex-done", id: 6, revision: 12, count: 0 }]);

    send("regex-start", { version: regexProtocolVersion, source: 3, id: 7, length: 600, pattern: "x", matchCase: true });
    send("regex-chunk", { id: 7, from: 0, text: "x".repeat(600) }); messages.length = 0;
    send("regex-run", { id: 7 }); assert.equal((first() as { matches: unknown[] }).matches.length, 512); messages.length = 0;
    send("regex-continue", { id: 8 }); send("regex-chunk", { id: 8, text: null }); assert.deepEqual(messages, []);
    send("regex-continue", { id: 7 }); assert.equal((first() as { matches: unknown[] }).matches.length, 88); messages.length = 0;
    send("regex-continue", { id: 7 }); assert.deepEqual(messages, [{ operation: "regex-done", id: 7, revision: 12, count: 600 }]);

    send("regex-start", { version: regexProtocolVersion, source: 4, id: 8, length: 1, pattern: "x", matchCase: true }); messages.length = 0;
    const chunk = JSON.stringify({ operation: "regex-chunk", id: 8, revision: 12, from: 0, text: "x" });
    receive!(new MessageEvent("message", { data: chunk.padEnd(262144, " ") }));
    assert.deepEqual(messages, [{ operation: "regex-progress", id: 8, revision: 12, received: 1 }]); messages.length = 0;
    const run = JSON.stringify({ operation: "regex-run", id: 8, revision: 12 });
    receive!(new MessageEvent("message", { data: run.padEnd(262145, " ") }));
    assert.deepEqual(messages, [{ operation: "regex-error", id: 8, revision: 12, message: "Malformed regex request." }]);
    messages.length = 0; send("regex-run", { id: 8 }); send("regex-continue", { id: 8 }); assert.deepEqual(messages, []);
});
