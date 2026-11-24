import { emptyList } from "../core/empty-list.ts";
import { languageReview } from "./language-review.ts";
import { changedTextEdits, changesText } from "../core/changes.ts";
import { done, failed, refused, stale, type Outcome } from "../core/outcome.ts";
import { changedDocument, type ChangedDocument } from "./language-command.ts";
import type { DocumentId, DocumentSnapshot } from "../core/workspace.ts";
import { renameClient, type LspRenameClient } from "../protocol/lsp-rename.ts";
import { isStaleRequest } from "../protocol/wire.ts";
import type { LspWorkspaceEdit } from "../protocol/lsp-features.ts";
import { applyLspWorkspaceEdit } from "../protocol/lsp-workspace-edit.ts";
import type { LspEditNotes } from "../protocol/lsp-workspace-edit.ts";
import type { LspDocumentOwner } from "../protocol/lsp-client.ts";
import type { LspPrepare } from "../protocol/lsp-workspace.ts";
import type { CapturedViewRequest } from "./captured-view.ts";
import { retainEditProject, writableEdit } from "./edit-project.ts";
import type { TextEditor } from "./text-editor.ts";

type Changes = readonly ChangedDocument[];

export type RenamePreview = Readonly<{
    name: string; canApply: boolean;
    readEdits: (first: number, end: number) => LspEditNotes | undefined;
    apply: () => Outcome<Changes>;
}>;
export type RenameSnapshot = Readonly<{
    status: "idle" | "pending" | "ready" | "expired" | "failed" | "applied" | "disposed";
    message: string; preview: RenamePreview | null; changes: Changes;
}>;
export type RenameControllerOptions = Readonly<{
    documents?: () => readonly DocumentSnapshot[]; canCapture?: (id: DocumentId) => boolean; prepareRequest?: () => LspPrepare | undefined;
}>;
export type RenameController = ReturnType<typeof mountRename>;
type Job = { source: CapturedViewRequest<TextEditor["tab"]>; project: ReturnType<typeof retainEditProject>;
    client: LspRenameClient; invalid: boolean; timer?: number; edit?: LspWorkspaceEdit; review?: LspWorkspaceEdit };
const idle: RenameSnapshot = Object.freeze({ status: "idle", message: "", preview: null, changes: emptyList });

/** Apply or review a rename at the captured caret across its project. */
export function mountRename(editor: TextEditor, owner: LspDocumentOwner, options: RenameControllerOptions) {
    const { workspace, view } = editor, win = editor.element.ownerDocument.defaultView!;
    const { scope, state: cell, signal, active, available, capture, release, expire, mount } =
        languageReview<Job, RenameSnapshot>(editor, "Rename", idle, options.canCapture,
            status => publish({ status, ...(status === "expired" && { message: "The captured source or target changed." }) }));
    const publish = (patch: Partial<RenameSnapshot>) => scope.publish(cell, Object.freeze({ ...idle, ...patch }));
    function current(j: Job) {
        if (active.job !== j || j.invalid || !j.source.isCurrent() || j.edit && !j.edit.isCurrent()) return false;
        if (options.canCapture) for (const id of j.project.documents.keys()) if (!options.canCapture(id)) return false;
        return true;
    }
    function reportFailure(error: unknown) {
        release();
        publish({ status: "failed", message: error instanceof Error ? error.message : "Rename failed." });
        return failed(error);
    }
    function refusalMessage(hasChanges: boolean) {
        return hasChanges ? "A rename target is read-only or locked." : "No edits for this name.";
    }
    function apply(j: Job, hasChanges: boolean, canApply = true): Outcome<Changes> {
        try {
            const edit = j.edit;
            if (!edit || !current(j)) {
                expire(j);
                return stale;
            }
            if (!canApply || !hasChanges || !writableEdit(editor, edit)) {
                if (!cell.get().preview) {
                    release();
                    publish({ message: refusalMessage(hasChanges) });
                }
                return refused(hasChanges ? "not-writable" : "no-changes");
            }
            let changes: Changes = emptyList;
            if (!j.source.commit(() => {
                const changed = applyLspWorkspaceEdit(workspace, edit, {
                    origin: "host", requiredOrigins: ["human"], source: "rename", historyKind: "refactor", view
                });
                changes = Object.freeze(changed.map(changedDocument));
                return true;
            })) {
                expire(j);
                return stale;
            }
            release();
            publish({ status: "applied", message: "Rename applied.", changes });
            return done(changes);
        } catch (error) {
            return active.job === j ? reportFailure(error) : stale;
        }
    }
    function makePreview(name: string, hasChanges: boolean, canApply: boolean): RenamePreview {
        // A retained button keeps the identity of its preview, never the project's old buffers.
        const preview: RenamePreview = Object.freeze({ name, canApply, readEdits(first, end) {
            const j = active.job;
            if (cell.get().preview !== preview || !j?.review || !current(j)) return;
            return j.project.readEdits(j.review, first, end);
        }, apply() {
            scope.assertWritable();
            const j = active.job;
            return j && cell.get().preview === preview ? apply(j, hasChanges, canApply) : stale;
        } });
        return preview;
    }
    async function prepare(name: string, review: boolean): Promise<Outcome<RenamePreview | Changes>> {
        if (signal.aborted) return stale;
        release();
        if (!name.length) {
            publish({ message: "Enter a new name." });
            return refused("empty-name");
        }
        let source: Job["source"] | undefined;
        let pending: Job | undefined;
        let timedOut = false;
        try {
            source = capture();
            if (!source) {
                publish({ status: "expired", message: "Finish pending input before requesting a rename." });
                return refused("unavailable-view");
            }
            const client = renameClient(owner);
            const j: Job = { source, client, project: retainEditProject(editor, available, () => expire(j)), invalid: false };
            active.job = pending = j;
            j.project.include(source.document);
            for (const doc of options.documents?.() ?? []) j.project.include(doc);
            source.signal.addEventListener("abort", () => expire(j), { once: true });
            j.timer = win.setTimeout(() => {
                timedOut = true;
                client.cancel();
            }, 30000);
            const offset = source.selectionSet.ranges[source.selectionSet.primary]!.head;
            publish({ status: "pending", message: "Requesting rename…" });
            const edit = await client.run({ document: source.document, project: [...j.project.documents.values()],
                offset, newName: name, prepare: options.prepareRequest?.() }).result;
            j.edit = edit;
            if (!current(j)) {
                expire(j);
                return stale;
            }
            win.clearTimeout(j.timer);
            j.project.includeEdit(edit);
            if (!review) {
                return apply(j, edit.documents.some(({ target, edits }) => edits.some(change => changesText(target.document.buffer, change))));
            }
            const documents = edit.documents.map(({ target, edits }) => ({ target, edits: changedTextEdits(target.document.buffer, edits) }));
            j.review = { ...edit, documents };
            const hasChanges = documents.some(part => part.edits.length);
            const canApply = hasChanges && writableEdit(editor, edit);
            const preview = makePreview(name, hasChanges, canApply);
            publish({ status: "ready", preview, message: canApply ? "Review the rename." : refusalMessage(hasChanges) });
            return done(preview);
        } catch (cause) {
            if (pending && pending !== active.job) return stale;
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
            return reportFailure(error);
        }
    }
    function request(name: string, options: Readonly<{ review: true }>): Promise<Outcome<RenamePreview>>;
    function request(name: string, options?: Readonly<{ review?: false }>): Promise<Outcome<Changes>>;
    function request(name: string, options: Readonly<{ review?: boolean }>): Promise<Outcome<RenamePreview | Changes>>;
    function request(name: string, options?: Readonly<{ review?: boolean }>) {
        scope.assertWritable();
        return prepare(name, options?.review === true);
    }
    const stop = owner.provider.subscribe(() => { const j = active.job; if (j?.edit && !j.edit.isCurrent()) expire(j); });
    const controls = mount(stop);
    return Object.freeze({ ...controls, request });
}
