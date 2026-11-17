import type { TextBuffer } from "./text-buffer.ts";
import { DiffLines } from "./diff-lines.ts";
import type { DiffLine } from "./diff-lines.ts";

type TextProof = Readonly<{ a: TextBuffer; b: TextBuffer; from: number; otherFrom: number; length: number }>;
export type DiffStats = { work: number; yielded: number; readUnits: number; lineComparisons: number; lineEdits: number; textProof?: TextProof | undefined };
export type DiffIndex = Readonly<{ buffer: TextBuffer; to: number; lines: DiffLines }>;
type Edges = Readonly<{ aFrom: number; aTo: number; bTo: number }>;
export const tick = (stats: DiffStats, units = 1): boolean => { stats.work += units; if (stats.work - stats.yielded < 256) return false; stats.yielded = stats.work; return true; };
function* ownedEdge(a: TextBuffer, b: TextBuffer, from: number, to: number, otherFrom: number, otherTo: number, side: "start" | "end", stats: DiffStats): Generator<void, number> {
    let length = 0;
    for (const proved of a.sharedEdge(b, side, { from, to, otherFrom, otherTo })) { length = proved; if (tick(stats)) yield; }
    return length;
}
/** Ownership proves which complete row slots may reuse metadata across revisions. */
export function* lineEdges(a: TextBuffer, b: TextBuffer, stats: DiffStats): Generator<void, Edges> {
    const prefix = yield* ownedEdge(a, b, 0, a.length, 0, b.length, "start", stats);
    if (prefix === a.length && prefix === b.length) return { aFrom: a.length, aTo: a.length, bTo: b.length };
    const suffix = yield* ownedEdge(a, b, prefix, a.length, prefix, b.length, "end", stats);
    const aFrom = a.offsetAt(a.lineAt(prefix));
    let aTo = a.length - suffix, bTo = b.length - suffix;
    if (a.offsetAt(a.lineAt(aTo)) !== aTo || b.offsetAt(b.lineAt(bTo)) !== bTo) {
        const al = a.lineAt(aTo) + 1, bl = b.lineAt(bTo) + 1;
        aTo = al < a.lineCount ? a.offsetAt(al) : a.length; bTo = bl < b.lineCount ? b.offsetAt(bl) : b.length;
    }
    return { aFrom, aTo, bTo };
}
export function* commonText(a: TextBuffer, b: TextBuffer, from: number, to: number, otherFrom: number, otherTo: number, side: "start" | "end", stats: DiffStats,
    inspected?: (text: string, matchedBefore: number) => void): Generator<void, number> {
    let common = yield* ownedEdge(a, b, from, to, otherFrom, otherTo, side, stats);
    const maximum = Math.min(to - from, otherTo - otherFrom);
    const proof = stats.textProof;
    // Reuse only exact code units on the same captured alignment; continue at its boundary.
    if (common < maximum && proof) {
        const af = side === "start" ? from + common : to - common;
        const bf = side === "start" ? otherFrom + common : otherTo - common;
        const offset = af - proof.from;
        if (proof.a === a && proof.b === b && af - bf === proof.from - proof.otherFrom
            && (side === "start" ? offset >= 0 && offset < proof.length : offset > 0 && offset <= proof.length))
            common += Math.min(maximum - common, side === "start" ? proof.length - offset : offset);
        if (tick(stats, 12)) yield;
    }
    while (common < maximum) {
        const length = Math.min(256, maximum - common), af = side === "start" ? from + common : to - common - length;
        const bf = side === "start" ? otherFrom + common : otherTo - common - length;
        const av = a.slice(af, af + length), bv = b.slice(bf, bf + length); let matched = av === bv ? length : 0;
        while (matched < length && av[side === "start" ? matched : length - matched - 1] === bv[side === "start" ? matched : length - matched - 1]) matched++;
        if (matched === length) inspected?.(av, common);
        common += matched; stats.readUnits += length * 2; if (tick(stats, length * 2)) yield;
        if (matched < length) break;
    }
    // A single job-local span also retains a checked prefix of an unequal row.
    if (common >= 256 && (!proof || proof.a !== a || proof.b !== b || common >= proof.length)) {
        stats.textProof = Object.freeze({ a, b, from: side === "start" ? from : to - common,
            otherFrom: side === "start" ? otherFrom : otherTo - common, length: common });
        if (tick(stats, 8)) yield;
    }
    return common;
}
const rows = (buffer: TextBuffer): number => buffer.length ? buffer.lineAt(buffer.length - 1) + 1 : 0;
const rowAt = (index: DiffIndex, position: number): number => position === index.to ? index.lines.size : index.buffer.lineAt(position);
export const offsetAt = (index: DiffIndex, row: number): number => row === index.lines.size ? index.to : index.buffer.offsetAt(row);
export const lineLength = (index: DiffIndex, row: number): number => index.lines.at(row)?.length ?? offsetAt(index, row + 1) - offsetAt(index, row);
/** Only complete metadata blocks are memoized; cancellation can discard the local build. */
export function* getLine(index: DiffIndex, row: number, stats: DiffStats): Generator<void, DiffLine> {
    const known = index.lines.at(row); if (known) return known;
    const from = Math.floor(row / 64) * 64, to = Math.min(index.lines.size, from + 64), block: DiffLine[] = [];
    for (let line = from; line < to; line++) {
        const existing = index.lines.at(line);
        if (existing) { block.push(existing); if (tick(stats)) yield; continue; }
        const position = offsetAt(index, line), end = offsetAt(index, line + 1), length = end - position;
        let hash: number | undefined, token: string | undefined;
        if (length <= 256) {
            token = index.buffer.slice(position, end); hash = 2166136261;
            for (let i = 0; i < token.length; i++) hash = Math.imul(hash ^ token.charCodeAt(i), 16777619);
            hash >>>= 0; stats.readUnits += length;
        }
        block.push(Object.freeze({ length, hash, token }));
        if (tick(stats, Math.max(1, token?.length ?? 1))) yield;
    }
    index.lines.materialize(from, to, block); if (tick(stats, 256)) yield;
    return index.lines.at(row)!;
}
/** Full row coordinates with implicit gaps: extending a comparison never eagerly indexes its interior. */
export function* indexLines(buffer: TextBuffer, stats: DiffStats, prior?: DiffIndex): Generator<void, DiffIndex> {
    if (prior?.buffer === buffer) return prior;
    const size = rows(buffer); let lines = DiffLines.gap(size);
    if (prior) {
        const edges = yield* lineEdges(prior.buffer, buffer, stats);
        const prefix = rowAt(prior, edges.aFrom), oldSuffix = rowAt(prior, edges.aTo), suffix = edges.bTo === buffer.length ? size : buffer.lineAt(edges.bTo);
        lines = prior.lines.slice(0, prefix).concat(DiffLines.gap(suffix - prefix)).concat(prior.lines.slice(oldSuffix, prior.lines.size));
        if (tick(stats, 256)) yield;
    }
    return Object.freeze({ buffer, to: buffer.length, lines });
}
/** Count whole equal row tokens without materializing their metadata. */
export function* matchingLines(a: DiffIndex, b: DiffIndex, a0: number, a1: number, b0: number, b1: number, reverse: boolean, stats: DiffStats, exact = false): Generator<void, number> {
    const af = offsetAt(a, a0), at = offsetAt(a, a1), bf = offsetAt(b, b0), bt = offsetAt(b, b1);
    const proved = exact ? yield* commonText(a.buffer, b.buffer, af, at, bf, bt, reverse ? "end" : "start", stats)
        : yield* ownedEdge(a.buffer, b.buffer, af, at, bf, bt, reverse ? "end" : "start", stats);
    if (!proved) return 0;
    if (proved === at - af && proved === bt - bf) return Math.min(a1 - a0, b1 - b0);
    if (!reverse) return Math.min(a.buffer.lineAt(af + proved) - a.buffer.lineAt(af), b.buffer.lineAt(bf + proved) - b.buffer.lineAt(bf));
    let ap = at - proved, bp = bt - proved;
    if (a.buffer.offsetAt(a.buffer.lineAt(ap)) !== ap || b.buffer.offsetAt(b.buffer.lineAt(bp)) !== bp) {
        const al = a.buffer.lineAt(ap) + 1, bl = b.buffer.lineAt(bp) + 1;
        ap = al < a.buffer.lineCount ? Math.min(at, a.buffer.offsetAt(al)) : at;
        bp = bl < b.buffer.lineCount ? Math.min(bt, b.buffer.offsetAt(bl)) : bt;
    }
    return Math.min(a1 - rowAt(a, ap), b1 - rowAt(b, bp));
}
