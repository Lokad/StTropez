import { characterWarningLabel } from "../../src/index.ts";
import type { Workspace } from "../../src/index.ts";
import type { TextEditor } from "../../src/browser/index.ts";

/** Explicit inspection of a small source neighborhood, using only public editor/host APIs. */
export function inspectCharacters(editor: TextEditor, workspace: Workspace, host: HTMLElement): void {
    const document = workspace.document(editor.view.documentId), caret = editor.view.getSnapshot().selection.head;
    const capture = editor.characterWarnings.query(Math.max(0, caret - 64), Math.min(document.buffer.length, caret + 64));
    host.replaceChildren(); const note = host.ownerDocument.createElement("p"); host.append(note);
    if (!capture) { note.textContent = "Enable character warnings to inspect the source."; return; }
    note.textContent = capture.warnings.length ? "Characters near the source cursor. Select an entry to locate it. Some are intentional, including emoji joiners."
        : "No character warnings within 64 characters of the source cursor.";
    for (const warning of capture.warnings) {
        const line = document.buffer.lineAt(warning.from), column = warning.from - document.buffer.offsetAt(line);
        const button = host.ownerDocument.createElement("button");
        button.textContent = `Ln ${line + 1}, Col ${column + 1}: ${characterWarningLabel(warning)}`;
        button.addEventListener("click", () => {
            if (!capture.isCurrent()) { host.replaceChildren(); note.textContent = "The source or warning settings changed. Inspect again."; host.append(note); return; }
            editor.view.setSelection(capture.revision, { anchor: warning.from, head: warning.to });
            editor.viewport.revealOffset(warning.from); editor.focus();
        });
        host.append(button);
    }
}
