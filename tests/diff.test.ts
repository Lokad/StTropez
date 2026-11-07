import assert from "node:assert/strict";
import test from "node:test";
import { DiffReferenceCache, TextDiff, TextBuffer } from "../src/index.ts";

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
    // Independent backing forces a genuine long scan even when shared-span proofs exist.
    const a = TextBuffer.from("x".repeat(1_000_000)), b = TextBuffer.from("x".repeat(500_000) + "y" + "x".repeat(499_999));
    const job = new TextDiff(a, b); let result = job.next(512);
    while (result.status === "running" && result.readUnits === 0) result = job.next(512);
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

test("mixed short and long line identities retain exact UTF16 alignment at bounded-read thresholds", () => {
    const alphabet = ["\n", "a\r\n", "é😀\n", "x".repeat(254) + "\n", "x".repeat(255) + "\n", "x".repeat(256) + "\n", "\ud800".repeat(900) + "\n"];
    let seed = 7291; const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
    for (let trial = 0; trial < 250; trial++) {
        const a = Array.from({ length: random(11) }, () => alphabet[random(alphabet.length)]!), b = Array.from({ length: random(11) }, () => alphabet[random(alphabet.length)]!);
        const rows = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
        for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) rows[i]![j] = a[i - 1] === b[j - 1] ? rows[i - 1]![j - 1]! + 1 : Math.max(rows[i - 1]![j]!, rows[i]![j - 1]!);
        assert.equal(diff(a.join(""), b.join("")).lineEdits, a.length + b.length - 2 * rows[a.length]![b.length]!);
    }
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

test("reference and working index reuse retain exact hunks across edits and baseline replacement", () => {
    const cache = new DiffReferenceCache(), original = Array.from({ length: 2000 }, (_, i) => `line ${i}\r\n`).join(""), baseline = TextBuffer.from(original);
    const finish = (a: TextBuffer, b: TextBuffer, shared?: DiffReferenceCache) => { const job = new TextDiff(a, b, shared); let result = job.next(512);
        while (result.status === "running") result = job.next(512); job.dispose(); return result; };
    // Independent reference storage requires cached exact identities rather than ownership alone.
    let working = TextBuffer.from(original).replace(0, 4, "changed"); finish(baseline, working, cache);
    for (let i = 0; i < 12; i++) {
        working = working.replace(working.length, working.length, `tail ${i}\n`);
        const reused = finish(baseline, working, cache), fresh = finish(baseline, working);
        assert.deepEqual(reused.hunks, fresh.hunks); assert.equal(reused.lineEdits, fresh.lineEdits); assert.ok(reused.readUnits < fresh.readUnits);
    }
    const other = TextBuffer.from("different\r\n"), reused = finish(other, working, cache), fresh = finish(other, working);
    assert.deepEqual(reused.hunks, fresh.hunks); assert.equal(reused.lineEdits, fresh.lineEdits); cache.dispose();
    assert.throws(() => new TextDiff(baseline, working, cache), /disposed/);
    assert.equal(baseline.readMetrics().textExports, 0); assert.equal(working.readMetrics().textExports, 0);
});

test("cancelled partial reference indexing and concurrent jobs retain independent working identities", () => {
    const cache = new DiffReferenceCache(), a = TextBuffer.from("repeat\n".repeat(2000));
    const cancelled = new TextDiff(a, TextBuffer.from("other\n"), cache); cancelled.next(512); cancelled.dispose();
    const left = new TextDiff(a, TextBuffer.from("left\n"), cache), right = new TextDiff(a, TextBuffer.from("right\n"), cache);
    let l = left.next(512), r = right.next(512);
    while (l.status === "running" || r.status === "running") { if (l.status === "running") l = left.next(512); if (r.status === "running") r = right.next(512); }
    assert.equal(l.hunks.length, 1); assert.equal(r.hunks.length, 1);
    cache.dispose(); assert.equal(left.next(512).status, "ready"); left.dispose(); right.dispose(); cache.dispose();
});

test("cached alignment stays minimal through block splits, mixed endings, long rows and hash collisions", () => {
    const collision = ["F\"]:`#\"/Q\n", "S/:hvp6FJ\n"];
    const rows = Array.from({ length: 194 }, (_, i) => `row ${i} é😀\ud800${i % 3 ? "\n" : "\r\n"}`);
    rows[63] = collision[0]!; rows[127] = "x".repeat(300) + "\r\n";
    const baselineRows = [...rows]; baselineRows[0] = "remote " + baselineRows[0];
    const baselineText = baselineRows.join(""), baseline = TextBuffer.from(baselineText), cache = new DiffReferenceCache();
    let workingRows = [...rows], working = TextBuffer.from(rows.join(""));
    const finish = (buffer: TextBuffer, shared?: DiffReferenceCache) => {
        const job = new TextDiff(baseline, buffer, shared); let result = job.next(512);
        while (result.status === "running") { const before = result.work; result = job.next(512); assert.ok(result.work - before < 1280); }
        assert.equal(result.status, "ready"); job.dispose(); return result;
    };
    const retained = finish(working, cache).hunks, retainedJson = JSON.stringify(retained);
    for (let trial = 0; trial < 48; trial++) {
        const at = [0, 1, 62, 63, 64, 65, 126, 127, 128, 129, 190, 191, 192][trial % 13]! % workingRows.length;
        const from = workingRows.slice(0, at).join("").length, old = workingRows[at]!;
        const insert = trial % 4 === 0 ? `insert ${trial}\r\n` : trial % 4 === 1 ? collision[trial % 2]!
            : trial % 4 === 2 ? "" : "long é😀".repeat(50) + "\n";
        const remove = trial % 4 === 0 ? 0 : old.length;
        working = working.replace(from, from + remove, insert);
        workingRows.splice(at, remove ? 1 : 0, ...(insert ? [insert] : []));
        const expected = workingRows.join(""), cached = finish(working, cache), fresh = finish(working);
        assert.deepEqual(cached.hunks, fresh.hunks);
        let previous = new Uint16Array(workingRows.length + 1);
        for (const row of baselineRows) {
            const next = new Uint16Array(previous.length);
            for (let j = 1; j < next.length; j++) next[j] = row === workingRows[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, next[j - 1]!);
            previous = next;
        }
        assert.equal(cached.lineEdits, baselineRows.length + workingRows.length - 2 * previous.at(-1)!);
        let restored = baselineText;
        for (const hunk of [...cached.hunks].reverse()) restored = restored.slice(0, hunk.baseline.from)
            + expected.slice(hunk.working.from, hunk.working.to) + restored.slice(hunk.baseline.to);
        assert.equal(restored, expected); assert.equal(JSON.stringify(retained), retainedJson);
        assert.equal(working.readMetrics().textExports, 0);
    }
    assert.equal(baseline.readMetrics().textExports, 0); cache.dispose();
});

test("independent 100k-line cached comparisons retain literal edits without rereading equal interiors", () => {
    const original = Array.from({ length: 100000 }, (_, i) => `const row${i}\r\n`).join("").trimEnd();
    const baseline = TextBuffer.from("remote " + original), cache = new DiffReferenceCache();
    let working = TextBuffer.from(original);
    const finish = () => { const job = new TextDiff(baseline, working, cache); let result = job.next(32768);
        while (result.status === "running") result = job.next(32768); assert.equal(result.status, "ready"); job.dispose(); return result; };
    finish(); let tail = "";
    for (const addition of [" later", "😀", " correction", "\tmore"]) {
        working = working.replace(working.length, working.length, addition); tail += addition;
        const result = finish();
        assert.deepEqual(result.hunks, [
            { baseline: { from: 0, to: 7, lineFrom: 0, lineTo: 1 }, working: { from: 0, to: 0, lineFrom: 0, lineTo: 0 }, whitespaceOnly: false },
            { baseline: { from: baseline.length, to: baseline.length, lineFrom: 99999, lineTo: 99999 },
                working: { from: original.length, to: original.length + tail.length, lineFrom: 99999, lineTo: 100000 }, whitespaceOnly: false },
        ]);
        assert.ok(result.readUnits < 4096); assert.equal(result.lineEdits, 4);
        assert.equal(working.readMetrics().textExports, 0);
    }
    assert.equal(baseline.readMetrics().textExports, 0); cache.dispose();
});

test("shared-source restoration retains bounded comparison reads across partial metadata blocks", () => {
    const counts = [...Array.from({ length: 64 }, (_, remainder) => 128 + remainder), 194, 10000, 99967, 100000];
    for (const count of counts) for (const restoredEdge of ["first", "last"]) {
        const rows = Array.from({ length: count }, (_, i) => `const value${String(i).padStart(6, "0")} = 123;`), text = rows.join("\n");
        const baseline = TextBuffer.from(text), firstEnd = rows[0]!.length, lastStart = text.length - rows.at(-1)!.length;
        // Separate real edits retain new backing after restoration; an identical single
        // replacement is filtered before buffer construction and would miss this case.
        const intermediate = baseline.apply([
            { from: 0, to: firstEnd, insert: restoredEdge === "first" ? "temporary first row" : "changed first row" },
            { from: lastStart, to: text.length, insert: restoredEdge === "last" ? "temporary last row" : "changed last row" },
        ]).buffer;
        const working = restoredEdge === "first" ? intermediate.replace(0, "temporary first row".length, rows[0]!)
            : intermediate.replace(intermediate.length - "temporary last row".length, intermediate.length, rows.at(-1)!);
        const expected = restoredEdge === "first" ? rows.slice(0, -1).join("\n") + "\nchanged last row"
            : "changed first row\n" + rows.slice(1).join("\n");
        const job = new TextDiff(baseline, working); let result = job.next(32768);
        while (result.status === "running") result = job.next(32768);
        assert.equal(result.status, "ready"); assert.equal(result.hunks.length, 1); assert.equal(result.lineEdits, 2);
        let rebuilt = text;
        for (const hunk of [...result.hunks].reverse()) rebuilt = rebuilt.slice(0, hunk.baseline.from)
            + working.slice(hunk.working.from, hunk.working.to) + rebuilt.slice(hunk.baseline.to);
        assert.equal(rebuilt, expected);
        assert.ok(result.readUnits < 8192, `${count} rows, restored ${restoredEdge}: ${result.readUnits} comparison reads`);
        assert.ok(result.work < 20000); assert.ok(result.lineComparisons < 256);
        assert.equal(baseline.readMetrics().textExports, 0); assert.equal(working.readMetrics().textExports, 0); job.dispose();
    }
});
