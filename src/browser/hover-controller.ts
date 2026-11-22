import { Store } from "../core/observable.ts";
import type { Observable } from "../core/observable.ts";
import type { DocumentationContent } from "../core/documentation.ts";
import { ownsTextSurface } from "../core/workspace.ts";
import type { FoldIndex } from "../core/folding.ts";
import type { SelectionSet } from "../core/selections.ts";
import { createLspHoverClient } from "../protocol/index.ts";
import type { LspDiagnostic, LspPrepare, LspWorkspace } from "../protocol/index.ts";
import type { OverlayAnchor } from "./anchored-overlay.ts";
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
const idle: HoverSnapshot = Object.freeze({ status: "idle", message: "", revision: null, range: null, text: "" });
type HoverResult = NonNullable<Awaited<ReturnType<ReturnType<typeof createLspHoverClient>["run"]>["result"]>>;
type Inspection = { revision: number; selection: SelectionSet; folds: FoldIndex; offset: number; source: HoverDiagnostics;
    stops: (() => void)[]; timer?: number; pending: boolean; symbol?: HoverResult; failure?: string };

/** A mounted view owns the range, provider reply and diagnostic messages displayed together. */
export function createHoverController(editor: TextEditor, provider: LspWorkspace, options: HoverControllerOptions = {}) {
    const { workspace, view, tab } = editor, win = editor.element.ownerDocument.defaultView!;
    if (editor.signal.aborted || !ownsTextSurface(workspace, view, tab)) throw new Error("Hover requires a live document view.");
    const notifications = workspace.createNotificationScope(options.onError), cell = new Store(idle, notifications);
    const client = createLspHoverClient(provider), calls = editor.latestOperation(), subscribers = new Set<() => void>();
    let inspection: Inspection | undefined, disposed = false;
    let providerScope: ReturnType<LspWorkspace["createScope"]> | undefined, defaultSource: HoverDiagnostics | undefined;
    const counts = { posted: 0, received: 0, stale: 0, invalid: 0, failed: 0, cancelled: 0 };
    const publish = (next: HoverSnapshot) => notifications.publish(cell, Object.freeze(next));
    function diagnosticSource(): HoverDiagnostics {
        if (options.diagnostics) return options.diagnostics;
        if (defaultSource) return defaultSource;
        const scope = provider.createScope();
        try {
            const source = scope.observeDiagnostics(scope.attachDocument(view.documentId));
            defaultSource = { subscribe: source.subscribe, getSnapshot() {
                const state = source.getSnapshot(), result = state.isPlacementCurrent() ? state.result : null;
                return { diagnosticRevision: result?.snapshotRevision ?? -1, diagnostics: result?.items ?? [], diagnosticsPending: state.status === "pending" };
            } };
            providerScope = scope; return defaultSource;
        } catch (error) { scope.dispose(); throw error; }
    }
    function release(): void {
        const previous = inspection; inspection = undefined;
        if (!previous) return;
        win.clearTimeout(previous.timer); for (const stop of previous.stops) stop(); calls.cancel(); client.cancel();
    }
    function available(): boolean {
        const activity = editor.activity();
        return !disposed && editor.element.isConnected && !editor.input.disabled && !activity.composing && !activity.pendingInput
            && !activity.pendingCommand && ownsTextSurface(workspace, view, tab) && (options.canCapture?.() ?? true);
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
        if (current.pending || current.symbol && !current.symbol.range) range = null;
        else if (range) range = Object.freeze({ from: Math.max(left, range.from), to: Math.min(right, range.to) });
        if (messages.length && diagnostics.diagnosticsPending) messages.push("Awaiting recheck.");
        const symbol = current.symbol;
        if (messages.length || symbol?.text) {
            const text = [...messages, ...(symbol?.text ? [symbol.text] : [])].join("\n\n");
            const content: DocumentationContent = Object.freeze([...messages.map(value => Object.freeze({ kind: "plaintext" as const, value })), ...(symbol?.content ?? [])]);
            publish({ status: "ready", message: "", revision, range, text, content }); return;
        }
        if (current.pending) publish({ ...idle, status: "pending", revision, message: "Reading symbol information." });
        else if (current.failure) publish({ ...idle, status: "failed", message: current.failure });
        else { release(); publish({ ...idle, status: "empty", message: "No information at this position." }); }
    }
    function request(anchor?: OverlayAnchor): boolean {
        notifications.assertWritable();
        if (!available()) return false;
        const selected = view.getSnapshot(), offset = anchor?.offset ?? selected.selection.head;
        const doc = workspace.observeDocument(view.documentId).getSnapshot();
        if (!doc || (anchor && anchor.revision !== doc.revision) || !Number.isSafeInteger(offset) || offset < 0 || offset > doc.buffer.length
            || view.folding.getSnapshot().index.hiddenBy(doc.buffer.lineAt(offset))) return false;
        release();
        try {
            const current: Inspection = { revision: doc.revision, selection: selected.selectionSet, folds: view.folding.getSnapshot().index,
                offset, source: diagnosticSource(), pending: true, stops: [] }; inspection = current;
            const changed = () => { if (!valid(current)) queueMicrotask(() => expire(current)); };
            current.stops.push(current.source.subscribe(() => queueMicrotask(() => render(current))), view.subscribe(changed),
                view.folding.subscribe(changed), workspace.observeDocument(doc.id).subscribe(changed));
            if (tab) current.stops.push(workspace.tabs.subscribe(changed));
            counts.posted++;
            const result = calls.run({}, operation => operation.step(client.run({ document: operation.document, offset, prepare: options.prepareRequest })));
            current.timer = win.setTimeout(() => {
                if (inspection !== current || !current.pending) return;
                current.pending = false; current.failure = "Symbol information timed out."; counts.failed++; calls.cancel(); render(current);
            }, 5000);
            void result.then(outcome => {
                if (inspection !== current || !current.pending) return;
                if (outcome.status === "stale") { expire(current); return; }
                current.pending = false; win.clearTimeout(current.timer); counts.received++;
                if (outcome.value) current.symbol = outcome.value;
                render(current);
            }, error => {
                if (inspection !== current || !current.pending) return;
                current.pending = false; win.clearTimeout(current.timer);
                if (error instanceof TypeError || error instanceof RangeError) counts.invalid++; else counts.failed++;
                current.failure = error instanceof Error ? error.message : "Symbol information failed."; render(current);
            });
            render(current); return true;
        } catch (error) { release(); publish({ ...idle, status: "failed", message: String(error) }); return false; }
    }
    const cancel = () => {
        notifications.assertWritable(); if (disposed) return;
        if (inspection?.pending) counts.cancelled++;
        release(); publish(idle);
    };
    const stopClient = client.subscribe(() => {
        const current = inspection;
        if (current?.symbol && !current.symbol.isCurrent()) queueMicrotask(() => expire(current));
    });
    editor.input.addEventListener("compositionstart", cancel, { signal: editor.signal });
    function dispose(): void {
        if (disposed) return;
        notifications.assertWritable(); disposed = true; release(); stopClient(); calls.dispose(); client.dispose(); providerScope?.dispose();
        editor.input.removeEventListener("compositionstart", cancel); editor.signal.removeEventListener("abort", dispose);
        publish({ ...idle, status: "disposed" }); for (const stop of subscribers) stop();
    }
    editor.signal.addEventListener("abort", dispose, { once: true });
    return Object.freeze({ request, cancel, dispose, getSnapshot: cell.observable.getSnapshot, subscribe(listener: () => void) {
        notifications.assertWritable(); if (disposed) throw new Error("Hover controller is disposed.");
        const unsubscribe = cell.observable.subscribe(listener);
        const stop = () => { unsubscribe(); subscribers.delete(stop); }; subscribers.add(stop); return stop;
    }, getDiagnostics: () => Object.freeze({ ...counts, connected: client.getSnapshot().phase === "ready", pending: !!inspection?.pending, disposed }) });
}
export type HoverController = ReturnType<typeof createHoverController>;
