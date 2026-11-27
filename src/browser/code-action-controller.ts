import { emptyList } from "../core/empty-list.ts";
import { controllerObservable } from "./controller-observable.ts";
import { Store } from "../core/observable.ts";
import type { Observable } from "../core/observable.ts";
import { done, failed, refused, stale, type Outcome } from "../core/outcome.ts";
import type { DocumentId } from "../core/workspace.ts";
import { actionClient, type LspActionResult } from "../protocol/lsp-actions.ts";
import type { LspDocumentOwner } from "../protocol/lsp-client.ts";
import { isStaleRequest } from "../protocol/wire.ts";
import type { LspCodeAction, LspCommandPolicy, LspPrepare, LspEditNotes } from "../protocol/index.ts";
import { captureEditCommand, commandTransaction, type CapturedCommand, type ChangedDocument, type CommandEditReviewer, type LanguageCommandOptions } from "./language-command.ts";
import { writableEdit } from "./edit-project.ts";
import type { TextEditor } from "./text-editor.ts";

import { mountCodeActionPopup, type CodeActionPopupOptions } from "./code-action-popup.ts";

type Changes = readonly ChangedDocument[];
type SelectionResult = Outcome<CodeActionPreview | Changes>;
export type CodeActionChoice = ReturnType<typeof actionChoice>;
export type CodeActionPreview = Readonly<{
    title: string; command: string | null; disabled: string | null;
    canApply: boolean; readEdits: (first: number, end: number) => LspEditNotes | undefined; apply: () => Promise<Outcome<readonly ChangedDocument[]>>;
}>;
export type CodeActionSnapshot = Readonly<{
    status: "idle" | "pending" | "ready" | "resolving" | "executing" | "expired" | "failed" | "applied" | "executed";
    message: string; choices: readonly CodeActionChoice[]; choice: number | null;
    preview: CodeActionPreview | null; changes: readonly ChangedDocument[];
}>;
export type CodeActionControllerOptions = LanguageCommandOptions & Readonly<{
    popup?: boolean | CodeActionPopupOptions;
    prepareRequest?: LspPrepare; prepareResolve?: LspPrepare; commandPolicy?: LspCommandPolicy;
    canRunCommand?: () => boolean;
    onError?: (error: unknown) => void;
}>;

type Job = {
    capture: CapturedCommand;
    timer?: number; invalid: boolean; batch?: LspActionResult; selection?: LspCodeAction;
    failure?: Outcome<never>;
    changes?: Map<DocumentId, ChangedDocument>;
    resolving?: { index: number; finish: (resolved?: LspCodeAction) => void };
};
function actionChoice(action: LspCodeAction, index: number, disabled: string | null, choose: (review: boolean) => Promise<SelectionResult>) {
    function select(options: Readonly<{ review: true }>): Promise<Outcome<CodeActionPreview>>;
    function select(options?: Readonly<{ review?: false }>): Promise<Outcome<Changes>>;
    function select(options: Readonly<{ review?: boolean }>): Promise<SelectionResult>;
    function select(options?: Readonly<{ review?: boolean }>) {
        return choose(options?.review === true).catch(failed);
    }
    return Object.freeze({ index, title: action.title, kind: action.kind, preferred: action.preferred, disabled,
        needsResolve: action.resolve !== null, select });
}
function afterEdits(reason: string, count?: number) {
    return count ? reason + " Earlier edits remain applied and undoable." : reason;
}
const empty: CodeActionSnapshot = Object.freeze({ status: "idle", message: "", choices: emptyList, choice: null, preview: null, changes: emptyList });
export type CodeActionController = Observable<CodeActionSnapshot> & Readonly<{
    request: () => Promise<Outcome<readonly CodeActionChoice[]>>; cancel: () => void; dispose: () => void;
}>;

/** Resolve and apply each choice against the editor that requested it. */
export function mountCodeActions(editor: TextEditor, owner: LspDocumentOwner, options: CodeActionControllerOptions,
    reviewEdit?: CommandEditReviewer): CodeActionController {
    const { workspace, view } = editor, win = editor.element.ownerDocument.defaultView!;
    const scope = workspace.createNotificationScope(options.onError), cell = new Store(empty, scope);
    const client = actionClient(owner, options), events = new AbortController();
    let job: Job | undefined, disposed = false;
    const publish = (state: CodeActionSnapshot) => scope.publish(cell, Object.freeze(state));
    function current(j: Job): boolean {
        return job === j && !j.invalid && j.capture.current()
            && (!j.batch || (j.changes ? j.batch.commandCurrent() : j.batch.isCurrent()));
    }
    const release = () => {
        const previous = job; job = undefined;
        if (!previous) return;
        win.clearTimeout(previous.timer);
        previous.resolving?.finish();
        previous.capture.dispose();
        client.cancel();
    };
    function finish(status: CodeActionSnapshot["status"], message: string) {
        const changes = job?.changes ? Object.freeze([...job.changes.values()]) : emptyList;
        release();
        publish({ ...empty, status, changes, message });
        return changes;
    }
    const expire = (j: Job) => {
        if (job !== j || j.invalid) return;
        j.invalid = true;
        // Lease release is a workspace write. Complete it after the notifying edit.
        queueMicrotask(() => {
            if (job === j) finish("expired", afterEdits("The captured source or provider changed.", j.changes?.size));
        });
    };
    const requestFailed = (j: Job | undefined, error: unknown): Outcome<never> => {
        if (j?.failure) return j.failure;
        if (j) {
            try {
                if (job !== j || j.invalid || isStaleRequest(error) || !j.capture.current()) {
                    expire(j);
                    return stale;
                }
            } catch (captureError) { error = captureError; }
        }
        const outcome = failed(error);
        if (j) j.failure = outcome;
        finish("failed", error instanceof Error ? error.message : String(error));
        return outcome;
    };
    const timeout = (j: Job) => {
        win.clearTimeout(j.timer);
        j.timer = win.setTimeout(() => requestFailed(j, new Error("Code action request timed out.")), 30000);
    };
    const disabled = (batch: LspActionResult, action: LspCodeAction) => action.disabled ?? (action.command
        ? !reviewEdit || !batch.supports(action.command) ? "This command is unavailable." : null
        : !action.resolve && !action.edit?.documents.some(part => part.edits.length) ? "The provider returned no text changes." : null);
    async function apply(j: Job | undefined, index: number, preview: CodeActionPreview | null): Promise<Outcome<Changes>> {
        scope.assertWritable();
        const action = j?.selection, batch = j?.batch, state = cell.get();
        if (state.status !== "ready" || state.choice !== index || state.preview !== preview) return stale;
        if (!j || !action || !batch || !current(j)) return stale;
        if (disabled(batch, action) !== null) return refused("disabled");
        if (!writableEdit(editor, action.edit)) return refused("not-writable");
        if (action.command && (!client.getSnapshot().commandAvailable || options.canRunCommand?.() === false)) {
            publish({ ...cell.get(), message: "Another command is active. Try again." });
            return refused("command-unavailable");
        }
        const transaction = commandTransaction(editor, j.capture, () => current(j), reviewEdit, !!action.command, scope, "code-action");
        const changed = j.changes = transaction.changes;
        let message = "Applied the edits.";
        let failure: Outcome<never> | undefined;
        try {
            if (action.command) {
                j.timer = win.setTimeout(() => expire(j), 120000);
                publish({ ...empty, status: "executing", message: "Executing the action." });
                const receipt = await batch.execute(action, {
                    ...transaction.scope,
                    prepare: () => { if (action.edit) transaction.write(action.edit); }
                });
                if (!current(j)) {
                    expire(j);
                    return stale;
                }
                if (receipt.decision?.applied === false) {
                    message = receipt.decision.failureReason ?? "Provider edits declined.";
                    failure = refused(message);
                } else message = typeof receipt.value === "string" ? receipt.value : "Command completed.";
            } else if (action.edit) transaction.write(action.edit);
        } catch (error) {
            if (job !== j || j.invalid) return stale;
            message = error instanceof Error ? error.message : String(error);
            failure = isStaleRequest(error) ? stale : failed(error);
        }
        const status = failure ? "failed" : !action.command || changed.size ? "applied" : "executed";
        const changes = finish(status, failure ? afterEdits(message, changed.size) : message);
        if (!failure && !action.command && editor.element.isConnected && editor.getSnapshot().focused) {
            editor.viewport.revealOffset(view.getSnapshot().selection.head);
        }
        return failure ?? done(changes);
    }
    function makePreview(index: number, title: string, command: string | null, reason: string | null): CodeActionPreview {
        const preview: CodeActionPreview = Object.freeze({ title, command, disabled: reason, canApply: reason === null,
            readEdits: (first, end) => {
                const j = job;
                if (cell.get().preview !== preview || !j || !current(j)) return;
                return j.capture.project.readEdits(j.selection!.edit, first, end);
            },
            apply: () => apply(job, index, preview).catch(failed) });
        return preview;
    }
    async function present(j: Job, index: number, action: LspCodeAction, review: boolean): Promise<SelectionResult> {
        if (!current(j)) return stale;
        j.selection = action;
        const reason = disabled(j.batch!, action)
            ?? (writableEdit(editor, action.edit) ? null : "This action would edit a read-only or locked file.");
        const preview = review ? makePreview(index, action.title, action.command?.command ?? null, reason) : null;
        publish({ ...cell.get(), status: "ready", choice: index, preview, message: reason ?? (review ? "Review the action before applying it." : "") });
        if (!preview) return apply(j, index, null);
        return cell.get().preview === preview ? done(preview) : stale;
    }
    async function choose(source: AbortSignal, index: number, review: boolean): Promise<SelectionResult> {
        scope.assertWritable();
        const j = job, batch = j?.batch, action = batch?.actions[index];
        const status = cell.get().status;
        if (!j || j.capture.first.signal !== source || !batch || !action || !current(j)
            || (status !== "ready" && status !== "resolving")) return stale;
        const previous = j.resolving;
        previous?.finish();
        if (previous?.index !== index) {
            delete j.resolving;
            win.clearTimeout(j.timer);
            batch.cancelResolve();
        }
        if (!action.resolve) return present(j, index, action, review);
        return new Promise<SelectionResult>(settle => {
            const finish = (resolved?: LspCodeAction) => settle(resolved
                ? present(j, index, resolved, review) : j.failure ?? stale);
            if (j.resolving) {
                j.resolving.finish = finish;
                return;
            }
            const choice = j.resolving = { index, finish };
            publish({ ...cell.get(), status: "resolving", choice: index, preview: null, message: "Resolving the selected action." });
            timeout(j);
            void batch.resolve(action, options.prepareResolve).then(resolved => {
                if (job !== j || j.resolving !== choice) return;
                if (!current(j)) { expire(j); return; }
                win.clearTimeout(j.timer);
                if (resolved.edit) j.capture.project.includeEdit(resolved.edit);
                delete j.resolving;
                choice.finish(resolved);
            }).catch(error => { if (job === j && j.resolving === choice) requestFailed(j, error); });
        });
    }
    function cancel(): void {
        scope.assertWritable(); if (disposed) return;
        const applied = job?.changes?.size;
        finish("idle", applied ? afterEdits("Action command cancelled.", applied) : "");
    }
    async function request(): Promise<Outcome<readonly CodeActionChoice[]>> {
        cancel();
        if (disposed) return stale;
        let pending: Job | undefined;
        try {
            const capture = captureEditCommand(editor, options, () => { if (pending) expire(pending); });
            if (!capture) {
                publish({ ...empty, status: "expired", message: "Finish the current editor operation before requesting actions." });
                return refused("unavailable-view");
            }
            const source = capture.first.signal;
            const j: Job = { capture, invalid: false };
            job = pending = j;
            capture.collectDocuments();
            const { document, selectionSet } = capture.first;
            const range = selectionSet.ranges[selectionSet.primary]!;
            timeout(j);
            publish({ ...empty, status: "pending", message: "Requesting code actions." });
            const batch = await client.run({ document, project: [...j.capture.project.documents.values()],
                from: Math.min(range.anchor, range.head), to: Math.max(range.anchor, range.head),
                prepare: options.prepareRequest }).result;
            j.batch = batch;
            if (!current(j)) {
                expire(j);
                return stale;
            }
            win.clearTimeout(j.timer);
            for (const action of batch.actions) if (action.edit) j.capture.project.includeEdit(action.edit);
            const choices = Object.freeze(batch.actions.map((action, index) =>
                actionChoice(action, index, disabled(batch, action), review => choose(source, index, review))));
            const available = choices.some(choice => choice.disabled === null);
            publish({ ...empty, status: "ready", choices,
                message: available ? "Choose an action." : "No available actions for this range." });
            return done(choices);
        } catch (error) {
            return requestFailed(pending, error);
        }
    }
    const stopClient = client.subscribe(() => {
        if (job?.batch && (job.resolving ? client.getSnapshot().phase !== "ready" : !current(job))) expire(job);
    });
    editor.onEditIntent(() => { if (job) cancel(); }, events.signal);
    function dispose(): void {
        if (disposed) return;
        scope.assertWritable(); cancel(); disposed = true; events.abort(); stopClient(); client.dispose();
        cell.clearSnapshotListeners();
    }
    const controller = Object.freeze({ request, cancel, dispose, ...controllerObservable(cell, "Code action", () => disposed, scope) });
    try {
        if (options.popup) mountCodeActionPopup(editor, owner, controller, events.signal, options.popup === true ? {} : options.popup);
        return controller;
    } catch (error) { dispose(); throw error; }
}
