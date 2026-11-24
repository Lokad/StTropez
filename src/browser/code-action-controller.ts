import { emptyList } from "../core/empty-list.ts";
import { controllerObservable } from "./controller-observable.ts";
import { Store } from "../core/observable.ts";
import type { Observable } from "../core/observable.ts";
import { done, failed, refused, stale, type Outcome } from "../core/outcome.ts";
import type { DocumentId, DocumentSnapshot, TabTarget } from "../core/workspace.ts";
import { applyLspWorkspaceEdit, createLspActionClient, type LspActionResult, previewLspWorkspaceEdit } from "../protocol/index.ts";
import { isStaleRequest } from "../protocol/wire.ts";
import type { LspCodeAction, LspCommandPolicy, LspCommandReceipt, LspCommandScope, LspPrepare, LspWorkspace, LspWorkspaceEdit, LspWorkspaceEditPreview } from "../protocol/index.ts";
import { requireLanguageView, captureViewRequest, editorReadyForRequest } from "./captured-view.ts";
import type { CapturedViewRequest } from "./captured-view.ts";
import { retainEditProject, writableEdit } from "./edit-project.ts";
import type { TextEditor } from "./text-editor.ts";

export type CodeActionChoice = Readonly<{
    index: number; title: string; kind: string | null; preferred: boolean; disabled: string | null; needsResolve: boolean;
    select: (applyWhen?: (resolved: LspCodeAction) => boolean) => void;
}>;
export type CodeActionConfirmation = Readonly<
    { status: "applied" | "executing" | "declined" | "expired" | "disabled" | "not-writable" }
    | { status: "failed"; message: string }
>;
export type CodeActionPreview = Readonly<{
    index: number; title: string; command: string | null; disabled: string | null;
    canApply: boolean; readPage: (page?: number) => LspWorkspaceEditPreview | undefined; confirm: () => CodeActionConfirmation;
}>;
type ChangedDocument = Readonly<{ document: DocumentId; title: string }>;
export type CodeActionSnapshot = Readonly<{
    status: "idle" | "pending" | "ready" | "resolving" | "executing" | "expired" | "failed" | "applied" | "executed";
    message: string; choices: readonly CodeActionChoice[]; choice: number | null;
    preview: CodeActionPreview | null; changes: readonly ChangedDocument[];
}>;
export type CodeActionCommand = Readonly<{
    documents: readonly DocumentSnapshot[]; edit: LspWorkspaceEdit | null; isCurrent: () => boolean;
    subscribe: (listener: () => void) => () => void; cancel: () => void; execute: (scope: LspCommandScope) => Promise<LspCommandReceipt>;
}>;
export type CodeActionExecution = Readonly<{
    /** Stop pending work and report whether a command edit has already committed. */
    cancel: () => Readonly<{ applied: boolean }>;
    result: Promise<Readonly<{ success: boolean; applied: boolean; reason: string; changes: readonly ChangedDocument[] }>>;
}>;
export type CodeActionControllerOptions = Readonly<{
    documents?: () => readonly DocumentSnapshot[]; canCapture?: (id: DocumentId) => boolean;
    prepareRequest?: LspPrepare; prepareResolve?: LspPrepare; commandPolicy?: LspCommandPolicy;
    runCommand?: (command: CodeActionCommand) => CodeActionExecution | undefined; onError?: (error: unknown) => void;
}>;

type Job = {
    id: number; capture: CapturedViewRequest<TabTarget | undefined>; project: ReturnType<typeof retainEditProject>;
    timer?: number; invalid: boolean; batch?: LspActionResult; selection?: LspCodeAction;
    failure?: Outcome<never>;
    resolving?: { index: number; applyWhen: ((action: LspCodeAction) => boolean) | undefined };
};
const empty: CodeActionSnapshot = Object.freeze({ status: "idle", message: "", choices: emptyList, choice: null, preview: null, changes: emptyList });
export type CodeActionController = Observable<CodeActionSnapshot> & Readonly<{
    request: () => Promise<Outcome<readonly CodeActionChoice[]>>; cancel: () => void; dispose: () => void;
}>;

/** One editor owns the request, lazy resolution and confirmation of its displayed preview. */
export function createCodeActionController(editor: TextEditor, provider: LspWorkspace, options: CodeActionControllerOptions = {}): CodeActionController {
    const { workspace, view, tab } = editor, win = editor.element.ownerDocument.defaultView!;
    requireLanguageView(editor);
    const scope = workspace.createNotificationScope(options.onError), cell = new Store(empty, scope);
    const client = createLspActionClient(provider, options), events = new AbortController();
    let job: Job | undefined, execution: CodeActionExecution | undefined, disposed = false;
    const available = (id: DocumentId) => {
        const activity = editor.activity();
        return !disposed && editorReadyForRequest(editor, activity) && !activity.pendingGrapheme
            && !activity.pendingWord && (options.canCapture?.(id) ?? true);
    };
    const publish = (state: CodeActionSnapshot) => scope.publish(cell, Object.freeze(state));
    function current(j: Job): boolean {
        if (job !== j || j.invalid || !j.capture.isCurrent() || (j.batch && !j.batch.isCurrent())) return false;
        if (options.canCapture) for (const id of j.project.documents.keys()) if (!options.canCapture(id)) return false;
        return true;
    }
    const release = (keepClient = false) => {
        const previous = job; job = undefined;
        if (!previous) return;
        win.clearTimeout(previous.timer);
        previous.project.dispose();
        previous.capture.cancel();
        if (!keepClient) client.cancel();
    };
    const expire = (j: Job) => {
        if (job !== j || j.invalid) return;
        j.invalid = true;
        // Lease release is a workspace write. Complete it after the notifying edit.
        queueMicrotask(() => { if (job === j) { release(); publish({ ...empty, status: "expired", message: "The captured source or provider changed." }); } });
    };
    const expired = Object.freeze({ status: "expired" } as const);
    const reportFailure = (error: unknown) => {
        const message = error instanceof Error ? error.message : "Code action failed.";
        publish({ ...empty, status: "failed", message });
        return Object.freeze({ status: "failed" as const, message });
    };
    const fail = (j: Job, error: unknown): CodeActionConfirmation => {
        if (job !== j) return expired;
        release();
        return reportFailure(error);
    };
    const requestFailed = (j: Job, error: unknown): Outcome<never> => {
        if (j.failure) return j.failure;
        try {
            if (job !== j || j.invalid || isStaleRequest(error) || !j.capture.isCurrent()) {
                expire(j);
                return stale;
            }
        } catch (captureError) { error = captureError; }
        j.failure = failed(error);
        fail(j, error);
        return j.failure;
    };
    const timeout = (j: Job) => {
        win.clearTimeout(j.timer);
        j.timer = win.setTimeout(() => requestFailed(j, new Error("Code action request timed out.")), 30000);
    };
    const disabled = (batch: LspActionResult, action: LspCodeAction) => action.disabled ?? (action.command
        ? !options.runCommand || !batch.supports(action.command) ? "This command is unavailable." : null
        : !action.resolve && !action.edit?.documents.some(part => part.edits.length) ? "The provider returned no text changes." : null);
    function confirm(preview: CodeActionPreview): CodeActionConfirmation {
        scope.assertWritable();
        const j = job, action = j?.selection, batch = j?.batch;
        if (cell.get().preview !== preview || !j || !action || !batch || !current(j)) return expired;
        if (disabled(batch, action) !== null) return Object.freeze({ status: "disabled" });
        if (!writableEdit(editor, action.edit)) return Object.freeze({ status: "not-writable" });
        if (action.command) {
            let live = true;
            const isCurrent = () => live && batch.commandCurrent();
            try {
                const handle = options.runCommand?.({ documents: Object.freeze([...j.project.documents.values()]), edit: action.edit,
                    isCurrent, subscribe: client.subscribe, execute: s => isCurrent() ? batch.execute(action, s) : Promise.reject(new Error("Code action command expired.")),
                    cancel: () => { if (isCurrent()) client.cancel(); } });
                if (!handle) {
                    live = false;
                    if (cell.get().preview !== preview || !current(j)) return expired;
                    publish({ ...cell.get(), message: "The host declined this command. You can retry this preview." });
                    return Object.freeze({ status: "declined" });
                }
                void handle.result.then(receipt => {
                    if (execution !== handle) return;
                    execution = undefined; client.cancel();
                    publish({ ...empty, status: receipt.success ? receipt.applied ? "applied" : "executed" : "failed", message: receipt.reason,
                        changes: Object.freeze(receipt.changes.map(change => Object.freeze({ ...change }))) });
                }, error => {
                    if (execution !== handle) return;
                    execution = undefined; client.cancel(); publish({ ...empty, status: "failed", message: String(error) });
                });
                if (cell.get().preview !== preview) { live = false; handle.cancel(); return expired; }
                execution = handle; release(true); publish({ ...empty, status: "executing", message: "Executing the confirmed action." });
                return Object.freeze({ status: "executing" });
            } catch (error) {
                live = false;
                return cell.get().preview === preview ? fail(j, error) : expired;
            }
        }
        try {
            let changes: readonly ChangedDocument[] = [];
            if (!j.capture.commit(() => {
                changes = applyLspWorkspaceEdit(workspace, action.edit!, { origin: "host", requiredOrigins: ["human"], source: "code-action", historyKind: "refactor", view })
                    .map(doc => Object.freeze({ document: doc.id, title: doc.title }));
                return true;
            })) { expire(j); return expired; }
            release(); publish({ ...empty, status: "applied", message: "Applied the reviewed edits.", changes: Object.freeze(changes) });
        } catch (error) { return fail(j, error); }
        if (editor.element.isConnected && !editor.signal.aborted) { editor.viewport.revealOffset(view.getSnapshot().selection.head); editor.focus(); }
        return Object.freeze({ status: "applied" });
    }
    function makePreview(index: number, title: string, command: string | null, reason: string | null): CodeActionPreview {
        const preview: CodeActionPreview = Object.freeze({ index, title, command, disabled: reason, canApply: reason === null,
            readPage: (page = 0) => {
                const j = job;
                if (cell.get().preview !== preview || !j || !current(j)) return;
                const edit = j.selection?.edit;
                return edit ? previewLspWorkspaceEdit(edit, id => j.project.documents.get(id as DocumentId)!.title, page)
                    : Object.freeze({ page, count: 0, notes: emptyList });
            },
            confirm: () => confirm(preview) });
        return preview;
    }
    function present(j: Job, index: number, action: LspCodeAction, applyWhen?: (action: LspCodeAction) => boolean): void {
        if (!j.batch || !current(j)) { expire(j); return; }
        j.selection = action;
        const reason = disabled(j.batch, action) ?? (writableEdit(editor, action.edit) ? null : "This action would edit a read-only or locked file.");
        const preview = makePreview(index, action.title, action.command?.command ?? null, reason);
        publish({ ...cell.get(), status: "ready", choice: index, preview, message: reason ?? "Review the selected action before confirming." });
        if (preview.canApply && cell.get().preview === preview && applyWhen?.(action)) preview.confirm();
    }
    function choose(id: number, index: number, applyWhen?: (action: LspCodeAction) => boolean): void {
        scope.assertWritable();
        const j = job, batch = j?.batch, action = batch?.actions[index];
        if (!j || j.id !== id || !batch || !action || !current(j)) return;
        const status = cell.get().status;
        if (status !== "ready" && status !== "resolving") return;
        if (status === "resolving" && j.resolving?.index === index) { j.resolving.applyWhen = applyWhen; return; }
        if (j.resolving) {
            delete j.resolving; win.clearTimeout(j.timer);
        }
        batch.cancelResolve();
        if (!action.resolve || disabled(batch, action)) { present(j, index, action, applyWhen); return; }
        const choice = j.resolving = { index, applyWhen };
        publish({ ...cell.get(), status: "resolving", choice: index, preview: null, message: "Resolving the selected action." });
        if (job !== j || j.resolving !== choice) return;
        timeout(j);
        void batch.resolve(action, options.prepareResolve).then(resolved => {
            if (job !== j || j.resolving !== choice) return;
            if (!current(j)) { expire(j); return; }
            win.clearTimeout(j.timer); if (resolved.edit) j.project.includeEdit(resolved.edit);
            present(j, index, resolved, choice.applyWhen);
            if (j.resolving === choice) delete j.resolving;
        }).catch(error => { if (job === j && j.resolving === choice) requestFailed(j, error); });
    }
    function cancel(): void {
        scope.assertWritable(); if (disposed) return;
        const previous = execution; execution = undefined;
        const applied = previous?.cancel().applied;
        if (previous) client.cancel();
        release(); publish(applied ? { ...empty, message: "Action command cancelled after application. Its edits remain undoable." } : empty);
    }
    async function discover(): Promise<Outcome<readonly CodeActionChoice[]>> {
        if (disposed) return stale;
        let pending: Job | undefined;
        try {
            const capture = captureViewRequest(workspace, tab, view, { available: () => available(view.documentId) });
            if (!capture) {
                publish({ ...empty, status: "expired", message: "Finish the current editor operation before requesting actions." });
                return refused("unavailable-view");
            }
            const id = workspace.allocateIdentity();
            const j: Job = { id, capture, project: retainEditProject(editor, available, () => expire(j)), invalid: false };
            job = pending = j;
            j.project.include(capture.document);
            for (const doc of options.documents?.() ?? []) j.project.include(doc);
            capture.signal.addEventListener("abort", () => expire(j), { once: true });
            const range = capture.selectionSet.ranges[capture.selectionSet.primary]!;
            timeout(j);
            publish({ ...empty, status: "pending", message: "Requesting code actions." });
            const batch = await client.run({ document: capture.document, project: [...j.project.documents.values()],
                from: Math.min(range.anchor, range.head), to: Math.max(range.anchor, range.head),
                prepare: options.prepareRequest }).result;
            j.batch = batch;
            if (!current(j)) {
                expire(j);
                return stale;
            }
            win.clearTimeout(j.timer);
            for (const action of batch.actions) if (action.edit) j.project.includeEdit(action.edit);
            const choices = Object.freeze(batch.actions.map((action, index): CodeActionChoice => Object.freeze({
                index, title: action.title, kind: action.kind, preferred: action.preferred, disabled: disabled(batch, action),
                needsResolve: action.resolve !== null, select: applyWhen => choose(id, index, applyWhen) })));
            publish({ ...empty, status: "ready", choices, message: choices.length ? "Choose an action to review." : "No actions for this range." });
            if (batch.actions[0]?.edit && !choices[0]!.disabled) choices[0]!.select();
            return done(choices);
        } catch (error) {
            if (pending) return requestFailed(pending, error);
            reportFailure(error);
            return failed(error);
        }
    }
    function request() {
        cancel();
        return discover();
    }
    const stopClient = client.subscribe(() => {
        if (job?.batch && (provider.getSnapshot().phase !== "ready" || cell.get().status !== "resolving" && !job.batch.isCurrent())) expire(job);
    });
    editor.onEditIntent(() => { if (job) cancel(); }, events.signal);
    function dispose(): void {
        if (disposed) return;
        scope.assertWritable(); cancel(); disposed = true; events.abort(); stopClient(); client.dispose();
        cell.clearSnapshotListeners();
    }
    editor.signal.addEventListener("abort", dispose, { once: true, signal: events.signal });
    return Object.freeze({ request, cancel, dispose, ...controllerObservable(cell, "Code action", () => disposed, scope) });
}
