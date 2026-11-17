import { bidiBracket, bidiClass } from "./bidi-data.ts";
import type { BidiClass } from "./bidi-data.ts";
import type { BidiDirection, BidiParagraph, BidiText } from "./bidi.ts";
import type { TextBuffer } from "./text-buffer.ts";
import { readUtf16Window } from "./utf16.ts";
import { kernelCursor } from "./kernel-cursor.ts";
import type { KernelCursor, KernelStatus } from "./kernel-cursor.ts";

export type BidiIndex = Readonly<{
    from: number; to: number; length: number; visualLength: number; paragraphCount: number;
    levelAt: (offset: number) => number | null; offsetAt: (visualIndex: number) => number;
    indexOf: (offset: number) => number | null; paragraphAt: (index: number) => BidiParagraph;
    materialize: () => BidiText;
}>;
export type BidiStep = Readonly<{ status: KernelStatus;
    phase: "scan" | "resolve" | "publish" | Exclude<KernelStatus, "running">;
    scannedUnits: number; readUnits: number; workUnits: number; result: BidiIndex | null; failure: string | null }>;
type Counters = { work: number; yielded: number; scanned: number; reads: number; phase: "scan" | "resolve" | "publish" };
const spent = (c: Counters, count = 1) => { c.work += count; if (c.work - c.yielded < 256) return false; c.yielded = c.work; return true; };
const isolate = (type: BidiClass) => type === "LRI" || type === "RLI" || type === "FSI";
const removed = (type: BidiClass) => type === "BN" || type === "PDF" || type === "LRE" || type === "RLE" || type === "LRO" || type === "RLO";
const strong = (type: BidiClass): "L" | "R" | undefined => type === "L" ? "L" : type === "R" || type === "EN" || type === "AN" ? "R" : undefined;
const directionOf = (level: number): "L" | "R" => level % 2 ? "R" : "L";
const neutral = (type: BidiClass) => type === "B" || type === "S" || type === "WS" || type === "ON" || isolate(type) || type === "PDI";
const whitespace = (type: BidiClass) => type === "WS" || isolate(type) || type === "PDI";
type ParagraphResult = { base: number; levels: readonly number[]; order: readonly number[] };

// With base level 0 and only these classes, W1-W7 and N0-N2 resolve every point to L.
// AN, RTL strong classes, removed characters and explicit/isolate controls need the full path.
const levelZeroType = (type: BidiClass) => type === "L" || type === "EN" || type === "ES" || type === "ET" || type === "CS"
    || type === "NSM" || type === "B" || type === "S" || type === "WS" || type === "ON";
function* levelZeroParagraph(length: number, c: Counters): Generator<void, ParagraphResult> {
    const levels: number[] = [], order: number[] = [];
    for (let i = 0; i < length; i++) { levels.push(0); order.push(i); if (spent(c)) yield; }
    return { base: 0, levels, order };
}

function* paragraph(points: readonly number[], original: readonly BidiClass[], requested: BidiDirection, c: Counters): Generator<void, ParagraphResult> {
    const n = points.length, types: BidiClass[] = [], levels: number[] = [], matches: number[] = [], nesting: number[] = [];
    for (let i = 0; i < n; i++) {
        types.push(original[i]!); levels.push(0); matches.push(-1);
        if (isolate(original[i]!)) nesting.push(i); else if (original[i] === "PDI" && nesting.length) matches[nesting.pop()!] = i;
        if (spent(c)) yield;
    }
    function* firstStrong(from: number, to: number): Generator<void, number> {
        for (let i = from; i < to; i++) {
            const type = original[i]!; if (spent(c)) yield;
            if (isolate(type)) { i = matches[i]! < 0 ? to : matches[i]!; continue; }
            if (type === "L") return 0; if (type === "R" || type === "AL") return 1;
        } return 0;
    }
    const base = requested === "auto" ? yield* firstStrong(0, n) : requested === "rtl" ? 1 : 0;
    type Frame = Readonly<{ level: number; override: "L" | "R" | undefined; isolate: boolean }>;
    const stack: Frame[] = [{ level: base, override: undefined, isolate: false }];
    let overflowIsolates = 0, overflowEmbeddings = 0, validIsolates = 0;
    for (let i = 0; i < n; i++) {
        const type = original[i]!, frame = stack.at(-1)!; levels[i] = frame.level; if (spent(c)) yield;
        if (type === "RLE" || type === "LRE" || type === "RLO" || type === "LRO" || isolate(type)) {
            const isIsolate = isolate(type), rtl = type === "RLE" || type === "RLO" || type === "RLI" || type === "FSI" && (yield* firstStrong(i + 1, matches[i]! < 0 ? n : matches[i]!)) === 1;
            const level = rtl ? (frame.level + 1) | 1 : (frame.level + 2) & ~1;
            if (isIsolate && frame.override) types[i] = frame.override;
            if (level <= 125 && overflowIsolates === 0 && overflowEmbeddings === 0) {
                stack.push({ level, override: type === "LRO" ? "L" : type === "RLO" ? "R" : undefined, isolate: isIsolate }); if (isIsolate) validIsolates++;
            } else if (isIsolate) overflowIsolates++; else if (overflowIsolates === 0) overflowEmbeddings++;
        } else if (type === "PDI") {
            if (overflowIsolates > 0) overflowIsolates--;
            else if (validIsolates > 0) {
                overflowEmbeddings = 0; while (!stack.at(-1)!.isolate) { stack.pop(); if (spent(c)) yield; } stack.pop(); validIsolates--;
            }
            const outer = stack.at(-1)!; levels[i] = outer.level; if (outer.override) types[i] = outer.override;
        } else if (type === "PDF") {
            if (overflowIsolates === 0) { if (overflowEmbeddings > 0) overflowEmbeddings--; else if (stack.length > 1 && !frame.isolate) stack.pop(); }
        } else if (type === "B") levels[i] = base;
        else if (type !== "BN" && frame.override) types[i] = frame.override;
    }
    const explicit: number[] = [], active: number[] = [], runFor: number[] = [], positions: number[] = [];
    for (let i = 0; i < n; i++) { explicit.push(levels[i]!); runFor.push(-1); positions.push(-1); if (!removed(original[i]!)) active.push(i); if (spent(c)) yield; }
    const runs: number[][] = [], nextRun: number[] = [], incoming = new Set<number>();
    for (let p = 0; p < active.length; p++) {
        const index = active[p]!; positions[index] = p;
        if (!p || levels[index] !== levels[active[p - 1]!]) { runs.push([]); nextRun.push(-1); }
        runFor[index] = runs.length - 1; runs.at(-1)!.push(index); if (spent(c)) yield;
    }
    for (let r = 0; r < runs.length; r++) {
        const last = runs[r]!.at(-1)!;
        if (isolate(original[last]!) && matches[last]! >= 0) { const next = runFor[matches[last]!]!; nextRun[r] = next; incoming.add(next); }
        if (spent(c)) yield;
    }
    for (let root = 0; root < runs.length; root++) {
        if (spent(c)) yield; if (incoming.has(root)) continue;
        const sequence: number[] = [];
        for (let r = root; r >= 0; r = nextRun[r]!) for (const index of runs[r]!) { sequence.push(index); if (spent(c)) yield; }
        const first = sequence[0]!, last = sequence.at(-1)!, before = active[positions[first]! - 1], after = active[positions[last]! + 1];
        const sos = directionOf(Math.max(explicit[first]!, before === undefined ? base : explicit[before]!));
        const eos = directionOf(Math.max(explicit[last]!, after === undefined || isolate(original[last]!) ? base : explicit[after]!));
        yield* resolveSequence(sequence, points, original, types, explicit[first]!, levels, sos, eos, c);
    }
    for (let p = 0; p <= active.length; p++) {
        if (spent(c)) yield;
        if (p === active.length || original[active[p]!] === "B" || original[active[p]!] === "S") {
            if (p < active.length) levels[active[p]!] = base;
            for (let q = p - 1; q >= 0 && whitespace(original[active[q]!]!); q--) { levels[active[q]!] = base; if (spent(c)) yield; }
        }
    }
    const order: number[] = []; let maximum = 0, minimumOdd = Infinity;
    for (const i of active) { order.push(i); maximum = Math.max(maximum, levels[i]!); if (levels[i]! % 2) minimumOdd = Math.min(minimumOdd, levels[i]!); if (spent(c)) yield; }
    for (let level = maximum; level >= minimumOdd; level--) for (let start = 0; start < order.length;) {
        if (spent(c)) yield;
        if (levels[order[start]!]! < level) { start++; continue; }
        let end = start + 1; while (end < order.length && levels[order[end]!]! >= level) { end++; if (spent(c)) yield; }
        for (let a = start, b = end - 1; a < b; a++, b--) { [order[a], order[b]] = [order[b]!, order[a]!]; if (spent(c, 2)) yield; } start = end;
    }
    for (let i = 0; i < n; i++) { if (removed(original[i]!)) levels[i] = -1; if (spent(c)) yield; }
    return { base, levels, order };
}

function* resolveSequence(sequence: readonly number[], points: readonly number[], original: readonly BidiClass[], types: BidiClass[], level: number, levels: number[], sos: "L" | "R", eos: "L" | "R", c: Counters): Generator<void, void> {
    const get = (p: number): BidiClass => p < 0 ? sos : p >= sequence.length ? eos : types[sequence[p]!]!;
    const set = (p: number, value: BidiClass) => { types[sequence[p]!] = value; };
    let context: BidiClass = sos;
    for (let p = 0; p < sequence.length; p++) { if (get(p) === "NSM") { const previous = get(p - 1); set(p, isolate(previous) || previous === "PDI" ? "ON" : previous); } if (spent(c)) yield; }
    for (let p = 0; p < sequence.length; p++) { const type = get(p); if (type === "EN" && context === "AL") set(p, "AN"); if (type === "L" || type === "R" || type === "AL") context = type; if (spent(c)) yield; }
    for (let p = 0; p < sequence.length; p++) { if (get(p) === "AL") set(p, "R"); if (spent(c)) yield; }
    for (let p = 1; p + 1 < sequence.length; p++) { const a = get(p - 1), t = get(p), b = get(p + 1); if (a === b && (t === "ES" && a === "EN" || t === "CS" && (a === "EN" || a === "AN"))) set(p, a); if (spent(c)) yield; }
    for (let p = 0; p < sequence.length;) {
        if (spent(c)) yield; if (get(p) !== "ET") { p++; continue; }
        let end = p + 1; while (end < sequence.length && get(end) === "ET") { end++; if (spent(c)) yield; }
        if (get(p - 1) === "EN" || get(end) === "EN") for (let q = p; q < end; q++) { set(q, "EN"); if (spent(c)) yield; } p = end;
    }
    for (let p = 0; p < sequence.length; p++) { if (get(p) === "ES" || get(p) === "ET" || get(p) === "CS") set(p, "ON"); if (spent(c)) yield; }
    context = sos; for (let p = 0; p < sequence.length; p++) { const type = get(p); if (type === "EN" && context === "L") set(p, "L"); if (type === "L" || type === "R") context = type; if (spent(c)) yield; }
    const opens: { partner: number; position: number }[] = [], closing: number[] = []; let overflow = false;
    const canonical = (cp: number) => cp === 0x232a ? 0x3009 : cp;
    for (let p = 0; p < sequence.length; p++) { closing.push(-1); if (spent(c)) yield; }
    for (let p = 0; p < sequence.length; p++) {
        if (spent(c)) yield; if (get(p) !== "ON") continue;
        const cp = points[sequence[p]!]!, bracket = bidiBracket(cp); if (!bracket) continue;
        if (bracket[1]) { if (opens.length === 63) { overflow = true; break; } opens.push({ partner: canonical(bracket[0]), position: p }); }
        else for (let q = opens.length - 1; q >= 0; q--) { if (spent(c)) yield; if (opens[q]!.partner === canonical(cp)) { closing[opens[q]!.position] = p; opens.length = q; break; } }
    }
    const embedding = directionOf(level);
    if (!overflow) for (let open = 0; open < sequence.length; open++) {
        if (spent(c)) yield; const close = closing[open]!; if (close < 0) continue;
        let enclosed = false, same = false;
        for (let p = open + 1; p < close; p++) { const t = strong(get(p)); if (spent(c)) yield; if (t) { enclosed = true; if (t === embedding) { same = true; break; } } }
        if (!enclosed) continue; let resolved = embedding;
        if (!same) { resolved = sos; for (let p = open - 1; p >= 0; p--) { const t = strong(get(p)); if (spent(c)) yield; if (t) { resolved = t; break; } } }
        for (const p of [open, close]) { set(p, resolved); for (let q = p + 1; q < sequence.length && original[sequence[q]!] === "NSM"; q++) { set(q, resolved); if (spent(c)) yield; } }
    }
    for (let p = 0; p < sequence.length;) {
        if (spent(c)) yield; if (!neutral(get(p))) { p++; continue; }
        let end = p + 1; while (end < sequence.length && neutral(get(end))) { end++; if (spent(c)) yield; }
        const a = strong(get(p - 1)), b = strong(get(end)), resolved = a === b ? a! : embedding;
        for (let q = p; q < end; q++) { set(q, resolved); if (spent(c)) yield; } p = end;
    }
    for (const index of sequence) { const type = types[index]!; levels[index] = level + (level % 2 ? type === "R" ? 0 : 1 : type === "R" ? 1 : type === "EN" || type === "AN" ? 2 : 0); if (spent(c)) yield; }
}

function makeIndex(from: number, to: number, levels: readonly (number | null)[], order: readonly number[], inverse: readonly number[], paragraphs: readonly BidiParagraph[]): BidiIndex {
    const valid = (value: number, low: number, high: number) => { if (!Number.isSafeInteger(value) || value < low || value >= high) throw new RangeError("Invalid bidi index position."); };
    return Object.freeze({ from, to, length: to - from, visualLength: order.length, paragraphCount: paragraphs.length,
        levelAt: (offset: number) => { valid(offset, from, to); return levels[offset - from]!; },
        offsetAt: (index: number) => { valid(index, 0, order.length); return order[index]!; },
        indexOf: (offset: number) => { valid(offset, from, to + 1); const value = inverse[offset - from]; return value === undefined || value < 0 ? null : value; },
        paragraphAt: (index: number) => { valid(index, 0, paragraphs.length); return paragraphs[index]!; },
        materialize: () => Object.freeze({ levels: Object.freeze([...levels]), order: Object.freeze(order.map(offset => offset - from)),
            paragraphs: Object.freeze(paragraphs.map(p => Object.freeze({ from: p.from - from, to: p.to - from, level: p.level }))) }) });
}

function* build(source: TextBuffer | string, from: number, to: number, direction: BidiDirection, c: Counters): Generator<void, BidiIndex> {
    const points: number[] = [], offsets: number[] = [], types: BidiClass[] = []; let offset = from;
    while (offset < to) {
        const chunk = readUtf16Window(source, offset, to), text = chunk.text; c.reads += chunk.readUnits;
        for (let i = 0; i < text.length;) {
            const cp = text.codePointAt(i)!, width = cp > 0xffff ? 2 : 1;
            points.push(cp); offsets.push(offset + i); types.push(bidiClass(cp)); i += width; c.scanned += width; if (spent(c, width)) yield;
        } offset = chunk.to;
    }
    const levels: (number | null)[] = [], order: number[] = [], inverse: number[] = [], paragraphs: BidiParagraph[] = []; let first = 0; c.phase = "resolve";
    for (let end = 0; end <= points.length; end++) {
        if (spent(c)) yield;
        if (end !== points.length && !(types[end] === "B" && !(points[end] === 0x0d && points[end + 1] === 0x0a))) continue;
        const last = end === points.length ? end : end + 1; if (last === first && points.length) continue;
        const paraPoints: number[] = [], paraTypes: BidiClass[] = [], atomFrom: number[] = [], atomTo: number[] = [];
        let levelZero = direction !== "rtl";
        // Consecutive original L characters have identical rule context and resolved level.
        // Keep one weighted atom; parity determines their expansion after L2, including overrides.
        for (let i = first; i < last; i++) {
            levelZero &&= levelZeroType(types[i]!);
            if (types[i] === "L" && paraTypes.at(-1) === "L") atomTo[atomTo.length - 1] = i + 1;
            else { paraPoints.push(points[i]!); paraTypes.push(types[i]!); atomFrom.push(i); atomTo.push(i + 1); }
            if (spent(c)) yield;
        }
        const resolved = yield* (levelZero ? levelZeroParagraph(paraPoints.length, c) : paragraph(paraPoints, paraTypes, direction, c)); c.phase = "publish";
        paragraphs.push(Object.freeze({ from: offsets[first] ?? from, to: offsets[last] ?? to, level: resolved.base }));
        for (let atom = 0; atom < atomFrom.length; atom++) for (let i = atomFrom[atom]!; i < atomTo[atom]!; i++) for (let unit = offsets[i]!; unit < (offsets[i + 1] ?? to); unit++) {
            const level = resolved.levels[atom]!; levels.push(level < 0 ? null : level); inverse.push(-1); if (spent(c)) yield;
        }
        for (const atom of resolved.order) {
            const a = atomFrom[atom]!, b = atomTo[atom]!, direction = resolved.levels[atom]! % 2 ? -1 : 1;
            for (let i = direction > 0 ? a : b - 1; direction > 0 ? i < b : i >= a; i += direction) {
                const unit = offsets[i]!; inverse[unit - from] = order.length; order.push(unit); if (spent(c)) yield;
            }
        }
        first = last; c.phase = "resolve";
    }
    return makeIndex(from, to, levels, order, inverse, paragraphs);
}

/** Cooperative Unicode 18 paragraph resolution. Text reads and all data-sized passes yield. */
export class BidiCursor {
    private readonly driver: KernelCursor<BidiStep>;
    constructor(source: TextBuffer | string, options: Readonly<{ from?: number; to?: number; direction?: BidiDirection }> = {}) {
        const from = options.from ?? 0, to = options.to ?? source.length, direction = options.direction ?? "ltr";
        if (![from, to].every(Number.isSafeInteger) || from < 0 || from > to || to > source.length) throw new RangeError("Invalid bidi range.");
        if (direction !== "ltr" && direction !== "rtl" && direction !== "auto") throw new TypeError("Invalid bidi direction.");
        const counters: Counters = { work: 0, yielded: 0, scanned: 0, reads: 0, phase: "scan" };
        this.driver = kernelCursor(build(source, from, to, direction, counters), () => counters.work,
            (status, result, failure): BidiStep => Object.freeze({ status, phase: status === "running" ? counters.phase : status,
                scannedUnits: counters.scanned, readUnits: counters.reads, workUnits: counters.work, result, failure }), "Bidi");
    }
    next(workBudget = 4096): BidiStep { return this.driver.next(workBudget); }
    snapshot(): BidiStep { return this.driver.snapshot(); }
    dispose(): void { this.driver.dispose(); }
}
