import { isMountedEditor } from "./captured-view.ts";
import { emptyList } from "../core/empty-list.ts";
import type { LspDocumentOwner } from "../protocol/lsp-client.ts";
import { controllerObservable } from "./controller-observable.ts";
import { Store } from "../core/observable.ts";
import type { Observable } from "../core/observable.ts";
import type { LspDiagnostic, LspDiagnostics } from "../protocol/index.ts";
import type { InlineDecoration } from "./viewport.ts";
import type { TextEditor } from "./text-editor.ts";

export type EditorDiagnostic = Pick<LspDiagnostic, "message" | "severity" | "source" | "code" | "tags"> &
    Readonly<{ from: number; to: number; select: () => boolean }>;

const severities = ["error", "warning", "information", "hint"] as const;

/** The same marks serve provider pushes and host-supplied diagnostics. */
export function diagnosticDecoration(
    { from, to, severity, tags }: Pick<EditorDiagnostic, "from" | "to"> & Partial<Pick<LspDiagnostic, "severity" | "tags">>
): InlineDecoration {
    const level = severities[(severity ?? 1) - 1] ?? "error";
    const deprecated = tags?.includes(2) ? " st-deprecated" : "";
    return { from, to, className: `st-diagnostic st-diagnostic-${level}${deprecated}` };
}

export type DiagnosticSnapshot = Readonly<{
    diagnostics: readonly EditorDiagnostic[]; diagnosticRevision: number; diagnosticsPending: boolean;
    unversionedDiagnostics: readonly string[];
}>;
export type DiagnosticControllerOptions = Readonly<{
    autoConnect?: boolean; canCapture?: () => boolean; onError?: (error: unknown) => void;
}>;
export type DiagnosticController = Observable<DiagnosticSnapshot> & Readonly<{
    request: () => void; cancel: () => void; dispose: () => void;
}>;

const empty: DiagnosticSnapshot = Object.freeze({ diagnostics: emptyList, diagnosticRevision: -1,
    diagnosticsPending: false, unversionedDiagnostics: emptyList });

/** Displays pushed diagnostics for one view, including positions mapped while analysis is pending. */
export function mountDiagnostic(editor: TextEditor, { scope, binding }: LspDocumentOwner,
    options: DiagnosticControllerOptions): DiagnosticController {
    const { workspace, tab } = editor;
    const source = scope.observeDiagnostics(binding);
    const layer = editor.decorations.add({ order: 40 });
    const notifications = workspace.createNotificationScope(options.onError);
    const cell = new Store<DiagnosticSnapshot>(empty, notifications);
    let displayed: LspDiagnostics | null = null, disposed = false, stop: (() => void) | undefined;
    const available = () => !disposed && isMountedEditor(editor);
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
            const { from, to, message, severity, code, tags } = item;
            if (from === null || to === null) { messages.push(message + " (range outside the current snapshot)"); continue; }
            if (result.freshness === "unversioned") messages.push(message + " (provider version unknown)");
            const select = (): boolean => {
                notifications.assertWritable();
                const now = source.getSnapshot();
                if (!available() || displayed !== result || now.result !== result || !now.isPlacementCurrent()
                    || cell.get().diagnostics !== diagnostics || options.canCapture?.() === false) return false;
                return !!editor.reveal({ from, to }, { expectedRevision: result.snapshotRevision, select: true, focus: true });
            };
            diagnostics.push(Object.freeze({
                from, to, message, severity, source: item.source, select,
                ...(code !== undefined && { code }), ...(tags && { tags })
            }));
        }
        layer.set(result.snapshotRevision, diagnostics.map(diagnosticDecoration));
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
    const stopTabs = tab ? workspace.tabs.subscribe(() => { if (!available()) clear(); }) : undefined;
    const dispose = () => {
        if (disposed) return;
        notifications.assertWritable(); disposed = true;
        cancel();
        stopTabs?.();
        layer.dispose();
        cell.clearSnapshotListeners();
    };
    try { request(); } catch (error) { dispose(); throw error; }
    return Object.freeze({ ...controllerObservable(cell, "Diagnostic", () => disposed, notifications), request, cancel, dispose });
}
