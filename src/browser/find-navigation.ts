import type { FindIndex } from "../core/find-index.ts";
import { LiteralSearch, type SearchMatch } from "../core/search.ts";
import type { Selection } from "../core/selections.ts";
import type { TextBuffer } from "../core/text-buffer.ts";
import type { FindSnapshot } from "./find.ts";
import type { LiteralFindRepair } from "./find-index.ts";

export function matchesRange(matches: FindIndex, index: number, from: number, to: number): boolean {
    const range = index < matches.count ? matches.at(index) : undefined;
    return range?.from === from && range.to === to;
}

export function indexedSelection(matches: FindIndex, { anchor, head }: Selection): number | null {
    const from = Math.min(anchor, head);
    const index = matches.firstIntersecting(from);
    if (anchor !== head) return matchesRange(matches, index, from, Math.max(anchor, head)) ? index : null;
    return index < matches.count && matches.at(index).from <= head ? index : null;
}

/** Recheck a manually selected overlap that the non-overlapping result index can omit. */
export function replacementRange(matches: FindIndex, state: FindSnapshot, buffer: TextBuffer,
    { anchor, head }: Selection, replacedPoint: boolean): SearchMatch | undefined {
    if (!state.query) return;
    const from = Math.min(anchor, head);
    const to = Math.max(anchor, head);
    const index = matches.lowerBound(from);
    if (matchesRange(matches, index, from, to) && !(from === to && replacedPoint)) return { from, to };
    if (state.status !== "ready") return;
    // The regex backend validates the candidate against its captured pattern before replacing.
    if (state.regularExpression) return to > from && index > 0 && matches.at(index - 1).to > from ? { from, to } : undefined;
    if (state.wholeWord) return;
    const length = to - from;
    if (state.matchCase && !state.query.includes("\n")) {
        return length === state.query.length && buffer.slice(from, to) === state.query ? { from, to } : undefined;
    }
    if (length < Math.ceil(state.query.length / 2) || length > state.query.length * 2) return;
    const search = new LiteralSearch(buffer, state.query, { from, to, matchCase: state.matchCase, lineEndings: "equivalent" });
    try {
        const match = search.next(length + 3, 1).matches[0];
        return match?.from === from && match.to === to ? match : undefined;
    } finally {
        search.dispose();
    }
}

/** During repair only navigate through source already covered by the current index. */
export function nextIndexedMatch(matches: FindIndex, direction: 1 | -1, { anchor, head }: Selection,
    preview: number | undefined, navigated: number | undefined, replacedPoint: boolean,
    ready: boolean, repair: LiteralFindRepair | undefined, scannedTo: number) {
    const count = matches.count;
    const bound = direction === 1 ? Math.max(anchor, head) : Math.min(anchor, head);
    let index = matches.lowerBound(bound);
    if (preview !== undefined) index = preview + direction;
    else if (direction === -1) index--;
    else if (index < count && matches.at(index).to === bound && (navigated === index || replacedPoint)) index++;
    if (!ready) {
        if (index < 0 || index >= count) return;
        if (repair?.hasRetainedSuffix && index >= repair.prefixCount) {
            if (bound < repair.suffixStart) return;
        } else if (direction === -1 && bound > scannedTo) return;
    }
    const wrappedTo = index < 0 ? "end" : index >= count ? "start" : null;
    return { index: (index + count) % count, wrappedTo } as const;
}
