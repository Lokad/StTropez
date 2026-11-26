import type { DocumentSnapshot, DocumentView, EditOrigin, ResourceMetadata, Workspace } from "../core/workspace.ts";
import type { FoldingSnapshot } from "../core/folding.ts";
import type { SelectionSet } from "../core/selections.ts";
import type { TextEditor } from "./text-editor.ts";

function ownsEditorView(editor: TextEditor) {
    return !editor.signal.aborted && editor.workspace.ownsDocumentView(editor.view);
}

export function requireLanguageView(editor: TextEditor): void {
    if (!ownsEditorView(editor)) throw new Error("Language features require a live document view.");
}

export function isMountedEditor(editor: TextEditor, workspace = editor.workspace): boolean {
    return workspace === editor.workspace && editor.element.isConnected && ownsEditorView(editor);
}

export function editorReadyForRequest(editor: TextEditor): boolean {
    const activity = editor.activity();
    return isMountedEditor(editor) && !editor.getSnapshot().disabled && !activity.disposed && activity.input === "idle";
}

export function canInspectView(editor: TextEditor, canCapture?: () => boolean): boolean {
    return editorReadyForRequest(editor) && (canCapture?.() ?? true);
}

/** Changes to the text, selections or fold projection can retire a view request. */
export function observeViewSource(workspace: Workspace, view: DocumentView, changed: () => void) {
    const stops = [workspace.observeDocument(view.documentId).subscribe(changed), view.subscribe(changed),
        view.folding.subscribe(changed)];

    return stops;
}

export type CapturedViewOptions = Readonly<{
    /** Omit for a read request. Edits require permission for this origin. */
    editOrigin?: EditOrigin;
    /** Host lifecycle/input guard; call cancel when unobserved host state changes. */
    available?: () => boolean;
}>;
export type CapturedViewRequest = Readonly<{
    view: DocumentView; document: DocumentSnapshot; selectionSet: SelectionSet; folding: FoldingSnapshot;
    signal: AbortSignal; isCurrent: () => boolean; cancel: () => void;
    /** Consume once, keeping retention through this synchronous operation. No edit authority is granted. */
    commit: (operation: () => boolean) => boolean;
}>;

export function sameEditAuthority(before: ResourceMetadata, after: ResourceMetadata): boolean {
    const left = before.capabilities.edit, right = after.capabilities.edit;
    return before === after || before.state === after.state
        && (left === right || left.length === right.length && left.every((origin, index) => origin === right[index]));
}

type CaptureOwner = Pick<TextEditor, "workspace" | "view" | "signal">;

/** Capture a request until the editor closes or its source changes. */
export function captureViewRequest(editor: CaptureOwner, options: CapturedViewOptions = {}): CapturedViewRequest | undefined {
    return captureRequest(editor, options, true);
}

export function captureRequest({ workspace, view, signal }: CaptureOwner,
    options: CapturedViewOptions, selectionBound: boolean): CapturedViewRequest | undefined {
    const { editOrigin, available = () => true } = options;
    if (signal.aborted || !workspace.ownsDocumentView(view) || !available()) return;
    const document = workspace.observeDocument(view.documentId).getSnapshot(); if (!document) return;
    const resource = workspace.resource(document.id), permission = resource.metadata.getSnapshot();
    if (permission.state !== "ready" || editOrigin !== undefined && !permission.capabilities.edit.includes(editOrigin)) return;
    const selectionSet = view.getSnapshot().selectionSet, folding = view.folding.getSnapshot();
    const lease = workspace.acquire(document.id), abort = new AbortController();
    let active = true; const stops: (() => void)[] = [];
    const detach = () => { active = false; for (const stop of stops.splice(0)) stop(); };
    const release = () => { try { lease.release(); } finally { abort.abort(); } };
    const cancel = (deferred = false) => {
        if (!active) return; detach();
        // Core observer delivery forbids writes, including retention release and host abort handlers.
        if (deferred) queueMicrotask(release); else release();
    };
    const matches = () => {
        return !signal.aborted && lease.active() && workspace.ownsDocumentView(view)
            && workspace.observeDocument(document.id).getSnapshot()?.revision === document.revision
            && (!selectionBound || view.getSnapshot().selectionSet === selectionSet && folding.index.sameProjection(view.folding.getSnapshot().index))
            && sameEditAuthority(permission, resource.metadata.getSnapshot()) && available();
    };
    const isCurrent = () => {
        if (!active) return false;
        try { if (!matches()) cancel(true); } catch (error) { cancel(true); throw error; }
        return active;
    };
    const changed = () => { isCurrent(); };
    stops.push(...observeViewSource(workspace, view, changed), resource.metadata.subscribe(changed));
    signal.addEventListener("abort", () => cancel(), { once: true, signal: abort.signal });
    if (!isCurrent()) return;
    return Object.freeze({ view, document, selectionSet, folding, signal: abort.signal, isCurrent,
        cancel: () => cancel(), commit: operation => {
            if (!isCurrent()) return false;
            detach();
            try { return operation(); } finally { release(); }
        } });
}
