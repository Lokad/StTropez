import { bufferReads } from "./buffer-reads.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { TextBuffer } from "../src/index.ts";
import { graphemeBoundaries, pointAtBoundaries } from "../src/core/graphemes.ts";
import { defaultIgnorable } from "../src/core/default-ignorable.ts";
const fixture = async (name: string) => gunzipSync(await readFile(new URL(`fixtures/graphemes/${name}.txt.gz`, import.meta.url))).toString("utf8");
const records = (text: string) => text.trim().split(/\r?\n/).map(line => line.split(";").map(v => v.trim()));
const interval = (text: string) => { const values = text.split("..").map(v => parseInt(v, 16)); return [values[0]!, values[1] ?? values[0]!] as const; };
test("warning characters retain the reviewed default-ignorable property", async () => {
    const expected = new Uint8Array(0x110000);
    for (const [range, property] of records(await fixture("DerivedCoreProperties"))) {
        if (property !== "Default_Ignorable_Code_Point") continue;
        const [from, to] = interval(range!);
        expected.fill(1, from, to + 1);
    }
    for (let cp = 0; cp < expected.length; cp++) assert.equal(defaultIgnorable(cp), !!expected[cp], String(cp));
});
test("strings and ropes match native segmentation across the Unicode 18 corpus", async () => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const lines = (await fixture("GraphemeBreakTest")).trim().split(/\r?\n/);
    assert.equal(lines.length, 853);
    for (const line of lines) {
        const points = line.split(/\s+/).filter(token => token !== "÷" && token !== "×");
        const text = String.fromCodePoint(...points.map(point => parseInt(point, 16)));
        const expected = [...segmenter.segment(text)].map(part => part.index).concat(text.length);
        const buffer = TextBuffer.from(text);
        assert.deepEqual(graphemeBoundaries(buffer.slice(0, buffer.length)), expected, line);
        assert.equal(bufferReads(buffer).textExports, 0);
    }
});
test("raw surrogate seams and independent ranges preserve absolute UTF-16 positions", () => {
    const text = "a".repeat(255) + "😀\u0301\r\n\ud800\u0300x\udc00";
    const buffer = TextBuffer.from(text).replace(256, 257, "").replace(256, 256, text.slice(256, 257));
    assert.deepEqual(graphemeBoundaries(buffer.slice(0, buffer.length)).slice(255), [255, 258, 260, 262, 263, 264]);
    assert.deepEqual(graphemeBoundaries(buffer.slice(256, 259), 256), [256, 258, 259]);
    assert.equal(bufferReads(buffer).textExports, 0);
});

test("caret neighbors include or skip exact boundaries in a nonzero source range", () => {
    const from = 7;
    const text = "A😀\u0301B".repeat(300);
    const boundaries = graphemeBoundaries(text, from);
    const expected = [...Array.from({ length: 300 }, (_, i) => [from + i * 5, from + i * 5 + 1, from + i * 5 + 4]).flat(),
        from + text.length];
    assert.deepEqual(boundaries, expected);
    assert.ok(Object.isFrozen(boundaries));
    const reversed = [...expected].reverse();
    for (let offset = from; offset <= from + text.length; offset++) {
        assert.deepEqual(pointAtBoundaries(boundaries, offset), { offset,
            floor: reversed.find(at => at <= offset), ceil: expected.find(at => at >= offset),
            preceding: reversed.find(at => at < offset) ?? null, following: expected.find(at => at > offset) ?? null });
    }
    assert.deepEqual(pointAtBoundaries(graphemeBoundaries(""), 0),
        { offset: 0, floor: 0, ceil: 0, preceding: null, following: null });
});

test("long combining and flag sequences keep their complete context", () => {
    const marks = "\u0301".repeat(90_000);
    for (const text of ["A" + marks, "👩" + marks + "‍💻"]) {
        assert.deepEqual(graphemeBoundaries(text), [0, text.length]);
    }
    const flags = "🇫".repeat(50_001);
    const boundaries = graphemeBoundaries(flags);
    assert.equal(boundaries.length, 25_002);
    assert.equal(boundaries.at(-2), flags.length - 2);
});
