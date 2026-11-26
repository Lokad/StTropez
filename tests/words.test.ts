import { bufferReads } from "./buffer-reads.ts";
import test from "node:test";
import { nextSeed } from "./fixtures/workloads.ts";
import assert from "node:assert/strict";
import { TextBuffer } from "../src/index.ts";
import { wordBoundary, wordCommandOffset } from "../src/core/words.ts";

test("word movement starting inside an operator stops at its edge", () => {
    const move = (source: string, at: number, direction: -1 | 1) =>
        wordCommandOffset(TextBuffer.from(source), at, direction, false, 1);
    assert.equal(move("object?.field", 7, 1), 8);
    assert.equal(move("object?.field", 7, -1), 6);
    assert.equal(move("x+\u0301.field", 3, 1), 4);
    assert.equal(move("e\u0301.field", 2, 1), 8);
});

const boundary = (buffer: TextBuffer, offset: number, direction: -1 | 1, bounds = { from: 0, to: buffer.length }) =>
    wordBoundary(buffer, offset, direction, bounds);

test("word movement crosses long immutable pieces without exporting the document", () => {
    const buffer = TextBuffer.from("x".repeat(100_000) + "  end").replace(255, 255, "😀");
    assert.equal(wordCommandOffset(buffer, 258, 1, false, 1), 100_002);
    assert.equal(wordCommandOffset(buffer, 100_002, -1, false, 1), 257);
    assert.equal(bufferReads(buffer).textExports, 0);
});

test("lexical run boundaries exclude neighboring whitespace and stay inside captured raw-line bounds", () => {
    const text = "before\r\nalpha_beta  gamma.delta 😀 café\r\nafter", buffer = TextBuffer.from(text);
    const from = text.indexOf("alpha"), to = text.lastIndexOf("\r\n"), options = { from, to };
    assert.equal(boundary(buffer, from + 3, -1, options), from);
    assert.equal(boundary(buffer, from + 3, 1, options), from + 10);
    assert.equal(boundary(buffer, from + 10, 1, options), from + 12);
    assert.equal(boundary(buffer, from + 12, -1, options), from + 10);
    assert.equal(boundary(buffer, to - 1, 1, options), to);
    assert.equal(boundary(buffer, from, -1, options), from);
    assert.equal(bufferReads(buffer).textExports, 0);
    for (const bounds of [{ from: -1, to }, { from, to: buffer.length + 1 }, { from: from + 1, to }, { from, to: from - 1 }]) {
        assert.throws(() => boundary(buffer, from, 1, bounds), RangeError);
    }
});

test("word, symbol and whitespace boundaries cross long runs in either direction", () => {
    for (const token of ["x", "!", " ", "東", "\u0301", "\u3000"]) {
        const original = TextBuffer.from(token.repeat(24_000)), buffer = original.replace(255, 255, token);
        assert.equal(boundary(buffer, 12_000, -1), 0);
        assert.equal(boundary(buffer, 12_000, 1), buffer.length);
        assert.equal(bufferReads(buffer).textExports, 0);
    }
});

test("Unicode runs preserve raw clipped surrogate seams and the final whitespace control", () => {
    const buffer = TextBuffer.from("!" + "𐐀".repeat(300) + "?");
    for (const [offset, direction, from, to, expected] of [[1, 1, 0, 602, 601], [601, -1, 0, 602, 1],
        [2, 1, 2, 600, 3], [600, -1, 2, 600, 599], [300, 1, 0, 602, 301], [300, -1, 0, 602, 299],
        [3, 1, 3, 599, 599], [599, -1, 3, 599, 3]] as const) {
        assert.equal(boundary(buffer, offset, direction, { from, to }), expected, JSON.stringify({ offset, direction, from, to }));
    }
    for (const spaces of ["\u00a0 \u2028", "\u0085\u2029\t", "\u2028\u0085\u00a0"]) {
        const source = TextBuffer.from("東".repeat(260) + spaces + "\u0301".repeat(260) + "𐐀"), control = /[\t\u2028]$/u.test(spaces);
        assert.equal(boundary(source, 0, 1), 260);
        assert.equal(boundary(source, 260, 1), control ? 263 : 523);
        assert.equal(boundary(source, 263, 1), 523);
        assert.equal(boundary(source, 523, -1), control ? 263 : 260);
        assert.equal(boundary(source, 525, -1), 523);
        assert.equal(bufferReads(source).textExports, 0);
    }
    assert.equal(bufferReads(buffer).textExports, 0);
});

test("Unicode and fragmented run scans match an independent complete grapheme/run table", () => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const tokens = ["alpha", "βγ", "東京", "नम", "123", "_", "é", "👩‍💻", "!?", "😀", "  ", "\t", "\r\n", "\u0301"];
    let seed = 0x291b; const random = (limit: number) => { seed = nextSeed(seed); return seed % limit; };
    for (let trial = 0; trial < 180; trial++) {
        const text = Array.from({ length: 3 + random(18) }, () => tokens[random(tokens.length)]!).join("");
        let buffer = TextBuffer.from("");
        for (let i = 0; i < text.length;) {
            const end = Math.min(text.length, i + 1 + random(13));
            buffer = buffer.replace(buffer.length, buffer.length, text.slice(i, end)); i = end;
        }
        const clusters = [...segmenter.segment(text)], runs: { from: number; to: number; kind: string }[] = [];
        for (const cluster of clusters) {
            const kind = /^\p{White_Space}/u.test(cluster.segment) ? "space" : /^[\p{L}\p{N}\p{Pc}]/u.test(cluster.segment) ? "word" : "symbol";
            const last = runs.at(-1);
            if (last?.kind === kind) last.to = cluster.index + cluster.segment.length;
            else runs.push({ from: cluster.index, to: cluster.index + cluster.segment.length, kind });
        }
        for (const cluster of clusters) {
            const run = runs.find(run => run.from <= cluster.index && run.to > cluster.index)!;
            assert.equal(boundary(buffer, cluster.index, 1), run.to, JSON.stringify({ text, offset: cluster.index, direction: 1 }));
            assert.equal(boundary(buffer, cluster.index + cluster.segment.length, -1), run.from, JSON.stringify({ text, offset: cluster.index, direction: -1 }));
        }
        assert.equal(bufferReads(buffer).textExports, 0);
    }
});
