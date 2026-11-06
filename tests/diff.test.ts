import assert from "node:assert/strict";
import test from "node:test";
import { TextDiff, TextBuffer } from "../src/index.ts";

function diff(a: string, b: string, buffers?: readonly [TextBuffer, TextBuffer]) {
    const job = new TextDiff(buffers?.[0] ?? TextBuffer.from(a), buffers?.[1] ?? TextBuffer.from(b)); let result = job.next(512), calls = 1;
    while (result.status === "running") { const before = result.work; result = job.next(512); assert.ok(result.work - before < 1280); assert.ok(++calls < 100000); }
    assert.equal(result.status, "ready"); assert.ok(Object.isFrozen(result.hunks));
    let forward = a, reverse = b;
    for (const hunk of [...result.hunks].reverse()) {
        forward = forward.slice(0, hunk.baseline.from) + b.slice(hunk.working.from, hunk.working.to) + forward.slice(hunk.baseline.to);
        reverse = reverse.slice(0, hunk.working.from) + a.slice(hunk.baseline.from, hunk.baseline.to) + reverse.slice(hunk.working.to);
    }
    assert.equal(forward, b); assert.equal(reverse, a); return result;
}

test("comparison preserves exact whitespace, endings, empty text and UTF-16", () => {
    for (const a of ["", "\n", "abc", "a\r\nb\n", "👩‍💻é\n", " \t\n", "a\na\nb\n"])
        for (const b of ["", "\n", "abc", "a\nb\r\n", "👨‍💻é\n", "\t \n", "b\na\nb\n"]) diff(a, b);
    assert.equal(diff("a\r\n", "a\n").hunks[0]!.whitespaceOnly, true);
    assert.equal(diff("a\n", "b\n").hunks[0]!.whitespaceOnly, false);
    assert.equal(diff("same\n", "same\n").hunks.length, 0);
});

test("line alignment agrees with a dynamic-programming edit-distance oracle", () => {
    let seed = 45923; const random = (n: number) => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) % n; };
    for (let trial = 0; trial < 4000; trial++) {
        const a = Array.from({ length: random(18) }, () => String.fromCharCode(65 + random(5)) + "\n");
        const b = Array.from({ length: random(18) }, () => String.fromCharCode(65 + random(5)) + "\n");
        const rows = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
        for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) rows[i]![j] = a[i - 1] === b[j - 1] ? rows[i - 1]![j - 1]! + 1 : Math.max(rows[i - 1]![j]!, rows[i]![j - 1]!);
        const result = diff(a.join(""), b.join(""));
        assert.equal(result.lineEdits, a.length + b.length - 2 * rows[a.length]![b.length]!);
    }
});

test("comparison yields within a long line, never exports full text and cancels retained work", () => {
    const a = TextBuffer.from("x".repeat(1_000_000)), b = a.replace(500_000, 500_001, "y");
    const job = new TextDiff(a, b); let result = job.next(512);
    assert.equal(result.status, "running"); assert.ok(result.readUnits <= 1024);
    job.dispose(); result = job.next(512); assert.equal(result.status, "cancelled"); assert.equal(result.hunks.length, 0);
    assert.equal(a.readMetrics().textExports, 0); assert.equal(b.readMetrics().textExports, 0);
    assert.throws(() => job.next(1), RangeError);
    const same = new TextDiff(a, a).next(512); assert.equal(same.status, "ready"); assert.equal(same.work, 0);
});

test("equal-length hash collisions still require exact line comparison", () => {
    // These owned synthetic strings have the same FNV-1a signature, including LF.
    const a = "F\"]:`#\"/Q\n", b = "S/:hvp6FJ\n";
    const result = diff(a, b); assert.equal(result.hunks.length, 1); assert.equal(result.lineEdits, 2);
    const surrounded = diff(`same\n${a}same\n`, `same\n${b}same\n`); assert.equal(surrounded.hunks.length, 1);
});

test("fragmented snapshots preserve raw seams, unpaired surrogates and every edit range", () => {
    let a = "a😀\r\nb\né\t".repeat(10), b = a, left = TextBuffer.from(a), right = TextBuffer.from(b), seed = 871;
    const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
    for (let iteration = 0; iteration < 200; iteration++) {
        const onLeft = random(2) === 0, text = onLeft ? a : b, from = random(text.length + 1), to = Math.min(text.length, from + random(4)), insert = ["\r", "\n", "😀", "é", "", "\ud800"][random(6)]!;
        if (onLeft) { a = a.slice(0, from) + insert + a.slice(to); left = left.replace(from, to, insert); }
        else { b = b.slice(0, from) + insert + b.slice(to); right = right.replace(from, to, insert); }
        diff(a, b, [left, right]); assert.equal(left.readMetrics().textExports, 0); assert.equal(right.readMetrics().textExports, 0);
    }
});
