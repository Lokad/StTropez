import type { TextEdit } from "./changes.ts";
import { positionChanges, unchangedPositionEdges } from "./positions.ts";
import type { TextBuffer } from "./text-buffer.ts";
import type { DocumentChange } from "./workspace.ts";

/** Commit metadata owns the mapping and the resulting buffer, so no text diff is needed. */
export function documentChange(fields: Omit<DocumentChange, "edits">, after: TextBuffer): DocumentChange {
    let edits: readonly TextEdit[] | undefined;
    function edit(from: number, to: number, start: number, end: number): TextEdit {
        let inserted: string | undefined;
        return Object.freeze({ from, to, get insert() { return inserted ??= after.slice(start, end); } });
    }
    const change: DocumentChange = { ...fields, get edits() {
        if (edits) return edits;
        const mapping = fields.mapping, ranges = positionChanges(mapping);
        if (ranges) {
            let delta = 0;
            edits = Object.freeze(ranges.map(({ from, to, insertedLength }) => {
                const start = from + delta;
                delta += insertedLength - (to - from);
                return edit(from, to, start, start + insertedLength);
            }));
        } else {
            // A grouped undo can span successive coordinate spaces. The composed map
            // retains the unchanged ends, so one replacement reproduces the whole group.
            const { prefix, suffix } = unchangedPositionEdges(mapping)!;
            edits = Object.freeze([edit(prefix, mapping.oldLength - suffix, prefix, after.length - suffix)]);
        }
        return edits;
    } };
    // Serializing a document snapshot must not materialize inserted text.
    Object.defineProperty(change, "edits", { enumerable: false });
    return Object.freeze(change);
}
