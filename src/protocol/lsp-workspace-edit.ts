import type { DocumentId, DocumentSnapshot, DocumentView, EditOrigin, EditRequest, Workspace } from "../core/workspace.ts";
import { RpcError } from "./json-rpc.ts";
import type { LspWorkspaceEdit } from "./lsp-features.ts";

export type LspWorkspaceEditOptions = Readonly<{
    origin: EditOrigin;
    /** Additional permissions required by the host, for example human approval of a host edit. */
    requiredOrigins?: readonly EditOrigin[];
    /** The captured originating view, if any. Other views still receive mapped selections. */
    view?: DocumentView;
}>;

/**
 * Apply a decoded, retained text-only edit as one shared undo command. Check host intent
 * (selection, lifecycle, approval) before calling. This synchronous helper owns no leases.
 * Throws on stale identities, malformed edits or refused authority, before any mutation.
 * Returns updated snapshots only for documents whose buffers changed; an empty edit succeeds.
 */
export function applyLspWorkspaceEdit(workspace: Workspace, edit: LspWorkspaceEdit, options: LspWorkspaceEditOptions): readonly DocumentSnapshot[] {
    if (!edit.isCurrent()) throw new RpcError(-32801, "LSP workspace edit capture expired.");
    if (options.view && !workspace.ownsDocumentView(options.view)) throw new Error("LSP edit view does not belong to this workspace.");
    const identities = new Set<DocumentId>(), before: DocumentSnapshot[] = [], requests: EditRequest[] = [];
    for (const change of edit.documents) {
        const target = change.target, captured = target.document, document = workspace.document(captured.documentId as DocumentId);
        if (!target.isCurrent() || target.index.buffer !== captured.buffer || document.resourceId !== captured.resourceId
            || document.revision !== captured.revision || document.buffer !== captured.buffer) {
            throw new RpcError(-32801, "LSP edit target differs from its captured working resource.");
        }
        if (identities.has(document.id)) throw new TypeError("An LSP edit must name each document once.");
        identities.add(document.id);
        if (!change.edits.length) continue;
        const metadata = workspace.resourceForDocument(document.id).metadata.getSnapshot();
        if (options.requiredOrigins?.some(origin => !metadata.capabilities.edit.includes(origin))) throw new Error("read-only");
        before.push(document);
        requests.push({ documentId: document.id, expectedRevision: document.revision, edits: change.edits, origin: options.origin,
            history: { kind: "replace" }, ...(options.view?.documentId === document.id ? { view: options.view } : {}) });
    }
    if (!requests.length) return Object.freeze([]);
    // The core validates every range, revision, permission, lock and view before publishing.
    const result = workspace.editDocuments(requests);
    if (!result.applied) throw new Error(result.reason);
    return Object.freeze(before.flatMap(document => {
        const current = workspace.document(document.id);
        return current.buffer === document.buffer ? [] : [current];
    }));
}

export type LspWorkspaceEditNote = Readonly<{
    document: string; resource: string; title: string; revision: number;
    from: number; to: number; before: string; insert: string; insertUnits: number; context: string;
}>;
export type LspWorkspaceEditPreview = Readonly<{ count: number; page: number; notes: readonly LspWorkspaceEditNote[] }>;

/**
 * Build a 64-edit review page from captured buffers, without exporting complete text or
 * materializing off-page edits. Titles come from the host's captured resource inventory.
 * Previewing does not establish currentness or grant edit authority.
 */
export function previewLspWorkspaceEdit(edit: LspWorkspaceEdit, title: (documentId: string) => string, page = 0): LspWorkspaceEditPreview {
    if (!Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger((page + 1) * 64)) throw new RangeError("Invalid LSP edit preview page.");
    const first = page * 64, last = first + 64, notes: LspWorkspaceEditNote[] = [];
    let count = 0;
    for (const change of edit.documents) {
        const from = Math.max(0, first - count), to = Math.min(change.edits.length, last - count);
        count += change.edits.length;
        if (from >= to) continue;
        const doc = change.target.document, label = title(doc.documentId).slice(0, 128);
        for (let i = from; i < to; i++) {
            const at = change.edits[i]!;
            notes.push(Object.freeze({ document: doc.documentId, resource: doc.resourceId, title: label, revision: doc.revision, from: at.from, to: at.to,
                before: doc.buffer.slice(at.from, Math.min(at.to, at.from + 256)) + (at.to - at.from > 256 ? "…" : ""),
                insert: at.insert.slice(0, 256), insertUnits: at.insert.length,
                context: doc.buffer.slice(Math.max(0, at.from - 32), Math.min(at.to, at.from + 128)) + (at.to - at.from > 128 ? "…" : "")
                    + doc.buffer.slice(at.to, Math.min(doc.buffer.length, at.to + 32)) }));
        }
    }
    return Object.freeze({ count, page, notes: Object.freeze(notes) });
}
