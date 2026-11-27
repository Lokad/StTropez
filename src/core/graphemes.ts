import { partitionPoint } from "./bound-search.ts";
import type { GraphemePoint } from "./grapheme-point.ts";

let segmenter: Intl.Segmenter | undefined;

/** Segment the complete string so a rope seam cannot split a grapheme. */
export function graphemeBoundaries(text: string, from = 0): readonly number[] {
    segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const boundaries: number[] = [];
    for (const part of segmenter.segment(text)) boundaries.push(from + part.index);
    boundaries.push(from + text.length);
    return Object.freeze(boundaries);
}

/** The editor asks for all four neighbors at once when moving or deleting. */
export function pointAtBoundaries(boundaries: readonly number[], offset: number): GraphemePoint {
    const next = partitionPoint(boundaries.length, index => boundaries[index]! <= offset);
    const floor = boundaries[next - 1]!;
    const following = boundaries[next] ?? null;
    return { offset, floor, ceil: floor === offset ? floor : following!,
        preceding: floor === offset ? boundaries[next - 2] ?? null : floor, following };
}
