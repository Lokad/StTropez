import type { TextBuffer } from "./text-buffer.ts";
import { kernelCursor } from "./kernel-cursor.ts";
import type { KernelCursor, KernelStatus } from "./kernel-cursor.ts";

export type DiffRange = Readonly<{ from: number; to: number; lineFrom: number; lineTo: number }>;
export type DiffHunk = Readonly<{ baseline: DiffRange; working: DiffRange; whitespaceOnly: boolean; lineEndingOnly?: true }>;
export type DiffProgress = Readonly<{ status: KernelStatus; work: number; readUnits: number; lineEdits: number; hunks: readonly DiffHunk[]; failure: string | null }>;

type Stats = { work: number; yielded: number; readUnits: number; lineEdits: number };
const block = 256;
function charge(stats: Stats, units = 1): boolean {
    stats.work += units;
    if (stats.work - stats.yielded < block) return false;
    stats.yielded = stats.work;
    return true;
}

// A shared immutable span can skip many equal rows, even when an independently
// restored edge is the first thing encountered. Independent text uses bounded reads.
function* commonText(a: TextBuffer, b: TextBuffer, from: number, to: number, otherFrom: number, otherTo: number,
    atStart: boolean, stats: Stats): Generator<void, number> {
    const limit = Math.min(to - from, otherTo - otherFrom);
    let common = 0, nextShared = 0;
    while (common < limit) {
        if (common >= nextShared && limit - common > block) {
            const bounds = atStart ? { from: from + common, to, otherFrom: otherFrom + common, otherTo }
                : { from, to: to - common, otherFrom, otherTo: otherTo - common };
            let shared = 0;
            for (const length of a.sharedEdge(b, atStart ? "start" : "end", bounds)) {
                shared = length;
                if (charge(stats)) yield;
            }
            common += shared;
            if (common === limit) break;
            nextShared = common + (nextShared === 0 ? block : 4096);
        }
        const length = Math.min(block, limit - common);
        const x = atStart ? from + common : to - common - length, y = atStart ? otherFrom + common : otherTo - common - length;
        const left = a.slice(x, x + length), right = b.slice(y, y + length);
        stats.readUnits += length * 2;
        if (charge(stats, length * 2)) yield;
        if (left !== right) {
            let matched = 0;
            while (left[atStart ? matched : length - matched - 1] === right[atStart ? matched : length - matched - 1]) matched++;
            return common + matched;
        }
        common += length;
    }
    return common;
}

type Dictionary = { first: Map<string, number>; tails: Map<number, Map<string, number>>; size: number };
function intern(dict: Dictionary, parent: number, text: string): number {
    let entries = dict.first;
    if (parent) {
        const existing = dict.tails.get(parent);
        if (existing) entries = existing;
        else { entries = new Map(); dict.tails.set(parent, entries); }
    }
    const known = entries.get(text);
    if (known !== undefined) return known;
    const id = ++dict.size;
    entries.set(text, id);
    return id;
}

type Lines = { ids: number[]; offsets: number[]; present: Set<number> };
function* readLines(buffer: TextBuffer, from: number, to: number, dict: Dictionary, stats: Stats): Generator<void, Lines> {
    const ids: number[] = [], offsets = [from], present = new Set<number>();
    // Fixed-size segments give even a single very long row an exact identity,
    // independent of where a buffer read ends. LF belongs to the preceding row.
    let parent = 0, carry = "";
    for (let start = from; start < to; start += 512) {
        const window = buffer.slice(start, Math.min(start + 512, to));
        for (let i = 0; i < window.length;) {
            const lf = window.indexOf("\n", i), end = lf < 0 ? window.length : lf + 1;
            const text = carry + window.slice(i, end);
            if (text.length >= 512) {
                parent = intern(dict, parent, text.slice(0, 512));
                carry = text.slice(512);
            } else carry = text;
            if (lf >= 0 || start + end === to) {
                const id = carry ? intern(dict, parent, carry) : parent;
                ids.push(id); offsets.push(start + end); present.add(id);
                parent = 0; carry = "";
            }
            i = end;
        }
        stats.readUnits += window.length;
        if (charge(stats, window.length)) yield;
    }
    return { ids, offsets, present };
}

type Candidates = { ids: number[]; rows: number[]; changed: Uint8Array };
function* candidates(lines: Lines, other: Lines, stats: Stats): Generator<void, Candidates> {
    const ids: number[] = [], rows: number[] = [], changed = new Uint8Array(lines.ids.length);
    for (let i = 0; i < changed.length; i++) {
        const id = lines.ids[i]!;
        if (other.present.has(id)) { ids.push(id); rows.push(i); }
        else changed[i] = 1;
        if (charge(stats)) yield;
    }
    return { ids, rows, changed };
}

type Region = [a0: number, a1: number, b0: number, b1: number];
// Myers bisection. Each diagonal stores the furthest x reached from its end.
// The first overlap joins two shortest paths. The vectors are reused by children.
function* bisect(a: number[], b: number[], [a0, a1, b0, b1]: Region, front: Int32Array, back: Int32Array,
    shift: number, stats: Stats): Generator<void, [number, number]> {
    const low = a0 - b1, high = a1 - b0;
    let fMin = a0 - b0, fMax = fMin, rMin = a1 - b1, rMax = rMin;
    const odd = (fMin - rMin) & 1;
    front[shift + fMin] = a0;
    back[shift + rMin] = a1;
    for (;;) {
        if (fMin > low) { fMin--; front[shift + fMin - 1] = -1; } else fMin++;
        if (fMax < high) { fMax++; front[shift + fMax + 1] = -1; } else fMax--;
        for (let k = fMax; k >= fMin; k -= 2) {
            const index = shift + k;
            let x = Math.max(front[index - 1]! + 1, front[index + 1]!), y = x - k;
            while (x < a1 && y < b1 && a[x] === b[y]) { x++; y++; if (charge(stats)) yield; }
            front[index] = x;
            if (odd && k >= rMin && k <= rMax && x >= back[index]!) return [x, y];
            if (charge(stats)) yield;
        }
        if (rMin > low) { rMin--; back[shift + rMin - 1] = 0x7fffffff; } else rMin++;
        if (rMax < high) { rMax++; back[shift + rMax + 1] = 0x7fffffff; } else rMax--;
        for (let k = rMax; k >= rMin; k -= 2) {
            const index = shift + k;
            let x = Math.min(back[index - 1]!, back[index + 1]! - 1), y = x - k;
            while (x > a0 && y > b0 && a[x - 1] === b[y - 1]) { x--; y--; if (charge(stats)) yield; }
            back[index] = x;
            if (!odd && k >= fMin && k <= fMax && x <= front[index]!) return [x, y];
            if (charge(stats)) yield;
        }
    }
}

function* align(left: Candidates, right: Candidates, stats: Stats): Generator<void> {
    const a = left.ids, b = right.ids, size = a.length + b.length + 3;
    const front = new Int32Array(size), back = new Int32Array(size);
    const stack: Region[] = [[0, a.length, 0, b.length]];
    while (stack.length) {
        let [a0, a1, b0, b1] = stack.pop()!;
        while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) { a0++; b0++; if (charge(stats)) yield; }
        while (a0 < a1 && b0 < b1 && a[a1 - 1] === b[b1 - 1]) { a1--; b1--; if (charge(stats)) yield; }
        if (a0 === a1 || b0 === b1) {
            for (; a0 < a1; a0++) { left.changed[left.rows[a0]!] = 1; if (charge(stats)) yield; }
            for (; b0 < b1; b0++) { right.changed[right.rows[b0]!] = 1; if (charge(stats)) yield; }
        } else {
            const [x, y] = yield* bisect(a, b, [a0, a1, b0, b1], front, back, b.length + 1, stats);
            stack.push([x, a1, y, b1], [a0, x, b0, y]);
        }
        if (charge(stats)) yield;
    }
}

function range(buffer: TextBuffer, from: number, to: number): DiffRange {
    const lineFrom = buffer.lineAt(from);
    return Object.freeze({ from, to, lineFrom, lineTo: from === to ? lineFrom : buffer.lineAt(to - 1) + 1 });
}

function* whitespace(buffer: TextBuffer, from: number, to: number, stats: Stats): Generator<void, boolean> {
    for (let at = from; at < to; at += block) {
        const text = buffer.slice(at, Math.min(at + block, to));
        stats.readUnits += text.length;
        if (charge(stats, text.length)) yield;
        if (/\S/u.test(text)) return false;
    }
    return true;
}

/** The trimmed hunk can end just before the LF shared by both files. */
function* onlyLineEndings(a: TextBuffer, b: TextBuffer, x: number, xEnd: number, y: number, yEnd: number, stats: Stats): Generator<void, boolean> {
    if (x === xEnd && y === yEnd) return false;
    while (x < xEnd || y < yEnd) {
        const left = a.slice(x, Math.min(x + 2, a.length)), right = b.slice(y, Math.min(y + 2, b.length));
        stats.readUnits += left.length + right.length;
        if (charge(stats, left.length + right.length)) yield;
        if (x < xEnd && left === "\r\n" && right.startsWith("\n")) x++;
        else if (y < yEnd && right === "\r\n" && left.startsWith("\n")) y++;
        else return false;
        const equal = yield* commonText(a, b, x, xEnd, y, yEnd, true, stats);
        x += equal; y += equal;
    }
    return true;
}

function* compare(a: TextBuffer, b: TextBuffer, stats: Stats): Generator<void, readonly DiffHunk[]> {
    const hunks: DiffHunk[] = [];
    if (a === b) return Object.freeze(hunks);
    const prefix = yield* commonText(a, b, 0, a.length, 0, b.length, true, stats);
    if (prefix === a.length && prefix === b.length) return Object.freeze(hunks);
    const start = a.offsetAt(a.lineAt(prefix));
    const suffix = yield* commonText(a, b, prefix, a.length, prefix, b.length, false, stats);
    let aTo = a.length - suffix, bTo = b.length - suffix;
    const lastA = a.lineAt(aTo), lastB = b.lineAt(bTo);
    if (a.offsetAt(lastA) !== aTo || b.offsetAt(lastB) !== bTo) {
        aTo = lastA + 1 < a.lineCount ? a.offsetAt(lastA + 1) : a.length;
        bTo = lastB + 1 < b.lineCount ? b.offsetAt(lastB + 1) : b.length;
    }
    const dict: Dictionary = { first: new Map(), tails: new Map(), size: 0 };
    const aLines = yield* readLines(a, start, aTo, dict, stats), bLines = yield* readLines(b, start, bTo, dict, stats);
    const left = yield* candidates(aLines, bLines, stats), right = yield* candidates(bLines, aLines, stats);
    yield* align(left, right, stats);
    let i = 0, j = 0;
    while (i < left.changed.length || j < right.changed.length) {
        if (charge(stats)) yield;
        if (!left.changed[i] && !right.changed[j]) { i++; j++; continue; }
        const firstI = i, firstJ = j;
        while (left.changed[i]) { i++; if (charge(stats)) yield; }
        while (right.changed[j]) { j++; if (charge(stats)) yield; }
        stats.lineEdits += i - firstI + j - firstJ;
        let x0 = aLines.offsets[firstI]!, x1 = aLines.offsets[i]!, y0 = bLines.offsets[firstJ]!, y1 = bLines.offsets[j]!;
        const before = yield* commonText(a, b, x0, x1, y0, y1, true, stats);
        x0 += before; y0 += before;
        const after = yield* commonText(a, b, x0, x1, y0, y1, false, stats);
        x1 -= after; y1 -= after;
        const whitespaceOnly = (yield* whitespace(a, x0, x1, stats)) && (yield* whitespace(b, y0, y1, stats));
        const lineEndingOnly = yield* onlyLineEndings(a, b, x0, x1, y0, y1, stats);
        hunks.push(Object.freeze({ baseline: range(a, x0, x1), working: range(b, y0, y1), whitespaceOnly, ...(lineEndingOnly ? { lineEndingOnly: true as const } : {}) }));
    }
    return Object.freeze(hunks);
}

export class TextDiff {
    private readonly driver: KernelCursor<DiffProgress>;
    constructor(baseline: TextBuffer, working: TextBuffer) {
        const stats: Stats = { work: 0, yielded: 0, readUnits: 0, lineEdits: 0 };
        const empty: readonly DiffHunk[] = Object.freeze([]);
        this.driver = kernelCursor(compare(baseline, working, stats), () => stats.work,
            (status, result, failure): DiffProgress => Object.freeze({ status, work: stats.work, readUnits: stats.readUnits,
                lineEdits: stats.lineEdits, hunks: result ?? empty, failure }), "Comparison");
    }
    next(workBudget = 32_768): DiffProgress { return this.driver.next(workBudget); }
    snapshot(): DiffProgress { return this.driver.snapshot(); }
    dispose(): void { this.driver.dispose(); }
}
