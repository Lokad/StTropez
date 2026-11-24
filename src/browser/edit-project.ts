import type { DocumentId } from "../core/workspace.ts";
import type { LspWorkspaceEdit } from "../protocol/lsp-features.ts";
import { retainDocuments } from "./retained-documents.ts";
import { staleRequest } from "../protocol/wire.ts";
import type { TextEditor } from "./text-editor.ts";

/** The view capture retains the origin. A preview also retains its project and any loaded edit targets. */
export function retainEditProject(editor: TextEditor, available: (id: DocumentId) => boolean, expire: () => void) {
    const { workspace, view } = editor, project = retainDocuments(workspace, available, expire, view.documentId);
    function includeEdit(edit: LspWorkspaceEdit) {
        for (const change of edit.documents) {
            if (!change.target.isCurrent()) throw staleRequest("A resolved edit target changed.");
            project.include(change.target.document);
        }
    }
    return { ...project, includeEdit };
}

export function writableEdit(editor: TextEditor, edit: LspWorkspaceEdit | null) {
    return (edit?.documents ?? []).every(change =>
        !change.edits.length || writableDocument(editor, change.target.document.documentId as DocumentId));
}

export function writableDocument(editor: TextEditor, document: DocumentId) {
    if (document === editor.view.documentId && editor.getSnapshot().readOnlyReason !== null) return false;
    const metadata = editor.workspace.resourceForDocument(document).metadata.getSnapshot();
    return metadata.editLock === null && metadata.capabilities.edit.includes("human") && metadata.capabilities.edit.includes("host");
}
