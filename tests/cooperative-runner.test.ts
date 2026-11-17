import assert from "node:assert/strict";
import { test } from "node:test";
import { createCooperativeRunner } from "../src/browser/cooperative-runner.ts";

function fixture() {
    let id = 0, time = 0;
    const tasks = new Map<number, () => void>(), delays: number[] = [];
    const runner = createCooperativeRunner({ performance: { now: () => time },
        setTimeout: (work, delay) => { delays.push(delay); tasks.set(++id, work); return id; }, clearTimeout: timer => { tasks.delete(timer); } });
    const step = () => { const entry = tasks.entries().next().value; assert.ok(entry); tasks.delete(entry[0]); entry[1](); };
    return { runner, tasks, delays, step, elapse: (ms: number) => { time += ms; } };
}

test("cooperative slices yield under both stationary and advancing clocks and stop expired work", () => {
    for (const cost of [0, 2]) {
        const f = fixture(), values: number[] = [], turns: number[] = []; let current = true;
        const pump = () => {
            f.runner.slice(() => { f.elapse(cost); values.push(values.length); return values.length; },
                count => current && count < 25, 8);
            turns.push(values.length);
            if (current && values.length < 25) f.runner.schedule(pump);
        };
        pump(); assert.equal(values.length, cost ? 2 : 8); assert.equal(f.tasks.size, 1);
        while (f.tasks.size) f.step();
        assert.deepEqual(values, Array.from({ length: 25 }, (_, i) => i)); assert.ok(turns.length > 1);
        assert.ok(f.delays.every(delay => delay === 0));
        let advances = 0;
        f.runner.slice(() => { advances++; current = false; return true; }, running => running && current, 8);
        assert.equal(advances, 1); assert.equal(f.tasks.size, 0);
    }
});

test("cancelled continuations cannot execute late or invalidate replacement work", () => {
    const f = fixture(), calls: string[] = [];
    const cancel = f.runner.schedule(() => calls.push("expired"));
    const late = [...f.tasks.values()][0]!; cancel(); cancel();
    f.runner.schedule(() => calls.push("replacement"), 16); late();
    assert.deepEqual([...calls], []); assert.equal(f.tasks.size, 1); f.step();
    assert.deepEqual([...calls], ["replacement"]); assert.equal(f.tasks.size, 0);
    f.runner.schedule(() => calls.push("cancelled-a")); f.runner.schedule(() => calls.push("cancelled-b"));
    const obsolete = [...f.tasks.values()]; f.runner.cancel();
    f.runner.schedule(() => calls.push("after-cancel")); obsolete.forEach(work => work()); f.step();
    assert.deepEqual(calls, ["replacement", "after-cancel"]); assert.equal(f.tasks.size, 0);
});

test("turn failures detach the running task before owner cleanup and later recovery", () => {
    const f = fixture(), calls: string[] = [], cause = new Error("owner failure");
    const enter = (work: () => void) => { calls.push("enter"); try { work(); } finally { calls.push("leave"); } };
    const cancel = f.runner.schedule(() => {
        f.runner.schedule(() => calls.push("obsolete")); throw cause;
    }, 0, enter);
    assert.throws(f.step, error => error === cause); cancel(); f.runner.cancel();
    assert.equal(f.tasks.size, 0);
    f.runner.schedule(() => { calls.push("recovered"); f.runner.schedule(() => calls.push("continuation")); }, 0, enter);
    f.step(); f.step();
    assert.deepEqual(calls, ["enter", "leave", "enter", "recovered", "leave", "continuation"]); assert.equal(f.tasks.size, 0);
});
