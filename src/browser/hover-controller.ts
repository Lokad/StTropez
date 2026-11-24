import { isOffset } from "../core/bounds.ts";
import { controllerObservable } from "./controller-observable.ts";
import { Store } from "../core/observable.ts";
import { captureViewRequest, editorReadyForRequest, observeViewSource, type CapturedViewRequest } from "./captured-view.ts";
import type { Observable } from "../core/observable.ts";
import type { DocumentationContent } from "../core/documentation.ts";
import type { FoldIndex } from "../core/folding.ts";
import type { SelectionSet } from "../core/selections.ts";
import { hoverClient } from "../protocol/lsp-hover.ts";
import type { LspDocumentOwner } from "../protocol/lsp-client.ts";
import { isStaleRequest } from "../protocol/wire.ts";
import type { LspHoverResult, LspDiagnostic, LspPrepare } from "../protocol/index.ts";
import type { OverlayPosition } from "./anchored-overlay.ts";
import type { TextEditor } from "./text-editor.ts";

type Range = Readonly<{ from: number; to: number }>;
type Diagnostic = Pick<LspDiagnostic, "from" | "to" | "message">;
/** Hosts with project-wide analysis can supply the diagnostics they actually paint. */
export type HoverDiagnostics = Observable<Readonly<{ diagnosticRevision: number; diagnostics: readonly Diagnostic[]; diagnosticsPending?: boolean }>>;
export type HoverControllerOptions = Readonly<{
    diagnostics?: HoverDiagnostics; canCapture?: () => boolean; prepareRequest?: LspPrepare; onError?: (error: unknown) => void;
}>;
export type HoverSnapshot = Readonly<{
    status: "idle" | "pending" | "ready" | "empty" | "failed" | "expired" | "disposed";
    message: string; revision: number | null; range: Range | null; text: string; content?: DocumentationContent;
}>;
export type HoverController = Observable<HoverSnapshot> & Readonly<{
    request: (anchor?: OverlayPosition, mode?: "refresh" | "reuse") => boolean; cancel: () => void; dispose: () => void;
    getDiagnostics: () => Readonly<{ connected: boolean; pending: boolean; disposed: boolean; posted: number; received: number;
        stale: number; invalid: number; failed: number; cancelled: number }>;
}>;

const idle: HoverSnapshot = Object.freeze({ status: "idle", message: "", revision: null, range: null, text: "" });
type Inspection = { revision: number; selection: SelectionSet; folds: FoldIndex; offset: number; source: HoverDiagnostics;
    stops: (() => void)[]; timer?: number; capture?: CapturedViewRequest<TextEditor["tab"]>; symbol?: LspHoverResult; failure?: string };

/** A mounted view owns the range, provider reply and diagnostic messages displayed together. */
export function mountHover(editor: TextEditor, owner: LspDocumentOwner, options: HoverControllerOptions): HoverController {
    const { workspace, view, tab } = editor, win = editor.element.ownerDocument.defaultView!;
    const notifications = workspace.createNotificationScope(options.onError), cell = new Store(idle, notifications);
    const client = hoverClient(owner);
    let inspection: Inspection | undefined, disposed = false;
    let diagnostics = options.diagnostics;
    const counts = { posted: 0, received: 0, stale: 0, invalid: 0, failed: 0, cancelled: 0 };
    const publish = (next: HoverSnapshot) => notifications.publish(cell, Object.freeze(next));
    function diagnosticSource(): HoverDiagnostics {
        if (diagnostics) return diagnostics;
        const source = owner.scope.observeDiagnostics(owner.binding);
        diagnostics = { subscribe: source.subscribe, getSnapshot() {
            const state = source.getSnapshot();
            const result = state.isPlacementCurrent() ? state.result : null;
            return { diagnosticRevision: result?.snapshotRevision ?? -1, diagnostics: result?.items ?? [], diagnosticsPending: state.status === "pending" };
        } };
        return diagnostics;
    }
    function finish(current: Inspection): void {
        const capture = current.capture;
        if (!capture) return;
        win.clearTimeout(current.timer);
        delete current.capture;
        capture.cancel();
        if (inspection === current) {
            // The displayed card still follows the view after its read lease is released.
            current.stops.push(...observeViewSource(workspace, view, tab, () => {
                if (!valid(current)) queueMicrotask(() => expire(current));
            }));
        }
    }
    function release(): void {
        const previous = inspection; inspection = undefined;
        if (!previous) return;
        finish(previous);
        for (const stop of previous.stops) stop();
        client.cancel();
    }
    function available(): boolean {
        return !disposed && editorReadyForRequest(editor) && workspace.ownsDocumentView(view, tab)
            && (options.canCapture?.() ?? true);
    }
    const valid = (current: Inspection) => available() && view.getSnapshot().revision === current.revision
        && view.getSnapshot().selectionSet === current.selection && current.folds.sameProjection(view.folding.getSnapshot().index)
        && current.symbol?.isCurrent() !== false;
    function expire(current: Inspection): void {
        if (inspection !== current) return;
        counts.stale++; release(); publish({ ...idle, status: "expired", message: "The inspected source changed." });
    }
    function render(current: Inspection): void {
        if (inspection !== current) return;
        if (!valid(current)) { expire(current); return; }
        const revision = current.revision, diagnostics = current.source.getSnapshot(), at = current.offset;
        const messages: string[] = [];
        let range = current.symbol?.range ?? null;
        let left = 0, right = Infinity;
        if (diagnostics.diagnosticRevision === revision) for (const item of diagnostics.diagnostics) {
            if (item.from === null || item.to === null) continue;
            if (at < item.from) { right = Math.min(right, item.from); continue; }
            if (item.from === item.to ? at !== item.from : at >= item.to) {
                left = Math.max(left, item.from === item.to ? item.to + 1 : item.to); continue;
            }
            messages.push(item.message);
            left = Math.max(left, item.from); right = Math.min(right, item.to);
            range ??= { from: item.from, to: item.to };
        }
        // An unbounded symbol reply only describes the requested offset.
        if (current.capture || current.symbol && !current.symbol.range) range = null;
        else if (range) range = Object.freeze({ from: Math.max(left, range.from), to: Math.min(right, range.to) });
        if (messages.length && diagnostics.diagnosticsPending) messages.push("Awaiting recheck.");
        const symbol = current.symbol;
        if (messages.length || symbol?.text) {
            const text = [...messages, ...(symbol?.text ? [symbol.text] : [])].join("\n\n");
            const content: DocumentationContent = Object.freeze([...messages.map(value => Object.freeze({ kind: "plaintext" as const, value })), ...(symbol?.content ?? [])]);
            publish({ status: "ready", message: "", revision, range, text, content }); return;
        }
        if (current.capture) publish({ ...idle, status: "pending", revision, message: "Reading symbol information." });
        else if (current.failure) publish({ ...idle, status: "failed", message: current.failure });
        else { release(); publish({ ...idle, status: "empty", message: "No information at this position." }); }
    }
    function request(anchor?: OverlayPosition, mode: "refresh" | "reuse" = "refresh"): boolean {
        notifications.assertWritable();
        if (!available()) return false;
        const selected = view.getSnapshot(), offset = anchor?.offset ?? selected.selection.head;
        const doc = workspace.observeDocument(view.documentId).getSnapshot();
        if (!doc || (anchor && anchor.revision !== doc.revision) || !isOffset(offset, doc.buffer.length)
            || view.folding.getSnapshot().index.hiddenBy(doc.buffer.lineAt(offset))) return false;
        if (mode === "reuse" && inspection && valid(inspection)) {
            if (inspection.offset === offset) return true;
            const range = inspection.symbol?.range;
            if (range && range.from <= offset && offset < range.to) {
                inspection.offset = offset;
                // Diagnostics can split a provider range today or in a later notification.
                const shown = cell.get().range;
                if (!shown || offset < shown.from || offset >= shown.to) render(inspection);
                return true;
            }
        }
        release();
        try {
            const source = diagnosticSource();
            const capture = captureViewRequest(workspace, tab, view, { available });
            if (!capture) {
                publish({ ...idle, status: "expired", message: "The inspected source changed." });
                return false;
            }
            const current: Inspection = { revision: capture.document.revision, selection: capture.selectionSet,
                folds: capture.folding.index, offset, source, capture, stops: [] };
            inspection = current;
            capture.signal.addEventListener("abort", () => { if (current.capture) expire(current); }, { once: true });
            current.stops.push(source.subscribe(() => queueMicrotask(() => render(current))));
            counts.posted++;
            const result = client.run({ document: capture.document, offset, prepare: options.prepareRequest }).result;
            current.timer = win.setTimeout(() => {
                if (!current.capture) return;
                finish(current);
                client.cancel();
                counts.failed++;
                current.failure = "Symbol information timed out.";
                render(current);
            }, 5000);
            void result.then(symbol => {
                if (!current.capture) return;
                if (!capture.isCurrent() || symbol?.isCurrent() === false) { expire(current); return; }
                finish(current);
                counts.received++;
                if (symbol) current.symbol = symbol;
                render(current);
            }, error => {
                if (!current.capture) return;
                if (isStaleRequest(error) || !capture.isCurrent()) { expire(current); return; }
                finish(current);
                if (error instanceof TypeError || error instanceof RangeError) counts.invalid++; else counts.failed++;
                current.failure = error instanceof Error ? error.message : "Symbol information failed."; render(current);
            });
            render(current); return true;
        } catch (error) { release(); publish({ ...idle, status: "failed", message: String(error) }); return false; }
    }
    const cancel = () => {
        notifications.assertWritable(); if (disposed) return;
        if (inspection?.capture) counts.cancelled++;
        release(); publish(idle);
    };
    const stopClient = client.subscribe(() => {
        const current = inspection;
        if (current?.symbol && !current.symbol.isCurrent()) queueMicrotask(() => expire(current));
    });
    const intent = editor.onEditIntent(kind => { if (kind === "compositionstart") cancel(); });
    function dispose(): void {
        if (disposed) return;
        notifications.assertWritable();
        disposed = true;
        release();
        stopClient();
        client.dispose();
        intent.dispose();
        publish({ ...idle, status: "disposed" });
        cell.clearSnapshotListeners();
    }
    return Object.freeze({ request, cancel, dispose, ...controllerObservable(cell, "Hover", () => disposed, notifications), getDiagnostics: () => Object.freeze({ ...counts, connected: client.getSnapshot().phase === "ready", pending: !!inspection?.capture, disposed }) });
}
