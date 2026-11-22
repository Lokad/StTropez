import type { DocumentId } from "../core/workspace.ts";
import type { LspWorkspaceEdit } from "../protocol/lsp-features.ts";
import { retainDocuments } from "./retained-documents.ts";
import type { TextEditor } from "./text-editor.ts";

/** The view capture retains the origin. A preview also retains its project and any loaded edit targets. */
export function retainEditProject(editor: TextEditor, available: (id: DocumentId) => boolean, expire: () => void) {
    const { workspace, view } = editor, project = retainDocuments(workspace, available, expire, view.documentId);
    function includeEdit(edit: LspWorkspaceEdit) {
        for (const change of edit.documents) {
            const target = change.target.document, doc = workspace.document(target.documentId as DocumentId);
            if (doc.resourceId !== target.resourceId || doc.revision !== target.revision || doc.buffer !== target.buffer || !change.target.isCurrent()) {
                throw new Error("A resolved edit target changed.");
            }
            project.include(doc);
        }
    }
    return { ...project, includeEdit };
}

export function writableEdit(editor: TextEditor, edit: LspWorkspaceEdit | null) {
    return (edit?.documents ?? []).every(change => {
        if (!change.edits.length) return true;
        const document = change.target.document.documentId as DocumentId;
        if (document === editor.view.documentId && editor.getSnapshot().readOnlyReason) return false;
        const metadata = editor.workspace.resourceForDocument(document).metadata.getSnapshot();
        return metadata.capabilities.edit.includes("human") && metadata.capabilities.edit.includes("host") && metadata.editLock === null;
    });
}
