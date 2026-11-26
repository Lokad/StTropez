import { onAbort } from "./listen.ts";
import { done, failed, refused, stale, type Outcome } from "../core/outcome.ts";
import { isOffset } from "../core/bounds.ts";
import { emptyList } from "../core/empty-list.ts";
import { controllerObservable } from "./controller-observable.ts";
import { Store } from "../core/observable.ts";
import { canInspectView, captureViewRequest, observeViewSource, type CapturedViewRequest } from "./captured-view.ts";
import type { Observable } from "../core/observable.ts";
import type { DocumentationContent } from "../core/documentation.ts";
import type { FoldIndex } from "../core/folding.ts";
import type { SelectionSet } from "../core/selections.ts";
import { hoverClient, type LspHoverResult } from "../protocol/lsp-hover.ts";
import type { LspDocumentOwner } from "../protocol/lsp-client.ts";
import { isStaleRequest } from "../protocol/wire.ts";
import type { LspDiagnostic, LspPrepare } from "../protocol/index.ts";
import type { OverlayPosition } from "./anchored-overlay.ts";
import { mountHoverPopup, type HoverPopupOptions } from "./hover-popup.ts";
import type { TextEditor } from "./text-editor.ts";

type Range = Readonly<{ from: number; to: number }>;
type Diagnostic = Pick<LspDiagnostic, "from" | "to" | "message">;
type MatchedDiagnostic = Range & Pick<Diagnostic, "message">;
/** Hosts with project-wide analysis can supply the diagnostics they actually paint. */
export type HoverDiagnostics = Observable<Readonly<{ diagnosticRevision: number; diagnostics: readonly Diagnostic[]; diagnosticsPending?: boolean }>>;
export type HoverControllerOptions = Readonly<{
    diagnostics?: HoverDiagnostics; canCapture?: () => boolean; prepareRequest?: LspPrepare; onError?: (error: unknown) => void;
    popup?: boolean | HoverPopupOptions;
}>;
export type HoverSnapshot = Readonly<{
    status: "idle" | "pending" | "ready" | "empty" | "failed" | "expired" | "disposed";
    message: string; revision: number | null; range: Range | null; text: string; content?: DocumentationContent;
    diagnostics: readonly MatchedDiagnostic[];
}>;
export type HoverController = Observable<HoverSnapshot> & Readonly<{
    request: (anchor?: OverlayPosition, mode?: "refresh" | "reuse") => Promise<Outcome<HoverSnapshot>>;
    cancel: () => void; dispose: () => void;
}>;

const idle: HoverSnapshot = Object.freeze({ status: "idle", message: "", revision: null, range: null, text: "", diagnostics: emptyList });
type Inspection = { revision: number; selection: SelectionSet; folds: FoldIndex; offset: number;
    stops: (() => void)[]; timer?: number; capture?: CapturedViewRequest; symbol?: LspHoverResult; failure?: ReturnType<typeof failed> };

/** A mounted view owns the range, provider reply and diagnostic messages displayed together. */
export function mountHover(editor: TextEditor, owner: LspDocumentOwner, options: HoverControllerOptions): HoverController {
    const { workspace, view, tab } = editor, win = editor.element.ownerDocument.defaultView!;
    const notifications = workspace.createNotificationScope(options.onError), cell = new Store(idle, notifications);
    const client = hoverClient(owner);
    let inspection: Inspection | undefined, disposed = false;
    const diagnostics = options.diagnostics ?? providerDiagnostics(owner);
    let pending: Promise<Outcome<HoverSnapshot>> | undefined;
    const publish = (next: HoverSnapshot) => notifications.publish(cell, Object.freeze(next));
    const status = (status: HoverSnapshot["status"], message: string, revision: number | null = null) =>
        publish({ ...idle, status, message, revision });
    function finish(current: Inspection): void {
        const capture = current.capture;
        if (!capture) return;
        pending = undefined;
        win.clearTimeout(current.timer);
        delete current.capture;
        capture.cancel();
        if (inspection === current) {
            // The displayed card still follows the view after its read lease is released.
            current.stops.push(...observeViewSource(workspace, view, tab, changed));
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
        return !disposed && canInspectView(editor, options.canCapture);
    }
    const valid = (current: Inspection) => available() && view.getSnapshot().revision === current.revision
        && view.getSnapshot().selectionSet === current.selection && current.folds.sameProjection(view.folding.getSnapshot().index)
        && current.symbol?.isCurrent() !== false;
    function changed(): void {
        const current = inspection;
        if (current && !valid(current)) queueMicrotask(() => expire(current));
    }
    function expire(current: Inspection): void {
        if (inspection !== current) return;
        release();
        status("expired", "The inspected source changed.");
    }
    function render(current: Inspection): void {
        if (inspection !== current) return;
        if (!valid(current)) { expire(current); return; }
        const { revision, offset: at, symbol } = current;
        const source = diagnostics.getSnapshot();
        const matches: MatchedDiagnostic[] = [];
        let range = symbol?.range ?? null;
        let left = 0, right = Infinity;
        if (source.diagnosticRevision === revision) for (const { from, to, message } of source.diagnostics) {
            if (from === null || to === null) continue;
            if (at < from) {
                right = Math.min(right, from);
            } else if (from === to ? at > to : at >= to) {
                left = Math.max(left, from === to ? to + 1 : to);
            } else {
                const match = Object.freeze({ from, to, message });
                matches.push(match);
                left = Math.max(left, from);
                right = Math.min(right, to);
                range ??= match;
            }
        }
        // An unbounded symbol reply only describes the requested offset.
        if (current.capture || symbol && !symbol.range) range = null;
        else if (range) range = Object.freeze({ from: Math.max(left, range.from), to: Math.min(right, range.to) });
        if (matches.length || symbol) {
            const messages = matches.map(match => match.message);
            if (matches.length && source.diagnosticsPending) messages.push(editor.strings.text("Awaiting recheck."));
            const content: DocumentationContent = Object.freeze([...messages.map(value => Object.freeze({ kind: "plaintext" as const, value })), ...(symbol?.content ?? [])]);
            if (symbol) messages.push(symbol.text);
            publish({ status: "ready", message: "", revision, range, text: messages.join("\n\n"), content,
                diagnostics: Object.freeze(matches) });
            return;
        }
        if (current.capture) status("pending", "Reading symbol information.", revision);
        else if (current.failure) {
            const { error } = current.failure;
            status("failed", error instanceof Error ? error.message : String(error));
        } else {
            // An action-only card still belongs to this source selection.
            if (!(typeof options.popup === "object" && options.popup.actions)) release();
            status("empty", "No information at this position.", revision);
        }
    }
    async function read(current: Inspection, capture: NonNullable<Inspection["capture"]>): Promise<Outcome<HoverSnapshot>> {
        let timedOut = false;
        let symbol: LspHoverResult | null = null;
        try {
            const result = client.run({ document: capture.document, offset: current.offset, prepare: options.prepareRequest }).result;
            current.timer = win.setTimeout(() => {
                timedOut = true;
                client.cancel();
            }, 5000);
            symbol = await result;
        } catch (error) {
            current.failure = failed(timedOut ? new Error("Symbol information timed out.") : error);
        }
        if (inspection !== current) return stale;
        const failure = current.failure;
        if (!capture.isCurrent() || symbol?.isCurrent() === false || isStaleRequest(failure?.error)) {
            expire(current);
            return stale;
        }
        if (symbol) current.symbol = symbol;
        finish(current);
        render(current);
        return failure ?? done(cell.get());
    }
    async function request(anchor?: OverlayPosition, mode: "refresh" | "reuse" = "refresh"): Promise<Outcome<HoverSnapshot>> {
        notifications.assertWritable();
        let owned = inspection;
        try {
            if (!available()) return refused("unavailable-view");
            const selected = view.getSnapshot(), offset = anchor?.offset ?? selected.selection.head;
            if (anchor && anchor.revision !== selected.revision) return stale;
            const doc = workspace.document(view.documentId);
            if (!isOffset(offset, doc.buffer.length) || view.folding.getSnapshot().index.hiddenBy(doc.buffer.lineAt(offset))) {
                return refused("unavailable-position");
            }
            const previous = inspection;
            if (mode === "reuse" && previous && valid(previous)) {
                const range = previous.symbol?.range;
                if (previous.offset === offset) return pending ?? previous.failure ?? done(cell.get());
                if (range && range.from <= offset && offset < range.to) {
                    previous.offset = offset;
                    const shown = cell.get().range;
                    if (!shown || offset < shown.from || offset >= shown.to) render(previous);
                    return done(cell.get());
                }
            }
            release();
            owned = undefined;
            const capture = captureViewRequest(editor, { available });
            if (!capture) return refused("unavailable-view");
            const current: Inspection = { revision: capture.document.revision, selection: capture.selectionSet,
                folds: capture.folding.index, offset, capture, stops: [] };
            owned = inspection = current;
            onAbort(capture.signal, () => { if (current.capture) expire(current); });
            current.stops.push(diagnostics.subscribe(() => queueMicrotask(() => render(current))));
            const result = read(current, capture);
            if (current.capture) {
                pending = result;
                render(current);
            }
            return await result;
        } catch (error) {
            if (owned !== inspection) return stale;
            release();
            status("failed", String(error));
            return failed(error);
        }
    }
    const cancel = () => {
        notifications.assertWritable(); if (disposed) return;
        release(); publish(idle);
    };
    const stopClient = client.subscribe(changed);
    const intent = editor.onEditIntent(kind => { if (kind === "compositionstart") cancel(); });
    function dispose(): void {
        if (disposed) return;
        notifications.assertWritable();
        disposed = true;
        release();
        stopClient();
        client.dispose();
        intent.dispose();
        status("disposed", "");
        cell.clearSnapshotListeners();
    }
    const controller = Object.freeze({ request, cancel, dispose,
        ...controllerObservable(cell, "Hover", () => disposed, notifications) });
    if (!options.popup) return controller;
    try {
        const popup = mountHoverPopup(editor, controller, options.popup === true ? {} : options.popup);
        return Object.freeze({ ...controller, request: popup.request, cancel: popup.cancel, dispose() {
            if (disposed) return;
            notifications.assertWritable();
            popup.dispose();
            dispose();
        } });
    } catch (error) { dispose(); throw error; }
}

function providerDiagnostics(owner: LspDocumentOwner): HoverDiagnostics {
    const source = owner.scope.observeDiagnostics(owner.binding);
    return { subscribe: source.subscribe, getSnapshot() {
        const state = source.getSnapshot();
        const result = state.isPlacementCurrent() ? state.result : null;
        return { diagnosticRevision: result?.snapshotRevision ?? -1, diagnostics: result?.items ?? emptyList,
            diagnosticsPending: state.status === "pending" };
    } };
}
