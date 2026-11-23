import type { DocumentId, TabTarget, Workspace } from "../../src/index.ts";
import type { TextEditor } from "../../src/browser/index.ts";
import { createNavigationHistory } from "../../src/browser/index.ts";
import { focusSource, focusSourceCaret } from "./source-focus.ts";
import { HostCell } from "../shared/observable.ts";

export type ChangedFile = Readonly<{ document: DocumentId; title: string }>;

export type LanguageHost = Readonly<{
    workspace: Workspace;
    canCapture: (id: DocumentId) => boolean;
    present: (id: DocumentId) => TextEditor | undefined;
    reconnect?: () => void;
}>;

/** A later destination request owns focus even if its result is empty or fails. */
export function createNavigationHost(host: LanguageHost) {
    let latest = 0;
    type Kind = "symbols" | "modules";
    let active: Kind = "symbols";
    const status = new HostCell("Focus a source to look up a symbol or module.");
    function report(kind: Kind, message: string) {
        if (kind === active && status.get() !== message) status.set(message);
    }
    const history = createNavigationHistory(host.workspace);
    // The link panel has a targeted Return. Track opaque visit identities so it never pops a newer symbol jump.
    const visits = new HostCell<readonly symbol[]>([]);
    function capture(editor: TextEditor) {
        const point = history.capture(editor); if (!point) return;
        const key = Symbol();
        return {
            isNext: () => visits.get().at(-1) === key,
            recorded: () => visits.get().includes(key),
            visit(open: () => boolean) {
                const opened = point.visit(open), depth = history.getSnapshot();
                if (opened && depth && host.workspace.ownsDocumentView(editor.view, editor.tab) && visits.get().at(-1) !== key)
                    visits.set([...visits.get(), key].slice(-depth));
                return opened;
            },
        };
    }
    function back(panes: Iterable<{ editor: TextEditor }>) {
        let origin: TextEditor | undefined;
        const result = history.back(view => {
            if (!host.canCapture(view.documentId)) return "busy";
            for (const { editor } of panes) if (editor.view === view && isMountedEditor(host.workspace, editor)) {
                origin = editor; return editor;
            }
            return undefined;
        });
        const depth = history.getSnapshot();
        if (visits.get().length !== depth) visits.set(visits.get().slice(0, depth));
        if (result === "restored" && origin) focusSource(origin);
        return result;
    }
    return { ...host, history: { capture, getSnapshot: history.getSnapshot, subscribe: visits.observable.subscribe,
        dispose() { history.dispose(); visits.set([]); } }, back, locationStatus: status.observable, report, claimNavigationFocus(kind: Kind) {
        active = kind;
        const request = ++latest;
        return () => request === latest;
    } };
}
export type NavigationHost = ReturnType<typeof createNavigationHost>;
export type HostLocation = NonNullable<ReturnType<NavigationHost["history"]["capture"]>>;

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
    host: LanguageHost, id: DocumentId, sessions: Iterable<{ editor: TextEditor }>,
): string {
    let title: string;
    try { title = host.workspace.document(id).title; }
    catch { return "The changed file is no longer available."; }
    try {
        if (!host.canCapture(id)) return "Finish the current edit before opening the changed file.";
        const editor = presentDocument(host, id, sessions);
        if (!editor) return unavailablePaneMessage;
        focusSourceCaret(editor);
        return `Opened ${title}.`;
    } catch {
        return `The host could not open ${title}.`;
    }
}
