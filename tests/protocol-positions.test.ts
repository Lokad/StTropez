import test from "node:test";
import assert from "node:assert/strict";
import { TextDocument } from "vscode-languageserver-protocol/node.js";
import type { TextBuffer as Buffer } from "../src/core/text-buffer.ts";
import type { PositionMapping } from "../src/core/positions.ts";
import type { LspLineIndex as LineIndex } from "../src/protocol/index.ts";

import { TextBuffer, PositionMap, composePositionMaps } from "../src/index.ts";
import { LspLineIndex } from "../src/protocol/index.ts";
const cooperate = async () => {};
function apply(text: string, changes: readonly { range: { start: { line: number; character: number }; end: { line: number; character: number } }; text: string }[]): string {
    for (const change of changes) text = TextDocument.applyEdits(TextDocument.create("fixture:document", "fixture", 1, text), [{ range: change.range, newText: change.text }]);
    return text;
}
function check(index: LineIndex, text: string): void {
    const reference = TextDocument.create("fixture:document", "fixture", 1, text);
    // The legacy reference helper reports zero lines for empty text; LSP position (0,0) still exists.
    assert.equal(index.lineCount, text === "" ? 1 : reference.lineCount);
    for (let offset = 0; offset <= text.length; offset++) {
        if (text[offset - 1] === "\r" && text[offset] === "\n") { assert.throws(() => index.at(offset), RangeError); continue; }
        const position = reference.positionAt(offset); assert.deepEqual(index.at(offset), position);
        assert.equal(index.offsetAt(position), offset);
    }
    const lines = text.split(/\r\n|\r|\n/); let offset = 0;
    for (let line = 0; line < lines.length; line++) {
        assert.equal(index.offsetAt({ line, character: 0x7fffffff }), offset + lines[line]!.length);
        offset += lines[line]!.length;
        if (line + 1 < lines.length) offset += text.slice(offset, offset + 2) === "\r\n" ? 2 : 1;
    }
    assert.equal(index.offsetAt({ line: index.lineCount, character: 100 }), text.length);
}

test("UTF-16 positions preserve bare CR, CRLF, LF, surrogate units and end-of-line clamping", async () => {
    for (const text of ["", "\r\r\n\n\r", "a😀\r\né\rb\n\ud800", "x\r\ny\rz\n"]) {
        const index = await LspLineIndex.create(TextBuffer.from(text), cooperate); check(index, text);
        for (const position of [{ line: -1, character: 0 }, { line: 0, character: 1.5 }, { line: Infinity, character: 0 }]) assert.throws(() => index.offsetAt(position), RangeError);
        assert.throws(() => index.at(text.length + 1), RangeError);
    }
});

test("incremental newline joins/splits and history jumps apply exactly through the independent reference", async () => {
    let text = "a😀\r\nb\rc\n\ud800", buffer = TextBuffer.from(text), index = await LspLineIndex.create(buffer, cooperate), seed = 7193;
    const history = [{ buffer, text }], inserts = ["", "\r", "\n", "\r\n", "😀é", "\ud800", "x\ry\nz"];
    const random = (max: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
    for (let step = 0; step < 300; step++) {
        let next: Buffer, expected: string, mapping: PositionMapping | undefined;
        if (step % 17 === 16) { const old = history[random(history.length)]!; next = old.buffer; expected = old.text; }
        else { const from = random(text.length + 1), to = from + random(text.length - from + 1), insert = inserts[random(inserts.length)]!;
            const second = to + random(text.length - to + 1), final = second + random(text.length - second + 1), tail = inserts[random(inserts.length)]!;
            const result = buffer.apply([{ from, to, insert }, { from: second, to: final, insert: tail }]); next = result.buffer; mapping = result.mapping;
            expected = text.slice(0, from) + insert + text.slice(to, second) + tail + text.slice(final); }
        const result = await index.change(next, cooperate, mapping ? { before: buffer, mapping } : undefined);
        assert.equal(apply(text, result.changes), expected);
        index = result.index; text = expected; buffer = next; check(index, text); history.push({ buffer, text });
    }
});

test("distant batch changes and their inverses send bounded text instead of the intervening 100k lines", async t => {
    const text = "row 😀\r\n".repeat(100_000), before = TextBuffer.from(text), index = await LspLineIndex.create(before, cooperate);
    const far = before.offsetAt(99_998) + 2, result = before.apply([{ from: 2, to: 2, insert: "Z\r" }, { from: far, to: far + 1, insert: "\n😀" }]);
    const fallback = await index.change(result.buffer, cooperate), oldReads = before.readMetrics().sliceUnits, newReads = result.buffer.readMetrics().sliceUnits;
    const exact = await index.change(result.buffer, cooperate, { before, mapping: result.mapping });
    const counts = { fallbackUnits: fallback.changes.reduce((sum, change) => sum + change.text.length, 0),
        batchUnits: exact.changes.reduce((sum, change) => sum + change.text.length, 0),
        batchReads: before.readMetrics().sliceUnits - oldReads + result.buffer.readMetrics().sliceUnits - newReads };
    t.diagnostic(JSON.stringify(counts));
    assert.ok(counts.fallbackUnits > 700_000); assert.ok(counts.batchUnits < 32); assert.ok(counts.batchReads < 256);
    assert.equal(exact.changes.length, 2); assert.ok(exact.changes[0]!.range.start.line > exact.changes[1]!.range.start.line);
    assert.equal(apply(text, exact.changes), result.buffer.slice(0, result.buffer.length));
    const reverse = await exact.index.change(before, cooperate, { before: result.buffer, mapping: result.mapping.invert() });
    assert.equal(reverse.changes.length, 2); assert.equal(apply(result.buffer.slice(0, result.buffer.length), reverse.changes), text);
    const a = before.apply([{ from: 2, to: 2, insert: "a" }, { from: far, to: far, insert: "a" }]);
    const b = a.buffer.apply([{ from: 3, to: 3, insert: "b" }, { from: far + 2, to: far + 2, insert: "b" }]);
    const grouped = composePositionMaps(a.mapping, b.mapping), group = await index.change(b.buffer, cooperate, { before, mapping: grouped });
    assert.equal(group.changes.length, 2); assert.equal(apply(text, group.changes), b.buffer.slice(0, b.buffer.length));
    const undo = await group.index.change(before, cooperate, { before: b.buffer, mapping: grouped.invert() });
    assert.equal(undo.changes.length, 2); assert.equal(apply(b.buffer.slice(0, b.buffer.length), undo.changes), text);
});

test("unproved, mismatched and skipped change hints preserve the exact fallback", async () => {
    const before = TextBuffer.from("start\r\n" + "middle\r".repeat(40) + "end"), index = await LspLineIndex.create(before, cooperate);
    const a = before.apply([{ from: 0, to: 0, insert: "x" }]), b = a.buffer.apply([{ from: a.buffer.length, to: a.buffer.length, insert: "y" }]);
    const opaque: PositionMapping = { ...a.mapping, map: a.mapping.map.bind(a.mapping), mapRange: a.mapping.mapRange.bind(a.mapping), invert: a.mapping.invert.bind(a.mapping) };
    for (const hint of [{ before, mapping: new PositionMap(before.length, [{ from: 10, to: 10, insert: "xy" }]) },
        { before: a.buffer, mapping: b.mapping }, { before, mapping: opaque }, { before, mapping: composePositionMaps(a.mapping, b.mapping) }]) {
        const result = await index.change(b.buffer, cooperate, hint);
        assert.equal(apply(before.slice(0, before.length), result.changes), b.buffer.slice(0, b.buffer.length));
        check(result.index, b.buffer.slice(0, b.buffer.length));
    }
});

test("large document opening yields; point changes reuse LF metadata and bound text reads", async () => {
    const text = "sample 😀\r\n".repeat(100_000), before = TextBuffer.from(text); let yields = 0;
    const index = await LspLineIndex.create(before, async () => { yields++; }); assert.ok(yields > 10);
    const baseline = before.readMetrics().sliceUnits, from = before.offsetAt(50_000) + 2, after = before.replace(from, from, "Z\r");
    const changed = await index.change(after, cooperate), change = changed.changes[0]!;
    assert.deepEqual(changed.index.at(from + 2), { line: 50_001, character: 0 });
    assert.equal(TextDocument.applyEdits(TextDocument.create("fixture:large", "fixture", 1, text), [{ range: change.range, newText: change.text }]), text.slice(0, from) + "Z\r" + text.slice(from));
    assert.ok(before.readMetrics().sliceUnits - baseline < 64); assert.ok(after.readMetrics().sliceUnits < 64);
    assert.equal(before.readMetrics().textExports + after.readMetrics().textExports, 0);
    const unchanged = await changed.index.change(after, cooperate); assert.equal(unchanged.index, changed.index); assert.deepEqual(unchanged.changes, []);
});

test("chunk-edge CRLF classification and cooperative cancellation preserve the old index", async () => {
    const text = "x".repeat(16_383) + "\r\ny\rz", before = TextBuffer.from(text), index = await LspLineIndex.create(before, cooperate);
    const after = before.replace(16_384, 16_385, ""), changed = await index.change(after, cooperate);
    check(changed.index, text.slice(0, 16_384) + text.slice(16_385)); assert.equal(index.lineCount, 3);
    const large = before.replace(0, before.length, "\r".repeat(40_000)); let yields = 0;
    await assert.rejects(index.change(large, async () => { yields++; throw new Error("Cancelled plan"); }), /Cancelled plan/);
    assert.equal(yields, 1); assert.deepEqual(index.at(16_385), { line: 1, character: 0 });
    const batch = before.apply(Array.from({ length: 200 }, (_, i) => ({ from: i * 60, to: i * 60, insert: "!" })));
    await assert.rejects(index.change(batch.buffer, async () => { throw new Error("Cancelled batch"); }, { before, mapping: batch.mapping }), /Cancelled batch/);
    assert.deepEqual(index.at(16_385), { line: 1, character: 0 });
});
