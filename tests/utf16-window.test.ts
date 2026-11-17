import assert from "node:assert/strict";
import test from "node:test";
import { TextBuffer } from "../src/index.ts";
import { readUtf16Window } from "../src/core/utf16.ts";

test("directional windows preserve raw bounds and count successful and failed surrogate peeks", () => {
    const head = "a".repeat(255), tail = "z".repeat(255);
    const cases: readonly (readonly [string, number, number, -1 | 1, number, number, number])[] = [
        [head + "😀!", 0, 258, 1, 0, 257, 257],
        [head + "\ud83d!?", 0, 258, 1, 0, 256, 257],
        [head + "😀!", 0, 256, 1, 0, 256, 256],
        [head + "\ude00!?", 0, 258, 1, 0, 256, 256],
        ["!😀" + tail, 258, 0, -1, 1, 258, 257],
        ["!?\ude00" + tail, 258, 0, -1, 2, 258, 257],
        ["!😀" + tail, 258, 2, -1, 2, 258, 256],
        ["!?\ud83d" + tail, 258, 0, -1, 2, 258, 256],
        ["!😀?", 1, 3, 1, 1, 3, 2],
        ["!😀?", 3, 1, -1, 1, 3, 2],
        ["!😀?", 2, 2, 1, 2, 2, 0],
        ["!😀?", 2, 2, -1, 2, 2, 0],
    ];
    for (const [text, start, bound, direction, from, to, readUnits] of cases) {
        const split = Math.min(256, text.length), buffer = TextBuffer.from(text.slice(0, split)).replace(split, split, text.slice(split));
        for (const source of [text, buffer]) {
            let actualReads = 0, calls = 0;
            const window = readUtf16Window({ slice(a, b) {
                assert.ok(a >= Math.min(start, bound) && b <= Math.max(start, bound));
                assert.ok(b >= a && b - a <= (calls++ ? 1 : 256)); actualReads += b - a;
                return source.slice(a, b);
            } }, start, bound, direction);
            assert.deepEqual(window, { from, to, text: text.slice(from, to), readUnits });
            assert.equal(actualReads, readUnits); assert.ok(calls <= 2);
        }
        assert.equal(buffer.readMetrics().sliceUnits, readUnits); assert.equal(buffer.readMetrics().textExports, 0);
    }
});
