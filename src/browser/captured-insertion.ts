import { onAbort } from "./listen.ts";
import { planSelectionEdits } from "../core/selections.ts";
import type { SelectionEditPlan, SelectionSet } from "../core/selections.ts";
import type { DocumentId } from "../core/workspace.ts";
import type { TextEditor } from "./text-editor.ts";
import { captureViewRequest } from "./captured-view.ts";

export type CapturedInsertion = Readonly<{ documentId: DocumentId; revision: number; length: number; selectionSet: SelectionSet;
    signal: AbortSignal; isCurrent: () => boolean; insert: (text: string | readonly string[]) => boolean; cancel: () => void }>;

/** Internal capture shared by the browser input owner and host-controller contract tests. */
export function captureInsertion(editor: TextEditor, available: () => boolean,
    commit: (plan: SelectionEditPlan, revision: number) => boolean, ended: () => void): CapturedInsertion | undefined {
    const capture = captureViewRequest(editor, { editOrigin: "human", available }); if (!capture) return;
    const { document, selectionSet } = capture;
    let done = false;
    const finish = () => { if (done) return; done = true; ended(); };
    const cancel = () => { try { capture.cancel(); } finally { finish(); } };
    onAbort(capture.signal, finish);
    return Object.freeze({ documentId: document.id, revision: document.revision, length: document.buffer.length, selectionSet,
        signal: capture.signal, isCurrent: capture.isCurrent, cancel, insert: text => {
            if (!capture.isCurrent()) { cancel(); return false; }
            try {
                if (typeof text !== "string") {
                    if (!Array.isArray(text) || text.length !== selectionSet.ranges.length
                        || !selectionSet.ranges.every((_, index) => typeof text[index] === "string"))
                        throw new TypeError("Expected one string per captured selection.");
                }
                if (text === "" || Array.isArray(text) && text.every(part => part === "")) { cancel(); return false; }
                const plan = planSelectionEdits(document.buffer.length, selectionSet, text);
                return capture.commit(() => { finish(); return commit(plan, document.revision); });
            } catch (error) { cancel(); throw error; }
        } });
}
