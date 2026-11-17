import test from "node:test";
import assert from "node:assert/strict";
import { TextBuffer, TextDiff, FoldIndex, createFoldRegions } from "../src/index.ts";
import { ComparisonRowsCursor } from "../src/core/comparison-rows.ts";
import type { ComparisonRows } from "../src/core/comparison-rows.ts";
function capture(a: string, b: string) { const baseline = TextBuffer.from(a), working = TextBuffer.from(b), diff = new TextDiff(baseline, working); let result = diff.next(32768); while (result.status === "running") result = diff.next(32768); return { baseline, working, hunks: result.hunks }; }
function finish(cursor: ComparisonRowsCursor): ComparisonRows { let work = 0; for (;;) { const step = cursor.next(256); assert.ok(step.work >= work && step.work - work <= 256); work = step.work; if (step.status === "ready") { cursor.dispose(); return step.result!; } assert.equal(step.status, "running"); assert.equal(step.result, null); } }
function realRows(rows: ComparisonRows, side: "baseline" | "working") { const index = rows[side], lines: number[] = []; for (let row = 0; row < rows.rowCount; row++) if (!index.gapAt(row)) { const line = index.lineAt(row); assert.equal(index.rowAt(line), row); lines.push(line); } return lines; }
test("aligned slots preserve exact source rows across scalar trims, inline/newline changes and empty/EOF sources", () => {
    for (const a of ["", "a", "a\n", "a\r\nb", "same\nline\nend", "😀é\r\nlast", "a\nb\nc\n"]) for (const b of ["", "x", "a\n", "aX\r\nb", "same\nnew\nline\nend", "😀élast", "a\nb"]) {
        const c = capture(a, b), rows = finish(new ComparisonRowsCursor(c.baseline, c.working, c.hunks));
        assert.deepEqual(realRows(rows, "baseline"), Array.from({ length: c.baseline.lineCount }, (_, i) => i));
        assert.deepEqual(realRows(rows, "working"), Array.from({ length: c.working.lineCount }, (_, i) => i));
        assert.equal(c.baseline.readMetrics().textExports, 0); assert.equal(c.working.readMetrics().textExports, 0);
    }
    const c = capture("one\ntwo\nthree", "one\nadded\nmore\ntwo\nthree"), rows = finish(new ComparisonRowsCursor(c.baseline, c.working, c.hunks));
    assert.equal(rows.baseline.rowAt(1), rows.working.rowAt(3)); assert.equal(rows.baseline.gapAt(1)!.offset, 4); assert.equal(rows.baseline.nextLine(1, -1), 0); assert.equal(rows.baseline.nextLine(1, 1), 1);
});
test("generated edits retain every real row and align unique unchanged lines", () => {
    let seed = 95471; const random = (n: number) => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) % n; };
    for (let trial = 0; trial < 300; trial++) {
        const a = Array.from({ length: 40 }, (_, i) => `original ${i} café😀;`), b = a.slice();
        for (let edit = 0; edit < 6; edit++) b.splice(random(b.length), random(4), ...Array.from({ length: random(5) }, (_, i) => `new ${edit}.${i};`));
        const c = capture(a.join("\r\n"), b.join("\r\n")), rows = finish(new ComparisonRowsCursor(c.baseline, c.working, c.hunks));
        assert.deepEqual(realRows(rows, "baseline"), a.map((_, i) => i)); assert.deepEqual(realRows(rows, "working"), b.map((_, i) => i));
        // Exact line tokens include their terminator. A retained body at a new EOF is changed.
        for (let line = 0; line < a.length; line++) { const target = b.indexOf(a[line]!); if (target >= 0 && (line === a.length - 1) === (target === b.length - 1)) assert.equal(rows.baseline.rowAt(line), rows.working.rowAt(target), `${trial} ${line}`); }
    }
});
test("independent nested folds hide source rows without losing shared alignment or exposing hidden caret anchors", () => {
    const c = capture("a\nb\nc\nd\ne\nf\ng\nh\n", "a\nb\nc\nd\ne\nf\ng\nh\n");
    const fold = (buffer: TextBuffer, from: number, to: number) => new FoldIndex(buffer.lineCount, createFoldRegions(buffer, [{ id: "outer", from: buffer.offsetAt(from), to: buffer.offsetAt(to), collapsed: true }, { id: "inner", from: buffer.offsetAt(from + 1), to: buffer.offsetAt(to - 1), collapsed: true }]));
    const af = fold(c.baseline, 1, 7), one = finish(new ComparisonRowsCursor(c.baseline, c.working, c.hunks, af));
    assert.equal(one.rowCount, c.working.lineCount); assert.deepEqual(realRows(one, "baseline"), [0, 1, 7, 8]); assert.equal(one.baseline.gapAt(4)!.offset, c.baseline.offsetAt(1));
    assert.equal(one.baseline.rowAt(5), one.baseline.rowAt(1)); assert.equal(one.baseline.nextLine(4, 1), 7); assert.equal(one.baseline.nextLine(4, -1), 1);
    const both = finish(new ComparisonRowsCursor(c.baseline, c.working, c.hunks, af, fold(c.working, 1, 7))); assert.equal(both.rowCount, 4); assert.deepEqual(realRows(both, "working"), [0, 1, 7, 8]);
});
test("huge inserted spans stay sparse and cancellation or invalid captures publish no partial row model", () => {
    const c = capture("start\nend", "start\n" + "inserted\n".repeat(100000) + "end"), cursor = new ComparisonRowsCursor(c.baseline, c.working, c.hunks), rows = finish(cursor);
    assert.ok(rows.runCount < 10); assert.equal(rows.rowCount, 100002); assert.equal(rows.baseline.rowAt(1), 100001); assert.equal(rows.baseline.gapAt(50000)!.offset, 6);
    const folds = new FoldIndex(c.working.lineCount, createFoldRegions(c.working, Array.from({ length: 300 }, (_, i) => ({ id: `fold-${i}`,
        from: c.working.offsetAt(i * 300 + 1), to: c.working.offsetAt(i * 300 + 4), collapsed: true }))));
    const cancelled = new ComparisonRowsCursor(c.baseline, c.working, c.hunks, undefined, folds), initial = cancelled.snapshot();
    assert.deepEqual(initial, { status: "running", work: 0, result: null, failure: null }); assert.ok(Object.isFrozen(initial));
    assert.throws(() => cancelled.next(255), RangeError); assert.deepEqual(cancelled.snapshot(), initial);
    const first = cancelled.next(); assert.equal(first.status, "running"); assert.equal(first.work, 256); assert.equal(first.result, null);
    assert.equal(initial.work, 0); cancelled.dispose(); assert.equal(cancelled.next().status, "disposed"); assert.equal(cancelled.snapshot().result, null);
    assert.throws(() => new ComparisonRowsCursor(c.baseline, c.working, [...c.hunks])); assert.throws(() => new ComparisonRowsCursor(c.baseline, c.working, c.hunks, new FoldIndex(3, [])));
    const invalid = new ComparisonRowsCursor(c.baseline, c.working, Object.freeze([Object.freeze({ baseline: Object.freeze({ from: -1, to: 0, lineFrom: 0, lineTo: 0 }), working: Object.freeze({ from: 0, to: 0, lineFrom: 0, lineTo: 0 }), whitespaceOnly: false })])); assert.throws(() => invalid.next(), /Invalid comparison hunk/);
    assert.equal(invalid.snapshot().status, "failed"); assert.equal(invalid.snapshot().result, null); assert.equal(invalid.next().failure, "Invalid comparison hunk.");
});

test("alignment reuses indexed hidden boundaries without visiting expanded or hidden nested folds", () => {
    const buffer = TextBuffer.from("x\n".repeat(100000));
    const ranges = Array.from({ length: 20000 }, (_, i) => ({ id: `fold-${i}`, from: buffer.offsetAt(i * 5), to: buffer.offsetAt(i * 5 + 4) }));
    const expanded = new FoldIndex(buffer.lineCount, createFoldRegions(buffer, ranges));
    assert.deepEqual([...expanded.collapsedRegions()], []);
    const cursor = new ComparisonRowsCursor(buffer, buffer, Object.freeze([]), expanded, expanded), step = cursor.next(256);
    assert.equal(step.work, 1); assert.equal(step.result!.runCount, 1); assert.equal(step.result!.rowCount, buffer.lineCount); cursor.dispose();
    const regions = createFoldRegions(buffer, [...ranges, { id: "nested", from: buffer.offsetAt(1), to: buffer.offsetAt(3), collapsed: true }]
        .map(r => r.id === "fold-0" || r.id === "fold-19999" ? { ...r, collapsed: true } : r));
    const collapsed = new FoldIndex(buffer.lineCount, regions);
    assert.deepEqual([...collapsed.collapsedRegions()].map(r => r.id), ["fold-0", "fold-19999"]);
    const mixed = new ComparisonRowsCursor(buffer, buffer, Object.freeze([]), collapsed, expanded), result = mixed.next(256);
    assert.ok(result.work < 10); assert.equal(result.result!.baseline.gapAt(2)!.line, 0);
    assert.equal(result.result!.baseline.gapAt(99997)!.line, 99995); assert.equal(result.result!.working.lineAt(99997), 99997); mixed.dispose();
});
