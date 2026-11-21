import { Workspace } from "sttropez";
import type { Selection, TabId, TextResourceHandle } from "sttropez";
import { createFindController, createRegexFindBackend, mountTextEditor } from "sttropez/browser";
import type { TextEditor, FindController, ViewState } from "sttropez/browser";

/** Loaded only by an explicit host action; model/history outlive individual DOM attachments. */
export function createActivationSession(original: string, selection: Selection, shared?: Readonly<{ workspace: Workspace; source: TextResourceHandle; tab: () => TabId | undefined; label?: string; focus?: boolean }>) {
    const workspace = shared?.workspace ?? new Workspace(), source = shared?.source ?? workspace.createTextResource({ scope: "activation", resource: "source", variant: "working" }, "Source", { value: original });
    const ownTab = shared ? undefined : workspace.tabs.open({ kind: "text", documentId: source.documentId }, "source"), view = workspace.createDocumentView(source.documentId, selection), history = workspace.observeHistory(source.documentId);
    let editor: TextEditor | undefined, find: FindController | undefined, stopFind: (() => void) | undefined, viewState: ViewState | undefined;
    let disposed = false, mounts = 0, workers = 0;
    const busy = () => { const s = editor?.snapshot(); return !!s && (s.composing || s.pendingInput || s.pendingCommand || s.pendingWord || s.pendingGrapheme || s.pendingDragScroll); };
    const unmount = () => { if (busy()) return false; stopFind?.(); stopFind = undefined; find?.dispose(); find = undefined;
        if (editor) { viewState = editor.captureView(); editor.dispose(); editor = undefined; } return true; };
    return Object.freeze({
        mount: (host: HTMLElement, selection: Selection | undefined, update: (message: string) => void, readOnly = false) => {
            if (disposed || editor) throw new Error("Source session is unavailable.");
            const tab = shared ? shared.tab() : ownTab!;
            if (!tab) throw new Error("Source tab is closed.");
            const current = view.getSnapshot().selection;
            const changed = selection && (selection.anchor !== current.anchor || selection.head !== current.head);
            if (changed) view.setSelection(workspace.document(source.documentId).revision, selection);
            editor = mountTextEditor(host, workspace, tab, { ariaLabel: shared?.label ?? "Activated source", view, readOnly }); mounts++;
            if (viewState) editor.restoreView({ ...viewState, ...view.getSnapshot().selection, selectionSet: view.getSnapshot().selectionSet });
            if (changed || !viewState) editor.viewport.revealOffset(view.getSnapshot().selection.head);
            find = createFindController(editor, { regularExpressionBackend: createRegexFindBackend({ clock: host.ownerDocument.defaultView!,
                createWorker: () => { workers++; return new Worker(new URL("./regex-worker.js", import.meta.url), { type: "module" }); } }) });
            stopFind = find.subscribe(() => { const s = find!.getSnapshot(); update(s.message || `${s.status}: ${s.count} matches`); });
            if (shared?.focus !== false) editor.input.focus({ preventScroll: true });
        },
        unmount,
        canUnmount: () => !busy(),
        search: (query: string, regex: boolean) => { find?.setFlags({ regularExpression: regex }); find?.setQuery(query); },
        next: () => find?.next(),
        select: (ranges: readonly Selection[], primary = 0) => view.setSelections(workspace.document(source.documentId).revision, ranges, primary),
        selection: () => view.getSnapshot().selection,
        text: () => { const b = workspace.document(source.documentId).buffer; return b.slice(0, b.length); },
        snapshot: () => ({ resourceId: source.id, documentId: source.documentId, viewId: view.id, revision: source.getSnapshot().revision, selections: view.getSnapshot().selectionSet,
            tab: workspace.tabs.getSnapshot().find(tab => tab.id === (shared ? shared.tab() : ownTab)) ?? null, readOnly: editor?.input.readOnly ?? null,
            history: history.getSnapshot(), diagnostics: workspace.diagnostics(), mounts, workers, disposed,
            input: editor?.snapshot() ?? null, viewport: editor?.viewport.snapshot() ?? null, find: find?.getSnapshot() ?? null,
            exports: disposed ? 0 : workspace.document(source.documentId).buffer.readMetrics().textExports }),
        dispose: () => { if (!disposed) { stopFind?.(); stopFind = undefined; find?.dispose(); editor?.dispose(); editor = undefined; find = undefined; view.dispose();
            if (!shared) { workspace.tabs.close(ownTab!); workspace.releaseResource(source.id, true); } disposed = true; } return workspace.diagnostics(); },
    });
}
export type ActivationSession = ReturnType<typeof createActivationSession>;
