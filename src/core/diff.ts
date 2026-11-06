import type { TextBuffer } from "./text-buffer.ts";
import type { DiffLine } from "./diff-lines.ts";
import { commonText, getLine, indexLines, lineLength, matchingLines, offsetAt, tick } from "./diff-index.ts";
import type { DiffStats as Stats, DiffIndex as Index } from "./diff-index.ts";
export type DiffRange = Readonly<{ from: number; to: number; lineFrom: number; lineTo: number }>;
export type DiffHunk = Readonly<{ baseline: DiffRange; working: DiffRange; whitespaceOnly: boolean }>;
export type DiffProgress = Readonly<{ status: "running" | "ready" | "cancelled"; work: number; readUnits: number; lineComparisons: number; lineEdits: number; hunks: readonly DiffHunk[] }>;
type Cache = { baseline: TextBuffer; serial: number; reference: Index | undefined; working: Index | undefined };
const referenceCaches = new WeakMap<DiffReferenceCache, { current: Cache | undefined }>();
const longHashes = new WeakMap<DiffLine, number>();

/** Retains one reference and one current working index. Active jobs own their captures. */
export class DiffReferenceCache {
    constructor() { referenceCaches.set(this, { current: undefined }); Object.freeze(this); }
    dispose(): void { referenceCaches.delete(this); }
}
type Region = Readonly<{ a0: number; a1: number; b0: number; b1: number }>;
function* equalLine(a: Index, b: Index, ai: number, bi: number, stats: Stats, prove = true): Generator<void, boolean> {
    stats.lineComparisons++;
    if (tick(stats)) yield;
    const length = lineLength(a, ai); if (length !== lineLength(b, bi)) return false;
    if (prove && (yield* matchingLines(a, b, ai, ai + 1, bi, bi + 1, false, stats)) === 1) return true;
    const left = yield* getLine(a, ai, stats), right = yield* getLine(b, bi, stats);
    const leftHash = left.hash ?? longHashes.get(left), rightHash = right.hash ?? longHashes.get(right);
    if (leftHash !== undefined && rightHash !== undefined && leftHash !== rightHash) return false;
    if (left.token !== undefined && right.token !== undefined) return left.token === right.token;
    const af = offsetAt(a, ai), bf = offsetAt(b, bi);
    return (yield* commonText(a.buffer, b.buffer, af, af + left.length, bf, bf + right.length, "start", stats)) === left.length;
}
function* commonLines(a: Index, b: Index, region: Region, reverse: boolean, stats: Stats): Generator<void, number> {
    let count = 0;
    const maximum = Math.min(region.a1 - region.a0, region.b1 - region.b0);
    while (count < maximum) {
        if (count % 64 === 0) {
            const proved = yield* matchingLines(a, b, reverse ? region.a0 : region.a0 + count, reverse ? region.a1 - count : region.a1,
                reverse ? region.b0 : region.b0 + count, reverse ? region.b1 - count : region.b1, reverse, stats);
            if (proved) { count += proved; continue; }
        }
        const ai = reverse ? region.a1 - count - 1 : region.a0 + count, bi = reverse ? region.b1 - count - 1 : region.b0 + count;
        if (!(yield* equalLine(a, b, ai, bi, stats, false))) break; count++;
        // Repeated rows can align at different backing offsets. Verify their remaining
        // text in bounded native string comparisons instead of materializing every row.
        const token = a.lines.at(ai)?.token; let repeated = false;
        for (let distance = 1; token !== undefined && distance <= 4 && count - 1 + distance < maximum; distance++) {
            const nextA = ai + (reverse ? -distance : distance), nextB = bi + (reverse ? -distance : distance);
            if (token === a.lines.at(nextA)?.token && token === b.lines.at(nextB)?.token) { repeated = true; break; }
        }
        if (repeated) {
            count += yield* matchingLines(a, b, reverse ? region.a0 : region.a0 + count, reverse ? region.a1 - count : region.a1,
                reverse ? region.b0 : region.b0 + count, reverse ? region.b1 - count : region.b1, reverse, stats, true);
        }
    }
    return count;
}
function* lineHash(index: Index, row: number, line: DiffLine, stats: Stats): Generator<void, number> {
    const known = line.hash ?? longHashes.get(line); if (known !== undefined) return known;
    const from = offsetAt(index, row); let hash = 2166136261;
    for (let offset = 0; offset < line.length; offset += 256) {
        const length = Math.min(256, line.length - offset), text = index.buffer.slice(from + offset, from + offset + length);
        for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
        stats.readUnits += length; if (tick(stats, length)) yield;
    }
    hash >>>= 0; longHashes.set(line, hash); return hash;
}
function* disjoint(left: Index, right: Index, region: Region, stats: Stats): Generator<void, boolean> {
    // A cheap exact match can decline this optional scan without indexing a huge shared interior.
    for (let offset = 1; offset < Math.min(4, region.a1 - region.a0, region.b1 - region.b0); offset++)
        if (yield* equalLine(left, right, region.a0 + offset, region.b0 + offset, stats)) return false;
    const signatures = new Set<number>();
    for (let ai = region.a0; ai < region.a1; ai++) { signatures.add(yield* lineHash(left, ai, yield* getLine(left, ai, stats), stats)); if (tick(stats)) yield; }
    for (let bi = region.b0; bi < region.b1; bi++) { if (signatures.has(yield* lineHash(right, bi, yield* getLine(right, bi, stats), stats))) return false; if (tick(stats)) yield; }
    return true;
}
function* bisect(a: Index, b: Index, region: Region, stats: Stats): Generator<void, readonly [number, number]> {
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
            if (x >= 0) { const same = yield* commonLines(a, b, { a0: region.a0 + x, a1: region.a1, b0: region.b0 + y, b1: region.b1 }, false, stats); x += same; y += same; }
            forward[origin + diagonal] = x;
            const opposite = origin + delta - diagonal;
            if (x >= 0 && delta % 2 !== 0 && opposite >= 0 && opposite < reverse.length && reverse[opposite]! >= 0 && x >= n - reverse[opposite]!) return [region.a0 + x, region.b0 + y];
            if (tick(stats)) yield;
        }
        for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
            let x = start(reverse, diagonal), y = x - diagonal;
            if (x >= 0) { const same = yield* commonLines(a, b, { a0: region.a0, a1: region.a1 - x, b0: region.b0, b1: region.b1 - y }, true, stats); x += same; y += same; }
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
function* compare(a: TextBuffer, b: TextBuffer, stats: Stats, cache?: Cache, serial = 0): Generator<void, readonly DiffHunk[]> {
    if (a === b) return Object.freeze([]);
    const left = yield* indexLines(a, stats, cache?.reference);
    if (cache?.serial === serial) cache.reference = left;
    const right = yield* indexLines(b, stats, cache?.working ?? left);
    if (cache?.serial === serial) cache.working = right;
    const tasks: Region[] = [{ a0: 0, a1: left.lines.size, b0: 0, b1: right.lines.size }], changes: Region[] = [];
    const append = (change: Region) => {
        const previous = changes.at(-1);
        if (previous?.a1 === change.a0 && previous.b1 === change.b0) changes[changes.length - 1] = { a0: previous.a0, a1: change.a1, b0: previous.b0, b1: change.b1 };
        else changes.push(change);
    };
    while (tasks.length) {
        let { a0, a1, b0, b1 } = tasks.pop()!;
        const prefix = yield* commonLines(left, right, { a0, a1, b0, b1 }, false, stats); a0 += prefix; b0 += prefix;
        const suffix = yield* commonLines(left, right, { a0, a1, b0, b1 }, true, stats); a1 -= suffix; b1 -= suffix;
        if (a0 === a1 && b0 === b1) continue;
        if (a0 === a1 || b0 === b1 || a1 - a0 > 1 && b1 - b0 > 1 && (yield* disjoint(left, right, { a0, a1, b0, b1 }, stats))) {
            append({ a0, a1, b0, b1 });
        } else if (a1 - a0 === 1 || b1 - b0 === 1) {
            let matchA = -1, matchB = -1;
            outer: for (let ai = a0; ai < a1; ai++) for (let bi = b0; bi < b1; bi++) if (yield* equalLine(left, right, ai, bi, stats)) { matchA = ai; matchB = bi; break outer; }
            if (matchA < 0) append({ a0, a1, b0, b1 });
            else { tasks.push({ a0: matchA + 1, a1, b0: matchB + 1, b1 }); tasks.push({ a0, a1: matchA, b0, b1: matchB }); }
        } else {
            const [ai, bi] = yield* bisect(left, right, { a0, a1, b0, b1 }, stats);
            if ((ai === a0 && bi === b0) || (ai === a1 && bi === b1)) throw new Error("Comparison split did not make progress.");
            tasks.push({ a0: ai, a1, b0: bi, b1 }); tasks.push({ a0, a1: ai, b0, b1: bi });
        }
    }
    const hunks: DiffHunk[] = [];
    for (const change of changes) {
        stats.lineEdits += change.a1 - change.a0 + change.b1 - change.b0;
        let a0 = offsetAt(left, change.a0), a1 = offsetAt(left, change.a1);
        let b0 = offsetAt(right, change.b0), b1 = offsetAt(right, change.b1);
        const prefix = yield* commonText(a, b, a0, a1, b0, b1, "start", stats); a0 += prefix; b0 += prefix;
        const suffix = yield* commonText(a, b, a0, a1, b0, b1, "end", stats); a1 -= suffix; b1 -= suffix;
        let whitespaceOnly = true;
        outer: for (const [buffer, from, to] of [[a, a0, a1], [b, b0, b1]] as const) for (let offset = from; offset < to; offset += 256) {
            const end = Math.min(to, offset + 256), white = /^\s*$/u.test(buffer.slice(offset, end));
            stats.readUnits += end - offset; if (tick(stats, end - offset)) yield;
            if (!white) { whitespaceOnly = false; break outer; }
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
    constructor(baseline: TextBuffer, working: TextBuffer, cache?: DiffReferenceCache) {
        const state = cache === undefined ? undefined : referenceCaches.get(cache);
        if (cache !== undefined && !state) throw new Error("Reference cache is disposed or foreign.");
        const current = state?.current?.baseline === baseline ? state.current : { baseline, serial: 0, reference: undefined, working: undefined };
        if (state) state.current = current;
        this.iterator = compare(baseline, working, this.stats, current, ++current.serial);
    }
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
