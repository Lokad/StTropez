import type { DocumentId, DocumentSnapshot, Workspace } from "../core/workspace.ts";
import { sameEditAuthority } from "./captured-view.ts";

/** Keep the exact revisions and edit permissions used to interpret a provider reply. */
export function retainDocuments(workspace: Workspace, available: (id: DocumentId) => boolean, expire: () => void, retainedByView?: DocumentId) {
    const documents = new Map<DocumentId, DocumentSnapshot>(), stops: (() => void)[] = [];
    function include(doc: DocumentSnapshot) {
        const existing = documents.get(doc.id), live = existing ?? workspace.document(doc.id);
        if (live.resourceId !== doc.resourceId || live.revision !== doc.revision || live.buffer !== doc.buffer || !available(doc.id)) {
            throw new Error("The captured document changed.");
        }
        if (existing) return;
        documents.set(doc.id, doc);
        if (doc.id === retainedByView) return;
        const handle = workspace.observeDocument(doc.id), metadata = workspace.resourceForDocument(doc.id).metadata;
        const permission = metadata.getSnapshot(), lease = workspace.acquire(doc.resourceId);
        stops.push(lease.release, handle.subscribe(() => {
            const next = handle.getSnapshot();
            if (next?.revision !== doc.revision || next.buffer !== doc.buffer) expire();
        }), metadata.subscribe(() => { if (!sameEditAuthority(permission, metadata.getSnapshot())) expire(); }));
    }
    return { documents, include, dispose() { for (const stop of stops.splice(0)) stop(); } };
}
