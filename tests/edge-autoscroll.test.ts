import assert from "node:assert/strict";
import { test } from "node:test";
import { createEdgeAutoscroll, edgeVelocity } from "../src/browser/edge-autoscroll.ts";

test("selection and drop edges retain distinct activation, zoom conversion and speed caps", () => {
    const box = { left: 0, top: 0, right: 100, bottom: 200, zoom: 1 }, units = { columnWidth: 8, lineHeight: 20 };
    assert.deepEqual(edgeVelocity({ x: 90, y: 190 }, box, units, "outside"), { x: 0, y: 0 });
    assert.deepEqual(edgeVelocity({ x: 90, y: 190 }, box, units, "inside"), { x: 280, y: 280 });
    assert.deepEqual(edgeVelocity({ x: 100, y: 200 }, box, units, "outside"), { x: 40, y: 100 });
    for (const activation of ["inside", "outside"] as const) for (const zoom of [1, 2]) {
        const scaled = { ...box, right: box.right * zoom, bottom: box.bottom * zoom, zoom };
        assert.deepEqual(edgeVelocity({ x: 50 * zoom, y: 100 * zoom }, scaled, units, activation), { x: 0, y: 0 });
        assert.deepEqual(edgeVelocity({ x: -10000, y: 10000 }, scaled, units, activation), { x: -300, y: 600 });
    }
});

function fixture(maximum = 1000) {
    let id = 0, position = { scrollLeft: 0, scrollTop: 0 }, capture: { id: number; valid: boolean } | undefined = { id: 1, valid: true };
    const frames = new Map<number, FrameRequestCallback>(), updates: number[] = [], cancelled: number[] = [];
    let duringFlush = () => {}, duringUpdate = () => {};
    const scroll = createEdgeAutoscroll({ requestAnimationFrame: work => { frames.set(++id, work); return id; }, cancelAnimationFrame: id => { frames.delete(id); } }, {
        getSnapshot: () => position,
        scrollTo: point => { position = { scrollLeft: Math.min(maximum, point.left), scrollTop: Math.min(maximum, point.top) }; },
        flush: () => duringFlush(),
    }, {
        capture: () => capture, valid: capture => capture.valid, velocity: () => ({ x: 0, y: 1000 }),
        update: capture => { updates.push(capture.id); duringUpdate(); }, cancel: captured => { cancelled.push(captured.id); capture = undefined; },
    });
    const step = (time: number) => { const entry = frames.entries().next().value; assert.ok(entry); frames.delete(entry[0]); entry[1](time); };
    return { scroll, frames, step, updates, cancelled, position: () => position,
        replace: () => { capture = { id: 2, valid: true }; }, invalidate: () => { capture!.valid = false; },
        onFlush: (work: () => void) => { duringFlush = work; }, onUpdate: (work: () => void) => { duringUpdate = work; } };
}

test("one frame chain bounds delayed movement, stops at scroll limits and rejects cancelled callbacks", () => {
    const f = fixture(80); f.scroll.schedule(); f.scroll.schedule(); assert.equal(f.frames.size, 1);
    f.step(100); assert.equal(f.position().scrollTop, 1000 / 60);
    f.step(100); assert.equal(f.position().scrollTop, 1000 / 60); assert.equal(f.frames.size, 1);
    f.step(10000); assert.equal(f.position().scrollTop, 1000 / 60 + 32);
    const late = [...f.frames.values()][0]!; f.scroll.stop(); f.replace(); f.scroll.schedule(); late(20000);
    assert.deepEqual(f.updates, [1, 1]); assert.equal(f.frames.size, 1); assert.equal(f.scroll.pending(), true);
    f.step(30000); assert.equal(f.position().scrollTop, 2000 / 60 + 32);
    f.step(40000); f.step(50000); assert.equal(f.position().scrollTop, 80); assert.equal(f.frames.size, 0); assert.equal(f.scroll.pending(), false);
});

test("viewport callbacks preserve replacement frame ownership and reject expired captures", () => {
    for (const phase of ["flush", "update"] as const) for (const stop of [false, true]) {
        const f = fixture(phase === "update" ? 0 : 1000);
        const replace = () => {
            f.onFlush(() => {}); f.onUpdate(() => {});
            if (stop) f.scroll.stop(); f.replace(); f.scroll.schedule();
        };
        if (phase === "flush") f.onFlush(replace); else f.onUpdate(replace);
        f.scroll.schedule(); f.step(100);
        assert.deepEqual(f.updates, phase === "flush" ? [] : [1]); assert.deepEqual(f.cancelled, []); assert.equal(f.frames.size, 1);
        f.step(116); assert.equal(f.updates.at(-1), 2); f.scroll.stop(); assert.equal(f.frames.size, 0);
    }
    const f = fixture(); f.onFlush(f.invalidate); f.scroll.schedule(); f.step(100);
    assert.deepEqual(f.updates, []); assert.deepEqual(f.cancelled, [1]); assert.equal(f.frames.size, 0); assert.equal(f.scroll.pending(), false);
});
