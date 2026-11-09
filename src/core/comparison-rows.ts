import type { DiffHunk } from "./diff.ts";
import { FoldIndex } from "./folding.ts";
import type { FoldRegion } from "./folding.ts";
import type { TextBuffer } from "./text-buffer.ts";

type Side = "baseline" | "working";
type Run = Readonly<{ row: number; length: number; baseline: number | null; working: number | null; baselineAnchor: number; workingAnchor: number }>;
type Hidden = Readonly<{ from: number; to: number; header: number }>;
type Span = { a0: number; a1: number; b0: number; b1: number };
export type ComparisonGap = Readonly<{ line: number; offset: number }>;

/** Immutable sparse source/visual coordinates. Padding has no source characters. */
class ComparisonRowIndex {
    readonly lineCount: number;
    readonly visibleLineCount: number;
    readonly collapsedCount: number;
    readonly regions: readonly FoldRegion[];
    readonly #buffer: TextBuffer;
    readonly #folds: FoldIndex;
    readonly #runs: readonly Run[];
    readonly #real: readonly Run[];
    readonly #side: Side;
    constructor(buffer: TextBuffer, folds: FoldIndex, runs: readonly Run[], real: readonly Run[], side: Side, count: number) {
        this.#buffer = buffer; this.#folds = folds; this.#runs = runs; this.#real = real; this.#side = side;
        this.lineCount = buffer.lineCount; this.visibleLineCount = count; this.collapsedCount = folds.collapsedCount; this.regions = folds.regions;
        Object.freeze(this);
    }
    matches(buffer: TextBuffer, folds: FoldIndex): boolean { return this.#buffer === buffer && this.#folds === folds; }
    hiddenBy(line: number): FoldRegion | undefined { return this.#folds.hiddenBy(line); }
    headerAt(line: number): FoldRegion | undefined { return this.#folds.headerAt(line); }
    #run(row: number): Run {
        if (!Number.isSafeInteger(row) || row < 0 || row >= this.visibleLineCount) throw new RangeError("Invalid aligned row.");
        let low = 0, high = this.#runs.length;
        while (low < high) { const mid = (low + high) >>> 1; if (this.#runs[mid]!.row <= row) low = mid + 1; else high = mid; }
        return this.#runs[low - 1]!;
    }
    #anchor(run: Run): ComparisonGap {
        const boundary = this.#side === "baseline" ? run.baselineAnchor : run.workingAnchor, source = Math.min(this.lineCount - 1, boundary);
        const hidden = this.#folds.hiddenBy(source), line = hidden?.lineFrom ?? source;
        return Object.freeze({ line, offset: hidden ? this.#buffer.offsetAt(line) : boundary === this.lineCount ? this.#buffer.length : this.#buffer.offsetAt(line) });
    }
    rowAt(line: number): number {
        line = this.#folds.hiddenBy(line)?.lineFrom ?? line;
        let low = 0, high = this.#real.length;
        while (low < high) { const mid = (low + high) >>> 1; if (this.#real[mid]![this.#side]! <= line) low = mid + 1; else high = mid; }
        const run = this.#real[low - 1];
        if (!run || line >= run[this.#side]! + run.length) throw new Error("Source row is missing from comparison alignment.");
        return run.row + line - run[this.#side]!;
    }
    lineAt(row: number): number { const run = this.#run(row), line = run[this.#side]; return line === null ? this.#anchor(run).line : line + row - run.row; }
    gapAt(row: number): ComparisonGap | undefined { const run = this.#run(row); return run[this.#side] === null ? this.#anchor(run) : undefined; }
    /** Page destinations stay on real source rows, even when the page lies entirely in padding. */
    nextLine(row: number, direction: -1 | 1): number {
        row = Math.max(0, Math.min(this.visibleLineCount - 1, row));
        let low = 0, high = this.#real.length;
        while (low < high) { const mid = (low + high) >>> 1; if (this.#real[mid]!.row <= row) low = mid + 1; else high = mid; }
        const before = this.#real[low - 1];
        if (before && row < before.row + before.length) return before[this.#side]! + row - before.row;
        const run = direction > 0 ? this.#real[low] ?? this.#real.at(-1)! : before ?? this.#real[0]!;
        return run[this.#side]! + (direction < 0 || direction > 0 && run.row < row ? run.length - 1 : 0);
    }
}
export type { ComparisonRowIndex };
export type ComparisonRows = Readonly<{ baseline: ComparisonRowIndex; working: ComparisonRowIndex; rowCount: number; runCount: number }>;

function bounds(a: TextBuffer, b: TextBuffer, h: DiffHunk): Span {
    if (!Object.isFrozen(h) || !Object.isFrozen(h.baseline) || !Object.isFrozen(h.working)) throw new Error("Comparison hunks must be immutable captures.");
    for (const [buffer, range] of [[a, h.baseline], [b, h.working]] as const)
        if (!Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to) || range.from < 0 || range.from > range.to || range.to > buffer.length) throw new RangeError("Invalid comparison hunk.");
    if (h.baseline.from === h.baseline.to && h.working.from === h.working.to) throw new RangeError("Empty comparison hunk.");
    const ae = a.lineAt(h.baseline.to), be = b.lineAt(h.working.to);
    // Scalar trimming can leave either end inside a row. Include that row on BOTH sides:
    // deleting a newline merges the following source row into the preceding target row.
    const partial = h.baseline.to !== a.offsetAt(ae) || h.working.to !== b.offsetAt(be);
    return { a0: a.lineAt(h.baseline.from), a1: ae + Number(partial), b0: b.lineAt(h.working.from), b1: be + Number(partial) };
}
function* plan(a: TextBuffer, b: TextBuffer, hunks: readonly DiffHunk[], af: FoldIndex, bf: FoldIndex): Generator<void, ComparisonRows> {
    const ah: Hidden[] = [], bh: Hidden[] = [];
    for (const [folds, hidden] of [[af, ah], [bf, bh]] as const) for (const r of folds.regions) {
        if (r.collapsed && (!hidden.length || r.lineFrom >= hidden.at(-1)!.to)) hidden.push({ from: r.lineFrom + 1, to: r.lineTo, header: r.lineFrom });
        yield;
    }
    const runs: Run[] = [], ar: Run[] = [], br: Run[] = []; let rows = 0, ai = 0, bi = 0, ac = 0, bc = 0;
    const visible = (line: number | null, length: number, side: Side) => {
        if (line === null) return { line, length, header: -1 };
        const hidden = side === "baseline" ? ah : bh; let at = side === "baseline" ? ai : bi;
        while (hidden[at] && hidden[at]!.to <= line) at++;
        if (side === "baseline") ai = at; else bi = at;
        const h = hidden[at];
        return h && h.from <= line ? { line: null, length: Math.min(length, h.to - line), header: h.header }
            : { line, length: Math.min(length, h ? h.from - line : length), header: -1 };
    };
    function* emit(a0: number, na: number, b0: number, nb: number): Generator<void> {
        const paired = Math.min(na, nb), length = Math.max(na, nb); let at = 0;
        while (at < length) {
            const limit = at < paired ? paired - at : length - at;
            const av = visible(at < na ? a0 + at : null, limit, "baseline"), bv = visible(at < nb ? b0 + at : null, limit, "working");
            const count = Math.min(av.length, bv.length); if (count < 1) throw new Error("Alignment did not advance.");
            if (av.line !== null || bv.line !== null) {
                const run = Object.freeze({ row: rows, length: count, baseline: av.line, working: bv.line,
                    baselineAnchor: av.header >= 0 ? av.header : a0 + Math.min(at, na), workingAnchor: bv.header >= 0 ? bv.header : b0 + Math.min(at, nb) });
                runs.push(run); if (run.baseline !== null) ar.push(run); if (run.working !== null) br.push(run);
                rows += count; if (!Number.isSafeInteger(rows)) throw new RangeError("Too many aligned rows.");
            }
            at += count; yield;
        }
    }
    function* flush(span: Span): Generator<void> {
        if (span.a0 < ac || span.b0 < bc || span.a0 - ac !== span.b0 - bc) throw new Error("Comparison line boundaries disagree.");
        yield* emit(ac, span.a0 - ac, bc, span.b0 - bc);
        yield* emit(span.a0, span.a1 - span.a0, span.b0, span.b1 - span.b0); ac = span.a1; bc = span.b1;
    }
    let pending: Span | undefined, endA = -1, endB = -1;
    for (const h of hunks) {
        if (h.baseline.from < endA || h.working.from < endB) throw new RangeError("Unordered comparison hunks.");
        const span = bounds(a, b, h); endA = h.baseline.to; endB = h.working.to;
        if (pending && (span.a0 <= pending.a1 || span.b0 <= pending.b1)) { pending.a1 = Math.max(pending.a1, span.a1); pending.b1 = Math.max(pending.b1, span.b1); }
        else { if (pending) yield* flush(pending); pending = span; }
        yield;
    }
    if (pending) yield* flush(pending);
    if (a.lineCount - ac !== b.lineCount - bc) throw new Error("Comparison suffix rows disagree.");
    yield* emit(ac, a.lineCount - ac, bc, b.lineCount - bc);
    if (!rows || !ar.length || !br.length) throw new Error("Comparison lost its source rows.");
    return Object.freeze({ baseline: new ComparisonRowIndex(a, af, runs, ar, "baseline", rows), working: new ComparisonRowIndex(b, bf, runs, br, "working", rows), rowCount: rows, runCount: runs.length });
}

/** Work depends on hunk/fold boundaries, never on the number of unchanged or padded rows. */
export class ComparisonRowsCursor {
    #iterator: Generator<void, ComparisonRows> | undefined;
    #result: ComparisonRows | undefined;
    #work = 0;
    #disposed = false;
    constructor(a: TextBuffer, b: TextBuffer, hunks: readonly DiffHunk[], af = new FoldIndex(a.lineCount, []), bf = new FoldIndex(b.lineCount, [])) {
        if (!Object.isFrozen(hunks) || af.lineCount !== a.lineCount || bf.lineCount !== b.lineCount) throw new Error("Expected captured comparison/fold coordinates.");
        this.#iterator = plan(a, b, hunks, af, bf);
    }
    next(budget = 256): Readonly<{ work: number; result?: ComparisonRows }> {
        if (this.#disposed) throw new Error("Alignment cursor is disposed.");
        if (!Number.isSafeInteger(budget) || budget < 1 || budget > 4096) throw new RangeError("Invalid alignment budget.");
        for (let step = 0; this.#iterator && step < budget; step++) {
            const next = this.#iterator.next();
            if (next.done) { this.#result = next.value; this.#iterator = undefined; } else this.#work++;
        }
        return Object.freeze({ work: this.#work, ...(this.#result ? { result: this.#result } : {}) });
    }
    dispose(): void { this.#disposed = true; this.#iterator = undefined; this.#result = undefined; }
}
