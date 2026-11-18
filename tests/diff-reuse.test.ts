import assert from "node:assert/strict";
import { nextSeed } from "../fixtures/workloads.ts";
import test from "node:test";
import { DiffReferenceCache, TextBuffer, TextDiff } from "../src/index.ts";
import type { DiffProgress } from "../src/index.ts";
import { DiffLines } from "../src/core/diff-lines.ts";
import { prepareEqualities } from "../src/core/diff-equalities.ts";
import { indexLines } from "../src/core/diff-index.ts";
import type { DiffStats } from "../src/core/diff-index.ts";
import { collidingDiffLines } from "./helpers/diff-collision.ts";

function finish(a: TextBuffer, b: TextBuffer, cache?: DiffReferenceCache): DiffProgress {
    const inputs = a === b ? [a] : [a, b];
    const reads = () => inputs.reduce((total, buffer) => { const metrics = buffer.readMetrics();
        return { slices: total.slices + metrics.sliceUnits, exports: total.exports + metrics.textExports }; }, { slices: 0, exports: 0 });
    let observed = reads(), reported = 0;
    const job = new TextDiff(a, b, cache); let prior = 0, result = job.next(512), calls = 0;
    for (;;) {
        const current = reads(), advance = result.readUnits - reported;
        // Includes construction/first advance and excludes later reconstruction oracles.
        // Reported reads can also include an older working capture retained by the cache.
        assert.equal(current.exports, observed.exports, "Comparison exported a captured input.");
        assert.ok(current.slices - observed.slices <= advance, "Unreported UTF-16 slices from captured inputs.");
        assert.ok(advance <= result.work - prior, "Comparison reads escaped the cooperative work charge.");
        assert.ok(result.work - prior < 1280); if (result.status !== "running") break;
        observed = current; reported = result.readUnits; prior = result.work;
        assert.ok(++calls < 100000); result = job.next(512);
    }
    job.dispose(); assert.equal(result.status, "ready"); return result;
}
function reconstruct(result: DiffProgress, a: string, b: string): void {
    let forward = a, reverse = b;
    for (const hunk of [...result.hunks].reverse()) {
        forward = forward.slice(0, hunk.baseline.from) + b.slice(hunk.working.from, hunk.working.to) + forward.slice(hunk.baseline.to);
        reverse = reverse.slice(0, hunk.working.from) + a.slice(hunk.baseline.from, hunk.baseline.to) + reverse.slice(hunk.working.to);
    }
    assert.equal(forward, b); assert.equal(reverse, a);
}
const tokens = (text: string) => text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
function distance(a: string, b: string): number {
    const left = tokens(a), right = tokens(b), rows = Array.from({ length: left.length + 1 }, () => Array<number>(right.length + 1).fill(0));
    for (let i = 1; i <= left.length; i++) for (let j = 1; j <= right.length; j++) rows[i]![j] = left[i - 1] === right[j - 1]
        ? rows[i - 1]![j - 1]! + 1 : Math.max(rows[i - 1]![j]!, rows[i]![j - 1]!);
    return left.length + right.length - rows[left.length]![right.length]! * 2;
}

test("sparse line metadata retains exact runs across gaps, shifted copies and memo changes", () => {
    const entries = (text: string) => [...text].map(token => Object.freeze({ length: 1, hash: undefined, token }));
    const original = entries("abcd"), changed = entries("wxyz"), lines = DiffLines.gap(12);
    lines.materialize(2, 6, original);
    const slice = lines.slice(1, 8), shifted = DiffLines.gap(3).concat(slice).concat(DiffLines.gap(2));
    lines.materialize(8, 12, original);
    const unknown = () => undefined;
    for (const reverse of [false, true]) {
        assert.equal(lines.matching(lines, 2, 6, 8, 12, reverse, unknown), 4);
        lines.at(2); // A cached known block must not turn a gap into a proof.
        assert.equal(lines.matching(shifted, 0, 1, 4, 5, reverse, () => assert.fail("Gap has no identity")), 0);
        assert.equal(lines.matching(shifted, 2, 3, 0, 1, reverse, () => assert.fail("Gap has no identity")), 0);
        let calls = 0;
        const identity = () => { calls++; lines.at(8); shifted.at(7); return undefined; };
        // Ranges extend past the captured block; both directions stop at its boundary.
        const count = reverse ? lines.matching(shifted, 1, 6, 3, 8, true, identity)
            : lines.matching(shifted, 2, 7, 4, 9, false, identity);
        assert.equal(count, 4); assert.equal(calls, 8);
    }
    lines.at(2); lines.materialize(2, 6, changed);
    assert.equal(lines.at(2), changed[0]); assert.equal(slice.at(1), original[0]); assert.equal(shifted.at(4), original[0]);
    assert.equal(lines.matching(shifted, 2, 6, 4, 8, false, unknown), 0);
    slice.materialize(1, 5, changed);
    assert.equal(slice.at(1), changed[0]); assert.equal(shifted.at(4), original[0]);
    assert.equal(lines.matching(slice, 2, 6, 1, 5, true, unknown), 4);
    assert.equal(lines.size, 12); assert.equal(slice.size, 7); assert.equal(shifted.size, 12);
});

test("shared proofs preserve backing-independent alignment ties, Enter splits and final-token semantics", () => {
    for (const original of ["", "A\n", "A\nA\n", "x", "x\n", "a\r\nb\r\n", "😀é\n\ud800\r", "x".repeat(2000)]) {
        const a = TextBuffer.from(original), cache = new DiffReferenceCache();
        for (const at of new Set([0, Math.floor(original.length / 2), original.length])) for (const text of ["A\n", "\n", "\r", "😀", "x"]) {
            const b = a.replace(at, at, text), expected = original.slice(0, at) + text + original.slice(at);
            const shared = finish(a, b, cache), independent = finish(TextBuffer.from(original), TextBuffer.from(expected));
            assert.deepEqual(shared.hunks, independent.hunks); assert.equal(shared.lineEdits, distance(original, expected)); reconstruct(shared, original, expected);
        }
        cache.dispose();
    }
    const a = TextBuffer.from("A\n"), result = finish(a, a.replace(0, 0, "A\n"));
    assert.equal(result.hunks[0]!.baseline.from, 2); assert.equal(result.hunks[0]!.working.from, 2);
});

test("shared and cached fragmented revisions agree with independent snapshots and a seeded LCS oracle", () => {
    let seed = 82213; const random = (n: number) => { seed = nextSeed(seed); return seed % n; };
    const alphabet = ["A\n", "A\r\n", "B\n", "😀é\n", "\ud800", "\r", "", "x".repeat(257) + "\n"];
    for (let trial = 0; trial < 180; trial++) {
        const independent = trial % 3 === 0;
        const original = Array.from({ length: independent ? 48 + random(48) : 1 + random(12) }, () => alphabet[random(alphabet.length)]!).join("");
        const baseline = TextBuffer.from(original), cache = new DiffReferenceCache(); let working = independent ? TextBuffer.from(original) : baseline, text = original;
        for (let change = 0; change < 16; change++) {
            const from = random(text.length + 1), to = Math.min(text.length, from + random(7)), insert = alphabet[random(alphabet.length)]!;
            working = working.replace(from, to, insert); text = text.slice(0, from) + insert + text.slice(to);
            const reused = finish(baseline, working, cache), fresh = finish(TextBuffer.from(original), TextBuffer.from(text));
            assert.deepEqual(reused.hunks, fresh.hunks); assert.equal(reused.lineEdits, distance(original, text)); reconstruct(reused, original, text);
        }
        cache.dispose();
    }
});

test("equal-row proofs stay bounded, immutable and valid across a split row", () => {
    const stats: DiffStats = { work: 0, yielded: 0, readUnits: 0, lineComparisons: 0, lineEdits: 0 };
    const drain = <T>(job: Generator<void, T>): T => { let prior = stats.work;
        for (;;) { const step = job.next(); assert.ok(stats.work - prior < 768); prior = stats.work; if (step.done) return step.value; }
    };
    const original = TextBuffer.from("row\n".repeat(10000)), index = drain(indexLines(original, stats));
    const owner = drain(prepareEqualities(index, undefined, stats));
    for (let i = 0; i < 100; i++) drain(owner.remember(i * 96, i * 96, 32 + i % 24, stats));
    drain(owner.remember(4800, 4800, 400, stats));
    const proof = drain(owner.finish(stats)), before = JSON.stringify(proof.ranges);
    assert.ok(proof.ranges.length <= 32); assert.ok(Object.isFrozen(proof.ranges));
    for (const range of proof.ranges) assert.equal(owner.match(range.a, range.b, range.length, false, stats), range.length);
    assert.equal(owner.match(0, 0, 32, false, stats), 0, "evicted ranges leave the active lookup");
    const changed = original.replace(original.offsetAt(5000), original.offsetAt(5000) + 1, "changed\n");
    const next = drain(prepareEqualities(drain(indexLines(changed, stats)), proof, stats));
    const mapped = drain(next.finish(stats)); assert.ok(mapped.ranges.length <= 32);
    assert.ok(mapped.ranges.some(range => range.a !== range.b), "the unchanged suffix shifts by one row");
    for (const range of mapped.ranges) {
        assert.ok(Object.isFrozen(range));
        assert.equal(original.slice(original.offsetAt(range.a), original.offsetAt(range.a + range.length)),
            changed.slice(changed.offsetAt(range.b), changed.offsetAt(range.b + range.length)));
        assert.equal(next.match(range.a, range.b, range.length, false, stats), range.length);
        assert.equal(next.match(range.a + range.length, range.b + range.length, range.length, true, stats), range.length);
        const beforeMiss = stats.work;
        assert.equal(next.match(range.a, range.b + 2, range.length, false, stats), 0);
        assert.equal(stats.work - beforeMiss, 1, "an absent diagonal does not scan unrelated proofs");
    }
    drain(owner.remember(0, 0, 10000, stats)); assert.equal(JSON.stringify(proof.ranges), before);
    assert.equal(owner.match(0, 0, 10000, false, stats), 10000, "new proofs are usable in the current comparison");
});

test("independent large references reuse exact equal rows without choosing different canonical hunks", () => {
    for (const distinct of [false, true]) {
        const original = Array.from({ length: 100000 }, (_, i) => `const value${distinct ? i : ""} = 123;\n`).join("").trimEnd();
        const baseline = TextBuffer.from("remote " + original), cache = new DiffReferenceCache();
        let working = TextBuffer.from(original + " during review"); finish(baseline, working, cache);
        for (const [insert, remove] of [["z", 0], ["q", 0], ["", 1]] as const) {
            working = working.replace(working.length - remove, working.length, insert);
            const reused = finish(baseline, working, cache), fresh = finish(baseline, working);
            assert.deepEqual(reused.hunks, fresh.hunks); assert.equal(reused.lineEdits, fresh.lineEdits);
            reconstruct(reused, baseline.slice(0, baseline.length), working.slice(0, working.length));
            assert.ok(reused.readUnits < 1024, `warm reads: ${reused.readUnits}`);
            assert.ok(reused.work < 4096, `warm work: ${reused.work}`);
        }
        cache.dispose();
    }
});

test("adjacent unmatched regions remain one review hunk with unknown or colliding signatures", () => {
    const x = "x".repeat(256) + "\n", longX = "x".repeat(300) + "\n", longY = "y".repeat(300) + "\n", unicode = "😀é\n";
    const a = ["B\n", unicode, longX, unicode, "B\n", longY, "B\n", x, "A\r\n", "B\n", "A\r\n", "B\n", longY, "\ud800A\n"].join("");
    const b = ["A\r\n", "\rA\n", "\r" + longY, x, "\ud800" + x].join("");
    const result = finish(TextBuffer.from(a), TextBuffer.from(b));
    assert.equal(result.hunks.length, 2); assert.equal(result.lineEdits, distance(a, b)); reconstruct(result, a, b);
    const [left, right] = collidingDiffLines(), ca = left.repeat(2), cb = right.repeat(2), collision = finish(TextBuffer.from(ca), TextBuffer.from(cb));
    assert.equal(collision.hunks.length, 1); assert.equal(collision.lineEdits, 4); reconstruct(collision, ca, cb);
});

test("cold shared 100k-line and long-line point edits avoid document-sized indexing and preserve exact Enter hunks", () => {
    const sources = [Array.from({ length: 100000 }, (_, i) => `const value${i} = 123;`).join("\n"), "x".repeat(2400000), "first\n" + "x".repeat(2400000) + "\nlast"];
    for (const source of sources) {
        const baseline = TextBuffer.from(source);
        for (const at of [0, Math.floor(source.length / 2), source.length]) for (const insert of ["z", "\n", "abc"]) for (const remove of at < source.length ? [0, 1] : [0]) {
            const working = baseline.replace(at, at + remove, insert), result = finish(baseline, working), expected = source.slice(0, at) + insert + source.slice(at + remove);
            reconstruct(result, source, expected); assert.ok(result.readUnits < 4096, `${result.readUnits} units for ${at}/${JSON.stringify(insert)}`);
            assert.ok(result.lineComparisons < 12);
        }
    }
});

test("long-line review identities bound warm reads across revisions and independent reference storage", () => {
    const source = "x".repeat(2400000), baseline = TextBuffer.from(source), cache = new DiffReferenceCache();
    const tail = baseline.replace(baseline.length, baseline.length, "\nreview-tail"), deleted = tail.replace(0, 1, "");
    finish(baseline, tail, cache);
    for (const capture of [deleted, tail, deleted]) {
        const result = finish(baseline, capture, cache), fresh = finish(baseline, capture);
        assert.deepEqual(result.hunks, fresh.hunks); reconstruct(result, source, capture.slice(0, capture.length));
        assert.ok(result.readUnits < source.length * 2 + 4096, `${result.readUnits} units; establish the long equal prefix once`);
        assert.ok(fresh.readUnits < source.length * 2 + 4096, "the proof also belongs to comparisons without a reference cache");
    }
    cache.dispose();
    for (const length of [300, 1000]) for (const shared of [true, false]) {
        const source = Array.from({ length: 512 }, (_, i) => String(i).padStart(8, "0") + " " + "x".repeat(length - 9) + "\n").join("");
        const baseline = TextBuffer.from(source), cache = new DiffReferenceCache(); let working = shared ? baseline : TextBuffer.from(source);
        const initial = finish(baseline, working, cache); assert.equal(initial.readUnits, shared ? 0 : source.length * 2, "remember inspected equal chunks without a second scan");
        working = working.apply(Array.from({ length: 32 }, (_, i) => { const at = working.offsetAt(8 + i * 16) + length - 1; return { from: at, to: at + 1, insert: "Y" }; })).buffer;
        const exact = finish(baseline, working, cache), before = JSON.stringify(exact.hunks), at = working.offsetAt(7) + length - 2;
        const changed = working.replace(at, at + 1, "Z");
        for (const capture of [changed, working, changed]) {
            const reused = finish(baseline, capture, cache), fresh = finish(baseline, capture);
            assert.deepEqual(reused.hunks, fresh.hunks); assert.equal(reused.lineEdits, fresh.lineEdits);
            reconstruct(reused, source, capture.slice(0, capture.length));
            assert.ok(reused.readUnits < source.length / 3, `${length}/${shared}: ${reused.readUnits} warm read units`);
            assert.equal(JSON.stringify(exact.hunks), before);
        }
        cache.dispose();
    }
});

for (const [count, period] of [[2000, 2000], [20000, 20]] as const) test(`matched-row edits repair exact alignment across split/join histories: ${count}/${period}`, () => {
    const rows = Array.from({ length: count }, (_, i) => `row ${i % period}\n`), original = rows.join("");
    let lines = rows.map((row, i) => i % 10 === 0 ? row.replace("row ", "changed ") : row);
    const baseline = TextBuffer.from(original), cache = new DiffReferenceCache(); let working = TextBuffer.from(lines.join(""));
    const initial = finish(baseline, working, cache), retained = JSON.stringify(initial.hunks);
    const edit = (from: number, to: number, insert: readonly string[], local: boolean) => {
        working = working.replace(working.offsetAt(from), working.offsetAt(to), insert.join(""));
        lines = [...lines.slice(0, from), ...insert, ...lines.slice(to)];
        const result = finish(baseline, working, cache), expected = finish(baseline, TextBuffer.from(lines.join("")));
        assert.deepEqual(result.hunks, expected.hunks); assert.equal(result.lineEdits, expected.lineEdits);
        reconstruct(result, original, lines.join("")); assert.equal(JSON.stringify(initial.hunks), retained);
        if (local) {
            assert.ok(result.work < count * 3, `${result.work} units for local repair`);
            assert.ok(result.readUnits < 1024, `${result.readUnits} units reread outside the edit`);
        }
    };
    try {
        const middle = count / 2 + 1, second = middle + 21;
        edit(middle, middle + 1, [lines[middle]!.slice(0, 3) + "\n", lines[middle]!.slice(3)], true);
        edit(second, second + 1, [lines[second]!.slice(0, 3) + "\n", lines[second]!.slice(3)], true);
        edit(middle, middle + 2, [rows[middle]!], true);
        edit(middle - 1, middle, [rows[middle - 1]!], true);
        // A duplicate creates ambiguous optimal matches; long tokens also require fallback.
        edit(middle + 4, middle + 4, [lines[middle + 4]!], false);
        edit(middle + 8, middle + 9, ["x".repeat(257) + "😀\r\n"], false);
    } finally { cache.dispose(); }
});

test("optional alignment certification bounds cold work when shared outer spans dwarf the changed region", () => {
    for (const count of [10000, 60000]) {
        const original = Array.from({ length: count }, (_, i) => `row ${i % 20}\n`).join(""), baseline = TextBuffer.from(original);
        const edits = Array.from({ length: 80 }, (_, i) => {
            const from = baseline.offsetAt(count / 2 + i * 10); return { from, to: from + 3, insert: "changed" };
        });
        const working = baseline.apply(edits).buffer, cache = new DiffReferenceCache();
        try {
            const result = finish(baseline, working, cache), expected = finish(baseline, working);
            assert.deepEqual(result.hunks, expected.hunks); assert.equal(result.lineEdits, expected.lineEdits);
            reconstruct(result, original, working.slice(0, working.length));
            assert.ok(result.work < expected.work * 2 + 4096, `${count}: ${result.work}/${expected.work} cold work`);
            assert.ok(result.readUnits < 64000, `${count}: ${result.readUnits} UTF-16 units read`);
        } finally { cache.dispose(); }
    }
});

test("distant small edits keep alignment storage independent of unchanged row count", context => {
    const allocations: number[] = [], Native = Int32Array;
    context.mock.method(globalThis, "Int32Array", new Proxy(Native, { construct(target, args) {
        const array = Reflect.construct(target, args) as Int32Array; allocations.push(array.length); return array;
    } }));
    for (const count of [256, 100000]) {
        const original = Array.from({ length: count }, (_, i) => `row${i}\n`).join(""), baseline = TextBuffer.from(original);
        const working = baseline.apply([{ from: 0, to: 1, insert: "R" }, { from: original.length - 2, to: original.length - 1, insert: "!" }]).buffer;
        const expected = "R" + original.slice(1, -2) + "!\n"; allocations.length = 0;
        const result = finish(baseline, working);
        reconstruct(result, original, expected); assert.equal(result.hunks.length, 2); assert.equal(result.lineEdits, 4);
        assert.ok(allocations.length > 0, "exercise the alignment frontier");
        assert.ok(allocations.reduce((total, size) => total + size, 0) < 128, `allocated ${allocations} frontier slots for ${count} rows`);
        assert.ok(result.work < 20000); assert.ok(result.readUnits < 4096);
    }
});

test("disjoint long-line blocks retain linear scanning and lazy hash collisions still require exact equality", () => {
    const a = Array.from({ length: 300 }, (_, i) => `baseline ${i} ` + "x".repeat(1000) + "\n").join("");
    const b = Array.from({ length: 300 }, (_, i) => `working ${i}  ` + "y".repeat(1000) + "\n").join("");
    const result = finish(TextBuffer.from(a), TextBuffer.from(b));
    reconstruct(result, a, b); assert.equal(result.hunks.length, 1); assert.equal(result.lineEdits, 600);
    assert.ok(result.lineComparisons < 20); assert.ok(result.readUnits < (a.length + b.length) * 2);
    const [left, right] = collidingDiffLines("long"), ca = left.repeat(2), cb = right.repeat(2);
    const collision = finish(TextBuffer.from(ca), TextBuffer.from(cb));
    assert.equal(collision.lineEdits, 4); reconstruct(collision, ca, cb);
});

test("independent remote references reuse working metadata across shifted suffixes and split or joined rows", () => {
    const source = Array.from({ length: 4000 }, (_, i) => `value${i} = 123;`).join("\n"), remote = TextBuffer.from("remote " + source);
    const cache = new DiffReferenceCache(); let working = TextBuffer.from(source), text = source;
    finish(remote, working, cache);
    for (let i = 0; i < 36; i++) {
        const from = i % 3 === 0 ? 0 : i % 3 === 1 ? Math.floor(text.length / 2) : text.length;
        const to = Math.min(text.length, from + (i % 4 === 0 ? 4 : 0)), insert = ["z", "\n", "\r\n", ""][i % 4]!;
        working = working.replace(from, to, insert); text = text.slice(0, from) + insert + text.slice(to);
        const reused = finish(remote, working, cache), fresh = finish(remote, TextBuffer.from(text));
        assert.deepEqual(reused.hunks, fresh.hunks); assert.equal(reused.lineEdits, fresh.lineEdits); reconstruct(reused, "remote " + source, text);
        assert.ok(reused.readUnits < fresh.readUnits / 10, `${reused.readUnits}/${fresh.readUnits}`);
    }
    cache.dispose();
});

test("many separated changes retain exact alignment and bounded work for unique and repeated rows", () => {
    for (const [count, period, stride, variation, hunks, coldLimit, warmLimit] of [
        [100000, 100000, 100, "ordered", 1000, 13000000, 15000000],
        // The ordered capture includes a bounded initial count-index/certificate pass.
        [10000, 10000, 10, "ordered", 1000, 1000000, 600000],
        [10000, 20, 10, "ordered", 1000, 1100000, 850000],
        [10000, 20, 10, "extra", 1068, 10000000, 10000000],
        [10000, 20, 10, "crossed", 1500, 14000000, 14000000]
    ] as const) {
        const source = Array.from({ length: count }, (_, i) => `row ${i % period}\n`).join(""), baseline = TextBuffer.from(source);
        let text = source.replace(/^row (\d+)$/gm, (line, n: string) => Number(n) % stride === 0 ? "changed " + n : line);
        if (variation === "extra") text = text.replaceAll("row 11\n", "row 11\nrow 11\n");
        if (variation === "crossed") text = text.replaceAll("row 11\nrow 12\n", "row 12\nrow 11\n");
        const working = TextBuffer.from(text), cache = new DiffReferenceCache();
        const cold = finish(baseline, working, cache), changed = working.replace(working.length, working.length, "z");
        const warm = finish(baseline, changed, cache), fresh = finish(baseline, changed);
        assert.deepEqual(warm.hunks, fresh.hunks); reconstruct(warm, source, text + "z");
        assert.equal(cold.hunks.length, hunks); assert.equal(warm.hunks.length, hunks + 1);
        assert.ok(cold.work < coldLimit, `${count}/${period}/${variation}: ${cold.work} cold units`);
        assert.ok(warm.work < warmLimit, `${count}/${period}/${variation}: ${warm.work} warm units`);
        cache.dispose();
    }
});

test("tail-only warmup retains sparse coverage through distant edits, undo and redo without indexing the intervening 100k rows", () => {
    const original = Array.from({ length: 100000 }, (_, i) => `const value${String(i).padStart(6, "0")} = 123;`).join("\n");
    const baseline = TextBuffer.from(original), text = original + "\nreview-tail", working = baseline.replace(baseline.length, baseline.length, "\nreview-tail");
    const cache = new DiffReferenceCache(); finish(baseline, working, cache);
    for (const at of [0, 50000 * 25]) {
        const changed = working.replace(at, at + 7, ""), expected = text.slice(0, at) + text.slice(at + 7);
        for (const value of [changed, working, changed, working]) {
            const result = finish(baseline, value, cache), fresh = finish(baseline, value);
            assert.deepEqual(result.hunks, fresh.hunks); assert.equal(result.lineEdits, fresh.lineEdits);
            assert.ok(result.readUnits < 20000, `${at}: ${result.readUnits}`);
            reconstruct(result, original, value === working ? text : expected);
        }
    }
    cache.dispose();
});

test("edits to unmatched rows reuse raw alignment and re-trim exact hunks through history", () => {
    const original = Array.from({ length: 2000 }, (_, i) => `row ${i % 20}\n`).join("");
    const text = original.replace(/^row (\d+)$/gm, (line, n: string) => Number(n) % 10 === 0 ? "changed " + n : line)
        .replaceAll("row 11\n", "row 11\nrow 11\n");
    const baseline = TextBuffer.from(original), working = TextBuffer.from(text), cache = new DiffReferenceCache();
    const initial = finish(baseline, working, cache), retained = JSON.stringify(initial.hunks);
    const at = text.indexOf("changed ", Math.floor(text.length / 2));
    const typed = working.replace(at + 3, at + 3, "😀é\ud800"), trimmed = typed.replace(at, at + 7, " \t");
    for (const capture of [typed, trimmed, typed, working]) {
        const result = finish(baseline, capture, cache), expected = finish(baseline, capture);
        assert.deepEqual(result.hunks, expected.hunks); assert.equal(result.lineEdits, expected.lineEdits);
        reconstruct(result, original, capture.slice(0, capture.length));
        assert.ok(result.work < 10000, `${result.work} units for unchanged line alignment`);
        assert.equal(JSON.stringify(initial.hunks), retained);
    }
    // Enter changes the equality matrix; unchanged recursive regions still retain their decisions.
    finish(baseline, working, cache);
    const split = working.replace(at + 3, at + 3, "\n"), splitResult = finish(baseline, split, cache), splitExpected = finish(baseline, split);
    assert.deepEqual(splitResult.hunks, splitExpected.hunks); assert.equal(splitResult.lineEdits, splitExpected.lineEdits);
    reconstruct(splitResult, original, split.slice(0, split.length));
    assert.ok(splitResult.lineComparisons < splitExpected.lineComparisons * 0.85, "reuse completed subregion decisions as well as frontier waves");
    assert.ok(splitResult.work < splitExpected.work * 0.75, "nearby Enter retains enough completed search to reduce total charged work");
    // Changed equality/row counts re-run alignment, but can resume unaffected frontier waves.
    for (const insert of ["row 0\n", "new\nrow\n", "x".repeat(300) + "\n"]) {
        finish(baseline, working, cache);
        const capture = working.replace(at, text.indexOf("\n", at) + 1, insert);
        const result = finish(baseline, capture, cache), expected = finish(baseline, capture);
        assert.deepEqual(result.hunks, expected.hunks); assert.equal(result.lineEdits, expected.lineEdits);
        reconstruct(result, original, capture.slice(0, capture.length));
        assert.ok(result.lineComparisons < expected.lineComparisons * 0.9, "resume a proven wave instead of repeating the entire frontier");
    }
    cache.dispose();
});

for (const [count, fraction, maximumColdRatio] of [[10000, 0.25, 0.6], [10000, 0.5, 0.48], [10000, 0.75, 0.8], [20000, 0.5, 0.45]] as const)
    test(`edited-region distance bounds reduce ${count}/${fraction} Enter work without changing canonical hunks`, () => {
        const original = Array.from({ length: count }, (_, i) => `row ${i % 20}\n`).join("");
        const text = original.replaceAll("row 0\n", "changed 0\n").replaceAll("row 10\n", "changed 10\n").replaceAll("row 11\n", "row 11\nrow 11\n");
        const baseline = TextBuffer.from(original), working = TextBuffer.from(text), cache = new DiffReferenceCache();
        try {
            const initial = finish(baseline, working, cache), retained = JSON.stringify(initial.hunks);
            const at = text.indexOf("changed ", Math.floor(text.length * fraction)); assert.ok(at >= 0);
            const edited = working.replace(at + 3, at + 3, "\n");
            const result = finish(baseline, edited, cache), expected = finish(baseline, edited);
            assert.deepEqual(result.hunks, expected.hunks); assert.equal(result.lineEdits, expected.lineEdits);
            reconstruct(result, original, edited.slice(0, edited.length));
            assert.ok(result.work < expected.work * maximumColdRatio, `${fraction}: ${result.work} warm / ${expected.work} cold work`);
            if (count === 10000 && fraction === 0.5) {
                // A cheap first split must leave useful decisions for later edits and history.
                const typed = edited.replace(at + 5, at + 5, "!");
                const typedText = typed.slice(0, typed.length), distantAt = typedText.indexOf("changed ", typedText.length * 0.75) + 3;
                assert.ok(distantAt > at);
                const distant = typed.replace(distantAt, distantAt, "\n");
                const history = [["type", typed, 20_000], ["distant Enter", distant, 5_700_000],
                    ["undo distant", typed, 5_700_000], ["undo type", edited, 20_000], ["undo Enter", working, 4_400_000],
                    ["redo Enter", edited, 4_400_000], ["redo type", typed, 20_000], ["redo distant", distant, 5_700_000]] as const;
                for (const [label, capture, maximumWork] of history) {
                    const warm = finish(baseline, capture, cache), fresh = finish(baseline, capture);
                    assert.deepEqual(warm.hunks, fresh.hunks); assert.equal(warm.lineEdits, fresh.lineEdits);
                    reconstruct(warm, original, capture.slice(0, capture.length));
                    assert.ok(warm.work < maximumWork, label + ": " + warm.work + " work must preserve reuse across successive captures");
                }
            }
            if (count === 20000) {
                const second = edited.replace(at + 5, at + 5, "\n");
                for (const capture of [second, edited, second]) {
                    const warm = finish(baseline, capture, cache), fresh = finish(baseline, capture);
                    assert.deepEqual(warm.hunks, fresh.hunks); assert.equal(warm.lineEdits, fresh.lineEdits);
                    reconstruct(warm, original, capture.slice(0, capture.length));
                    assert.ok(warm.work < fresh.work * maximumColdRatio, "successive Enter and undo/redo retain the cheaper exact split");
                }
            }
            assert.equal(JSON.stringify(initial.hunks), retained);
        } finally { cache.dispose(); }
    });

for (const fraction of [0.25, 0.5, 0.75]) test(`comparison decision reuse survives cancellation and failure without publishing superseded captures: ${fraction}`, () => {
    const original = Array.from({ length: 2000 }, (_, i) => `row ${i % 20}\n`).join("");
    const text = original.replaceAll("row 0\n", "changed 0\n").replaceAll("row 10\n", "changed 10\n").replaceAll("row 11\n", "row 11\nrow 11\n");
    const baseline = TextBuffer.from(original), working = TextBuffer.from(text), cache = new DiffReferenceCache();
    const at = text.indexOf("changed ", text.length * fraction) + 3, split = working.replace(at, at, "\n");
    const expected = finish(baseline, split);
    assert.ok(finish(baseline, working, cache).lineComparisons >= 100000, "retain an eligible expensive frontier");
    const cancelled = new TextDiff(baseline, split, cache); let partial = cancelled.next(512);
    // Cancel after actual search progress, independently of the completed cold job's cost.
    while (partial.status === "running" && partial.lineComparisons < 256) partial = cancelled.next(512);
    assert.ok(partial.lineComparisons >= 256);
    assert.equal(partial.status, "running"); cancelled.dispose();
    const slice = TextBuffer.prototype.slice, failure = new Error("captured frontier read failed");
    const failed = new TextDiff(baseline, split, cache);
    try {
        TextBuffer.prototype.slice = function (from, to) { if (this === split) throw failure; return slice.call(this, from, to); };
        assert.throws(() => { while (failed.next(512).status === "running") { /* Stop at the captured read. */ } }, error => error === failure);
        assert.equal(failed.snapshot().status, "failed");
    } finally { TextBuffer.prototype.slice = slice; failed.dispose(); }
    const resumed = finish(baseline, split, cache);
    assert.deepEqual(resumed.hunks, expected.hunks);
    assert.ok(resumed.lineComparisons < expected.lineComparisons * 0.85, "failed/cancelled captures preserve completed split and frontier decisions");
    finish(baseline, working, cache);
    const old = new TextDiff(baseline, split, cache); assert.equal(old.next(4096).status, "running");
    finish(baseline, baseline, cache); // A newer successful comparison clears the retained plans.
    let late = old.next(512); while (late.status === "running") late = old.next(512);
    assert.deepEqual(late.hunks, expected.hunks); old.dispose();
    const after = finish(baseline, split, cache);
    assert.deepEqual(after.hunks, expected.hunks);
    assert.ok(after.lineComparisons > expected.lineComparisons * 0.95, "a stale completion cannot republish its saved frontier");
    cache.dispose();
});

test("a superseded raw alignment cannot replace a newer successful cache capture", () => {
    const original = Array.from({ length: 2000 }, (_, i) => `row ${i % 20}\n`).join("");
    const text = original.replaceAll("row 0\n", "changed\n").replaceAll("row 10\n", "changed ten\n").replaceAll("row 11\n", "row 11\nrow 11\n");
    const baseline = TextBuffer.from(original), working = TextBuffer.from(text), cache = new DiffReferenceCache();
    assert.ok(finish(baseline, working, cache).lineComparisons >= 100000);
    const at = text.indexOf("changed", text.length / 2), changed = working.replace(at, at, "z");
    const old = new TextDiff(baseline, changed, cache); assert.equal(old.next(256).status, "running");
    finish(baseline, baseline, cache); // The newer successful capture has no retained change plan.
    let stale = old.next(512); while (stale.status === "running") stale = old.next(512);
    assert.equal(stale.status, "ready"); old.dispose();
    const result = finish(baseline, changed, cache); assert.deepEqual(result.hunks, stale.hunks);
    assert.ok(result.work > 100000, "the late result did not republish its cheap reusable plan");
    const next = changed.replace(at, at, "y"), reused = finish(baseline, next, cache);
    assert.ok(reused.work < 10000); assert.deepEqual(reused.hunks, finish(baseline, next).hunks); cache.dispose();
});

test("periodic row alignment verifies long exact runs without probing every repeated line", () => {
    for (const period of [1, 2, 3, 4]) {
        const original = Array.from({ length: 5000 }, (_, i) => `const name${i % period} = 1234567;`).join("\n");
        const baseline = TextBuffer.from(original), tail = original + "\nreview-tail", working = baseline.replace(baseline.length, baseline.length, "\nreview-tail");
        const cache = new DiffReferenceCache(); finish(baseline, working, cache);
        const changed = working.replace(0, 7, ""), result = finish(baseline, changed, cache);
        reconstruct(result, original, tail.slice(7)); assert.equal(result.hunks.length, 2);
        assert.deepEqual(result.hunks, finish(baseline, changed).hunks);
        assert.ok(result.readUnits < original.length * 2 + 8192, `${period}: ${result.readUnits} units; establish each long run once`);
        assert.ok(result.lineComparisons < 128, `${period}: ${result.lineComparisons}`); cache.dispose();
    }
});

test("cancelled and concurrent index captures cannot publish stale working or replacement-reference data", () => {
    const baseline = TextBuffer.from("A\r\n".repeat(2000)), cache = new DiffReferenceCache();
    const old = new TextDiff(baseline, TextBuffer.from("old\n".repeat(2000)), cache); old.next(512);
    const first = new TextDiff(baseline, baseline.replace(30, 32, "first"), cache), secondWorking = baseline.replace(900, 900, "second\n");
    const second = new TextDiff(baseline, secondWorking, cache); first.next(512); second.next(512); first.dispose();
    let result = second.next(512); while (result.status === "running") result = second.next(512);
    let stale = old.next(512); while (stale.status === "running") stale = old.next(512);
    const expected = finish(baseline, secondWorking); assert.deepEqual(result.hunks, expected.hunks);
    const replacement = TextBuffer.from("other\n"), newResult = finish(replacement, secondWorking, cache), fresh = finish(replacement, secondWorking);
    assert.deepEqual(newResult.hunks, fresh.hunks); old.dispose(); second.dispose(); cache.dispose();
    assert.throws(() => new TextDiff(baseline, secondWorking, cache), /disposed/);
});
