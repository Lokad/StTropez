import test from "node:test";
import assert from "node:assert/strict";
import { regexProtocolVersion } from "../src/browser/regex-session.ts";

test("worker execution failure retains its capture identity, releases it and accepts a fresh search", async t => {
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
    send("regex-start", { version: regexProtocolVersion, source: 1, length: 0, pattern: ".", matchCase: true }); messages.length = 0;
    const matching = t.mock.method(String.prototype, "matchAll", () => { throw new Error("Injected native execution failure"); });
    send("regex-run"); matching.mock.restore();
    assert.deepEqual(messages, [{ operation: "regex-error", id: 5, revision: 12, message: "Regex search failed; editing remains available." }]);
    messages.length = 0; send("regex-run"); send("regex-continue"); assert.deepEqual(messages, []);
    send("regex-start", { version: regexProtocolVersion, source: 2, id: 6, length: 0, pattern: ".", matchCase: true }); messages.length = 0;
    send("regex-run", { id: 6 }); assert.deepEqual(messages, [{ operation: "regex-done", id: 6, revision: 12, count: 0 }]);
});
