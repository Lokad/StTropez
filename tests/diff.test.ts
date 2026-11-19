import assert from "node:assert/strict";
import { nextSeed } from "../fixtures/workloads.ts";
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
    let seed = 45923; const random = (n: number) => { seed = nextSeed(seed) | 0; return (seed >>> 0) % n; };
    for (let trial = 0; trial < 4000; trial++) {
        const a = Array.from({ length: random(18) }, () => String.fromCharCode(65 + random(5)) + "\n");
        const b = Array.from({ length: random(18) }, () => String.fromCharCode(65 + random(5)) + "\n");
        const rows = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
        for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) rows[i]![j] = a[i - 1] === b[j - 1] ? rows[i - 1]![j - 1]! + 1 : Math.max(rows[i - 1]![j]!, rows[i]![j - 1]!);
        const result = diff(a.join(""), b.join(""));
        assert.equal(result.lineEdits, a.length + b.length - 2 * rows[a.length]![b.length]!);
    }
});

test("imbalanced repeated-row alignment remains minimal with one shared token and exact fallbacks", () => {
    let seed = 9917; const random = (n: number) => { seed = nextSeed(seed); return seed % n; };
    const alternatives = ["left alternative\n", "right alternative\n"];
    for (let trial = 0; trial < 24; trial++) {
        const left = ["common é😀\r\n", "left\n", alternatives[0]!], right = ["common é😀\r\n", "right\n", alternatives[1]!];
        if (trial % 3 === 1) right[2] = left[2]!; // Two shared tokens must use the general exact algorithm.
        if (trial % 3 === 2) left[0] = right[0] = "x".repeat(300) + "\n"; // No short-token identity.
        const a = Array.from({ length: 256 }, () => left[random(left.length)]!), b = Array.from({ length: 96 }, () => right[random(right.length)]!);
        let previous = new Uint16Array(b.length + 1);
        for (const row of a) { const next = new Uint16Array(previous.length);
            for (let j = 1; j < next.length; j++) next[j] = row === b[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, next[j - 1]!);
            previous = next; }
        const result = diff(a.join(""), b.join("")); assert.equal(result.lineEdits, a.length + b.length - 2 * previous.at(-1)!);
    }
});

test("large repeated-row removal and scattered changes complete in bounded work and reconstruct both variants", () => {
    const line = "const sample = 123;\r\n", original = "old\n" + line.repeat(100000) + "tail\n", baseline = TextBuffer.from(original);
    const removed = baseline.apply([{ from: 0, to: 3, insert: "new" }, { from: 4 + 50 * line.length, to: 4 + 24000 * line.length, insert: "changed" },
        ...Array.from({ length: 32 }, (_, i) => { const at = 4 + (50000 + i) * line.length + 5; return { from: at, to: at, insert: "xy" }; })]).buffer;
    const scattered = baseline.apply(Array.from({ length: 1024 }, (_, i) => { const at = 4 + (i < 32 ? i : 50000 + i) * line.length + 5; return { from: at, to: at, insert: "z" }; })).buffer;
    for (const working of [removed, scattered]) {
    const job = new TextDiff(baseline, working); let result = job.next(4096), calls = 1;
    while (result.status === "running") { const work = result.work; result = job.next(4096); assert.ok(result.work - work <= 4864); assert.ok(++calls < 2048); }
    assert.equal(result.status, "ready"); const changed = working.slice(0, working.length); let forward = original, reverse = changed;
    for (const hunk of [...result.hunks].reverse()) {
        forward = forward.slice(0, hunk.baseline.from) + changed.slice(hunk.working.from, hunk.working.to) + forward.slice(hunk.baseline.to);
        reverse = reverse.slice(0, hunk.working.from) + original.slice(hunk.baseline.from, hunk.baseline.to) + reverse.slice(hunk.working.to);
    }
    assert.equal(forward, changed); assert.equal(reverse, original); assert.equal(baseline.readMetrics().textExports + working.readMetrics().textExports, 0); job.dispose();
    }
});

test("comparison yields within a long line, never exports full text and cancels retained work", () => {
    // Independent backing forces a genuine long scan even when shared-span proofs exist.
    const a = TextBuffer.from("x".repeat(1_000_000)), b = TextBuffer.from("x".repeat(500_000) + "y" + "x".repeat(499_999));
    const job = new TextDiff(a, b); let result = job.next(512);
    while (result.status === "running" && result.readUnits === 0) result = job.next(512);
    assert.equal(result.status, "running"); assert.ok(result.readUnits <= 1024);
    job.dispose(); result = job.next(512); assert.equal(result.status, "disposed"); assert.equal(result.hunks.length, 0);
    assert.equal(a.readMetrics().textExports, 0); assert.equal(b.readMetrics().textExports, 0);
    assert.throws(() => job.next(1), RangeError);
    const same = new TextDiff(a, a).next(512); assert.equal(same.status, "ready"); assert.equal(same.work, 0);
});

test("comparison snapshots do not advance work and the default retains its charged-work budget", () => {
    const a = TextBuffer.from("x".repeat(1_000_000)), b = TextBuffer.from("x".repeat(999_999) + "y");
    const job = new TextDiff(a, b), explicit = new TextDiff(a, b), initial = job.snapshot();
    assert.deepEqual(initial, { status: "running", work: 0, readUnits: 0, lineEdits: 0, hunks: [], failure: null });
    assert.ok(Object.isFrozen(initial)); assert.equal(a.readMetrics().sliceUnits + b.readMetrics().sliceUnits, 0);
    const first = job.next(); assert.deepEqual(first, explicit.next(32_768));
    assert.equal(first.status, "running"); assert.ok(first.work >= 32_768 && first.work <= 32_768 + 768);
    assert.deepEqual(job.snapshot(), first); assert.equal(initial.work, 0);
    job.dispose(); explicit.dispose(); assert.equal(job.snapshot().status, "disposed");
    const same = new TextDiff(a, a), ready = same.next(); assert.equal(ready.status, "ready"); assert.deepEqual(ready.hunks, []);
    same.dispose(); assert.equal(same.snapshot().status, "disposed"); assert.deepEqual(ready.hunks, []);
});

test("failed comparison preserves its cause and cannot publish or resume a partial result", t => {
    const baseline = TextBuffer.from("abc\n".repeat(20_000)), working = TextBuffer.from("def\n".repeat(20_000));
    const job = new TextDiff(baseline, working), cause = new Error("Read failed.");
    const slice = TextBuffer.prototype.slice;
    const fault = t.mock.method(TextBuffer.prototype, "slice", function(this: TextBuffer, from: number, to: number) {
        if (this === working) throw cause;
        return slice.call(this, from, to);
    });
    assert.throws(() => { while (job.next(256).status === "running") { /* Run to the injected working read. */ } }, error => error === cause);
    const failed = job.next(256);
    assert.equal(failed.status, "failed"); assert.deepEqual(failed.hunks, []); assert.equal(failed.failure, cause.message);
    fault.mock.restore(); assert.deepEqual(job.next(256), failed);
    const fresh = new TextDiff(baseline, working); let ready = fresh.next();
    while (ready.status === "running") ready = fresh.next();
    assert.equal(ready.status, "ready"); assert.equal(ready.hunks.length, 1); assert.equal(ready.lineEdits, 40_000);
    job.dispose(); fresh.dispose();
});

test("mixed short and long line identities retain exact UTF16 alignment at bounded-read thresholds", () => {
    const alphabet = ["\n", "a\r\n", "é😀\n", "x".repeat(254) + "\n", "x".repeat(255) + "\n", "x".repeat(256) + "\n", "x".repeat(511) + "\n", "x".repeat(512) + "\n", "\ud800".repeat(900) + "\n"];
    let seed = 7291; const random = (n: number) => { seed = nextSeed(seed); return seed % n; };
    for (let trial = 0; trial < 250; trial++) {
        const a = Array.from({ length: random(11) }, () => alphabet[random(alphabet.length)]!), b = Array.from({ length: random(11) }, () => alphabet[random(alphabet.length)]!);
        const rows = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
        for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) rows[i]![j] = a[i - 1] === b[j - 1] ? rows[i - 1]![j - 1]! + 1 : Math.max(rows[i - 1]![j]!, rows[i]![j - 1]!);
        assert.equal(diff(a.join(""), b.join("")).lineEdits, a.length + b.length - 2 * rows[a.length]![b.length]!);
    }
});

test("fragmented snapshots preserve raw seams, unpaired surrogates and every edit range", () => {
    let a = "a😀\r\nb\né\t".repeat(10), b = a, left = TextBuffer.from(a), right = TextBuffer.from(b), seed = 871;
    const random = (n: number) => { seed = nextSeed(seed); return seed % n; };
    for (let iteration = 0; iteration < 200; iteration++) {
        const onLeft = random(2) === 0, text = onLeft ? a : b, from = random(text.length + 1), to = Math.min(text.length, from + random(4)), insert = ["\r", "\n", "😀", "é", "", "\ud800"][random(6)]!;
        if (onLeft) { a = a.slice(0, from) + insert + a.slice(to); left = left.replace(from, to, insert); }
        else { b = b.slice(0, from) + insert + b.slice(to); right = right.replace(from, to, insert); }
        diff(a, b, [left, right]); assert.equal(left.readMetrics().textExports, 0); assert.equal(right.readMetrics().textExports, 0);
    }
});

test("cancelling one comparison leaves interleaved jobs independent", () => {
    const a = TextBuffer.from("repeat\n".repeat(2000));
    const cancelled = new TextDiff(a, TextBuffer.from("other\n")); cancelled.next(512); cancelled.dispose();
    const left = new TextDiff(a, TextBuffer.from("left\n")), right = new TextDiff(a, TextBuffer.from("right\n"));
    let l = left.next(512), r = right.next(512);
    while (l.status === "running" || r.status === "running") { if (l.status === "running") l = left.next(512); if (r.status === "running") r = right.next(512); }
    assert.equal(l.hunks.length, 1); assert.equal(r.hunks.length, 1);
    assert.equal(left.next(512).status, "ready"); left.dispose(); right.dispose();
});

test("alignment stays minimal for successive edits with mixed endings and long rows", () => {
    const alternatives = ["left alternative\n", "right alternative\n"];
    const rows = Array.from({ length: 194 }, (_, i) => `row ${i} é😀\ud800${i % 3 ? "\n" : "\r\n"}`);
    rows[63] = alternatives[0]!; rows[127] = "x".repeat(300) + "\r\n";
    const baselineRows = [...rows]; baselineRows[0] = "remote " + baselineRows[0];
    const baselineText = baselineRows.join(""), baseline = TextBuffer.from(baselineText);
    let workingRows = [...rows], working = TextBuffer.from(rows.join(""));
    const finish = (buffer: TextBuffer) => {
        const job = new TextDiff(baseline, buffer); let result = job.next(512);
        while (result.status === "running") { const before = result.work; result = job.next(512); assert.ok(result.work - before < 1280); }
        assert.equal(result.status, "ready"); job.dispose(); return result;
    };
    const retained = finish(working).hunks, retainedJson = JSON.stringify(retained);
    for (let trial = 0; trial < 48; trial++) {
        const at = [0, 1, 62, 63, 64, 65, 126, 127, 128, 129, 190, 191, 192][trial % 13]! % workingRows.length;
        const from = workingRows.slice(0, at).join("").length, old = workingRows[at]!;
        const insert = trial % 4 === 0 ? `insert ${trial}\r\n` : trial % 4 === 1 ? alternatives[trial % 2]!
            : trial % 4 === 2 ? "" : "long é😀".repeat(50) + "\n";
        const remove = trial % 4 === 0 ? 0 : old.length;
        working = working.replace(from, from + remove, insert);
        workingRows.splice(at, remove ? 1 : 0, ...(insert ? [insert] : []));
        const expected = workingRows.join(""), result = finish(working);
        let previous = new Uint16Array(workingRows.length + 1);
        for (const row of baselineRows) {
            const next = new Uint16Array(previous.length);
            for (let j = 1; j < next.length; j++) next[j] = row === workingRows[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, next[j - 1]!);
            previous = next;
        }
        assert.equal(result.lineEdits, baselineRows.length + workingRows.length - 2 * previous.at(-1)!);
        let restored = baselineText;
        for (const hunk of [...result.hunks].reverse()) restored = restored.slice(0, hunk.baseline.from)
            + expected.slice(hunk.working.from, hunk.working.to) + restored.slice(hunk.baseline.to);
        assert.equal(restored, expected); assert.equal(JSON.stringify(retained), retainedJson);
        assert.equal(working.readMetrics().textExports, 0);
    }
    assert.equal(baseline.readMetrics().textExports, 0);
});

test("independent 100k-line comparisons preserve literal edits at both ends", () => {
    const original = Array.from({ length: 100000 }, (_, i) => `const row${i}\r\n`).join("").trimEnd();
    const baseline = TextBuffer.from("remote " + original);
    let working = TextBuffer.from(original);
    const finish = () => { const job = new TextDiff(baseline, working); let result = job.next(32768);
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
        assert.equal(result.lineEdits, 4);
        assert.equal(working.readMetrics().textExports, 0);
    }
    assert.equal(baseline.readMetrics().textExports, 0);
});

test("shared-source restoration skips equal rows beyond the restored edge", () => {
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
        assert.ok(result.work < 20000);
        assert.equal(baseline.readMetrics().textExports, 0); assert.equal(working.readMetrics().textExports, 0); job.dispose();
    }
});
