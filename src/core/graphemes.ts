import { isOffsetRange, isPositiveInteger } from "./bounds.ts";
import type { TextBuffer } from "./text-buffer.ts";
import { highSurrogate, lowSurrogate } from "./utf16.ts";
import { kernelCursor } from "./kernel-cursor.ts";
import type { KernelStatus } from "./kernel-cursor.ts";

export type GraphemeSource = Readonly<{ kind: "buffer"; buffer: TextBuffer }> | Readonly<{ kind: "string"; text: string }>;
export type GraphemeRange = Readonly<{ from: number; to: number }>;
export type GraphemeOptions = Readonly<{ from?: number; to?: number; maxOperations?: number; maxClusters?: number }>;
export type GraphemeProgress = Readonly<{ status: KernelStatus; phase: "scan" | "publish";
    scannedUnits: number; readUnits: number; inputPoints: number; publishedBoundaries: number; completedClusters: number; workUnits: number; result: GraphemeIndex | null; failure: string | null }>;
export type GraphemeCursor = Readonly<{ next: (workBudget?: number) => GraphemeProgress; snapshot: () => GraphemeProgress; dispose: () => void }>;
export class GraphemeLimitError extends Error {
    readonly limit: "operations" | "clusters";
    constructor(limit: "operations" | "clusters") { super(`Grapheme segmentation exceeded its ${limit} limit.`); this.name = "GraphemeLimitError"; this.limit = limit; }
}
let publish: (source: GraphemeSource, from: number, to: number, blocks: readonly (readonly number[])[], count: number) => GraphemeIndex;
const range = (length: number, from: number, to: number) => { if (!isOffsetRange(from, to, length)) throw new RangeError("Invalid grapheme range."); };

/** Immutable extended-grapheme boundaries. Coordinates are absolute UTF-16 offsets. */
export class GraphemeIndex {
    readonly source: GraphemeSource; readonly from: number; readonly to: number; readonly clusterCount: number; readonly boundaryCount: number;
    readonly #blocks: readonly (readonly number[])[];
    private constructor(source: GraphemeSource, from: number, to: number, blocks: readonly (readonly number[])[], count: number) {
        this.source = source; this.from = from; this.to = to; this.#blocks = blocks; this.boundaryCount = count; this.clusterCount = count - 1; Object.freeze(this);
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
type Counters = { phase: "scan" | "publish"; scanned: number; reads: number; points: number; boundaries: number; clusters: number; work: number };
let segmenter: Intl.Segmenter | undefined;
function* segment(source: GraphemeSource, from: number, to: number, maxOperations: number, maxClusters: number,
    c: Counters): Generator<void, GraphemeIndex | null> {
    const input = source.kind === "buffer" ? source.buffer : source.text;
    const pieces: string[] = [];
    let previous = -1;
    for (let start = from; start < to; start += 256) {
        const piece = input.slice(start, Math.min(to, start + 256));
        pieces.push(piece);
        c.reads += piece.length;
        c.work += piece.length;
        if (c.work > maxOperations) throw new GraphemeLimitError("operations");
        for (let i = 0; i < piece.length; i++) {
            const unit = piece.charCodeAt(i);
            if (!(highSurrogate(previous) && lowSurrogate(unit))) c.points++;
            previous = unit;
        }
        c.scanned += piece.length;
        yield;
    }
    // Feed one range to the segmenter. A rope or read boundary may split a cluster.
    const text = pieces.join("");
    pieces.length = 0;
    segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const blocks: (readonly number[])[] = [];
    let block: number[] = [];
    function boundary(at: number) {
        if (++c.work > maxOperations) throw new GraphemeLimitError("operations");
        if (c.boundaries > maxClusters) throw new GraphemeLimitError("clusters");
        block.push(at);
        c.clusters = c.boundaries++;
        if (block.length === 256) {
            blocks.push(Object.freeze(block));
            block = [];
        }
    }
    c.phase = "publish";
    for (const part of segmenter.segment(text)) {
        boundary(from + part.index);
        if (!block.length) yield;
    }
    boundary(to);
    if (block.length) blocks.push(Object.freeze(block));
    return publish(source, from, to, Object.freeze(blocks), c.boundaries);
}
function drive(iterator: Generator<void, GraphemeIndex | null> | null, c: Counters): GraphemeCursor {
    const cursor = kernelCursor(iterator, () => c.work, (status, result, failure): GraphemeProgress => Object.freeze({ status, phase: c.phase, scannedUnits: c.scanned, readUnits: c.reads,
        inputPoints: c.points, publishedBoundaries: c.boundaries, completedClusters: c.clusters, workUnits: c.work, result, failure }), "Grapheme"); iterator = null; return cursor;
}
function create(source: GraphemeSource, length: number, options: GraphemeOptions): GraphemeCursor {
    const from = options.from ?? 0, to = options.to ?? length; range(length, from, to);
    const maxOperations = options.maxOperations ?? Math.max(1_000_000, (to - from) * 16), maxClusters = options.maxClusters ?? Math.max(1_000_000, to - from);
    if (![maxOperations, maxClusters].every(isPositiveInteger)) throw new RangeError("Invalid grapheme limits.");
    const c: Counters = { phase: "scan", scanned: 0, reads: 0, points: 0, boundaries: 0, clusters: 0, work: 0 }; return drive(segment(source, from, to, maxOperations, maxClusters, c), c);
}
export function createGraphemeCursor(source: TextBuffer | string, options: GraphemeOptions = {}): GraphemeCursor { return create(typeof source === "string" ? Object.freeze({ kind: "string", text: source }) : Object.freeze({ kind: "buffer", buffer: source }), source.length, options); }
/** Build the complete index for one synchronous editor command. */
export function indexGraphemes(source: TextBuffer | string, options?: GraphemeOptions): GraphemeIndex {
    const cursor = createGraphemeCursor(source, options);
    try {
        return cursor.next(Number.MAX_SAFE_INTEGER).result!;
    } finally {
        cursor.dispose();
    }
}

export function graphemeBoundaries(text: string): readonly number[] {
    return indexGraphemes(text).boundaries();
}
