import { bufferReads } from "./buffer-reads.ts";
import test from "node:test";
import { nextSeed } from "./fixtures/workloads.ts";
import assert from "node:assert/strict";
import { TextBuffer } from "../src/index.ts";
import { bufferDifference } from "../src/kernels/index.ts";
test("shared-edge planning isolates a small edit between shared ranges and handles version-only undo", () => {
    const before = TextBuffer.from("const value = 1;\r\n".repeat(10_000)), after = before.replace(123456, 123456, "😀\r\n");
    assert.deepEqual(bufferDifference(before, after), { from: 123456, to: 123456, insertFrom: 123456, insertTo: 123460 });
    assert.deepEqual(bufferDifference(after, before), { from: 123456, to: 123460, insertFrom: 123456, insertTo: 123456 });
    assert.deepEqual(bufferDifference(before, before), { from: before.length, to: before.length, insertFrom: before.length, insertTo: before.length });
    assert.deepEqual(bufferDifference(TextBuffer.from("abc"), TextBuffer.from("abc")), { from: 0, to: 3, insertFrom: 0, insertTo: 3 });
    assert.equal(bufferReads(before).textExports, 0);
    assert.equal(bufferReads(after).textExports, 0);
});

test("fragmented versions with shared text need no text reads", () => {
    const before = TextBuffer.from("x".repeat(300000)); let after = before;
    for (let i = 1; i <= 200; i++) { const at = i * 1000; after = after.replace(at, at, "y".repeat(65)).replace(at, at + 65, ""); }
    assert.deepEqual(bufferDifference(before, after), {
        from: before.length, to: before.length, insertFrom: after.length, insertTo: after.length,
    });
    assert.deepEqual(bufferReads(before), { textExports: 0, sliceUnits: 0 }); assert.deepEqual(bufferReads(after), bufferReads(before));
});
test("generated raw incremental edits, batched changes and older immutable versions remain exactly equivalent", () => {
    let buffer = TextBuffer.from("\ufeffhead\r\n😀 café\ntail"); const history = [buffer]; let seed = 17;
    const next = (n: number) => { seed = nextSeed(seed); return seed % n; }, alphabet = ["\r\n", "😀", "\ud800", "東京", "é", "", "x"];
    for (let revision = 1; revision <= 80; revision++) {
        const from = next(buffer.length + 1), to = from + next(buffer.length - from + 1);
        const after = revision % 7 === 0 ? history[next(history.length)]! : buffer.apply([{ from, to, insert: alphabet[next(alphabet.length)]! }, ...(to < buffer.length ? [{ from: buffer.length, to: buffer.length, insert: "\r\n" }] : [])]).buffer;
        const change = bufferDifference(buffer, after), insert = after.slice(change.insertFrom, change.insertTo);
        const reconstructed = buffer.replace(change.from, change.to, insert);
        assert.equal(reconstructed.slice(0, after.length), after.slice(0, after.length)); assert.equal(reconstructed.lineCount, after.lineCount); history.push(after); buffer = after;
    }
});
