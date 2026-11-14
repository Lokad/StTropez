import { validateTextEdits } from "./changes.ts";
import type { TextEdit } from "./changes.ts";

export type Affinity = "before" | "after";
export type MappedPosition = Readonly<{ offset: number; deleted: boolean }>;
export type AnchoredRange = Readonly<{ from: number; to: number; fromAffinity: Affinity; toAffinity: Affinity;
    onDelete: "collapse" | "invalidate" }>;
export type PositionMapping = Readonly<{ oldLength: number; newLength: number;
    map: (offset: number, affinity?: Affinity) => MappedPosition;
    mapRange: (range: AnchoredRange) => AnchoredRange | undefined;
    invert: () => PositionMapping;
    isSingleInsertion?: (offset: number, units: number) => boolean }>;
type Change = Readonly<{ from: number; to: number; insertedLength: number }>;
type IndexedChange = Change & Readonly<{ deltaBefore: number; coveredTo: number }>;

function position(length: number, offset: number): void {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > length) throw new RangeError("Position is outside the original document.");
}
function affinity(value: Affinity): void { if (value !== "before" && value !== "after") throw new TypeError("Unknown selection affinity."); }
function validateRange(length: number, from: number, to: number, fromAffinity: Affinity, toAffinity: Affinity, onDelete: AnchoredRange["onDelete"]): void {
    position(length, from); position(length, to);
    if (to < from) throw new RangeError("Anchored ranges must be ordered.");
    affinity(fromAffinity); affinity(toAffinity);
    if (onDelete !== "collapse" && onDelete !== "invalidate") throw new TypeError("Unknown anchor deletion policy.");
}
export function anchoredRange(length: number, from: number, to: number, options: Readonly<{
    fromAffinity?: Affinity; toAffinity?: Affinity; onDelete?: "collapse" | "invalidate" }> = {}): AnchoredRange {
    const fromAffinity = options.fromAffinity ?? "after", toAffinity = options.toAffinity ?? "before", onDelete = options.onDelete ?? "collapse";
    validateRange(length, from, to, fromAffinity, toAffinity, onDelete);
    return Object.freeze({ from, to, fromAffinity, toAffinity, onDelete });
}

/** Length-only construction is shared by forward and inverse maps. */
class ChangePositionMap implements PositionMapping {
    readonly oldLength: number;
    readonly newLength: number;
    private readonly changes: readonly IndexedChange[];
    constructor(oldLength: number, changes: readonly Change[]) {
        this.oldLength = oldLength;
        let delta = 0;
        const indexed = changes.map(change => {
            const result = { ...change, deltaBefore: delta, coveredTo: change.to };
            delta += change.insertedLength - (change.to - change.from); return result;
        });
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
    /** Exact change metadata, unlike endpoint probes which cannot exclude other edits. */
    isSingleInsertion(offset: number, units: number): boolean {
        const change = this.changes[0]; return this.changes.length === 1 && change!.from === offset && change!.to === offset && change!.insertedLength === units;
    }
    map(offset: number, side: Affinity = "after"): MappedPosition {
        position(this.oldLength, offset); affinity(side);
        const change = this.changes[this.preceding(offset, side)];
        if (!change) return Object.freeze({ offset, deleted: false });
        if (offset < change.to) return Object.freeze({ offset: change.from + change.deltaBefore + (side === "after" ? change.insertedLength : 0), deleted: offset > change.from });
        return Object.freeze({ offset: offset + (change.deltaBefore + (change.insertedLength - (change.to - change.from))), deleted: false });
    }
    private preceding(offset: number, side: Affinity): number {
        let low = 0, high = this.changes.length;
        while (low < high) {
            const middle = low + Math.floor((high - low) / 2), from = this.changes[middle]!.from;
            if (from < offset || from === offset && side === "after") low = middle + 1;
            else high = middle;
        }
        return low - 1;
    }
    mapRange(range: AnchoredRange): AnchoredRange | undefined {
        validateRange(this.oldLength, range.from, range.to, range.fromAffinity ?? "after", range.toAffinity ?? "before", range.onDelete ?? "collapse");
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
            return Object.freeze({ from, to: from + change.insertedLength, insertedLength: change.to - change.from });
        });
        return new ChangePositionMap(this.newLength, changes);
    }
}

/** An immutable indexed map for one batch. Offsets are UTF-16; a replacement consumes its interior. */
export class PositionMap extends ChangePositionMap {
    constructor(oldLength: number, edits: readonly TextEdit[]) {
        if (!Number.isSafeInteger(oldLength) || oldLength < 0) throw new RangeError("Invalid document length.");
        validateTextEdits(oldLength, edits);
        super(oldLength, edits.filter(edit => edit.from !== edit.to || edit.insert.length !== 0)
            .map(edit => ({ from: edit.from, to: edit.to, insertedLength: edit.insert.length })));
    }
}

/** Composition preserves sequential affinity/deletion semantics instead of flattening change records. */
export function composePositionMaps(...input: readonly PositionMapping[]): PositionMapping {
    if (!input.length) throw new Error("At least one position map is required.");
    const maps = Object.freeze([...input]);
    for (let index = 1; index < maps.length; index++) if (maps[index - 1]!.newLength !== maps[index]!.oldLength) throw new RangeError("Position map dimensions do not join.");
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
