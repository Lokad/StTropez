import { invalidRange, isIndex, isNonNegativeInteger, isOffset } from "./bounds.ts";
import type { TextEdit } from "./changes.ts";
import type { Affinity, PositionMapping } from "./positions.ts";
import { unchangedPositionEdges } from "./positions.ts";
import type { TextBuffer } from "./text-buffer.ts";
import type { TextStep } from "./text-transaction.ts";
import { splitsTextPair, splitsTextPairAt } from "./utf16.ts";

export type Selection = Readonly<{ anchor: number; head: number; anchorAffinity?: Affinity; headAffinity?: Affinity }>;
export type SelectionSet = Readonly<{ ranges: readonly Selection[]; primary: number }>;
export type SelectionEditPlan = Readonly<{ edits: readonly TextEdit[]; selectionSet: SelectionSet }>;
// Only our deeply frozen output arrays qualify; caller-owned/frozen lookalikes are validated.
const normalizedSets = new WeakMap<readonly Selection[], SelectionSet>();

function checkEndpoints(length: number, anchor: number, head: number) {
    if (!isOffset(anchor, length) || !isOffset(head, length)) throw new RangeError("Selection is outside the document.");
}

function normalizeSelection(length: number, { anchor, head, anchorAffinity, headAffinity }: Selection): Readonly<Required<Selection>> {
    checkEndpoints(length, anchor, head);
    anchorAffinity ??= anchor <= head ? "after" : "before";
    headAffinity ??= anchor === head ? anchorAffinity : anchor < head ? "before" : "after";
    return Object.freeze({ anchor, head, anchorAffinity, headAffinity });
}

function knownSelectionSet(length: number, ranges: readonly Selection[], primary: number) {
    if (!isNonNegativeInteger(length)) invalidRange("document length");
    if (!ranges.length || !isIndex(primary, ranges.length)) throw new RangeError("A selection set needs ranges and a valid primary index.");
    const known = normalizedSets.get(ranges);
    if (known?.primary === primary) {
        const last = ranges.at(-1)!;
        if (Math.max(last.anchor, last.head) > length) throw new RangeError("Selection is outside the document.");
        return known;
    }
}

function overlaps(previousFrom: number, previousTo: number, from: number, to: number) {
    return from < previousTo || from === previousTo && (from === to || previousFrom === previousTo);
}

/** Sort and merge overlaps/occupied carets. Adjacent nonempty ranges remain independent. */
export function createSelectionSet(length: number, ranges: readonly Selection[], primary = 0): SelectionSet {
    const known = knownSelectionSet(length, ranges, primary);
    if (known) return known;
    const sorted = ranges.map((range, index) => { const value = normalizeSelection(length, range);
        return { value, index, from: Math.min(value.anchor, value.head), to: Math.max(value.anchor, value.head) }; });
    const compare = (a: typeof sorted[number], b: typeof sorted[number]) => a.from - b.from || a.to - b.to || a.index - b.index;
    if (sorted.some((item, index) => index > 0 && compare(sorted[index - 1]!, item) > 0)) sorted.sort(compare);
    type Item = typeof sorted[number];
    const groups: { from: number; to: number; owner: Item; primary: boolean }[] = [];
    for (const item of sorted) {
        const previous = groups.at(-1);
        if (previous && overlaps(previous.from, previous.to, item.from, item.to)) {
            previous.to = Math.max(previous.to, item.to);
            if (item.index === primary || !previous.primary && item.index < previous.owner.index) previous.owner = item;
            previous.primary ||= item.index === primary;
        } else groups.push({ from: item.from, to: item.to, owner: item, primary: item.index === primary });
    }
    const normalized = groups.map(({ from, to, owner }) => {
        const value = owner.value;
        if (from === owner.from && to === owner.to) return value;
        return normalizeSelection(length, { anchor: value.anchor <= value.head ? from : to, head: value.anchor <= value.head ? to : from,
            anchorAffinity: value.anchorAffinity, headAffinity: value.headAffinity });
    });
    const result = Object.freeze({ ranges: Object.freeze(normalized), primary: groups.findIndex(group => group.primary) });
    normalizedSets.set(result.ranges, result); return result;
}

export function sameSelectionSet(a: SelectionSet, b: SelectionSet): boolean {
    return a === b || a.primary === b.primary && a.ranges.length === b.ranges.length && a.ranges.every((range, index) => {
        const other = b.ranges[index]!;
        return range.anchor === other.anchor && range.head === other.head && range.anchorAffinity === other.anchorAffinity && range.headAffinity === other.headAffinity;
    });
}

/** Map each range using its endpoint affinities, then merge overlapping ranges. */
export function mapSelectionSet(mapping: PositionMapping, value: SelectionSet): SelectionSet {
    const before = createSelectionSet(mapping.oldLength, value.ranges, value.primary);
    const after = mapSelectionRanges(mapping, before);
    return sameSelectionSet(before, after) ? before : after;
}

/** @internal Map validated ranges; language commands override mapping sides, retaining stored affinities. */
export function mapSelectionRanges(mapping: PositionMapping, value: SelectionSet, side?: Affinity): SelectionSet {
    const map = mapping.createMapper?.() ?? ((offset, affinity) => mapping.map(offset, affinity));
    return mapEndpoints(mapping.newLength, value, (offset, affinity) => map(offset, side ?? affinity).offset);
}

function mapEndpoints(length: number, value: SelectionSet, map: (offset: number, affinity?: Affinity) => number): SelectionSet {
    return createSelectionSet(length, value.ranges.map(range => {
        // Reverse selections still feed the cursor ordered original endpoints.
        const forward = range.anchor <= range.head;
        const first = map(forward ? range.anchor : range.head, forward ? range.anchorAffinity : range.headAffinity);
        const second = map(forward ? range.head : range.anchor, forward ? range.headAffinity : range.anchorAffinity);
        return { ...range, anchor: forward ? first : second, head: forward ? second : first };
    }), value.primary);
}

/** Selections and viewport anchors follow the same text across a document change. */
export type DocumentViewMapping = Readonly<{
    mapViewOffset(offset: number, affinity: Affinity): number;
    mapSelections(set: SelectionSet): SelectionSet;
}>;
export function documentViewMapping(mapping: PositionMapping, after?: TextBuffer,
    parts?: readonly TextStep[], undo = false): DocumentViewMapping {
    if (!after) return {
        mapSelections: (set: SelectionSet) => mapSelectionSet(mapping, set),
        mapViewOffset: (offset: number, affinity: Affinity) => mapping.map(offset, affinity).offset,
    };
    if (parts) {
        const steps = parts.map(part => documentViewMapping(undo ? part.mapping.invert() : part.mapping,
            part.wholeText ? (undo ? part.before : part.after) : undefined, part.parts, undo));
        if (undo) steps.reverse();
        return {
            mapViewOffset: (offset, affinity) => steps.reduce((at, step) => step.mapViewOffset(at, affinity), offset),
            mapSelections: set => steps.reduce((current, step) => step.mapSelections(current), set),
        };
    }
    const { prefix, suffix } = unchangedPositionEdges(mapping)!;
    const oldEnd = mapping.oldLength - suffix, newEnd = after.length - suffix;
    const map = (offset: number, affinity?: Affinity) => {
        if (offset === 0) return 0;
        if (offset === mapping.oldLength) return after.length;
        if (offset < prefix) return offset;
        if (offset > oldEnd) return newEnd + (offset - oldEnd);
        const next = oldEnd === prefix ? mapping.map(offset, affinity).offset : offset === oldEnd ? newEnd : Math.min(offset, newEnd);
        return splitsTextPair(after, next) ? next - 1 : next;
    };
    return {
        mapSelections: (set: SelectionSet) => mapEndpoints(after.length, createSelectionSet(mapping.oldLength, set.ranges, set.primary), map),
        mapViewOffset(offset: number, affinity: Affinity) {
            checkEndpoints(mapping.oldLength, offset, offset);
            return map(offset, affinity);
        },
    };
}

/** Preserve each endpoint's relative offset inside a replacement, including backwards selections. */
export function mapReplacementSelections(length: number, selections: SelectionSet, edits: readonly TextEdit[]): SelectionSet {
    let next = 0;
    let delta = 0;
    const map = (offset: number) => {
        for (; next < edits.length; next++) {
            const edit = edits[next]!;
            if (offset < edit.from) break;
            if (offset < edit.to) {
                let relative = Math.min(offset - edit.from, edit.insert.length);
                if (splitsTextPairAt(edit.insert, relative)) relative--;
                return edit.from + delta + relative;
            }
            delta += edit.insert.length - (edit.to - edit.from);
        }
        return offset + delta;
    };
    const newLength = length + edits.reduce((n, edit) => n + edit.insert.length - (edit.to - edit.from), 0);
    return mapEndpoints(newLength, selections, map);
}

/** Capture caller-owned ranges before planning edits in their supplied order. */
export function orderedSelections(length: number, { ranges, primary }: SelectionSet): SelectionSet {
    const known = knownSelectionSet(length, ranges, primary);
    if (known) return known;
    let previousFrom = -1;
    let previousTo = -1;
    const captured = Array.from(ranges, ({ anchor, head, anchorAffinity, headAffinity }) => {
        checkEndpoints(length, anchor, head);
        const from = Math.min(anchor, head);
        const to = Math.max(anchor, head);
        if (overlaps(previousFrom, previousTo, from, to)) {
            throw new RangeError("Selection edits require normalized range order.");
        }
        previousFrom = from;
        previousTo = to;
        return Object.freeze({ anchor, head, ...(anchorAffinity !== undefined && { anchorAffinity }),
            ...(headAffinity !== undefined && { headAffinity }) });
    });
    return Object.freeze({ ranges: Object.freeze(captured), primary });
}

/** Plan one original-coordinate replacement per normalized range; text may differ per range. */
export function planSelectionEdits(length: number, selections: SelectionSet, replacement: string | readonly string[]): SelectionEditPlan {
    const value = orderedSelections(length, selections);
    if (typeof replacement !== "string" && replacement.length !== value.ranges.length) throw new TypeError("Expected replacement text for every selection.");
    let delta = 0;
    const carets: Selection[] = [], edits = value.ranges.map((range, index) => {
        const from = Math.min(range.anchor, range.head), to = Math.max(range.anchor, range.head), insert = typeof replacement === "string" ? replacement : replacement[index]!;
        const head = from + delta + insert.length; delta += insert.length - (to - from);
        carets.push({ anchor: head, head }); return Object.freeze({ from, to, insert });
    });
    return Object.freeze({ edits: Object.freeze(edits), selectionSet: createSelectionSet(length + delta, carets, value.primary) });
}
