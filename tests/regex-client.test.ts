import test from "node:test";
import assert from "node:assert/strict";
import { TextBuffer, applyTextEdits } from "../src/index.ts";
import type { TextEdit } from "../src/index.ts";
import { createRegexCursor } from "../src/browser/regex-client.ts";
import { RegexSession } from "../src/browser/regex-session.ts";
import type { RegexReply } from "../src/browser/regex-session.ts";
class FixtureWorker extends EventTarget {
    readonly messages: Record<string, unknown>[] = [];
    readonly session = new RegexSession();
    continuation: Generator<RegexReply> | undefined;
    terminated = false;
    automatic = true;
    postMessage(text: string): void {
        const request = JSON.parse(text) as Record<string, unknown>; this.messages.push(request);
        if (!this.automatic) return;
        const replies = request.operation === "regex-continue" ? this.continuation! : this.session.receive(request), result = replies.next();
        if (result.done) return;
        this.continuation = ["regex-matches", "regex-edits", "regex-edit", "regex-insert"].includes(result.value.operation) ? replies : undefined; this.reply(result.value);
    }
    reply(value: unknown): void { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
    terminate(): void { this.terminated = true; }
}
function fixture(buffer: TextBuffer, pattern = "(?:)", automatic = true, options: Omit<Parameters<typeof createRegexCursor>[4], "clock" | "createWorker"> = {}) {
    let serial = 0; const timers = new Map<number, () => void>(), workers: FixtureWorker[] = [];
    const clock = { setTimeout: (work: () => void) => { timers.set(++serial, work); return serial; }, clearTimeout: (id: number) => timers.delete(id) } as unknown as Pick<Window, "setTimeout" | "clearTimeout">;
    const cursor = createRegexCursor(buffer, 9, pattern, true, { ...options, clock, createWorker: () => { const worker = new FixtureWorker(); worker.automatic = automatic; workers.push(worker); return worker as unknown as Worker; } });
    return { cursor, workers, timers };
}

test("regex client streams an immutable buffer without exports and pulls one validated result page per step", async () => {
    const text = "x".repeat(32767) + "😀𐐀value", buffer = TextBuffer.from(text).replace(2, 2, "!").replace(2, 3, ""), f = fixture(buffer, "x|😀|𐐀value");
    assert.equal(f.workers.length, 0); const first = await f.cursor.next();
    assert.equal(first.readUnits, 32768); assert.equal(first.scanned, 0); assert.deepEqual(first.matches, []); assert.equal(f.workers[0]!.messages.length, 2);
    const newer = buffer.replace(0, 1, "human"); assert.equal(newer.slice(0, 5), "human");
    const second = await f.cursor.next(); assert.equal(second.readUnits, text.length - 32768); assert.equal(f.cursor.snapshot().transferred, text.length);
    let count = 0, calls = 0;
    for (;;) { const before: number = f.workers[0]!.messages.length;
        const step = await f.cursor.next(); assert.equal(f.workers[0]!.messages.length, before + 1); calls++;
        assert.ok(step.matches.length <= 512); assert.ok(step.readUnits <= 2048); assert.ok(Object.isFrozen(step)); assert.ok(Object.isFrozen(step.matches));
        count += step.matches.length; if (step.done) break; }
    assert.equal(count, 32769); assert.ok(calls > 60); assert.equal(f.cursor.snapshot().scanned, text.length);
    assert.equal(buffer.readMetrics().textExports, 0); assert.equal(newer.readMetrics().textExports, 0); assert.equal(f.workers[0]!.terminated, true); assert.equal(f.timers.size, 0);
    assert.equal((await f.cursor.next()).done, true); f.cursor.dispose();
});

test("regex replacement plans stream exact captures, large fragments, zero-width and whole-word edits", async () => {
    const cases = [
        { text: "before ab after ab", pattern: "(?<first>a)(b)(c)?", replacement: "$<first>/$2/$3/$`/$'" },
        { text: "😀x", pattern: "(?:)", replacement: "[$&]" },
        { text: "x".repeat(40000) + "y", pattern: "x{40000}", replacement: "$&$&" },
        { text: "a ".repeat(1100), pattern: "(a)", replacement: "$1!" },
    ];
    for (const { text, pattern, replacement } of cases) {
        const buffer = TextBuffer.from(text), f = fixture(buffer, pattern, true, { replacement }), edits: TextEdit[] = [];
        let pages = 0;
        for (;;) { const step = await f.cursor.next(); assert.deepEqual(step.matches, []); assert.ok(step.edits.length <= 512); assert.ok(Object.isFrozen(step.edits));
            if (step.edits.length) pages++; edits.push(...step.edits); if (step.done) break; }
        assert.equal(applyTextEdits(text, edits), text.replace(new RegExp(pattern, "gmu"), replacement)); assert.equal(buffer.readMetrics().textExports, 0);
        if (text.length > 40000) { assert.equal(edits.length, 1); assert.equal(edits[0]!.insert.length, 80000); assert.equal(f.workers[0]!.messages.filter(m => m.operation === "regex-continue").length, 4); }
        if (text.length === 2200) assert.equal(pages, 3);
        assert.equal(f.workers[0]!.terminated, true); assert.equal(f.timers.size, 0);
    }
    for (const { text, pattern, options, expected } of [
        { text: "foobar foo foo_", pattern: "foo|foobar", options: { wholeWord: true, replacement: "<$&>" }, expected: "<foobar> <foo> foo_" },
        { text: "xab xab", pattern: "(?<=x)(ab)", options: { replacement: "$1!", range: { from: 5, to: 7 } }, expected: "xab xab!" },
    ]) {
        const f = fixture(TextBuffer.from(text), pattern, true, options), edits: TextEdit[] = [];
        for (;;) { const step = await f.cursor.next(); edits.push(...step.edits); if (step.done) break; } assert.equal(applyTextEdits(text, edits), expected);
    }
});

test("regex replacement limits and malformed insertion streams reject incomplete plans", async () => {
    const buffer = TextBuffer.from("x".repeat(600)), f = fixture(buffer, "x", true, { replacement: "XX", maxOutputUnits: 1100 }), staged: TextEdit[] = [];
    await assert.rejects(async () => { for (;;) { const step = await f.cursor.next(); staged.push(...step.edits); if (step.done) break; } }, /limit/);
    assert.equal(staged.length, 512); assert.equal(buffer.slice(0, buffer.length), "x".repeat(600)); assert.equal(f.workers[0]!.terminated, true); assert.equal(f.timers.size, 0);
    const broken = fixture(TextBuffer.from("x"), "x", true, { replacement: "$&" }); await broken.cursor.next(); const worker = broken.workers[0]!; worker.automatic = false;
    const descriptor = broken.cursor.next(), id = worker.messages.at(-1)!.id;
    worker.reply({ operation: "regex-edit", id, revision: 9, ordinal: 0, from: 0, to: 1, units: 40000 }); assert.deepEqual((await descriptor).edits, []);
    const partial = broken.cursor.next(); worker.reply({ operation: "regex-insert", id, revision: 9, ordinal: 0, from: 0, text: "safe" }); assert.deepEqual((await partial).edits, []);
    const invalid = broken.cursor.next(); worker.reply({ operation: "regex-insert", id, revision: 9, ordinal: 1, from: 4, text: "wrong" }); await assert.rejects(invalid, /chunk/);
    assert.equal(worker.terminated, true); assert.equal(broken.timers.size, 0);
    const wrongDone = fixture(TextBuffer.from("x"), "x", true, { replacement: "y" }); await wrongDone.cursor.next(); const other = wrongDone.workers[0]!; await wrongDone.cursor.next(); other.automatic = false;
    const done = wrongDone.cursor.next(); other.reply({ operation: "regex-done", id: other.messages.at(-1)!.id, revision: 9, count: 1, outputLength: 99 }); await assert.rejects(done, /size/);
    assert.equal(other.terminated, true); assert.equal(wrongDone.timers.size, 0);
});

test("regex client validates complete pages, rejects split pairs/counts and preserves pending steps after stale replies", async () => {
    for (const matches of [[{ from: 0, to: 1 }], [{ from: 0, to: 2 }, { from: 0, to: 2 }], [{ from: 2, to: 99 }], [{ from: -1, to: 0 }], []]) {
        const f = fixture(TextBuffer.from("😀x")); await f.cursor.next(); const worker = f.workers[0]!; worker.automatic = false;
        const pending = f.cursor.next(), target = worker.messages.at(-1)!;
        worker.reply({ operation: "regex-matches", id: Number(target.id) + 1, revision: 9, matches: [{ from: 0, to: 0 }] }); assert.equal(f.cursor.snapshot().pending, true);
        worker.reply({ operation: "regex-matches", id: target.id, revision: 9, matches }); await assert.rejects(pending, /Invalid/);
        assert.equal(worker.terminated, true); assert.equal(f.timers.size, 0); assert.equal(f.cursor.snapshot().count, 0);
    }
    const f = fixture(TextBuffer.from("x")); await f.cursor.next(); const worker = f.workers[0]!; worker.automatic = false; const pending = f.cursor.next();
    worker.reply({ operation: "regex-done", id: worker.messages.at(-1)!.id, revision: 9, count: 99 }); await assert.rejects(pending, /count/); assert.equal(worker.terminated, true);
});

test("regex client cancellation, timeout and malformed responses release the lane without continuing transfer", async () => {
    for (const action of ["cancel", "timeout", "malformed", "error"] as const) {
        const f = fixture(TextBuffer.from("text"), "x", false), pending = f.cursor.next(), worker = f.workers[0]!;
        if (action === "cancel") f.cursor.dispose();
        else if (action === "timeout") f.timers.values().next().value!();
        else if (action === "malformed") worker.reply(null);
        else worker.dispatchEvent(new Event("error", { cancelable: true }));
        await assert.rejects(pending); assert.equal(worker.terminated, true); assert.equal(f.timers.size, 0); assert.equal(worker.messages.length, 1); f.cursor.dispose();
    }
    const f = fixture(TextBuffer.from("text"), "x", false), pending = f.cursor.next(), worker = f.workers[0]!;
    worker.reply({ operation: "regex-progress", id: worker.messages[0]!.id, revision: 9, received: 0 }); f.cursor.dispose(); await assert.rejects(pending, /cancelled/);
    assert.equal(worker.messages.length, 1); assert.equal(f.timers.size, 0);
});
