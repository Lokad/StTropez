import { emptyList } from "../core/empty-list.ts";
import { isOffsetRange } from "../core/bounds.ts";
import { wireLimits, staleRequest } from "./wire.ts";
import type { DocumentId, DocumentSnapshot, DocumentView, EditOrigin, EditRequest, Workspace } from "../core/workspace.ts";
import type { EditKind } from "../core/history.ts";
import type { TextEdit } from "../core/changes.ts";
import type { LspWorkspaceEdit } from "./lsp-features.ts";
import type { LspDocumentSnapshot } from "./lsp-session.ts";

export type LspWorkspaceEditOptions = Readonly<{
    origin: EditOrigin;
    source?: string;
    /** Additional permissions required by the host, for example human approval of a host edit. */
    requiredOrigins?: readonly EditOrigin[];
    /** The captured originating view, if any. Other views still receive mapped selections. */
    view?: DocumentView;
    /** One shared history command with this kind; defaults to replace. No typing-group merge. */
    historyKind?: EditKind;
}>;

/**
 * Apply a decoded, retained text-only edit as one shared undo command. Check host intent
 * (selection, lifecycle, approval) before calling. This synchronous helper owns no leases.
 * Throws on stale identities, malformed edits or refused authority, before any mutation.
 * Returns updated snapshots only for documents whose buffers changed; an empty edit succeeds.
 */
export function applyLspWorkspaceEdit(workspace: Workspace, edit: LspWorkspaceEdit, {
    origin, source, requiredOrigins, view, historyKind = "replace",
}: LspWorkspaceEditOptions): readonly DocumentSnapshot[] {
    if (!edit.isCurrent()) throw staleRequest();
    if (view && !workspace.ownsDocumentView(view)) throw new Error("LSP edit view does not belong to this workspace.");
    const identities = new Set<DocumentId>();
    const requests: EditRequest[] = [];
    for (const { target, edits } of edit.documents) {
        const captured = target.document;
        const document = workspace.document(captured.documentId as DocumentId);
        if (!target.isCurrent() || target.index.buffer !== captured.buffer || document.resourceId !== captured.resourceId
            || document.revision !== captured.revision || document.buffer !== captured.buffer) {
            throw staleRequest();
        }
        if (identities.has(document.id)) throw new TypeError("An LSP edit must name each document once.");
        identities.add(document.id);
        if (!edits.length) continue;
        const metadata = workspace.resourceForDocument(document.id).metadata.getSnapshot();
        if (requiredOrigins?.some(required => !metadata.capabilities.edit.includes(required))) throw new Error("read-only");
        requests.push({ documentId: document.id, expectedRevision: document.revision, edits, origin,
            ...(source === undefined ? {} : { source }), history: { kind: historyKind },
            ...(view?.documentId === document.id ? { view } : {}) });
    }
    if (!requests.length) return emptyList;
    // The core validates every range, revision, permission, lock and view before publishing.
    const result = workspace.editDocuments(requests);
    if (!result.applied) throw new Error(result.reason);
    return Object.freeze(result.revisions.flatMap(({ documentId, revision }, i) => {
        return revision === requests[i]!.expectedRevision ? [] : [workspace.document(documentId)];
    }));
}

export type LspWorkspaceEditNote = Readonly<{
    document: string; resource: string; title: string; revision: number;
    from: number; to: number; before: string; insert: string; insertUnits: number; context: string;
}>;
export type LspEditNotes = Readonly<{ total: number; notes: readonly LspWorkspaceEditNote[] }>;

export function describeLspEdit(source: Pick<LspDocumentSnapshot, "buffer" | "resourceId" | "revision">, document: string, title: string, edit: TextEdit): LspWorkspaceEditNote {
    const { from, to, insert } = edit, { buffer } = source;
    return Object.freeze({
        document, resource: source.resourceId, title: title.slice(0, wireLimits.previewLabelUnits), revision: source.revision, from, to,
        before: buffer.slice(from, Math.min(to, from + 256)) + (to - from > 256 ? "…" : ""),
        insert: insert.slice(0, 256), insertUnits: insert.length,
        context: buffer.slice(Math.max(0, from - 32), Math.min(to, from + wireLimits.previewContextUnits)) + (to - from > wireLimits.previewContextUnits ? "…" : "")
            + buffer.slice(to, Math.min(buffer.length, to + 32)),
    });
}

/** Read notes for [first, end) across the edit's documents in provider order. */
export function readLspEditNotes(edit: LspWorkspaceEdit | null, title: (documentId: string) => string,
    first: number, end: number): LspEditNotes {
    if (!isOffsetRange(first, end)) throw new RangeError("Invalid edit note range.");
    const notes: LspWorkspaceEditNote[] = [];
    let count = 0;
    for (const change of edit?.documents ?? emptyList) {
        const from = Math.max(0, first - count), to = Math.min(change.edits.length, end - count);
        count += change.edits.length;
        if (from >= to) continue;
        const doc = change.target.document, label = title(doc.documentId);
        for (let i = from; i < to; i++) notes.push(describeLspEdit(doc, doc.documentId, label, change.edits[i]!));
    }
    return Object.freeze({ total: count, notes: Object.freeze(notes) });
}
