import type { DocumentSnapshot, DocumentView, EditOrigin, ResourceMetadata, TabTarget, Workspace } from "../core/workspace.ts";
import type { FoldingSnapshot } from "../core/folding.ts";
import type { SelectionSet } from "../core/selections.ts";
import type { TextEditor } from "./text-editor.ts";

export function editorReadyForRequest(editor: TextEditor, activity = editor.activity()): boolean {
    return editor.element.isConnected && !editor.getSnapshot().disabled && !activity.disposed
        && !activity.composing && !activity.pendingInput && !activity.pendingCommand;
}

/** Changes to the text, selections, fold projection or mounted tab can retire a view request. */
export function observeViewSource(workspace: Workspace, view: DocumentView, target: TabTarget | undefined, changed: () => void) {
    const stops = [workspace.observeDocument(view.documentId).subscribe(changed), view.subscribe(changed),
        view.folding.subscribe(changed)];
    if (target) stops.push(workspace.tabs.subscribe(changed));
    return stops;
}

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

export function sameEditAuthority(before: ResourceMetadata, after: ResourceMetadata): boolean {
    const left = before.capabilities.edit, right = after.capabilities.edit;
    return before === after || before.state === after.state
        && (left === right || left.length === right.length && left.every((origin, index) => origin === right[index]))
        && before.editLock?.owner === after.editLock?.owner && before.editLock?.origin === after.editLock?.origin;
}

/** One retained view context. Observable interruptions latch even if the original state returns. */
export function captureViewRequest<T extends TabTarget | undefined>(workspace: Workspace, target: T, view: DocumentView,
    options: CapturedViewOptions = {}): CapturedViewRequest<T> | undefined {
    const { editOrigin, available = () => true } = options;
    const capturedTarget = target && Object.freeze({ ...target });
    if (!workspace.ownsDocumentView(view, capturedTarget) || !available()) return;
    const document = workspace.observeDocument(view.documentId).getSnapshot(); if (!document) return;
    const resource = workspace.resourceForDocument(document.id), permission = resource.metadata.getSnapshot();
    if (permission.state !== "ready" || editOrigin !== undefined && (!permission.capabilities.edit.includes(editOrigin) || permission.editLock !== null)) return;
    const selectionSet = view.getSnapshot().selectionSet, folding = view.folding.getSnapshot();
    const lease = workspace.acquire(resource.id), abort = new AbortController();
    let active = true; const stops: (() => void)[] = [];
    const detach = () => { active = false; for (const stop of stops.splice(0)) stop(); };
    const release = () => { try { lease.release(); } finally { abort.abort(); } };
    const cancel = (deferred = false) => {
        if (!active) return; detach();
        // Core observer delivery forbids writes, including retention release and host abort handlers.
        if (deferred) queueMicrotask(release); else release();
    };
    const matches = () => {
        return lease.active() && workspace.ownsDocumentView(view, capturedTarget)
            && workspace.observeDocument(document.id).getSnapshot()?.revision === document.revision && view.getSnapshot().selectionSet === selectionSet
            && folding.index.sameProjection(view.folding.getSnapshot().index) && sameEditAuthority(permission, resource.metadata.getSnapshot()) && available();
    };
    const isCurrent = () => {
        if (!active) return false;
        try { if (!matches()) cancel(true); } catch (error) { cancel(true); throw error; }
        return active;
    };
    const changed = () => { isCurrent(); };
    stops.push(...observeViewSource(workspace, view, capturedTarget, changed), resource.metadata.subscribe(changed));
    if (!isCurrent()) return;
    return Object.freeze({ target: capturedTarget, view, document, selectionSet, folding, signal: abort.signal, isCurrent,
        cancel: () => cancel(), commit: operation => {
            if (!isCurrent()) return false;
            detach();
            try { return operation(); } finally { release(); }
        } });
}
