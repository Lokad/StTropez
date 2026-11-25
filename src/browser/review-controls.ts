import type { DocumentId } from "../core/workspace.ts";
import type { LspEditNotes } from "../protocol/lsp-workspace-edit.ts";
import type { TextEditor } from "./text-editor.ts";

type ReadEdits = { readEdits(first: number, end: number): LspEditNotes | undefined };

/** Buttons belong to the page that created them. A held press cannot advance a replacement page. */
export function reviewElements(doc: Document, text: (label: string) => string) {
    const node = <K extends keyof HTMLElementTagNameMap>(tag: K) => doc.createElement(tag);
    function button(parent: HTMLElement, label: string, action: () => void) {
        const control = node("button");
        control.type = "button";
        control.textContent = text(label);
        control.onclick = action;
        parent.append(control);
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
    return { node, button, paging };
}

const pageSize = 64;
function excerpt(value: string, length: number) {
    return value + (length > value.length ? `… (${length} UTF-16 units)` : "");
}

export function editPreview(editor: TextEditor, ui: ReturnType<typeof reviewElements>, list: HTMLOListElement, pages: HTMLElement) {
    function show(result: ReadEdits | null, offset = 0): number {
        const batch = result?.readEdits(offset, offset + pageSize);
        const total = batch?.total ?? 0;
        ui.paging(pages, "edits", offset, total, pageSize, next => show(result, next));
        list.replaceChildren();
        list.start = offset + 1;
        for (const note of batch?.notes ?? []) {
            const { line, column } = editor.workspace.document(note.document as DocumentId).buffer.positionAt(note.from);
            const row = ui.node("li");
            const code = ui.node("code");
            const before = ui.node("del");
            const after = ui.node("ins");
            before.textContent = excerpt(note.before, note.to - note.from);
            after.textContent = excerpt(note.insert, note.insertUnits);
            code.append(before, " → ", after);
            row.append(`${note.title} · ${line + 1}:${column + 1} `, code);
            list.append(row);
        }
        list.scrollTop = 0;
        return total;
    }
    return show;
}
