import type { Affinity, PositionMapping } from "./positions.ts";
import { partitionPoint } from "./bound-search.ts";

/** Integer-position domains are half open; only their final sentinel may be MAX_SAFE_INTEGER + 1. */
export type PositionPiece = Readonly<{ from: number; to: number; offset: number; slope: 0 | 1; deleted: boolean }>;
export type PositionSpan = Readonly<{ from: number; to: number }>;
export type MappingGeometry = Readonly<{ oldLength: number; newLength: number;
    points: readonly [readonly PositionPiece[], readonly PositionPiece[]];
    covers: readonly (readonly PositionSpan[])[]; expandedPointDeletes: readonly PositionSpan[] }>;
const sideIndex = (side: Affinity): number => side === "before" ? 0 : 1;
export const pieceOffset = (piece: PositionPiece, offset: number): number => piece.offset + (offset - piece.from) * piece.slope;

export function pieceAt(pieces: readonly PositionPiece[], offset: number): number {
    return partitionPoint(pieces.length, index => pieces[index]!.to <= offset);
}
function append(pieces: PositionPiece[], piece: PositionPiece): void {
    const last = pieces.at(-1);
    if (last && last.to === piece.from && last.deleted === piece.deleted) {
        const slope = last.to - last.from === 1 ? piece.to - piece.from === 1 ? piece.offset - last.offset : piece.slope : last.slope;
        if ((slope === 0 || slope === 1) && (piece.to - piece.from === 1 || piece.slope === slope) && last.offset + (piece.from - last.from) * slope === piece.offset) {
            pieces[pieces.length - 1] = { ...last, to: piece.to, slope }; return;
        }
    }
    pieces.push(piece);
}
function freezePieces(pieces: PositionPiece[]): readonly PositionPiece[] { return Object.freeze(pieces.map(piece => Object.freeze(piece))); }

/** For nonempty ranges, containment invalidates; overlapping covers must NOT be joined. */
function covers(spans: readonly PositionSpan[]): readonly PositionSpan[] {
    const result: PositionSpan[] = [];
    for (const span of [...spans].sort((a, b) => a.from - b.from || b.to - a.to)) {
        if (span.from < span.to && (!result.length || span.to > result.at(-1)!.to)) result.push(Object.freeze(span));
    }
    return Object.freeze(result);
}
/** For point predicates, adjacent integer intervals really do form one set. */
function pointSet(spans: readonly PositionSpan[]): readonly PositionSpan[] {
    const result: PositionSpan[] = [];
    for (const span of [...spans].sort((a, b) => a.from - b.from || a.to - b.to)) {
        if (span.from > span.to) continue;
        const last = result.at(-1);
        if (last && span.from <= last.to + 1) result[result.length - 1] = { from: last.from, to: Math.max(last.to, span.to) };
        else result.push(span);
    }
    return Object.freeze(result.map(span => Object.freeze(span)));
}
export function covered(spans: readonly PositionSpan[], from: number, to: number): boolean {
    const low = partitionPoint(spans.length, index => spans[index]!.from <= from);
    return low > 0 && to <= spans[low - 1]!.to;
}

/** Compile only known edit boundaries; never scan document positions or retain source text. */
export function batchGeometry(mapping: PositionMapping, boundaries: readonly number[], consumed: readonly PositionSpan[]): MappingGeometry {
    const cuts = [...new Set([0, mapping.oldLength + 1, ...boundaries])].sort((a, b) => a - b);
    const points = (["before", "after"] as const).map(side => {
        const result: PositionPiece[] = [];
        for (let index = 0; index + 1 < cuts.length; index++) {
            const from = cuts[index]!, to = cuts[index + 1]!, first = mapping.map(from, side);
            const slope = to - from > 1 ? (mapping.map(to - 1, side).offset - first.offset) / (to - from - 1) as 0 | 1 : 0;
            append(result, { from, to, offset: first.offset, slope, deleted: first.deleted });
        }
        return freezePieces(result);
    }) as [readonly PositionPiece[], readonly PositionPiece[]];
    const joined: PositionSpan[] = [];
    for (const span of consumed) {
        const last = joined.at(-1);
        if (last && last.to === span.from) joined[joined.length - 1] = { from: last.from, to: span.to };
        else joined.push({ from: span.from, to: span.to });
    }
    const invalid = covers(joined), zero = pointSet(points[0].filter(piece => piece.deleted).map(piece => ({ from: piece.from, to: piece.to - 1 })));
    return Object.freeze({ oldLength: mapping.oldLength, newLength: mapping.newLength, points: Object.freeze(points),
        covers: Object.freeze([invalid, invalid, invalid, invalid]), expandedPointDeletes: zero });
}

function composePoints(first: readonly PositionPiece[], second: readonly PositionPiece[]): readonly PositionPiece[] {
    const result: PositionPiece[] = []; let index = 0;
    for (const piece of first) {
        while (second[index]!.to <= piece.offset) index++;
        let from = piece.from;
        while (from < piece.to) {
            const input = pieceOffset(piece, from), next = second[index]!;
            const to = piece.slope ? Math.min(piece.to, from + (next.to - input)) : piece.to;
            append(result, { from, to, offset: pieceOffset(next, input), slope: piece.slope ? next.slope : 0, deleted: piece.deleted || next.deleted });
            from = to; if (from < piece.to) index++;
        }
    }
    return freezePieces(result);
}

/** First original position whose mapped value is >= value (or > value for strict). */
function preimage(pieces: readonly PositionPiece[], value: number, strict = false): number {
    const low = partitionPoint(pieces.length, index => {
        const piece = pieces[index]!, end = pieceOffset(piece, piece.to - 1);
        return end < value || strict && end === value;
    });
    const piece = pieces[low];
    return !piece ? pieces.at(-1)!.to : piece.slope ? piece.from + Math.max(0, value - piece.offset + (strict ? 1 : 0)) : piece.from;
}
function pullback(first: readonly PositionPiece[], second: readonly PositionPiece[], span: PositionSpan): PositionSpan {
    return { from: preimage(first, span.from), to: preimage(second, span.to, true) - 1 };
}

/** A zero-width before/after anchor may expand. Other affinity pairs remain zero-width. */
function expansion(points: MappingGeometry["points"]): Readonly<{ equal: readonly PositionSpan[]; expanded: readonly PositionSpan[] }> {
    const equal: PositionSpan[] = [], expanded: PositionSpan[] = [];
    let left = 0, right = 0;
    while (left < points[0].length && right < points[1].length) {
        const a = points[0][left]!, b = points[1][right]!, from = Math.max(a.from, b.from), to = Math.min(a.to, b.to) - 1;
        const startEqual = pieceOffset(a, from) === pieceOffset(b, from), endEqual = pieceOffset(a, to) === pieceOffset(b, to);
        if (startEqual && endEqual) equal.push({ from, to });
        else if (startEqual) { equal.push({ from, to: from }); if (from < to) expanded.push({ from: from + 1, to }); }
        else if (endEqual) { expanded.push({ from, to: to - 1 }); equal.push({ from: to, to }); }
        else expanded.push({ from, to });
        if (a.to <= b.to) left++; if (b.to <= a.to) right++;
    }
    return { equal: pointSet(equal), expanded: pointSet(expanded) };
}
function intersect(a: readonly PositionSpan[], b: readonly PositionSpan[]): PositionSpan[] {
    const result: PositionSpan[] = []; let left = 0, right = 0;
    while (left < a.length && right < b.length) {
        const x = a[left]!, y = b[right]!, from = Math.max(x.from, y.from), to = Math.min(x.to, y.to);
        if (from <= to) result.push({ from, to });
        if (x.to <= y.to) left++; if (y.to <= x.to) right++;
    }
    return result;
}

/** Semantic composition: endpoint functions plus nonempty-range and expanded-point deletion predicates. */
export function composeGeometry(first: MappingGeometry, second: MappingGeometry): MappingGeometry {
    const points: MappingGeometry["points"] = Object.freeze([composePoints(first.points[0], second.points[0]), composePoints(first.points[1], second.points[1])]);
    // A nonempty range that has not been invalidated cannot have collapsed. Its endpoints
    // therefore pull a later deletion cover back to one original interval. Keep contained
    // covers only once, but never join merely overlapping covers from different steps.
    const rangeCovers = first.covers.map((prior, index) => covers([...prior,
        ...second.covers[index]!.map(span => pullback(first.points[index >> 1]!, first.points[index & 1]!, span))]));
    const { equal, expanded } = expansion(first.points);
    const zero = pointSet([...first.expandedPointDeletes,
        ...intersect(equal, pointSet(second.expandedPointDeletes.map(span => pullback(first.points[0], first.points[0], span)))),
        ...intersect(expanded, pointSet(second.covers[1]!.map(span => pullback(first.points[0], first.points[1], span))))]);
    return Object.freeze({ oldLength: first.oldLength, newLength: second.newLength, points, covers: Object.freeze(rangeCovers), expandedPointDeletes: zero });
}

export function geometryPieces(geometry: MappingGeometry, side: Affinity): readonly PositionPiece[] { return geometry.points[sideIndex(side)]!; }
export function geometryInvalidates(geometry: MappingGeometry, from: number, to: number, fromSide: Affinity, toSide: Affinity, pointDeleted: boolean): boolean {
    if (from === to) return fromSide === "before" && toSide === "after" ? covered(geometry.expandedPointDeletes, from, to) : pointDeleted;
    return covered(geometry.covers[sideIndex(fromSide) * 2 + sideIndex(toSide)]!, from, to);
}
