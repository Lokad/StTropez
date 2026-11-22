import type { TextEdit } from "../core/changes.ts";
import type { Selection } from "../core/history.ts";
import { lineContentEnd } from "../core/newlines.ts";
import { PositionMap, positionChanges } from "../core/positions.ts";
import { createSelectionSet, mapSelectionSet } from "../core/selections.ts";
import type { SelectionSet } from "../core/selections.ts";
import type { TextBuffer } from "../core/text-buffer.ts";
import type { DocumentSnapshot } from "../core/workspace.ts";

type Span = Readonly<{ from: number; to: number }>;

/** Remember only blank rows whose entire whitespace came from this view's Enter command. */
export function automaticIndentation() {
    let blank = new WeakMap<TextBuffer, readonly Span[]>(), current: TextBuffer | undefined, revision = -1;
    function sync(document: DocumentSnapshot): void {
        if (document.revision === revision) return;
        const previous = current && blank.get(current), priorRevision = revision, { buffer, change } = document;
        current = buffer; revision = document.revision;
        if (!previous || !change || change.previousRevision !== priorRevision || change.kind === "undo" || change.kind === "redo") return;
        const changes = positionChanges(change.mapping);
        if (!changes) return;
        const kept: Span[] = [];
        let i = 0;
        for (const span of previous) {
            while (i < changes.length && changes[i]!.to < span.from) i++;
            if (changes[i] && changes[i]!.from <= span.to) continue;
            const from = change.mapping.map(span.from).offset, to = from + span.to - span.from;
            kept.push({ from, to });
        }
        if (kept.length) blank.set(buffer, kept);
    }
    return {
        sync,
        clear() { current = undefined; revision = -1; blank = new WeakMap(); },
        remember(document: DocumentSnapshot, edits: readonly TextEdit[], planned: readonly TextEdit[]) {
            sync(document);
            const buffer = document.buffer;
            const generated = new Set(planned.map(edit => edit.insert)), spans: Span[] = [];
            let delta = 0;
            for (const edit of edits) {
                const text = edit.insert, start = edit.from + delta;
                delta += text.length - (edit.to - edit.from);
                if (!generated.has(text)) continue;
                for (let offset = 0; offset < text.length;) {
                    const from = start + offset, next = text.indexOf("\n", offset);
                    const to = start + (next < 0 ? text.length : next - Number(text[next - 1] === "\r"));
                    const line = buffer.lineAt(from);
                    if (from < to && buffer.offsetAt(line) === from && lineContentEnd(buffer, line) === to) spans.push({ from, to });
                    if (next < 0) break;
                    offset = next + 1;
                }
            }
            if (spans.length) {
                const kept = blank.get(buffer);
                blank.set(buffer, kept ? [...kept, ...spans].sort((a, b) => a.from - b.from) : spans);
            }
        },
        trim(buffer: TextBuffer, edits: readonly TextEdit[], selection: Selection | SelectionSet) {
            const spans = blank.get(buffer);
            if (!spans || !edits.some(edit => edit.to !== edit.from || edit.insert.length)) return;
            const mapping = new PositionMap(buffer.length, edits);
            const selections = "ranges" in selection ? selection : createSelectionSet(mapping.newLength, [selection]);
            const trim: TextEdit[] = [], after: TextEdit[] = [];
            let e = 0, s = 0;
            for (const span of spans) {
                while (e < edits.length && edits[e]!.to < span.from) e++;
                const edit = edits[e];
                // Enter at the end can leave a blank line behind. Other edits touching
                // its whitespace or line break belong to the user and take precedence.
                if (edit && edit.from <= span.to && !(edit.from === span.to && edit.to === span.to && /^\r?\n/.test(edit.insert))) continue;
                const from = mapping.map(span.from, "after").offset, to = mapping.map(span.to, "before").offset;
                while (s < selections.ranges.length && Math.max(selections.ranges[s]!.anchor, selections.ranges[s]!.head) < from) s++;
                const range = selections.ranges[s];
                if (range && Math.min(range.anchor, range.head) <= to) continue;
                trim.push({ ...span, insert: "" }); after.push({ from, to, insert: "" });
            }
            if (!trim.length) return;
            const combined = [...edits, ...trim].sort((a, b) => a.from - b.from || a.to - b.to);
            return { edits: combined, selectionSet: mapSelectionSet(new PositionMap(mapping.newLength, after), selections) };
        },
    };
}
