import type { DocumentId, TextBuffer, Workspace } from "../../src/index.ts";
import type { LspDocument, LspSession } from "../../src/protocol/index.ts";

/** Refresh only explicitly captured working resources; connection and request lifetime stay with the caller. */
export function updateLspProject(workspace: Workspace, session: LspSession, documents: Map<string, LspDocument>,
    input: readonly Readonly<{ document: string; revision: number; length: number }>[], buffers: ReadonlyMap<string, TextBuffer>, uriFor: (id: DocumentId) => string): void {
    const ids = new Set(input.map(doc => doc.document)), uris = new Set<string>();
    if (ids.size !== input.length) throw new Error("An LSP project cannot repeat document identities.");
    const snapshots = input.map(doc => {
        const buffer = buffers.get(doc.document), resource = workspace.resourceForDocument(doc.document as DocumentId);
        if (!buffer || buffer.length !== doc.length || workspace.document(doc.document as DocumentId).key.variant !== "working") throw new Error("LSP buffer is outside its captured working scope.");
        const uri = uriFor(doc.document as DocumentId); if (uris.has(uri)) throw new Error("LSP host URI mapping must be unique."); uris.add(uri);
        return { uri, languageId: "fixture", resourceId: resource.id, documentId: doc.document, revision: doc.revision, buffer };
    });
    for (const [id, document] of documents) if (!ids.has(id) || !snapshots.some(snapshot => snapshot.documentId === id && snapshot.resourceId === document.getSnapshot().resourceId && snapshot.uri === document.getSnapshot().uri)) { document.close(); documents.delete(id); }
    // Shrink before growing, so a valid final project does not fail a transient total-size bound.
    snapshots.sort((a, b) => (a.buffer.length - (documents.get(a.documentId)?.getSnapshot().buffer.length ?? 0)) - (b.buffer.length - (documents.get(b.documentId)?.getSnapshot().buffer.length ?? 0)));
    for (const snapshot of snapshots) {
        const document = documents.get(snapshot.documentId);
        if (!document) documents.set(snapshot.documentId, session.bindDocument(snapshot));
        else if (document.getSnapshot().revision !== snapshot.revision) document.update(document.getSnapshot().revision, snapshot.revision, snapshot.buffer);
        else if (document.getSnapshot().buffer !== snapshot.buffer) throw new Error("An LSP revision cannot name different buffers.");
    }
}
export function captureLspProject(session: LspSession, documents: ReadonlyMap<string, LspDocument>) {
    return new Map([...documents.values()].map(document => { const captured = session.synchronized(document); if (!captured) throw new Error("LSP project synchronization is incomplete."); return [captured.document.uri, captured] as const; }));
}
