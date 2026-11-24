import type { TextEdit } from "./changes.ts";
import type { Affinity, PositionMapping } from "./positions.ts";
import { unchangedPositionEdges } from "./positions.ts";
import type { TextBuffer } from "./text-buffer.ts";
import { splitsTextPair } from "./utf16.ts";

export type Selection = Readonly<{ anchor: number; head: number; anchorAffinity?: Affinity; headAffinity?: Affinity }>;
export type SelectionSet = Readonly<{ ranges: readonly Selection[]; primary: number }>;
export type SelectionEditPlan = Readonly<{ edits: readonly TextEdit[]; selectionSet: SelectionSet }>;
// Only our deeply frozen output arrays qualify; caller-owned/frozen lookalikes are validated.
const normalizedSets = new WeakMap<readonly Selection[], SelectionSet>();

function normalizeSelection(length: number, value: Selection): Readonly<Required<Selection>> {
    if (![value.anchor, value.head].every(offset => Number.isSafeInteger(offset) && offset >= 0 && offset <= length)) throw new RangeError("Selection is outside the document.");
    const anchorAffinity = value.anchorAffinity ?? (value.anchor <= value.head ? "after" : "before");
    const headAffinity = value.headAffinity ?? (value.anchor === value.head ? anchorAffinity : value.anchor < value.head ? "before" : "after");

    return Object.freeze({ anchor: value.anchor, head: value.head, anchorAffinity, headAffinity });
}

/** Sort and merge overlaps/occupied carets. Adjacent nonempty ranges remain independent. */
export function createSelectionSet(length: number, ranges: readonly Selection[], primary = 0): SelectionSet {
    if (!Number.isSafeInteger(length) || length < 0) throw new RangeError("Invalid document length.");
    if (!ranges.length || !Number.isSafeInteger(primary) || primary < 0 || primary >= ranges.length) throw new RangeError("A selection set needs ranges and a valid primary index.");
    const known = normalizedSets.get(ranges);
    if (known?.primary === primary) {
        const last = ranges.at(-1)!;
        if (Math.max(last.anchor, last.head) > length) throw new RangeError("Selection is outside the document.");
        return known;
    }
    const sorted = ranges.map((range, index) => { const value = normalizeSelection(length, range);
        return { value, index, from: Math.min(value.anchor, value.head), to: Math.max(value.anchor, value.head) }; });
    const compare = (a: typeof sorted[number], b: typeof sorted[number]) => a.from - b.from || a.to - b.to || a.index - b.index;
    if (sorted.some((item, index) => index > 0 && compare(sorted[index - 1]!, item) > 0)) sorted.sort(compare);
    type Item = typeof sorted[number];
    const groups: { from: number; to: number; owner: Item; primary: boolean }[] = [];
    for (const item of sorted) {
        const previous = groups.at(-1);
        if (previous && (item.from < previous.to || item.from === previous.to && (item.from === item.to || previous.from === previous.to))) {
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

/** Map every range with its own affinities, then coalesce ranges that now overlap. */
export function mapSelectionSet(mapping: PositionMapping, value: SelectionSet): SelectionSet {
    const before = createSelectionSet(mapping.oldLength, value.ranges, value.primary);
    const after = mapSelectionRanges(mapping, before);
    return sameSelectionSet(value, after) ? value : after;
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

/** The whole-text APIs supply a single compact replacement. Retain each pane's place within it. */
export function mapWholeTextSelections(mapping: PositionMapping, after: TextBuffer, selections: SelectionSet): SelectionSet {
    const { prefix, suffix } = unchangedPositionEdges(mapping)!;
    const oldEnd = mapping.oldLength - suffix, newEnd = after.length - suffix;
    return mapEndpoints(after.length, selections, (offset, affinity) => {
        if (offset === 0) return 0;
        if (offset === mapping.oldLength) return after.length;
        if (offset < prefix) return offset;
        if (offset > oldEnd) return newEnd + (offset - oldEnd);
        const next = oldEnd === prefix ? mapping.map(offset, affinity).offset : offset === oldEnd ? newEnd : Math.min(offset, newEnd);
        return splitsTextPair(after, next) ? next - 1 : next;
    });
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
                if (relative > 0 && relative < edit.insert.length && /[\ud800-\udbff]/.test(edit.insert[relative - 1]!) && /[\udc00-\udfff]/.test(edit.insert[relative]!)) relative--;
                return edit.from + delta + relative;
            }
            delta += edit.insert.length - (edit.to - edit.from);
        }
        return offset + delta;
    };
    const newLength = length + edits.reduce((n, edit) => n + edit.insert.length - (edit.to - edit.from), 0);
    return mapEndpoints(newLength, selections, map);
}

/** Plan one original-coordinate replacement per normalized range; text may differ per range. */
export function planSelectionEdits(length: number, selections: SelectionSet, replacement: string | readonly string[]): SelectionEditPlan {
    const value = createSelectionSet(length, selections.ranges, selections.primary);
    if (value.primary !== selections.primary || value.ranges.length !== selections.ranges.length
        || value.ranges.some((range, index) => range.anchor !== selections.ranges[index]!.anchor || range.head !== selections.ranges[index]!.head)) throw new RangeError("Selection edits require normalized range order.");
    if (typeof replacement !== "string" && replacement.length !== value.ranges.length) throw new TypeError("Expected replacement text for every selection.");
    let delta = 0;
    const carets: Selection[] = [], edits = value.ranges.map((range, index) => {
        const from = Math.min(range.anchor, range.head), to = Math.max(range.anchor, range.head), insert = typeof replacement === "string" ? replacement : replacement[index]!;
        const head = from + delta + insert.length; delta += insert.length - (to - from);
        carets.push({ anchor: head, head }); return Object.freeze({ from, to, insert });
    });
    return Object.freeze({ edits: Object.freeze(edits), selectionSet: createSelectionSet(length + delta, carets, value.primary) });
}
