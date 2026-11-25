import { bufferReads } from "./buffer-reads.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { TextBuffer } from "../src/index.ts";
import { createGraphemeCursor, graphemeBoundaries, GraphemeLimitError } from "../src/kernels/index.ts";
import { defaultIgnorable } from "../src/core/default-ignorable.ts";
import type { GraphemeCursor } from "../src/index.ts";
import type { GraphemeIndex } from "../src/kernels/index.ts";
const fixture = async (name: string) => gunzipSync(await readFile(new URL(`fixtures/graphemes/${name}.txt.gz`, import.meta.url))).toString("utf8");
function finish(cursor: GraphemeCursor, budget = 256): GraphemeIndex { let previous = cursor.snapshot(); while (true) { const step = cursor.next(budget); assert.ok(Object.isFrozen(step)); assert.ok(step.workUnits - previous.workUnits <= budget + 256); if (step.status === "ready") return step.result!; assert.equal(step.status, "running"); assert.equal(step.result, null); previous = step; } }
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
    for (const [row, line] of lines.entries()) {
        const points = line.split(/\s+/).filter(token => token !== "÷" && token !== "×");
        const text = String.fromCodePoint(...points.map(point => parseInt(point, 16)));
        const expected = [...segmenter.segment(text)].map(part => part.index).concat(text.length);
        const buffer = TextBuffer.from(text);
        const cursor = createGraphemeCursor(buffer);
        assert.deepEqual(finish(cursor, [256, 777, 4096][row % 3]).boundaries(), expected, line);
        assert.deepEqual(graphemeBoundaries(text), expected, line);
        assert.equal(bufferReads(buffer).textExports, 0);
        assert.equal(cursor.snapshot().readUnits, bufferReads(buffer).sliceUnits);
        cursor.dispose();
    }
});
test("emoji sequences, RI parity and Unicode18 conjuncts use full left context", () => {
    for (const text of ["👩🏽‍💻", "🇫🇷🇬🇷🇯", "\u094dक", "क्\u0308क", "\u1cf5क", "\u0600A", "각", "\u{16d63}\u{16d67}"]) { const cursor = createGraphemeCursor(text), index = finish(cursor); assert.equal(index.to, text.length); assert.equal(index.boundaryAt(0), 0); assert.equal(index.boundaryAt(index.boundaryCount - 1), text.length); cursor.dispose(); }
    assert.deepEqual(graphemeBoundaries("👩🏽‍💻"), [0, 7]); assert.deepEqual(graphemeBoundaries("🇫🇷🇬🇷🇯"), [0, 4, 8, 10]); assert.deepEqual(graphemeBoundaries("\u0600A"), [0, 2]);
});
test("raw surrogate seams, CRLF and independent ranges preserve absolute UTF16 coordinates", () => {
    const text = "a".repeat(255) + "😀\u0301\r\n\ud800\u0300x\udc00", original = TextBuffer.from(text), source = original.replace(256, 257, "").replace(256, 256, text.slice(256, 257)), cursor = createGraphemeCursor(source), index = finish(cursor);
    assert.deepEqual(index.boundaries(255), [255, 258, 260, 262, 263, 264]); assert.equal(index.clusterAt(255).to, 258); assert.deepEqual(bufferReads(source).textExports, 0); cursor.dispose(); assert.equal(index.source.kind, "buffer");
    const part = finish(createGraphemeCursor(source, { from: 256, to: 259 })); assert.deepEqual(part.boundaries(), [256, 258, 259]); assert.equal(part.from, 256); assert.equal(part.to, 259);
});
test("indexed queries distinguish containing clusters and strict/inclusive boundaries", () => {
    const cursor = createGraphemeCursor("A😀\u0301B"), index = finish(cursor); cursor.dispose(); assert.deepEqual(index.boundaries(), [0, 1, 4, 5]); assert.equal(index.clusterCount, 3);
    assert.equal(index.isBoundary(2), false); assert.equal(index.isBoundary(4), true); assert.equal(index.floor(3), 1); assert.equal(index.ceil(3), 4); assert.equal(index.preceding(4), 1); assert.equal(index.preceding(0), null); assert.equal(index.following(1), 4); assert.equal(index.following(5), null); assert.equal(index.clusterIndexAt(3), 1);
    assert.ok(Object.isFrozen(index)); assert.ok(Object.isFrozen(index.source)); assert.ok(Object.isFrozen(index.clusterAt(0))); assert.ok(Object.isFrozen(index.boundaries())); for (const i of [-1, .5, 6]) assert.throws(() => index.floor(i)); assert.throws(() => index.clusterIndexAt(5)); assert.throws(() => index.boundaryAt(4));
    const empty = finish(createGraphemeCursor("", { from: 0, to: 0 })); assert.equal(empty.clusterCount, 0); assert.deepEqual(empty.boundaries(), [0]); assert.equal(empty.preceding(0), null); assert.equal(empty.following(0), null);
});
test("paged queries retain strict and inclusive boundaries in a nonzero source range", () => {
    const from = 7, count = 300, to = from + count * 5;
    const cursor = createGraphemeCursor("prefix|" + "A😀\u0301B".repeat(count) + "suffix", { from, to }), index = finish(cursor); cursor.dispose();
    const expected = [...Array.from({ length: count }, (_, i) => [from + i * 5, from + i * 5 + 1, from + i * 5 + 4]).flat(), to];
    const reversed = [...expected].reverse();
    assert.deepEqual(index.boundaries(), expected);
    for (let offset = from; offset <= to; offset++) {
        assert.equal(index.floor(offset), reversed.find(value => value <= offset));
        assert.equal(index.ceil(offset), expected.find(value => value >= offset));
        assert.equal(index.preceding(offset), reversed.find(value => value < offset) ?? null);
        assert.equal(index.following(offset), expected.find(value => value > offset) ?? null);
    }
});

test("arbitrarily long mark, ZWJ and RI sequences use linear work and suspend without exporting buffers", () => {
    for (const text of ["A" + "\u0301".repeat(90_000), "👩" + "\u0301".repeat(50_000) + "‍💻", "🇫".repeat(50_001), "\u094d" + "\u0301".repeat(90_000) + "क"]) {
        const source = TextBuffer.from(text), cursor = createGraphemeCursor(source), initial = cursor.snapshot(); assert.equal(initial.readUnits, 0); const first = cursor.next(4096); assert.equal(first.status, "running"); assert.equal(first.result, null); const index = finish(cursor, 4096); assert.ok(cursor.snapshot().workUnits < text.length * 8); assert.equal(bufferReads(source).textExports, 0); assert.equal(index.to, text.length); cursor.dispose();
    }
});
test("cancellation, copied options and limits expose no partial index and preserve completed source", () => {
    const source = TextBuffer.from("a".repeat(40_000)); for (const phase of ["scan", "publish"] as const) { const cursor = createGraphemeCursor(source); let step = cursor.next(256); while (step.status === "running" && step.phase !== phase) step = cursor.next(256); assert.equal(step.status, "running", phase); assert.equal(step.result, null); cursor.dispose(); cursor.dispose(); assert.equal(cursor.next().status, "disposed"); assert.equal(cursor.snapshot().result, null); }
    const options = { from: 1, to: 3 }, cursor = createGraphemeCursor(source, options); options.to = 20_000; const index = finish(cursor); cursor.dispose(); assert.deepEqual(index.boundaries(), [1, 2, 3]); assert.equal(index.source.kind, "buffer");
    for (const options of [{ maxOperations: 1 }, { maxClusters: 2 }]) { const c = createGraphemeCursor(source, options); assert.throws(() => finish(c), GraphemeLimitError); assert.equal(c.snapshot().status, "failed"); assert.equal(c.snapshot().result, null); c.dispose(); }
    assert.throws(() => createGraphemeCursor(source, { to: -1 })); assert.throws(() => createGraphemeCursor(source, { maxClusters: 0 })); const c = createGraphemeCursor(source); for (const b of [0, 255, .5, NaN, Infinity]) assert.throws(() => c.next(b)); assert.equal(c.snapshot().workUnits, 0); c.dispose();
});
