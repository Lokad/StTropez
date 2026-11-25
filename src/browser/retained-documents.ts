import type { DocumentId, DocumentSnapshot, Workspace } from "../core/workspace.ts";
import { staleRequest } from "../protocol/wire.ts";
import type { LspDocumentSnapshot } from "../protocol/lsp-session.ts";
import { sameEditAuthority } from "./captured-view.ts";

export function observeProjectDocument(workspace: Workspace, expected: () => DocumentSnapshot,
    expire: () => void, stops: (() => void)[]) {
    const id = expected().id;
    const handle = workspace.observeDocument(id);
    const metadata = workspace.resourceForDocument(id).metadata;
    const permission = metadata.getSnapshot();
    const checkText = () => {
        const current = handle.getSnapshot();
        const doc = expected();
        if (current?.revision !== doc.revision || current.buffer !== doc.buffer) expire();
    };
    stops.push(handle.subscribe(checkText), metadata.subscribe(() => {
        if (!sameEditAuthority(permission, metadata.getSnapshot())) expire();
    }));
    checkText();
}

/** Keep the exact revisions and edit permissions used to interpret a provider reply. */
export function retainDocuments(workspace: Workspace, available: (id: DocumentId) => boolean, expire: () => void, retainedByView?: DocumentId) {
    const documents = new Map<DocumentId, DocumentSnapshot>(), stops: (() => void)[] = [];
    let disposed = false;
    function include(snapshot: DocumentSnapshot | LspDocumentSnapshot) {
        const id = "id" in snapshot ? snapshot.id : snapshot.documentId as DocumentId;
        const existing = documents.get(id);
        let live: DocumentSnapshot;
        try { live = existing ?? workspace.document(id); }
        catch { throw staleRequest(); }
        if (live.resourceId !== snapshot.resourceId || live.revision !== snapshot.revision
            || live.buffer !== snapshot.buffer || !available(id) || disposed) throw staleRequest();
        if (existing) return;
        const doc = "id" in snapshot ? snapshot : live;
        documents.set(doc.id, doc);
        if (doc.id === retainedByView) return;
        stops.push(workspace.acquire(doc.resourceId).release);
        // A command can advance this snapshot with its first edit before reviewing its next one.
        observeProjectDocument(workspace, () => documents.get(id)!, expire, stops);
    }
    function capture(source: DocumentSnapshot, others: readonly DocumentSnapshot[] = []) {
        include(source);
        for (const doc of others) include(doc);
    }
    function allows(options: { canCapture?: (id: DocumentId) => boolean }) {
        if (options.canCapture) {
            for (const id of documents.keys()) if (!options.canCapture(id)) return false;
        }
        return !disposed;
    }
    function dispose() {
        disposed = true;
        for (const stop of stops.splice(0)) stop();
        documents.clear();
    }
    return { documents, include, capture, allows, dispose };
}
