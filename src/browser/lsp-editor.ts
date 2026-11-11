import { codeWordConstituentPattern } from "../index.ts";
import type { ResourceLease, SelectionSet, TabId, Workspace } from "../index.ts";
import type { EditingCandidate } from "./editing-candidate.ts";
import { RpcError, decodeLspCompletions } from "../protocol/index.ts";
import type { LspCall, LspCompletions, LspCompletionFallback, LspDocument, LspDocumentCapture, LspSessionAccess, LspWorkspace } from "../protocol/index.ts";
import { NotificationScope, Store } from "../core/observable.ts";
import type { Observable } from "../core/observable.ts";
import type { JsonValue } from "../protocol/index.ts";

type Job = { revision: number; selections: SelectionSet; authority: string; folds: number; lease: ResourceLease;
    call?: LspCall<unknown>; capture?: LspDocumentCapture; choices?: LspCompletions; choice: number; cancelled: boolean };
export type LspEditorDiagnostic = Readonly<{ from: number; to: number; message: string }>;
export type LspEditorSnapshot = Readonly<{ message: string; connected: boolean; pending: boolean; offerText: string | null;
    diagnostics: readonly LspEditorDiagnostic[]; diagnosticRevision: number; choices: readonly string[]; choiceIndex: number; unversionedDiagnostics: readonly string[] }>;
export type LspEditorOptions = Readonly<{ provider: LspWorkspace; autoConnect?: boolean; canCapture?: () => boolean;
    prepareCompletion?: (session: LspSessionAccess) => Promise<unknown>; onError?: (error: unknown) => void }>;
export type LspEditorController = Readonly<{ state: Observable<LspEditorSnapshot>; request: () => void; apply: (mode: "insert" | "replace") => boolean;
    chooseCompletion: (index: number) => boolean; cancel: () => void; connect: () => void; selectDiagnostic: (index: number) => boolean;
    customRequest: (method: string, params: JsonValue) => Promise<JsonValue>; destroy: () => void;
    snapshot: () => Readonly<{ posted: number; received: number; applied: number; stale: number; cancelled: number; invalid: number; failed: number;
        connected: boolean; pending: boolean; offer: boolean; diagnostics: number; diagnosticRevision: number; transport: "lsp3.17"; protocol: ReturnType<LspWorkspace["snapshot"]>["protocol"] }> }>;
const word = new RegExp(`^(?:${codeWordConstituentPattern})$`, "u");

/** Captured editor coordination; hosts render controls and supply provider/custom-message policy. */
export function createLspEditor(workspace: Workspace, tabId: TabId, editor: EditingCandidate, options: LspEditorOptions): LspEditorController {
    const target = workspace.captureTab(tabId), documentId = editor.view.documentId, resource = workspace.resourceForDocument(documentId), tab = workspace.resolveTab(target);
    if (tab?.surface.kind !== "text" || tab.surface.documentId !== documentId || !workspace.ownsDocumentView(editor.view)) throw new Error("LSP provider requires the captured document view.");
    const listeners = new AbortController(), session = options.provider.createScope();
    let binding: LspDocument;
    try { binding = session.attachDocument(documentId); }
    catch (error) { session.dispose(); throw error; }
    const diagnosticState = session.observeDiagnostics(binding);
    const counters = { posted: 0, received: 0, applied: 0, stale: 0, cancelled: 0, invalid: 0, failed: 0 };
    let job: Job | undefined, disposed = false, connecting: Promise<void> | undefined;
    const emptyDiagnostics: readonly LspEditorDiagnostic[] = Object.freeze([]), emptyMessages: readonly string[] = Object.freeze([]);
    let diagnostics = emptyDiagnostics, unversioned = emptyMessages, diagnosticRevision = -1;
    const notifications = new NotificationScope(error => options.onError?.(error)), observers = new Set<() => void>();
    const cell = new Store<LspEditorSnapshot>(Object.freeze({ message: "LSP provider disconnected; local editing remains available.", connected: false, pending: false, offerText: null, diagnostics, diagnosticRevision, choices: Object.freeze([]), choiceIndex: 0, unversionedDiagnostics: Object.freeze([]) }), notifications);
    const state: Observable<LspEditorSnapshot> = Object.freeze({ getSnapshot: cell.observable.getSnapshot, subscribe: listener => {
        notifications.assertWritable(); if (disposed) throw new Error("LSP editor is disposed."); const stop = cell.observable.subscribe(listener);
        const release = () => { stop(); observers.delete(release); }; observers.add(release); return release;
    } });
    const available = () => { const tab = workspace.resolveTab(target); return !disposed && editor.element.isConnected && !editor.snapshot().disposed && workspace.ownsDocumentView(editor.view)
        && tab?.surface.kind === "text" && tab.surface.documentId === documentId && !!workspace.observeDocument(documentId).getSnapshot(); };
    const idle = () => { const m = editor.snapshot(); return !m.composing && !m.pendingInput && !m.pendingCommand && !m.pendingWord && !m.pendingGrapheme && !m.disposed && !editor.input.disabled && (options.canCapture?.() ?? true); };
    const authority = () => { const m = resource.metadata.getSnapshot(); return JSON.stringify([m.state, m.capabilities.edit, m.editLock]); };
    const current = (captured: Job) => job === captured && !captured.cancelled && available() && idle() && workspace.document(documentId).revision === captured.revision
        && editor.view.getSnapshot().selectionSet === captured.selections && editor.view.folding.getSnapshot().generation === captured.folds && authority() === captured.authority && captured.lease.active();
    const publish = (message: string) => { const changed = new Set<Store<unknown>>(); cell.set(Object.freeze({ message, connected: session.state.getSnapshot().phase === "ready", pending: !!job && !job.choices,
        offerText: job?.choices?.items[job.choice]?.label ?? null, choices: Object.freeze(job?.choices?.items.map(item => item.label) ?? []), choiceIndex: job?.choice ?? 0,
        diagnostics, diagnosticRevision, unversionedDiagnostics: unversioned }), changed); notifications.deliver([...changed]); };
    const release = () => {
        const old = job; job = undefined; if (!old) return; old.cancelled = true; old.call?.cancel();
        // Workspace observers run during commit delivery; retention cleanup must follow that delivery.
        void Promise.resolve().then(() => old.lease.release());
    };
    const expire = (message: string) => { if (job) counters.stale++; release(); publish(message); };
    const clearDiagnostics = () => { diagnostics = emptyDiagnostics; unversioned = emptyMessages; diagnosticRevision = -1; };
    const connect = () => {
        if (disposed || connecting || session.state.getSnapshot().phase === "ready") return;
        const work = session.connect(); connecting = work; publish("LSP provider connecting.");
        void work.then(() => { if (connecting !== work || disposed) return; connecting = undefined; publish("LSP provider connected. Request completion for results."); }, () => {
            if (connecting !== work || disposed) return; connecting = undefined; counters.failed++; release(); clearDiagnostics(); publish("LSP provider unavailable; local editing remains available.");
        });
    };
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
        job = captured; counters.posted++; publish("LSP completion pending.");
        void (async () => {
            if (connecting) await connecting; if (!current(captured)) throw new RpcError(-32801, "Completion capture changed.");
            if (options.prepareCompletion) await options.prepareCompletion(session);
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
        diagnostics = Object.freeze(decoded.items.filter(item => item.placement === "placed").map(item => Object.freeze({ from: item.from!, to: item.to!, message: item.message })));
        unversioned = Object.freeze(decoded.items.filter(item => decoded.freshness === "unversioned" || item.placement !== "placed")
            .map(item => `${item.message}${item.placement === "placed" ? " (provider version unknown)" : " (range outside the current snapshot)"}`));
        diagnosticRevision = decoded.snapshotRevision;
        publish(decoded.freshness === "unversioned" ? "LSP diagnostic locations use the current snapshot; provider version is unknown." : "Versioned LSP diagnostics updated.");
    };
    const stops = [diagnosticState.subscribe(updateDiagnostics), options.provider.state.subscribe(() => {
        const phase = session.state.getSnapshot().phase;
        if (phase === "disconnected" || phase === "disposed") { release(); clearDiagnostics(); }
        else if (job?.capture && !job.capture.isCurrent()) { expire("LSP completion expired after provider capabilities changed."); return; }
        publish(cell.get().message);
    }),
    workspace.observeDocument(documentId).subscribe(() => {
        clearDiagnostics(); expire("LSP results expired after an edit.");
    }), editor.view.subscribe(() => { if (job && editor.view.getSnapshot().selectionSet !== job.selections) expire("LSP completion expired after selection changed."); }),
    resource.metadata.subscribe(() => { if (job && authority() !== job.authority) expire("LSP completion expired after authority changed."); }),
    workspace.tabState.subscribe(() => { if (!available()) { clearDiagnostics(); expire("Captured LSP view is unavailable."); } })];
    editor.input.addEventListener("compositionstart", () => expire("Finish composition before completion."), { signal: listeners.signal });
    editor.input.addEventListener("beforeinput", () => { if (job) expire("LSP completion expired after input."); }, { signal: listeners.signal });
    updateDiagnostics(); if (options.autoConnect !== false) connect();
    return Object.freeze({ state, request: () => { notifications.assertWritable(); if (!disposed) request(); },
        apply: mode => { notifications.assertWritable(); return !disposed && apply(mode); },
        chooseCompletion: index => { notifications.assertWritable(); return !disposed && chooseCompletion(index); },
        cancel: () => { notifications.assertWritable(); if (!disposed) cancel(); }, connect: () => { notifications.assertWritable(); connect(); },
        selectDiagnostic: index => { notifications.assertWritable(); return !disposed && selectDiagnostic(index); },
        customRequest: (method, params) => { notifications.assertWritable(); return session.request(method, params).result; },
        snapshot: () => Object.freeze({ ...counters, connected: session.state.getSnapshot().phase === "ready", pending: !!job && !job.choices, offer: !!job?.choices, diagnostics: diagnostics.length, diagnosticRevision, transport: "lsp3.17", protocol: session.snapshotOwnership() }),
        destroy: () => { if (disposed) return; notifications.assertWritable(); disposed = true; for (const stop of stops) stop(); listeners.abort(); release(); binding.close(); session.dispose(); clearDiagnostics(); publish("LSP editor disposed."); for (const stop of [...observers]) stop(); } });
}
