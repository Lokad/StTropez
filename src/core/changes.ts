/** Offsets are UTF-16 code units in the original document. Ranges are half-open. */
export type TextEdit = Readonly<{ from: number; to: number; insert: string }>;

export function validateTextEdits(length: number, edits: readonly TextEdit[]): void {
    if (!Number.isSafeInteger(length) || length < 0) throw new RangeError("Invalid document length.");
    let end = 0;
    for (const edit of edits) {
        if (!Number.isSafeInteger(edit.from) || !Number.isSafeInteger(edit.to) || edit.from < end
            || edit.to < edit.from || edit.to > length || typeof edit.insert !== "string") {
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
