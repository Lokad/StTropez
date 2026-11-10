import test from "node:test";
import assert from "node:assert/strict";
import { TextDocument } from "vscode-languageserver-protocol/node.js";
import { TextBuffer } from "../src/core/text-buffer.ts";
import type { LspLineIndex as LineIndex } from "../src/protocol/index.ts";

const { LspLineIndex } = await import(process.env.STTROPEZ_PROTOCOL_TEST_MODULE ?? "../src/protocol/index.ts") as typeof import("../src/protocol/index.ts");
const cooperate = async () => {};
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
        let next: TextBuffer, expected: string;
        if (step % 17 === 16) { const old = history[random(history.length)]!; next = old.buffer; expected = old.text; }
        else { const from = random(text.length + 1), to = from + random(text.length - from + 1), insert = inserts[random(inserts.length)]!;
            next = buffer.replace(from, to, insert); expected = text.slice(0, from) + insert + text.slice(to); }
        const result = await index.change(next, cooperate), reference = TextDocument.create("fixture:document", "fixture", step, text);
        assert.equal(TextDocument.applyEdits(reference, result.changes.map(change => ({ range: change.range, newText: change.text }))), expected);
        index = result.index; text = expected; buffer = next; check(index, text); history.push({ buffer, text });
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
});
