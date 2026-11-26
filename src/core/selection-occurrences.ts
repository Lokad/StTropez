import { partitionPoint } from "./bound-search.ts";
import { LiteralSearch } from "./search.ts";
import type { Selection, SelectionSet } from "./selections.ts";
import type { TextBuffer } from "./text-buffer.ts";

/** Search on either side of the primary selection so overlapping literals never displace it. */
export function selectionOccurrences(buffer: TextBuffer, selections: SelectionSet, seed: Selection, all: boolean,
    wholeWord: boolean): SelectionSet {
    const from = Math.min(seed.anchor, seed.head), to = Math.max(seed.anchor, seed.head);
    if (to === from) return selections;
    const ranges: Selection[] = [];
    let primary = 0, query: string | undefined;
    const intervals = all ? [[0, from], [to, buffer.length]] as const : [[to, buffer.length], [0, from]] as const;
    for (const [start, end] of intervals) {
        if (all && start === to) { primary = ranges.length; ranges.push(seed); }
        if (end - start < to - from) continue;
        query ??= buffer.slice(from, to);
        const search = new LiteralSearch(buffer, query, { from: start, to: end, wholeWord });
        let occupied = all ? 0 : partitionPoint(selections.ranges.length, i => {
            const range = selections.ranges[i]!; return Math.max(range.anchor, range.head) < start;
        });
        try {
            for (;;) {
                const step = search.next(8192, 128);
                for (const match of step.matches) {
                    if (!all) {
                        while (occupied < selections.ranges.length) {
                            const range = selections.ranges[occupied]!;
                            const high = Math.max(range.anchor, range.head);
                            if (high > match.from || high === match.from && range.head === range.anchor) break;
                            occupied++;
                        }
                        const range = selections.ranges[occupied];
                        if (range && (Math.min(range.anchor, range.head) < match.to || range.anchor === range.head && range.head === match.to)) continue;
                    }
                    const range = seed.head < seed.anchor ? { anchor: match.to, head: match.from } : { anchor: match.from, head: match.to };
                    if (!all) return { ranges: [...selections.ranges, range], primary: selections.ranges.length };
                    ranges.push(range);
                }
                if (step.done) break;
            }
        } finally { search.dispose(); }
    }
    return all ? { ranges, primary } : selections;
}
