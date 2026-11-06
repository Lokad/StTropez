import test from "node:test";
import assert from "node:assert/strict";
import { captureNativeInsertion, resolveNativeInsertion } from "../src/browser/input-target.ts";

test("native insertion keeps the captured caret or selected range through repeated text", () => {
    for (const c of [
        { before: "abconst", from: 2, to: 2, data: "c", after: "abcconst", end: 3 },
        { before: "xxxx", from: 1, to: 1, data: "x", after: "xxxxx", end: 2 },
        { before: "abc", from: 1, to: 2, data: "b", after: "abc", end: 2 },
        { before: "ab😀cd", from: 2, to: 4, data: "😀", after: "ab😀cd", end: 4 },
    ]) {
        const target = captureNativeInsertion({ value: c.before, selectionStart: c.from, selectionEnd: c.to }, "insertText", c.data)!;
        assert.ok(Object.isFrozen(target));
        assert.deepEqual(resolveNativeInsertion(target, { value: c.after, selectionStart: c.end, selectionEnd: c.end }, "insertText"), { from: c.from, to: c.to, insert: c.data });
    }
});

test("target validation declines unrelated rewrites, changed types and noncollapsed resulting selections", () => {
    const target = captureNativeInsertion({ value: "prefix suffix", selectionStart: 7, selectionEnd: 7 }, "insertText", "x")!;
    for (const value of ["PREFIX xsuffix", "prefix xsuffiX", "prefix ysuffix", "short"]) assert.equal(resolveNativeInsertion(target, { value, selectionStart: 8, selectionEnd: 8 }, "insertText"), undefined);
    assert.equal(resolveNativeInsertion(target, { value: "prefix xsuffix", selectionStart: 7, selectionEnd: 8 }, "insertText"), undefined);
    assert.equal(resolveNativeInsertion(target, { value: "prefix xsuffix", selectionStart: 8, selectionEnd: 8 }, "insertFromPaste"), undefined);
    assert.equal(captureNativeInsertion({ value: "", selectionStart: 0, selectionEnd: 0 }, "insertFromComposition", "x"), undefined);
    const newline = captureNativeInsertion({ value: "aa", selectionStart: 1, selectionEnd: 1 }, "insertLineBreak", null)!;
    assert.deepEqual(resolveNativeInsertion(newline, { value: "a\na", selectionStart: 2, selectionEnd: 2 }, "insertLineBreak"), { from: 1, to: 1, insert: "\n" });
});
