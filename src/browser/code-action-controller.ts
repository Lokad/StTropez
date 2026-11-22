import { Store } from "../core/observable.ts";
import type { Observable } from "../core/observable.ts";
import { ownsTextSurface } from "../core/workspace.ts";
import type { DocumentId, DocumentSnapshot, TabTarget } from "../core/workspace.ts";
import { RpcError, applyLspWorkspaceEdit, createLspActionClient, previewLspWorkspaceEdit } from "../protocol/index.ts";
import type { LspCodeAction, LspCommandPolicy, LspCommandReceipt, LspCommandScope, LspPrepare, LspWorkspace, LspWorkspaceEdit, LspWorkspaceEditPreview } from "../protocol/index.ts";
import { captureViewRequest } from "./captured-view.ts";
import type { CapturedViewRequest } from "./captured-view.ts";
import { retainEditProject, writableEdit } from "./edit-project.ts";
import type { TextEditor } from "./text-editor.ts";

export type CodeActionChoice = Readonly<{
    index: number; title: string; kind: string | null; preferred: boolean; disabled: string | null; needsResolve: boolean;
    select: (applyWhen?: (resolved: LspCodeAction) => boolean) => void;
}>;
export type CodeActionPreview = Readonly<{
    index: number; title: string; command: string | null; disabled: string | null;
    canApply: boolean; readPage: (page?: number) => LspWorkspaceEditPreview | undefined; confirm: () => void;
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
type Client = ReturnType<typeof createLspActionClient>;
type Batch = Awaited<ReturnType<Client["run"]>["result"]>;
type Job = {
    id: number; capture: CapturedViewRequest<TabTarget | undefined>; project: ReturnType<typeof retainEditProject>;
    timer?: number; invalid: boolean; batch?: Batch; selection?: LspCodeAction;
};
const empty: CodeActionSnapshot = Object.freeze({ status: "idle", message: "", choices: Object.freeze([]), choice: null, preview: null, changes: Object.freeze([]) });
export type CodeActionController = Observable<CodeActionSnapshot> & Readonly<{
    request: () => void; cancel: () => void; dispose: () => void;
}>;

/** One editor owns the request, lazy resolution and confirmation of its displayed preview. */
export function createCodeActionController(editor: TextEditor, provider: LspWorkspace, options: CodeActionControllerOptions = {}): CodeActionController {
    const { workspace, view, tab } = editor, win = editor.element.ownerDocument.defaultView!;
    if (editor.signal.aborted || !ownsTextSurface(workspace, view, tab)) throw new Error("Code actions require a live document view.");
    const scope = workspace.createNotificationScope(options.onError), cell = new Store(empty, scope), observers = new Set<() => void>();
    const client = createLspActionClient(provider, options), events = new AbortController();
    let job: Job | undefined, execution: CodeActionExecution | undefined, disposed = false;
    const available = (id: DocumentId) => {
        const a = editor.activity();
        return !disposed && editor.element.isConnected && !a.disposed && !a.composing && !a.pendingInput && !a.pendingCommand
            && !a.pendingGrapheme && !a.pendingWord && !editor.input.disabled && (options.canCapture?.(id) ?? true);
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
    const fail = (j: Job, error: unknown) => {
        if (job !== j) return;
        if (j.invalid || !j.capture.isCurrent() || error instanceof RpcError && (error.code === -32800 || error.code === -32801)) { expire(j); return; }
        release(); publish({ ...empty, status: "failed", message: error instanceof Error ? error.message : "Code action failed." });
    };
    const timeout = (j: Job) => {
        win.clearTimeout(j.timer);
        j.timer = win.setTimeout(() => fail(j, new Error("Code action request timed out.")), 30000);
    };
    const disabled = (batch: Batch, action: LspCodeAction) => action.disabled ?? (action.command
        ? !options.runCommand || !batch.supports(action.command) ? "This command is unavailable." : null
        : !action.resolve && !action.edit?.documents.some(part => part.edits.length) ? "The provider returned no text changes." : null);
    function confirm(): void {
        const j = job, action = j?.selection, batch = j?.batch;
        if (!j || !action || !batch || !current(j) || disabled(batch, action) || !writableEdit(workspace, action.edit)) return;
        if (action.command) {
            try {
                const handle = options.runCommand?.({ documents: Object.freeze([...j.project.documents.values()]), edit: action.edit,
                    isCurrent: batch.commandCurrent, subscribe: client.subscribe, execute: s => batch.execute(action, s),
                    cancel: () => { if (batch.commandCurrent()) client.cancel(); } });
                if (!handle) return;
                execution = handle; release(true); publish({ ...empty, status: "executing", message: "Executing the confirmed action." });
                void handle.result.then(receipt => {
                    if (execution !== handle) return;
                    execution = undefined; client.cancel();
                    publish({ ...empty, status: receipt.success ? receipt.applied ? "applied" : "executed" : "failed", message: receipt.reason,
                        changes: Object.freeze(receipt.changes.map(change => Object.freeze({ ...change }))) });
                }, error => {
                    if (execution !== handle) return;
                    execution = undefined; client.cancel(); publish({ ...empty, status: "failed", message: String(error) });
                });
            } catch (error) { fail(j, error); }
            return;
        }
        try {
            let changes: readonly ChangedDocument[] = [];
            if (!j.capture.commit(() => {
                changes = applyLspWorkspaceEdit(workspace, action.edit!, { origin: "host", requiredOrigins: ["human"], source: "code-action", historyKind: "refactor", view })
                    .map(doc => Object.freeze({ document: doc.id, title: doc.title }));
                return true;
            })) { expire(j); return; }
            release(); publish({ ...empty, status: "applied", message: "Applied the reviewed edits.", changes: Object.freeze(changes) });
            if (editor.element.isConnected && !editor.signal.aborted) { editor.viewport.revealOffset(view.getSnapshot().selection.head); editor.focus(); }
        } catch (error) { fail(j, error); }
    }
    function makePreview(index: number, title: string, command: string | null, reason: string | null, canApply: boolean): CodeActionPreview {
        const preview: CodeActionPreview = Object.freeze({ index, title, command, disabled: reason, canApply,
            readPage: (page = 0) => {
                const j = job;
                if (cell.get().preview !== preview || !j || !current(j)) return;
                const edit = j.selection?.edit;
                return edit ? previewLspWorkspaceEdit(edit, id => j.project.documents.get(id as DocumentId)!.title, page)
                    : Object.freeze({ page, count: 0, notes: Object.freeze([]) });
            },
            confirm: () => { scope.assertWritable(); if (cell.get().preview === preview) confirm(); } });
        return preview;
    }
    function present(j: Job, index: number, action: LspCodeAction, applyWhen?: (action: LspCodeAction) => boolean): void {
        if (!j.batch || !current(j)) { expire(j); return; }
        j.selection = action;
        const reason = disabled(j.batch, action);
        const preview = makePreview(index, action.title, action.command?.command ?? null, reason, !reason && writableEdit(workspace, action.edit));
        publish({ ...cell.get(), status: "ready", choice: index, preview, message: reason ?? "Review the selected action before confirming." });
        if (!reason && applyWhen?.(action)) preview.confirm();
    }
    function choose(id: number, index: number, applyWhen?: (action: LspCodeAction) => boolean): void {
        scope.assertWritable();
        const j = job, batch = j?.batch, action = batch?.actions[index];
        if (!j || j.id !== id || !batch || !action || cell.get().status !== "ready" || !current(j)) return;
        if (!action.resolve || disabled(batch, action)) { present(j, index, action, applyWhen); return; }
        publish({ ...cell.get(), status: "resolving", choice: index, preview: null, message: "Resolving the selected action." });
        timeout(j);
        void batch.resolve(action, options.prepareResolve).then(resolved => {
            if (!current(j)) { expire(j); return; }
            win.clearTimeout(j.timer); if (resolved.edit) j.project.includeEdit(resolved.edit); present(j, index, resolved, applyWhen);
        }).catch(error => fail(j, error));
    }
    function cancel(): void {
        scope.assertWritable(); if (disposed) return;
        const previous = execution; execution = undefined;
        const applied = previous?.cancel().applied;
        if (previous) client.cancel();
        release(); publish(applied ? { ...empty, message: "Action command cancelled after application. Its edits remain undoable." } : empty);
    }
    function request(): void {
        scope.assertWritable(); if (disposed) return;
        cancel();
        const capture = captureViewRequest(workspace, tab, view, { available: () => available(view.documentId) });
        if (!capture) { publish({ ...empty, status: "expired", message: "Finish the current editor operation before requesting actions." }); return; }
        const id = workspace.allocateIdentity();
        const j: Job = { id, capture, project: retainEditProject(editor, available, () => expire(j)), invalid: false }; job = j;
        try {
            j.project.include(capture.document);
            for (const doc of options.documents?.() ?? []) j.project.include(doc);
            capture.signal.addEventListener("abort", () => expire(j), { once: true });
            const range = capture.selectionSet.ranges[capture.selectionSet.primary]!;
            timeout(j); publish({ ...empty, status: "pending", message: "Requesting code actions." });
            void client.run({ document: capture.document, project: [...j.project.documents.values()], from: Math.min(range.anchor, range.head), to: Math.max(range.anchor, range.head), prepare: options.prepareRequest }).result.then(batch => {
                j.batch = batch;
                if (!current(j)) { expire(j); return; }
                win.clearTimeout(j.timer); for (const action of batch.actions) if (action.edit) j.project.includeEdit(action.edit);
                const choices = Object.freeze(batch.actions.map((action, index): CodeActionChoice => Object.freeze({ index, title: action.title, kind: action.kind,
                    preferred: action.preferred, disabled: disabled(batch, action), needsResolve: action.resolve !== null,
                    select: applyWhen => choose(id, index, applyWhen) })));
                publish({ ...empty, status: "ready", choices, message: choices.length ? "Choose an action to review." : "No actions for this range." });
                if (batch.actions[0]?.edit && !choices[0]!.disabled) choices[0]!.select();
            }).catch(error => fail(j, error));
        } catch (error) { fail(j, error); }
    }
    const stopClient = client.subscribe(() => {
        if (job?.batch && (provider.getSnapshot().phase !== "ready" || cell.get().status !== "resolving" && !job.batch.isCurrent())) expire(job);
    });
    for (const event of ["beforeinput", "compositionstart", "paste", "cut"] as const) editor.input.addEventListener(event, () => { if (job) cancel(); }, { signal: events.signal });
    function dispose(): void {
        if (disposed) return;
        scope.assertWritable(); cancel(); disposed = true; events.abort(); stopClient(); client.dispose();
        for (const stop of observers) stop();
    }
    editor.signal.addEventListener("abort", dispose, { once: true, signal: events.signal });
    return Object.freeze({ request, cancel, dispose, getSnapshot: cell.observable.getSnapshot, subscribe(listener: () => void) {
        scope.assertWritable(); if (disposed) throw new Error("Code action controller is disposed.");
        const unsubscribe = cell.observable.subscribe(listener);
        const stop = () => { unsubscribe(); observers.delete(stop); }; observers.add(stop); return stop;
    } });
}
