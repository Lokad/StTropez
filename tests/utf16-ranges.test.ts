import assert from "node:assert/strict";
import test from "node:test";
import { TextBuffer } from "../src/index.ts";
import { createGraphemeCursor } from "../src/kernels/index.ts";


test("heated clipped grapheme windows cannot turn a raw high surrogate into an emoji continuation", () => {
    for (let i = 0; i < 5000; i++) for (const source of ["👩‍💻", TextBuffer.from("👩‍💻")]) {
        const cursor = createGraphemeCursor(source, { from: 0, to: 4 }); let p = cursor.next(); while (p.status === "running") p = cursor.next(); assert.deepEqual(p.result!.boundaries(), [0, 3, 4]); assert.equal(p.scannedUnits, 4); cursor.dispose();
    }
});
