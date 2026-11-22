import type { DocumentId } from "../../src/index.ts";
import type { ChangedFile } from "./language-host.ts";

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
