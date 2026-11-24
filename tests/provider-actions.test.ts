import test from "node:test";
import assert from "node:assert/strict";
import { TextBuffer } from "../src/index.ts";
import { ModuleActionCursor, validateActionInput, validateActionResult } from "../fixtures/language/actions.ts";
const capture = (text: string) => validateActionInput({ operation: "action-start", id: 1, document: "source", revision: 3, length: text.length, from: 0, to: Math.min(5, text.length), module: "sample-utils", delay: 0 });
function scan(text: string) { const input = capture(text), buffer = TextBuffer.from(text), cursor = new ModuleActionCursor(input, buffer); let previous = 0;
    for (;;) { const step = cursor.next(); assert.ok(step.work >= previous && step.work - previous <= 16384); previous = step.work; if (step.result) { assert.equal(step.work, text.length); return { input, buffer, result: step.result }; } }
}
test("module actions reuse bounded import policy with raw BOM/CRLF, Unicode, LF fallback and idempotent disabled results", () => {
    for (const text of ["", "const café = '😀';", "\ufeffconst café = '😀';\r\n" + "x".repeat(32_768), "// prefix\nsource;"]) {
        const x = scan(text), edit = x.result.action.edits[0]!.edits[0]!, ending = text.includes("\r\n") ? "\r\n" : "\n", from = text.startsWith("\ufeff") ? 1 : 0;
        assert.deepEqual(edit, { from, to: from, insert: 'import "sample-utils";' + ending }); assert.equal(x.buffer.readMetrics().textExports, 0); assert.ok(Object.isFrozen(x.result.action.edits));
        const inserted = text.slice(0, from) + edit.insert + text.slice(from), again = scan(inserted); assert.deepEqual(again.result.action.edits, []); assert.match(again.result.action.disabled!, /already present/);
    }
});
test("action result validation rejects incomplete, wrong identity and late invalid edits before exposing any target", () => {
    const x = scan("alpha\r\nbeta"), action = x.result.action;
    for (const result of [{ ...x.result, complete: false }, { ...x.result, module: "other" }, { ...x.result, revision: 4 }, { ...x.result, from: 1 },
        { ...x.result, action: { ...action, id: "other" } }, { ...x.result, action: { ...action, disabled: "disabled" } }, { ...x.result, action: { ...action, edits: [] } },
        { ...x.result, action: { ...action, edits: [{ document: "source", revision: 3, edits: [{ from: 0, to: 0, insert: "valid" }, { from: -1, to: 0, insert: "late invalid" }] }] } },
        { ...x.result, action: { ...action, edits: [{ document: "unknown", revision: 3, edits: [{ from: 0, to: 0, insert: "wrong" }] }] } }]) assert.throws(() => validateActionResult(result, x.input));
    assert.throws(() => validateActionResult({ ...x.result, action: { ...action, edits: [{ document: "source", revision: 3, edits: [{ from: 0, to: 0, insert: "x".repeat(16385) }] }] } }, x.input));
    const safe = validateActionResult({ ...x.result, action: { ...action, title: '<img onerror="execute()">' } }, x.input); assert.match(safe.action.title, /<img/);
});
test("action input captures a bounded document, range and module without accepting commands or malformed fields", () => {
    const input = capture("source"); for (const change of [{ module: "" }, { module: "a\n" }, { module: "x".repeat(65) }, { module: "<img>" }, { length: 16777217 }, { document: "" }, { revision: -1 }, { from: -1 }, { to: 100 }, { id: 0 }, { fault: "command" }, { delay: NaN }]) assert.throws(() => validateActionInput({ ...input, ...change }));
});
