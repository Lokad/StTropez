import type { DocumentId } from "../core/workspace.ts";
import type { LspEditNotes } from "../protocol/lsp-workspace-edit.ts";
import { onAbort } from "./listen.ts";
import type { TextEditor } from "./text-editor.ts";

type ReadEdits = { readEdits(first: number, end: number): LspEditNotes | undefined };
const pageSize = 64;

function excerpt(value: string, length: number) {
    return value + (length > value.length ? `… (${length} UTF-16 units)` : "");
}

/** Buttons belong to the page that created them. A held press cannot advance a replacement page. */
export function reviewPanel(editor: TextEditor, signal: AbortSignal, className: string, title: string,
    text = (label: string) => label) {
    const doc = editor.element.ownerDocument;
    const node = <K extends keyof HTMLElementTagNameMap>(tag: K) => doc.createElement(tag);
    const panel = node("section");
    // Clicks on review text and disabled controls must not focus the editor behind the panel.
    panel.tabIndex = -1;
    // Appending the panel can throw after insertion, before an overlay returns its disposer.
    onAbort(signal, () => panel.remove());
    panel.className = className;
    panel.setAttribute("aria-label", text(title));
    const status = node("p");
    const list = node("ol");
    const pages = node("div");
    function button(parent: HTMLElement, label: string, action: () => void, previous?: HTMLButtonElement) {
        const control = node("button");
        control.type = "button";
        control.textContent = text(label);
        control.onclick = action;
        if (previous) previous.replaceWith(control);
        else parent.append(control);
        return control;
    }
    function paging(parent: HTMLElement, subject: string, offset: number, total: number, size: number,
        change: (next: number) => void) {
        const focus = parent.querySelector(":focus")?.textContent;
        parent.replaceChildren();
        if (total <= size) return;
        for (const [label, next] of [["Previous ", offset - size], ["Next ", offset + size]] as const) {
            const item = button(parent, label + subject, () => {
                if (item.isConnected && item.parentElement === parent) change(next);
            });
            item.disabled = next < 0 || next >= total;
        }
        if (focus) {
            const enabled = [...parent.querySelectorAll<HTMLButtonElement>("button:enabled")];
            (enabled.find(item => item.textContent === focus) ?? enabled[0])?.focus({ preventScroll: true });
        }
    }
    function showEdits(result: ReadEdits | Pick<LspEditNotes, "notes"> | null, offset = 0): number {
        const batch = result && ("notes" in result
            ? { total: result.notes.length, notes: result.notes.slice(offset, offset + pageSize) }
            : result.readEdits(offset, offset + pageSize));
        const total = batch?.total ?? 0;
        paging(pages, "edits", offset, total, pageSize, next => showEdits(result, next));
        list.replaceChildren();
        list.start = offset + 1;
        for (const note of batch?.notes ?? []) {
            const { line, column } = editor.workspace.document(note.document as DocumentId).buffer.positionAt(note.from);
            const row = node("li");
            const code = node("code");
            const before = node("del");
            const after = node("ins");
            before.textContent = excerpt(note.before, note.to - note.from);
            after.textContent = excerpt(note.insert, note.insertUnits);
            code.append(before, " → ", after);
            row.append(`${note.title} · ${line + 1}:${column + 1} `, code);
            list.append(row);
        }
        list.scrollTop = 0;
        return total;
    }
    return { panel, status, list, pages, showEdits, node, button, paging, text };
}
