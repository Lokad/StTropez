import { Store } from "../core/observable.ts";
import type { Observable } from "../core/observable.ts";
import { ownsTextSurface } from "../core/workspace.ts";
import type { DocumentId, DocumentSnapshot } from "../core/workspace.ts";
import { createLspRenameClient } from "../protocol/lsp-rename.ts";
import type { LspWorkspaceEdit } from "../protocol/lsp-features.ts";
import { applyLspWorkspaceEdit, previewLspWorkspaceEdit } from "../protocol/lsp-workspace-edit.ts";
import type { LspWorkspaceEditPreview } from "../protocol/lsp-workspace-edit.ts";
import type { LspPrepare, LspWorkspace } from "../protocol/lsp-workspace.ts";
import { captureViewRequest } from "./captured-view.ts";
import type { CapturedViewRequest } from "./captured-view.ts";
import { retainEditProject, writableEdit } from "./edit-project.ts";
import type { TextEditor } from "./text-editor.ts";

export type RenamePreview = Readonly<{
    name: string; count: number; canApply: boolean;
    readPage: (page?: number) => LspWorkspaceEditPreview | undefined; confirm: () => boolean;
}>;
export type RenameSnapshot = Readonly<{
    name: string; status: "idle" | "pending" | "ready" | "expired" | "failed" | "applied" | "disposed";
    message: string; preview: RenamePreview | null; changes: readonly Readonly<{ document: DocumentId; title: string }>[];
}>;
export type RenameControllerOptions = Readonly<{
    documents?: () => readonly DocumentSnapshot[]; canCapture?: (id: DocumentId) => boolean; prepareRequest?: () => LspPrepare | undefined;
}>;
export type RenameController = Observable<RenameSnapshot> & Readonly<{
    setName: (name: string) => void; request: (name?: string) => void; cancel: () => void; dispose: () => void;
}>;
type Job = { source: CapturedViewRequest<TextEditor["tab"]>; project: ReturnType<typeof retainEditProject>;
    client: ReturnType<typeof createLspRenameClient>; invalid: boolean; timer?: number; edit?: LspWorkspaceEdit };
const idle: RenameSnapshot = Object.freeze({ name: "", status: "idle", message: "", preview: null, changes: Object.freeze([]) });

/** Review and confirm one provider rename from the captured caret and project. */
export function createRenameController(editor: TextEditor, provider: LspWorkspace, options: RenameControllerOptions = {}): RenameController {
    const { workspace, view, tab } = editor, win = editor.element.ownerDocument.defaultView!;
    if (editor.signal.aborted || !ownsTextSurface(workspace, view, tab)) throw new Error("Rename requires a live document view.");
    const scope = workspace.createNotificationScope(), cell = new Store(idle, scope), events = new AbortController(), observers = new Set<() => void>();
    let job: Job | undefined;
    const available = (id: DocumentId) => {
        const a = editor.activity();
        return !events.signal.aborted && editor.element.isConnected && !editor.getSnapshot().disabled && !a.composing
            && !a.pendingCommand && !a.pendingInput && (options.canCapture?.(id) ?? true);
    };
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
    function fail(j: Job, error: unknown) {
        if (job !== j) return;
        if (!current(j)) { expire(j); return; }
        release(); publish({ status: "failed", message: error instanceof Error ? error.message : "Rename failed." });
    }
    const writable = (edit: LspWorkspaceEdit) => writableEdit(workspace, edit) && !(editor.getSnapshot().readOnlyReason
        && edit.documents.some(change => change.target.document.documentId === view.documentId && change.edits.length));
    function makePreview(name: string, count: number, canApply: boolean): RenamePreview {
        // A retained button keeps the identity of its preview, never the project's old buffers.
        const preview: RenamePreview = Object.freeze({ name, count, canApply, readPage(page = 0) {
            const j = job;
            if (cell.get().preview !== preview || !j?.edit || !current(j)) return;
            return previewLspWorkspaceEdit(j.edit, id => j.project.documents.get(id as DocumentId)!.title, page);
        }, confirm() {
            scope.assertWritable(); const j = job, edit = j?.edit;
            if (cell.get().preview !== preview || !canApply || !j || !edit || !current(j) || !writable(edit)) return false;
            try {
                let changed: readonly DocumentSnapshot[] = [];
                if (!j.source.commit(() => {
                    changed = applyLspWorkspaceEdit(workspace, edit, { origin: "host", requiredOrigins: ["human"], source: "rename", historyKind: "refactor", view });
                    return true;
                })) { expire(j); return false; }
                release(); publish({ status: "applied", message: `Applied ${count} edits across ${changed.length} files.`,
                    changes: Object.freeze(changed.map(doc => Object.freeze({ document: doc.id, title: doc.title }))) });
                return true;
            } catch (error) { fail(j, error); return false; }
        } });
        return preview;
    }
    function setName(name: string) {
        scope.assertWritable(); if (events.signal.aborted || name === cell.get().name) return;
        release(); publish({ name });
    }
    function request(name = cell.get().name) {
        scope.assertWritable(); if (events.signal.aborted) return;
        release();
        if (!name.length) { publish({ name, message: "Enter a new name." }); return; }
        const source = captureViewRequest(workspace, tab, view, { available: () => available(view.documentId) });
        if (!source) { publish({ name, status: "expired", message: "Finish pending input before requesting a rename." }); return; }
        let client: Job["client"];
        try { client = createLspRenameClient(provider); }
        catch (error) { source.cancel(); publish({ name, status: "failed", message: String(error) }); return; }
        const j: Job = { source, client, project: retainEditProject(editor, available, () => expire(j)), invalid: false }; job = j;
        try {
            j.project.include(source.document);
            for (const doc of options.documents?.() ?? []) j.project.include(doc);
            source.signal.addEventListener("abort", () => expire(j), { once: true });
            j.timer = win.setTimeout(() => fail(j, new Error("Rename request timed out.")), 30000);
            const offset = source.selectionSet.ranges[source.selectionSet.primary]!.head;
            publish({ name, status: "pending", message: "Preparing rename preview…" });
            void client.run({ document: j.source.document, project: [...j.project.documents.values()], offset, newName: name, prepare: options.prepareRequest?.() }).result.then(edit => {
                if (j !== job) return;
                j.edit = edit;
                if (!current(j)) { expire(j); return; }
                win.clearTimeout(j.timer); j.project.includeEdit(edit);
                const count = edit.documents.reduce((n, change) => n + change.edits.length, 0);
                const canApply = count > 0 && writable(edit);
                publish({ name, status: "ready", preview: makePreview(name, count, canApply),
                    message: !count ? "No edits for this name." : !canApply ? "A rename target is read-only or locked."
                        : `Review ${count} ${count === 1 ? "change" : "changes"}.` });
            }).catch(error => fail(j, error));
        } catch (error) { fail(j, error); }
    }
    function cancel() { scope.assertWritable(); if (!events.signal.aborted) { release(); publish({}); } }
    const stop = provider.subscribe(() => { const j = job; if (j?.edit && !j.edit.isCurrent()) expire(j); });
    editor.onEditIntent(() => { if (job) cancel(); }, events.signal);
    function dispose() {
        if (events.signal.aborted) return;
        scope.assertWritable(); events.abort(); stop(); release(); editor.signal.removeEventListener("abort", dispose);
        publish({ status: "disposed" }); for (const unsubscribe of observers) unsubscribe();
    }
    events.signal.addEventListener("abort", provider.retainFeatures("textDocument/rename"), { once: true });
    editor.signal.addEventListener("abort", dispose, { once: true });
    return Object.freeze({ request, setName, cancel, dispose, getSnapshot: cell.observable.getSnapshot, subscribe(listener: () => void) {
        if (events.signal.aborted) throw new Error("Rename controller is disposed.");
        const unsubscribe = cell.observable.subscribe(listener), stop = () => { unsubscribe(); observers.delete(stop); };
        observers.add(stop); return stop;
    } });
}
