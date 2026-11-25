import assert from "node:assert/strict";
import test from "node:test";
import { copyCaretLines, planClipboardPaste } from "../src/core/clipboard-edits.ts";
import { TextBuffer } from "../src/index.ts";
import { createSelectionSet } from "../src/core/selections.ts";

test("a cut ending at EOF takes the separator before the last group, including a trailing empty row", () => {
    for (const [source, offsets, copied, remainder] of [
        ["a\r\nb\nc\r\nd", [3, 8], "b\nd\r\n", "a\r\nc"],
        ["a\r\nb\nc", [3, 5], "b\nc\n", "a"],
        ["a\r\n", [3], "\r\n", "a"],
    ] as const) {
        const buffer = TextBuffer.from(source), carets = createSelectionSet(buffer.length, offsets.map(head => ({ anchor: head, head })));
        const cut = copyCaretLines(buffer, carets, true);
        assert.equal(cut.text, copied); assert.equal(buffer.apply(cut.edits).buffer.text(), remainder);
    }
});

test("only tagged lines paste above carets and retain each original column", () => {
    const buffer = TextBuffer.from("a\r\nb"), carets = createSelectionSet(buffer.length, [
        { anchor: 0, head: 0, anchorAffinity: "before", headAffinity: "before" }, { anchor: 4, head: 4 },
    ]);
    const insert = (text: string, whole: boolean) => {
        const plan = planClipboardPaste(buffer, carets, text, whole, false);
        return [buffer.apply(plan.edits).buffer.text(), plan.selectionSet.ranges.map(r => r.head)];
    };
    assert.deepEqual(insert("X\nY\n", true), ["X\r\na\r\nY\r\nb", [3, 10]]);
    assert.deepEqual(insert("X\nY\n", false), ["Xa\r\nbY", [1, 6]]);
    assert.deepEqual(insert("X\r\nY\r", false), ["Xa\r\nbY", [1, 6]]);
    assert.deepEqual(insert("X\n", false), ["Xa\r\nb", [1, 5]]);
    assert.deepEqual(insert("X\nY\n\n", false), ["X\r\nY\r\n\r\na\r\nbX\r\nY\r\n\r\n", [8, 20]]);
});
