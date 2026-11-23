import { createSelectionSet, type SelectionSet } from "../core/selections.ts";
import { planLinkedFieldEdit, type SnippetEditPlan, type SnippetStop } from "../core/snippets.ts";
import { lspCompletionPlan, type LspCompletion } from "../protocol/index.ts";

/** Expand the accepted text at the linked field and keep the enclosing template's Tab order. */
export function planFieldCompletion(item: LspCompletion, mode: "insert" | "replace", character: string | undefined,
    selections: SelectionSet, stops: readonly SnippetStop[], active: number): SnippetEditPlan {
    const buffer = item.source.buffer;
    const carets = createSelectionSet(buffer.length, selections.ranges.map(range => {
        const end = Math.max(range.anchor, range.head);
        return { anchor: end, head: end };
    }), selections.primary);
    const completion = lspCompletionPlan(item, mode, character, carets);
    const additional = new Set(item.additional), primaries = completion.edits.filter(edit => !additional.has(edit));
    let delta = 0;
    const heads = primaries.map((edit, index) => {
        const selection = selections.ranges[index]!;
        if (edit.from > Math.min(selection.anchor, selection.head) || edit.to < Math.max(selection.anchor, selection.head))
            throw new RangeError("Completion does not cover the selected placeholder text.");
        delta += edit.insert.length - (edit.to - edit.from);
        const head = edit.to + delta;
        return { anchor: head, head };
    });
    const field = planLinkedFieldEdit(buffer, stops, active, primaries, selections,
        createSelectionSet(buffer.length + delta, heads, selections.primary), true, item.additional);
    if (!field) throw new RangeError("Completion would leave the active snippet field.");
    const length = field.edits.reduce((n, edit) => n + edit.insert.length - (edit.to - edit.from), buffer.length);
    if (length > item.insertion.maxUnits) throw new RangeError("Completion exceeds the document limit.");
    return field;
}
