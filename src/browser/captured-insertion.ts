import { planSelectionEdits } from "../core/selections.ts";
import type { SelectionEditPlan, SelectionSet } from "../core/selections.ts";
import type { DocumentId, DocumentView, TabTarget, Workspace } from "../core/workspace.ts";
import { captureViewRequest } from "./captured-view.ts";

export type CapturedInsertion = Readonly<{ documentId: DocumentId; revision: number; length: number; selectionSet: SelectionSet;
    signal: AbortSignal; isCurrent: () => boolean; insert: (text: string) => boolean; cancel: () => void }>;

/** Internal capture shared by the browser input owner and host-controller contract tests. */
export function captureInsertion(workspace: Workspace, target: TabTarget, view: DocumentView, available: () => boolean,
    commit: (plan: SelectionEditPlan, revision: number) => boolean, ended: () => void): CapturedInsertion | undefined {
    const capture = captureViewRequest(workspace, target, view, { editOrigin: "human", available }); if (!capture) return;
    const { document, selectionSet } = capture;
    let done = false;
    const finish = () => { if (done) return; done = true; ended(); };
    const cancel = () => { try { capture.cancel(); } finally { finish(); } };
    capture.signal.addEventListener("abort", finish, { once: true });
    return Object.freeze({ documentId: document.id, revision: document.revision, length: document.buffer.length, selectionSet,
        signal: capture.signal, isCurrent: capture.isCurrent, cancel, insert: text => {
            if (!capture.isCurrent()) { cancel(); return false; }
            // Empty clipboard/conversion results never delete selected source text.
            if (!text.length) { cancel(); return false; }
            try {
                const plan = planSelectionEdits(document.buffer.length, selectionSet, text);
                return capture.commit(() => { finish(); return commit(plan, document.revision); });
            } catch (error) { cancel(); throw error; }
        } });
}
