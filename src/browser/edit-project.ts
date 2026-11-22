import type { DocumentId, DocumentSnapshot, Workspace } from "../core/workspace.ts";
import type { LspWorkspaceEdit } from "../protocol/lsp-features.ts";
import { sameEditAuthority } from "./captured-view.ts";
import type { TextEditor } from "./text-editor.ts";

/** The view capture retains the origin. A preview also retains its project and any loaded edit targets. */
export function retainEditProject(editor: TextEditor, available: (id: DocumentId) => boolean, expire: () => void) {
    const { workspace, view } = editor, documents = new Map<DocumentId, DocumentSnapshot>(), stops: (() => void)[] = [];
    function include(doc: DocumentSnapshot) {
        const existing = documents.get(doc.id), live = existing ?? workspace.document(doc.id);
        if (live.resourceId !== doc.resourceId || live.revision !== doc.revision || live.buffer !== doc.buffer || !available(doc.id)) {
            throw new Error("The captured edit target changed.");
        }
        if (existing) return;
        documents.set(doc.id, doc);
        if (doc.id === view.documentId) return;
        const handle = workspace.observeDocument(doc.id), metadata = workspace.resourceForDocument(doc.id).metadata;
        const permission = metadata.getSnapshot(), lease = workspace.acquire(doc.resourceId);
        stops.push(lease.release, handle.subscribe(() => {
            const next = handle.getSnapshot();
            if (next?.revision !== doc.revision || next.buffer !== doc.buffer) expire();
        }), metadata.subscribe(() => { if (!sameEditAuthority(permission, metadata.getSnapshot())) expire(); }));
    }
    function includeEdit(edit: LspWorkspaceEdit) {
        for (const change of edit.documents) {
            const target = change.target.document, doc = workspace.document(target.documentId as DocumentId);
            if (doc.resourceId !== target.resourceId || doc.revision !== target.revision || doc.buffer !== target.buffer || !change.target.isCurrent()) {
                throw new Error("A resolved edit target changed.");
            }
            include(doc);
        }
    }
    return { documents, include, includeEdit, dispose() { for (const stop of stops.splice(0)) stop(); } };
}

export function writableEdit(workspace: Workspace, edit: LspWorkspaceEdit | null) {
    return (edit?.documents ?? []).every(change => {
        if (!change.edits.length) return true;
        const metadata = workspace.resourceForDocument(change.target.document.documentId as DocumentId).metadata.getSnapshot();
        return metadata.capabilities.edit.includes("human") && metadata.capabilities.edit.includes("host") && metadata.editLock === null;
    });
}
