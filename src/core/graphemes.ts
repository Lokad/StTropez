import type { TextBuffer } from "./text-buffer.ts";
import { graphemeProperties, graphemeUnicodeVersion } from "./grapheme-data.ts";
import { kernelCursor } from "./kernel-cursor.ts";
import { utf16CodePointAt } from "./utf16.ts";

export type GraphemeSource = Readonly<{ kind: "buffer"; buffer: TextBuffer }> | Readonly<{ kind: "string"; text: string }>;
export type GraphemeRange = Readonly<{ from: number; to: number }>;
export type GraphemeOptions = Readonly<{ from?: number; to?: number; maxOperations?: number; maxClusters?: number }>;
export type GraphemeProgress = Readonly<{ status: "running" | "ready" | "failed" | "disposed"; phase: "scan" | "publish";
    scannedUnits: number; readUnits: number; inputPoints: number; publishedBoundaries: number; completedClusters: number; workUnits: number; result: GraphemeIndex | null; failure: string | null }>;
export type GraphemeCursor = Readonly<{ next: (workBudget?: number) => GraphemeProgress; snapshot: () => GraphemeProgress; dispose: () => void }>;
export class GraphemeLimitError extends Error {
    readonly limit: "operations" | "clusters";
    constructor(limit: "operations" | "clusters") { super(`Grapheme segmentation exceeded its ${limit} limit.`); this.name = "GraphemeLimitError"; this.limit = limit; }
}
const owned = new WeakSet<GraphemeIndex>();
export const ownedGraphemeIndex = (value: unknown): value is GraphemeIndex => typeof value === "object" && value !== null && owned.has(value as GraphemeIndex);
let publish: (source: GraphemeSource, from: number, to: number, blocks: readonly (readonly number[])[], count: number) => GraphemeIndex;
const range = (length: number, from: number, to: number) => { if (![from, to].every(Number.isSafeInteger) || from < 0 || from > to || to > length) throw new RangeError("Invalid grapheme range."); };

/** Immutable extended-grapheme boundaries. Coordinates are absolute UTF-16 offsets. */
export class GraphemeIndex {
    readonly source: GraphemeSource; readonly from: number; readonly to: number; readonly clusterCount: number; readonly boundaryCount: number; readonly unicodeVersion = graphemeUnicodeVersion;
    readonly #blocks: readonly (readonly number[])[];
    private constructor(source: GraphemeSource, from: number, to: number, blocks: readonly (readonly number[])[], count: number) {
        this.source = source; this.from = from; this.to = to; this.#blocks = blocks; this.boundaryCount = count; this.clusterCount = count - 1; owned.add(this); Object.freeze(this);
    }
    boundaryAt(index: number): number { range(this.boundaryCount, index, index + 1); return this.#blocks[Math.floor(index / 256)]![index % 256]!; }
    clusterAt(index: number): GraphemeRange { range(this.clusterCount, index, index + 1); return Object.freeze({ from: this.boundaryAt(index), to: this.boundaryAt(index + 1) }); }
    #floorIndex(offset: number): number {
        if (!Number.isSafeInteger(offset) || offset < this.from || offset > this.to) throw new RangeError("Invalid grapheme offset.");
        let low = 0, high = this.boundaryCount; while (low + 1 < high) { const mid = (low + high) >>> 1; if (this.boundaryAt(mid) <= offset) low = mid; else high = mid; } return low;
    }
    isBoundary(offset: number): boolean { return this.boundaryAt(this.#floorIndex(offset)) === offset; }
    floor(offset: number): number { return this.boundaryAt(this.#floorIndex(offset)); }
    ceil(offset: number): number { const i = this.#floorIndex(offset), at = this.boundaryAt(i); return at === offset ? at : this.boundaryAt(i + 1); }
    preceding(offset: number): number | null { const i = this.#floorIndex(offset), at = this.boundaryAt(i); return at < offset ? at : i === 0 ? null : this.boundaryAt(i - 1); }
    following(offset: number): number | null { const i = this.#floorIndex(offset); return i + 1 === this.boundaryCount ? null : this.boundaryAt(i + 1); }
    clusterIndexAt(offset: number): number { if (offset === this.to) throw new RangeError("No grapheme contains the end offset."); return this.#floorIndex(offset); }
    /** Explicit materialization. Bounded consumers should query boundaryAt/clusterAt. */
    boundaries(fromIndex = 0, toIndex = this.boundaryCount): readonly number[] { range(this.boundaryCount, fromIndex, toIndex); const values: number[] = []; for (let i = fromIndex; i < toIndex; i++) values.push(this.boundaryAt(i)); return Object.freeze(values); }
    static { publish = (source, from, to, blocks, count) => new GraphemeIndex(source, from, to, blocks, count); }
}
type Counters = { phase: "scan" | "publish"; scanned: number; reads: number; points: number; boundaries: number; clusters: number; work: number; yielded: number };
const control = (gcb: number) => gcb >= 1 && gcb <= 3;
function* segment(source: GraphemeSource, from: number, to: number, maxOperations: number, maxClusters: number, c: Counters): Generator<void, GraphemeIndex | null> {
    const tick = (n = 1) => { c.work += n; if (c.work > maxOperations) throw new GraphemeLimitError("operations"); }, pause = () => { if (c.work - c.yielded < 256) return false; c.yielded = c.work; return true; };
    const blocks: (readonly number[])[] = []; let pending: number[] = [];
    function* boundary(at: number): Generator<void, void> { c.phase = "publish"; tick(); if (pause()) yield; if (c.boundaries > maxClusters) throw new GraphemeLimitError("clusters"); pending.push(at); c.boundaries++; c.clusters = c.boundaries - 1; if (pending.length === 256) { blocks.push(Object.freeze(pending)); pending = []; } }
    yield* boundary(from);
    let offset = from, windowFrom = from, window = "", previous = -1, regionalCount = 0, emojiExtends = false, previousZwjAfterEmoji = false, linker = false;
    while (offset < to) {
        c.phase = "scan"; let cp: number, width: number;
        if (offset >= windowFrom + window.length) {
            windowFrom = offset; const end = Math.min(to, offset + 256); window = source.kind === "buffer" ? source.buffer.slice(offset, end) : source.text.slice(offset, end); let reads = window.length;
            const last = window.charCodeAt(window.length - 1); if (last >= 0xd800 && last <= 0xdbff && end < to) { const tail = source.kind === "buffer" ? source.buffer.slice(end, end + 1) : source.text.slice(end, end + 1); reads++; const low = tail.charCodeAt(0); if (low >= 0xdc00 && low <= 0xdfff) window += tail; }
            c.reads += reads;
            // A surrogate peek can make a window 257 units. Charge it across exact quanta.
            for (let remaining = reads; remaining > 0;) { const n = Math.min(remaining, 256 - (c.work - c.yielded)); tick(n); remaining -= n; if (pause()) yield; }
        }
        cp = utf16CodePointAt(window, offset - windowFrom); width = cp > 0xffff ? 2 : 1;
        tick(); if (pause()) yield; const properties = graphemeProperties(cp), current = properties & 15, incb = properties >>> 4 & 3, pictographic = !!(properties & 64);
        let breaks = previous >= 0;
        if (previous === 1 && current === 2) breaks = false; // GB3
        else if (control(previous) || control(current)) { /* GB4/5 */ }
        else if (previous === 9 && (current === 9 || current === 10 || current === 12 || current === 13)) breaks = false; // GB6
        else if ((previous === 12 || previous === 10) && (current === 10 || current === 11)) breaks = false; // GB7
        else if ((previous === 13 || previous === 11) && current === 11) breaks = false; // GB8
        else if (current === 4 || current === 5 || current === 8 || previous === 7) breaks = false; // GB9/9a/9b
        else if (linker && incb === 1) breaks = false; // Unicode18 GB9c: Linker Extend* x Consonant
        else if (previous === 5 && previousZwjAfterEmoji && pictographic) breaks = false; // GB11
        else if (previous === 6 && current === 6 && regionalCount % 2 === 1) breaks = false; // GB12/13
        if (breaks) yield* boundary(offset);
        previousZwjAfterEmoji = current === 5 && emojiExtends;
        if (pictographic) emojiExtends = true; else if (current !== 4) emojiExtends = false;
        if (incb === 3) linker = true; else if (incb !== 2) linker = false;
        regionalCount = current === 6 ? regionalCount + 1 : 0; previous = current; offset += width; c.scanned = offset - from; c.points++;
    }
    if (to > from) yield* boundary(to); if (pending.length) blocks.push(Object.freeze(pending)); return publish(source, from, to, Object.freeze(blocks), c.boundaries);
}
function drive(iterator: Generator<void, GraphemeIndex | null> | null, c: Counters): GraphemeCursor {
    const cursor = kernelCursor(iterator, () => c.work, (status, result, failure): GraphemeProgress => Object.freeze({ status, phase: c.phase, scannedUnits: c.scanned, readUnits: c.reads,
        inputPoints: c.points, publishedBoundaries: c.boundaries, completedClusters: c.clusters, workUnits: c.work, result, failure }), "Grapheme"); iterator = null; return cursor;
}
function create(source: GraphemeSource, length: number, options: GraphemeOptions): GraphemeCursor {
    const from = options.from ?? 0, to = options.to ?? length; range(length, from, to);
    const maxOperations = options.maxOperations ?? Math.max(1_000_000, (to - from) * 16), maxClusters = options.maxClusters ?? Math.max(1_000_000, to - from);
    if (![maxOperations, maxClusters].every(v => Number.isSafeInteger(v) && v > 0)) throw new RangeError("Invalid grapheme limits.");
    const c: Counters = { phase: "scan", scanned: 0, reads: 0, points: 0, boundaries: 0, clusters: 0, work: 0, yielded: 0 }; return drive(segment(source, from, to, maxOperations, maxClusters, c), c);
}
export function createGraphemeCursor(source: TextBuffer | string, options: GraphemeOptions = {}): GraphemeCursor { return create(typeof source === "string" ? Object.freeze({ kind: "string", text: source }) : Object.freeze({ kind: "buffer", buffer: source }), source.length, options); }
export function graphemeBoundaries(text: string): readonly number[] {
    if (typeof text !== "string") throw new TypeError("Invalid grapheme text."); const cursor = createGraphemeCursor(text); try { let step = cursor.next(65536); while (step.status === "running") step = cursor.next(65536); return step.result!.boundaries(); } finally { cursor.dispose(); }
}
