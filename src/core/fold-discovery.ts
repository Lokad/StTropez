import type { TextBuffer } from "./text-buffer.ts";
import type { FoldRange, FoldRegion } from "./folding.ts";

export type DiscoveredFold = Readonly<{ from: number; to: number; group?: string }>;
export type IndentationFoldingOptions = Readonly<{ tabSize?: number; indentation?: boolean; group?: string;
    markers?: readonly Readonly<{ start: string; end: string; group: string }>[] }>;

/** Host-supplied off-side and marker policy. No language parser or whole-document string. */
export function* discoverIndentationFolds(buffer: TextBuffer, options: IndentationFoldingOptions = {}): Generator<void, readonly DiscoveredFold[]> {
    const tabSize = options.tabSize ?? 4, markers = options.markers?.map(value => ({ ...value })) ?? [];
    if (!Number.isSafeInteger(tabSize) || tabSize < 1 || tabSize > 256) throw new RangeError("Invalid folding tab size.");
    if (markers.some(marker => !marker.start || !marker.end || !marker.group || /[\r\n]/.test(marker.start + marker.end))) throw new TypeError("Invalid fold markers.");
    const prefixUnits = markers.reduce((max, marker) => Math.max(max, marker.start.length, marker.end.length), 0) + 1;
    const result: DiscoveredFold[] = [], stack: { from: number; indent: number }[] = [];
    const regions: { from: number; marker: number }[] = [];
    let previous: { from: number; indent: number } | undefined, lastContentEnd = 0;
    const add = (from: number, to: number, group: string) => { if (from < to && buffer.lineAt(from) < buffer.lineAt(to - 1)) result.push(Object.freeze({ from, to, group })); };
    for (let line = 0; line < buffer.lineCount; line++) {
        const from = buffer.offsetAt(line), end = line + 1 < buffer.lineCount ? buffer.offsetAt(line + 1) : buffer.length;
        let at = from, indent = 0;
        while (at < end) {
            const chunk = buffer.slice(at, Math.min(end, at + 4096)); let read = 0;
            while (read < chunk.length && (chunk[read] === " " || chunk[read] === "\t")) {
                indent += chunk[read++] === "\t" ? tabSize - indent % tabSize : 1;
            }
            at += read; if (read < chunk.length) break; yield;
        }
        const prefix = buffer.slice(at, Math.min(end, at + prefixUnits));
        if (prefix && !/^[\r\n]/.test(prefix)) {
            if (options.indentation !== false) {
                while (stack.length && indent <= stack.at(-1)!.indent) add(stack.pop()!.from, lastContentEnd, options.group ?? "indentation");
                if (previous && indent > previous.indent) stack.push(previous);
            }
            const matches = (marker: string) => prefix.startsWith(marker) && (!prefix[marker.length] || /\s/.test(prefix[marker.length]!));
            const close = markers.findIndex(marker => matches(marker.end)), open = markers.findIndex(marker => matches(marker.start));
            if (close >= 0 && regions.at(-1)?.marker === close) {
                const start = regions.pop()!; add(start.from, end, markers[close]!.group);
            } else if (open >= 0) regions.push({ from, marker: open });
            previous = { from, indent }; lastContentEnd = end;
        }
        if ((line + 1) % 128 === 0) yield;
    }
    while (stack.length) add(stack.pop()!.from, lastContentEnd, options.group ?? "indentation");
    // Unclosed markers remain expanded until their matching close exists.
    return Object.freeze(result);
}

/** Choose one outer range per header and discard crossing discoveries deterministically.
 * Existing view anchors have already followed edits; matching their header/group preserves choice. */
export function reconcileFoldRanges(buffer: TextBuffer, discovered: readonly DiscoveredFold[], previous: readonly FoldRegion[]): readonly FoldRange[] {
    const sorted = discovered.map(value => {
        if (!Number.isSafeInteger(value.from) || !Number.isSafeInteger(value.to) || value.from < 0 || value.to > buffer.length || value.to <= value.from
            || value.group !== undefined && (typeof value.group !== "string" || !value.group)) throw new RangeError("Invalid discovered fold range.");
        return { ...value, lineFrom: buffer.lineAt(value.from), lineTo: buffer.lineAt(value.to - 1) + 1 };
    }).sort((a, b) => a.lineFrom - b.lineFrom || b.lineTo - a.lineTo);
    const prior = new Map(previous.map(value => [value.lineFrom, value])), ids = new Set(previous.map(value => value.id));
    const ranges: FoldRange[] = [], stack: number[] = []; let last = -1, serial = 0;
    for (const item of sorted) {
        if (item.lineTo < item.lineFrom + 2 || item.lineFrom === last) continue;
        while (stack.length && item.lineFrom >= stack.at(-1)!) stack.pop();
        if (stack.length && item.lineTo > stack.at(-1)!) continue;
        const old = prior.get(item.lineFrom); let id = old?.group === item.group ? old?.id : undefined;
        if (!id) { do { id = `discovered-${++serial}`; } while (ids.has(id)); ids.add(id); }
        ranges.push(Object.freeze({ id, from: item.from, to: item.to, ...(item.group === undefined ? {} : { group: item.group }) }));
        last = item.lineFrom; stack.push(item.lineTo);
    }
    return Object.freeze(ranges);
}
