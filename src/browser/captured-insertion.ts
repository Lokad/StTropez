import { planSelectionEdits } from "../core/selections.ts";
import type { SelectionEditPlan, SelectionSet } from "../core/selections.ts";
import type { DocumentId, DocumentView, TabTarget, Workspace } from "../core/workspace.ts";

export type CapturedInsertion = Readonly<{ documentId: DocumentId; revision: number; length: number; selectionSet: SelectionSet;
    signal: AbortSignal; isCurrent: () => boolean; insert: (text: string) => boolean; cancel: () => void }>;

/** Internal capture shared by the browser input owner and host-controller contract tests. */
export function captureInsertion(workspace: Workspace, target: TabTarget, view: DocumentView, available: () => boolean,
    commit: (plan: SelectionEditPlan, revision: number) => boolean, ended: () => void): CapturedInsertion | undefined {
    const document = workspace.observeDocument(view.documentId).getSnapshot();
    if (!document || !available() || !workspace.ownsDocumentView(view)) return;
    const resource = workspace.resourceForDocument(document.id), selections = view.getSnapshot().selectionSet, folds = view.folding.getSnapshot().generation;
    const authority = () => { const state = resource.getSnapshot(); return JSON.stringify([state.state, state.metadata.capabilities.edit, state.metadata.editLock]); };
    const permission = resource.metadata.getSnapshot();
    if (resource.getSnapshot().state !== "ready" || !permission.capabilities.edit.includes("human") || permission.editLock !== null) return;
    const capturedAuthority = authority(), lease = workspace.acquire(resource.id), abort = new AbortController();
    let done = false; const stops: (() => void)[] = [];
    const current = () => {
        const tab = workspace.resolveTab(target);
        return !done && lease.active() && available() && workspace.ownsDocumentView(view) && tab?.surface.kind === "text" && tab.surface.documentId === document.id
            && workspace.observeDocument(document.id).getSnapshot()?.revision === document.revision && view.getSnapshot().selectionSet === selections
            && view.folding.getSnapshot().generation === folds && authority() === capturedAuthority;
    };
    const finish = (deferred = false) => {
        if (done) return; done = true; stops.splice(0).forEach(stop => stop()); ended();
        // Observer delivery forbids workspace writes, including lease release.
        if (deferred) queueMicrotask(() => { lease.release(); abort.abort(); }); else { lease.release(); abort.abort(); }
    };
    const changed = () => { if (!current()) finish(true); };
    stops.push(workspace.observeDocument(document.id).subscribe(changed), view.subscribe(changed), view.folding.subscribe(changed),
        resource.metadata.subscribe(changed), workspace.tabState.subscribe(changed));
    if (!current()) { finish(); return; }
    return Object.freeze({ documentId: document.id, revision: document.revision, length: document.buffer.length, selectionSet: selections,
        signal: abort.signal, isCurrent: current, cancel: () => finish(), insert: text => {
            if (!current()) { finish(); return false; }
            if (typeof text !== "string") { finish(); throw new TypeError("Captured insertion expects text."); }
            // Empty clipboard/conversion results never delete selected source text.
            if (!text.length) { finish(); return false; }
            const plan = planSelectionEdits(document.buffer.length, selections, text);
            done = true; stops.splice(0).forEach(stop => stop()); ended();
            try { return commit(plan, document.revision); } finally { lease.release(); abort.abort(); }
        } });
}
