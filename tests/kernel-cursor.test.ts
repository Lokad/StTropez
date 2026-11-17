import test from "node:test";
import assert from "node:assert/strict";
import { kernelCursor } from "../src/core/kernel-cursor.ts";
import type { KernelStatus } from "../src/core/kernel-cursor.ts";

const progress = <R>(status: KernelStatus, result: R | null, failure: string | null) => Object.freeze({ status, result, failure });

test("kernel results distinguish zero and empty values from absent work", () => {
    for (const value of [0, false, "", Object.freeze([]), null]) {
        const cursor = kernelCursor((function* () { return value; })(), () => 0, progress, "Test");
        assert.equal(cursor.snapshot().status, "running");
        assert.deepEqual(cursor.next(), { status: value === null ? "disposed" : "ready", result: value, failure: null });
        assert.deepEqual(cursor.next(), cursor.snapshot());
        cursor.dispose(); assert.deepEqual(cursor.snapshot(), { status: "disposed", result: null, failure: null });
    }
    const empty = kernelCursor(null, () => { throw new Error("No work to count."); }, progress, "Test");
    assert.equal(empty.snapshot().status, "disposed"); assert.equal(empty.next().status, "disposed");
});

test("kernel budgets count charged work between checkpoints and validate before advancing", () => {
    let work = 0, advances = 0;
    const cursor = kernelCursor((function* () {
        for (const cost of [300, 300, 256]) { work += cost; advances++; yield; }
        return work;
    })(), () => work, progress, "Test");
    for (const budget of [0, 255, 256.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => cursor.next(budget), RangeError);
    assert.equal(advances, 0); assert.equal(cursor.next(257).status, "running"); assert.equal(work, 300);
    assert.equal(cursor.next(512).status, "running"); assert.equal(work, 856); assert.equal(advances, 3);
    assert.deepEqual(cursor.next(), { status: "ready", result: 856, failure: null });
    cursor.dispose(); assert.throws(() => cursor.next(1), RangeError);
});

test("kernel failure preserves the original cause even when cleanup throws", () => {
    const original = new Error("Work failed."), cleanup = new Error("Cleanup failed.");
    let work = 0, fail = false, released = 0;
    const cursor = kernelCursor((function* () {
        try { work += 256; yield; return 42; } finally { released++; throw cleanup; }
    })(), () => { if (fail) throw original; return work; }, progress, "Test");
    cursor.next(256); fail = true;
    assert.throws(() => cursor.next(), error => error === original);
    assert.deepEqual(cursor.snapshot(), { status: "failed", result: null, failure: original.message });
    assert.deepEqual(cursor.next(), cursor.snapshot()); assert.equal(released, 1);
    cursor.dispose(); cursor.dispose(); assert.equal(released, 1); assert.equal(cursor.snapshot().failure, null);
    const thrown = kernelCursor((function* () { throw "failure"; })(), () => 0, progress, "Test");
    assert.throws(() => thrown.next(), error => error === "failure");
    assert.deepEqual(thrown.snapshot(), { status: "failed", result: null, failure: "Test failed." });
});

test("kernel disposal drops work before cleanup and remains terminal after a cleanup failure", () => {
    let work = 0, released = 0;
    const cause = new Error("Cleanup failed.");
    const cursor = kernelCursor((function* () {
        try { work += 256; yield; return 42; } finally { released++; throw cause; }
    })(), () => work, progress, "Test");
    cursor.next(256); assert.throws(() => cursor.dispose(), error => error === cause);
    assert.deepEqual(cursor.next(), { status: "disposed", result: null, failure: null });
    cursor.dispose(); assert.equal(released, 1);
    let entered = false;
    const unstarted = kernelCursor((function* () { entered = true; return 42; })(), () => 0, progress, "Test");
    unstarted.dispose(); assert.equal(unstarted.next().status, "disposed"); assert.equal(entered, false);
});

test("kernel advancement and cleanup reject reentrant mutations without corrupting progress", () => {
    let work = 0, cleaned = false;
    const check = () => {
        assert.throws(() => cursor.next(), /Test cursor is busy/);
        assert.throws(() => cursor.dispose(), /Test cursor is busy/);
    };
    const cursor = kernelCursor((function* () {
        try { check(); work += 256; yield; return 42; }
        finally { check(); cleaned = true; }
    })(), () => { check(); return work; }, (status, result, failure) => { check(); return progress(status, result, failure); }, "Test");
    assert.equal(cursor.next(256).status, "running"); cursor.dispose(); assert.equal(cleaned, true);
    assert.equal(cursor.next().status, "disposed");
});
