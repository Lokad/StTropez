import type { DocumentId, TextBuffer, Workspace } from "../../src/index.ts";
import type { LspDocument, LspWorkspaceScope } from "../../src/protocol/index.ts";

/** Refresh only explicitly captured working resources; connection and request lifetime stay with the caller. */
export function updateLspProject(workspace: Workspace, session: LspWorkspaceScope, documents: Map<string, LspDocument>,
    input: readonly Readonly<{ document: string; revision: number; length: number }>[], buffers: ReadonlyMap<string, TextBuffer>): void {
    const snapshots = input.map(doc => {
        const buffer = buffers.get(doc.document), current = workspace.document(doc.document as DocumentId);
        if (!buffer || current.revision !== doc.revision || current.buffer !== buffer || buffer.length !== doc.length || current.key.variant !== "working") throw new Error("LSP buffer is outside its captured working scope.");
        return current;
    });
    const bound = session.setDocuments(snapshots); documents.clear(); for (const [id, document] of bound) documents.set(id, document);
}
export function captureLspProject(session: LspWorkspaceScope, _documents: ReadonlyMap<string, LspDocument>) {
    return session.captureProject();
}
