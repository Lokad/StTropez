import type { DocumentId, DocumentSnapshot, Workspace } from "../core/workspace.ts";
import { staleRequest } from "../protocol/wire.ts";
import type { LspDocumentSnapshot } from "../protocol/lsp-session.ts";
import { sameEditAuthority } from "./captured-view.ts";

/** Keep the exact revisions and edit permissions used to interpret a provider reply. */
export function retainDocuments(workspace: Workspace, available: (id: DocumentId) => boolean, expire: () => void, retainedByView?: DocumentId) {
    const documents = new Map<DocumentId, DocumentSnapshot>(), stops: (() => void)[] = [];
    function include(snapshot: DocumentSnapshot | LspDocumentSnapshot) {
        const id = "id" in snapshot ? snapshot.id : snapshot.documentId as DocumentId;
        const existing = documents.get(id);
        let live: DocumentSnapshot;
        try { live = existing ?? workspace.document(id); }
        catch { throw staleRequest("The captured document was released."); }
        if (live.resourceId !== snapshot.resourceId || live.revision !== snapshot.revision
            || live.buffer !== snapshot.buffer || !available(id)) throw staleRequest("The captured document changed.");
        if (existing) return;
        const doc = "id" in snapshot ? snapshot : live;
        documents.set(doc.id, doc);
        if (doc.id === retainedByView) return;
        const handle = workspace.observeDocument(doc.id), metadata = workspace.resourceForDocument(doc.id).metadata;
        const permission = metadata.getSnapshot(), lease = workspace.acquire(doc.resourceId);
        stops.push(lease.release, handle.subscribe(() => {
            const next = handle.getSnapshot();
            const expected = documents.get(id)!;
            if (next?.revision !== expected.revision || next.buffer !== expected.buffer) expire();
        }), metadata.subscribe(() => { if (!sameEditAuthority(permission, metadata.getSnapshot())) expire(); }));
    }
    return { documents, include, dispose() { for (const stop of stops.splice(0)) stop(); } };
}
