import type { LspWorkspaceEditNote } from "../../src/protocol/index.ts";
import type { DocumentId } from "../../src/index.ts";
import type { ChangedFile } from "./language-host.ts";
import { panelPaging } from "./panel-actions.ts";

export const editPageSize = 64;
export function editPaging(key: number, page: number, count: number, show: (page: number) => void) {
    return count > editPageSize ? panelPaging(key, page, count, editPageSize, show) : null;
}

export function changedFiles(label: string, buttonPrefix: string, files: readonly ChangedFile[], disabled: boolean, open: (id: DocumentId) => void) {
    return {
        label, identity: files, disabled,
        items: () => files.map(({ document, title }) => ({ key: document, label: buttonPrefix + title, invoke: () => open(document) })),
    };
}

export type ChangedFileList = ReturnType<typeof changedFiles>;

export function createChangedFileList(owner: Document, label: string) {
    const element = owner.createElement("ul");
    element.setAttribute("aria-label", label);
    let previous: ChangedFileList["identity"] | undefined;
    return { element, render(model: ChangedFileList) {
        if (previous !== model.identity) {
            element.replaceChildren(...model.items().map(file => {
                const row = owner.createElement("li"), button = owner.createElement("button");
                button.textContent = file.label; button.onclick = file.invoke; row.append(button); return row;
            }));
            previous = model.identity;
        }
        for (const button of element.querySelectorAll("button")) button.disabled = model.disabled;
    } };
}

export const formatEditNote = (at: LspWorkspaceEditNote): string => `${at.title} · ${at.resource} · ${at.document} @ revision ${at.revision} · [${at.from},${at.to})\nInsert ${JSON.stringify(at.insert)}${at.insertUnits > at.insert.length ? `… (${at.insertUnits} UTF-16 units)` : ""}\nContext: ${at.context}`;

export type EditNotes = Readonly<{ label: string; page: number; notes: readonly LspWorkspaceEditNote[] | undefined }>;

export function createEditNoteList(owner: Document, label: string) {
    const element = owner.createElement("ol");
    element.setAttribute("aria-label", label);
    let previous: EditNotes["notes"];
    return { element, render({ page, notes }: EditNotes) {
        element.start = page * editPageSize + 1;
        if (notes === previous) return;
        previous = notes;
        element.replaceChildren(...(notes ?? []).map(note => {
            const row = owner.createElement("li"), text = owner.createElement("pre");
            text.textContent = formatEditNote(note); row.append(text); return row;
        }));
    } };
}
