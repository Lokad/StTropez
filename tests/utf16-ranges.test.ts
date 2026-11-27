import assert from "node:assert/strict";
import test from "node:test";
import { TextBuffer } from "../src/index.ts";
import { graphemeBoundaries } from "../src/core/graphemes.ts";


test("heated clipped grapheme windows cannot turn a raw high surrogate into an emoji continuation", () => {
    for (let i = 0; i < 5000; i++) for (const source of ["👩‍💻", TextBuffer.from("👩‍💻")]) {
        assert.deepEqual(graphemeBoundaries(source.slice(0, 4)), [0, 3, 4]);
    }
});
