import { codeWordConstituentPattern } from "../index.ts";
import type { ResourceLease, SelectionSet, TabId, TextBuffer, Workspace } from "../index.ts";
import type { EditingCandidate } from "./editing-candidate.ts";
import { RpcError, decodeLspCompletions, decodeLspResolvedCompletion, lspCompletionPlan, rebaseLspCompletion } from "../protocol/index.ts";
import type { LspCall, LspCompletion, LspCompletions, LspCompletionFallback, LspDocument, LspDocumentCapture, LspSessionAccess, LspWorkspace } from "../protocol/index.ts";
import { NotificationScope, Store } from "../core/observable.ts";
import type { Observable } from "../core/observable.ts";
import type { JsonValue } from "../protocol/index.ts";

type Job = { id: number; revision: number; buffer: TextBuffer; caret: number; prefixFrom: number | undefined; selections: SelectionSet; authority: string; folds: number; lease: ResourceLease;
    call?: LspCall<unknown>; capture?: LspDocumentCapture; choices?: LspCompletions; visible: readonly LspCompletion[]; choice: number; cancelled: boolean; pendingList: boolean; requestGeneration: number;
    resolution?: { item: LspCompletion; revision: number; call?: LspCall<unknown> } | undefined };
type Input = { revision: number; selections: SelectionSet; caret: number; data: string; word: boolean; trigger: string | undefined; reused: boolean; after?: SelectionSet };
type Invocation = Readonly<{ kind: 1 | 2 | 3; character?: string; automatic?: boolean }>;
export type LspEditorDiagnostic = Readonly<{ from: number; to: number; message: string }>;
export type LspEditorSnapshot = Readonly<{ message: string; connected: boolean; pending: boolean; offerText: string | null;
    diagnostics: readonly LspEditorDiagnostic[]; diagnosticRevision: number; choices: readonly string[]; choiceIndex: number; completionId: number; completionDetail: string; resolving: boolean; unversionedDiagnostics: readonly string[] }>;
export type LspEditorOptions = Readonly<{ provider: LspWorkspace; autoConnect?: boolean; automatic?: boolean; canCapture?: () => boolean;
    prepareCompletion?: (session: LspSessionAccess) => Promise<unknown>; onError?: (error: unknown) => void }>;
export type LspEditorController = Readonly<{ state: Observable<LspEditorSnapshot>; request: () => void; apply: (mode: "insert" | "replace", completionId?: number) => boolean;
    chooseCompletion: (index: number, completionId?: number) => boolean; cancel: () => void; connect: () => void; selectDiagnostic: (index: number) => boolean;
    customRequest: (method: string, params: JsonValue) => Promise<JsonValue>; destroy: () => void;
    snapshot: () => Readonly<{ posted: number; received: number; applied: number; stale: number; cancelled: number; invalid: number; failed: number; resolved: number;
        completionBeforeInputEvents: number; lastCompletionBeforeInputMs: number; completionKeydownEvents: number; lastCompletionKeydownMs: number;
        connected: boolean; pending: boolean; offer: boolean; diagnostics: number; diagnosticRevision: number; transport: "lsp3.17"; protocol: ReturnType<LspWorkspace["snapshot"]>["protocol"] }> }>;
const word = new RegExp(`^(?:${codeWordConstituentPattern})$`, "u");
// IDs also distinguish retained host controls from lists belonging to another mounted view.
let completionSequence = 0;

/** Captured editor coordination; hosts render controls and supply provider/custom-message policy. */
export function createLspEditor(workspace: Workspace, tabId: TabId, editor: EditingCandidate, options: LspEditorOptions): LspEditorController {
    const target = workspace.captureTab(tabId), documentId = editor.view.documentId, resource = workspace.resourceForDocument(documentId), tab = workspace.resolveTab(target);
    if (tab?.surface.kind !== "text" || tab.surface.documentId !== documentId || !workspace.ownsDocumentView(editor.view)) throw new Error("LSP provider requires the captured document view.");
    const listeners = new AbortController(), session = options.provider.createScope();
    let binding: LspDocument;
    try { binding = session.attachDocument(documentId); }
    catch (error) { session.dispose(); throw error; }
    const diagnosticState = session.observeDiagnostics(binding);
    const counters = { posted: 0, received: 0, applied: 0, stale: 0, cancelled: 0, invalid: 0, failed: 0, resolved: 0,
        completionBeforeInputEvents: 0, lastCompletionBeforeInputMs: 0, completionKeydownEvents: 0, lastCompletionKeydownMs: 0 };
    let job: Job | undefined, disposed = false, connecting: Promise<void> | undefined, inputIntent: Input | undefined, autoFrame: number | undefined, autoTurns = 0, applying = false;
    const owner = editor.element.ownerDocument, clock = owner.defaultView!;
    const emptyDiagnostics: readonly LspEditorDiagnostic[] = Object.freeze([]), emptyMessages: readonly string[] = Object.freeze([]);
    let diagnostics = emptyDiagnostics, unversioned = emptyMessages, diagnosticRevision = -1;
    const notifications = new NotificationScope(error => options.onError?.(error)), observers = new Set<() => void>();
    const cell = new Store<LspEditorSnapshot>(Object.freeze({ message: "LSP provider disconnected; local editing remains available.", connected: false, pending: false, offerText: null, diagnostics, diagnosticRevision, choices: Object.freeze([]), choiceIndex: 0, completionId: 0, completionDetail: "", resolving: false, unversionedDiagnostics: Object.freeze([]) }), notifications);
    const state: Observable<LspEditorSnapshot> = Object.freeze({ getSnapshot: cell.observable.getSnapshot, subscribe: listener => {
        notifications.assertWritable(); if (disposed) throw new Error("LSP editor is disposed."); const stop = cell.observable.subscribe(listener);
        const release = () => { stop(); observers.delete(release); }; observers.add(release); return release;
    } });
    const available = () => { const tab = workspace.resolveTab(target); return !disposed && editor.element.isConnected && !editor.snapshot().disposed && workspace.ownsDocumentView(editor.view)
        && tab?.surface.kind === "text" && tab.surface.documentId === documentId && !!workspace.observeDocument(documentId).getSnapshot(); };
    const idle = () => { const m = editor.snapshot(); return !m.composing && !m.pendingInput && !m.pendingCommand && !m.pendingWord && !m.pendingGrapheme && !m.disposed && !editor.input.disabled && (options.canCapture?.() ?? true); };
    const authority = () => { const m = resource.metadata.getSnapshot(); return JSON.stringify([m.state, m.capabilities.edit, m.editLock]); };
    const current = (captured: Job) => job === captured && !captured.cancelled && available() && idle() && workspace.document(documentId).revision === captured.revision && workspace.document(documentId).buffer === captured.buffer
        && editor.view.getSnapshot().selectionSet === captured.selections && editor.view.folding.getSnapshot().generation === captured.folds && authority() === captured.authority && captured.lease.active();
    const bindingCurrent = (captured: Job) => !!captured.capture && (captured.capture.isBindingCurrent?.() ?? captured.capture.isCurrent());
    const publish = (message: string) => { const selected = job?.visible[job.choice], changed = new Set<Store<unknown>>(); cell.set(Object.freeze({ message, connected: session.state.getSnapshot().phase === "ready", pending: !!job && (job.pendingList || !!job.resolution || !!selected?.resolve),
        offerText: job?.visible[job.choice]?.label ?? null, choices: Object.freeze(job?.visible.map(item => item.label) ?? []), choiceIndex: job?.choice ?? 0, completionId: job?.id ?? 0,
        completionDetail: selected ? [selected.detail, selected.documentation].filter(Boolean).join("\n") : "", resolving: !!job?.resolution,
        diagnostics, diagnosticRevision, unversionedDiagnostics: unversioned }), changed); notifications.deliver([...changed]); };
    const release = () => {
        const old = job; job = undefined; if (!old) return; old.cancelled = true; old.call?.cancel(); old.resolution?.call?.cancel(); old.resolution = undefined;
        // Workspace observers run during commit delivery; retention cleanup must follow that delivery.
        void Promise.resolve().then(() => old.lease.release());
    };
    const cancelAuto = () => { inputIntent = undefined; if (autoFrame !== undefined) clock.cancelAnimationFrame(autoFrame); autoFrame = undefined; autoTurns = 0; };
    const cancelResolution = (captured: Job) => { const old = captured.resolution; captured.resolution = undefined; old?.call?.cancel(); };
    const expire = (message: string) => { if (job) counters.stale++; release(); publish(message); };
    const clearDiagnostics = () => { diagnostics = emptyDiagnostics; unversioned = emptyMessages; diagnosticRevision = -1; };
    const connect = () => {
        if (disposed || connecting || session.state.getSnapshot().phase === "ready") return;
        const work = session.connect(); connecting = work; publish("LSP provider connecting.");
        void work.then(() => { if (connecting !== work || disposed) return; connecting = undefined; publish("LSP provider connected. Request completion for results."); }, () => {
            if (connecting !== work || disposed) return; connecting = undefined; counters.failed++; release(); clearDiagnostics(); publish("LSP provider unavailable; local editing remains available.");
        });
    };
    const wordRange = (buffer: TextBuffer, offset: number): LspCompletionFallback => {
        const from = Math.max(0, offset - 2048), to = Math.min(buffer.length, offset + 2048), text = buffer.slice(from, to), at = offset - from;
        let low = at, high = at;
        for (const point of Array.from(text.slice(0, at)).reverse()) { if (!word.test(point)) break; low -= point.length; }
        for (const point of text.slice(at)) { if (!word.test(point)) break; high += point.length; }
        if (low === 0 && from > 0 || high === text.length && to < buffer.length) throw new RangeError("Completion word extends beyond the bounded window.");
        return { from: from + low, to: offset, replaceTo: from + high };
    };
    const filter = (captured: Job, prefix: boolean) => {
        const selected = captured.visible[captured.choice], content = prefix && captured.prefixFrom !== undefined ? captured.buffer.slice(captured.prefixFrom, captured.caret).toLowerCase() : "";
        captured.visible = Object.freeze((captured.choices?.items ?? []).filter(item => !content || item.filterText.toLowerCase().startsWith(content)));
        const previous = selected && captured.visible.findIndex(item => item === selected); captured.choice = previous !== undefined && previous >= 0 ? previous : Math.max(0, captured.visible.findIndex(item => item.preselect));
        captured.id = ++completionSequence;
    };
    const request = (invocation: Invocation = { kind: 1 }) => {
        cancelAuto();
        if (!available() || !idle()) { publish("Finish pending typing, navigation or composition before completion."); return; }
        const selections = editor.view.getSnapshot().selectionSet, selected = selections.ranges[selections.primary]!;
        if (selections.ranges.length !== 1 || selected.anchor !== selected.head) { publish("Place one caret before requesting completion."); return; }
        if (!connecting && session.state.getSnapshot().phase !== "ready") { publish("Reconnect the LSP provider before requesting completion."); return; }
        const previous = invocation.automatic && job?.choices && current(job) && bindingCurrent(job) ? job : undefined, provisional = previous?.choices, provisionalVisible = previous?.visible;
        release(); const document = workspace.document(documentId); let prefixFrom: number | undefined;
        try { prefixFrom = wordRange(document.buffer, selected.head).from; } catch { /* Explicit provider ranges do not require a word window. */ }
        const captured: Job = { id: ++completionSequence, revision: document.revision, buffer: document.buffer, caret: selected.head, prefixFrom, selections, authority: authority(), folds: editor.view.folding.getSnapshot().generation,
            lease: workspace.acquire(resource.id), choice: previous?.choice ?? 0, cancelled: false, pendingList: true, requestGeneration: 0, visible: provisionalVisible ?? Object.freeze([]), ...(provisional ? { choices: provisional } : {}), ...(previous?.capture ? { capture: previous.capture } : {}) };
        job = captured; counters.posted++; publish("LSP completion pending.");
        void (async () => {
            if (connecting) await connecting; if (captured.requestGeneration !== 0) return; if (!current(captured)) throw new RpcError(-32801, "Completion capture changed.");
            if (options.prepareCompletion) await options.prepareCompletion(session);
            if (captured.requestGeneration !== 0) return;
            if (!current(captured)) throw new RpcError(-32801, "Completion capture changed.");
            captured.call = session.requestDocument("textDocument/completion", binding, (index, _snapshot, remote) => {
                captured.capture = remote; return { position: index.at(selected.head), context: { triggerKind: invocation.kind, ...(invocation.kind === 2 && invocation.character ? { triggerCharacter: invocation.character } : {}) } };
            });
            const result = await captured.call.result; counters.received++;
            if (captured.requestGeneration !== 0) return;
            if (!current(captured) || !captured.capture?.isCurrent()) throw new RpcError(-32801, "Completion capture changed.");
            const configuration = session.featureOptions("textDocument/completion", binding), commits = configuration.flatMap(option => Array.isArray(option.allCommitCharacters) ? option.allCommitCharacters.filter((value): value is string => typeof value === "string").slice(0, 64) : []);
            const choices = decodeLspCompletions(result, captured.capture, selected.head, () => wordRange(captured.capture!.document.buffer, selected.head), { resolve: configuration.some(option => option.resolveProvider === true), commitCharacters: commits });
            captured.choices = Object.freeze({ ...choices, items: Object.freeze(choices.items.map((item, order) => ({ item, order })).sort((a, b) => a.item.sortText < b.item.sortText ? -1 : a.item.sortText > b.item.sortText ? 1 : a.order - b.order).map(value => value.item)) });
            captured.pendingList = false; filter(captured, invocation.automatic === true);
            if (!captured.visible.length) { release(); publish("No LSP completions for this caret."); return; }
            publish("LSP completion ready.");
            resolveSelected(captured);
        })().catch(error => {
            if (job !== captured || captured.requestGeneration !== 0) return; release();
            if (error instanceof RpcError && error.code === -32801) { counters.stale++; publish("Stale LSP completion rejected."); }
            else if (error instanceof TypeError || error instanceof RangeError) { counters.invalid++; publish("Malformed or unsupported LSP completion rejected."); }
            else { counters.failed++; publish("LSP provider unavailable; local editing remains available."); }
        });
    };
    const resolveSelected = (captured: Job) => {
        const item = captured.visible[captured.choice];
        if (!item?.resolve || captured.pendingList || captured.resolution?.item === item || !current(captured) || !bindingCurrent(captured)) return;
        cancelResolution(captured); const resolution: NonNullable<Job["resolution"]> = { item, revision: captured.revision }; captured.resolution = resolution;
        const valid = () => job === captured && captured.resolution === resolution && captured.visible[captured.choice] === item && captured.revision === resolution.revision && current(captured) && bindingCurrent(captured);
        publish("Resolving the selected completion.");
        void (async () => {
            await session.flush(); if (!valid()) return;
            const capture = session.synchronized(binding); if (!capture) throw new RpcError(-32801, "Completion resolve snapshot changed.");
            resolution.call = session.request("completionItem/resolve", item.resolve!); const value = await resolution.call.result;
            if (!valid() || !capture.isCurrent()) return;
            const resolved = decodeLspResolvedCompletion(value, item, capture);
            captured.choices = Object.freeze({ ...captured.choices!, items: Object.freeze(captured.choices!.items.map(value => value === item ? resolved : value)) });
            captured.visible = Object.freeze(captured.visible.map(value => value === item ? resolved : value)); captured.resolution = undefined; counters.resolved++;
            publish("LSP completion ready.");
        })().catch(error => { if (job !== captured || captured.resolution !== resolution) return;
            if (error instanceof TypeError || error instanceof RangeError) counters.invalid++; else if (error instanceof RpcError && error.code === -32801) counters.stale++; else counters.failed++;
            release(); publish("Completion resolution failed or expired; request fresh choices."); });
    };
    const apply = (mode: "insert" | "replace", completionId?: number, character?: string): boolean => {
        if (completionId !== undefined && job?.id !== completionId) return false;
        const captured = job, completion = captured?.visible[captured.choice]; if (!captured || !completion) return false;
        if (!current(captured) || !bindingCurrent(captured) || editor.input.readOnly) { expire("Stale or unauthorized LSP completion rejected."); return false; }
        if (completion.resolve || captured.resolution) { resolveSelected(captured); publish("Wait for the selected completion to finish resolving."); return false; }
        const plan = lspCompletionPlan(completion, mode, character); applying = true;
        let result;
        try { result = workspace.edit({ documentId, expectedRevision: captured.revision, origin: "human", edits: plan.edits, view: editor.view,
            selection: { anchor: plan.head, head: plan.head }, history: { kind: "replace" } }); } finally { applying = false; }
        if (!result.applied) { expire(`LSP completion rejected: ${result.reason}.`); return false; }
        counters.applied++; cancelAuto(); release(); publish("LSP completion applied."); editor.viewport.revealOffset(plan.head); editor.focus(); return true;
    };
    const chooseCompletion = (index: number, completionId?: number): boolean => {
        if (!job?.choices || completionId !== undefined && completionId !== job.id || !Number.isSafeInteger(index) || index < 0 || index >= job.visible.length || !current(job)) return false;
        cancelResolution(job); job.choice = index; if (job.pendingList) { job.requestGeneration++; job.call?.cancel(); job.pendingList = false; } publish("LSP completion selected."); resolveSelected(job); return true;
    };
    const cancel = () => { cancelAuto(); if (job) counters.cancelled++; release(); publish("LSP request cancelled."); };
    const triggers = () => new Set(session.featureOptions("textDocument/completion", binding).flatMap(option => Array.isArray(option.triggerCharacters)
        ? option.triggerCharacters.filter((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 8).slice(0, 64) : []));
    const scheduleAuto = () => {
        if (options.automatic === false || !inputIntent || autoFrame !== undefined) return;
        autoFrame = clock.requestAnimationFrame(() => {
            autoFrame = undefined;
            if (!inputIntent || disposed || !available() || owner.activeElement !== editor.input || editor.input.readOnly || editor.snapshot().composing) { cancelAuto(); return; }
            if (!idle()) { if (++autoTurns < 120) scheduleAuto(); return; }
            if (session.state.getSnapshot().phase !== "ready" && connecting) { if (++autoTurns < 120) scheduleAuto(); return; }
            const intent = inputIntent, selected = editor.view.getSnapshot().selectionSet, caret = selected.ranges[selected.primary]!;
            if (selected.ranges.length !== 1 || caret.anchor !== caret.head || !workspace.document(documentId).change || workspace.document(documentId).change!.origin !== "human") { cancelAuto(); return; }
            if (!connecting && session.state.getSnapshot().phase !== "ready" || session.state.getSnapshot().phase === "ready" && !session.canRequest("textDocument/completion", binding)) { cancelAuto(); return; }
            const character = triggers().has(intent.data) ? intent.data : undefined;
            if (!intent.word && !character) { cancelAuto(); return; }
            if (!character && intent.reused && job?.choices && !job.choices.incomplete && job.visible.length) { cancelAuto(); resolveSelected(job); return; }
            const kind = character ? 2 : intent.reused && job?.choices?.incomplete ? 3 : 1;
            request({ kind, automatic: true, ...(character ? { character } : {}) });
        });
    };
    const typed = (event: InputEvent) => {
        cancelAuto();
        const captured = job, selected = captured?.visible[captured.choice];
        if (!event.defaultPrevented && !event.isComposing && !editor.snapshot().composing && event.inputType === "insertText" && event.data?.length === 1 && captured && selected?.commitCharacters.includes(event.data)) {
            if (apply("replace", captured.id, event.data)) { event.preventDefault(); return; }
            // An unresolved choice must not consume a user's character.
            expire("Completion dismissed while resolution was pending."); return;
        }
        if (event.defaultPrevented || event.isComposing || editor.snapshot().composing || options.automatic === false || event.inputType !== "insertText" || !event.data || event.data.length > 64) {
            if (job) expire("LSP completion expired after input."); return;
        }
        const selections = editor.view.getSnapshot().selectionSet, caret = selections.ranges[selections.primary]!;
        if (selections.ranges.length !== 1 || caret.anchor !== caret.head) { if (job) expire("Place one caret before completion."); return; }
        const isWord = Array.from(event.data).every(value => word.test(value)), trigger = triggers().has(event.data) ? event.data : undefined;
        if (!isWord && !trigger && !connecting) { if (job) expire("LSP completion expired after input."); return; }
        inputIntent = { revision: workspace.document(documentId).revision, selections, caret: caret.head, data: event.data, word: isWord, trigger, reused: false };
    };
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
        if (phase === "disconnected" || phase === "disposed") { cancelAuto(); release(); clearDiagnostics(); }
        else if (job?.capture && !bindingCurrent(job)) { expire("LSP completion expired after provider capabilities changed."); return; }
        if (phase === "ready" && inputIntent) scheduleAuto();
        publish(cell.get().message);
    }),
    workspace.observeDocument(documentId).subscribe(() => {
        clearDiagnostics(); if (applying) return;
        const intent = inputIntent, captured = job, document = workspace.document(documentId), selected = editor.view.getSnapshot().selectionSet, caret = selected.ranges[selected.primary]!;
        if (intent) intent.after = selected;
        if (captured?.choices && intent?.word && intent.revision === captured.revision && intent.selections === captured.selections && intent.caret === captured.caret
            && document.change && authority() === captured.authority && bindingCurrent(captured) && selected.ranges.length === 1 && caret.anchor === caret.head && caret.head === intent.caret + intent.data.length
            && document.buffer.slice(intent.caret, caret.head) === intent.data && editor.view.folding.getSnapshot().generation === captured.folds + 1) {
            const source = Object.freeze({ ...captured.choices.items[0]!.source, revision: document.revision, buffer: document.buffer });
            const selectedIndex = captured.choices.items.indexOf(captured.visible[captured.choice]!);
            const rebased = captured.choices.items.map(item => rebaseLspCompletion(item, source, document.change!, intent.caret));
            if (rebased.every((item): item is LspCompletion => !!item)) {
                cancelResolution(captured);
                captured.choices = Object.freeze({ ...captured.choices, items: Object.freeze(rebased) }); captured.revision = document.revision; captured.buffer = document.buffer;
                captured.caret = caret.head; captured.selections = selected; captured.folds = editor.view.folding.getSnapshot().generation;
                captured.pendingList = false; captured.requestGeneration++; captured.call?.cancel(); filter(captured, true); intent.reused = true;
                const choice = selectedIndex < 0 ? -1 : captured.visible.indexOf(rebased[selectedIndex]!); if (choice >= 0) captured.choice = choice;
                publish("LSP completion follows the typed prefix."); scheduleAuto(); return;
            }
        }
        expire("LSP results expired after an edit."); if (intent) scheduleAuto();
    }), editor.view.subscribe(() => { const selected = editor.view.getSnapshot().selectionSet;
        if (inputIntent?.after && selected !== inputIntent.after) cancelAuto();
        if (!applying && job && selected !== job.selections) { cancelAuto(); expire("LSP completion expired after selection changed."); }
    }),
    resource.metadata.subscribe(() => { if (job && authority() !== job.authority) expire("LSP completion expired after authority changed."); }),
    workspace.tabState.subscribe(() => { if (!available()) { clearDiagnostics(); expire("Captured LSP view is unavailable."); } })];
    editor.input.addEventListener("compositionstart", () => { cancelAuto(); expire("Finish composition before completion."); }, { signal: listeners.signal });
    editor.input.addEventListener("beforeinput", event => { const started = clock.performance.now();
        try { typed(event); } finally { counters.completionBeforeInputEvents++; counters.lastCompletionBeforeInputMs = clock.performance.now() - started; }
    }, { capture: true, signal: listeners.signal });
    editor.input.addEventListener("input", () => { if (inputIntent) scheduleAuto(); }, { signal: listeners.signal });
    editor.input.addEventListener("compositionend", event => {
        if (!event.data || options.automatic === false || !Array.from(event.data).every(value => word.test(value))) return;
        const selections = editor.view.getSnapshot().selectionSet, caret = selections.ranges[selections.primary]!;
        inputIntent = { revision: workspace.document(documentId).revision, selections, caret: caret.head, data: event.data, word: true, trigger: undefined, reused: false }; scheduleAuto();
    }, { signal: listeners.signal });
    const keydown = (event: KeyboardEvent) => {
        if (event.defaultPrevented || event.isComposing || editor.snapshot().composing) return;
        if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.code === "Space") { event.preventDefault(); request(); return; }
        if (event.key === "Escape" && (job || inputIntent || autoFrame !== undefined)) { event.preventDefault(); cancel(); return; }
        if (!job?.visible.length) return;
        if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            const next = (job.choice + (event.key === "ArrowDown" ? 1 : job.visible.length - 1)) % job.visible.length;
            if (chooseCompletion(next, job.id)) event.preventDefault();
        } else if (!event.ctrlKey && !event.metaKey && !event.shiftKey && (event.key === "Enter" || event.key === "Tab" && !event.altKey)) {
            if (apply(event.key === "Tab" ? "insert" : "replace", job.id)) event.preventDefault(); else cancel();
        }
    };
    editor.input.addEventListener("keydown", event => { const started = clock.performance.now();
        try { keydown(event); } finally { counters.completionKeydownEvents++; counters.lastCompletionKeydownMs = clock.performance.now() - started; }
    }, { capture: true, signal: listeners.signal });
    updateDiagnostics(); if (options.autoConnect !== false) connect();
    return Object.freeze({ state, request: () => { notifications.assertWritable(); if (!disposed) request(); },
        apply: (mode, completionId) => { notifications.assertWritable(); return !disposed && apply(mode, completionId); },
        chooseCompletion: (index, completionId) => { notifications.assertWritable(); return !disposed && chooseCompletion(index, completionId); },
        cancel: () => { notifications.assertWritable(); if (!disposed) cancel(); }, connect: () => { notifications.assertWritable(); connect(); },
        selectDiagnostic: index => { notifications.assertWritable(); return !disposed && selectDiagnostic(index); },
        customRequest: (method, params) => { notifications.assertWritable(); return session.request(method, params).result; },
        snapshot: () => Object.freeze({ ...counters, connected: session.state.getSnapshot().phase === "ready", pending: cell.get().pending, offer: !!job?.visible.length, diagnostics: diagnostics.length, diagnosticRevision, transport: "lsp3.17", protocol: session.snapshotOwnership() }),
        destroy: () => { if (disposed) return; notifications.assertWritable(); disposed = true; cancelAuto(); for (const stop of stops) stop(); listeners.abort(); release(); binding.close(); session.dispose(); clearDiagnostics(); publish("LSP editor disposed."); for (const stop of [...observers]) stop(); } });
}
