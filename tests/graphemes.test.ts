import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { TextBuffer, createGraphemeCursor, graphemeBoundaries, GraphemeLimitError, unicodeGraphemeVersion } from "../src/index.ts";
import { graphemeBreakProperty, indicConjunctBreak, extendedPictographic, defaultIgnorable } from "../src/core/grapheme-data.ts";
import type { GraphemeCursor, GraphemeIndex } from "../src/index.ts";
const fixture = async (name: string) => gunzipSync(await readFile(new URL(`fixtures/graphemes/${name}.txt.gz`, import.meta.url))).toString("utf8");
function finish(cursor: GraphemeCursor, budget = 256): GraphemeIndex { let previous = cursor.snapshot(); while (true) { const step = cursor.next(budget); assert.ok(Object.isFrozen(step)); assert.ok(step.workUnits - previous.workUnits <= budget + 256); if (step.status === "ready") return step.result!; assert.equal(step.status, "running"); assert.equal(step.result, null); previous = step; } }
const records = (text: string) => text.trim().split(/\r?\n/).map(line => line.split(";").map(v => v.trim()));
const interval = (text: string) => { const values = text.split("..").map(v => parseInt(v, 16)); return [values[0]!, values[1] ?? values[0]!] as const; };
test("Unicode18 grapheme, conjunct, pictographic and default-ignorable properties match every reviewed code point", async () => {
    const data = await Promise.allSettled(["GraphemeBreakProperty", "DerivedCoreProperties", "emoji-data"].map(fixture)); for (const r of data) if (r.status === "rejected") throw r.reason;
    const files = data.map(r => (r as PromiseFulfilledResult<string>).value), gcb = Array<string>(0x110000).fill("Other"), incb = Array<string>(0x110000).fill("None"), ep = new Uint8Array(0x110000), di = new Uint8Array(0x110000);
    for (const [text, property] of records(files[0]!)) { const [from, to] = interval(text!); gcb.fill(property!, from, to + 1); }
    for (const [text, property, value] of records(files[1]!)) if (property === "InCB") { const [from, to] = interval(text!); incb.fill(value!, from, to + 1); }
    for (const [text, property] of records(files[2]!)) if (property === "Extended_Pictographic") { const [from, to] = interval(text!); ep.fill(1, from, to + 1); }
    for (const [text, property] of records(files[1]!)) if (property === "Default_Ignorable_Code_Point") { const [from, to] = interval(text!); di.fill(1, from, to + 1); }
    assert.equal(unicodeGraphemeVersion, "18.0.0"); for (let cp = 0; cp <= 0x10ffff; cp++) { assert.equal(graphemeBreakProperty(cp), gcb[cp], `GCB ${cp}`); assert.equal(indicConjunctBreak(cp), incb[cp], `InCB ${cp}`); assert.equal(extendedPictographic(cp), !!ep[cp], `EP ${cp}`); assert.equal(defaultIgnorable(cp), !!di[cp], `DI ${cp}`); }
    for (const cp of [-1, NaN, .5, 0x110000]) { assert.throws(() => graphemeBreakProperty(cp)); assert.throws(() => indicConjunctBreak(cp)); assert.throws(() => extendedPictographic(cp)); assert.throws(() => defaultIgnorable(cp)); }
    console.log("Grapheme facts: 1114112 code points /4 properties.");
});
test("complete Unicode18 extended-grapheme corpus agrees for strings and ropes", async () => {
    let rows = 0, boundaries = 0; for (const line of (await fixture("GraphemeBreakTest")).trim().split(/\r?\n/)) {
        const tokens = line.trim().split(/\s+/), units: number[] = [], points: number[] = [], cps: number[] = []; let utf16 = 0;
        for (const token of tokens) { if (token === "÷") { units.push(utf16); points.push(cps.length); } else if (token !== "×") { const cp = parseInt(token, 16); cps.push(cp); utf16 += cp > 0xffff ? 2 : 1; } }
        const text = String.fromCodePoint(...cps), buffer = TextBuffer.from(text), cursor = createGraphemeCursor(buffer), result = finish(cursor, [256, 777, 4096][rows % 3]); assert.deepEqual(result.boundaries(), units, `${rows}:rope:${line}`); assert.deepEqual(graphemeBoundaries(text), units, `${rows}:string`);
        assert.equal(buffer.readMetrics().textExports, 0); assert.equal(cursor.snapshot().readUnits, buffer.readMetrics().sliceUnits); cursor.dispose();
        boundaries += units.length; rows++;
    }
    assert.ok(rows > 700); console.log(`Grapheme conformance: ${rows} rows /${boundaries} boundaries /2 input kinds.`);
});
test("emoji sequences, RI parity and Unicode18 conjuncts use full left context", () => {
    for (const text of ["👩🏽‍💻", "🇫🇷🇬🇷🇯", "\u094dक", "क्\u0308क", "\u1cf5क", "\u0600A", "각", "\u{16d63}\u{16d67}"]) { const cursor = createGraphemeCursor(text), index = finish(cursor); assert.equal(index.to, text.length); assert.equal(index.boundaryAt(0), 0); assert.equal(index.boundaryAt(index.boundaryCount - 1), text.length); cursor.dispose(); }
    assert.deepEqual(graphemeBoundaries("👩🏽‍💻"), [0, 7]); assert.deepEqual(graphemeBoundaries("🇫🇷🇬🇷🇯"), [0, 4, 8, 10]); assert.deepEqual(graphemeBoundaries("\u094dक"), [0, 2]); assert.deepEqual(graphemeBoundaries("\u0600A"), [0, 2]);
});
test("raw surrogate seams, CRLF and independent ranges preserve absolute UTF16 coordinates", () => {
    const text = "a".repeat(255) + "😀\u0301\r\n\ud800\u0300x\udc00", original = TextBuffer.from(text), source = original.replace(256, 257, "").replace(256, 256, text.slice(256, 257)), cursor = createGraphemeCursor(source), index = finish(cursor);
    assert.deepEqual(index.boundaries(255), [255, 258, 260, 262, 263, 264]); assert.equal(index.clusterAt(255).to, 258); assert.deepEqual(source.readMetrics().textExports, 0); cursor.dispose(); assert.equal(index.source.kind, "buffer");
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
        const source = TextBuffer.from(text), cursor = createGraphemeCursor(source), initial = cursor.snapshot(); assert.equal(initial.readUnits, 0); const first = cursor.next(4096); assert.equal(first.status, "running"); assert.equal(first.result, null); const index = finish(cursor, 4096); assert.ok(cursor.snapshot().workUnits < text.length * 8); assert.equal(source.readMetrics().textExports, 0); assert.equal(index.to, text.length); cursor.dispose();
    }
});
test("cancellation, copied options and limits expose no partial index and preserve completed source", () => {
    const source = TextBuffer.from("a".repeat(40_000)); for (const phase of ["scan", "publish"] as const) { const cursor = createGraphemeCursor(source); let step = cursor.next(256); while (step.status === "running" && step.phase !== phase) step = cursor.next(256); assert.equal(step.status, "running", phase); assert.equal(step.result, null); cursor.dispose(); cursor.dispose(); assert.equal(cursor.next().status, "disposed"); assert.equal(cursor.snapshot().result, null); }
    const options = { from: 1, to: 3 }, cursor = createGraphemeCursor(source, options); options.to = 20_000; const index = finish(cursor); cursor.dispose(); assert.deepEqual(index.boundaries(), [1, 2, 3]); assert.equal(index.source.kind, "buffer");
    for (const options of [{ maxOperations: 1 }, { maxClusters: 2 }]) { const c = createGraphemeCursor(source, options); assert.throws(() => finish(c), GraphemeLimitError); assert.equal(c.snapshot().status, "failed"); assert.equal(c.snapshot().result, null); c.dispose(); }
    assert.throws(() => createGraphemeCursor(source, { to: -1 })); assert.throws(() => createGraphemeCursor(source, { maxClusters: 0 })); const c = createGraphemeCursor(source); for (const b of [0, 255, .5, NaN, Infinity]) assert.throws(() => c.next(b)); assert.equal(c.snapshot().workUnits, 0); c.dispose();
});
