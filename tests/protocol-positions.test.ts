import { bufferReads } from "./buffer-reads.ts";
import test from "node:test";
import { nextSeed } from "./fixtures/workloads.ts";
import assert from "node:assert/strict";
import { TextDocument } from "vscode-languageserver-protocol/node.js";
import type { TextBuffer as Buffer } from "../src/core/text-buffer.ts";
import type { TextEdit } from "../src/core/changes.ts";
import type { LspLineIndex as LineIndex } from "../src/protocol/index.ts";

import { TextBuffer, Workspace } from "../src/index.ts";
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
    const random = (max: number) => { seed = nextSeed(seed); return seed % max; };
    for (let step = 0; step < 300; step++) {
        let next: Buffer, expected: string, edits: readonly TextEdit[] | undefined;
        if (step % 17 === 16) { const old = history[random(history.length)]!; next = old.buffer; expected = old.text; }
        else { const from = random(text.length + 1), to = from + random(text.length - from + 1), insert = inserts[random(inserts.length)]!;
            const second = to + random(text.length - to + 1), final = second + random(text.length - second + 1), tail = inserts[random(inserts.length)]!;
            edits = [{ from, to, insert }, { from: second, to: final, insert: tail }]; next = buffer.apply(edits).buffer;
            expected = text.slice(0, from) + insert + text.slice(to, second) + tail + text.slice(final); }
        const result = await index.change(next, cooperate, edits ? { before: buffer, edits } : undefined);
        assert.equal(apply(text, result.changes), expected);
        index = result.index; text = expected; buffer = next; check(index, text); history.push({ buffer, text });
    }
});

test("distant batch changes and their inverses send bounded text without copying intervening lines", async t => {
    const text = "row 😀\r\n".repeat(20_000), before = TextBuffer.from(text), index = await LspLineIndex.create(before, cooperate);
    const far = before.offsetAt(19_998) + 2, workspace = new Workspace();
    const { documentId } = workspace.createTextResourceFromBuffer({ scope: "test", resource: "large", variant: "source" }, "Large", { buffer: before });
    const edit = (edits: readonly TextEdit[], group?: string) => workspace.edit({ documentId, origin: "human", expectedRevision: workspace.document(documentId).revision,
        edits, ...(group ? { history: { kind: "typing" as const, group } } : {}) });
    const undoEdit = () => workspace.undo({ documentId, expectedRevision: workspace.document(documentId).revision });
    edit([{ from: 2, to: 2, insert: "Z\r" }, { from: far, to: far + 1, insert: "\n😀" }]);
    const result = workspace.document(documentId);
    const fallback = await index.change(result.buffer, cooperate), oldReads = bufferReads(before).sliceUnits, newReads = bufferReads(result.buffer).sliceUnits;
    const exact = await index.change(result.buffer, cooperate, { before, edits: result.change!.edits });
    const counts = { fallbackUnits: fallback.changes.reduce((sum, change) => sum + change.text.length, 0),
        batchUnits: exact.changes.reduce((sum, change) => sum + change.text.length, 0),
        batchReads: bufferReads(before).sliceUnits - oldReads + bufferReads(result.buffer).sliceUnits - newReads };
    t.diagnostic(JSON.stringify(counts));
    assert.ok(counts.fallbackUnits > 140_000); assert.ok(counts.batchUnits < 32); assert.ok(counts.batchReads < 256);
    assert.equal(exact.changes.length, 2); assert.ok(exact.changes[0]!.range.start.line > exact.changes[1]!.range.start.line);
    assert.equal(apply(text, exact.changes), result.buffer.slice(0, result.buffer.length));
    undoEdit();
    const reverse = await exact.index.change(before, cooperate, { before: result.buffer, edits: workspace.document(documentId).change!.edits });
    assert.equal(reverse.changes.length, 2); assert.equal(apply(result.buffer.slice(0, result.buffer.length), reverse.changes), text);
    edit([{ from: 2, to: 2, insert: "a" }, { from: far, to: far, insert: "a" }], "letters");
    edit([{ from: 3, to: 3, insert: "b" }, { from: far + 2, to: far + 2, insert: "b" }], "letters");
    undoEdit(); const inverse = workspace.document(documentId).change!;
    workspace.redo({ documentId, expectedRevision: inverse.revision });
    const b = workspace.document(documentId), group = await index.change(b.buffer, cooperate, { before, edits: b.change!.edits });
    assert.equal(group.changes.length, 2); assert.equal(apply(text, group.changes), b.buffer.slice(0, b.buffer.length));
    const undo = await group.index.change(before, cooperate, { before: b.buffer, edits: inverse.edits });
    assert.equal(undo.changes.length, 2); assert.equal(apply(b.buffer.slice(0, b.buffer.length), undo.changes), text);
});

test("unproved, mismatched and skipped change hints preserve the exact fallback", async () => {
    const before = TextBuffer.from("start\r\n" + "middle\r".repeat(40) + "end"), index = await LspLineIndex.create(before, cooperate);
    const a = before.apply([{ from: 0, to: 0, insert: "x" }]), b = a.buffer.apply([{ from: a.buffer.length, to: a.buffer.length, insert: "y" }]);
    for (const hint of [{ before, edits: [{ from: 10, to: 10, insert: "xy" }] },
        { before: a.buffer, edits: [{ from: a.buffer.length, to: a.buffer.length, insert: "y" }] },
        { before, edits: [{ from: -1, to: 5, insert: "" }] }, { before, edits: [] }]) {
        const result = await index.change(b.buffer, cooperate, hint);
        assert.equal(apply(before.slice(0, before.length), result.changes), b.buffer.slice(0, b.buffer.length));
        check(result.index, b.buffer.slice(0, b.buffer.length));
    }
});

test("large document opening yields; point changes reuse LF metadata and bound text reads", async () => {
    const text = "sample 😀\r\n".repeat(20_000), before = TextBuffer.from(text); let yields = 0;
    const index = await LspLineIndex.create(before, async () => { yields++; }); assert.ok(yields > 10);
    const baseline = bufferReads(before).sliceUnits, from = before.offsetAt(10_000) + 2, after = before.replace(from, from, "Z\r");
    const changed = await index.change(after, cooperate), change = changed.changes[0]!;
    assert.deepEqual(changed.index.at(from + 2), { line: 10_001, character: 0 });
    assert.equal(TextDocument.applyEdits(TextDocument.create("fixture:large", "fixture", 1, text), [{ range: change.range, newText: change.text }]), text.slice(0, from) + "Z\r" + text.slice(from));
    assert.ok(bufferReads(before).sliceUnits - baseline < 64); assert.ok(bufferReads(after).sliceUnits < 64);
    assert.equal(bufferReads(before).textExports + bufferReads(after).textExports, 0);
    const unchanged = await changed.index.change(after, cooperate); assert.equal(unchanged.index, changed.index); assert.deepEqual(unchanged.changes, []);
});

test("chunk-edge CRLF classification and cooperative cancellation preserve the old index", async () => {
    const text = "x".repeat(16_383) + "\r\ny\rz", before = TextBuffer.from(text), index = await LspLineIndex.create(before, cooperate);
    const after = before.replace(16_384, 16_385, ""), changed = await index.change(after, cooperate);
    check(changed.index, text.slice(0, 16_384) + text.slice(16_385)); assert.equal(index.lineCount, 3);
    const large = before.replace(0, before.length, "\r".repeat(40_000)); let yields = 0;
    await assert.rejects(index.change(large, async () => { yields++; throw new Error("Cancelled plan"); }), /Cancelled plan/);
    assert.equal(yields, 1); assert.deepEqual(index.at(16_385), { line: 1, character: 0 });
    const edits = Array.from({ length: 200 }, (_, i) => ({ from: i * 60, to: i * 60, insert: "!" }));
    const batch = before.apply(edits);
    await assert.rejects(index.change(batch.buffer, async () => { throw new Error("Cancelled batch"); }, { before, edits }), /Cancelled batch/);
    assert.deepEqual(index.at(16_385), { line: 1, character: 0 });
    const original = TextBuffer.from("row\r\n".repeat(60000)), captured = await LspLineIndex.create(original, cooperate); let fragmented = original;
    for (let i = 1; i <= 200; i++) { const at = i * 1000; fragmented = fragmented.replace(at, at, "x".repeat(65)).replace(at, at + 65, ""); }
    const reads = bufferReads(original);
    await assert.rejects(captured.change(fragmented, async () => { throw new Error("Cancelled traversal"); }), /Cancelled traversal/);
    assert.deepEqual(bufferReads(original), reads); assert.equal(bufferReads(fragmented).sliceUnits, 0);
    assert.deepEqual(captured.at(1000), { line: 200, character: 0 });
});
