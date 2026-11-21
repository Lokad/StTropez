import { ownsTextSurface } from "../core/workspace.ts";
import type { DocumentSnapshot, DocumentView, EditOrigin, TabTarget, Workspace } from "../core/workspace.ts";
import type { FoldingSnapshot } from "../core/folding.ts";
import type { SelectionSet } from "../core/selections.ts";

export type CapturedViewOptions = Readonly<{
    /** Omit for a read request. Editing also requires this origin and no edit lock. */
    editOrigin?: EditOrigin;
    /** Host lifecycle/input guard; call cancel when unobserved host state changes. */
    available?: () => boolean;
}>;
export type CapturedViewRequest<T extends TabTarget | undefined = TabTarget> = Readonly<{
    target: T; view: DocumentView; document: DocumentSnapshot; selectionSet: SelectionSet; folding: FoldingSnapshot;
    signal: AbortSignal; isCurrent: () => boolean; cancel: () => void;
    /** Consume once, keeping retention through this synchronous operation. No edit authority is granted. */
    commit: (operation: () => boolean) => boolean;
}>;

/** One retained view context. Observable interruptions latch even if the original state returns. */
export function captureViewRequest<T extends TabTarget | undefined>(workspace: Workspace, target: T, view: DocumentView,
    options: CapturedViewOptions = {}): CapturedViewRequest<T> | undefined {
    const { editOrigin, available = () => true } = options;
    const capturedTarget = target && Object.freeze({ ...target });
    if (!ownsTextSurface(workspace, view, capturedTarget) || !available()) return;
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
        return lease.active() && ownsTextSurface(workspace, view, capturedTarget)
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
        resource.metadata.subscribe(changed));
    if (capturedTarget) stops.push(workspace.tabs.subscribe(changed));
    if (!isCurrent()) return;
    return Object.freeze({ target: capturedTarget, view, document, selectionSet, folding, signal: abort.signal, isCurrent,
        cancel: () => cancel(), commit: operation => {
            if (!isCurrent()) return false;
            detach();
            try { return operation(); } finally { release(); }
        } });
}
