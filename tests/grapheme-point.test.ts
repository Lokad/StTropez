import { bufferReads } from "./buffer-reads.ts";
import test from "node:test";
import { nextSeed } from "../fixtures/workloads.ts";
import assert from "node:assert/strict";
import { TextBuffer } from "../src/index.ts";
import { createGraphemeCursor } from "../src/kernels/index.ts";
import { localAsciiGraphemePoint } from "../src/core/grapheme-point.ts";

function verify(text: string): number {
    // Piece seams deliberately split surrogate pairs and neighborhoods.
    let buffer = TextBuffer.from("");
    for (let from = 0; from < text.length; from += 3) buffer = buffer.replace(buffer.length, buffer.length, text.slice(from, from + 3));
    const cursor = createGraphemeCursor(buffer); let step = cursor.next(256);
    while (step.status === "running") step = cursor.next(256);
    const index = step.result!, native = [0, ...[...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(p => p.index + p.segment.length)];
    let accepted = 0;
    for (let offset = 0; offset <= text.length; offset++) {
        const reads = bufferReads(buffer).sliceUnits, point = localAsciiGraphemePoint(buffer, offset);
        assert.ok(bufferReads(buffer).sliceUnits - reads <= 4);
        if (!point) continue; accepted++;
        assert.ok(Object.isFrozen(point));
        assert.deepEqual(point, { offset, floor: index.floor(offset), ceil: index.ceil(offset), preceding: index.preceding(offset), following: index.following(offset) }, JSON.stringify({ text, offset }));
        assert.equal(point.floor, native.filter(at => at <= offset).at(-1));
        assert.equal(point.ceil, native.find(at => at >= offset));
        assert.equal(point.preceding, native.filter(at => at < offset).at(-1) ?? null);
        assert.equal(point.following, native.find(at => at > offset) ?? null);
    }
    assert.equal(bufferReads(buffer).textExports, 0); cursor.dispose(); return accepted;
}

test("bounded ASCII point queries agree with full-context indexes and a native grapheme oracle", () => {
    assert.equal(verify(""), 1);
    for (const text of ["x", "xy", "\r", "\r\n", "\r\n\r\n", "\r\r\n", "\n\r", "a\r\nb\rc\n", "prefix\tword\nend", Array.from({ length: 128 }, (_, code) => String.fromCharCode(code)).join(""), "x".repeat(770)])
        assert.equal(verify(text), text.length + 1);
    for (const text of ["\u0600x", "x\u0301", "x\u200d", "\u093e", "😀"])
        for (let offset = 0; offset <= text.length; offset++) assert.equal(localAsciiGraphemePoint(TextBuffer.from(text), offset), undefined);
});

test("accepted ASCII neighborhoods remain exact beside arbitrary Unicode and control context", () => {
    const contexts = ["\u0600", "\u0301", "\u093e", "क्‍क", "🇦🇧🇨", "👩‍💻", "\ud800", "\udc00", "\r\n", "\u200c", "\u200d", "\u0000", "\u007f", "\u2028"];
    for (const left of contexts) for (const right of contexts) assert.ok(verify(left + "abc\nxyz" + right) > 0);
    let seed = 0xa51c; const tokens = [...contexts, "abc_def", "  ", "\n", "0123456789"];
    for (let trial = 0; trial < 80; trial++) {
        const text = Array.from({ length: 12 }, () => { seed = nextSeed(seed); return tokens[seed % tokens.length]!; }).join("");
        verify(text);
    }
});

test("huge immutable buffers answer proven points with four units and reject invalid offsets", () => {
    const buffer = TextBuffer.from("x".repeat(24000));
    for (const offset of [0, 1, 12000, 23999, 24000]) {
        const before = bufferReads(buffer).sliceUnits, point = localAsciiGraphemePoint(buffer, offset)!;
        assert.equal(point.floor, offset); assert.equal(point.ceil, offset);
        assert.equal(point.preceding, offset ? offset - 1 : null); assert.equal(point.following, offset < buffer.length ? offset + 1 : null);
        assert.ok(bufferReads(buffer).sliceUnits - before <= 4);
    }
    for (const offset of [-1, buffer.length + 1, 0.5, NaN, Infinity]) assert.throws(() => localAsciiGraphemePoint(buffer, offset), RangeError);
    const crlf = buffer.replace(12000, 12000, "\r\n");
    for (const [offset, floor, ceil, preceding, following] of [[12000, 12000, 12000, 11999, 12002],
        [12001, 12000, 12002, 12000, 12002], [12002, 12002, 12002, 12000, 12003]] as const) {
        const reads = bufferReads(crlf).sliceUnits;
        assert.deepEqual(localAsciiGraphemePoint(crlf, offset), { offset, floor, ceil, preceding, following });
        assert.ok(bufferReads(crlf).sliceUnits - reads <= 4);
    }
    assert.equal(bufferReads(buffer).textExports, 0);
});
