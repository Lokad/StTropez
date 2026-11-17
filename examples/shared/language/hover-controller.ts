import type { FoldIndex, ResourceLease, SelectionSet, TabId, Workspace } from "../../../src/index.ts";
import type { DocumentationContent, TextEditor } from "../../../src/browser/index.ts";
import { HostCell } from "../observable.ts";
import type { HoverInput } from "../../../fixtures/language/hover.ts";
import type { AbsoluteHover, HoverBackend } from "./hover-backend.ts";

type Capture = Readonly<{ revision: number; selectionSet: SelectionSet; folds: FoldIndex; lease: ResourceLease }>;
export type HoverSnapshot = Readonly<{ status: "idle" | "pending" | "ready" | "empty" | "failed" | "disconnected" | "expired" | "disposed";
    message: string; revision: number | null; range: Readonly<{ from: number; to: number }> | null; text: string; content?: DocumentationContent }>;

/** Host-owned read-only service with an explicit captured async backend. */
export function createHoverController(workspace: Workspace, tabId: TabId, editor: TextEditor, options: Readonly<{ backend: HoverBackend; canCapture?: () => boolean }>) {
    const target = workspace.captureTab(tabId), documentId = editor.view.documentId, resource = workspace.resourceForDocument(documentId), tab = workspace.resolveTab(target);
    if (tab?.surface.kind !== "text" || tab.surface.documentId !== documentId || !workspace.ownsDocumentView(editor.view)) throw new Error("Hover requires the captured document view.");
    const win = editor.element.ownerDocument.defaultView!, counts = { posted: 0, received: 0, stale: 0, invalid: 0, failed: 0, cancelled: 0 };
    const cell = new HostCell<HoverSnapshot>({ status: "idle", message: "Inspect a symbol for information.", revision: null, range: null, text: "" });
    let pending: Capture | undefined, capture: Capture | undefined, timer: number | undefined, disposed = false, intent = 0, delay = 0, fault: HoverInput["fault"];
    let subscriptions: (() => void)[] = [];
    let backendCall: ReturnType<HoverBackend["run"]> | undefined, backendCurrent: (() => boolean) | undefined;
    const valid = () => !disposed && workspace.resolveTab(target) !== undefined && workspace.ownsDocumentView(editor.view) && !editor.activity().disposed && resource.getSnapshot().state === "ready";
    const current = (value: Capture) => valid() && workspace.document(documentId).revision === value.revision && editor.view.getSnapshot().selectionSet === value.selectionSet
        && value.folds.sameProjection(editor.view.folding.getSnapshot().index) && (options.canCapture?.() ?? true) && (backendCurrent?.() ?? true);
    const release = () => { const value = pending, call = backendCall; pending = undefined; backendCall = undefined; value?.lease.release(); call?.cancel(); if (timer !== undefined) win.clearTimeout(timer); timer = undefined; };
    const clear = (status: HoverSnapshot["status"], message: string) => { intent++; capture = undefined; backendCurrent = undefined; release();
        for (const stop of subscriptions.splice(0)) stop(); cell.set({ status, message, revision: null, range: null, text: "" }); };
    function disconnect(): void { clear(disposed ? "disposed" : "disconnected", "Symbol information is disconnected."); options.backend.disconnect(); }
    function accept(value: Capture, result: AbsoluteHover | null): void {
        release(); backendCurrent = result?.isCurrent;
        if (!current(value)) { counts.stale++; clear("expired", "The captured symbol changed."); return; }
        if (!result?.text) { clear("empty", "No symbol information at this position."); return; }
        capture = value; cell.set({ status: "ready", message: "Symbol information ready.", revision: result.revision, range: result.range, text: result.text, ...(result.content ? { content: result.content } : {}) });
    }
    function request(expectedRevision: number, offset: number): boolean {
        if (!valid()) return false;
        const document = workspace.document(documentId);
        if (document.revision !== expectedRevision || !Number.isSafeInteger(offset) || offset < 0 || offset > document.buffer.length || editor.activity().composing
            || !(options.canCapture?.() ?? true) || editor.view.folding.getSnapshot().index.hiddenBy(document.buffer.lineAt(offset))) return false;
        clear("idle", "Reading captured symbol information.");
        const configuration = { delay, ...(fault ? { fault } : {}) }; fault = undefined;
        pending = Object.freeze({ revision: document.revision, selectionSet: editor.view.getSnapshot().selectionSet, folds: editor.view.folding.getSnapshot().index, lease: workspace.acquire(resource.id) });
        subscriptions = [workspace.observeDocument(documentId).subscribe(invalidate), editor.view.subscribe(invalidate), editor.view.folding.subscribe(invalidate), workspace.tabState.subscribe(invalidate)];
        counts.posted++;
        const value = pending, token = intent;
        try { backendCall = options.backend.run(document, offset, configuration);
            void backendCall.result.then(result => { if (disposed || intent !== token || pending !== value) return; counts.received++; accept(value, result); }, error => {
                if (disposed || intent !== token || pending !== value) return;
                if (error instanceof TypeError || error instanceof RangeError) counts.invalid++; else counts.failed++;
                clear("failed", error instanceof Error ? error.message : "LSP symbol information failed.");
            });
        } catch { counts.failed++; disconnect(); return false; }
        cell.set({ status: "pending", message: "Reading captured symbol information.", revision: document.revision, range: null, text: "" });
        timer = win.setTimeout(() => { if (disposed || token !== intent || !pending) return; counts.failed++; clear("failed", "Symbol information timed out; editing remains available."); }, 5000);
        return true;
    }
    // Workspace notifications cannot release leases. Defer cleanup and preserve a newer intent.
    const invalidate = () => { const value = pending ?? capture, token = intent;
        if (value && !current(value)) queueMicrotask(() => { if (!disposed && token === intent) clear("expired", "The captured symbol changed."); }); };
    const composition = () => { if (pending) counts.cancelled++; clear("idle", "Finish composition before inspecting a symbol."); };
    const stopBackend = options.backend.subscribe(invalidate);
    editor.input.addEventListener("compositionstart", composition);
    return Object.freeze({ state: cell.observable, request, disconnect,
        cancel: () => { if (disposed) return; if (pending) counts.cancelled++; clear("idle", "Symbol information dismissed."); },
        setDelay: (value: number) => { if (!Number.isFinite(value) || value < 0 || value > 1000) throw new RangeError("Invalid hover delay."); delay = value; },
        faultNext: (value: NonNullable<HoverInput["fault"]>) => { fault = value; },
        snapshot: () => Object.freeze({ ...counts, connected: options.backend.snapshot().connected, pending: pending !== undefined, disposed,
            transport: options.backend.snapshot().transport }),
        destroy: () => { if (disposed) return; disposed = true; stopBackend?.(); disconnect(); options.backend.dispose(); editor.input.removeEventListener("compositionstart", composition); } });
}
