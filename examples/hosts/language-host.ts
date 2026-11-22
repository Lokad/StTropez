import type { DocumentId, Workspace } from "../../src/index.ts";
import type { TextEditor } from "../../src/browser/index.ts";

export type LanguageHost = Readonly<{
    workspace: Workspace;
    canCapture: (id: DocumentId) => boolean;
    present: (id: DocumentId) => TextEditor | undefined;
    reconnect?: () => void;
}>;

/** A completed edit identifies a document. Resolve its current editor when the user opens it. */
export function openChangedFile(
    host: LanguageHost, id: DocumentId, sessions: Iterable<{ editor: TextEditor }>, focus = (editor: TextEditor) => editor.focus(),
): string {
    let title: string;
    try { title = host.workspace.document(id).title; }
    catch { return "The changed file is no longer available."; }
    try {
        if (!host.canCapture(id)) return "Finish the current edit before opening the changed file.";
        const live = (editor: TextEditor) => editor.view.documentId === id && !editor.signal.aborted
            && editor.element.isConnected && host.workspace.ownsDocumentView(editor.view, editor.tab);
        const editor = [...sessions].find(session => live(session.editor))?.editor ?? host.present(id);
        if (!editor || !live(editor)) return "Show a source pane or finish its pending input, then try again.";
        focus(editor);
        return `Opened ${title}.`;
    } catch {
        return `The host could not open ${title}.`;
    }
}
