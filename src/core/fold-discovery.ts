import { invalidRange, isOffsetRange, isPositiveInteger } from "./bounds.ts";
import type { TextBuffer } from "./text-buffer.ts";
import type { FoldRange, FoldRegion } from "./folding.ts";
import { movedCollapsedRegions, prepareFoldRanges } from "./folding.ts";
import { partitionPoint } from "./bound-search.ts";
import { appendNestedFold } from "./fold-nesting.ts";
import { lineBoundary } from "./newlines.ts";
import { kernelCursor } from "./kernel-cursor.ts";
import type { KernelCursor, KernelStatus } from "./kernel-cursor.ts";

export type DiscoveredFold = Readonly<{ from: number; to: number; group?: string; initiallyCollapsed?: boolean }>;
const discoveredRows = new WeakMap<TextBuffer, WeakMap<DiscoveredFold, Readonly<{ lineFrom: number; lineTo: number }>>>();
export type IndentationFoldingOptions = Readonly<{ tabSize?: number; indentation?: boolean; group?: string;
    markers?: readonly Readonly<{ start: string; end: string; group: string }>[] }>;
export type IndentationFoldingProgress = Readonly<{
    status: KernelStatus; phase: "validate" | "scan" | "finish" | "publish";
    workUnits: number; readUnits: number; bulkWorkUnits: number;
    result: readonly DiscoveredFold[] | null; failure: string | null;
}>;
export type IndentationFoldingCursor = KernelCursor<IndentationFoldingProgress>;
type Work = { phase: IndentationFoldingProgress["phase"]; workUnits: number; readUnits: number; bulkWorkUnits: number; checkpoint: number };
function bulk(work: Work, units: number): void { work.workUnits += units; work.bulkWorkUnits += units; }
function checkpoint(work: Work): boolean {
    if (work.workUnits - work.checkpoint < 256) return false;
    work.checkpoint = work.workUnits; return true;
}

/** Lazy off-side/marker discovery. Work budgets do not bound elapsed time or later reconciliation. */
export function discoverIndentationFolds(buffer: TextBuffer, options: IndentationFoldingOptions = {}): IndentationFoldingCursor {
    const work: Work = { phase: "validate", workUnits: 0, readUnits: 0, bulkWorkUnits: 0, checkpoint: 0 };
    return kernelCursor(discover(buffer, options, work), () => work.workUnits,
        (status, result, failure) => Object.freeze({ status, phase: work.phase, workUnits: work.workUnits,
            readUnits: work.readUnits, bulkWorkUnits: work.bulkWorkUnits, result, failure }), "Indentation folding");
}
function* discover(buffer: TextBuffer, options: IndentationFoldingOptions, work: Work): Generator<void, readonly DiscoveredFold[]> {
    const tabSize = options.tabSize ?? 4, markers: { start: string; end: string; group: string }[] = [];
    if (!isPositiveInteger(tabSize) || tabSize > 256) invalidRange("folding tab size");
    let prefixUnits = 1;
    for (const value of options.markers ?? []) {
        const marker = { ...value }; work.workUnits++;
        if (!marker.start || !marker.end || !marker.group) throw new TypeError("Invalid fold markers.");
        bulk(work, marker.start.length + marker.end.length);
        if (/[\r\n]/.test(marker.start + marker.end)) throw new TypeError("Invalid fold markers.");
        prefixUnits = Math.max(prefixUnits, marker.start.length + 1, marker.end.length + 1); markers.push(marker);
        if (checkpoint(work)) yield;
    }
    const result: DiscoveredFold[] = [], stack: { from: number; line: number; indent: number }[] = [];
    const regions: { from: number; line: number; marker: number }[] = [];
    let previous: { from: number; line: number; indent: number } | undefined, lastContentEnd = 0, lastContentLine = 0;
    let rows = discoveredRows.get(buffer); if (!rows) { rows = new WeakMap(); discoveredRows.set(buffer, rows); }
    const add = (from: number, to: number, lineFrom: number, lineTo: number, group: string) => {
        if (lineFrom + 1 >= lineTo) return;
        const range = Object.freeze({ from, to, group }); rows.set(range, { lineFrom, lineTo }); result.push(range); work.workUnits++;
    };
    const read = (from: number, to: number) => {
        const value = buffer.slice(from, to); work.readUnits += value.length;
        if (value.length > 4096) bulk(work, value.length); else work.workUnits += value.length;
        return value;
    };
    work.phase = "scan";
    for (let line = 0; line < buffer.lineCount; line++) {
        const from = buffer.offsetAt(line), end = lineBoundary(buffer, line + 1);
        let at = from, indent = 0;
        while (at < end) {
            const chunk = read(at, Math.min(end, at + 4096)); let units = 0;
            while (units < chunk.length && (chunk[units] === " " || chunk[units] === "\t")) {
                indent += chunk[units++] === "\t" ? tabSize - indent % tabSize : 1;
            }
            at += units; if (checkpoint(work)) yield;
            if (units < chunk.length) break;
        }
        const prefix = read(at, Math.min(end, at + prefixUnits));
        if (checkpoint(work)) yield;
        if (prefix && !/^[\r\n]/.test(prefix)) {
            if (options.indentation !== false) {
                while (stack.length && indent <= stack.at(-1)!.indent) {
                    const start = stack.pop()!; work.workUnits++;
                    add(start.from, lastContentEnd, start.line, lastContentLine + 1, options.group ?? "indentation");
                    if (checkpoint(work)) yield;
                }
                if (previous && indent > previous.indent) stack.push(previous);
            }
            const matches = (marker: string) => {
                bulk(work, Math.min(prefix.length, marker.length));
                return prefix.startsWith(marker) && (!prefix[marker.length] || /\s/.test(prefix[marker.length]!));
            };
            let close = -1, open = -1;
            for (let index = 0; index < markers.length && (close < 0 || open < 0); index++) {
                const marker = markers[index]!; work.workUnits++;
                if (close < 0 && matches(marker.end)) close = index;
                if (open < 0 && matches(marker.start)) open = index;
                if (checkpoint(work)) yield;
            }
            if (close >= 0 && regions.at(-1)?.marker === close) {
                const start = regions.pop()!; add(start.from, end, start.line, line + 1, markers[close]!.group);
            } else if (open >= 0) regions.push({ from, line, marker: open });
            previous = { from, line, indent }; lastContentEnd = end; lastContentLine = line;
        }
        work.workUnits++; if (checkpoint(work)) yield;
    }
    work.phase = "finish";
    while (stack.length) {
        const start = stack.pop()!; work.workUnits++;
        add(start.from, lastContentEnd, start.line, lastContentLine + 1, options.group ?? "indentation");
        if (checkpoint(work)) yield;
    }
    // Unclosed markers remain expanded until their matching close exists.
    work.phase = "publish"; bulk(work, result.length); Object.freeze(result);
    if (checkpoint(work)) yield;
    return result;
}

/** Choose one outer range per header and discard crossing discoveries deterministically.
 * Existing view anchors have already followed edits; matching their header/group preserves choice. */
export function reconcileFoldRanges(buffer: TextBuffer, discovered: readonly DiscoveredFold[], previous: readonly FoldRegion[]): readonly FoldRange[] {
    let candidates = discovered.map(value => {
        if (!isOffsetRange(value.from, value.to, buffer.length) || value.from === value.to
            || value.group !== undefined && !value.group) invalidRange("discovered fold range");
        return { ...value, ...(discoveredRows.get(buffer)?.get(value) ?? { lineFrom: buffer.lineAt(value.from), lineTo: buffer.lineAt(value.to - 1) + 1 }) };
    });
    const moved = movedCollapsedRegions(buffer, previous);
    const retained = moved.length ? new Map<number, FoldRegion>() : undefined;
    if (retained) {
        // A line move transports the visible header and its exact hidden text. A parser can temporarily
        // disagree about those boundaries. Continue discovering folds outside the transported blocks.
        const containing = (line: number) => {
            const at = partitionPoint(moved.length, i => moved[i]!.lineFrom <= line);
            const region = moved[at - 1];
            return region && line < region.lineTo ? region : undefined;
        };
        candidates = candidates.filter(item => {
            if (containing(item.lineFrom)) return false;
            const end = containing(item.lineTo - 1);
            return !end || end.lineTo === item.lineTo;
        });
        for (const region of previous) {
            if (!containing(region.lineFrom)) continue;
            retained.set(region.lineFrom, region);
            candidates.push(region);
        }
    }
    const sorted = candidates.sort((a, b) => a.lineFrom - b.lineFrom || b.lineTo - a.lineTo);
    const prior = new Map(previous.map(value => [value.lineFrom, value])), ids = new Set(previous.map(value => value.id));
    const ranges: FoldRange[] = [], regions: FoldRegion[] = [], stack: typeof sorted = [], assigned = new Set<string>(); let last = -1, serial = 0;
    for (const item of sorted) {
        if (item.lineTo < item.lineFrom + 2 || item.lineFrom === last) continue;
        if (!appendNestedFold(stack, item)) continue;
        const keep = retained?.get(item.lineFrom);
        if (keep) {
            ranges.push(keep);
            regions.push(keep);
            assigned.add(keep.id);
            last = item.lineFrom;
            continue;
        }
        const old = prior.get(item.lineFrom);
        let id = old?.group === item.group ? old?.id : undefined;
        const collapsed = !id && item.initiallyCollapsed === true;
        if (!id) { do { id = `discovered-${++serial}`; } while (ids.has(id)); ids.add(id); }
        if (id.length > 256 || assigned.has(id)) throw new TypeError("Expected unique fold identities.");
        assigned.add(id);
        const range = Object.freeze({ id, from: item.from, to: item.to,
            ...(item.group === undefined ? {} : { group: item.group }), ...(collapsed ? { collapsed } : {}) });
        ranges.push(range);
        regions.push(Object.freeze({ ...range, lineFrom: item.lineFrom, lineTo: item.lineTo, collapsed }));
        last = item.lineFrom;
    }
    Object.freeze(ranges); prepareFoldRanges(buffer, ranges, regions); return ranges;
}
