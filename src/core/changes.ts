/** Offsets are UTF-16 code units in the original document. Ranges are half-open. */
export type TextEdit = Readonly<{ from: number; to: number; insert: string }>;

/** Apply a sorted, non-overlapping batch atomically. No edit is relative to another edit. */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
    let cursor = 0;
    const parts: string[] = [];
    for (const edit of edits) {
        if (!Number.isSafeInteger(edit.from) || !Number.isSafeInteger(edit.to)
            || edit.from < cursor || edit.to < edit.from || edit.to > text.length) {
            throw new RangeError("Edits must be sorted, non-overlapping, and within the document.");
        }
        parts.push(text.slice(cursor, edit.from), edit.insert);
        cursor = edit.to;
    }
    parts.push(text.slice(cursor));
    return parts.join("");
}
