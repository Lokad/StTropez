import test from "node:test";
import { nextSeed } from "../fixtures/workloads.ts";
import assert from "node:assert/strict";
import { BufferChangeCursor, TextBuffer } from "../src/index.ts";
function delta(before: TextBuffer, after: TextBuffer, budget = 256) {
    const cursor = new BufferChangeCursor(before, after); let prior = 0;
    try { for (;;) { const step = cursor.next(budget); assert.ok(step.workUnits - prior < budget + 256); prior = step.workUnits;
        if (step.status === "ready") return step.result!; } } finally { cursor.dispose(); }
}



test("shared-edge planning isolates a small edit in a 100k-line buffer and handles version-only undo", () => {
    const before = TextBuffer.from("const value = 1;\r\n".repeat(100000)), after = before.replace(123456, 123456, "😀\r\n");
    assert.deepEqual(delta(before, after), { from: 123456, to: 123456, insertFrom: 123456, insertTo: 123460 });
    assert.deepEqual(delta(after, before), { from: 123456, to: 123460, insertFrom: 123456, insertTo: 123456 });
    assert.deepEqual(delta(before, before), { from: before.length, to: before.length, insertFrom: before.length, insertTo: before.length });
    assert.deepEqual(delta(TextBuffer.from("abc"), TextBuffer.from("abc")), { from: 0, to: 3, insertFrom: 0, insertTo: 3 });
    const cursor = new BufferChangeCursor(before, after); cursor.dispose(); assert.equal(cursor.next().status, "disposed"); assert.equal(before.readMetrics().textExports, 0); assert.equal(after.readMetrics().textExports, 0);
});

test("change planning charges fragmented structural work and suspends without text reads", () => {
    const before = TextBuffer.from("x".repeat(300000)); let after = before;
    for (let i = 1; i <= 200; i++) { const at = i * 1000; after = after.replace(at, at, "y".repeat(65)).replace(at, at + 65, ""); }
    const cursor = new BufferChangeCursor(before, after), initial = cursor.snapshot();
    assert.deepEqual(initial, { status: "running", workUnits: 0, result: null, failure: null }); assert.ok(Object.isFrozen(initial));
    assert.throws(() => cursor.next(255), RangeError); assert.deepEqual(cursor.snapshot(), initial);
    const pending = cursor.next(); assert.equal(pending.status, "running"); assert.equal(pending.workUnits, 256); assert.equal(pending.result, null);
    const ready = cursor.next(); assert.equal(ready.status, "ready"); assert.equal(ready.workUnits, 401);
    assert.deepEqual(ready.result, { from: before.length, to: before.length, insertFrom: after.length, insertTo: after.length });
    assert.deepEqual(cursor.next(), ready); cursor.dispose();
    const cancelled = new BufferChangeCursor(before, after); cancelled.next(); cancelled.dispose();
    assert.deepEqual(cancelled.next(), { status: "disposed", workUnits: 256, result: null, failure: null });
    assert.deepEqual(before.readMetrics(), { textExports: 0, sliceUnits: 0 }); assert.deepEqual(after.readMetrics(), before.readMetrics());
});
test("generated raw incremental edits, batched changes and older immutable versions remain exactly equivalent", () => {
    let buffer = TextBuffer.from("\ufeffhead\r\n😀 café\ntail"); const history = [buffer]; let seed = 17;
    const next = (n: number) => { seed = nextSeed(seed); return seed % n; }, alphabet = ["\r\n", "😀", "\ud800", "東京", "é", "", "x"];
    for (let revision = 1; revision <= 80; revision++) {
        const from = next(buffer.length + 1), to = from + next(buffer.length - from + 1);
        const after = revision % 7 === 0 ? history[next(history.length)]! : buffer.apply([{ from, to, insert: alphabet[next(alphabet.length)]! }, ...(to < buffer.length ? [{ from: buffer.length, to: buffer.length, insert: "\r\n" }] : [])]).buffer;
        const change = delta(buffer, after), insert = after.slice(change.insertFrom, change.insertTo);
        const reconstructed = buffer.replace(change.from, change.to, insert);
        assert.equal(reconstructed.slice(0, after.length), after.slice(0, after.length)); assert.equal(reconstructed.lineCount, after.lineCount); history.push(after); buffer = after;
    }
});
