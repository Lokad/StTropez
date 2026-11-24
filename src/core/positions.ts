import { validateTextEdits } from "./changes.ts";
import type { TextEdit } from "./changes.ts";
import { batchGeometry, composeGeometry, geometryChanges, geometryInvalidates, geometryPieces, pieceAt, pieceOffset } from "./position-geometry.ts";
import type { MappingGeometry } from "./position-geometry.ts";
import { partitionPoint } from "./bound-search.ts";

export type Affinity = "before" | "after";
export type MappedPosition = Readonly<{ offset: number; deleted: boolean }>;
export type AnchoredRange = Readonly<{ from: number; to: number; fromAffinity: Affinity; toAffinity: Affinity;
    onDelete: "collapse" | "invalidate" }>;
export type PositionMapping = Readonly<{ oldLength: number; newLength: number;
    map: (offset: number, affinity?: Affinity) => MappedPosition;
    /** Independent lookup cursor. Ordered endpoints reuse progress; arbitrary order remains valid. */
    createMapper?: () => PositionMapping["map"];
    mapRange: (range: AnchoredRange) => AnchoredRange | undefined;
    invert: () => PositionMapping }>;
type Change = Readonly<{ from: number; to: number; insertedLength: number; unitDeletion?: boolean; inverseUnitDeletion?: boolean }>;
type IndexedChange = Change & Readonly<{ deltaBefore: number; coveredTo: number }>;
type GeometryPair = Readonly<{ forward: MappingGeometry; reverse: MappingGeometry }>;
const compiledGeometry = Symbol("compiled position geometry");
const compactUnitChanges = Symbol("compact unit changes");
const unchangedEdges = Symbol("unchanged text edges");
const batchChanges = Symbol("batch text changes");
type UnchangedEdges = Readonly<{ prefix: number; suffix: number }>;

function position(length: number, offset: number): void {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > length) throw new RangeError("Position is outside the original document.");
}
function validateRange(length: number, from: number, to: number): void {
    position(length, from); position(length, to);
    if (to < from) throw new RangeError("Anchored ranges must be ordered.");
}
export function anchoredRange(length: number, from: number, to: number, options: Readonly<{
    fromAffinity?: Affinity; toAffinity?: Affinity; onDelete?: "collapse" | "invalidate" }> = {}): AnchoredRange {
    const fromAffinity = options.fromAffinity ?? "after", toAffinity = options.toAffinity ?? "before", onDelete = options.onDelete ?? "collapse";
    validateRange(length, from, to);
    return Object.freeze({ from, to, fromAffinity, toAffinity, onDelete });
}

/** Length-only construction is shared by forward and inverse maps. */
class ChangePositionMap implements PositionMapping {
    readonly oldLength: number;
    readonly newLength: number;
    private readonly changes: readonly IndexedChange[];
    #compiled: GeometryPair | undefined;
    constructor(oldLength: number, batch: readonly Change[] | { edits: readonly TextEdit[] }) {
        this.oldLength = oldLength;
        let delta = 0;
        const indexed: (Change & { deltaBefore: number; coveredTo: number })[] = [];
        const append = (from: number, to: number, insertedLength: number, change?: Change) => {
            indexed.push({ ...change, from, to, insertedLength, deltaBefore: delta, coveredTo: to });
            delta += insertedLength - (to - from);
        };
        if ("edits" in batch) {
            validateTextEdits(oldLength, batch.edits);
            for (const { from, to, insert } of batch.edits) {
                if (from !== to || insert.length) append(from, to, insert.length);
            }
        } else {
            for (const change of batch) append(change.from, change.to, change.insertedLength, change);
        }
        // Adjacent consumed intervals cover an original range even if insertions lie between them.
        for (let index = indexed.length - 1; index >= 0; index--) {
            const change = indexed[index]!, next = indexed[index + 1];
            if (next && change.to === next.from) change.coveredTo = next.coveredTo;
            Object.freeze(change);
        }
        this.changes = Object.freeze(indexed);
        this.newLength = oldLength + delta;
        if (!Number.isSafeInteger(this.newLength)) throw new RangeError("Resulting length exceeds safe positions.");
        Object.freeze(this);
    }
    [unchangedEdges](): UnchangedEdges {
        return { prefix: this.changes[0]?.from ?? this.oldLength, suffix: this.oldLength - (this.changes.at(-1)?.to ?? 0) };
    }
    [batchChanges](): readonly Change[] { return this.changes; }
    map(offset: number, side: Affinity = "after"): MappedPosition {
        position(this.oldLength, offset);
        return this.mapped(offset, side, this.preceding(offset, side));
    }
    createMapper(): PositionMapping["map"] {
        let previous = -1, before = -1, after = -1;
        return (offset, side = "after") => {
            position(this.oldLength, offset);
            if (offset !== previous) {
                before = this.preceding(offset, "before", offset > previous ? after + 1 : 0);
                after = this.preceding(offset, "after", before + 1);
                previous = offset;
            }
            return this.mapped(offset, side, side === "before" ? before : after);
        };
    }
    private mapped(offset: number, side: Affinity, index: number): MappedPosition {
        const change = this.changes[index];
        if (!change) return Object.freeze({ offset, deleted: false });
        if (offset < change.to) return Object.freeze({ offset: change.from + change.deltaBefore + (side === "after" ? change.insertedLength : 0), deleted: !change.unitDeletion && offset > change.from });
        return Object.freeze({ offset: offset + (change.deltaBefore + (change.insertedLength - (change.to - change.from))), deleted: false });
    }
    private preceding(offset: number, side: Affinity, start?: number): number {
        let low = start ?? 0, high = this.changes.length;
        // Gallop from a cursor's known prefix: nearby endpoints advance in constant time,
        // while a sparse jump (including the first lookup at EOF) stays logarithmic.
        if (start !== undefined) {
            let step = 1;
            while (low < high) {
                const from = this.changes[low]!.from;
                if (from > offset || from === offset && side === "before") { high = low; break; }
                const next = Math.min(high, low + step);
                low++;
                if (next === high) break;
                const end = this.changes[next]!.from;
                if (end > offset || end === offset && side === "before") { high = next; break; }
                low = next; step *= 2;
            }
        }
        const base = low;
        return base + partitionPoint(high - base, index => {
            const from = this.changes[base + index]!.from;
            return from < offset || from === offset && side === "after";
        }) - 1;
    }
    mapRange(range: AnchoredRange): AnchoredRange | undefined {
        validateRange(this.oldLength, range.from, range.to);
        const from = this.map(range.from, range.fromAffinity), to = this.map(range.to, range.toAffinity);
        if (range.onDelete === "invalidate") {
            const change = this.changes[this.preceding(range.from, "after")];
            const deleted = range.from === range.to ? from.deleted : change && change.to >= range.from && change.coveredTo >= range.to;
            if (deleted) return undefined;
        }
        return Object.freeze({ ...range, from: from.offset, to: Math.max(from.offset, to.offset) });
    }
    invert(): PositionMapping {
        let delta = 0;
        const changes = this.changes.map(change => {
            const from = change.from + delta;
            delta += change.insertedLength - (change.to - change.from);
            return { from, to: from + change.insertedLength, insertedLength: change.to - change.from,
                unitDeletion: change.inverseUnitDeletion === true, inverseUnitDeletion: change.unitDeletion === true };
        });
        return new ChangePositionMap(this.newLength, changes);
    }
    [compactUnitChanges](next: ChangePositionMap): ChangePositionMap | undefined {
        const inserted = this.joinUnitInsertions(next);
        if (inserted) return inserted;
        const unitDeletes = (map: ChangePositionMap) => map.changes.length > 0 && map.changes.every(change => change.insertedLength === 0 && (change.to - change.from === 1 || change.unitDeletion));
        if (unitDeletes(this) && unitDeletes(next)) {
            const reversed = (next.invert() as ChangePositionMap).joinUnitInsertions(this.invert() as ChangePositionMap);
            if (reversed) return reversed.invert() as ChangePositionMap;
        }
        return undefined;
    }
    private joinUnitInsertions(next: ChangePositionMap): ChangePositionMap | undefined {
        if (!this.changes.length || this.changes.length !== next.changes.length) return undefined;
        const changes: Change[] = [];
        for (let index = 0; index < this.changes.length; index++) {
            const a = this.changes[index]!, b = next.changes[index]!;
            if (a.from !== a.to || b.from !== b.to || !(a.insertedLength === 1 || a.inverseUnitDeletion) || !(b.insertedLength === 1 || b.inverseUnitDeletion)) return undefined;
            const start = a.from + a.deltaBefore;
            if (b.from < start || b.from > start + a.insertedLength) return undefined;
            // Every inserted unit has its own original boundary when undone. A net deletion
            // would incorrectly mark those boundaries deleted; retain that distinction explicitly.
            changes.push({ from: a.from, to: a.to, insertedLength: a.insertedLength + b.insertedLength, inverseUnitDeletion: true });
        }
        return new ChangePositionMap(this.oldLength, changes);
    }
    [compiledGeometry](): GeometryPair | undefined {
        if (!this.changes.length) return undefined; // Exact identity, without compiling input-context no-op maps.
        return this.#compiled ??= Object.freeze({ forward: this.geometry(), reverse: (this.invert() as ChangePositionMap).geometry() });
    }
    private geometry(): MappingGeometry {
        return batchGeometry(this, this.changes.flatMap(change => [change.from, change.from + 1, change.to, change.to + 1]),
            this.changes.filter(change => change.from < change.to));
    }
}

/** Stores results in each direction, including deletion history that net edits cannot express. */
class ComposedPositionMap implements PositionMapping {
    readonly oldLength: number;
    readonly newLength: number;
    readonly #geometry: GeometryPair;
    readonly #edges: UnchangedEdges;
    constructor(forward: MappingGeometry, reverse: MappingGeometry, edges: UnchangedEdges) {
        this.oldLength = forward.oldLength; this.newLength = forward.newLength;
        this.#geometry = Object.freeze({ forward, reverse }); this.#edges = Object.freeze(edges); Object.freeze(this);
    }
    [unchangedEdges](): UnchangedEdges { return this.#edges; }
    [compiledGeometry](): GeometryPair { return this.#geometry; }
    map(offset: number, side: Affinity = "after"): MappedPosition {
        position(this.oldLength, offset);
        const pieces = geometryPieces(this.#geometry.forward, side), piece = pieces[pieceAt(pieces, offset)]!;
        return Object.freeze({ offset: pieceOffset(piece, offset), deleted: piece.deleted });
    }
    mapRange(range: AnchoredRange): AnchoredRange | undefined {
        validateRange(this.oldLength, range.from, range.to);
        const from = this.map(range.from, range.fromAffinity), to = this.map(range.to, range.toAffinity);
        if (range.onDelete === "invalidate" && geometryInvalidates(this.#geometry.forward, range.from, range.to,
            range.fromAffinity ?? "after", range.toAffinity ?? "after", from.deleted)) return undefined;
        // before <= after at each boundary: only after/before ranges can cross, and a
        // collapsed one stays collapsed. Taking max therefore commutes with composition.
        return Object.freeze({ ...range, from: from.offset, to: Math.max(from.offset, to.offset) });
    }
    invert(): PositionMapping { return new ComposedPositionMap(this.#geometry.reverse, this.#geometry.forward, this.#edges); }
}

function knownMapping(map: PositionMapping): map is ChangePositionMap | ComposedPositionMap {
    return map instanceof ComposedPositionMap || map instanceof ChangePositionMap
        && map.map === ChangePositionMap.prototype.map && map.mapRange === ChangePositionMap.prototype.mapRange && map.invert === ChangePositionMap.prototype.invert;
}
/** Internal conservative proof from edit metadata, never inferred from equal endpoint offsets.
 * An opaque host map has no such proof. Inversion preserves equal edge lengths. */
export function unchangedPositionEdges(mapping: PositionMapping): UnchangedEdges | undefined {
    return knownMapping(mapping) ? mapping[unchangedEdges]() : undefined;
}
/** Internal batch metadata only. Consumers must still prove its relationship to their buffers. */
export function positionChanges(mapping: PositionMapping): readonly Readonly<{ from: number; to: number; insertedLength: number }>[] | undefined {
    return knownMapping(mapping) && mapping instanceof ChangePositionMap ? mapping[batchChanges]() : undefined;
}

/** Forwarding needs net text edits. Selections and history still use the full position map. */
export function forwardedChanges(mapping: PositionMapping) {
    return mapping instanceof ComposedPositionMap ? geometryChanges(mapping[compiledGeometry]().forward) : positionChanges(mapping)!;
}

/** Cost of retaining this map for another composition. Opaque maps have no known bound. */
export function positionMapSize(mapping: PositionMapping): number {
    if (mapping instanceof ComposedPositionMap) {
        const { forward, reverse } = mapping[compiledGeometry]();
        return Math.max(forward.points[0].length, forward.points[1].length, reverse.points[0].length, reverse.points[1].length);
    }
    return positionChanges(mapping)?.length ?? Infinity;
}

/** A known replacement between two immutable buffers needs only its lengths. */
export function replacementMap(oldLength: number, span: Pick<Change, "from" | "to" | "insertedLength">): PositionMapping {
    return new ChangePositionMap(oldLength, span.from === span.to && !span.insertedLength ? [] : [span]);
}

/** An immutable indexed map for one batch. Offsets are UTF-16; a replacement consumes its interior. */
export class PositionMap extends ChangePositionMap {
    constructor(oldLength: number, edits: readonly TextEdit[]) {
        super(oldLength, { edits });
    }
}

/** Known maps compile sequential semantics; opaque host mappings retain their own ordered pipeline. */
export function composePositionMaps(...input: readonly PositionMapping[]): PositionMapping {
    return composePositionMapList(input);
}
export function composePositionMapList(input: readonly PositionMapping[]): PositionMapping {
    if (!input.length) throw new Error("At least one position map is required.");
    const maps = Object.freeze([...input]);
    for (let index = 1; index < maps.length; index++) if (maps[index - 1]!.newLength !== maps[index]!.oldLength) throw new RangeError("Position map dimensions do not join.");
    if (maps.every(knownMapping)) {
        const join = (from: number, to: number): ChangePositionMap | ComposedPositionMap => {
            if (to - from === 1) return maps[from]!;
            const middle = from + Math.floor((to - from) / 2), a = join(from, middle), b = join(middle, to);
            if (a instanceof ChangePositionMap && b instanceof ChangePositionMap) { const compact = a[compactUnitChanges](b); if (compact) return compact; }
            const left = a[compiledGeometry]();
            if (!left) return b;
            const right = b[compiledGeometry](); if (!right) return a;
            const ae = a[unchangedEdges](), be = b[unchangedEdges]();
            return new ComposedPositionMap(composeGeometry(left.forward, right.forward), composeGeometry(right.reverse, left.reverse),
                { prefix: Math.min(ae.prefix, be.prefix), suffix: Math.min(ae.suffix, be.suffix) });
        };
        return join(0, maps.length);
    }
    return Object.freeze({ oldLength: maps[0]!.oldLength, newLength: maps.at(-1)!.newLength,
        map: (offset: number, side: Affinity = "after") => {
            let deleted = false;
            for (const map of maps) { const next = map.map(offset, side); offset = next.offset; deleted ||= next.deleted; }
            return Object.freeze({ offset, deleted });
        }, mapRange: (range: AnchoredRange) => {
            let current: AnchoredRange | undefined = range;
            for (const map of maps) { if (!current) break; current = map.mapRange(current); }
            return current;
        }, invert: () => composePositionMaps(...[...maps].reverse().map(map => map.invert())) });
}
