import type { FoldIndex, ResourceLease, SelectionSet, TabId, Workspace } from "../../../src/index.ts";
import type { DocumentationContent, EditingCandidate } from "../../../src/browser/index.ts";
import { HostCell } from "../observable.ts";
import { validateHoverResult } from "../../../fixtures/language/hover.ts";
import type { HoverInput } from "../../../fixtures/language/hover.ts";
import type { AbsoluteHover, HoverBackend } from "./hover-backend.ts";

type Capture = Readonly<{ input: HoverInput; from: number; selectionSet: SelectionSet; folds: FoldIndex; startsInWord: boolean; endsInWord: boolean; lease: ResourceLease }>;
export type HoverSnapshot = Readonly<{ status: "idle" | "pending" | "ready" | "empty" | "failed" | "disconnected" | "expired" | "disposed";
    message: string; revision: number | null; range: Readonly<{ from: number; to: number }> | null; text: string; content?: DocumentationContent }>;

/** Host-owned read-only service. Its worker lane is independent of completion/diagnostics. */
export function createHoverController(workspace: Workspace, tabId: TabId, editor: EditingCandidate, options: Readonly<{ createWorker?: () => Worker; backend?: HoverBackend; canCapture?: () => boolean }> = {}) {
    const target = workspace.captureTab(tabId), documentId = editor.view.documentId, resource = workspace.resourceForDocument(documentId), tab = workspace.resolveTab(target);
    if (tab?.surface.kind !== "text" || tab.surface.documentId !== documentId || !workspace.ownsDocumentView(editor.view)) throw new Error("Hover requires the captured document view.");
    const win = editor.element.ownerDocument.defaultView!, counts = { created: 0, posted: 0, received: 0, stale: 0, invalid: 0, failed: 0, cancelled: 0, postedUnits: 0 };
    const cell = new HostCell<HoverSnapshot>({ status: "idle", message: "Inspect a symbol for information.", revision: null, range: null, text: "" });
    let worker: Worker | undefined, pending: Capture | undefined, capture: Capture | undefined, timer: number | undefined, disposed = false, sequence = 0, intent = 0, epoch = 0, delay = 0, fault: HoverInput["fault"];
    let subscriptions: (() => void)[] = [];
    let backendCall: ReturnType<HoverBackend["run"]> | undefined, backendCurrent: (() => boolean) | undefined;
    const valid = () => !disposed && workspace.resolveTab(target) !== undefined && workspace.ownsDocumentView(editor.view) && !editor.activity().disposed && resource.getSnapshot().state === "ready";
    const current = (value: Capture) => valid() && workspace.document(documentId).revision === value.input.revision && editor.view.getSnapshot().selectionSet === value.selectionSet
        && value.folds.sameProjection(editor.view.folding.getSnapshot().index) && (options.canCapture?.() ?? true) && (backendCurrent?.() ?? true);
    const release = () => { const value = pending, call = backendCall; pending = undefined; backendCall = undefined; value?.lease.release(); call?.cancel(); if (timer !== undefined) win.clearTimeout(timer); timer = undefined; };
    const clear = (status: HoverSnapshot["status"], message: string) => { intent++; capture = undefined; backendCurrent = undefined; release();
        for (const stop of subscriptions.splice(0)) stop(); cell.set({ status, message, revision: null, range: null, text: "" }); };
    function disconnect(): void { epoch++; worker?.terminate(); worker = undefined; clear(disposed ? "disposed" : "disconnected", "Symbol information is disconnected."); options.backend?.disconnect(); }
    function accept(value: Capture, result: AbsoluteHover | null): void {
        release(); backendCurrent = result?.isCurrent;
        if (!current(value)) { counts.stale++; clear("expired", "The captured symbol changed."); return; }
        if (!result?.text) { clear("empty", "No symbol information at this position."); return; }
        capture = value; cell.set({ status: "ready", message: "Symbol information ready.", revision: result.revision, range: result.range, text: result.text, ...(result.content ? { content: result.content } : {}) });
    }
    function connect(): boolean {
        if (options.backend) return true;
        if (worker) return true;
        const connection = ++epoch;
        try { worker = options.createWorker?.() ?? new Worker("/provider-worker.js", { type: "module" }); counts.created++; }
        catch { counts.failed++; clear("failed", "Symbol information is unavailable; editing remains available."); return false; }
        const failed = () => { if (disposed || connection !== epoch) return; counts.failed++; disconnect(); cell.set({ ...cell.get(), status: "failed", message: "Symbol information is unavailable; editing remains available." }); };
        worker.addEventListener("error", event => { event.preventDefault(); failed(); }); worker.addEventListener("messageerror", failed);
        worker.addEventListener("message", (event: MessageEvent<unknown>) => {
            if (disposed || connection !== epoch) return; counts.received++;
            let decoded: unknown;
            try { if (typeof event.data !== "string") throw new TypeError(); decoded = JSON.parse(event.data); }
            catch { counts.invalid++; clear("failed", "Malformed symbol information rejected."); return; }
            if (!pending) { counts.stale++; return; }
            if (typeof decoded !== "object" || decoded === null || !("id" in decoded) || typeof decoded.id !== "number" || !Number.isSafeInteger(decoded.id)) {
                counts.invalid++; clear("failed", "Malformed symbol information rejected."); return;
            }
            if (decoded.id !== pending.input.id) { counts.stale++; return; }
            const value = pending, result = validateHoverResult(decoded, value.input);
            if (!result) { counts.invalid++; clear("failed", "Malformed symbol information rejected."); return; }
            if (result.range && (value.startsInWord && result.range.from === 0 || value.endsInWord && result.range.to === value.input.text.length)) {
                counts.invalid++; clear("empty", "The symbol extends beyond the captured window."); return;
            }
            accept(value, result.range ? { revision: result.revision, range: Object.freeze({ from: value.from + result.range.from, to: value.from + result.range.to }), text: result.text } : null);
        });
        return true;
    }
    function request(expectedRevision: number, offset: number): boolean {
        if (!valid()) return false;
        const document = workspace.document(documentId);
        if (document.revision !== expectedRevision || !Number.isSafeInteger(offset) || offset < 0 || offset > document.buffer.length || editor.activity().composing
            || !(options.canCapture?.() ?? true) || editor.view.folding.getSnapshot().index.hiddenBy(document.buffer.lineAt(offset))) return false;
        clear("idle", "Reading captured symbol information."); if (!connect()) return false;
        const buffer = document.buffer; let from = Math.max(0, offset - 2047), to = Math.min(buffer.length, offset + 2047);
        const high = (value: string) => /^[\ud800-\udbff]$/.test(value), low = (value: string) => /^[\udc00-\udfff]$/.test(value);
        if (from > 0 && low(buffer.slice(from, from + 1)) && high(buffer.slice(from - 1, from))) from--;
        if (to < buffer.length && high(buffer.slice(to - 1, to)) && low(buffer.slice(to, to + 1))) to++;
        const input: HoverInput = Object.freeze({ operation: "hover", id: ++sequence, revision: document.revision, text: buffer.slice(from, to), offset: offset - from, delay, ...(fault ? { fault } : {}) }); fault = undefined;
        const word = /^[\p{L}\p{N}\p{Pc}\p{M}\u200c\u200d]$/u, points = Array.from(input.text), before = Array.from(buffer.slice(Math.max(0, from - 2), from)).at(-1) ?? "", after = Array.from(buffer.slice(to, Math.min(buffer.length, to + 2)))[0] ?? "";
        pending = Object.freeze({ input, from, selectionSet: editor.view.getSnapshot().selectionSet, folds: editor.view.folding.getSnapshot().index, lease: workspace.acquire(resource.id),
            startsInWord: from > 0 && word.test(before) && word.test(points[0] ?? ""), endsInWord: to < buffer.length && word.test(after) && word.test(points.at(-1) ?? "") });
        subscriptions = [workspace.observeDocument(documentId).subscribe(invalidate), editor.view.subscribe(invalidate), editor.view.folding.subscribe(invalidate), workspace.tabState.subscribe(invalidate)];
        counts.posted++; counts.postedUnits += input.text.length;
        if (options.backend) {
            const value = pending, token = intent;
            try { backendCall = options.backend.run(document, offset, input);
                void backendCall.result.then(result => { if (disposed || intent !== token || pending !== value) return; counts.received++; accept(value, result); }, error => {
                    if (disposed || intent !== token || pending !== value) return;
                    if (error instanceof TypeError || error instanceof RangeError) counts.invalid++; else counts.failed++;
                    clear("failed", error instanceof Error ? error.message : "LSP symbol information failed.");
                });
            } catch { counts.failed++; disconnect(); return false; }
        } else try { worker!.postMessage(JSON.stringify(input)); } catch { counts.failed++; disconnect(); return false; }
        cell.set({ status: "pending", message: "Reading captured symbol information.", revision: document.revision, range: null, text: "" });
        const token = intent; timer = win.setTimeout(() => { if (disposed || token !== intent || !pending) return; counts.failed++; clear("failed", "Symbol information timed out; editing remains available."); }, 5000);
        return true;
    }
    // Workspace notifications cannot release leases. Defer cleanup and preserve a newer intent.
    const invalidate = () => { const value = pending ?? capture, token = intent;
        if (value && !current(value)) queueMicrotask(() => { if (!disposed && token === intent) clear("expired", "The captured symbol changed."); }); };
    const composition = () => { if (pending) counts.cancelled++; clear("idle", "Finish composition before inspecting a symbol."); };
    const stopBackend = options.backend?.subscribe(invalidate);
    editor.input.addEventListener("compositionstart", composition);
    return Object.freeze({ state: cell.observable, request, disconnect,
        cancel: () => { if (disposed) return; if (pending) counts.cancelled++; clear("idle", "Symbol information dismissed."); },
        setDelay: (value: number) => { if (!Number.isFinite(value) || value < 0 || value > 1000) throw new RangeError("Invalid hover delay."); delay = value; },
        faultNext: (value: NonNullable<HoverInput["fault"]>) => { fault = value; },
        snapshot: () => Object.freeze({ ...counts, connected: options.backend?.snapshot().connected ?? worker !== undefined, pending: pending !== undefined, disposed,
            ...(options.backend ? { transport: options.backend.snapshot().transport } : {}) }),
        destroy: () => { if (disposed) return; disposed = true; stopBackend?.(); disconnect(); options.backend?.dispose(); editor.input.removeEventListener("compositionstart", composition); } });
}
