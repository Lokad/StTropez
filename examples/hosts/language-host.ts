import type { DocumentId, TabTarget, Workspace } from "../../src/index.ts";
import type { TextEditor } from "../../src/browser/index.ts";

export type ChangedFile = Readonly<{ document: DocumentId; title: string }>;

export type LanguageHost = Readonly<{
    workspace: Workspace;
    canCapture: (id: DocumentId) => boolean;
    present: (id: DocumentId) => TextEditor | undefined;
    reconnect?: () => void;
}>;

export const unavailablePaneMessage = "Show a source pane or finish its pending input, then try again.";

export function isMountedEditor(workspace: Workspace, editor: TextEditor, target = editor.tab): boolean {
    return editor.element.isConnected && !editor.activity().disposed && workspace.ownsDocumentView(editor.view, target)
        && !!workspace.observeDocument(editor.view.documentId).getSnapshot();
}

/** The requesting pane wins when several panes show the same document. */
export function captureDestinationPanes<S extends { editor: TextEditor; target?: TabTarget }>(
    origin: S, sessions: Iterable<S>, documents: ReadonlySet<DocumentId>,
) {
    const panes = new Map([[origin.editor.view.documentId, origin]]);
    for (const pane of sessions) {
        const id = pane.editor.view.documentId;
        if (documents.has(id) && !panes.has(id) && isMountedEditor(origin.editor.workspace, pane.editor, pane.target)) panes.set(id, pane);
    }
    return panes;
}

export function presentDocument(host: LanguageHost, id: DocumentId, sessions: Iterable<{ editor: TextEditor }>): TextEditor | undefined {
    const live = (editor: TextEditor) => editor.view.documentId === id && isMountedEditor(host.workspace, editor);
    for (const { editor } of sessions) if (live(editor)) return editor;
    const editor = host.present(id);
    return editor && live(editor) ? editor : undefined;
}

/** A completed edit identifies a document. Resolve its current editor when the user opens it. */
export function openChangedFile(
    host: LanguageHost, id: DocumentId, sessions: Iterable<{ editor: TextEditor }>, focus = (editor: TextEditor) => editor.focus(),
): string {
    let title: string;
    try { title = host.workspace.document(id).title; }
    catch { return "The changed file is no longer available."; }
    try {
        if (!host.canCapture(id)) return "Finish the current edit before opening the changed file.";
        const editor = presentDocument(host, id, sessions);
        if (!editor) return unavailablePaneMessage;
        focus(editor);
        return `Opened ${title}.`;
    } catch {
        return `The host could not open ${title}.`;
    }
}
