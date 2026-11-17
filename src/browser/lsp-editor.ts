import { ProtocolDecodeError, rpcCodes, staleRequest } from "../protocol/wire.ts";
import { isFocused } from "./dom-focus.ts";
import { codeWordConstituentPattern } from "../core/words.ts";
import type { ResourceLease, ResourceMetadata, TabId, Workspace } from "../core/workspace.ts";
import type { SelectionSet } from "../core/selections.ts";
import { planSnippetEdit, planSnippetChoice, snippetChoiceText } from "../core/snippets.ts";
import type { SnippetStop } from "../core/snippets.ts";
import type { TextBuffer } from "../core/text-buffer.ts";
import type { FoldIndex } from "../core/folding.ts";
import type { EditingCandidate } from "./editing-candidate.ts";
import { RpcError, createLspCompletionClient, lspCompletionPlan } from "../protocol/index.ts";
import type { LspCall, LspCompletion, LspCompletionBatch, LspCompletionResolution, LspCompletions, LspCompletionFallback, LspDiagnostics, LspDocument, LspScopeAccess, LspWorkspace, JsonValue } from "../protocol/index.ts";
import { Store } from "../core/observable.ts";
import type { Observable } from "../core/observable.ts";

type Job = { id: number; revision: number; buffer: TextBuffer; caret: number; selections: SelectionSet; indentation: ReturnType<EditingCandidate["languageConfiguration"]>; authority: ResourceMetadata; folds: number; foldIndex: FoldIndex; lease: ResourceLease;
    call?: LspCall<LspCompletionBatch>; batch?: LspCompletionBatch; choices?: LspCompletions; visible: readonly LspCompletion[]; choice: number; cancelled: boolean; pendingList: boolean; requestGeneration: number;
    acceptance?: Readonly<{ id: number; item: LspCompletion; mode: "insert" | "replace" }> | undefined;
    resolution?: { item: LspCompletion; revision: number; call?: LspCall<LspCompletionResolution> } | undefined };
type Input = { revision: number; selections: SelectionSet; caret: number; data: string; word: boolean; trigger: string | undefined; reused: boolean; after?: SelectionSet };
type Invocation = Readonly<{ kind: 1 | 2 | 3; character?: string; automatic?: boolean }>;
export type LspEditorDiagnostic = Readonly<{ from: number; to: number; message: string }>;
export type LspEditorSnippet = Readonly<{ id: number; stop: number; position: number; count: number; choices: readonly string[]; choiceIndex: number }>;
export type LspEditorSnapshot = Readonly<{ message: string; connected: boolean; pending: boolean; offerText: string | null;
    snippet: LspEditorSnippet | null; omittedCompletions: LspCompletions["omitted"];
    diagnostics: readonly LspEditorDiagnostic[]; diagnosticRevision: number; diagnosticsPending: boolean; choices: readonly string[]; choiceIndex: number; completionId: number; completionIncomplete: boolean; completionDetail: string; resolving: boolean; unversionedDiagnostics: readonly string[] }>;
export type LspEditorOptions = Readonly<{ provider: LspWorkspace; autoConnect?: boolean; automatic?: boolean;
    /** Narrow explicit requests using each item's captured edit prefix, as automatic requests do. */
    filterManualCompletions?: boolean; canCapture?: () => boolean;
    prepareCompletion?: (scope: LspScopeAccess) => Promise<unknown>; onError?: (error: unknown) => void }>;
export type LspEditorController = Readonly<{ state: Observable<LspEditorSnapshot>; request: () => void; apply: (mode: "insert" | "replace", completionId?: number) => boolean;
    accept: (mode: "insert" | "replace", completionId?: number) => boolean;
    moveSnippet: (direction: -1 | 1, snippetId?: number) => boolean; chooseSnippet: (index: number, snippetId?: number) => boolean;
    chooseCompletion: (index: number, completionId?: number) => boolean; cancel: () => void; connect: () => void; selectDiagnostic: (index: number) => boolean;
    customRequest: (method: string, params: JsonValue) => Promise<JsonValue>; destroy: () => void;
    snapshot: () => Readonly<{ posted: number; received: number; applied: number; stale: number; cancelled: number; invalid: number; failed: number; resolved: number;
        completionBeforeInputEvents: number; lastCompletionBeforeInputMs: number; completionKeydownEvents: number; lastCompletionKeydownMs: number;
        connected: boolean; pending: boolean; offer: boolean; diagnostics: number; diagnosticRevision: number; diagnosticsPending: boolean; transport: "lsp3.17"; protocol: ReturnType<LspWorkspace["snapshot"]>["protocol"] }> }>;
const word = new RegExp(`^(?:${codeWordConstituentPattern})$`, "u");
// IDs also distinguish retained host controls from lists belonging to another mounted view.
let completionSequence = 0;
let snippetSequence = 0;

/** Captured editor coordination; hosts render controls and supply provider/custom-message policy. */
export function createLspEditor(workspace: Workspace, tabId: TabId, editor: EditingCandidate, options: LspEditorOptions): LspEditorController {
    const target = workspace.captureTab(tabId), documentId = editor.view.documentId, resource = workspace.resourceForDocument(documentId), tab = workspace.resolveTab(target);
    if (tab?.surface.kind !== "text" || tab.surface.documentId !== documentId || !workspace.ownsDocumentView(editor.view)) throw new Error("LSP provider requires the captured document view.");
    const listeners = new AbortController(), scope = options.provider.createScope();
    let binding: LspDocument, completion: ReturnType<typeof createLspCompletionClient>;
    try { binding = scope.attachDocument(documentId); completion = createLspCompletionClient(options.provider); }
    catch (error) { scope.release(); throw error; }
    const diagnosticState = scope.observeDiagnostics(binding);
    const counters = { posted: 0, applied: 0, stale: 0, cancelled: 0, invalid: 0, failed: 0, resolved: 0,
        completionBeforeInputEvents: 0, lastCompletionBeforeInputMs: 0, completionKeydownEvents: 0, lastCompletionKeydownMs: 0 };
    let job: Job | undefined, disposed = false, connecting: Promise<void> | undefined, inputIntent: Input | undefined, autoFrame: number | undefined, autoTurns = 0, applying = false;
    type SnippetSession = { id: number; stops: readonly SnippetStop[]; active: number; revision: number; authority: ResourceMetadata;
        indentation: Job["indentation"]; maxUnits: number; primaryGroup: number };
    let snippet: SnippetSession | undefined, snippetChanging = false;
    const owner = editor.element.ownerDocument, clock = owner.defaultView!;
    const emptyDiagnostics: readonly LspEditorDiagnostic[] = Object.freeze([]), emptyMessages: readonly string[] = Object.freeze([]);
    let labelItems: readonly LspCompletion[] | undefined, labels = emptyMessages;
    let diagnostics = emptyDiagnostics, unversioned = emptyMessages, diagnosticRevision = -1;
    let diagnosticsPending = false, diagnosticResult: LspDiagnostics | null = null;
    const notifications = workspace.createNotificationScope(error => options.onError?.(error)), observers = new Set<() => void>();
    const cell = new Store<LspEditorSnapshot>(Object.freeze({ message: "LSP provider disconnected; local editing remains available.", connected: false, pending: false, offerText: null, diagnostics, diagnosticRevision, diagnosticsPending, choices: Object.freeze([]), choiceIndex: 0, completionId: 0, completionIncomplete: false, completionDetail: "", resolving: false, unversionedDiagnostics: Object.freeze([]), snippet: null, omittedCompletions: Object.freeze([]) }), notifications);
    const state: Observable<LspEditorSnapshot> = Object.freeze({ getSnapshot: cell.observable.getSnapshot, subscribe: listener => {
        notifications.assertWritable(); if (disposed) throw new Error("LSP editor is disposed."); const stop = cell.observable.subscribe(listener);
        const release = () => { stop(); observers.delete(release); }; observers.add(release); return release;
    } });
    const available = () => { const tab = workspace.resolveTab(target); return !disposed && editor.element.isConnected && !editor.activity().disposed && workspace.ownsDocumentView(editor.view)
        && tab?.surface.kind === "text" && tab.surface.documentId === documentId && !!workspace.observeDocument(documentId).getSnapshot(); };
    const idle = () => { const m = editor.activity(); return !m.composing && !m.pendingInput && !m.pendingCommand && !m.pendingWord && !m.pendingGrapheme && !m.disposed && !editor.input.disabled && (options.canCapture?.() ?? true); };
    const authority = resource.metadata.getSnapshot;
    const authorityCurrent = (before: ResourceMetadata) => {
        const after = authority(), left = before.capabilities.edit, right = after.capabilities.edit;
        return before === after || before.state === after.state
            && (left === right || left.length === right.length && left.every((origin, index) => origin === right[index]))
            && before.editLock?.owner === after.editLock?.owner && before.editLock?.origin === after.editLock?.origin;
    };
    const indentationCurrent = (before: Job["indentation"]) => { const after = editor.languageConfiguration(); return before.tabSize === after.tabSize && before.insertSpaces === after.insertSpaces; };
    const current = (captured: Job) => job === captured && !captured.cancelled && available() && idle() && indentationCurrent(captured.indentation) && workspace.document(documentId).revision === captured.revision && workspace.document(documentId).buffer === captured.buffer
        && editor.view.getSnapshot().selectionSet === captured.selections && captured.foldIndex.sameProjection(editor.view.folding.getSnapshot().index) && authorityCurrent(captured.authority) && captured.lease.active();
    const bindingCurrent = (captured: Job) => captured.batch?.isBindingCurrent() ?? false;
    const primaryOccurrence = (captured: SnippetSession, stop: SnippetStop) => Math.max(0, stop.ranges.findIndex(range => (range.group ?? 0) === captured.primaryGroup));
    const snippetChoiceIndex = (captured: SnippetSession, stop: SnippetStop) => {
        if (!stop.choices.length) return -1;
        const range = stop.ranges[primaryOccurrence(captured, stop)]!, text = workspace.document(documentId).buffer.slice(range.from, range.to);
        return stop.choices.findIndex((_choice, index) => { try { return snippetChoiceText(stop, range, index, captured.maxUnits) === text; }
            catch (error) { if (error instanceof RangeError) return false; throw error; } });
    };
    const publish = (message: string) => {
        const visible = job?.visible;
        if (visible !== labelItems) { labelItems = visible; labels = visible ? Object.freeze(visible.map(item => item.label)) : emptyMessages; }
        const selected = job?.visible[job.choice], activeStop = snippet?.stops[snippet.active], changed = new Set<Store<unknown>>(); cell.set(Object.freeze({ message, connected: scope.state.getSnapshot().phase === "ready", pending: !!job && (job.pendingList || !!job.resolution || !!selected?.resolve),
        offerText: selected?.label ?? null, choices: labels, choiceIndex: job?.choice ?? 0, completionId: job?.id ?? 0,
        completionIncomplete: job?.choices?.incomplete ?? false, completionDetail: selected ? [selected.detail, selected.documentation].filter(Boolean).join("\n") : "", resolving: !!job?.resolution,
        snippet: snippet ? Object.freeze({ id: snippet.id, stop: snippet.stops[snippet.active]!.index, position: snippet.active + 1,
            count: snippet.stops.length - 1, choices: activeStop!.choices, choiceIndex: snippetChoiceIndex(snippet, activeStop!) }) : null,
        omittedCompletions: job?.choices?.omitted ?? Object.freeze([]), diagnostics, diagnosticRevision, diagnosticsPending, unversionedDiagnostics: unversioned }), changed); notifications.deliver([...changed]); };
    const release = (retain = false) => {
        const old = job; job = undefined; if (!old) return; old.cancelled = true; old.call?.cancel(); old.resolution?.call?.cancel(); old.resolution = undefined;
        if (!retain) completion.cancel();
        // Workspace observers run during commit delivery; retention cleanup must follow that delivery.
        void Promise.resolve().then(() => old.lease.release());
    };
    const cancelAuto = () => { inputIntent = undefined; if (autoFrame !== undefined) clock.cancelAnimationFrame(autoFrame); autoFrame = undefined; autoTurns = 0; };
    const cancelResolution = (captured: Job) => { const old = captured.resolution; captured.resolution = undefined; old?.call?.cancel(); };
    const expire = (message: string) => { if (job) counters.stale++; release(); publish(message); };
    const clearDiagnostics = () => { diagnostics = emptyDiagnostics; unversioned = emptyMessages; diagnosticRevision = -1; diagnosticsPending = false; diagnosticResult = null; };
    const connect = () => {
        if (disposed || connecting || scope.state.getSnapshot().phase === "ready") return;
        const work = scope.ensureConnected(); connecting = work; publish("LSP provider connecting.");
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
        const selected = captured.visible[captured.choice], prefixes = new Map<number, string>();
        captured.visible = Object.freeze((captured.choices?.items ?? []).filter(item => {
            // Providers may include punctuation (for example the member-access dot) in their
            // edit/filter prefix. Query that exact range, with the same bounded word-read limit.
            const from = item.primary.from, units = captured.caret - from;
            if (!prefixes.has(from)) prefixes.set(from, prefix && units >= 0 && units <= 2048 ? captured.buffer.slice(from, captured.caret).toLowerCase() : "");
            const content = prefixes.get(from)!;
            return !content || item.filterText.toLowerCase().startsWith(content);
        }));
        const previous = selected && captured.visible.findIndex(item => item === selected); captured.choice = previous !== undefined && previous >= 0 ? previous : Math.max(0, captured.visible.findIndex(item => item.preselect));
        captured.id = ++completionSequence;
    };
    const request = (invocation: Invocation = { kind: 1 }) => {
        cancelAuto();
        snippet = undefined;
        if (!available() || !idle()) { publish("Finish pending typing, navigation or composition before completion."); return; }
        const selections = editor.view.getSnapshot().selectionSet, selected = selections.ranges[selections.primary]!;
        if (selections.ranges.some(range => range.anchor !== range.head)) { publish("Place collapsed carets before requesting completion."); return; }
        if (!connecting && scope.state.getSnapshot().phase !== "ready") { publish("Reconnect the LSP provider before requesting completion."); return; }
        const previous = invocation.automatic && job?.choices && current(job) && bindingCurrent(job) ? job : undefined, provisional = previous?.choices, provisionalVisible = previous?.visible;
        release(!!previous); const document = workspace.document(documentId);
        const captured: Job = { id: ++completionSequence, revision: document.revision, buffer: document.buffer, caret: selected.head, selections, indentation: editor.languageConfiguration(), authority: authority(), folds: editor.view.folding.getSnapshot().generation, foldIndex: editor.view.folding.getSnapshot().index,
            lease: workspace.acquire(resource.id), choice: previous?.choice ?? 0, cancelled: false, pendingList: true, requestGeneration: 0, visible: provisionalVisible ?? Object.freeze([]), ...(provisional ? { choices: provisional } : {}), ...(previous?.batch ? { batch: previous.batch } : {}) };
        job = captured; counters.posted++; publish("LSP completion pending.");
        void (async () => {
            if (connecting) await connecting; if (captured.requestGeneration !== 0) return; if (!current(captured)) throw staleRequest("Completion capture changed.");
            captured.call = completion.run(document, selected.head, {
                context: invocation.kind === 2 ? { triggerKind: 2, triggerCharacter: invocation.character! } : { triggerKind: invocation.kind },
                fallback: () => wordRange(document.buffer, selected.head), indentation: captured.indentation,
                ...(previous?.batch ? { retain: previous.batch } : {})
            }, async scope => {
                if (options.prepareCompletion) await options.prepareCompletion(scope);
                if (captured.requestGeneration !== 0 || !current(captured)) throw staleRequest("Completion capture changed.");
            });
            const choices = await captured.call.result;
            if (captured.requestGeneration !== 0) return;
            if (!current(captured) || !choices.isCurrent()) throw staleRequest("Completion capture changed.");
            captured.batch = choices; captured.choices = choices;
            captured.pendingList = false; filter(captured, invocation.automatic === true || options.filterManualCompletions === true);
            if (!captured.visible.length) { const omitted = choices.omitted.length; release(); publish(omitted ? `${omitted} unsupported completion choices omitted.` : "No LSP completions for this caret."); return; }
            publish("LSP completion ready.");
            resolveSelected(captured);
        })().catch(error => {
            if (job !== captured || captured.requestGeneration !== 0) return; release();
            if (error instanceof RpcError && error.code === rpcCodes.contentModified) { counters.stale++; publish("Stale LSP completion rejected."); }
            else if (error instanceof ProtocolDecodeError) { counters.invalid++; publish("Malformed or unsupported LSP completion rejected."); }
            else { counters.failed++; publish("LSP provider unavailable; local editing remains available."); }
        });
    };
    const resolveSelected = (captured: Job) => {
        const item = captured.visible[captured.choice];
        if (!item?.resolve || captured.pendingList || captured.resolution?.item === item || !current(captured) || !bindingCurrent(captured)) return;
        cancelResolution(captured); const resolution: NonNullable<Job["resolution"]> = { item, revision: captured.revision }; captured.resolution = resolution;
        const valid = (batch = captured.batch) => {
            if (job === captured && captured.resolution === resolution && !indentationCurrent(captured.indentation)) expire("Completion expired after indentation settings changed.");
            return job === captured && captured.resolution === resolution && captured.visible[captured.choice] === item && captured.revision === resolution.revision && current(captured) && !!batch?.isBindingCurrent();
        };
        publish("Resolving the selected completion.");
        void (async () => {
            resolution.call = completion.resolve(captured.batch!, item); const value = await resolution.call.result;
            // Resolution publishes a replacement batch; validate the view before adopting its identity.
            if (!valid(value.batch) || !value.batch.isCurrent()) return;
            captured.batch = value.batch; captured.choices = value.batch;
            const resolved = value.item, acceptance = captured.acceptance;
            if (!resolved) {
                captured.acceptance = undefined; captured.resolution = undefined;
                captured.visible = Object.freeze(captured.visible.filter(value => value !== item)); captured.choice = Math.min(captured.choice, Math.max(0, captured.visible.length - 1)); captured.id = ++completionSequence;
                publish(`Unsupported snippet omitted: ${item.label}. ${value.reason}`); resolveSelected(captured); return;
            }
            const previous = captured.visible;
            captured.visible = Object.freeze(previous.map(value => value === item ? resolved : value)); captured.resolution = undefined; counters.resolved++;
            // The decoder forbids label changes during resolution; the published labels still apply.
            if (labelItems === previous) labelItems = captured.visible;
            publish("LSP completion ready.");
            if (acceptance?.item === item) queueMicrotask(() => {
                if (job === captured && captured.acceptance === acceptance && captured.id === acceptance.id && captured.visible[captured.choice] === resolved && isFocused(editor.input)) {
                    captured.acceptance = undefined; apply(acceptance.mode, acceptance.id);
                }
            });
        })().catch(error => { if (job !== captured || captured.resolution !== resolution) return;
            if (error instanceof ProtocolDecodeError) counters.invalid++; else if (error instanceof RpcError && error.code === rpcCodes.contentModified) counters.stale++; else counters.failed++;
            release(); publish("Completion resolution failed or expired; request fresh choices."); });
    };
    const apply = (mode: "insert" | "replace", completionId?: number, character?: string): boolean => {
        if (completionId !== undefined && job?.id !== completionId) return false;
        const captured = job, completion = captured?.visible[captured.choice]; if (!captured || !completion) return false;
        if (!current(captured) || !bindingCurrent(captured) || editor.input.readOnly) { expire("Stale or unauthorized LSP completion rejected."); return false; }
        if (completion.resolve || captured.resolution) { resolveSelected(captured); publish("Wait for the selected completion to finish resolving."); return false; }
        let plan;
        try { plan = lspCompletionPlan(completion, mode, character, captured.selections); }
        catch (error) { if (!(error instanceof RangeError || error instanceof TypeError)) throw error;
            counters.invalid++; release(); publish("Completion cannot apply to all captured carets; no text changed."); return false; }
        applying = true;
        let result;
        const first = plan.snippet?.[0];
        try { result = workspace.edit({ documentId, expectedRevision: captured.revision, origin: "human", edits: plan.edits, view: editor.view,
            selectionSet: plan.selectionSet, history: { kind: "replace" } }); } finally { applying = false; }
        if (!result.applied) { expire(`LSP completion rejected: ${result.reason}.`); return false; }
        if (first && first.index !== 0) snippet = { id: ++snippetSequence, stops: plan.snippet!, active: 0, revision: result.revision, authority: authority(),
            indentation: captured.indentation, maxUnits: completion.insertion.maxUnits, primaryGroup: captured.selections.primary };
        counters.applied++; cancelAuto(); release(); publish("LSP completion applied."); editor.viewport.revealOffset(editor.view.getSnapshot().selection.head); editor.focus(); return true;
    };
    const accept = (mode: "insert" | "replace", id?: number): boolean => {
        const captured = job, item = captured?.visible[captured.choice];
        if (!captured || !item || id !== undefined && captured.id !== id) return false;
        if (!current(captured) || !bindingCurrent(captured) || editor.input.readOnly) { expire("Stale or unauthorized LSP completion rejected."); return false; }
        if (!item.resolve && !captured.resolution) return apply(mode, id);
        captured.acceptance = Object.freeze({ id: captured.id, item, mode }); resolveSelected(captured); publish("Accepting the selected completion after resolution."); return true;
    };
    const chooseCompletion = (index: number, completionId?: number): boolean => {
        if (!job?.choices || completionId !== undefined && completionId !== job.id || !Number.isSafeInteger(index) || index < 0 || index >= job.visible.length || !current(job)) return false;
        job.acceptance = undefined; cancelResolution(job); job.choice = index; if (job.pendingList) { job.requestGeneration++; job.call?.cancel(); job.pendingList = false; } publish("LSP completion selected."); resolveSelected(job); return true;
    };
    const cancel = () => { cancelAuto(); if (job) counters.cancelled++; release();
        if (snippet) { snippet = undefined; if (available() && !editor.activity().composing) editor.view.setSelection(workspace.document(documentId).revision, editor.view.getSnapshot().selection); }
        publish("LSP request or snippet cancelled."); };
    const snippetCurrent = (captured: SnippetSession) => snippet === captured && available() && !editor.input.readOnly && indentationCurrent(captured.indentation) && authorityCurrent(captured.authority) && workspace.document(documentId).revision === captured.revision;
    const moveSnippet = (direction: -1 | 1, id?: number): boolean => {
        const captured = snippet;
        if (!captured || direction !== -1 && direction !== 1 || id !== undefined && id !== captured.id || !snippetCurrent(captured) || !idle()) return false;
        const active = Math.max(0, captured.active + direction), stop = captured.stops[active]; if (!stop) return false;
        applying = true;
        try {
            if (!editor.view.setSelections(captured.revision, stop.ranges.map(range => ({ anchor: range.from, head: stop.index === 0 ? range.from : range.to })), primaryOccurrence(captured, stop))) return false;
            snippet = stop.index === 0 ? undefined : { ...captured, active, id: ++snippetSequence };
        } finally { applying = false; }
        publish(stop.index === 0 ? "Snippet complete." : "Snippet placeholder selected."); editor.viewport.revealOffset(editor.view.getSnapshot().selection.head); editor.focus(); return true;
    };
    const chooseSnippet = (index: number, id?: number): boolean => {
        const captured = snippet, stop = captured?.stops[captured.active], value = stop?.choices[index];
        if (!captured || !stop || value === undefined || id !== undefined && id !== captured.id || !snippetCurrent(captured) || !idle()) return false;
        const document = workspace.document(documentId); let plan;
        try { plan = planSnippetChoice(document.buffer, captured.stops, captured.active, index, primaryOccurrence(captured, stop), captured.maxUnits); }
        catch (error) { if (!(error instanceof RangeError)) throw error; publish("Snippet choice exceeds the document limit; no text changed."); return false; }
        if (!plan) return false; applying = true;
        let result;
        try { result = workspace.edit({ documentId, expectedRevision: document.revision, origin: "human", edits: plan.edits, selectionSet: plan.selectionSet, view: editor.view, history: { kind: "replace" } }); }
        finally { applying = false; }
        if (!result.applied) return false;
        snippet = { ...captured, stops: plan.stops, revision: result.revision, id: ++snippetSequence }; publish("Snippet choice applied."); editor.focus(); return true;
    };
    let stopTransform: () => void;
    try { stopTransform = editor.registerEditTransform(edit => {
        const captured = snippet; if (!captured) return;
        if (!snippetCurrent(captured) || edit.expectedRevision !== captured.revision) { snippet = undefined; return; }
        const plan = planSnippetEdit(workspace.document(documentId).buffer, captured.stops, captured.active, edit.edits, editor.view.getSnapshot().selectionSet, edit.selectionSet, edit.adjustNewlines);
        if (!plan) { snippet = undefined; return; }
        snippetChanging = true;
        return { edits: plan.edits, selectionSet: plan.selectionSet, complete: applied => {
            snippetChanging = false;
            if (snippet !== captured) return;
            snippet = applied ? { ...captured, stops: plan.stops, revision: workspace.document(documentId).revision, id: ++snippetSequence } : undefined;
            publish(applied ? "Snippet placeholder edited." : "Snippet edit rejected.");
        } };
    }); } catch (error) { completion.dispose(); binding.close(); scope.release(); throw error; }
    const triggers = () => new Set(scope.featureOptions("textDocument/completion", binding).flatMap(option => Array.isArray(option.triggerCharacters)
        ? option.triggerCharacters.filter((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 8).slice(0, 64) : []));
    const scheduleAuto = () => {
        if (options.automatic === false || !inputIntent || autoFrame !== undefined) return;
        autoFrame = clock.requestAnimationFrame(() => {
            autoFrame = undefined;
            if (!inputIntent || disposed || !available() || !isFocused(editor.input) || editor.input.readOnly || editor.activity().composing) { cancelAuto(); return; }
            if (!idle()) { if (++autoTurns < 120) scheduleAuto(); return; }
            if (scope.state.getSnapshot().phase !== "ready" && connecting) { if (++autoTurns < 120) scheduleAuto(); return; }
            const intent = inputIntent, selected = editor.view.getSnapshot().selectionSet, caret = selected.ranges[selected.primary]!;
            if (selected.ranges.length !== 1 || caret.anchor !== caret.head || !workspace.document(documentId).change || workspace.document(documentId).change!.origin !== "human") { cancelAuto(); return; }
            if (!connecting && scope.state.getSnapshot().phase !== "ready" || scope.state.getSnapshot().phase === "ready" && !scope.canRequest("textDocument/completion", binding)) { cancelAuto(); return; }
            const character = triggers().has(intent.data) ? intent.data : undefined;
            if (!intent.word && !character) { cancelAuto(); return; }
            if (!character && intent.reused && job?.choices && !job.choices.incomplete && job.visible.length) { cancelAuto(); resolveSelected(job); return; }
            const kind = character ? 2 : intent.reused && job?.choices?.incomplete ? 3 : 1;
            request({ kind, automatic: true, ...(character ? { character } : {}) });
        });
    };
    const typed = (event: InputEvent) => {
        cancelAuto();
        if (snippet) return;
        const captured = job, selected = captured?.visible[captured.choice];
        if (!event.defaultPrevented && !event.isComposing && !editor.activity().composing && event.inputType === "insertText" && event.data?.length === 1 && captured && selected?.commitCharacters.includes(event.data)) {
            if (apply("replace", captured.id, event.data)) { event.preventDefault(); return; }
            // An unresolved choice must not consume a user's character.
            expire("Completion dismissed while resolution was pending."); return;
        }
        if (event.defaultPrevented || event.isComposing || editor.activity().composing || options.automatic === false || event.inputType !== "insertText" || !event.data || event.data.length > 64) {
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
    const updateDiagnostics = (announce = true) => {
        const state = diagnosticState.getSnapshot(); counters.stale += state.stale - diagnosticStale; counters.invalid += state.invalid - diagnosticInvalid;
        diagnosticStale = state.stale; diagnosticInvalid = state.invalid;
        const decoded = available() && state.isPlacementCurrent() ? state.result : null;
        if (!decoded) { clearDiagnostics(); if (announce) publish(cell.get().message); return; }
        if (decoded !== diagnosticResult) {
            diagnostics = Object.freeze(decoded.items.filter(item => item.placement === "placed").map(item => Object.freeze({ from: item.from!, to: item.to!, message: item.message })));
            unversioned = Object.freeze(decoded.items.filter(item => decoded.freshness === "unversioned" || item.placement !== "placed")
                .map(item => `${item.message}${item.placement === "placed" ? " (provider version unknown)" : " (range outside the current snapshot)"}`));
            diagnosticResult = decoded;
        }
        diagnosticsPending = state.status === "pending";
        diagnosticRevision = decoded.snapshotRevision;
        if (announce) publish(diagnosticsPending ? "Diagnostic locations follow local edits; analysis is pending."
            : decoded.freshness === "unversioned" ? "LSP diagnostic locations use the current snapshot; provider version is unknown." : "Versioned LSP diagnostics updated.");
    };
    const stops = [diagnosticState.subscribe(updateDiagnostics), options.provider.state.subscribe(() => {
        const phase = scope.state.getSnapshot().phase;
        if (phase === "disconnected" || phase === "disposed") { cancelAuto(); release(); clearDiagnostics(); }
        else if (job?.batch && !bindingCurrent(job)) { expire("LSP completion expired after provider capabilities changed."); return; }
        if (phase === "ready" && inputIntent) scheduleAuto();
        publish(cell.get().message);
    }),
    workspace.observeDocument(documentId).subscribe(() => {
        updateDiagnostics(false); if (applying || snippetChanging) return;
        snippet = undefined;
        const intent = inputIntent, captured = job, document = workspace.document(documentId), selected = editor.view.getSnapshot().selectionSet, caret = selected.ranges[selected.primary]!;
        if (intent) intent.after = selected;
        if (captured?.choices?.items.length && intent?.word && intent.revision === captured.revision && intent.selections === captured.selections && intent.caret === captured.caret
            && document.change && authorityCurrent(captured.authority) && bindingCurrent(captured) && selected.ranges.length === 1 && caret.anchor === caret.head && caret.head === intent.caret + intent.data.length
            && document.buffer.slice(intent.caret, caret.head) === intent.data && editor.view.folding.getSnapshot().generation === captured.folds + 1) {
            const selectedIndex = captured.choices.items.indexOf(captured.visible[captured.choice]!);
            const rebased = captured.batch && completion.rebase(captured.batch, document);
            if (rebased) {
                captured.acceptance = undefined; cancelResolution(captured);
                captured.batch = rebased; captured.choices = rebased; captured.revision = document.revision; captured.buffer = document.buffer;
                captured.caret = caret.head; captured.selections = selected; captured.folds = editor.view.folding.getSnapshot().generation; captured.foldIndex = editor.view.folding.getSnapshot().index;
                captured.pendingList = false; captured.requestGeneration++; captured.call?.cancel(); filter(captured, true); intent.reused = true;
                const choice = selectedIndex < 0 ? -1 : captured.visible.indexOf(rebased.items[selectedIndex]!); if (choice >= 0) captured.choice = choice;
                publish("LSP completion follows the typed prefix."); scheduleAuto(); return;
            }
        }
        expire("LSP results expired after an edit."); if (intent) scheduleAuto();
    }), editor.view.subscribe(() => { const selected = editor.view.getSnapshot().selectionSet;
        if (snippet && !applying && !snippetChanging && !selected.ranges.every(selection => snippet!.stops[snippet!.active]!.ranges.some(range => range.from <= Math.min(selection.anchor, selection.head) && range.to >= Math.max(selection.anchor, selection.head)))) {
            snippet = undefined; publish("Snippet ended after selection left its placeholder.");
        }
        if (snippet && !applying && !snippetChanging) {
            const primary = selected.ranges[selected.primary]!, range = snippet.stops[snippet.active]!.ranges.find(range => range.from <= Math.min(primary.anchor, primary.head) && range.to >= Math.max(primary.anchor, primary.head));
            if (range) snippet.primaryGroup = range.group ?? 0;
        }
        if (inputIntent?.after && selected !== inputIntent.after) cancelAuto();
        if (!applying && job && selected !== job.selections) { cancelAuto(); expire("LSP completion expired after selection changed."); }
    }),
    editor.view.folding.subscribe(() => {
        if (!job || workspace.document(documentId).revision !== job.revision) return;
        const folds = editor.view.folding.getSnapshot();
        if (job.foldIndex.sameProjection(folds.index)) { job.folds = folds.generation; job.foldIndex = folds.index; }
        else expire("LSP completion expired after visible folds changed.");
    }),
    resource.metadata.subscribe(() => { if (snippet && !authorityCurrent(snippet.authority)) { snippet = undefined; publish("Snippet ended after authority changed."); } if (job && !authorityCurrent(job.authority)) expire("LSP completion expired after authority changed."); }),
    workspace.tabState.subscribe(() => { if (!available()) { snippet = undefined; clearDiagnostics(); expire("Captured LSP view is unavailable."); } })];
    editor.input.addEventListener("blur", () => { if (job) job.acceptance = undefined; if (snippet && !editor.activity().composing) { snippet = undefined; publish("Snippet ended after focus changed."); } }, { signal: listeners.signal });
    editor.input.addEventListener("compositionstart", () => { cancelAuto(); expire("Finish composition before completion."); }, { signal: listeners.signal });
    editor.input.addEventListener("beforeinput", event => { const started = clock.performance.now();
        try { typed(event); } finally { counters.completionBeforeInputEvents++; counters.lastCompletionBeforeInputMs = clock.performance.now() - started; }
    }, { capture: true, signal: listeners.signal });
    editor.input.addEventListener("input", () => { if (inputIntent) scheduleAuto(); }, { signal: listeners.signal });
    editor.input.addEventListener("compositionend", event => {
        if (snippet) { if (!isFocused(editor.input)) { snippet = undefined; publish("Snippet ended after composition lost focus."); } return; }
        if (!event.data || options.automatic === false || !Array.from(event.data).every(value => word.test(value))) return;
        const selections = editor.view.getSnapshot().selectionSet, caret = selections.ranges[selections.primary]!;
        inputIntent = { revision: workspace.document(documentId).revision, selections, caret: caret.head, data: event.data, word: true, trigger: undefined, reused: false }; scheduleAuto();
    }, { signal: listeners.signal });
    const keydown = (event: KeyboardEvent) => {
        if (event.defaultPrevented || event.isComposing || editor.activity().composing) return;
        if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.code === "Space") { event.preventDefault(); request(); return; }
        if (event.key === "Escape" && (snippet || job || inputIntent || autoFrame !== undefined)) { event.preventDefault(); cancel(); return; }
        if (snippet && event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) { if (moveSnippet(event.shiftKey ? -1 : 1)) event.preventDefault(); return; }
        if (snippet && (event.key === "ArrowDown" || event.key === "ArrowUp") && event.altKey && !event.ctrlKey && !event.metaKey) {
            const stop = snippet.stops[snippet.active]!, index = snippetChoiceIndex(snippet, stop), next = (Math.max(0, index) + (event.key === "ArrowDown" ? 1 : stop.choices.length - 1)) % stop.choices.length;
            if (chooseSnippet(next)) event.preventDefault(); return;
        }
        if (!job?.visible.length) return;
        if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            const next = (job.choice + (event.key === "ArrowDown" ? 1 : job.visible.length - 1)) % job.visible.length;
            if (chooseCompletion(next, job.id)) event.preventDefault();
        } else if (!event.ctrlKey && !event.metaKey && !event.shiftKey && (event.key === "Enter" || event.key === "Tab" && !event.altKey)) {
            event.preventDefault();
            if (!accept(event.key === "Tab" ? "insert" : "replace", job.id) && job) cancel();
        }
    };
    editor.input.addEventListener("keydown", event => { const started = clock.performance.now();
        try { keydown(event); } finally { counters.completionKeydownEvents++; counters.lastCompletionKeydownMs = clock.performance.now() - started; }
    }, { capture: true, signal: listeners.signal });
    updateDiagnostics(); if (options.autoConnect !== false) connect();
    return Object.freeze({ state, request: () => { notifications.assertWritable(); if (!disposed) request(); },
        moveSnippet: (direction, id) => { notifications.assertWritable(); return !disposed && moveSnippet(direction, id); },
        chooseSnippet: (index, id) => { notifications.assertWritable(); return !disposed && chooseSnippet(index, id); },
        apply: (mode, completionId) => { notifications.assertWritable(); return !disposed && apply(mode, completionId); },
        accept: (mode, completionId) => { notifications.assertWritable(); return !disposed && accept(mode, completionId); },
        chooseCompletion: (index, completionId) => { notifications.assertWritable(); return !disposed && chooseCompletion(index, completionId); },
        cancel: () => { notifications.assertWritable(); if (!disposed) cancel(); }, connect: () => { notifications.assertWritable(); connect(); },
        selectDiagnostic: index => { notifications.assertWritable(); return !disposed && selectDiagnostic(index); },
        customRequest: (method, params) => { notifications.assertWritable(); return scope.request(method, params).result; },
        snapshot: () => Object.freeze({ ...counters, received: completion.snapshot().received, connected: scope.state.getSnapshot().phase === "ready", pending: cell.get().pending, offer: !!job?.visible.length, diagnostics: diagnostics.length, diagnosticRevision, diagnosticsPending, transport: "lsp3.17", protocol: scope.snapshotOwnership() }),
        destroy: () => { if (disposed) return; notifications.assertWritable(); disposed = true; snippet = undefined; stopTransform(); cancelAuto(); for (const stop of stops) stop(); listeners.abort(); release(); completion.dispose(); binding.close(); scope.release(); clearDiagnostics(); publish("LSP editor disposed."); for (const stop of [...observers]) stop(); } });
}
