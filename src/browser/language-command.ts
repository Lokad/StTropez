import { onAbort } from "./listen.ts";
import { emptyList } from "../core/empty-list.ts";
import { Store, type Observable, type NotificationScope } from "../core/observable.ts";
import { done, failed, refused, stale, type Outcome } from "../core/outcome.ts";
import type { DocumentId, DocumentSnapshot } from "../core/workspace.ts";
import { applyLspWorkspaceEdit } from "../protocol/lsp-workspace-edit.ts";
import { commandRunner, type LspCommandScope } from "../protocol/lsp-command.ts";
import type { LspDocumentOwner } from "../protocol/lsp-client.ts";
import type { LspApplyEdit, LspWorkspaceEdit } from "../protocol/lsp-features.ts";
import type { LspDocument, LspRequestContext } from "../protocol/lsp-session.ts";
import { isStaleRequest, staleRequest, type JsonValue } from "../protocol/wire.ts";
import { captureRequest, editorReadyForRequest } from "./captured-view.ts";
import { retainEditProject, writableEdit } from "./edit-project.ts";
import { controllerObservable } from "./controller-observable.ts";
import type { TextEditor } from "./text-editor.ts";

export type ChangedDocument = Readonly<{ document: DocumentId; title: string }>;

export function changedDocument(doc: DocumentSnapshot): ChangedDocument {
    return Object.freeze({ document: doc.id, title: doc.title });
}

export type LanguageCommandOptions = Readonly<{
    documents?: () => readonly DocumentSnapshot[];
    canCapture?: (id: DocumentId) => boolean;
    reviewCommandEdit?: (request: LspApplyEdit, context: LspRequestContext, writable: boolean) => boolean | Promise<boolean>;
}>;
export type LanguageCommands = Observable<readonly ChangedDocument[]> & Readonly<{
    run: (name: string, args?: readonly JsonValue[]) => Promise<Outcome<readonly ChangedDocument[]>>;
    cancel: () => void;
    dispose: () => void;
}>;

/** Retain the requesting view and its exact edit targets until the caller releases the operation. */
export function captureEditCommand(editor: TextEditor, options: LanguageCommandOptions, expire: () => void, selectionBound = true) {
    const { view } = editor;
    function available(id: DocumentId) {
        return editorReadyForRequest(editor) && (options.canCapture?.(id) ?? true);
    }
    const capture = () => captureRequest(editor, { available: () => available(view.documentId) }, selectionBound);
    const first = capture();
    if (!first) return;
    let source = first;
    let valid = true;
    function invalidate() {
        if (!valid) return;
        valid = false;
        expire();
    }
    function watch(next: typeof source) {
        source = next;
        onAbort(next.signal, () => { if (source === next) invalidate(); });
    }
    const project = retainEditProject(editor, available, invalidate);
    function dispose() {
        valid = false;
        project.dispose();
        source.cancel();
    }
    watch(first);
    return {
        first, project, dispose,
        collectDocuments() {
            project.capture(first.document, options.documents?.());
        },
        current() {
            return valid && source.isCurrent() && project.allows(options);
        },
        renew() {
            const previous = source;
            const next = capture();
            if (next) watch(next);
            else invalidate();
            previous.cancel();
        }
    };
}

export type CapturedCommand = NonNullable<ReturnType<typeof captureEditCommand>>;

export function commandTransaction(editor: TextEditor, captured: CapturedCommand, isCurrent: () => boolean,
    reviewEdit: LanguageCommandOptions["reviewCommandEdit"], renew: boolean, notifications: NotificationScope,
    source: "code-action" | "server-command",
    changed?: (changes: readonly ChangedDocument[]) => void) {
    const { workspace, view } = editor;
    const changes = new Map<DocumentId, ChangedDocument>();
    function write(edit: LspWorkspaceEdit) {
        if (!isCurrent() || !writableEdit(editor, edit)) throw staleRequest();
        notifications.batch(() => {
            const documents = applyLspWorkspaceEdit(workspace, edit, {
                origin: "host", requiredOrigins: ["human"], source, historyKind: "refactor", view
            });
            for (const doc of documents) {
                captured.project.documents.set(doc.id, doc);
                changes.set(doc.id, changedDocument(doc));
            }
            if (renew && documents.some(doc => doc.id === view.documentId)) captured.renew();
            if (documents.length) changed?.(Object.freeze([...changes.values()]));
        });
    }
    const scope: LspCommandScope = {
        isCurrent,
        snapshots: () => [...captured.project.documents.values()],
        async review(request, context) {
            captured.project.includeEdit(request.edit);
            const writable = writableEdit(editor, request.edit);
            if (!reviewEdit || !context.isCurrent()) return { applied: false };
            let stop!: () => void;
            const cancelled = new Promise<boolean>(resolve => { stop = context.onCancel(() => resolve(false)); });
            try {
                if (!await Promise.race([reviewEdit(request, context, writable), cancelled]) || !context.isCurrent()) {
                    return { applied: false };
                }
                if (!writable) return { applied: false, failureReason: "not-writable" };
                write(request.edit);
                return { applied: true };
            } finally { stop(); }
        }
    };
    return { write, changes, scope };
}

export function mountLanguageCommands(editor: TextEditor, owner: LspDocumentOwner, options: LanguageCommandOptions): LanguageCommands {
    const events = new AbortController();
    const scope = editor.workspace.createNotificationScope();
    const changes = new Store<readonly ChangedDocument[]>(emptyList, scope);
    const publish = (next: readonly ChangedDocument[]) => scope.publish(changes, next);
    let active: CapturedCommand | undefined;
    let bindings: ReadonlyMap<string, LspDocument> = new Map();
    const runner = commandRunner(owner.scope, undefined, snapshots => bindings = owner.replace(bindings, snapshots));
    function cancel() {
        const captured = active;
        if (!captured) return;
        scope.assertWritable();
        active = undefined;
        runner.cancel();
        captured.dispose();
        owner.release(bindings);
        bindings = new Map();
    }
    async function run(name: string, args: readonly JsonValue[] = []): Promise<Outcome<readonly ChangedDocument[]>> {
        if (events.signal.aborted) return stale;
        if (active || !owner.scope.getSnapshot().commandAvailable || !owner.scope.commandNames().includes(name)) {
            return refused("command-unavailable");
        }
        let captured: CapturedCommand | undefined;
        try {
            captured = captureEditCommand(editor, options, () => queueMicrotask(() => {
                if (captured && active === captured) cancel();
            }), false);
            if (!captured) return refused("unavailable-view");
            active = captured;
            captured.collectDocuments();
            publish(emptyList);
            const transaction = commandTransaction(editor, captured, captured.current, options.reviewCommandEdit, true, scope, "server-command", publish);
            const receipt = await runner.run(name, args, transaction.scope);
            if (!captured.current()) return stale;
            if (receipt.decision?.applied === false) return refused(receipt.decision.failureReason ?? "declined");
            return done(changes.get());
        } catch (error) {
            return (captured && captured !== active) || isStaleRequest(error) ? stale : failed(error);
        } finally {
            if (captured && active === captured) cancel();
        }
    }
    editor.onEditIntent(cancel, events.signal);
    return Object.freeze({ ...controllerObservable(changes, "Command", () => events.signal.aborted, scope), run, cancel, dispose() {
        if (events.signal.aborted) return;
        scope.assertWritable();
        events.abort();
        cancel();
        runner.dispose();
        changes.clearSnapshotListeners();
    } });
}
