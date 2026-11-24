import { isNonNegativeInteger } from "./bounds.ts";
import type { TextBuffer } from "./text-buffer.ts";

/** Offsets are UTF-16 code units in the original document. Ranges are half-open. */
export type TextEdit = Readonly<{ from: number; to: number; insert: string }>;

/** Compare the replacement with its validated range in the source. */
export function changesText(buffer: TextBuffer, edit: TextEdit): boolean {
    return edit.to - edit.from !== edit.insert.length || buffer.slice(edit.from, edit.to) !== edit.insert;
}

export function changedTextEdits(buffer: TextBuffer, edits: readonly TextEdit[]): TextEdit[] {
    return edits.filter(edit => changesText(buffer, edit));
}

export function validateTextEdits(length: number, edits: readonly TextEdit[]): void {
    if (!isNonNegativeInteger(length)) throw new RangeError("Invalid document length.");
    let end = 0;
    for (const edit of edits) {
        if (!Number.isSafeInteger(edit.from) || !Number.isSafeInteger(edit.to) || edit.from < end
            || edit.to < edit.from || edit.to > length) {
            throw new RangeError("Edits must be sorted, non-overlapping, and within the document.");
        }
        end = edit.to;
    }
}

/** Apply a sorted, non-overlapping batch atomically. No edit is relative to another edit. */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
    validateTextEdits(text.length, edits);
    let cursor = 0;
    const parts: string[] = [];
    for (const edit of edits) {
        parts.push(text.slice(cursor, edit.from), edit.insert);
        cursor = edit.to;
    }
    parts.push(text.slice(cursor));
    return parts.join("");
}

/** Minimal single replacement for explicit whole-text boundaries such as native input or canonical saves. */
export function textDifference(before: string, after: string): TextEdit | null {
    if (before === after) return null;
    let from = 0, oldEnd = before.length, newEnd = after.length;
    while (from < oldEnd && from < newEnd && before.charCodeAt(from) === after.charCodeAt(from)) from++;
    while (oldEnd > from && newEnd > from && before.charCodeAt(oldEnd - 1) === after.charCodeAt(newEnd - 1)) { oldEnd--; newEnd--; }
    return Object.freeze({ from, to: oldEnd, insert: after.slice(from, newEnd) });
}

/** Compare the unproved edges in bounded slices, keeping a supplied buffer intact. */
export function replacementSpan(before: TextBuffer, after: string | TextBuffer) {
    const limit = Math.min(before.length, after.length);
    function equalEdge(reverse: boolean, available: number, prefix: number): number {
        let matched = 0;
        if (typeof after !== "string") {
            for (const count of before.sharedEdge(after, reverse ? "end" : "start",
                { from: prefix, to: before.length, otherFrom: prefix, otherTo: after.length })) matched = count;
        }
        while (matched < available) {
            const size = Math.min(8192, available - matched);
            const a = reverse ? before.length - matched - size : matched, b = reverse ? after.length - matched - size : matched;
            const difference = textDifference(before.slice(a, a + size), after.slice(b, b + size));
            if (difference) return matched + (reverse ? size - difference.to : difference.from);
            matched += size;
        }
        return matched;
    }
    const from = equalEdge(false, limit, 0), suffix = equalEdge(true, limit - from, from);
    return { from, to: before.length - suffix, insertedLength: after.length - suffix - from };
}

/** Hosts can submit a whole file. Compare its edges without flattening a fragmented buffer. */
export function compactDocumentEdit(before: TextBuffer, edits: readonly TextEdit[]): readonly TextEdit[] {
    const edit = edits[0];
    if (edits.length !== 1 || !edit || edit.from !== 0 || edit.to !== before.length || !before.length || !edit.insert.length) return edits;
    const { from, to, insertedLength } = replacementSpan(before, edit.insert);
    if (from === to && !insertedLength) return [];
    if (!from && to === before.length && insertedLength === edit.insert.length) return edits;
    return [{ from, to, insert: edit.insert.slice(from, from + insertedLength) }];
}
