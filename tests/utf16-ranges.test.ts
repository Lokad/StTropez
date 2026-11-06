import assert from "node:assert/strict";
import test from "node:test";
import { TextBuffer, normalizeText, createGraphemeCursor, BidiCursor } from "../src/index.ts";

test("heated normalization keeps clipped surrogate provenance inside every requested form/range", () => {
    for (let sample = 0; sample < 5000; sample++) {
        const text = "AᅡÅﬁ́Ǻ̧\nᆨ‍कB\r𖵣̧\nAᅡ😀्́" + "x".repeat(sample % 9), buffer = TextBuffer.from(text), end = text.indexOf("😀") + 1, start = sample % 7;
        for (const form of ["none", "NFC", "NFD", "NFKC", "NFKD"] as const) { const result = normalizeText(buffer, { from: start, to: end, form }), last = result.at(result.length - 1);
            assert.equal(last.codePoint, 0xd83d); assert.deepEqual(last.sources, [{ from: end - 1, to: end }]);
            for (let i = 0; i < result.length; i++) for (const source of result.at(i).sources) assert.ok(source.from >= start && source.to <= end);
        }
    }
});

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
