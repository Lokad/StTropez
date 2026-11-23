import type { TextBuffer } from "./text-buffer.ts";
import { unchangedPositionEdges } from "./positions.ts";
import type { PositionMapping } from "./positions.ts";
import type { SelectionSet } from "./selections.ts";
import type { Observable } from "./observable.ts";
import { partitionPoint } from "./bound-search.ts";
import { appendNestedFold } from "./fold-nesting.ts";

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
const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;
function region(buffer: TextBuffer, id: string, from: number, to: number, collapsed: boolean, group?: string): FoldRegion | undefined {
    if (!integer(from) || !integer(to) || from >= to || to > buffer.length) return;
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
/** View metadata follows document mappings. Degenerate/merged headers cease to be folds. */
export function mapFoldRegions(buffer: TextBuffer, mapping: PositionMapping, regions: readonly FoldRegion[], previous?: TextBuffer): readonly FoldRegion[] {
    if (!regions.length) return regions;
    const metadata = owned.get(regions), edges = previous && metadata ? unchangedPositionEdges(mapping) : undefined;
    if (edges && metadata!.maxTo <= edges.prefix) return regions;
    const suffix = edges ? mapping.oldLength - edges.suffix : Infinity;
    const units = mapping.newLength - mapping.oldLength, lines = previous ? buffer.lineCount - previous.lineCount : 0;
    const mapped: FoldRegion[] = [], headers = new Map<number, number>(), stack: FoldRegion[] = [];
    for (const r of regions) {
        let next: FoldRegion | undefined;
        if (edges && r.to <= edges.prefix) next = r;
        else if (edges && r.from >= suffix) next = units === 0 && lines === 0 ? r
            : Object.freeze({ ...r, from: r.from + units, to: r.to + units, lineFrom: r.lineFrom + lines, lineTo: r.lineTo + lines });
        else {
            const from = mapping.map(r.from, "after"), to = mapping.map(r.to, "before");
            if (from.offset < to.offset) {
                const lineFrom = edges && r.from < edges.prefix ? r.lineFrom : edges && r.from >= suffix ? r.lineFrom + lines : buffer.lineAt(from.offset);
                const lineTo = edges && r.to <= edges.prefix ? r.lineTo : edges && r.to > suffix ? r.lineTo + lines : buffer.lineAt(to.offset - 1) + 1;
                if (lineFrom + 1 < lineTo) next = Object.freeze({ ...r, from: from.offset, to: to.offset, lineFrom, lineTo, collapsed: r.collapsed && !from.deleted && !to.deleted });
            }
        }
        if (!next) continue;
        const existing = headers.get(next.lineFrom);
        if (existing !== undefined) { mapped[existing] = Object.freeze({ ...mapped[existing]!, collapsed: false }); continue; }
        if (!appendNestedFold(stack, next)) {
            // Removing a boundary newline can merge formerly disjoint headers. Do not
            // publish a crossing projection or keep the merged boundary hidden.
            const parent = headers.get(stack.at(-1)!.lineFrom)!;
            mapped[parent] = Object.freeze({ ...mapped[parent]!, collapsed: false }); continue;
        }
        headers.set(next.lineFrom, mapped.length); mapped.push(next);
    }
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
export function revealFoldRange(buffer: TextBuffer, regions: readonly FoldRegion[], from: number, to = from, index?: FoldIndex): readonly FoldRegion[] {
    if (!integer(from) || !integer(to) || to < from || to > buffer.length) throw new RangeError("Invalid fold reveal range.");
    if (index?.collapsedCount === 0) return regions;
    const first = buffer.lineAt(from), last = buffer.lineAt(to > from ? to - 1 : to) + 1; let changed = false;
    const next = regions.map(r => { if (!r.collapsed || r.lineFrom + 1 >= last || r.lineTo <= first) return r;
        changed = true; return Object.freeze({ ...r, collapsed: false }); });
    return changed ? retain(next) : regions;
}
export function revealSelectionFolds(buffer: TextBuffer, regions: readonly FoldRegion[], selections: SelectionSet, index?: FoldIndex): readonly FoldRegion[] {
    if (index?.collapsedCount === 0) return regions;
    const metadata = owned.get(regions);
    if (metadata?.collapsed === 0) return regions;
    if (!metadata && !regions.some(r => r.collapsed)) return regions;
    const endpoints = new Set<number>();
    for (const range of selections.ranges) {
        const from = Math.min(range.anchor, range.head), to = Math.max(range.anchor, range.head);
        const first = buffer.lineAt(from), last = buffer.lineAt(to);
        if (!index || index.hiddenBy(first)) endpoints.add(first);
        // A whole-line selection through EOF includes the final folded row in full.
        if (last !== first && (to !== buffer.length || from !== buffer.offsetAt(first)) && (!index || index.hiddenBy(last))) endpoints.add(last);
    }
    if (!endpoints.size) return regions;
    const lines = [...endpoints].sort((a, b) => a - b); let changed = false;
    if (metadata && lines[0]! >= metadata.maxLineTo) return regions;
    const next = regions.map(r => {
        if (!r.collapsed) return r;
        const low = partitionPoint(lines.length, index => lines[index]! < r.lineFrom + 1);
        if (low === lines.length || lines[low]! >= r.lineTo) return r;
        changed = true; return Object.freeze({ ...r, collapsed: false });
    }); return changed ? retain(next) : regions;
}

type Hidden = Readonly<{ from: number; to: number; before: number; owner: FoldRegion }>;
const indexed = new WeakMap<readonly FoldRegion[], FoldIndex>();
/** One interval per outer collapsed fold; no array proportional to document line count. */
export class FoldIndex {
    readonly lineCount: number;
    readonly visibleLineCount: number;
    readonly collapsedCount: number;
    readonly regions: readonly FoldRegion[];
    readonly #hidden: readonly Hidden[];
    constructor(lineCount: number, regions: readonly FoldRegion[]) {
        if (!Number.isSafeInteger(lineCount) || lineCount < 1) throw new RangeError("Invalid fold line count.");
        const metadata = owned.get(regions);
        if (metadata && metadata.maxLineTo > lineCount) throw new RangeError("Invalid fold row interval.");
        this.lineCount = lineCount; this.regions = metadata ? regions : Object.freeze(regions.map(r => Object.freeze({ ...r })));
        const previous = indexed.get(this.regions);
        if (previous) {
            this.visibleLineCount = lineCount - (previous.lineCount - previous.visibleLineCount);
            this.collapsedCount = previous.collapsedCount; this.#hidden = previous.#hidden; Object.freeze(this); return;
        }
        const hidden: Hidden[] = []; let removed = 0, prior = -1, collapsed = 0; const stack: FoldRegion[] = [], ids = new Set<string>();
        for (const r of this.regions) {
            if (!metadata) {
                if (!r.id.length || r.id.length > 256 || ids.has(r.id) || !integer(r.from) || !integer(r.to) || r.from >= r.to
                    || !integer(r.lineFrom) || !integer(r.lineTo) || r.lineFrom <= prior || r.lineTo > lineCount || r.lineTo <= r.lineFrom + 1) throw new RangeError("Invalid fold row interval.");
                if (r.group !== undefined && !r.group) throw new TypeError("Expected a nonempty fold group.");
                ids.add(r.id);
                prior = r.lineFrom;
                if (!appendNestedFold(stack, r)) throw new RangeError("Crossing fold rows.");
            }
            if (r.collapsed) collapsed++;
            if (!r.collapsed || hidden.length && r.lineFrom < hidden.at(-1)!.to) continue;
            hidden.push(Object.freeze({ from: r.lineFrom + 1, to: r.lineTo, before: removed, owner: r })); removed += r.lineTo - r.lineFrom - 1;
        }
        if (!metadata) retain(this.regions);
        this.visibleLineCount = lineCount - removed; this.collapsedCount = collapsed; this.#hidden = Object.freeze(hidden); Object.freeze(this); indexed.set(this.regions, this);
    }
    #at(line: number): Hidden | undefined {
        if (!integer(line) || line >= this.lineCount) throw new RangeError("Invalid source line.");
        const low = partitionPoint(this.#hidden.length, index => this.#hidden[index]!.from <= line);
        return this.#hidden[low - 1];
    }
    hiddenBy(line: number): FoldRegion | undefined { const h = this.#at(line); return h && line < h.to ? h.owner : undefined; }
    /** Visible collapsed headers only; skips expanded regions and nested hidden headers. */
    *collapsedRegions(): IterableIterator<FoldRegion> { for (const hidden of this.#hidden) yield hidden.owner; }
    rowAt(line: number): number { const h = this.#at(line); return !h ? line : line < h.to ? h.from - h.before - 1 : line - h.before - (h.to - h.from); }
    lineAt(row: number): number {
        if (!integer(row) || row >= this.visibleLineCount) throw new RangeError("Invalid visible row.");
        const low = partitionPoint(this.#hidden.length, index => { const h = this.#hidden[index]!; return h.from - h.before <= row; });
        const h = this.#hidden[low - 1]; return row + (h ? h.before + h.to - h.from : 0);
    }
    headerAt(line: number): FoldRegion | undefined {
        if (!integer(line) || line >= this.lineCount) throw new RangeError("Invalid source line.");
        const low = partitionPoint(this.regions.length, index => this.regions[index]!.lineFrom < line);
        const r = this.regions[low]; return r?.lineFrom === line ? r : undefined;
    }
    /** Display captures may survive new expanded metadata while still expiring on changed hidden rows. */
    sameProjection(other: FoldIndex): boolean {
        return this === other || this.lineCount === other.lineCount && this.#hidden.length === other.#hidden.length
            && this.#hidden.every((range, index) => range.from === other.#hidden[index]!.from && range.to === other.#hidden[index]!.to);
    }
}
/** The collapsed block displayed as one row at this source line, including its header. */
export function collapsedLineBlock(index: FoldIndex | undefined, line: number): FoldRegion | undefined {
    if (!index?.collapsedCount) return;
    const region = index.hiddenBy(line) ?? index.headerAt(line);
    return region?.collapsed ? region : undefined;
}

export function foldingSnapshot(buffer: TextBuffer, revision: number, generation: number, regions: readonly FoldRegion[], previous?: FoldingSnapshot): FoldingSnapshot {
    return Object.freeze({ revision, generation, regions, index: previous && previous.regions === regions && previous.index.lineCount === buffer.lineCount ? previous.index : new FoldIndex(buffer.lineCount, regions) });
}
