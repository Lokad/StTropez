import { createSelectionSet } from "../../src/index.ts";
import type { SelectionSet, TextBuffer, TextEdit } from "../../src/index.ts";
import { validateNavigationResult } from "./navigation.ts";
import type { NavigationInput, NavigationResult } from "./navigation.ts";

const reserved = new Set("await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield".split(" "));
/** The fixture deliberately supports the navigation worker's identifier subset. */
export function renameName(value: string): boolean {
    return value.length > 0 && value.length <= 256 && /^[\p{L}\p{Nl}_][\p{L}\p{N}\p{Pc}\p{M}\u200c\u200d]*$/u.test(value) && !reserved.has(value);
}
export type RenameCapture = Readonly<{ input: NavigationInput; document: string; offset: number }>;
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
/** Validate the whole completed reference batch before exposing an applicable preview. */
export function validateRenamePreview(value: unknown, capture: RenameCapture, buffers: ReadonlyMap<string, TextBuffer>): NavigationResult {
    const { input, document, offset } = capture, source = input.documents.find(d => d.document === document);
    if (input.kind !== "references" || !input.includeDeclaration || !renameName(input.symbol) || !source || !Number.isSafeInteger(offset) || offset < 0 || offset > source.length) throw new Error("Invalid rename origin.");
    const result = validateNavigationResult(value, input, buffers);
    if (result.truncated) throw new Error("Rename preview exceeds 1,024 locations; narrow the working-resource scope.");
    if (!result.locations.some(at => at.document === document && at.from <= offset && offset <= at.to)) throw new Error("The captured position has no code-token match to rename.");
    for (const at of result.locations) {
        const buffer = buffers.get(at.document)!;
        if (buffer.slice(Math.max(0, at.from - 1), at.from) === "$" || buffer.slice(at.to, Math.min(buffer.length, at.to + 1)) === "$") throw new Error("Dollar identifiers are outside this rename fixture.");
    }
    return result;
}
