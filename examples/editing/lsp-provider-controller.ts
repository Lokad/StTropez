import { codeWordConstituentPattern } from "../../src/index.ts";
import type { ResourceLease, SelectionSet, TabId, Workspace } from "../../src/index.ts";
import type { EditingCandidate } from "../../src/browser/index.ts";
import { RpcError, decodeLspCompletions } from "../../src/protocol/index.ts";
import type { LspCall, LspCompletions, LspCompletionFallback, LspDocument, LspDocumentCapture, LspSessionAccess, LspWorkspace } from "../../src/protocol/index.ts";
import type { Diagnostic, ProviderController, ProviderOptions, ProviderSnapshot } from "./provider-controller.ts";
import { HostCell } from "../shared/observable.ts";

type Job = { revision: number; selections: SelectionSet; authority: string; folds: number; lease: ResourceLease;
    call?: LspCall<unknown>; capture?: LspDocumentCapture; choices?: LspCompletions; choice: number; cancelled: boolean };
export type LspProviderOptions = ProviderOptions & Readonly<{ provider: LspWorkspace;
    beforeRequest?: (session: LspSessionAccess, configuration: Readonly<{ delay: number; fault?: "malformed" | "failure" }>) => Promise<unknown> }>;
const word = new RegExp(`^(?:${codeWordConstituentPattern})$`, "u");

/** Actual LSP adapter for the shared host controls. No worker fallback or secondary source mirror. */
export function createLspProviderController(workspace: Workspace, tabId: TabId, editor: EditingCandidate, options: LspProviderOptions): ProviderController {
    const target = workspace.captureTab(tabId), documentId = editor.view.documentId, resource = workspace.resourceForDocument(documentId), tab = workspace.resolveTab(target);
    if (tab?.surface.kind !== "text" || tab.surface.documentId !== documentId || !workspace.ownsDocumentView(editor.view)) throw new Error("LSP provider requires the captured document view.");
    const listeners = new AbortController(), session = options.provider.createScope();
    let binding: LspDocument;
    try { binding = session.attachDocument(documentId); }
    catch (error) { session.dispose(); throw error; }
    const diagnosticState = session.observeDiagnostics(binding);
    const counters = { posted: 0, received: 0, applied: 0, stale: 0, cancelled: 0, invalid: 0, outOfScope: 0, failed: 0, postedUnits: 0 };
    let job: Job | undefined, disposed = false, delay = 0, fault: "malformed" | "failure" | undefined, connecting: Promise<void> | undefined;
    let diagnostics: readonly Diagnostic[] = [], unversioned: readonly string[] = [], diagnosticRevision = -1;
    const cell = new HostCell<ProviderSnapshot>({ message: "LSP provider disconnected; local editing remains available.", connected: false, pending: false, offerText: null, diagnostics, diagnosticRevision });
    const available = () => { const tab = workspace.resolveTab(target); return !disposed && editor.element.isConnected && !editor.snapshot().disposed && workspace.ownsDocumentView(editor.view)
        && tab?.surface.kind === "text" && tab.surface.documentId === documentId && !!workspace.observeDocument(documentId).getSnapshot(); };
    const idle = () => { const m = editor.snapshot(); return !m.composing && !m.pendingInput && !m.pendingCommand && !m.pendingWord && !m.pendingGrapheme && !m.disposed && !editor.input.disabled && (options.canCapture?.() ?? true); };
    const authority = () => { const m = resource.metadata.getSnapshot(); return JSON.stringify([m.state, m.capabilities.edit, m.editLock]); };
    const current = (captured: Job) => job === captured && !captured.cancelled && available() && idle() && workspace.document(documentId).revision === captured.revision
        && editor.view.getSnapshot().selectionSet === captured.selections && editor.view.folding.getSnapshot().generation === captured.folds && authority() === captured.authority && captured.lease.active();
    const publish = (message: string) => cell.set({ message, connected: session.state.getSnapshot().phase === "ready", pending: !!job && !job.choices,
        offerText: job?.choices?.items[job.choice]?.label ?? null, choices: job?.choices?.items.map(item => item.label) ?? [], choiceIndex: job?.choice ?? 0,
        diagnostics, diagnosticRevision, unversionedDiagnostics: unversioned });
    const release = () => {
        const old = job; job = undefined; if (!old) return; old.cancelled = true; old.call?.cancel();
        // Workspace observers run during commit delivery; retention cleanup must follow that delivery.
        void Promise.resolve().then(() => old.lease.release());
    };
    const expire = (message: string) => { if (job) counters.stale++; release(); publish(message); };
    const clearDiagnostics = () => { diagnostics = []; unversioned = []; diagnosticRevision = -1; };
    const connect = () => {
        if (disposed || connecting || session.state.getSnapshot().phase === "ready") return;
        const work = session.connect(); connecting = work; publish("LSP provider connecting.");
        void work.then(() => { if (connecting !== work || disposed) return; connecting = undefined; publish("LSP provider connected. Request completion for results."); }, () => {
            if (connecting !== work || disposed) return; connecting = undefined; counters.failed++; release(); clearDiagnostics(); publish("LSP provider unavailable; local editing remains available.");
        });
    };
    const disconnect = () => { release(); clearDiagnostics(); options.provider.disconnect(); connecting = undefined; publish("LSP provider disconnected; local editing remains available."); };
    const fallback = (capture: LspDocumentCapture, offset: number): LspCompletionFallback => {
        const from = Math.max(0, offset - 2048), to = Math.min(capture.document.buffer.length, offset + 2048), text = capture.document.buffer.slice(from, to), at = offset - from;
        let low = at, high = at;
        for (const point of Array.from(text.slice(0, at)).reverse()) { if (!word.test(point)) break; low -= point.length; }
        for (const point of text.slice(at)) { if (!word.test(point)) break; high += point.length; }
        if (low === 0 && from > 0 || high === text.length && to < capture.document.buffer.length) throw new RangeError("Completion word extends beyond the bounded window.");
        return { from: from + low, to: offset, replaceTo: from + high };
    };
    const request = () => {
        if (!available() || !idle()) { publish("Finish pending typing, navigation or composition before completion."); return; }
        const selections = editor.view.getSnapshot().selectionSet, selected = selections.ranges[selections.primary]!;
        if (selections.ranges.length !== 1 || selected.anchor !== selected.head) { publish("Place one caret before requesting completion."); return; }
        if (!connecting && session.state.getSnapshot().phase !== "ready") { publish("Reconnect the LSP provider before requesting completion."); return; }
        release(); const captured: Job = { revision: workspace.document(documentId).revision, selections, authority: authority(), folds: editor.view.folding.getSnapshot().generation, lease: workspace.acquire(resource.id), choice: 0, cancelled: false };
        job = captured; const nextFault = fault; fault = undefined; counters.posted++; publish("LSP completion pending.");
        void (async () => {
            if (connecting) await connecting; if (!current(captured)) throw new RpcError(-32801, "Completion capture changed.");
            if (options.beforeRequest) await options.beforeRequest(session, { delay, ...(nextFault ? { fault: nextFault } : {}) });
            if (!current(captured)) throw new RpcError(-32801, "Completion capture changed.");
            captured.call = session.requestDocument("textDocument/completion", binding, (index, _snapshot, remote) => {
                captured.capture = remote; return { position: index.at(selected.head), context: { triggerKind: 1 } };
            });
            const result = await captured.call.result; counters.received++;
            if (!current(captured) || !captured.capture?.isCurrent()) throw new RpcError(-32801, "Completion capture changed.");
            captured.choices = decodeLspCompletions(result, captured.capture, selected.head, () => fallback(captured.capture!, selected.head));
            if (!captured.choices.items.length) { release(); publish("No LSP completions for this caret."); return; }
            publish(captured.choices.incomplete ? "LSP completion ready; request again after further typing." : "LSP completion ready.");
        })().catch(error => {
            if (job !== captured) return; release();
            if (error instanceof RpcError && error.code === -32801) { counters.stale++; publish("Stale LSP completion rejected."); }
            else if (error instanceof TypeError || error instanceof RangeError) { counters.invalid++; publish("Malformed or unsupported LSP completion rejected."); }
            else { counters.failed++; publish("LSP provider unavailable; local editing remains available."); }
        });
    };
    const apply = (mode: "insert" | "replace"): boolean => {
        const captured = job, completion = captured?.choices?.items[captured.choice]; if (!captured || !completion) return false;
        if (!current(captured) || !captured.capture?.isCurrent() || editor.input.readOnly) { expire("Stale or unauthorized LSP completion rejected."); return false; }
        const plan = completion[mode], result = workspace.edit({ documentId, expectedRevision: captured.revision, origin: "human", edits: plan.edits, view: editor.view,
            selection: { anchor: plan.head, head: plan.head }, history: { kind: "replace" } });
        if (!result.applied) { expire(`LSP completion rejected: ${result.reason}.`); return false; }
        counters.applied++; release(); publish("LSP completion applied."); editor.viewport.revealOffset(plan.head); editor.focus(); return true;
    };
    const chooseCompletion = (index: number): boolean => { if (!job?.choices || !Number.isSafeInteger(index) || index < 0 || index >= job.choices.items.length || !current(job)) return false; job.choice = index; publish("LSP completion selected."); return true; };
    const cancel = () => { if (job) counters.cancelled++; release(); publish("LSP request cancelled."); };
    const selectDiagnostic = (index: number): boolean => {
        const diagnostic = diagnostics[index]; if (!diagnostic || !available() || !idle() || workspace.document(documentId).revision !== diagnosticRevision) return false;
        if (!editor.view.setSelection(diagnosticRevision, { anchor: diagnostic.from, head: diagnostic.to })) return false; editor.viewport.revealOffset(diagnostic.from); editor.focus(); return true;
    };
    let diagnosticStale = 0, diagnosticInvalid = 0;
    const updateDiagnostics = () => {
        const state = diagnosticState.getSnapshot(); counters.stale += state.stale - diagnosticStale; counters.invalid += state.invalid - diagnosticInvalid;
        diagnosticStale = state.stale; diagnosticInvalid = state.invalid;
        const decoded = available() && state.isCurrent() ? state.result : null;
        if (!decoded) { clearDiagnostics(); publish(cell.get().message); return; }
        diagnostics = decoded.items.filter(item => item.placement === "placed").map(item => Object.freeze({ from: item.from!, to: item.to!, message: item.message }));
        unversioned = decoded.items.filter(item => decoded.freshness === "unversioned" || item.placement !== "placed")
            .map(item => `${item.message}${item.placement === "placed" ? " (provider version unknown)" : " (range outside the current snapshot)"}`);
        diagnosticRevision = decoded.snapshotRevision;
        publish(decoded.freshness === "unversioned" ? "LSP diagnostic locations use the current snapshot; provider version is unknown." : "Versioned LSP diagnostics updated.");
    };
    const stops = [diagnosticState.subscribe(updateDiagnostics), session.state.subscribe(() => { if (session.state.getSnapshot().phase === "disconnected") { release(); clearDiagnostics(); } publish(cell.get().message); }),
    workspace.observeDocument(documentId).subscribe(() => {
        clearDiagnostics(); expire("LSP results expired after an edit.");
    }), editor.view.subscribe(() => { if (job && editor.view.getSnapshot().selectionSet !== job.selections) expire("LSP completion expired after selection changed."); }),
    resource.metadata.subscribe(() => { if (job && authority() !== job.authority) expire("LSP completion expired after authority changed."); }),
    workspace.tabState.subscribe(() => { if (!available()) { clearDiagnostics(); expire("Captured LSP view is unavailable."); } })];
    editor.input.addEventListener("compositionstart", () => expire("Finish composition before completion."), { signal: listeners.signal });
    editor.input.addEventListener("beforeinput", () => { if (job) expire("LSP completion expired after input."); }, { signal: listeners.signal });
    updateDiagnostics(); if (options.autoConnect !== false) connect();
    return Object.freeze({ state: cell.observable, request, apply, chooseCompletion, cancel, connect, disconnect, selectDiagnostic,
        customRequest: (method, params) => session.request(method, params).result,
        setDelay: (value: number) => { if (!Number.isFinite(value) || value < 0 || value > 1000) throw new RangeError("Invalid LSP provider delay."); delay = value; }, faultNext: value => { fault = value; },
        snapshot: () => Object.freeze({ ...counters, connected: session.state.getSnapshot().phase === "ready", pending: !!job && !job.choices, offer: !!job?.choices, diagnostics: diagnostics.length, diagnosticRevision, transport: "lsp3.17", protocol: session.snapshotOwnership() }),
        destroy: () => { if (disposed) return; disposed = true; for (const stop of stops) stop(); listeners.abort(); release(); binding.close(); session.dispose(); clearDiagnostics(); publish("LSP provider disposed."); } });
}
