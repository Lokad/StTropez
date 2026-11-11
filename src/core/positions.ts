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

function position(length: number, offset: number): void {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > length) throw new RangeError("Position is outside the original document.");
}
function affinity(value: Affinity): void { if (value !== "before" && value !== "after") throw new TypeError("Unknown selection affinity."); }
export function anchoredRange(length: number, from: number, to: number, options: Readonly<{
    fromAffinity?: Affinity; toAffinity?: Affinity; onDelete?: "collapse" | "invalidate" }> = {}): AnchoredRange {
    position(length, from); position(length, to);
    if (to < from) throw new RangeError("Anchored ranges must be ordered.");
    const result = Object.freeze({ from, to, fromAffinity: options.fromAffinity ?? "after", toAffinity: options.toAffinity ?? "before", onDelete: options.onDelete ?? "collapse" });
    affinity(result.fromAffinity); affinity(result.toAffinity);
    if (result.onDelete !== "collapse" && result.onDelete !== "invalidate") throw new TypeError("Unknown anchor deletion policy.");
    return result;
}

/** An immutable map for one batch. Offsets are UTF-16; a replacement consumes its interior. */
export class PositionMap implements PositionMapping {
    readonly oldLength: number;
    readonly newLength: number;
    private readonly changes: readonly Change[];
    constructor(oldLength: number, edits: readonly TextEdit[]) {
        if (!Number.isSafeInteger(oldLength) || oldLength < 0) throw new RangeError("Invalid document length.");
        validateTextEdits(oldLength, edits);
        this.oldLength = oldLength;
        this.changes = Object.freeze(edits.filter(edit => edit.from !== edit.to || edit.insert.length !== 0)
            .map(edit => Object.freeze({ from: edit.from, to: edit.to, insertedLength: edit.insert.length })));
        this.newLength = oldLength + this.changes.reduce((delta, change) => delta + change.insertedLength - (change.to - change.from), 0);
        if (!Number.isSafeInteger(this.newLength)) throw new RangeError("Resulting length exceeds safe positions.");
        Object.freeze(this);
    }
    /** Exact change metadata, unlike endpoint probes which cannot exclude other edits. */
    isSingleInsertion(offset: number, units: number): boolean {
        const change = this.changes[0]; return this.changes.length === 1 && change!.from === offset && change!.to === offset && change!.insertedLength === units;
    }
    map(offset: number, side: Affinity = "after"): MappedPosition {
        position(this.oldLength, offset); affinity(side);
        let delta = 0;
        for (const change of this.changes) {
            if (offset < change.from) break;
            if (offset === change.from) {
                if (side === "before") return Object.freeze({ offset: offset + delta, deleted: false });
                if (change.from === change.to) { delta += change.insertedLength; continue; }
                return Object.freeze({ offset: change.from + delta + change.insertedLength, deleted: false });
            }
            if (offset < change.to) return Object.freeze({ offset: change.from + delta + (side === "after" ? change.insertedLength : 0), deleted: true });
            delta += change.insertedLength - (change.to - change.from);
        }
        return Object.freeze({ offset: offset + delta, deleted: false });
    }
    mapRange(range: AnchoredRange): AnchoredRange | undefined {
        anchoredRange(this.oldLength, range.from, range.to, range);
        const from = this.map(range.from, range.fromAffinity), to = this.map(range.to, range.toAffinity);
        let covered = range.from;
        for (const change of this.changes) {
            if (change.from > covered) break;
            if (change.to > covered) covered = change.to;
        }
        const deleted = range.from === range.to ? from.deleted : covered >= range.to;
        if (range.onDelete === "invalidate" && deleted) return undefined;
        return Object.freeze({ ...range, from: from.offset, to: Math.max(from.offset, to.offset) });
    }
    invert(): PositionMapping {
        let delta = 0;
        const changes = this.changes.map(change => {
            const from = change.from + delta;
            delta += change.insertedLength - (change.to - change.from);
            return Object.freeze({ from, to: from + change.insertedLength, insertedLength: change.to - change.from });
        });
        return mappingFromChanges(this.newLength, this.oldLength, changes);
    }
}

/** Inversion needs lengths only, without allocating placeholder strings for removed text. */
function mappingFromChanges(oldLength: number, newLength: number, changes: readonly Change[]): PositionMapping {
    const forward = Object.create(PositionMap.prototype) as PositionMap;
    Object.defineProperties(forward, { oldLength: { value: oldLength }, newLength: { value: newLength },
        changes: { value: Object.freeze(changes) } });
    return Object.freeze(forward);
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
