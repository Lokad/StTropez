import { emptyList } from "../core/empty-list.ts";
import { invalidRange, isNonNegativeInteger, isOffsetRange } from "../core/bounds.ts";
import { partitionPoint } from "../core/bound-search.ts";
import { composePositionMaps, positionMapSize } from "../core/positions.ts";
import type { PositionMapping } from "../core/positions.ts";
import type { DocumentChange, DocumentSnapshot } from "../core/workspace.ts";
import type { InlineDecoration, LineClass, LineDecorator, PresentedLine } from "./viewport.ts";
import { validDecorationClass } from "./decoration-parts.ts";

export type DecorationLayerOptions = Readonly<{ order: number; minimap?: boolean }>;
export type DecorationLayer = Readonly<{
    set: (revision: number, ranges: readonly InlineDecoration[]) => boolean;
    clear: () => void;
    dispose: () => void;
}>;
export type DecorationProvider = Readonly<{ invalidate: (fromLine?: number, toLine?: number) => void; dispose: () => void }>;
export type DecorationLayers = Readonly<{
    add: (options: DecorationLayerOptions) => DecorationLayer;
    addProvider: (options: DecorationLayerOptions & Readonly<{ provide?: LineDecorator; lineClass?: LineClass }>) => DecorationProvider;
}>;

type Entry = { order: number; minimap: boolean; provide?: LineDecorator; lineClass?: LineClass; ranges?: RangeIndex };
type Fragment = Readonly<{ line: number; start: number; from: number; to: number; endsLine: boolean }>;
type Dirty = (row: Fragment) => boolean;
const all = () => true;

function sameRange(a: InlineDecoration, b: InlineDecoration): boolean {
    if (a.from !== b.from || a.to !== b.to || a.className !== b.className || a.before !== b.before || a.afterLine !== b.afterLine) return false;
    if (a.properties === b.properties) return true;
    const aKeys = Object.keys(a.properties ?? {}) as `--${string}`[];
    return aKeys.length === Object.keys(b.properties ?? {}).length && aKeys.every(key => a.properties?.[key] === b.properties?.[key]);
}

/** Keep short edit maps; move the ranges themselves when a map would cost more. */
class RangeIndex {
    private readonly ends: number[] = [];
    private readonly ranges: InlineDecoration[];
    private readonly annotations: InlineDecoration[];
    private mapping?: PositionMapping;
    revision: number;
    constructor(revision: number, length: number, ranges: readonly InlineDecoration[]) {
        this.revision = revision;
        this.ranges = ranges.map(range => {
            const { from, to } = range;
            if (!isOffsetRange(from, to, length))
                throw new RangeError("Decoration lies outside its document revision.");
            return Object.freeze({ ...range, from, to, ...(range.properties && { properties: Object.freeze({ ...range.properties }) }) });
        }).sort((a, b) => a.from - b.from);
        this.annotations = this.ranges.filter(r => r.afterLine).sort((a, b) => a.to - b.to);
        const index = (low: number, high: number): number => {
            if (low === high) return -1;
            const mid = low + Math.floor((high - low) / 2);
            return this.ends[mid] = Math.max(this.ranges[mid]!.to, index(low, mid), index(mid + 1, high));
        };
        index(0, this.ranges.length);
    }
    advance(change: DocumentChange): RangeIndex | undefined {
        const prior = this.mapping, next = change.mapping;
        if (positionMapSize(next) + (prior ? positionMapSize(prior) : 0) > this.ranges.length) {
            const ranges: InlineDecoration[] = [];
            for (const r of this.ranges) {
                const previous = prior?.map(r.from, "after"), start = next.map(previous?.offset ?? r.from, "after");
                if (r.from === r.to && (previous?.deleted || start.deleted)) continue;
                const from = start.offset;
                const to = r.from === r.to ? from : next.map(prior?.map(r.to, "before").offset ?? r.to, "before").offset;
                if (r.from === r.to || from < to) ranges.push({ ...r, from, to });
            }
            return ranges.length ? new RangeIndex(change.revision, next.newLength, ranges) : undefined;
        }
        this.mapping = prior ? composePositionMaps(prior, next) : next;
        this.revision = change.revision;
        return this;
    }
    private query(from: number, to: number, matches: InlineDecoration[]): void {
        const map = this.mapping;
        const visit = (low: number, high: number): void => {
            if (low === high) return;
            const mid = low + Math.floor((high - low) / 2), max = this.ends[mid]!;
            if ((map?.map(max, "after").offset ?? max) < from) return;
            visit(low, mid);
            const r = this.ranges[mid]!, start = map?.map(r.from, "after"), left = start?.offset ?? r.from;
            if (left > to) return;
            const right = r.from === r.to ? left : map?.map(r.to, "before").offset ?? r.to;
            if (r.from === r.to ? !start?.deleted && left >= from : right > from && left < right && left < to) {
                matches.push(map ? { ...r, from: left, to: right } : r);
            }
            visit(mid + 1, high);
        };
        visit(0, this.ranges.length);
    }
    /** A label can reach the visible end of a line whose annotated text has scrolled out to the left. */
    private earlierAnnotations(start: number, from: number, matches: InlineDecoration[]): void {
        const map = this.mapping;
        const first = partitionPoint(this.annotations.length, i => (map?.map(this.annotations[i]!.to, "after").offset ?? this.annotations[i]!.to) < start);
        for (let i = first; i < this.annotations.length; i++) {
            const r = this.annotations[i]!, right = map?.map(r.to, "before").offset ?? r.to;
            if (right > from) break;
            const mapped = map?.map(r.from, "after"), left = mapped?.offset ?? r.from;
            const point = r.from === r.to, to = point ? left : right;
            if (to >= start && to <= from && left < from && (point ? !mapped?.deleted : left < to)) matches.push(map ? { ...r, from: left, to } : r);
        }
    }
    collect(from: number, to: number, start: number, endsLine: boolean, matches: InlineDecoration[]): void {
        if (endsLine && start < from) this.earlierAnnotations(start, from, matches);
        this.query(from, to, matches);
    }
}

export function createDecorationLayers(current: () => DocumentSnapshot | undefined, invalidate: (dirty: Dirty, minimap: boolean) => void, live: () => boolean) {
    const entries: Entry[] = [];
    let disposed = false;
    function register(options: DecorationLayerOptions): Entry {
        if (disposed || !live()) throw new Error("Decoration layers require a live view.");
        if (!Number.isFinite(options.order)) throw new RangeError("Decoration layer order must be finite.");
        const entry: Entry = { order: options.order, minimap: options.minimap !== false };
        const at = partitionPoint(entries.length, i => entries[i]!.order <= entry.order);
        entries.splice(at, 0, entry);
        return entry;
    }
    function release(entry: Entry): void {
        delete entry.provide; delete entry.lineClass; delete entry.ranges;
    }
    function remove(entry: Entry): void {
        const index = entries.indexOf(entry);
        if (index >= 0) entries.splice(index, 1);
        release(entry);
    }
    function advance(change: DocumentChange): boolean {
        let mapped = false;
        for (const entry of entries) {
            const index = entry.ranges;
            if (index?.revision === change.previousRevision) {
                const next = index.advance(change);
                if (next) entry.ranges = next; else delete entry.ranges;
                mapped = true;
            }
        }
        return mapped;
    }
    const handle: DecorationLayers = Object.freeze({
        add(options) {
            const entry = register(options);
            function replace(next?: RangeIndex): void {
                const old = entry.ranges;
                if (old === next) return;
                if (next) entry.ranges = next; else delete entry.ranges;
                invalidate(row => {
                    const before: InlineDecoration[] = [], after: InlineDecoration[] = [];
                    old?.collect(row.from, row.to, row.start, row.endsLine, before);
                    next?.collect(row.from, row.to, row.start, row.endsLine, after);
                    return before.length !== after.length || before.some((range, i) => !sameRange(range, after[i]!));
                }, entry.minimap);
            }
            return Object.freeze({
                set(revision: number, ranges: readonly InlineDecoration[]) {
                    const document = current();
                    if (disposed || !entries.includes(entry) || !document || document.revision !== revision) return false;
                    replace(ranges.length ? new RangeIndex(revision, document.buffer.length, ranges) : undefined);
                    return true;
                },
                clear: () => replace(),
                dispose: () => { replace(); remove(entry); }
            });
        },
        addProvider(options) {
            const entry = register(options);
            if (options.provide) entry.provide = options.provide;
            if (options.lineClass) entry.lineClass = options.lineClass;
            invalidate(all, entry.minimap);
            return Object.freeze({
                invalidate(fromLine = 0, toLine?: number) {
                    if (disposed || !entries.includes(entry)) return;
                    if (!isNonNegativeInteger(fromLine) || (toLine !== undefined && (!Number.isSafeInteger(toLine) || toLine < fromLine)))
                        invalidRange("decoration line interval");
                    invalidate(row => fromLine <= row.line && (toLine === undefined || row.line < toLine), entry.minimap);
                },
                dispose() {
                    if (!entries.includes(entry)) return;
                    remove(entry); invalidate(all, entry.minimap);
                }
            });
        }
    });
    function present(line: PresentedLine, overview = false, endsLine = false): readonly InlineDecoration[] {
        let result: InlineDecoration[] | undefined;
        for (const entry of entries) {
            if (overview && !entry.minimap) continue;
            if (entry.ranges?.revision === line.revision) {
                result ??= [];
                entry.ranges.collect(line.from, line.to, line.lineStart, endsLine, result);
            }
            const provided = entry.provide?.(line);
            if (provided?.length) { result ??= []; for (const range of provided) result.push(range); }
        }
        return result ?? emptyList;
    }
    function lineClasses(line: PresentedLine, overview = false): string {
        let result = "";
        for (const entry of entries) {
            if (overview && !entry.minimap) continue;
            const name = entry.lineClass?.(line);
            if (name && validDecorationClass(name)) result += (result ? " " : "") + name;
        }
        return result;
    }
    return { handle, present, lineClasses, advance, dispose() {
        disposed = true;
        entries.forEach(release); entries.length = 0;
    } };
}
