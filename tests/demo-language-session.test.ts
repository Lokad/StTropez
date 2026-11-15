import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { createDemoLanguageSession } from "../examples/demo/language-session.ts";
import { BrowserLanguageService } from "../examples/demo/browser-language-service.ts";

const flush = () => setImmediate();
function harness(provider: Parameters<typeof createDemoLanguageSession>[0]) {
    const tasks = new Set<() => void>(), replies: { id?: number; result?: unknown; error?: { code: number } }[] = [], failures: Error[] = [];
    const session = createDemoLanguageSession(provider, (_ms, run) => { tasks.add(run); return () => { tasks.delete(run); }; },
        text => { const result = JSON.parse(text); replies.push(...(Array.isArray(result) ? result : [result])); }, error => failures.push(error));
    return { ...session, tasks, replies, failures, send: (value: unknown) => session.message(JSON.stringify(value)),
        step: async () => { const run = tasks.values().next().value; assert.ok(run, "expected queued work"); tasks.delete(run); run(); await flush(); },
        drain: async () => { let count = 0; while (tasks.size) { assert.ok(++count <= 300); const run = tasks.values().next().value!; tasks.delete(run); run(); await flush(); } } };
}
const request = (id: number, method = "sttropez/diagnostics", params: unknown = {}) => ({ jsonrpc: "2.0", id, method, params });
const notice = (method: string, params: unknown = {}) => ({ jsonrpc: "2.0", method, params });

test("worker requests cancelled in a later message skip compiler work and release their scheduled turn", async () => {
    let calls = 0, disposed = 0;
    const session = harness({ request: () => { calls++; return null; }, notify: () => {}, dispose: () => { disposed++; } });
    for (let id = 1; id <= 40; id++) session.send(request(id));
    await flush(); assert.equal(calls, 0, "compiler work must wait for a cancellable task turn");
    for (let id = 1; id <= 40; id++) session.send(notice("$/cancelRequest", { id }));
    await flush(); assert.equal(session.tasks.size, 0); assert.equal(calls, 0);
    assert.equal(session.replies.length, 40); assert.ok(session.replies.every(reply => reply.error?.code === -32800));
    session.send(request(41)); await flush(); await session.step(); assert.equal(calls, 1);
    session.send(request(42)); await flush(); session.dispose(); await flush();
    assert.equal(calls, 1); assert.equal(disposed, 1); assert.equal(session.tasks.size, 0); assert.deepEqual(session.failures, []);
});

test("worker document notifications stay ordered with captured requests, including a mixed RPC batch", async () => {
    const uri = "file:///sttropez/main.ts", provider = new BrowserLanguageService({}, ["main.ts"]), session = harness(provider);
    session.send(notice("textDocument/didOpen", { textDocument: { uri, languageId: "typescript", version: 1, text: "one" } }));
    await flush(); await session.drain();
    session.send([request(1, "sttropez/readDocument", { uri }), notice("textDocument/didChange", { textDocument: { uri, version: 2 }, contentChanges: [{ text: "two" }] }),
        request(2, "sttropez/readDocument", { uri }), notice("textDocument/didChange", { textDocument: { uri, version: 3 }, contentChanges: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, text: "three" }] }),
        request(3, "sttropez/readDocument", { uri })]);
    await flush(); await session.drain();
    assert.deepEqual(session.replies.map(reply => reply.result), [{ uri, text: "one" }, { uri, text: "two" }, { uri, text: "three" }]);
    assert.deepEqual(session.failures, []); session.dispose();
});

test("worker queue overflow and notification errors close once without silently losing synchronization", async () => {
    for (const overflow of [true, false]) {
        let calls = 0, disposed = 0;
        const session = harness({ request: () => { calls++; return null; }, notify: () => { calls++; if (!overflow) throw new Error("Invalid document change"); }, dispose: () => { disposed++; } });
        for (let i = 0; i < (overflow ? 257 : 1); i++) session.send(notice("textDocument/didChange"));
        await flush(); await session.drain();
        assert.equal(session.failures.length, 1); assert.match(session.failures[0]!.message, overflow ? /queue.*full/i : /Invalid document/);
        assert.equal(calls, overflow ? 0 : 1); assert.equal(disposed, 1); assert.equal(session.tasks.size, 0);
        session.send(request(1)); await flush(); assert.equal(session.tasks.size, 0); session.dispose(); assert.equal(disposed, 1);
    }
});
