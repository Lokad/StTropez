import { invalidRange, isIndex, isOffsetRange } from "./bounds.ts";
import type { PositionMapping } from "./positions.ts";
import type { DiffHunk } from "./diff.ts";
import { FoldIndex } from "./folding.ts";
import type { FoldRegion } from "./folding.ts";
import type { TextBuffer } from "./text-buffer.ts";
import { kernelCursor } from "./kernel-cursor.ts";
import type { KernelCursor, KernelStatus } from "./kernel-cursor.ts";
import { partitionPoint } from "./bound-search.ts";

// A gap occupies [row, end) in the grid, immediately before a visible source row.
type Gap = Readonly<{ row: number; end: number; before: number; anchor: number }>;
type Hidden = Readonly<{ from: number; to: number; header: number }>;
type Span = { a0: number; a1: number; b0: number; b1: number };
export type ComparisonGap = Readonly<{ line: number; offset: number }>;

/** Immutable sparse source/visual coordinates. Padding has no source characters. */
class ComparisonRowIndex {
    readonly lineCount: number;
    readonly visibleLineCount: number;
    readonly collapsedCount: number;
    get regions(): readonly FoldRegion[] { return this.#folds.regions; }
    readonly #buffer: TextBuffer;
    readonly #folds: FoldIndex;
    readonly #gaps: readonly Gap[];
    constructor(buffer: TextBuffer, folds: FoldIndex, gaps: readonly Gap[]) {
        this.#buffer = buffer;
        this.#folds = folds;
        this.#gaps = gaps;
        this.lineCount = buffer.lineCount;
        this.collapsedCount = folds.collapsedCount;
        const last = gaps.at(-1);
        this.visibleLineCount = folds.visibleLineCount + (last ? last.end - last.before : 0);
        Object.freeze(this);
    }
    matches(buffer: TextBuffer, folds: FoldIndex): boolean { return this.#buffer === buffer && this.#folds === folds; }
    rebind(buffer: TextBuffer, folds: FoldIndex, mapping?: PositionMapping): ComparisonRowIndex | undefined {
        if (this.#folds.sameProjection(folds)) return new ComparisonRowIndex(buffer, folds, this.#gaps);
        if (!mapping) return;
        // Keep existing padding attached to its source boundary until the new diff supplies exact gaps.
        const mapLine = (line: number) => line === this.lineCount ? buffer.lineCount
            : buffer.lineAt(mapping.map(this.#buffer.offsetAt(line), "before").offset);
        let padding = 0;
        const gaps = this.#gaps.map(gap => {
            const before = gap.before === this.#folds.visibleLineCount ? folds.visibleLineCount
                : folds.rowAt(mapLine(this.#folds.lineAt(gap.before)));
            const row = before + padding;
            padding += gap.end - gap.row;
            return { before, row, end: before + padding, anchor: mapLine(gap.anchor) };
        });
        return new ComparisonRowIndex(buffer, folds, gaps);
    }
    hiddenBy(line: number): FoldRegion | undefined { return this.#folds.hiddenBy(line); }
    headerAt(line: number): FoldRegion | undefined { return this.#folds.headerAt(line); }
    #preceding(row: number): Gap | undefined {
        if (!isIndex(row, this.visibleLineCount)) invalidRange("aligned row");
        return this.#gaps[partitionPoint(this.#gaps.length, i => this.#gaps[i]!.row <= row) - 1];
    }
    #anchor({ anchor }: Gap): ComparisonGap {
        const source = Math.min(this.lineCount - 1, anchor);
        const line = this.#folds.hiddenBy(source)?.lineFrom ?? source;
        const offset = line === source && anchor === this.lineCount ? this.#buffer.length : this.#buffer.offsetAt(line);
        return Object.freeze({ line, offset });
    }
    rowAt(line: number): number {
        const before = this.#folds.rowAt(line);
        const gap = this.#gaps[partitionPoint(this.#gaps.length, i => this.#gaps[i]!.before <= before) - 1];
        return before + (gap ? gap.end - gap.before : 0);
    }
    lineAt(row: number): number {
        const gap = this.#preceding(row);
        if (gap && row < gap.end) return this.#anchor(gap).line;
        return this.#folds.lineAt(row - (gap ? gap.end - gap.before : 0));
    }
    gapAt(row: number): ComparisonGap | undefined {
        const gap = this.#preceding(row);
        return gap && row < gap.end ? this.#anchor(gap) : undefined;
    }
    nextLine(row: number, direction: -1 | 1): number {
        row = Math.max(0, Math.min(this.visibleLineCount - 1, row));
        const gap = this.#preceding(row);
        const source = gap && row < gap.end ? gap.before - Number(direction < 0) : row - (gap ? gap.end - gap.before : 0);
        return this.#folds.lineAt(Math.max(0, Math.min(this.#folds.visibleLineCount - 1, source)));
    }
}
export type { ComparisonRowIndex };
export type ComparisonRows = Readonly<{ baseline: ComparisonRowIndex; working: ComparisonRowIndex; rowCount: number; runCount: number }>;

function bounds(a: TextBuffer, b: TextBuffer, h: DiffHunk): Span {
    if (!Object.isFrozen(h) || !Object.isFrozen(h.baseline) || !Object.isFrozen(h.working)) throw new Error("Comparison hunks must be immutable captures.");
    for (const [buffer, range] of [[a, h.baseline], [b, h.working]] as const)
        if (!isOffsetRange(range.from, range.to, buffer.length)) invalidRange("comparison hunk");
    if (h.baseline.from === h.baseline.to && h.working.from === h.working.to) throw new RangeError("Empty comparison hunk.");
    const ae = a.lineAt(h.baseline.to), be = b.lineAt(h.working.to);
    // Scalar trimming can leave either end inside a row. Include that row on BOTH sides:
    // deleting a newline merges the following source row into the preceding target row.
    // An empty document still has an editable first row. Pair it with the first
    // changed row even when the nonempty document ends with a line break.
    const includeEndRow = a.length === 0 || b.length === 0 || h.baseline.to !== a.offsetAt(ae) || h.working.to !== b.offsetAt(be);
    return { a0: a.lineAt(h.baseline.from), a1: ae + Number(includeEndRow), b0: b.lineAt(h.working.from), b1: be + Number(includeEndRow) };
}
type Work = { units: number };
const checkpoint = (work: Work) => ++work.units % 256 === 0;
function* plan(a: TextBuffer, b: TextBuffer, hunks: readonly DiffHunk[], af: FoldIndex, bf: FoldIndex, work: Work): Generator<void, ComparisonRows> {
    const ah: Hidden[] = [], bh: Hidden[] = [];
    for (const [folds, hidden] of [[af, ah], [bf, bh]] as const) for (const r of folds.collapsedRegions()) {
        hidden.push({ from: r.lineFrom + 1, to: r.lineTo, header: r.lineFrom });
        if (checkpoint(work)) yield;
    }
    const baselineGaps: Gap[] = [], workingGaps: Gap[] = [];
    let rows = 0, runCount = 0, baselineLines = 0, workingLines = 0;
    let ai = 0, bi = 0, ac = 0, bc = 0;
    const visible = (line: number | null, length: number, side: "baseline" | "working") => {
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
                if (av.line === null) baselineGaps.push({ row: rows, end: rows + count, before: baselineLines,
                    anchor: av.header >= 0 ? av.header : a0 + Math.min(at, na) });
                else baselineLines += count;
                if (bv.line === null) workingGaps.push({ row: rows, end: rows + count, before: workingLines,
                    anchor: bv.header >= 0 ? bv.header : b0 + Math.min(at, nb) });
                else workingLines += count;
                runCount++;
                rows += count; if (!Number.isSafeInteger(rows)) throw new RangeError("Too many aligned rows.");
            }
            at += count; if (checkpoint(work)) yield;
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
        if (checkpoint(work)) yield;
        if (pending && (span.a0 <= pending.a1 || span.b0 <= pending.b1)) { pending.a1 = Math.max(pending.a1, span.a1); pending.b1 = Math.max(pending.b1, span.b1); }
        else { if (pending) yield* flush(pending); pending = span; }
    }
    if (pending) yield* flush(pending);
    if (a.lineCount - ac !== b.lineCount - bc) throw new Error("Comparison suffix rows disagree.");
    yield* emit(ac, a.lineCount - ac, bc, b.lineCount - bc);
    if (baselineLines !== af.visibleLineCount || workingLines !== bf.visibleLineCount)
        throw new Error("Comparison lost its source rows.");
    return Object.freeze({ baseline: new ComparisonRowIndex(a, af, baselineGaps),
        working: new ComparisonRowIndex(b, bf, workingGaps), rowCount: rows, runCount });
}

export type ComparisonRowsProgress = Readonly<{ status: KernelStatus; work: number; result: ComparisonRows | null; failure: string | null }>;
/** Charges collapsed-fold, hunk and span operations, independent of expanded folds or unchanged/padded row counts. */
export class ComparisonRowsCursor {
    readonly #driver: KernelCursor<ComparisonRowsProgress>;
    constructor(a: TextBuffer, b: TextBuffer, hunks: readonly DiffHunk[], af = new FoldIndex(a.lineCount), bf = new FoldIndex(b.lineCount)) {
        if (!Object.isFrozen(hunks) || af.lineCount !== a.lineCount || bf.lineCount !== b.lineCount) throw new Error("Expected captured comparison/fold coordinates.");
        const work = { units: 0 };
        this.#driver = kernelCursor(plan(a, b, hunks, af, bf, work), () => work.units,
            (status, result, failure): ComparisonRowsProgress => Object.freeze({ status, work: work.units, result, failure }), "Alignment");
    }
    next(budget = 256): ComparisonRowsProgress { return this.#driver.next(budget); }
    snapshot(): ComparisonRowsProgress { return this.#driver.snapshot(); }
    dispose(): void { this.#driver.dispose(); }
}
