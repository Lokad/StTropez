import type { TextEdit } from "./changes.ts";
import { forwardedChanges } from "./positions.ts";
import { splitsTextPair, splitsTextPairAt } from "./utf16.ts";
import type { TextBuffer } from "./text-buffer.ts";
import type { DocumentChange } from "./workspace.ts";

/** Repeated nearby boundary checks share one short buffer read in a dense change batch. */
function boundaryReader(buffer: TextBuffer, count: number) {
    if (count < 64) return (offset: number) => splitsTextPair(buffer, offset);
    let start = 0, window = "", previous = -Infinity;
    return (offset: number) => {
        if (offset <= 0 || offset >= buffer.length) return false;
        if (offset <= start || offset >= start + window.length) {
            start = offset - 1;
            const lookahead = offset >= previous && offset - previous <= 64 ? 512 : 1;
            window = buffer.slice(start, Math.min(buffer.length, offset + lookahead));
        }
        previous = offset;
        return splitsTextPairAt(window, offset - start);
    };
}

/** Build peer edits only when requested. Each inserted string is read on its first use. */
export function documentChange(fields: Omit<DocumentChange, "edits">, before: TextBuffer, after: TextBuffer): DocumentChange {
    let edits: readonly TextEdit[] | undefined;
    function edit(from: number, to: number, start: number, end: number): TextEdit {
        let inserted: string | undefined;
        return Object.freeze({ from, to, get insert() { return inserted ??= after.slice(start, end); } });
    }
    const change: DocumentChange = { ...fields, get edits() {
        if (edits) return edits;
        const ranges = forwardedChanges(fields.mapping);
        const inOld = boundaryReader(before, ranges.length), inNew = boundaryReader(after, ranges.length);
        const splits = (oldAt: number, newAt: number) => inOld(oldAt) || inNew(newAt);
        const result: TextEdit[] = [];
        let from = 0, start = 0, to = 0, end = 0, pending = false;
        for (const range of ranges) {
            const gap = range.from - to, nextStart = end + gap;
            const extendRight = pending && splits(to, end) ? 1 : 0;
            const extendLeft = pending && !gap ? extendRight : splits(range.from, nextStart) ? 1 : 0;
            // Both ranges borrow only from the unchanged gap. If they need the same
            // unit, or touch inside a pair, keep them as one edit.
            if (!pending || gap >= extendRight + extendLeft) {
                if (pending) result.push(edit(from, to + extendRight, start, end + extendRight));
                from = range.from - extendLeft; start = nextStart - extendLeft;
            }
            pending = true; to = range.to; end = nextStart + range.insertedLength;
        }
        if (pending) {
            const extendRight = splits(to, end) ? 1 : 0;
            result.push(edit(from, to + extendRight, start, end + extendRight));
        }
        return edits = Object.freeze(result);
    } };
    // Serializing a document snapshot must not materialize inserted text.
    Object.defineProperty(change, "edits", { enumerable: false });
    return Object.freeze(change);
}
