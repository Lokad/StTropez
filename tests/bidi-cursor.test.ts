import test from "node:test";
import assert from "node:assert/strict";
import { BidiCursor, TextBuffer, resolveBidi } from "../src/index.ts";
import type { BidiIndex, BidiStep } from "../src/index.ts";

function finish(cursor: BidiCursor, budget = 4096): { result: BidiIndex; steps: number; snapshot: BidiStep } {
    let previous = 0, steps = 0, step;
    do { step = cursor.next(budget); assert.ok(step.workUnits - previous <= budget + 256); previous = step.workUnits; steps++; assert.ok(Object.isFrozen(step)); } while (step.status === "running");
    assert.equal(step.status, "ready"); assert.ok(step.result); return { result: step.result, steps, snapshot: step };
}

test("cooperative bidi indexes keep absolute UTF-16 targets and immutable query results", () => {
    const text = "abc אבג 😀\r\n\u2067العربية (123)\u2069", buffer = TextBuffer.from("prefix " + text + " suffix"), from = 7, to = from + text.length;
    const cursor = new BidiCursor(buffer, { from, to, direction: "auto" }); assert.equal(buffer.readMetrics().sliceUnits, 0);
    const { result, snapshot } = finish(cursor, 256), expected = resolveBidi(text, "auto");
    assert.deepEqual(result.materialize(), expected); assert.equal(result.from, from); assert.equal(result.to, to); assert.equal(result.length, text.length);
    for (let i = 0; i < text.length; i++) assert.equal(result.levelAt(from + i), expected.levels[i]);
    for (let i = 0; i < result.visualLength; i++) { const offset = result.offsetAt(i); assert.equal(offset, from + expected.order[i]!); assert.equal(result.indexOf(offset), i); }
    assert.equal(result.indexOf(from + text.indexOf("😀") + 1), null); assert.equal(result.indexOf(to), null);
    assert.equal(result.paragraphCount, 2); assert.deepEqual(result.paragraphAt(0), { from, to: from + text.indexOf("\n") + 1, level: 0 });
    assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.paragraphAt(0))); assert.equal(buffer.readMetrics().textExports, 0); assert.equal(buffer.readMetrics().sliceUnits, snapshot.readUnits);
    cursor.dispose(); assert.equal(cursor.next().status, "cancelled"); assert.deepEqual(result.materialize(), expected);
    assert.throws(() => result.levelAt(to)); assert.throws(() => result.offsetAt(result.visualLength)); assert.throws(() => result.paragraphAt(2));
});

test("million-unit bidi work yields in scan, resolution and publication with bounded buffer reads", () => {
    const text = "a".repeat(255) + "😀" + " אבג (12) \u2067العربية\u2069 ".repeat(50_000), buffer = TextBuffer.from(text).replace(256, 257, "").replace(256, 256, text.slice(256, 257));
    const cursor = new BidiCursor(buffer); const first = cursor.next(256);
    assert.equal(first.status, "running"); assert.equal(first.phase, "scan"); assert.ok(first.readUnits <= 513); assert.equal(first.result, null);
    const phases = new Set<BidiStep["phase"]>([first.phase]); let step = first, previous = first.workUnits, steps = 1;
    while (step.status === "running") { step = cursor.next(4096); assert.ok(step.workUnits - previous <= 4352); previous = step.workUnits; phases.add(step.phase); steps++; }
    assert.equal(step.status, "ready"); assert.ok(steps > 100); assert.ok(phases.has("resolve")); assert.ok(phases.has("publish")); assert.equal(step.scannedUnits, text.length);
    assert.equal(step.result!.levelAt(0), 0); assert.equal(step.result!.levelAt(257 + 1), 1);
    assert.equal(buffer.readMetrics().textExports, 0); assert.equal(buffer.readMetrics().sliceUnits, step.readUnits);
});

test("cancellation can release every processing phase without publishing a partial index", () => {
    const text = "abc אבג (12) \u2067العربية\u2069 ".repeat(1500);
    for (const phase of ["scan", "resolve", "publish"] as const) {
        const cursor = new BidiCursor(text); let step = cursor.next(256);
        while (step.status === "running" && step.phase !== phase) step = cursor.next(256);
        assert.equal(step.status, "running"); assert.equal(step.phase, phase); assert.equal(step.result, null);
        cursor.dispose(); assert.equal(cursor.next().status, "cancelled"); assert.equal(cursor.next().result, null);
    }
    assert.throws(() => new BidiCursor(text, { from: -1 })); assert.throws(() => new BidiCursor(text, { to: text.length + 1 }));
    assert.throws(() => new BidiCursor(text).next(1));
});

test("weighted L runs expand by resolved parity and preserve surrogate boundaries under overrides", () => {
    const text = "\u202e" + "a𐐀".repeat(20_000) + "\u202c", cursor = new BidiCursor(text), { result, snapshot } = finish(cursor);
    assert.equal(result.levelAt(1), 1); assert.equal(result.visualLength, 40_000); assert.equal(result.offsetAt(0), text.length - 3);
    assert.equal(result.offsetAt(result.visualLength - 1), 1); assert.equal(result.indexOf(3), null);
    assert.ok(snapshot.workUnits < text.length * 8); assert.equal(result.levelAt(text.length - 1), null);
});
