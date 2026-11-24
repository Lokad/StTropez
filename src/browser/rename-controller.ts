import { controllerObservable } from "./controller-observable.ts";
import { Store } from "../core/observable.ts";
import { changedTextEdits } from "../core/changes.ts";
import { done, failed, refused, stale, type Outcome } from "../core/outcome.ts";
import { reviewApplied, reviewFailed, reviewRefused, type ReviewEditResult } from "./review-edit.ts";
import type { Observable } from "../core/observable.ts";
import type { DocumentId, DocumentSnapshot } from "../core/workspace.ts";
import { createLspRenameClient, type LspRenameClient } from "../protocol/lsp-rename.ts";
import { isStaleRequest } from "../protocol/wire.ts";
import type { LspWorkspaceEdit } from "../protocol/lsp-features.ts";
import { applyLspWorkspaceEdit, previewLspWorkspaceEdit } from "../protocol/lsp-workspace-edit.ts";
import type { LspWorkspaceEditPreview } from "../protocol/lsp-workspace-edit.ts";
import type { LspPrepare, LspWorkspace } from "../protocol/lsp-workspace.ts";
import { captureViewRequest, editorReadyForRequest } from "./captured-view.ts";
import type { CapturedViewRequest } from "./captured-view.ts";
import { retainEditProject, writableEdit } from "./edit-project.ts";
import type { TextEditor } from "./text-editor.ts";

export type RenamePreview = Readonly<{
    name: string; count: number; canApply: boolean;
    readPage: (page?: number) => LspWorkspaceEditPreview | undefined; confirm: () => ReviewEditResult;
}>;
export type RenameSnapshot = Readonly<{
    name: string; status: "idle" | "pending" | "ready" | "expired" | "failed" | "applied" | "disposed";
    message: string; preview: RenamePreview | null; changes: readonly Readonly<{ document: DocumentId; title: string }>[];
}>;
export type RenameControllerOptions = Readonly<{
    documents?: () => readonly DocumentSnapshot[]; canCapture?: (id: DocumentId) => boolean; prepareRequest?: () => LspPrepare | undefined;
}>;
export type RenameController = Observable<RenameSnapshot> & Readonly<{
    setName: (name: string) => void;
    request: (name?: string) => Promise<Outcome<RenamePreview>>;
    cancel: () => void;
    dispose: () => void;
}>;
type Job = { source: CapturedViewRequest<TextEditor["tab"]>; project: ReturnType<typeof retainEditProject>;
    client: LspRenameClient; invalid: boolean; timer?: number; edit?: LspWorkspaceEdit; review?: LspWorkspaceEdit };
const idle: RenameSnapshot = Object.freeze({ name: "", status: "idle", message: "", preview: null, changes: Object.freeze([]) });

/** Review and confirm one provider rename from the captured caret and project. */
export function createRenameController(editor: TextEditor, provider: LspWorkspace, options: RenameControllerOptions = {}): RenameController {
    const { workspace, view, tab } = editor, win = editor.element.ownerDocument.defaultView!;
    if (editor.signal.aborted || !workspace.ownsDocumentView(view, tab)) throw new Error("Rename requires a live document view.");
    const scope = workspace.createNotificationScope(), cell = new Store(idle, scope), events = new AbortController();
    let job: Job | undefined;
    const available = (id: DocumentId) => !events.signal.aborted && editorReadyForRequest(editor)
        && (options.canCapture?.(id) ?? true);
    const publish = (patch: Partial<RenameSnapshot>) => scope.publish(cell, Object.freeze({ ...idle, name: cell.get().name, ...patch }));
    function release() {
        const old = job; job = undefined;
        if (!old) return;
        win.clearTimeout(old.timer); old.source.cancel(); old.project.dispose(); old.client.dispose();
    }
    function expire(j: Job) {
        if (j !== job || j.invalid) return;
        j.invalid = true;
        // A resource observer latches expiry immediately. Its leases are released after delivery.
        queueMicrotask(() => { if (job === j) { release(); publish({ status: "expired", message: "The captured source or target changed." }); } });
    }
    function current(j: Job) {
        if (job !== j || j.invalid || !j.source.isCurrent() || j.edit && !j.edit.isCurrent()) return false;
        if (options.canCapture) for (const id of j.project.documents.keys()) if (!options.canCapture(id)) return false;
        return true;
    }
    function reportFailure(name: string, error: unknown): string {
        const message = error instanceof Error ? error.message : "Rename failed.";
        release();
        publish({ name, status: "failed", message });
        return message;
    }
    function makePreview(name: string, count: number, canApply: boolean): RenamePreview {
        // A retained button keeps the identity of its preview, never the project's old buffers.
        const preview: RenamePreview = Object.freeze({ name, count, canApply, readPage(page = 0) {
            const j = job;
            if (cell.get().preview !== preview || !j?.review || !current(j)) return;
            return previewLspWorkspaceEdit(j.review, id => j.project.documents.get(id as DocumentId)!.title, page);
        }, confirm() {
            scope.assertWritable(); const j = job, edit = j?.edit;
            if (cell.get().preview !== preview || !j || !edit || !current(j)) return reviewRefused("expired");
            if (!count) return reviewRefused("no-changes");
            if (!canApply || !writableEdit(editor, edit)) return reviewRefused("not-writable");
            try {
                let changed: readonly DocumentSnapshot[] = [];
                if (!j.source.commit(() => {
                    changed = applyLspWorkspaceEdit(workspace, edit, { origin: "host", requiredOrigins: ["human"], source: "rename", historyKind: "refactor", view });
                    return true;
                })) { expire(j); return reviewRefused("expired"); }
                release(); publish({ status: "applied", message: `Applied ${count} edits across ${changed.length} files.`,
                    changes: Object.freeze(changed.map(doc => Object.freeze({ document: doc.id, title: doc.title }))) });
                return reviewApplied;
            } catch (error) {
                return job === j ? reviewFailed(reportFailure(name, error)) : reviewRefused("expired");
            }
        } });
        return preview;
    }
    function setName(name: string) {
        scope.assertWritable(); if (events.signal.aborted || name === cell.get().name) return;
        release(); publish({ name });
    }
    async function prepare(name: string): Promise<Outcome<RenamePreview>> {
        if (events.signal.aborted) return stale;
        release();
        if (!name.length) {
            publish({ name, message: "Enter a new name." });
            return refused("empty-name");
        }
        let source: Job["source"] | undefined;
        let pending: Job | undefined;
        let timedOut = false;
        try {
            source = captureViewRequest(workspace, tab, view, { available: () => available(view.documentId) });
            if (!source) {
                publish({ name, status: "expired", message: "Finish pending input before requesting a rename." });
                return refused("unavailable-view");
            }
            const client = createLspRenameClient(provider);
            const j: Job = { source, client, project: retainEditProject(editor, available, () => expire(j)), invalid: false };
            job = pending = j;
            j.project.include(source.document);
            for (const doc of options.documents?.() ?? []) j.project.include(doc);
            source.signal.addEventListener("abort", () => expire(j), { once: true });
            j.timer = win.setTimeout(() => {
                timedOut = true;
                client.cancel();
            }, 30000);
            const offset = source.selectionSet.ranges[source.selectionSet.primary]!.head;
            publish({ name, status: "pending", message: "Preparing rename preview…" });
            const edit = await client.run({ document: source.document, project: [...j.project.documents.values()],
                offset, newName: name, prepare: options.prepareRequest?.() }).result;
            j.edit = edit;
            if (!current(j)) {
                expire(j);
                return stale;
            }
            win.clearTimeout(j.timer);
            j.project.includeEdit(edit);
            // Review changed text. Confirmation still checks every original target.
            const documents = edit.documents.map(({ target, edits }) => ({ target, edits: changedTextEdits(target.document.buffer, edits) }));
            j.review = { ...edit, documents };
            const count = documents.reduce((n, change) => n + change.edits.length, 0);
            const canApply = count > 0 && writableEdit(editor, edit);
            const preview = makePreview(name, count, canApply);
            publish({ name, status: "ready", preview,
                message: !count ? "No edits for this name." : !canApply ? "A rename target is read-only or locked."
                    : `Review ${count} ${count === 1 ? "change" : "changes"}.` });
            return done(preview);
        } catch (cause) {
            if (pending && pending !== job) return stale;
            let error = timedOut ? new Error("Rename request timed out.") : cause;
            if (pending) {
                try {
                    if (isStaleRequest(error) || !current(pending)) {
                        expire(pending);
                        return stale;
                    }
                } catch (captureError) { error = captureError; }
            }
            if (!pending) source?.cancel();
            reportFailure(name, error);
            return failed(error);
        }
    }
    function request(name = cell.get().name) {
        scope.assertWritable();
        return prepare(name);
    }
    function cancel() { scope.assertWritable(); if (!events.signal.aborted) { release(); publish({}); } }
    const stop = provider.subscribe(() => { const j = job; if (j?.edit && !j.edit.isCurrent()) expire(j); });
    editor.onEditIntent(() => { if (job) cancel(); }, events.signal);
    function dispose() {
        if (events.signal.aborted) return;
        scope.assertWritable(); events.abort(); stop(); release(); editor.signal.removeEventListener("abort", dispose);
        publish({ status: "disposed" });
        cell.clearSnapshotListeners();
    }
    editor.signal.addEventListener("abort", dispose, { once: true });
    return Object.freeze({ request, setName, cancel, dispose, ...controllerObservable(cell, "Rename", () => events.signal.aborted) });
}
