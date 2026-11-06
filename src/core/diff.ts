import type { TextBuffer } from "./text-buffer.ts";
export type DiffRange = Readonly<{ from: number; to: number; lineFrom: number; lineTo: number }>;
export type DiffHunk = Readonly<{ baseline: DiffRange; working: DiffRange; whitespaceOnly: boolean }>;
export type DiffProgress = Readonly<{ status: "running" | "ready" | "cancelled"; work: number; readUnits: number; lineComparisons: number; lineEdits: number; hunks: readonly DiffHunk[] }>;
type Line = Readonly<{ from: number; to: number; hash: number }>;
type Stats = { work: number; yielded: number; readUnits: number; lineComparisons: number; lineEdits: number };
type Region = Readonly<{ a0: number; a1: number; b0: number; b1: number }>;
const tick = (stats: Stats, units = 1): boolean => { stats.work += units; if (stats.work - stats.yielded < 256) return false; stats.yielded = stats.work; return true; };
function* lines(buffer: TextBuffer, stats: Stats): Generator<void, readonly Line[]> {
    const result: Line[] = []; let from = 0, offset = 0, hash = 2166136261;
    for (const chunk of buffer.chunks()) for (let start = 0; start < chunk.length;) {
        const end = Math.min(chunk.length, start + 256);
        for (let index = start; index < end; index++) {
            const unit = chunk.charCodeAt(index); hash = Math.imul(hash ^ unit, 16777619); offset++;
            if (unit === 10) { result.push(Object.freeze({ from, to: offset, hash: hash >>> 0 })); from = offset; hash = 2166136261; }
        }
        stats.readUnits += end - start; if (tick(stats, end - start)) yield; start = end;
    }
    if (from < offset) result.push(Object.freeze({ from, to: offset, hash: hash >>> 0 }));
    return result;
}
function* equalLine(a: TextBuffer, b: TextBuffer, left: Line, right: Line, stats: Stats): Generator<void, boolean> {
    stats.lineComparisons++;
    if (tick(stats)) yield;
    if (left.hash !== right.hash || left.to - left.from !== right.to - right.from) return false;
    for (let offset = 0; offset < left.to - left.from; offset += 256) {
        const length = Math.min(256, left.to - left.from - offset);
        const equal = a.slice(left.from + offset, left.from + offset + length) === b.slice(right.from + offset, right.from + offset + length);
        stats.readUnits += length * 2; if (tick(stats, length * 2)) yield;
        if (!equal) return false;
    }
    return true;
}
function* disjoint(left: readonly Line[], right: readonly Line[], region: Region, stats: Stats): Generator<void, boolean> {
    const signatures = new Set<number>();
    for (let index = region.a0; index < region.a1; index++) { signatures.add(left[index]!.hash); if (tick(stats)) yield; }
    for (let index = region.b0; index < region.b1; index++) { if (signatures.has(right[index]!.hash)) return false; if (tick(stats)) yield; }
    return true;
}
function* bisect(a: TextBuffer, b: TextBuffer, left: readonly Line[], right: readonly Line[], region: Region, stats: Stats): Generator<void, readonly [number, number]> {
    const n = region.a1 - region.a0, m = region.b1 - region.b0, maximum = Math.ceil((n + m) / 2), origin = maximum + 1, delta = n - m;
    const forward = new Int32Array(maximum * 2 + 3), reverse = new Int32Array(maximum * 2 + 3);
    for (let index = 0; index < forward.length; index++) { forward[index] = -1; reverse[index] = -1; if (tick(stats, 2)) yield; }
    forward[origin + 1] = 0; reverse[origin + 1] = 0;
    const start = (vector: Int32Array, diagonal: number): number => {
        const index = origin + diagonal, insert = vector[index + 1]!, remove = vector[index - 1]! < 0 ? -1 : vector[index - 1]! + 1;
        const valid = (x: number) => x >= 0 && x <= n && x - diagonal >= 0 && x - diagonal <= m;
        return Math.max(valid(insert) ? insert : -1, valid(remove) ? remove : -1);
    };
    for (let distance = 0; distance <= maximum; distance++) {
        for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
            let x = start(forward, diagonal), y = x - diagonal;
            if (x >= 0) while (x < n && y < m && (yield* equalLine(a, b, left[region.a0 + x]!, right[region.b0 + y]!, stats))) { x++; y++; }
            forward[origin + diagonal] = x;
            const opposite = origin + delta - diagonal;
            if (x >= 0 && delta % 2 !== 0 && opposite >= 0 && opposite < reverse.length && reverse[opposite]! >= 0 && x >= n - reverse[opposite]!) return [region.a0 + x, region.b0 + y];
            if (tick(stats)) yield;
        }
        for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
            let x = start(reverse, diagonal), y = x - diagonal;
            if (x >= 0) while (x < n && y < m && (yield* equalLine(a, b, left[region.a1 - x - 1]!, right[region.b1 - y - 1]!, stats))) { x++; y++; }
            reverse[origin + diagonal] = x;
            const opposite = origin + delta - diagonal;
            if (x >= 0 && delta % 2 === 0 && opposite >= 0 && opposite < forward.length && forward[opposite]! >= 0 && forward[opposite]! >= n - x) {
                const split = forward[opposite]!; return [region.a0 + split, region.b0 + split - (delta - diagonal)];
            }
            if (tick(stats)) yield;
        }
    }
    throw new Error("Comparison search did not find a split.");
}
function range(buffer: TextBuffer, from: number, to: number): DiffRange {
    const lineFrom = buffer.lineAt(from); return Object.freeze({ from, to, lineFrom, lineTo: from === to ? lineFrom : buffer.lineAt(to - 1) + 1 });
}
function* compare(a: TextBuffer, b: TextBuffer, stats: Stats): Generator<void, readonly DiffHunk[]> {
    if (a === b) return Object.freeze([]);
    const left = yield* lines(a, stats), right = yield* lines(b, stats), tasks: Region[] = [{ a0: 0, a1: left.length, b0: 0, b1: right.length }], changes: Region[] = [];
    while (tasks.length) {
        let { a0, a1, b0, b1 } = tasks.pop()!;
        while (a0 < a1 && b0 < b1 && (yield* equalLine(a, b, left[a0]!, right[b0]!, stats))) { a0++; b0++; }
        while (a0 < a1 && b0 < b1 && (yield* equalLine(a, b, left[a1 - 1]!, right[b1 - 1]!, stats))) { a1--; b1--; }
        if (a0 === a1 && b0 === b1) continue;
        if (a0 === a1 || b0 === b1 || (yield* disjoint(left, right, { a0, a1, b0, b1 }, stats))) {
            const previous = changes.at(-1);
            if (previous?.a1 === a0 && previous.b1 === b0) changes[changes.length - 1] = { a0: previous.a0, a1, b0: previous.b0, b1 };
            else changes.push({ a0, a1, b0, b1 });
        } else if (a1 - a0 === 1 || b1 - b0 === 1) {
            let matchA = -1, matchB = -1;
            outer: for (let ai = a0; ai < a1; ai++) for (let bi = b0; bi < b1; bi++) if (yield* equalLine(a, b, left[ai]!, right[bi]!, stats)) { matchA = ai; matchB = bi; break outer; }
            if (matchA < 0) changes.push({ a0, a1, b0, b1 });
            else { tasks.push({ a0: matchA + 1, a1, b0: matchB + 1, b1 }); tasks.push({ a0, a1: matchA, b0, b1: matchB }); }
        } else {
            const [ai, bi] = yield* bisect(a, b, left, right, { a0, a1, b0, b1 }, stats);
            if ((ai === a0 && bi === b0) || (ai === a1 && bi === b1)) throw new Error("Comparison split did not make progress.");
            tasks.push({ a0: ai, a1, b0: bi, b1 }); tasks.push({ a0, a1: ai, b0, b1: bi });
        }
    }
    const hunks: DiffHunk[] = [];
    for (const change of changes) {
        stats.lineEdits += change.a1 - change.a0 + change.b1 - change.b0;
        let a0 = left[change.a0]?.from ?? a.length, a1 = change.a1 > change.a0 ? left[change.a1 - 1]!.to : a0;
        let b0 = right[change.b0]?.from ?? b.length, b1 = change.b1 > change.b0 ? right[change.b1 - 1]!.to : b0;
        while (a0 < a1 && b0 < b1) {
            const length = Math.min(256, a1 - a0, b1 - b0), av = a.slice(a0, a0 + length), bv = b.slice(b0, b0 + length); let common = 0;
            while (common < length && av[common] === bv[common]) common++; a0 += common; b0 += common;
            stats.readUnits += length * 2; if (tick(stats, length * 2)) yield; if (common < length) break;
        }
        while (a0 < a1 && b0 < b1) {
            const length = Math.min(256, a1 - a0, b1 - b0), av = a.slice(a1 - length, a1), bv = b.slice(b1 - length, b1); let common = 0;
            while (common < length && av[length - common - 1] === bv[length - common - 1]) common++; a1 -= common; b1 -= common;
            stats.readUnits += length * 2; if (tick(stats, length * 2)) yield; if (common < length) break;
        }
        let whitespaceOnly = true;
        for (const [buffer, from, to] of [[a, a0, a1], [b, b0, b1]] as const) for (let offset = from; offset < to; offset += 256) {
            const end = Math.min(to, offset + 256); if (!/^\s*$/u.test(buffer.slice(offset, end))) whitespaceOnly = false;
            stats.readUnits += end - offset; if (tick(stats, end - offset)) yield;
        }
        if (a0 !== a1 || b0 !== b1) hunks.push(Object.freeze({ baseline: range(a, a0, a1), working: range(b, b0, b1), whitespaceOnly }));
    }
    return Object.freeze(hunks);
}

/** Exact line alignment with bounded cooperative steps and linear-space bisection. */
export class TextDiff {
    private iterator: Generator<void, readonly DiffHunk[]> | undefined;
    private readonly stats: Stats = { work: 0, yielded: 0, readUnits: 0, lineComparisons: 0, lineEdits: 0 };
    private status: DiffProgress["status"] = "running";
    private hunks: readonly DiffHunk[] = Object.freeze([]);
    constructor(baseline: TextBuffer, working: TextBuffer) { this.iterator = compare(baseline, working, this.stats); }
    next(workBudget = 32_768): DiffProgress {
        if (!Number.isSafeInteger(workBudget) || workBudget < 512) throw new RangeError("Comparison budget must be an integer of at least 512 units.");
        const start = this.stats.work;
        try {
            while (this.iterator && this.stats.work - start < workBudget) {
                const step = this.iterator.next(); if (step.done) { this.hunks = step.value; this.status = "ready"; this.iterator = undefined; }
            }
        } catch (error) { this.dispose(); throw error; }
        return Object.freeze({ status: this.status, work: this.stats.work, readUnits: this.stats.readUnits, lineComparisons: this.stats.lineComparisons, lineEdits: this.stats.lineEdits, hunks: this.hunks });
    }
    dispose(): void { this.iterator?.return(Object.freeze([])); this.iterator = undefined; this.hunks = Object.freeze([]); this.status = "cancelled"; }
}
