import { createSelectionSet } from "../../src/index.ts";
import type { SelectionSet, TextEdit } from "../../src/index.ts";

const reserved = new Set("await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield".split(" "));
/** The fixture deliberately supports the synthetic provider's identifier subset. */
export function renameName(value: string): boolean {
    return value.length > 0 && value.length <= 256 && /^[\p{L}\p{Nl}_][\p{L}\p{N}\p{Pc}\p{M}\u200c\u200d]*$/u.test(value) && !reserved.has(value);
}
/** Rename retains relative positions inside the new name; ordinary replacement consumes interiors. */
export function renameSelections(length: number, selections: SelectionSet, edits: readonly TextEdit[]): SelectionSet {
    const map = (offset: number) => {
        let delta = 0;
        for (const edit of edits) {
            if (offset < edit.from) break;
            if (offset < edit.to) {
                let relative = Math.min(offset - edit.from, edit.insert.length);
                if (relative > 0 && relative < edit.insert.length && /[\ud800-\udbff]/.test(edit.insert[relative - 1]!) && /[\udc00-\udfff]/.test(edit.insert[relative]!)) relative--;
                return edit.from + delta + relative;
            }
            delta += edit.insert.length - (edit.to - edit.from);
        }
        return offset + delta;
    };
    return createSelectionSet(length + edits.reduce((n, e) => n + e.insert.length - (e.to - e.from), 0), selections.ranges.map(r => ({ ...r, anchor: map(r.anchor), head: map(r.head) })), selections.primary);
}
