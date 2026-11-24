import { isIndex, isNonNegativeInteger, isOffsetRange, isPositiveInteger } from "./bounds.ts";
import type { TextBuffer } from "./text-buffer.ts";
import { unchangedPositionEdges } from "./positions.ts";
import type { PositionMapping } from "./positions.ts";
import type { SelectionSet } from "./selections.ts";
import type { Observable } from "./observable.ts";
import { partitionPoint } from "./bound-search.ts";
import { appendNestedFold } from "./fold-nesting.ts";
import { lineContentEnd } from "./newlines.ts";
import type { LineSwap } from "./line-moves.ts";

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
const empty: readonly FoldRegion[] = retain([]);
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
export function createFoldRegions(buffer: TextBuffer, ranges: readonly FoldRange[], previous: readonly FoldRegion[] = empty): readonly FoldRegion[] {
    const prepared = resolved.get(buffer)?.get(ranges);
    if (prepared) {
        if (ranges === previous && owned.has(previous)) return previous;
        const prior = new Map(previous.map(r => [r.id, r])); let changed = false;
        const regions = prepared.map((r, i) => {
            const collapsed = ranges[i]!.collapsed ?? prior.get(r.id)?.collapsed ?? false;
            if (collapsed === r.collapsed) return r;
            changed = true; return Object.freeze({ ...r, collapsed });
        });
        const result = owned.has(previous) && sameFoldRegions(previous, regions) ? previous : changed ? retain(regions) : prepared;
        prepareFoldRanges(buffer, result, result); return result;
    }
    const prior = new Map(previous.map(r => [r.id, r])), ids = new Set<string>();
    const regions = ranges.map(r => {
        if (!r.id.length || r.id.length > 256 || ids.has(r.id)) throw new TypeError("Expected unique fold identities.");
        if (r.group !== undefined && !r.group) throw new TypeError("Expected a nonempty fold group.");
        const collapsed = r.collapsed ?? prior.get(r.id)?.collapsed ?? false;
        ids.add(r.id); const value = region(buffer, r.id, r.from, r.to, collapsed, r.group);
        if (!value) throw new RangeError("A fold needs a header and at least one body row."); return value;
    }).sort((a, b) => a.lineFrom - b.lineFrom || b.lineTo - a.lineTo);
    const stack: FoldRegion[] = [];
    for (let i = 0; i < regions.length; i++) {
        const r = regions[i]!; if (i && regions[i - 1]!.lineFrom === r.lineFrom) throw new RangeError("A fold header has one identity.");
        if (!appendNestedFold(stack, r)) throw new RangeError("Fold regions must nest or remain disjoint.");
    }
    const result = owned.has(previous) && sameFoldRegions(previous, regions) ? previous : regions.length ? retain(regions) : empty;
    prepareFoldRanges(buffer, result, result); return result;
}
function movedFold(buffer: TextBuffer, previous: TextBuffer, r: FoldRegion, swaps: readonly LineSwap[]): FoldRegion | null | undefined {
    const at = partitionPoint(swaps.length, i => swaps[i]!.first <= r.lineFrom);
    const swap = swaps[at - 1];
    if (!swap || r.lineTo > swap.end || r.lineFrom < swap.middle && r.lineTo > swap.middle) return;
    const shift = r.lineFrom < swap.middle ? swap.end - swap.middle : swap.first - swap.middle;
    const offset = (value: number, line: number) => {
        const target = line + shift;
        const oldEnd = line + 1 < previous.lineCount ? previous.offsetAt(line + 1) : previous.length;
        const newEnd = target + 1 < buffer.lineCount ? buffer.offsetAt(target + 1) : buffer.length;
        return value === oldEnd ? newEnd : Math.min(newEnd, buffer.offsetAt(target) + value - previous.offsetAt(line));
    };
    // An empty last source row at EOF has no character that can anchor a fold body.
    return region(buffer, r.id, offset(r.from, r.lineFrom), offset(r.to, r.lineTo - 1), r.collapsed, r.group) ?? null;
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
        else if (edges && r.from >= suffix) next = units === 0 && lines === 0 ? r
            : Object.freeze({ ...r, from: r.from + units, to: r.to + units, lineFrom: r.lineFrom + lines, lineTo: r.lineTo + lines });
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
    if (reordered) for (const next of reordered.sort((a, b) => a.lineFrom - b.lineFrom || b.lineTo - a.lineTo)) append(next);
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
export function revealSelectionFolds(buffer: TextBuffer, regions: readonly FoldRegion[], selections: SelectionSet, index?: FoldIndex, previous?: FoldIndex): readonly FoldRegion[] {
    if (index?.collapsedCount === 0) return regions;
    const metadata = owned.get(regions);
    if (metadata?.collapsed === 0) return regions;
    if (!metadata && !regions.some(r => r.collapsed)) return regions;
    return revealEndpoints(regions, selectionEndpoints(buffer, selections, index, previous));
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
    const value = Object.freeze({ ...r, from: r.from + layout.units, to: r.to + layout.units,
        lineFrom: r.lineFrom + layout.lines, lineTo: r.lineTo + layout.lines });
    cache.set(r, value); return value;
}

function installIndex(index: FoldIndex, lineCount: number, layout: FoldLayout): FoldIndex {
    layouts.set(index, layout);
    Object.defineProperties(index, {
        lineCount: { value: lineCount, enumerable: true },
        visibleLineCount: { value: lineCount - layout.removed, enumerable: true },
        collapsedCount: { value: owned.get(layout.regions)!.collapsed, enumerable: true },
        regions: { enumerable: true, get() {
            if (!layout.exposed) {
                layout.exposed = retain(layout.regions.map(r => projectedRegion(layout, r)));
                indexed.set(layout.exposed, index);
            }
            return layout.exposed;
        } },
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
    constructor(lineCount: number, regions: readonly FoldRegion[]) {
        if (!isPositiveInteger(lineCount)) throw new RangeError("Invalid fold line count.");
        const metadata = owned.get(regions);
        if (metadata && metadata.maxLineTo > lineCount) throw new RangeError("Invalid fold row interval.");
        const values = metadata ? regions : Object.freeze(regions.map(r => Object.freeze({ ...r })));
        const previous = indexed.get(values);
        if (previous) { installIndex(this, lineCount, layouts.get(previous)!); return; }
        const hidden: Hidden[] = []; let removed = 0, prior = -1; const stack: FoldRegion[] = [], ids = new Set<string>();
        for (const r of values) {
            if (!metadata) {
                if (!r.id.length || r.id.length > 256 || ids.has(r.id) || !isNonNegativeInteger(r.from) || !isNonNegativeInteger(r.to) || r.from >= r.to
                    || !isNonNegativeInteger(r.lineFrom) || !isNonNegativeInteger(r.lineTo) || r.lineFrom <= prior || r.lineTo > lineCount || r.lineTo <= r.lineFrom + 1) throw new RangeError("Invalid fold row interval.");
                if (r.group !== undefined && !r.group) throw new TypeError("Expected a nonempty fold group.");
                ids.add(r.id); prior = r.lineFrom;
                if (!appendNestedFold(stack, r)) throw new RangeError("Crossing fold rows.");
            }
            if (!r.collapsed || hidden.length && r.lineFrom < hidden.at(-1)!.to) continue;
            hidden.push(Object.freeze({ from: r.lineFrom + 1, to: r.lineTo, before: removed, owner: r })); removed += r.lineTo - r.lineFrom - 1;
        }
        if (!metadata) retain(values);
        installIndex(this, lineCount, { regions: values, hidden: Object.freeze(hidden), removed, units: 0, lines: 0, exposed: values });
        indexed.set(values, this);
    }
    hiddenBy(line: number): FoldRegion | undefined {
        if (!isIndex(line, this.lineCount)) throw new RangeError("Invalid source line.");
        const layout = this.layout, h = hiddenAt(layout, line);
        return h && line < h.to + layout.lines ? projectedRegion(layout, h.owner) : undefined;
    }
    /** Visible collapsed headers only; skips expanded regions and nested hidden headers. */
    *collapsedRegions(): IterableIterator<FoldRegion> {
        const layout = this.layout;
        for (const h of layout.hidden) yield projectedRegion(layout, h.owner);
    }
    rowAt(line: number): number {
        if (!isIndex(line, this.lineCount)) throw new RangeError("Invalid source line.");
        const layout = this.layout, h = hiddenAt(layout, line);
        return !h ? line : line < h.to + layout.lines ? h.from + layout.lines - h.before - 1 : line - h.before - (h.to - h.from);
    }
    lineAt(row: number): number {
        if (!isIndex(row, this.visibleLineCount)) throw new RangeError("Invalid visible row.");
        const layout = this.layout;
        const low = partitionPoint(layout.hidden.length, i => { const h = layout.hidden[i]!; return h.from - h.before + layout.lines <= row; });
        const h = layout.hidden[low - 1]; return row + (h ? h.before + h.to - h.from : 0);
    }
    headerAt(line: number): FoldRegion | undefined {
        if (!isIndex(line, this.lineCount)) throw new RangeError("Invalid source line.");
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
export function revealIndexSelection(buffer: TextBuffer, index: FoldIndex, selections: SelectionSet): FoldIndex {
    if (!index.collapsedCount) return index;
    const endpoints = selectionEndpoints(buffer, selections, index);
    return endpoints.size ? indexFor(buffer.lineCount, revealEndpoints(index.regions, endpoints)) : index;
}
export function revealIndexRange(buffer: TextBuffer, index: FoldIndex, from: number, to = from): FoldIndex {
    if (!isOffsetRange(from, to, buffer.length)) throw new RangeError("Invalid fold reveal range.");
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

export function foldingSnapshot(buffer: TextBuffer, revision: number, generation: number, regions: readonly FoldRegion[], previous?: FoldingSnapshot): FoldingSnapshot {
    const index = previous && previous.index.lineCount === buffer.lineCount && previous.regions === regions ? previous.index : indexFor(buffer.lineCount, regions);
    return snapshotFromIndex(revision, generation, index);
}
export function snapshotFromIndex(revision: number, generation: number, index: FoldIndex): FoldingSnapshot {
    return Object.freeze({ revision, generation, get regions() { return index.regions; }, index });
}
