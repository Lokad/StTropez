import { emptyList } from "../core/empty-list.ts";
import { controllerObservable } from "./controller-observable.ts";
import { Store } from "../core/observable.ts";
import type { Observable } from "../core/observable.ts";
import { done, failed, refused, stale, type Outcome } from "../core/outcome.ts";
import type { DocumentId } from "../core/workspace.ts";
import { type LspActionResult, previewLspWorkspaceEdit } from "../protocol/index.ts";
import { actionClient } from "../protocol/lsp-actions.ts";
import type { LspDocumentOwner } from "../protocol/lsp-client.ts";
import { isStaleRequest } from "../protocol/wire.ts";
import type { LspCodeAction, LspCommandPolicy, LspPrepare, LspWorkspaceEditPreview } from "../protocol/index.ts";
import { captureEditCommand, commandTransaction, type CapturedCommand, type ChangedDocument, type LanguageCommandOptions } from "./language-command.ts";
import { writableEdit } from "./edit-project.ts";
import type { TextEditor } from "./text-editor.ts";

export type CodeActionChoice = Readonly<{
    index: number; title: string; kind: string | null; preferred: boolean; disabled: string | null; needsResolve: boolean;
    select: (applyWhen?: (resolved: LspCodeAction) => boolean) => void;
}>;
export type CodeActionPreview = Readonly<{
    index: number; title: string; command: string | null; disabled: string | null;
    canApply: boolean; readPage: (page?: number) => LspWorkspaceEditPreview | undefined; apply: () => Promise<Outcome<readonly ChangedDocument[]>>;
}>;
export type CodeActionSnapshot = Readonly<{
    status: "idle" | "pending" | "ready" | "resolving" | "executing" | "expired" | "failed" | "applied" | "executed";
    message: string; choices: readonly CodeActionChoice[]; choice: number | null;
    preview: CodeActionPreview | null; changes: readonly ChangedDocument[];
}>;
export type CodeActionControllerOptions = LanguageCommandOptions & Readonly<{
    prepareRequest?: LspPrepare; prepareResolve?: LspPrepare; commandPolicy?: LspCommandPolicy;
    canRunCommand?: () => boolean;
    onError?: (error: unknown) => void;
}>;

type Job = {
    capture: CapturedCommand;
    timer?: number; invalid: boolean; batch?: LspActionResult; selection?: LspCodeAction;
    failure?: Outcome<never>;
    changes?: Map<DocumentId, ChangedDocument>;
    resolving?: { index: number; applyWhen: ((action: LspCodeAction) => boolean) | undefined };
};
function afterEdits(reason: string, count?: number) {
    return count ? reason + " Earlier edits remain applied and undoable." : reason;
}
const empty: CodeActionSnapshot = Object.freeze({ status: "idle", message: "", choices: emptyList, choice: null, preview: null, changes: emptyList });
export type CodeActionController = Observable<CodeActionSnapshot> & Readonly<{
    request: () => Promise<Outcome<readonly CodeActionChoice[]>>; cancel: () => void; dispose: () => void;
}>;

/** One editor owns the request, lazy resolution and confirmation of its displayed preview. */
export function mountCodeActions(editor: TextEditor, owner: LspDocumentOwner, options: CodeActionControllerOptions): CodeActionController {
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
    const reportFailure = (error: unknown) => {
        publish({ ...empty, status: "failed", message: error instanceof Error ? error.message : String(error) });
        return failed(error);
    };
    const requestFailed = (j: Job, error: unknown): Outcome<never> => {
        if (j.failure) return j.failure;
        try {
            if (job !== j || j.invalid || isStaleRequest(error) || !j.capture.current()) {
                expire(j);
                return stale;
            }
        } catch (captureError) { error = captureError; }
        release();
        return j.failure = reportFailure(error);
    };
    const timeout = (j: Job) => {
        win.clearTimeout(j.timer);
        j.timer = win.setTimeout(() => requestFailed(j, new Error("Code action request timed out.")), 30000);
    };
    const disabled = (batch: LspActionResult, action: LspCodeAction) => action.disabled ?? (action.command
        ? !options.reviewCommandEdit || !batch.supports(action.command) ? "This command is unavailable." : null
        : !action.resolve && !action.edit?.documents.some(part => part.edits.length) ? "The provider returned no text changes." : null);
    async function apply(preview: CodeActionPreview): Promise<Outcome<readonly ChangedDocument[]>> {
        scope.assertWritable();
        const j = job, action = j?.selection, batch = j?.batch;
        if (cell.get().preview !== preview || !j || !action || !batch || !current(j)) return stale;
        if (disabled(batch, action) !== null) return refused("disabled");
        if (!writableEdit(editor, action.edit)) return refused("not-writable");
        if (action.command && (!client.getSnapshot().commandAvailable || options.canRunCommand?.() === false)) {
            publish({ ...cell.get(), message: "Another command is active. You can retry this preview." });
            return refused("command-unavailable");
        }
        const transaction = commandTransaction(editor, j.capture, () => current(j), options.reviewCommandEdit, !!action.command, scope, "code-action");
        const changed = j.changes = transaction.changes;
        let message = "Applied the reviewed edits.";
        let failure: Outcome<never> | undefined;
        try {
            if (action.command) {
                j.timer = win.setTimeout(() => expire(j), 120000);
                publish({ ...empty, status: "executing", message: "Executing the confirmed action." });
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
        if (!failure && !action.command && editor.element.isConnected && !editor.signal.aborted) {
            editor.viewport.revealOffset(view.getSnapshot().selection.head);
            editor.focus();
        }
        return failure ?? done(changes);
    }
    function makePreview(index: number, title: string, command: string | null, reason: string | null): CodeActionPreview {
        const preview: CodeActionPreview = Object.freeze({ index, title, command, disabled: reason, canApply: reason === null,
            readPage: (page = 0) => {
                const j = job;
                if (cell.get().preview !== preview || !j || !current(j)) return;
                const edit = j.selection?.edit;
                return edit ? previewLspWorkspaceEdit(edit, id => j.capture.project.documents.get(id as DocumentId)!.title, page)
                    : Object.freeze({ page, count: 0, notes: emptyList });
            },
            apply: () => apply(preview).catch(failed) });
        return preview;
    }
    function present(j: Job, index: number, action: LspCodeAction, applyWhen?: (action: LspCodeAction) => boolean): void {
        if (!j.batch || !current(j)) { expire(j); return; }
        j.selection = action;
        const reason = disabled(j.batch, action) ?? (writableEdit(editor, action.edit) ? null : "This action would edit a read-only or locked file.");
        const preview = makePreview(index, action.title, action.command?.command ?? null, reason);
        publish({ ...cell.get(), status: "ready", choice: index, preview, message: reason ?? "Review the selected action before confirming." });
        if (preview.canApply && cell.get().preview === preview && applyWhen?.(action)) void preview.apply();
    }
    function choose(source: AbortSignal, index: number, applyWhen?: (action: LspCodeAction) => boolean): void {
        scope.assertWritable();
        const j = job, batch = j?.batch, action = batch?.actions[index];
        if (!j || j.capture.first.signal !== source || !batch || !action || !current(j)) return;
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
            win.clearTimeout(j.timer); if (resolved.edit) j.capture.project.includeEdit(resolved.edit);
            present(j, index, resolved, choice.applyWhen);
            if (j.resolving === choice) delete j.resolving;
        }).catch(error => { if (job === j && j.resolving === choice) requestFailed(j, error); });
    }
    function cancel(): void {
        scope.assertWritable(); if (disposed) return;
        const applied = job?.changes?.size;
        finish("idle", applied ? afterEdits("Action command cancelled.", applied) : "");
    }
    async function discover(): Promise<Outcome<readonly CodeActionChoice[]>> {
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
            const choices = Object.freeze(batch.actions.map((action, index): CodeActionChoice => Object.freeze({
                index, title: action.title, kind: action.kind, preferred: action.preferred, disabled: disabled(batch, action),
                needsResolve: action.resolve !== null, select: applyWhen => choose(source, index, applyWhen) })));
            publish({ ...empty, status: "ready", choices, message: choices.length ? "Choose an action to review." : "No actions for this range." });
            if (batch.actions[0]?.edit && !choices[0]!.disabled) choices[0]!.select();
            return done(choices);
        } catch (error) {
            if (pending) return requestFailed(pending, error);
            return reportFailure(error);
        }
    }
    function request() {
        cancel();
        return discover();
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
    return Object.freeze({ request, cancel, dispose, ...controllerObservable(cell, "Code action", () => disposed, scope) });
}
