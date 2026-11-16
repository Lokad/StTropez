import assert from "node:assert/strict";
import { test } from "node:test";
import { createCooperativeRunner } from "../src/browser/cooperative-runner.ts";
import { createOrderedInputQueue } from "../src/browser/ordered-input.ts";
import type { InputIntent } from "../src/browser/ordered-input.ts";

function fixture() {
    let id = 0, time = 0, revision = 0;
    const tasks = new Map<number, () => void>(), seen: { text: string; at: number | undefined }[] = [], recovered: string[] = [];
    const clock = { now: () => time }, capture = () => ({ revision, deleting: false });
    let command: { capture: ReturnType<typeof capture>; purpose: "word" } | undefined = { capture: capture(), purpose: "word" };
    const runner = createCooperativeRunner({ performance: clock,
        setTimeout: work => { tasks.set(++id, work); return id; }, clearTimeout: id => { tasks.delete(id); } });
    const queue = createOrderedInputQueue(clock, runner, {
        command: () => command, capture, disposed: () => false,
        validCommand: capture => capture.revision === revision, valid: capture => capture.revision === revision, committed: () => false,
        pairKey: text => text === "(", replay: action => { seen.push({ text: action.text, at: queue.time }); return true; },
        recover: (_pending, text) => { recovered.push(text); }, commandTurn: work => work(), deferredTurn: work => work(),
    });
    const step = () => { const entry = tasks.entries().next().value; assert.ok(entry); tasks.delete(entry[0]); entry[1](); };
    return { queue, tasks, step, seen, recovered,
        at: (value: number) => { time = value; },
        finish: () => { const pending = command!; command = undefined; revision++; queue.complete(pending.capture, () => true); },
        start: () => { command = { capture: capture(), purpose: "word" }; },
    };
}
const text = (value: string, literal?: true): InputIntent => ({ kind: "text", type: "insertText", text: value, ...(literal ? { literal } : {}) });

test("ordered replay retains event times and literal boundaries while native input pauses bounded turns", () => {
    const f = fixture(); f.queue.append(text("a")); f.at(500); f.queue.append(text("b"));
    f.at(1500); f.queue.append(text("c")); f.queue.append(text("d", true)); f.queue.append(text("("));
    for (let i = 0; i < 8; i++) f.queue.append({ kind: "text", type: "insertFromPaste", text: String(i) });
    const pending = f.queue.pending!; f.queue.waitNative(pending); f.finish();
    assert.equal(f.tasks.size, 0); assert.deepEqual([...f.seen], []);
    f.queue.finishNative(pending); f.queue.schedule(); f.queue.schedule(); assert.equal(f.tasks.size, 1);
    f.step(); assert.equal(f.seen.length, 8); assert.equal(f.tasks.size, 1);
    f.step(); assert.equal(f.tasks.size, 0); assert.equal(f.queue.pending, undefined); assert.equal(f.queue.executing, undefined);
    assert.deepEqual(f.seen, ["ab", "c", "d", "(", "0", "1", "2", "3", "4", "5", "6", "7"].map((text, i) => ({ text, at: i ? 1500 : 500 })));
    assert.equal(f.queue.time, undefined); assert.equal(f.queue.draining, false);
});

test("queue limits retain accepted UTF-16 text for one recovery and allow later input", () => {
    for (const mode of ["actions", "units"] as const) {
        const f = fixture(), count = mode === "actions" ? 256 : 1, value = mode === "actions" ? "😀" : "😀".repeat(32768);
        for (let i = 0; i < count; i++) assert.equal(f.queue.append({ kind: "text", type: "insertFromPaste", text: value }), undefined);
        const rejected = f.queue.append(text("extra")); assert.ok(rejected);
        const accepted = f.queue.take(); assert.equal(accepted, rejected);
        f.queue.recover(accepted!, "cancelled"); f.queue.recover(accepted!, "cancelled-again");
        assert.deepEqual(f.recovered, [value.repeat(count)]); assert.equal(f.tasks.size, 0);
        f.start(); f.queue.append(text("after")); f.finish(); f.step();
        assert.deepEqual(f.seen, [{ text: "after", at: 0 }]); assert.equal(f.queue.pending, undefined);
    }
});
