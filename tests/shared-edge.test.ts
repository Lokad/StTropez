import assert from "node:assert/strict";
import test from "node:test";
import { TextBuffer } from "../src/index.ts";

const last = (values: Iterable<number>) => [...values].at(-1) ?? 0;
test("shared edges checkpoint structural descents and unproved leaves without advancing the proof", () => {
    const a = TextBuffer.from("x".repeat(2000)), b = a.replace(1000, 1000, "y".repeat(65)).replace(1000, 1065, "");
    for (const side of ["start", "end"] as const) {
        assert.deepEqual([...a.sharedEdge(b, side)], [0, 1000, 2000]);
        assert.deepEqual([...a.sharedEdge(TextBuffer.from("x".repeat(2000)), side)], [0]);
        assert.deepEqual([...a.sharedEdge(a, side)], [2000]);
    }
    const iterator = a.sharedEdge(b, "start")[Symbol.iterator]();
    assert.deepEqual(iterator.next(), { value: 0, done: false }); iterator.return?.();
    assert.equal(iterator.next().done, true); assert.deepEqual(a.readMetrics(), { textExports: 0, sliceUnits: 0 });
});

test("shared edges prove owned spans without text reads, including split backing and reversed ranges", () => {
    const original = "a\r\n😀é\n".repeat(10000), a = TextBuffer.from(original), b = a.replace(30001, 30003, "changed");
    assert.equal(last(a.sharedEdge(b, "start")), 30001);
    assert.equal(last(a.sharedEdge(b, "end")), a.length - 30003);
    assert.equal(last(a.sharedEdge(a, "start")), a.length);
    assert.equal(last(a.sharedEdge(TextBuffer.from(original), "start")), 0);
    assert.equal(last(a.sharedEdge(b, "end", { from: 30003, to: 40000, otherFrom: 30008, otherTo: 40005 })), 9997);
    assert.equal(a.readMetrics().sliceUnits, 0); assert.equal(a.readMetrics().textExports, 0);
    const range = { from: 0, to: 20, otherFrom: 0, otherTo: 20 }, captured = a.sharedEdge(a, "start", range);
    range.to = 0; assert.equal(last(captured), 20);
    assert.throws(() => a.sharedEdge(b, "start", { from: -1, to: 0, otherFrom: 0, otherTo: 0 }), RangeError);
});

test("fragmented shared-edge proofs remain exact through edits, balancing, partial spans and cancellation", () => {
    let text = "0123\r\n😀é\n".repeat(200), buffer = TextBuffer.from(text), seed = 9321;
    const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
    for (let iteration = 0; iteration < 600; iteration++) {
        const from = random(text.length + 1), to = Math.min(text.length, from + random(5)), insert = ["x", "\r\n", "", "😀", "é"][random(5)]!;
        const next = buffer.replace(from, to, insert), nextText = text.slice(0, from) + insert + text.slice(to);
        for (const side of ["start", "end"] as const) {
            const af = random(text.length + 1), at = af + random(text.length - af + 1);
            const bf = random(nextText.length + 1), bt = bf + random(nextText.length - bf + 1);
            for (const range of [{ from: 0, to: text.length, otherFrom: 0, otherTo: nextText.length }, { from: af, to: at, otherFrom: bf, otherTo: bt }]) {
                let prior = 0;
                for (const count of buffer.sharedEdge(next, side, range)) {
                    assert.ok(count >= prior && count <= Math.min(range.to - range.from, range.otherTo - range.otherFrom)); prior = count;
                    assert.equal(side === "start" ? text.slice(range.from, range.from + count) : text.slice(range.to - count, range.to),
                        side === "start" ? nextText.slice(range.otherFrom, range.otherFrom + count) : nextText.slice(range.otherTo - count, range.otherTo));
                }
            }
        }
        const cursor = buffer.sharedEdge(next, "end")[Symbol.iterator](); cursor.next(); cursor.return?.();
        buffer = next; text = nextText;
    }
});
