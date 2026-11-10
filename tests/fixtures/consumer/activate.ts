import { Workspace } from "sttropez";
import type { Selection } from "sttropez";
import { createFindController, createRegexFindBackend, mountEditingCandidate } from "sttropez/browser";
import type { EditingCandidate, FindController, ViewState } from "sttropez/browser";

/** Loaded only by an explicit host action; model/history outlive individual DOM attachments. */
export function createActivationSession(original: string, selection: Selection) {
    const workspace = new Workspace(), source = workspace.createTextResource({ scope: "activation", resource: "source", variant: "working" }, "Source", { value: original });
    const tab = workspace.open({ kind: "text", documentId: source.documentId }, "source"), view = workspace.createDocumentView(source.documentId, selection), history = workspace.observeHistory(source.documentId);
    let editor: EditingCandidate | undefined, find: FindController | undefined, stopFind: (() => void) | undefined, viewState: ViewState | undefined;
    let disposed = false, mounts = 0, workers = 0;
    const busy = () => { const s = editor?.snapshot(); return !!s && (s.composing || s.pendingInput || s.pendingCommand || s.pendingWord || s.pendingGrapheme || s.pendingDragScroll); };
    const unmount = () => { if (busy()) return false; stopFind?.(); stopFind = undefined; find?.destroy(); find = undefined;
        if (editor) { viewState = editor.captureView(); editor.destroy(); editor = undefined; } return true; };
    return Object.freeze({
        mount: (host: HTMLElement, selection: Selection | undefined, update: (message: string) => void) => {
            if (disposed || editor) throw new Error("Source session is unavailable.");
            const current = view.getSnapshot().selection;
            const changed = selection && (selection.anchor !== current.anchor || selection.head !== current.head);
            if (changed) view.setSelection(workspace.document(source.documentId).revision, selection);
            editor = mountEditingCandidate(host, workspace, tab, { ariaLabel: "Activated source", view }); mounts++;
            if (viewState) editor.restoreView({ ...viewState, ...view.getSnapshot().selection, selectionSet: view.getSnapshot().selectionSet });
            if (changed || !viewState) editor.viewport.revealOffset(view.getSnapshot().selection.head);
            find = createFindController(workspace, tab, editor, { regularExpression: createRegexFindBackend({ clock: host.ownerDocument.defaultView!,
                createWorker: () => { workers++; return new Worker(new URL("./regex-worker.js", import.meta.url), { type: "module" }); } }) });
            stopFind = find.state.subscribe(() => { const s = find!.state.getSnapshot(); update(s.message || `${s.status}: ${s.count} matches`); });
            editor.input.focus({ preventScroll: true });
        },
        unmount,
        search: (query: string, regex: boolean) => { find?.setOptions({ regularExpression: regex }); find?.setQuery(query); },
        next: () => find?.next(),
        select: (ranges: readonly Selection[], primary = 0) => view.setSelections(workspace.document(source.documentId).revision, ranges, primary),
        selection: () => view.getSnapshot().selection,
        text: () => { const b = workspace.document(source.documentId).buffer; return b.slice(0, b.length); },
        snapshot: () => ({ resourceId: source.id, documentId: source.documentId, revision: source.getSnapshot().revision, selections: view.getSnapshot().selectionSet,
            history: history.getSnapshot(), diagnostics: workspace.diagnostics(), mounts, workers, disposed,
            input: editor?.snapshot() ?? null, viewport: editor?.viewport.snapshot() ?? null, find: find?.state.getSnapshot() ?? null,
            exports: disposed ? 0 : workspace.document(source.documentId).buffer.readMetrics().textExports }),
        dispose: () => { if (!disposed) { stopFind?.(); find?.destroy(); editor?.destroy(); editor = undefined; find = undefined; view.dispose(); workspace.close(tab); workspace.releaseResource(source.id, true); disposed = true; } return workspace.diagnostics(); },
    });
}
export type ActivationSession = ReturnType<typeof createActivationSession>;
