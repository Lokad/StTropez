import type { DocumentSnapshot, DocumentView, EditOrigin, TabTarget, Workspace } from "../core/workspace.ts";
import type { FoldingSnapshot } from "../core/folding.ts";
import type { SelectionSet } from "../core/selections.ts";

export type CapturedViewOptions = Readonly<{
    /** Omit for a read request. Editing also requires this origin and no edit lock. */
    editOrigin?: EditOrigin;
    /** Host lifecycle/input guard; call cancel when unobserved host state changes. */
    available?: () => boolean;
}>;
export type CapturedViewRequest = Readonly<{
    target: TabTarget; view: DocumentView; document: DocumentSnapshot; selectionSet: SelectionSet; folding: FoldingSnapshot;
    signal: AbortSignal; isCurrent: () => boolean; cancel: () => void;
    /** Consume once, keeping retention through this synchronous operation. No edit authority is granted. */
    commit: (operation: () => boolean) => boolean;
}>;

/** One retained view context. Observable interruptions latch even if the original state returns. */
export function captureViewRequest(workspace: Workspace, target: TabTarget, view: DocumentView,
    options: CapturedViewOptions = {}): CapturedViewRequest | undefined {
    const { editOrigin, available = () => true } = options;
    if (editOrigin !== undefined && !["human", "agent", "host"].includes(editOrigin)) throw new TypeError("Invalid captured edit origin.");
    if (typeof available !== "function") throw new TypeError("Expected a captured-view availability function.");
    const capturedTarget = Object.freeze({ ...target }), tab = workspace.resolveTab(capturedTarget);
    if (!workspace.ownsDocumentView(view) || tab?.surface.kind !== "text" || tab.surface.documentId !== view.documentId || !available()) return;
    const document = workspace.observeDocument(view.documentId).getSnapshot(); if (!document) return;
    const resource = workspace.resourceForDocument(document.id), permission = resource.metadata.getSnapshot();
    if (permission.state !== "ready" || editOrigin !== undefined && (!permission.capabilities.edit.includes(editOrigin) || permission.editLock !== null)) return;
    const selectionSet = view.getSnapshot().selectionSet, folding = view.folding.getSnapshot();
    const authority = () => { const state = resource.metadata.getSnapshot(); return JSON.stringify([state.state, state.capabilities.edit, state.editLock]); };
    const capturedAuthority = authority(), lease = workspace.acquire(resource.id), abort = new AbortController();
    let active = true; const stops: (() => void)[] = [];
    const detach = () => { active = false; for (const stop of stops.splice(0)) stop(); };
    const release = () => { try { lease.release(); } finally { abort.abort(); } };
    const cancel = (deferred = false) => {
        if (!active) return; detach();
        // Core observer delivery forbids writes, including retention release and host abort handlers.
        if (deferred) queueMicrotask(release); else release();
    };
    const matches = () => {
        const currentTab = workspace.resolveTab(capturedTarget);
        return lease.active() && workspace.ownsDocumentView(view) && currentTab?.surface.kind === "text" && currentTab.surface.documentId === document.id
            && workspace.observeDocument(document.id).getSnapshot()?.revision === document.revision && view.getSnapshot().selectionSet === selectionSet
            && folding.index.sameProjection(view.folding.getSnapshot().index) && authority() === capturedAuthority && available();
    };
    const isCurrent = () => {
        if (!active) return false;
        try { if (!matches()) cancel(true); } catch (error) { cancel(true); throw error; }
        return active;
    };
    const changed = () => { isCurrent(); };
    stops.push(workspace.observeDocument(document.id).subscribe(changed), view.subscribe(changed), view.folding.subscribe(changed),
        resource.metadata.subscribe(changed), workspace.tabState.subscribe(changed));
    if (!isCurrent()) return;
    return Object.freeze({ target: capturedTarget, view, document, selectionSet, folding, signal: abort.signal, isCurrent,
        cancel: () => cancel(), commit: operation => {
            if (!isCurrent()) return false;
            detach();
            try {
                if (typeof operation !== "function") throw new TypeError("Expected a synchronous captured-view operation.");
                const result = operation();
                if (typeof result !== "boolean") throw new TypeError("A captured-view operation must return a boolean synchronously.");
                return result;
            } finally { release(); }
        } });
}
