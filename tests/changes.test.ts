import test from "node:test";
import assert from "node:assert/strict";
import { textDifference } from "../src/index.ts";
import { applyTextEdits } from "../src/core/changes.ts";
import type { TextEdit } from "../src/index.ts";

test("whole-text differences preserve exact shared UTF-16 boundaries in one immutable replacement", () => {
    const cases: readonly [string, string, TextEdit | null][] = [
        ["", "", null], ["same\r\n😀", "same\r\n😀", null],
        ["", "abc", { from: 0, to: 0, insert: "abc" }],
        ["abc", "", { from: 0, to: 3, insert: "" }],
        ["abc", "Xabc", { from: 0, to: 0, insert: "X" }],
        ["abc", "abcX", { from: 3, to: 3, insert: "X" }],
        ["abc", "ac", { from: 1, to: 2, insert: "" }],
        ["abc", "xyz", { from: 0, to: 3, insert: "xyz" }],
        ["aaaa", "aaa", { from: 3, to: 4, insert: "" }],
        ["aaa", "aaaa", { from: 3, to: 3, insert: "a" }],
        ["a\r\nb", "a\nb", { from: 1, to: 2, insert: "" }],
        ["😀", "😁", { from: 1, to: 2, insert: "\ude01" }],
        ["a\ud800b", "a\udfffb", { from: 1, to: 2, insert: "\udfff" }],
        ["e\u0301", "e", { from: 1, to: 2, insert: "" }],
        ["abcXYZdef", "aBcXYZdEf", { from: 1, to: 8, insert: "BcXYZdE" }],
    ];
    for (const [before, after, expected] of cases) {
        const edit = textDifference(before, after), context = JSON.stringify({ before, after });
        assert.deepEqual(edit, expected, context);
        assert.equal(applyTextEdits(before, edit ? [edit] : []), after, context);
        if (edit) assert.ok(Object.isFrozen(edit), context);
    }
});
