import { invalidRange, isIndex, isOffsetRange, isPositiveInteger } from "./bounds.ts";
import type { TextBuffer } from "./text-buffer.ts";
import { unchangedPositionEdges } from "./positions.ts";
import type { PositionMapping } from "./positions.ts";
import type { SelectionSet } from "./selections.ts";
import type { Observable } from "./observable.ts";
import { partitionPoint } from "./bound-search.ts";
import { appendNestedFold } from "./fold-nesting.ts";
import { emptyList } from "./empty-list.ts";
import { lineBoundary, lineContentEnd } from "./newlines.ts";
import { lineSwaps, type LineSwap } from "./line-moves.ts";
import type { TextStep } from "./text-transaction.ts";

/** Host-owned raw anchors include a visible header and at least one complete body row. */
export type FoldRange = Readonly<{ id: string; from: number; to: number; collapsed?: boolean; group?: string }>;
export type FoldRegion = Readonly<{ id: string; from: number; to: number; lineFrom: number; lineTo: number; collapsed: boolean; group?: string }>;
export type FoldVersion = Readonly<{ revision: number; generation: number }>;
export type FoldingSnapshot = FoldVersion & Readonly<{ regions: readonly FoldRegion[]; index: FoldIndex }>;
export type DocumentFolding = Observable<FoldingSnapshot> & Readonly<{
    setRanges: (expected: FoldVersion, ranges: readonly FoldRange[]) => boolean;
    setCollapsed: (expected: FoldVersion, ids: string | readonly string[], collapsed: boolean, options?: Readonly<{ moveHiddenCarets?: boolean }>) => boolean;
    reveal: (expected: FoldVersion, from: number, to?: number) => boolean;
    revealSelection: (expected: FoldVersion) => boolean;
}>;
type RegionMetadata = Readonly<{ maxTo: number; maxLineTo: number; collapsed: number }>;
const owned = new WeakMap<readonly FoldRegion[], RegionMetadata>();
const resolved = new WeakMap<TextBuffer, WeakMap<readonly FoldRange[], readonly FoldRegion[]>>();
/** Only validated module-owned regions enter this cache; frozen public input is not a proof. */
function retain(regions: readonly FoldRegion[]): readonly FoldRegion[] {
    if (owned.has(regions)) return regions;
    let maxTo = 0, maxLineTo = 0, collapsed = 0;
    for (const r of regions) { maxTo = Math.max(maxTo, r.to); maxLineTo = Math.max(maxLineTo, r.lineTo); if (r.collapsed) collapsed++; }
    owned.set(regions, { maxTo, maxLineTo, collapsed }); return Object.freeze(regions);
}
const empty: readonly FoldRegion[] = emptyList;
/** Internal handoff from reconciliation: raw ranges remain public, trusted rows stay private. */
export function prepareFoldRanges(buffer: TextBuffer, ranges: readonly FoldRange[], regions: readonly FoldRegion[]): void {
    let entries = resolved.get(buffer); if (!entries) { entries = new WeakMap(); resolved.set(buffer, entries); }
    entries.set(ranges, retain(regions));
}

function region(buffer: TextBuffer, id: string, from: number, to: number, collapsed: boolean, group?: string): FoldRegion | undefined {
    if (!isOffsetRange(from, to, buffer.length) || from === to) return;
    const lineFrom = buffer.lineAt(from), lineTo = buffer.lineAt(to - 1) + 1;
    return lineFrom + 1 < lineTo ? Object.freeze({ id, from, to, lineFrom, lineTo, collapsed, ...(group === undefined ? {} : { group }) }) : undefined;
}
export function sameFoldRegions(a: readonly FoldRegion[], b: readonly FoldRegion[]): boolean {
    return a === b || a.length === b.length && a.every((r, i) => { const s = b[i]!; return r.id === s.id && r.from === s.from && r.to === s.to && r.collapsed === s.collapsed && r.lineFrom === s.lineFrom && r.lineTo === s.lineTo && r.group === s.group; });
}
function shiftRegion(r: FoldRegion, units: number, lines: number): FoldRegion {
    return Object.freeze({ ...r, from: r.from + units, to: r.to + units,
        lineFrom: r.lineFrom + lines, lineTo: r.lineTo + lines });
}
function compareRegions(a: FoldRegion, b: FoldRegion): number {
    return a.lineFrom - b.lineFrom || b.lineTo - a.lineTo;
}
export function createFoldRegions(buffer: TextBuffer, ranges: readonly FoldRange[], previous: readonly FoldRegion[] = empty): readonly FoldRegion[] {
    const prepared = resolved.get(buffer)?.get(ranges);
    if (prepared === ranges) return owned.has(previous) && sameFoldRegions(previous, prepared) ? previous : prepared;
    const prior = new Map(previous.map(r => [r.id, r])), ids = new Set<string>();
    let unchanged = true;
    const regions = ranges.map((r, i) => {
        const collapsed = r.collapsed ?? prior.get(r.id)?.collapsed ?? false;
        const known = prepared?.[i];
        if (known) {
            if (known.collapsed === collapsed) return known;
            unchanged = false;
            return Object.freeze({ ...known, collapsed });
        }
        if (!r.id.length || r.id.length > 256 || ids.has(r.id)) throw new TypeError("Expected unique fold identities.");
        if (r.group !== undefined && !r.group) throw new TypeError("Expected a nonempty fold group.");
        ids.add(r.id); const value = region(buffer, r.id, r.from, r.to, collapsed, r.group);
        if (!value) throw new RangeError("A fold needs a header and at least one body row."); return value;
    });
    if (!prepared) {
        regions.sort(compareRegions);
        const stack: FoldRegion[] = [];
        for (let i = 0; i < regions.length; i++) {
            const r = regions[i]!;
            if (i && regions[i - 1]!.lineFrom === r.lineFrom) throw new RangeError("A fold header has one identity.");
            if (!appendNestedFold(stack, r)) throw new RangeError("Fold regions must nest or remain disjoint.");
        }
    }
    const next = prepared && unchanged ? prepared : regions;
    const result = owned.has(previous) && sameFoldRegions(previous, next) ? previous : next.length ? retain(next) : empty;
    prepareFoldRanges(buffer, result, result); return result;
}
const movedCollapsed = new WeakMap<TextBuffer, WeakSet<FoldRegion>>();

export function movedCollapsedRegions(buffer: TextBuffer, regions: readonly FoldRegion[]): FoldRegion[] {
    const moved = movedCollapsed.get(buffer);
    const outer: FoldRegion[] = [];
    if (!moved) return outer;
    for (const region of regions) {
        if (moved.has(region) && region.lineFrom >= (outer.at(-1)?.lineTo ?? 0)) outer.push(region);
    }
    return outer;
}

function movedFold(buffer: TextBuffer, previous: TextBuffer, r: FoldRegion, swaps: readonly LineSwap[]): FoldRegion | null | undefined {
    const at = partitionPoint(swaps.length, i => swaps[i]!.first <= r.lineFrom);
    const swap = swaps[at - 1];
    if (!swap || r.lineFrom >= swap.end) return;
    // Its header moved independently of some of its body. Discovery can rebuild this fold.
    if (r.lineTo > swap.end || r.lineFrom < swap.middle && r.lineTo > swap.middle) return null;
    const shift = r.lineFrom < swap.middle ? swap.end - swap.middle : swap.first - swap.middle;
    // Internal separators travel with the block. Its last row can acquire a different terminator.
    const delta = buffer.offsetAt(r.lineFrom + shift) - previous.offsetAt(r.lineFrom);
    const end = lineBoundary(buffer, r.lineTo + shift);
    const to = r.to === lineBoundary(previous, r.lineTo) ? end : Math.min(end, r.to + delta);
    // An empty last source row at EOF has no character that can anchor a fold body.
    const next = region(buffer, r.id, r.from + delta, to, r.collapsed, r.group);
    if (next?.collapsed) {
        let moved = movedCollapsed.get(buffer);
        if (!moved) {
            moved = new WeakSet();
            movedCollapsed.set(buffer, moved);
        }
        moved.add(next);
    }
    return next ?? null;
}

/** View metadata follows document mappings. Degenerate/merged headers cease to be folds. */
export function mapFoldRegions(buffer: TextBuffer, mapping: PositionMapping, regions: readonly FoldRegion[], previous: TextBuffer, swaps?: readonly LineSwap[]): readonly FoldRegion[] {
    if (!regions.length) return regions;
    const metadata = owned.get(regions), edges = metadata ? unchangedPositionEdges(mapping) : undefined;
    if (edges && metadata!.maxTo <= edges.prefix && (!swaps || metadata!.maxLineTo <= swaps[0]!.first)) return regions;
    const suffix = edges ? mapping.oldLength - edges.suffix : Infinity;
    const units = mapping.newLength - mapping.oldLength, lines = buffer.lineCount - previous.lineCount;
    const mapped: FoldRegion[] = [], headers = new Map<number, number>(), stack: FoldRegion[] = [];
    const reordered: FoldRegion[] | undefined = swaps ? [] : undefined;
    const append = (next: FoldRegion) => {
        const existing = headers.get(next.lineFrom);
        if (existing !== undefined) { mapped[existing] = Object.freeze({ ...mapped[existing]!, collapsed: false }); return; }
        if (!appendNestedFold(stack, next)) {
            // Removing a boundary newline can merge formerly disjoint headers.
            const parent = headers.get(stack.at(-1)!.lineFrom)!;
            mapped[parent] = Object.freeze({ ...mapped[parent]!, collapsed: false }); return;
        }
        headers.set(next.lineFrom, mapped.length); mapped.push(next);
    };
    for (const r of regions) {
        const moved = swaps && movedFold(buffer, previous, r, swaps);
        if (moved !== undefined) { if (moved) reordered!.push(moved); continue; }
        let next: FoldRegion | undefined;
        if (edges && r.to <= edges.prefix) next = r;
        else if (edges && r.from >= suffix) next = units === 0 && lines === 0 ? r : shiftRegion(r, units, lines);
        else {
            const from = mapping.map(r.from, "after"), to = mapping.map(r.to, "before");
            if (from.offset < to.offset) {
                const lineFrom = edges && r.from < edges.prefix ? r.lineFrom : edges && r.from >= suffix ? r.lineFrom + lines : buffer.lineAt(from.offset);
                const lineTo = edges && r.to <= edges.prefix ? r.lineTo : edges && r.to > suffix ? r.lineTo + lines : buffer.lineAt(to.offset - 1) + 1;
                if (lineFrom + 1 < lineTo) {
                    let keepEnd = !to.deleted;
                    if (!keepEnd && r.lineTo < previous.lineCount && r.to === previous.offsetAt(r.lineTo)) {
                        // Removing the following row at EOF can take the terminator after an intact folded body.
                        const contentEnd = mapping.map(lineContentEnd(previous, r.lineTo - 1), "before");
                        keepEnd = !contentEnd.deleted && contentEnd.offset === to.offset;
                    }
                    next = Object.freeze({ ...r, from: from.offset, to: to.offset, lineFrom, lineTo, collapsed: r.collapsed && !from.deleted && keepEnd });
                }
            }
        }
        if (!next) continue;
        if (reordered) reordered.push(next); else append(next);
    }
    if (reordered) for (const next of reordered.sort(compareRegions)) append(next);
    return sameFoldRegions(regions, mapped) ? regions : mapped.length ? retain(mapped) : empty;
}
/** Internal state-only change; geometry was validated when the regions were installed. */
export function collapseFoldRegions(regions: readonly FoldRegion[], ids: string | readonly string[], collapsed: boolean): readonly FoldRegion[] | undefined {
    if ((typeof ids !== "string" && !Array.isArray(ids)) || typeof collapsed !== "boolean") return;
    const remaining = new Set(typeof ids === "string" ? [ids] : ids);
    if (!remaining.size) return;
    let changed = false;
    const next = regions.map(region => {
        if (!remaining.delete(region.id) || region.collapsed === collapsed) return region;
        changed = true;
        return Object.freeze({ ...region, collapsed });
    });
    if (!remaining.size) return changed ? retain(next) : regions;
}
export function revealSelectionFolds(buffer: TextBuffer, regions: readonly FoldRegion[], selections: SelectionSet,
    previous?: FoldIndex): readonly FoldRegion[] {
    if (!(owned.get(regions)?.collapsed ?? regions.some(r => r.collapsed))) return regions;
    return revealEndpoints(regions, selectionEndpoints(buffer, selections, undefined, previous));
}
function selectionEndpoints(buffer: TextBuffer, selections: SelectionSet, index?: FoldIndex, previous?: FoldIndex) {
    const endpoints = new Set<number>();
    for (const range of selections.ranges) {
        const from = Math.min(range.anchor, range.head), to = Math.max(range.anchor, range.head);
        const first = buffer.lineAt(from), last = buffer.lineAt(to);
        if ((!index || index.hiddenBy(first)) && !previous?.hiddenBy(first)) endpoints.add(first);
        // A whole-line selection through EOF includes the final folded row in full.
        if (last !== first && (to !== buffer.length || from !== buffer.offsetAt(first))
            && (!index || index.hiddenBy(last)) && !previous?.hiddenBy(last)) endpoints.add(last);
    }
    return endpoints;
}
function revealEndpoints(regions: readonly FoldRegion[], endpoints: Set<number>): readonly FoldRegion[] {
    if (!endpoints.size) return regions;
    const lines = [...endpoints].sort((a, b) => a - b); let changed = false;
    const metadata = owned.get(regions);
    if (metadata && lines[0]! >= metadata.maxLineTo) return regions;
    const next = regions.map(r => {
        if (!r.collapsed) return r;
        const low = partitionPoint(lines.length, index => lines[index]! < r.lineFrom + 1);
        if (low === lines.length || lines[low]! >= r.lineTo) return r;
        changed = true; return Object.freeze({ ...r, collapsed: false });
    }); return changed ? retain(next) : regions;
}

type Hidden = Readonly<{ from: number; to: number; before: number; owner: FoldRegion }>;
type FoldLayout = {
    regions: readonly FoldRegion[]; hidden: readonly Hidden[]; removed: number; units: number; lines: number;
    exposed?: readonly FoldRegion[]; translated?: WeakMap<FoldRegion, FoldRegion>;
};
const layouts = new WeakMap<FoldIndex, FoldLayout>();
const indexed = new WeakMap<readonly FoldRegion[], FoldIndex>();

function projectedRegion(layout: FoldLayout, r: FoldRegion): FoldRegion {
    if (!layout.units && !layout.lines) return r;
    const cache = layout.translated ??= new WeakMap(), cached = cache.get(r);
    if (cached) return cached;
    const value = shiftRegion(r, layout.units, layout.lines);
    cache.set(r, value); return value;
}

function installIndex(index: FoldIndex, lineCount: number, layout: FoldLayout): FoldIndex {
    layouts.set(index, layout);
    Object.assign(index, { lineCount, visibleLineCount: lineCount - layout.removed, collapsedCount: owned.get(layout.regions)!.collapsed });
    Object.defineProperty(index, "regions", {
        enumerable: true,
        get() {
            if (!layout.exposed) {
                layout.exposed = retain(layout.regions.map(r => projectedRegion(layout, r)));
                indexed.set(layout.exposed, index);
            }
            return layout.exposed;
        },
    });
    Object.freeze(index);
    return index;
}

function hiddenAt(layout: FoldLayout, line: number): Hidden | undefined {
    const low = partitionPoint(layout.hidden.length, i => layout.hidden[i]!.from <= line - layout.lines);
    return layout.hidden[low - 1];
}

/** One interval per outer collapsed fold; no array proportional to document line count. */
export class FoldIndex {
    private get layout(): FoldLayout { return layouts.get(this)!; }
    declare readonly lineCount: number;
    declare readonly visibleLineCount: number;
    declare readonly collapsedCount: number;
    declare readonly regions: readonly FoldRegion[];
    constructor(lineCount: number, regions: readonly FoldRegion[] = empty) {
        if (!isPositiveInteger(lineCount)) invalidRange("fold line count");
        const values = regions.length ? regions : retain(empty);
        const metadata = owned.get(values);
        if (!metadata || metadata.maxLineTo > lineCount) throw new RangeError("Expected validated fold row intervals.");
        const previous = indexed.get(values);
        if (previous) { installIndex(this, lineCount, layouts.get(previous)!); return; }
        const hidden: Hidden[] = [];
        let removed = 0;
        for (const r of values) {
            if (!r.collapsed || hidden.length && r.lineFrom < hidden.at(-1)!.to) continue;
            hidden.push(Object.freeze({ from: r.lineFrom + 1, to: r.lineTo, before: removed, owner: r })); removed += r.lineTo - r.lineFrom - 1;
        }
        installIndex(this, lineCount, { regions: values, hidden: Object.freeze(hidden), removed, units: 0, lines: 0, exposed: values });
        indexed.set(values, this);
    }
    hiddenBy(line: number): FoldRegion | undefined {
        if (!isIndex(line, this.lineCount)) invalidRange("source line");
        const layout = this.layout, h = hiddenAt(layout, line);
        return h && line < h.to + layout.lines ? projectedRegion(layout, h.owner) : undefined;
    }
    /** Visible collapsed headers only; skips expanded regions and nested hidden headers. */
    *collapsedRegions(): IterableIterator<FoldRegion> {
        const layout = this.layout;
        for (const h of layout.hidden) yield projectedRegion(layout, h.owner);
    }
    rowAt(line: number): number {
        if (!isIndex(line, this.lineCount)) invalidRange("source line");
        const layout = this.layout, h = hiddenAt(layout, line);
        return !h ? line : line < h.to + layout.lines ? h.from + layout.lines - h.before - 1 : line - h.before - (h.to - h.from);
    }
    lineAt(row: number): number {
        if (!isIndex(row, this.visibleLineCount)) invalidRange("visible row");
        const layout = this.layout;
        const low = partitionPoint(layout.hidden.length, i => { const h = layout.hidden[i]!; return h.from - h.before + layout.lines <= row; });
        const h = layout.hidden[low - 1]; return row + (h ? h.before + h.to - h.from : 0);
    }
    headerAt(line: number): FoldRegion | undefined {
        if (!isIndex(line, this.lineCount)) invalidRange("source line");
        const layout = this.layout, local = line - layout.lines;
        const low = partitionPoint(layout.regions.length, i => layout.regions[i]!.lineFrom < local);
        const r = layout.regions[low]; return r?.lineFrom === local ? projectedRegion(layout, r) : undefined;
    }
    /** Display captures may survive new expanded metadata while still expiring on changed hidden rows. */
    sameProjection(other: FoldIndex): boolean {
        if (this === other) return true;
        const a = this.layout, b = layouts.get(other);
        return !!b && this.lineCount === other.lineCount && a.hidden.length === b.hidden.length && (
            a.hidden === b.hidden && a.lines === b.lines || a.hidden.every((h, i) =>
                h.from + a.lines === b.hidden[i]!.from + b.lines && h.to + a.lines === b.hidden[i]!.to + b.lines));
    }
}

function indexFor(lineCount: number, regions: readonly FoldRegion[]): FoldIndex {
    const cached = indexed.get(regions);
    return cached?.lineCount === lineCount ? cached : new FoldIndex(lineCount, regions);
}

type FoldHistory = { deleted?: WeakMap<PositionMapping, readonly FoldRegion[]> };

type FoldProjection = (view: FoldHistory, index: FoldIndex) => FoldIndex;
export function projectFolds(before: TextBuffer, after: TextBuffer, mapping: PositionMapping, share: boolean,
    undo?: PositionMapping, parts?: readonly TextStep[]): FoldProjection {
    if (parts) {
        const projections = parts.map(part => undo
            ? projectFolds(part.after, part.before, part.mapping.invert(), share, part.mapping, part.parts)
            : projectFolds(part.before, part.after, part.mapping, share, undefined, part.parts));
        if (undo) projections.reverse();
        return (view, index) => projections.reduce((current, project) => project(view, current), index);
    }
    const swaps = lineSwaps(before, after, mapping);
    const shared = share ? new Map<FoldIndex, FoldIndex>() : undefined;
    return (view, prior) => {
        let mapped = shared?.get(prior);
        if (!mapped) {
            mapped = mapFoldIndex(after, mapping, before, prior, swaps);
            shared?.set(prior, mapped);
        }
        return replayDeletedFolds(view, prior, mapped, mapping, undo, !!swaps);
    };
}

/** Only ranges erased by this edit travel back with Undo. Surviving ranges belong to the live view. */
function replayDeletedFolds(view: FoldHistory, prior: FoldIndex, mapped: FoldIndex,
    mapping: PositionMapping, undo: PositionMapping | undefined, moved: boolean): FoldIndex {
    if (!undo) {
        if ((moved || mapped.lineCount < prior.lineCount) && layouts.get(mapped)!.regions.length < layouts.get(prior)!.regions.length) {
            const surviving = moved ? new Set(mapped.regions.map(r => r.id)) : undefined;
            const removed = prior.regions.filter(r => surviving ? !surviving.has(r.id)
                : mapping.map(r.from, "before").offset === mapping.map(r.to, "after").offset);
            if (removed.length) {
                (view.deleted ??= new WeakMap()).set(mapping, removed);
                return mapped;
            }
        }
        view.deleted?.delete(mapping);
        return mapped;
    }
    const removed = view.deleted?.get(undo);
    if (!removed) return mapped;
    const live = mapped.regions;
    const ids = new Set(live.map(r => r.id));
    const parents: FoldRegion[] = [];
    const merged: FoldRegion[] = [];
    let cursor = 0;
    for (const fold of removed) {
        while (cursor < live.length && live[cursor]!.lineFrom < fold.lineFrom) {
            const next = live[cursor++]!;
            appendNestedFold(parents, next);
            merged.push(next);
        }
        while (parents.length && parents.at(-1)!.lineTo <= fold.lineFrom) parents.pop();
        // An intervening provider update can reuse an ID or occupy these rows.
        if (!ids.has(fold.id) && (parents.at(-1)?.lineTo ?? Infinity) >= fold.lineTo
            && (live[cursor]?.lineFrom ?? Infinity) >= fold.lineTo) merged.push(fold);
    }
    return indexFor(mapped.lineCount, retain(merged.concat(live.slice(cursor))));
}
export function revealIndexSelection(buffer: TextBuffer, index: FoldIndex, selections: SelectionSet): FoldIndex {
    if (!index.collapsedCount) return index;
    const endpoints = selectionEndpoints(buffer, selections, index);
    return endpoints.size ? indexFor(buffer.lineCount, revealEndpoints(index.regions, endpoints)) : index;
}
export function revealIndexRange(buffer: TextBuffer, index: FoldIndex, from: number, to = from): FoldIndex {
    if (!isOffsetRange(from, to, buffer.length)) invalidRange("fold reveal range");
    if (!index.collapsedCount) return index;
    const first = buffer.lineAt(from), last = buffer.lineAt(to > from ? to - 1 : to);
    if (!index.hiddenBy(first) && index.rowAt(last) - index.rowAt(first) === last - first) return index;
    const revealed = index.regions.map(r => r.collapsed && r.lineFrom < last && first < r.lineTo
        ? Object.freeze({ ...r, collapsed: false }) : r);
    return indexFor(buffer.lineCount, retain(revealed));
}

/** Whole-fold translations preserve header ordering, nesting and every hidden-row interval. */
export function mapFoldIndex(buffer: TextBuffer, mapping: PositionMapping, previous: TextBuffer, index: FoldIndex, swaps?: readonly LineSwap[]): FoldIndex {
    const layout = layouts.get(index)!, first = layout.regions[0], edges = unchangedPositionEdges(mapping);
    const meta = owned.get(layout.regions)!;
    let units = layout.units, lines = layout.lines;
    if (!first || edges && meta.maxTo + units <= edges.prefix && (!swaps || meta.maxLineTo + lines <= swaps[0]!.first)) {
        if (index.lineCount === buffer.lineCount) return index;
    } else if (!swaps && edges && first.from + units >= mapping.oldLength - edges.suffix) {
        units += buffer.length - previous.length; lines += buffer.lineCount - previous.lineCount;
        if (units === layout.units && lines === layout.lines) return index;
    } else {
        return indexFor(buffer.lineCount, mapFoldRegions(buffer, mapping, index.regions, previous, swaps));
    }
    // The original index already validated these intervals. Accumulate shifts against its base.
    const next: FoldIndex = Object.create(FoldIndex.prototype);
    return installIndex(next, buffer.lineCount, units === layout.units && lines === layout.lines ? layout
        : { regions: layout.regions, hidden: layout.hidden, removed: layout.removed, units, lines,
            ...(!units && !lines ? { exposed: layout.regions } : {}) });
}

const summaries = new WeakMap<readonly FoldRegion[], Readonly<{ count: number; groups: readonly string[] }>>();
export function foldSummary(index: FoldIndex) {
    const values = layouts.get(index)?.regions ?? index.regions, cached = summaries.get(values);
    if (cached) return cached;
    const summary = Object.freeze({ count: values.length, groups: Object.freeze([...new Set(values.flatMap(r => r.group ? [r.group] : []))].sort()) });
    summaries.set(values, summary); return summary;
}

/** Command availability can stop at the first matching ID without resolving shifted offsets. */
export function* matchingFoldIds(index: FoldIndex, collapsed: boolean, group?: string, line?: number): IterableIterator<string> {
    const layout = layouts.get(index), ranges = layout?.regions ?? index.regions;
    if (collapsed ? !index.collapsedCount : index.collapsedCount === ranges.length) return;
    const local = line === undefined ? undefined : line - (layout?.lines ?? 0);
    for (const r of ranges) {
        if (local !== undefined && local < r.lineFrom) return;
        if (r.collapsed === collapsed && (group === undefined || group === r.group) && (local === undefined || local < r.lineTo)) yield r.id;
    }
}

/** The collapsed block displayed as one row at this source line, including its header. */
export function collapsedLineBlock(index: FoldIndex | undefined, line: number): FoldRegion | undefined {
    if (!index?.collapsedCount) return;
    const region = index.hiddenBy(line) ?? index.headerAt(line);
    return region?.collapsed ? region : undefined;
}

export function foldingSnapshot(buffer: TextBuffer, revision: number, generation: number, regions = empty): FoldingSnapshot {
    return snapshotFromIndex(revision, generation, indexFor(buffer.lineCount, regions));
}
export function snapshotFromIndex(revision: number, generation: number, index: FoldIndex): FoldingSnapshot {
    return Object.freeze({ revision, generation, get regions() { return index.regions; }, index });
}
