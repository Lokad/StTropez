import { lineEdges, tick } from "./diff-index.ts";
import type { DiffIndex, DiffStats } from "./diff-index.ts";

type EqualRange = Readonly<{ a: number; b: number; length: number }>;
export type DiffEqualitySnapshot = Readonly<{ index: DiffIndex; ranges: readonly EqualRange[] }>;
const limit = 32;
export const minimumEqualRows = 32;
const row = (index: DiffIndex, offset: number) => offset === index.to ? index.lines.size : index.buffer.lineAt(offset);

/** Retain only complete equal rows outside an ownership-proven changed interval. */
export function* prepareEqualities(index: DiffIndex, prior: DiffEqualitySnapshot | undefined, stats: DiffStats): Generator<void, DiffEqualities> {
    const mapped: EqualRange[] = [];
    if (prior?.ranges.length) {
        const edges = yield* lineEdges(prior.index.buffer, index.buffer, stats);
        const prefix = row(prior.index, edges.aFrom), suffix = row(prior.index, edges.aTo), shifted = row(index, edges.bTo) - suffix;
        for (const range of prior.ranges) {
            const prefixEnd = Math.min(range.b + range.length, prefix);
            if (prefixEnd - range.b >= minimumEqualRows) mapped.push(Object.freeze({ a: range.a, b: range.b, length: prefixEnd - range.b }));
            const suffixStart = Math.max(range.b, suffix), remaining = range.b + range.length - suffixStart;
            if (remaining >= minimumEqualRows) mapped.push(Object.freeze({ a: range.a + suffixStart - range.b, b: suffixStart + shifted, length: remaining }));
            if (tick(stats, 4)) yield;
        }
    }
    // Splitting at the changed interval can double the bounded input list.
    mapped.sort((a, b) => b.length - a.length);
    if (tick(stats, mapped.length * 8)) yield;
    mapped.length = Math.min(limit, mapped.length);
    const owner = new DiffEqualities(index, mapped);
    if (tick(stats, mapped.length * 3)) yield;
    return owner;
}

export class DiffEqualities {
    private readonly ranges: EqualRange[];
    private readonly index: DiffIndex;
    private readonly prior = new Map<number, EqualRange[]>();
    readonly hasPrior: boolean;
    constructor(index: DiffIndex, prior: readonly EqualRange[]) {
        this.index = index; this.ranges = [...prior]; this.hasPrior = prior.length > 0;
        for (const range of prior) {
            const diagonal = range.a - range.b, ranges = this.prior.get(diagonal);
            if (ranges) ranges.push(range); else this.prior.set(diagonal, [range]);
        }
    }
    // A proof only extends the exact diagonal the existing traversal already chose.
    // Stop at its boundary; ordinary equality checks still establish the maximal run.
    match(a: number, b: number, maximum: number, reverse: boolean, stats: DiffStats): number {
        let matched = 0;
        const ranges = this.prior.get(a - b); stats.work++;
        if (!ranges) return matched;
        // At most 32 entries. The caller checks the charged checkpoint after this lookup.
        for (const range of ranges) {
            const offset = a - range.a;
            if (reverse ? offset > 0 && offset <= range.length : offset >= 0 && offset < range.length)
                matched = Math.max(matched, Math.min(maximum, reverse ? offset : range.length - offset));
            stats.work++;
        }
        return matched;
    }
    *remember(a: number, b: number, length: number, stats: DiffStats): Generator<void, void> {
        if (length < minimumEqualRows) return;
        for (let i = this.ranges.length - 1; i >= 0; i--) {
            const prior = this.ranges[i]!; let work = 1;
            if (a - b === prior.a - prior.b && a <= prior.a + prior.length && a + length >= prior.a) {
                const end = Math.max(a + length, prior.a + prior.length), start = Math.min(a, prior.a);
                b -= a - start; a = start; length = end - start; work += this.ranges.length - i; this.ranges.splice(i, 1);
            }
            if (tick(stats, work)) yield;
        }
        const range = Object.freeze({ a, b, length });
        if (this.ranges.length < limit) this.ranges.push(range);
        else {
            let shortest = 0;
            for (let i = 1; i < this.ranges.length; i++) { if (this.ranges[i]!.length < this.ranges[shortest]!.length) shortest = i; if (tick(stats)) yield; }
            if (length > this.ranges[shortest]!.length) this.ranges[shortest] = range;
        }
        if (tick(stats, limit)) yield;
    }
    *finish(stats: DiffStats): Generator<void, DiffEqualitySnapshot> {
        const ranges = Object.freeze([...this.ranges]);
        if (tick(stats, ranges.length)) yield;
        return Object.freeze({ index: this.index, ranges });
    }
}
