import assert from "node:assert/strict";
import test from "node:test";
import { TextBuffer, createGraphemeCursor, BidiCursor } from "../src/index.ts";


test("heated clipped grapheme windows cannot turn a raw high surrogate into an emoji continuation", () => {
    for (let i = 0; i < 5000; i++) for (const source of ["👩‍💻", TextBuffer.from("👩‍💻")]) {
        const cursor = createGraphemeCursor(source, { from: 0, to: 4 }); let p = cursor.next(); while (p.status === "running") p = cursor.next(); assert.deepEqual(p.result!.boundaries(), [0, 3, 4]); assert.equal(p.scannedUnits, 4); cursor.dispose();
    }
});

test("heated clipped bidi windows retain the raw surrogate's class and UTF16 extent", () => {
    for (let i = 0; i < 5000; i++) for (const source of ["א😀", TextBuffer.from("א😀")]) {
        const cursor = new BidiCursor(source, { from: 0, to: 2, direction: "rtl" }); let p = cursor.next(); while (p.status === "running") p = cursor.next(); assert.equal(p.result!.to, 2); assert.equal(p.result!.levelAt(1), 2); assert.equal(p.scannedUnits, 2); cursor.dispose();
    }
});
