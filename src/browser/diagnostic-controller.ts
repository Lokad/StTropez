import { Store } from "../core/observable.ts";
import type { Observable } from "../core/observable.ts";
import type { DecorationLayer } from "./decoration-layers.ts";
import { ownsTextSurface } from "../core/workspace.ts";
import type { LspDiagnostics, LspDiagnosticState, LspWorkspace } from "../protocol/index.ts";
import type { TextEditor } from "./text-editor.ts";

export type EditorDiagnostic = Readonly<{ from: number; to: number; message: string; select: () => boolean }>;
export type DiagnosticSnapshot = Readonly<{
    diagnostics: readonly EditorDiagnostic[]; diagnosticRevision: number; diagnosticsPending: boolean;
    unversionedDiagnostics: readonly string[];
}>;
export type DiagnosticControllerOptions = Readonly<{
    autoConnect?: boolean; canCapture?: () => boolean; onError?: (error: unknown) => void;
}>;
export type DiagnosticController = Observable<DiagnosticSnapshot> & Readonly<{
    request: () => void; cancel: () => void; dispose: () => void;
    getDiagnostics: () => Readonly<{ received: number; stale: number; invalid: number }>;
}>;

const empty: DiagnosticSnapshot = Object.freeze({ diagnostics: Object.freeze([]), diagnosticRevision: -1,
    diagnosticsPending: false, unversionedDiagnostics: Object.freeze([]) });

/** Displays pushed diagnostics for one view, including positions mapped while analysis is pending. */
export function createDiagnosticController(editor: TextEditor, provider: LspWorkspace, options: DiagnosticControllerOptions = {}): DiagnosticController {
    const { workspace, view, tab } = editor, documentId = view.documentId;
    if (editor.signal.aborted || !ownsTextSurface(workspace, view, tab)) throw new Error("Diagnostics require a live document view.");
    const scope = provider.createScope();
    let source: Observable<LspDiagnosticState>, layer: DecorationLayer;
    try {
        source = scope.observeDiagnostics(scope.attachDocument(documentId));
        layer = editor.decorations.add({ name: "diagnostics", order: 40 });
    } catch (error) { scope.dispose(); throw error; }
    const notifications = workspace.createNotificationScope(options.onError);
    const cell = new Store<DiagnosticSnapshot>(empty, notifications), observers = new Set<() => void>();
    let displayed: LspDiagnostics | null = null, disposed = false, stop: (() => void) | undefined;
    const available = () => !disposed && !editor.signal.aborted && editor.element.isConnected && ownsTextSurface(workspace, view, tab);
    const clear = () => {
        displayed = null;
        if (cell.get() !== empty) { layer.clear(); notifications.publish(cell, empty); }
    };
    const update = () => {
        const state = source.getSnapshot(), result = state.result;
        if (!stop || !result || !available() || !state.isPlacementCurrent()) { clear(); return; }
        if (result === displayed) return;
        displayed = result;
        const diagnostics: EditorDiagnostic[] = [], messages: string[] = [];
        for (const item of result.items) {
            const { from, to, message } = item;
            if (from === null || to === null) { messages.push(message + " (range outside the current snapshot)"); continue; }
            if (result.freshness === "unversioned") messages.push(message + " (provider version unknown)");
            const select = (): boolean => {
                notifications.assertWritable();
                const now = source.getSnapshot();
                if (!available() || displayed !== result || now.result !== result || !now.isPlacementCurrent()
                    || cell.get().diagnostics !== diagnostics || options.canCapture?.() === false) return false;
                return !!editor.reveal({ from, to }, { expectedRevision: result.snapshotRevision, select: true, focus: true });
            };
            const entry: EditorDiagnostic = Object.freeze({ from, to, message, select });
            diagnostics.push(entry);
        }
        layer.set(result.snapshotRevision, diagnostics.map(({ from, to }) => ({ from, to, className: "st-diagnostic" })));
        notifications.publish(cell, Object.freeze({ diagnostics: Object.freeze(diagnostics), diagnosticRevision: result.snapshotRevision,
            diagnosticsPending: state.status === "pending", unversionedDiagnostics: Object.freeze(messages) }));
    };
    const request = () => {
        notifications.assertWritable();
        if (disposed || stop) return;
        stop = source.subscribe(update); update();
        if (options.autoConnect !== false) void scope.ensureConnected().catch(error => { if (!disposed) options.onError?.(error); });
    };
    const cancel = () => {
        notifications.assertWritable();
        stop?.(); stop = undefined; clear();
    };
    const releaseFeature = provider.retainFeatures("textDocument/publishDiagnostics");
    const stopTabs = tab ? workspace.tabs.subscribe(() => { if (!available()) clear(); }) : undefined;
    const dispose = () => {
        if (disposed) return;
        notifications.assertWritable(); disposed = true;
        editor.signal.removeEventListener("abort", dispose);
        releaseFeature(); cancel(); stopTabs?.(); layer.dispose(); scope.dispose();
        for (const release of observers) release();
    };
    try { request(); } catch (error) { dispose(); throw error; }
    editor.signal.addEventListener("abort", dispose, { once: true });
    return Object.freeze({ getSnapshot: cell.observable.getSnapshot, subscribe(listener: () => void) {
        notifications.assertWritable(); if (disposed) throw new Error("Diagnostic controller is disposed.");
        const unsubscribe = cell.observable.subscribe(listener);
        const release = () => { unsubscribe(); observers.delete(release); }; observers.add(release); return release;
    }, request, cancel, dispose, getDiagnostics: () => {
        const { received, stale, invalid } = source.getSnapshot();
        return Object.freeze({ received, stale, invalid });
    } });
}
