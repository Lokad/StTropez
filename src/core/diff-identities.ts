import type { DiffLine } from "./diff-lines.ts";
import { commonText, offsetAt, tick } from "./diff-index.ts";
import type { DiffIndex, DiffStats } from "./diff-index.ts";

type LongLine = readonly string[];
// Captured line metadata owns this memoization; neither buffers nor old revisions are retained.
const longLines = new WeakMap<DiffLine, LongLine>();
const longHashes = new WeakMap<LongLine, number>();
export const knownLineHash = (line: DiffLine): number | undefined => {
    const known = longLines.get(line); return line.hash ?? (known && longHashes.get(known));
};

function* longLine(index: DiffIndex, row: number, line: DiffLine, stats: DiffStats): Generator<void, LongLine> {
    const known = longLines.get(line); if (known) return known;
    const from = offsetAt(index, row), chunks: string[] = [];
    for (let offset = 0; offset < line.length; offset += 256) {
        const text = index.buffer.slice(from + offset, from + Math.min(line.length, offset + 256)); chunks.push(text);
        stats.readUnits += text.length; if (tick(stats, text.length)) yield;
    }
    const result = Object.freeze(chunks);
    longLines.set(line, result); return result;
}
export function* lineHash(index: DiffIndex, row: number, line: DiffLine, stats: DiffStats): Generator<void, number> {
    const known = knownLineHash(line); if (known !== undefined) return known;
    const chunks = yield* longLine(index, row, line, stats); let hash = 2166136261;
    for (const text of chunks) {
        for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
        if (tick(stats, text.length)) yield;
    }
    hash >>>= 0; longHashes.set(chunks, hash); return hash;
}

/** Reuse inspected equal chunks only when the whole line required a literal scan. */
export function* equalLineText(a: DiffIndex, ai: number, left: DiffLine, b: DiffIndex, bi: number, right: DiffLine, stats: DiffStats): Generator<void, boolean> {
    const af = offsetAt(a, ai), bf = offsetAt(b, bi); let chunks: string[] | undefined = [];
    const same = (yield* commonText(a.buffer, b.buffer, af, af + left.length, bf, bf + right.length, "start", stats, (text, before) => {
        if (!chunks || before !== chunks.length * 256) { chunks = undefined; return; }
        chunks.push(text);
    })) === left.length;
    if (same && chunks?.length && chunks.length === Math.ceil(left.length / 256)) {
        const token = Object.freeze(chunks); longLines.set(left, token); longLines.set(right, token);
    }
    return same;
}

/** Exact integer identities in one job's namespace. Every string key is at most 256 units. */
export class DiffIdentities {
    private next = 1;
    private readonly chunks = new Map<string, number>();
    private readonly links = new Map<number, Map<number, number>>();
    private lines = new WeakMap<DiffLine, number>();
    private probes = new WeakMap<DiffLine, number>();
    readonly known = (line: DiffLine): number | undefined => this.lines.get(line);
    cached(line: DiffLine): boolean { return line.token !== undefined || longLines.has(line); }
    repeated(line: DiffLine): boolean {
        const count = (this.probes.get(line) ?? 0) + 1; this.probes.set(line, count);
        // Prefix/suffix trimming and a single-row comparison can probe the same huge
        // changed line three times. Keep their cheap shared-text proofs without indexing it.
        return count > 3;
    }
    *identify(index: DiffIndex, row: number, line: DiffLine, stats: DiffStats): Generator<void, number> {
        const known = this.lines.get(line); if (known !== undefined) return known;
        const chunks = line.token === undefined ? yield* longLine(index, row, line, stats) : [line.token];
        let id = 0;
        for (const text of chunks) {
            let chunk = this.chunks.get(text);
            if (chunk === undefined) { chunk = this.next++; this.chunks.set(text, chunk); }
            if (!id) id = chunk;
            else {
                let links = this.links.get(id); if (!links) { links = new Map(); this.links.set(id, links); }
                let joined = links.get(chunk); if (joined === undefined) { joined = this.next++; links.set(chunk, joined); }
                id = joined;
            }
            if (tick(stats)) yield;
        }
        this.lines.set(line, id); return id;
    }
    clear(): void {
        this.chunks.clear(); this.links.clear(); this.lines = new WeakMap(); this.probes = new WeakMap(); this.next = 1;
    }
}
