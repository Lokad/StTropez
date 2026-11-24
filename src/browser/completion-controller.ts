import { done, failed, refused, stale, type Outcome } from "../core/outcome.ts";
import { emptyList } from "../core/empty-list.ts";
import { isIndex, isPositiveInteger } from "../core/bounds.ts";
import { completionMethod } from "../protocol/lsp-methods.ts";
import type { LspDocumentOwner } from "../protocol/lsp-client.ts";
import { completionClient } from "../protocol/lsp-completion.ts";
import { beginReadRequest } from "../protocol/lsp-workspace.ts";
import { controllerObservable } from "./controller-observable.ts";
import { isStaleRequest, ProtocolDecodeError, rpcCodes, staleRequest } from "../protocol/wire.ts";
import { acceptedTypedText, dispatchTypedText, typedTextEvent } from "./input-events.ts";
import { codeWordConstituentPattern } from "../core/word-patterns.ts";
import type { DocumentViewSnapshot, ResourceLease, ResourceMetadata } from "../core/workspace.ts";
import type { SelectionSet } from "../core/selections.ts";
import { planSnippetEdit, planSnippetChoice, snippetChoiceText } from "../core/snippets.ts";
import { planFieldCompletion } from "./snippet-completion.ts";
import type { SnippetStop } from "../core/snippets.ts";
import type { TextBuffer } from "../core/text-buffer.ts";
import type { FoldingSnapshot } from "../core/folding.ts";
import type { TextEditor } from "./text-editor.ts";
import { editorInput } from "./editor-input.ts";
import type { DecorationLayer } from "./decoration-layers.ts";
import { sameEditAuthority } from "./captured-view.ts";
import { RpcError, lspCompletionPlan } from "../protocol/index.ts";
import type { LspCall, LspCompletion, LspCompletionBatch, LspCompletionResolution, LspCompletions, LspCompletionFallback, LspScopeAccess, LspWorkspace, LspWorkspaceSnapshot, JsonValue } from "../protocol/index.ts";
import { Store } from "../core/observable.ts";
import type { Observable } from "../core/observable.ts";

type Job = { id: number; revision: number; buffer: TextBuffer; caret: number; selections: SelectionSet; indentation: ReturnType<TextEditor["settings"]>["language"]; authority: ResourceMetadata; folding: FoldingSnapshot; lease: ResourceLease;
    call?: LspCall<LspCompletionBatch>; batch?: LspCompletionBatch; choices?: LspCompletions; visible: readonly LspCompletion[]; choice: number; pendingList: boolean; requestGeneration: number;
    acceptance?: Readonly<{ id: number; item: LspCompletion; mode: "insert" | "replace" }> | undefined;
    resolution?: { item: LspCompletion; revision: number; call?: LspCall<LspCompletionResolution> } | undefined };
type AutomaticInput = { target: DocumentViewSnapshot; text: string; word: boolean; backspace: boolean };
type PrefixEdit = { before: DocumentViewSnapshot; head: number; backspace: boolean };
type Invocation = Readonly<{ kind: 1 | 2 | 3; character?: string; automatic?: boolean }>;
export type CompletionChoice = Readonly<{ label: string; select: () => boolean; accept: (mode: "insert" | "replace") => boolean }>;
export type CompletionSnippet = Readonly<{ stop: number; position: number; count: number; choices: readonly string[]; choiceIndex: number;
    move: (direction: -1 | 1) => boolean; choose: (index: number) => boolean; finish: () => boolean }>;
export type CompletionSnapshot = Readonly<{ message: string; connected: boolean; pending: boolean; offerText: string | null;
    anchor: Readonly<{ revision: number; from: number; to: number }> | null;
    snippet: CompletionSnippet | null; omittedCompletions: LspCompletions["omitted"];
    choices: readonly string[]; choiceIndex: number; completionAt: (index: number) => CompletionChoice | undefined; completionIncomplete: boolean; completionDetail: string; resolving: boolean }>;
export type CompletionControllerOptions = Readonly<{ autoConnect?: boolean; automatic?: boolean;
    /** Narrow explicit requests using each item's captured edit prefix, as automatic requests do. */
    filterManualCompletions?: boolean; canCapture?: () => boolean;
    /** Visible choice rows for PageUp/Down. Defaults to ten. Return zero for a hidden list. */
    getPageSize?: () => number;
    prepareCompletion?: (scope: LspScopeAccess) => Promise<unknown>; onError?: (error: unknown) => void }>;
export type CompletionController = Observable<CompletionSnapshot> & Readonly<{ request: () => Promise<Outcome<CompletionSnapshot>>; cancel: () => void; connect: () => void;
    customRequest: (method: string, params: JsonValue) => Promise<JsonValue>; dispose: () => void;
    getDiagnostics: () => Readonly<{ posted: number; received: number; applied: number; stale: number; cancelled: number; invalid: number; failed: number; resolved: number;
        lastCompletionBeforeInputMs: number; lastCompletionCommandMs: number;
        connected: boolean; pending: boolean; offer: boolean; transport: "lsp3.17"; protocol: ReturnType<LspWorkspace["snapshot"]>["protocol"] }> }>;
const word = new RegExp(`^(?:${codeWordConstituentPattern})$`, "u");
// A word prefix can end in digits. A run of decimal digits on its own has no name to complete.
const namedPrefix = new RegExp(`(?:\\$|(?!\\p{Nd})${codeWordConstituentPattern})\\p{Nd}*$`, "u");
const hasNamedPrefix = (buffer: TextBuffer, head: number) => namedPrefix.test(buffer.slice(Math.max(0, head - 2048), head));

function connectionMessage(phase: LspWorkspaceSnapshot["phase"]): string {
    if (phase === "ready") return "LSP provider connected. Request completion for results.";
    if (phase === "connecting" || phase === "initializing") return "LSP provider connecting.";
    return "LSP provider disconnected; local editing remains available.";
}

/** Captured editor coordination; hosts render controls and supply provider/custom-message policy. */
export function mountCompletion(editor: TextEditor, ownerConnection: LspDocumentOwner,
    options: CompletionControllerOptions): CompletionController {
    const input = editorInput(editor);
    const { workspace, tab: target, view } = editor, documentId = view.documentId, resource = workspace.resourceForDocument(documentId);
    const listeners = new AbortController();
    const { scope, binding, provider } = ownerConnection;
    const custom = scope[beginReadRequest](() => {}, () => [binding]);
    const completion = completionClient(ownerConnection);
    function releaseConnection() {
        custom.dispose();
        completion.dispose();
    }
    const counters = { posted: 0, applied: 0, stale: 0, cancelled: 0, invalid: 0, failed: 0, resolved: 0,
        lastCompletionBeforeInputMs: 0, lastCompletionCommandMs: 0 };
    let job: Job | undefined, disposed = false, connecting: Promise<void> | undefined, inputIntent: AutomaticInput | undefined, prefixEdit: PrefixEdit | undefined, autoFrame: number | undefined, autoTurns = 0, applying = false;
    type SnippetSession = { stops: readonly SnippetStop[]; active: number; revision: number; authority: ResourceMetadata;
        indentation: Job["indentation"]; maxUnits: number; primaryGroup: number };
    let snippet: SnippetSession | undefined, snippetChanging = false;
    let fieldMarkers: DecorationLayer | undefined;
    let publishedSession: SnippetSession | undefined, field: CompletionSnippet | null = null;
    const owner = editor.element.ownerDocument, clock = owner.defaultView!;
    const emptyMessages: readonly string[] = emptyList;
    let labelItems: readonly LspCompletion[] | undefined, labels = emptyMessages;
    const notifications = workspace.createNotificationScope(error => options.onError?.(error));
    let providerPhase = scope.getSnapshot().phase;
    const cell = new Store<CompletionSnapshot>(Object.freeze({ message: connectionMessage(providerPhase), connected: providerPhase === "ready", pending: false, offerText: null, anchor: null, choices: emptyList, choiceIndex: 0, completionAt: () => undefined, completionIncomplete: false, completionDetail: "", resolving: false, snippet: null, omittedCompletions: emptyList }), notifications);
    const available = () => !disposed && editor.element.isConnected && !editor.signal.aborted && workspace.ownsDocumentView(view, target);
    const idle = () => { const m = editor.activity(); return !m.composing && !m.pendingInput && !m.pendingCommand && !m.pendingWord && !m.pendingGrapheme && !m.disposed && !editor.getSnapshot().disabled && (options.canCapture?.() ?? true); };
    const authority = resource.metadata.getSnapshot;
    const authorityCurrent = (before: ResourceMetadata) => sameEditAuthority(before, authority());
    const indentationCurrent = (before: Job["indentation"]) => { const after = editor.settings().language; return before.tabSize === after.tabSize && before.insertSpaces === after.insertSpaces; };
    const current = (captured: Job) => job === captured && available() && idle() && indentationCurrent(captured.indentation) && workspace.document(documentId).revision === captured.revision && workspace.document(documentId).buffer === captured.buffer
        && view.getSnapshot().selectionSet === captured.selections && captured.folding.index.sameProjection(view.folding.getSnapshot().index) && authorityCurrent(captured.authority) && captured.lease.active();
    const bindingCurrent = (captured: Job) => captured.batch?.isBindingCurrent() ?? false;
    const primaryOccurrence = (captured: SnippetSession, stop: SnippetStop) => Math.max(0, stop.ranges.findIndex(range => (range.group ?? 0) === captured.primaryGroup));
    const snippetChoiceIndex = (captured: SnippetSession, stop: SnippetStop) => {
        if (!stop.choices.length) return -1;
        const range = stop.ranges[primaryOccurrence(captured, stop)]!, text = workspace.document(documentId).buffer.slice(range.from, range.to);
        return stop.choices.findIndex((_choice, index) => { try { return snippetChoiceText(stop, range, index, captured.maxUnits) === text; }
            catch (error) { if (error instanceof RangeError) return false; throw error; } });
    };
    function completionAt(generation: number | undefined, index: number): CompletionChoice | undefined {
        if (generation === undefined || disposed || job?.id !== generation || !Number.isSafeInteger(index)) return;
        const item = job.visible[index]; if (!item) return;
        return Object.freeze({ label: item.label,
            select: () => { notifications.assertWritable(); return !disposed && chooseCompletion(index, generation); },
            accept: mode => {
                notifications.assertWritable();
                if (disposed || job?.id !== generation || job.choice !== index && !chooseCompletion(index, generation)) return false;
                return accept(mode, generation);
            } });
    }
    const publish = (message: string) => {
        const visible = job?.visible, generation = job?.id;
        if (visible !== labelItems) {
            labelItems = visible;
            labels = visible ? Object.freeze(visible.map(item => item.label)) : emptyMessages;
        }
        if (publishedSession !== snippet) {
            const captured = publishedSession = snippet;
            if (captured) {
                const stop = captured.stops[captured.active]!;
                fieldMarkers ??= editor.decorations.add({ name: "snippet-fields", order: 25, minimap: false });
                fieldMarkers.set(captured.revision, captured.stops.flatMap(other => other === stop || other.index === 0 ? []
                    : other.ranges.map(({ from, to }) => ({ from, to, className: "st-snippet-field" }))));
                const liveField = () => { notifications.assertWritable(); return !disposed && snippetCurrent(captured) && idle(); };
                field = Object.freeze({ stop: stop.index, position: captured.active + 1, count: captured.stops.length - 1,
                    choices: stop.choices, choiceIndex: snippetChoiceIndex(captured, stop),
                    move: direction => liveField() && moveSnippet(direction), choose: index => liveField() && chooseSnippet(index),
                    finish: () => { if (!liveField()) return false; cancel(); return true; } });
            } else {
                fieldMarkers?.dispose(); fieldMarkers = undefined;
                field = null;
            }
        }
        const selected = job?.visible[job.choice];
        const snapshot: CompletionSnapshot = Object.freeze({ message, connected: scope.getSnapshot().phase === "ready", pending: !!job && (job.pendingList || !!job.resolution || !!selected?.resolve),
        anchor: selected && job ? Object.freeze({ revision: job.revision, from: Math.min(selected.primary.from, job.caret), to: job.caret }) : null,
        offerText: selected?.label ?? null, choices: labels, choiceIndex: job?.choice ?? 0, completionAt: (index: number) => completionAt(generation, index),
        completionIncomplete: job?.choices?.incomplete ?? false, completionDetail: selected ? [selected.detail, selected.documentation].filter(Boolean).join("\n") : "", resolving: !!job?.resolution,
        snippet: field,
        omittedCompletions: job?.choices?.omitted ?? emptyList });
        notifications.publish(cell, snapshot);
        return snapshot;
    };
    const release = (retain = false) => {
        const old = job; job = undefined; if (!old) return; old.call?.cancel(); old.resolution?.call?.cancel(); old.resolution = undefined;
        if (!retain) completion.cancel();
        // Workspace observers run during commit delivery; retention cleanup must follow that delivery.
        void Promise.resolve().then(() => old.lease.release());
    };
    const cancelAuto = () => { inputIntent = undefined; if (autoFrame !== undefined) clock.cancelAnimationFrame(autoFrame); autoFrame = undefined; autoTurns = 0; };
    const cancelResolution = (captured: Job) => { const old = captured.resolution; captured.resolution = undefined; old?.call?.cancel(); };
    const expire = (message: string) => { if (job) counters.stale++; release(); publish(message); };
    const connect = () => {
        if (disposed || connecting || scope.getSnapshot().phase === "ready") return;
        const work = scope.ensureConnected(); connecting = work; publish(connectionMessage(scope.getSnapshot().phase));
        void work.then(() => { if (connecting === work) connecting = undefined; }, () => {
            if (connecting !== work || disposed) return; connecting = undefined; counters.failed++; release(); publish("LSP provider unavailable; local editing remains available.");
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
        captured.id = workspace.allocateIdentity();
    };
    const request = async (invocation: Invocation = { kind: 1 }): Promise<Outcome<CompletionSnapshot>> => {
        notifications.assertWritable();
        let owned: Job | undefined;
        try {
            if (disposed) return refused("unavailable-view");
            cancelAuto();
            if (!available() || !idle()) {
                publish("Finish pending typing, navigation or composition before completion.");
                return refused("unavailable-view");
            }
            const selections = view.getSnapshot().selectionSet, selected = selections.ranges[selections.primary]!;
            const document = workspace.document(documentId);
            if (!snippet && selections.ranges.some(range => range.anchor !== range.head && (selections.ranges.length > 1
                || document.buffer.lineAt(range.anchor) !== document.buffer.lineAt(range.head)))) {
                publish("Use one selection on a single line, or place carets where you want suggestions.");
                return refused("unsupported-selection");
            }
            const caret = Math.max(selected.anchor, selected.head);
            const field = snippet?.stops[snippet.active]!.ranges.find(range => range.from <= Math.min(selected.anchor, selected.head) && caret <= range.to);
            if (!connecting && scope.getSnapshot().phase !== "ready") {
                publish("Reconnect the LSP provider before requesting completion.");
                return refused("disconnected");
            }
            const previous = invocation.automatic && job?.choices && current(job) && bindingCurrent(job) ? job : undefined;
            release(!!previous);
            const captured: Job = {
                id: workspace.allocateIdentity(), revision: document.revision, buffer: document.buffer, caret, selections,
                indentation: editor.settings().language, authority: authority(), folding: view.folding.getSnapshot(),
                lease: workspace.acquire(resource.id), choice: previous?.choice ?? 0, pendingList: true,
                requestGeneration: 0, visible: previous?.visible ?? emptyList,
                ...(previous?.choices ? { choices: previous.choices } : {}), ...(previous?.batch ? { batch: previous.batch } : {}),
            };
            owned = job = captured;
            counters.posted++;
            publish("LSP completion pending.");
            if (!current(captured)) throw staleRequest();
            captured.call = completion.run({
                document, offset: caret,
                context: invocation.kind === 2 ? { triggerKind: 2, triggerCharacter: invocation.character! } : { triggerKind: invocation.kind },
                fallback: () => {
                    if (selected.anchor !== selected.head) return { from: Math.min(selected.anchor, selected.head), to: caret, replaceTo: caret };
                    const fallback = wordRange(document.buffer, caret);
                    return field ? { from: Math.max(field.from, fallback.from), to: caret, replaceTo: Math.min(field.to, fallback.replaceTo) } : fallback;
                }, indentation: captured.indentation,
                ...(previous?.batch ? { retain: previous.batch } : {}),
                prepare: async scope => {
                    if (options.prepareCompletion) await options.prepareCompletion(scope);
                    if (captured.requestGeneration !== 0 || !current(captured)) throw staleRequest();
                },
            });
            const choices = await captured.call.result;
            if (job !== captured || captured.requestGeneration !== 0) return stale;
            if (!current(captured) || !choices.isCurrent()) throw staleRequest();
            captured.batch = captured.choices = choices;
            captured.pendingList = false;
            filter(captured, invocation.automatic === true || options.filterManualCompletions === true);
            if (!captured.visible.length) {
                const omitted = choices.omitted.length;
                release();
                return done(publish(omitted ? `${omitted} unsupported completion choices omitted.` : "No suggestions here. Try a different prefix."));
            }
            const snapshot = publish("LSP completion ready.");
            resolveSelected(captured);
            return done(snapshot);
        } catch (error) {
            if (owned && (job !== owned || owned.requestGeneration !== 0)) return stale;
            release();
            if (isStaleRequest(error)) {
                counters.stale++;
                publish("Stale LSP completion rejected.");
                return stale;
            }
            if (error instanceof ProtocolDecodeError) {
                counters.invalid++;
                publish("Malformed or unsupported LSP completion rejected.");
            } else {
                counters.failed++;
                publish("LSP provider unavailable; local editing remains available.");
            }
            return failed(error);
        }
    };
    const resolveSelected = (captured: Job) => {
        const item = captured.visible[captured.choice];
        if (!item?.resolve || captured.pendingList || captured.resolution?.item === item || !current(captured) || !bindingCurrent(captured)) return;
        cancelResolution(captured); const resolution: NonNullable<Job["resolution"]> = { item, revision: captured.revision }; captured.resolution = resolution;
        publish("Resolving the selected completion.");
        void (async () => {
            resolution.call = completion.resolve(captured.batch!, item); const value = await resolution.call.result;
            // Resolution publishes a replacement batch; validate the view before adopting its identity.
            if (job !== captured || captured.resolution !== resolution) return;
            if (captured.visible[captured.choice] !== item || captured.revision !== resolution.revision || !current(captured) || !value.batch.isCurrent()) {
                expire(indentationCurrent(captured.indentation) ? "Completion expired. Request fresh choices." : "Completion expired after indentation settings changed.");
                return;
            }
            captured.batch = value.batch; captured.choices = value.batch;
            const resolved = value.item, acceptance = captured.acceptance;
            if (!resolved) {
                captured.acceptance = undefined; captured.resolution = undefined;
                captured.visible = Object.freeze(captured.visible.filter(value => value !== item)); captured.choice = Math.min(captured.choice, Math.max(0, captured.visible.length - 1)); captured.id = workspace.allocateIdentity();
                publish(`Unsupported snippet omitted: ${item.label}. ${value.reason}`); resolveSelected(captured); return;
            }
            const previous = captured.visible;
            captured.visible = Object.freeze(previous.map(value => value === item ? resolved : value)); captured.resolution = undefined; counters.resolved++;
            // The decoder forbids label changes during resolution; the published labels still apply.
            if (labelItems === previous) labelItems = captured.visible;
            publish("LSP completion ready.");
            if (acceptance?.item === item) queueMicrotask(() => {
                if (job === captured && captured.acceptance === acceptance && captured.id === acceptance.id && captured.visible[captured.choice] === resolved && editor.getSnapshot().focused) {
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
        if (!current(captured) || !bindingCurrent(captured) || editor.getSnapshot().readOnlyReason) { expire("Stale or unauthorized LSP completion rejected."); return false; }
        if (completion.resolve || captured.resolution) { resolveSelected(captured); publish("Wait for the selected completion to finish resolving."); return false; }
        const parent = snippet;
        let plan, fieldPlan;
        try {
            if (parent) {
                if (!snippetCurrent(parent)) throw new RangeError("Snippet field expired.");
                fieldPlan = planFieldCompletion(completion, mode, character, captured.selections, parent.stops, parent.active);
                plan = { ...fieldPlan, snippet: null };
            } else {
                const multiple = captured.selections.ranges.length > 1 ? captured.selections : undefined;
                plan = lspCompletionPlan(completion, mode, character, multiple);
            }
        }
        catch (error) { if (!(error instanceof RangeError || error instanceof TypeError)) throw error;
            counters.invalid++; release(); publish("Completion cannot apply to all captured carets; no text changed."); return false; }
        applying = true;
        let result;
        const first = plan.snippet?.[0];
        try { result = workspace.edit({ documentId, expectedRevision: captured.revision, origin: "human", edits: plan.edits, view: editor.view,
            selectionSet: plan.selectionSet, history: { kind: "replace" } }); } finally { applying = false; }
        if (!result.applied) { expire(`LSP completion rejected: ${result.reason}.`); return false; }
        if (parent && fieldPlan) snippet = { ...parent, stops: fieldPlan.stops, revision: result.revision };
        else if (first && first.index !== 0) snippet = { stops: plan.snippet!, active: 0, revision: result.revision, authority: authority(),
            indentation: captured.indentation, maxUnits: completion.insertion.maxUnits, primaryGroup: captured.selections.primary };
        const after = view.getSnapshot();
        counters.applied++; cancelAuto(); release(); publish("LSP completion applied."); editor.viewport.revealOffset(after.selection.head); editor.focus();
        if (character && available() && after.revision === result.revision) dispatchTypedText(editor.element, after, character);
        return true;
    };
    const accept = (mode: "insert" | "replace", id?: number): boolean => {
        const captured = job, item = captured?.visible[captured.choice];
        if (!captured || !item || id !== undefined && captured.id !== id) return false;
        if (!current(captured) || !bindingCurrent(captured) || editor.getSnapshot().readOnlyReason) { expire("Stale or unauthorized LSP completion rejected."); return false; }
        if (!item.resolve && !captured.resolution) return apply(mode, id);
        captured.acceptance = Object.freeze({ id: captured.id, item, mode }); resolveSelected(captured); publish("Accepting the selected completion after resolution."); return true;
    };
    const chooseCompletion = (index: number, completionId?: number): boolean => {
        if (!job?.choices || completionId !== undefined && completionId !== job.id || !isIndex(index, job.visible.length) || !current(job)) return false;
        job.acceptance = undefined; cancelResolution(job); job.choice = index; if (job.pendingList) { job.requestGeneration++; job.call?.cancel(); job.pendingList = false; } publish("LSP completion selected."); resolveSelected(job); return true;
    };
    const cancel = () => { cancelAuto(); if (job) counters.cancelled++; release();
        if (snippet) { snippet = undefined; if (available() && !editor.activity().composing) view.setSelection(workspace.document(documentId).revision, view.getSnapshot().selection); }
        publish("LSP request or snippet cancelled."); };
    const snippetCurrent = (captured: SnippetSession) => snippet === captured && available() && !editor.getSnapshot().readOnlyReason && indentationCurrent(captured.indentation) && authorityCurrent(captured.authority) && workspace.document(documentId).revision === captured.revision;
    const moveSnippet = (direction: -1 | 1): boolean => {
        const captured = snippet;
        if (!captured || !snippetCurrent(captured) || !idle()) return false;
        const active = Math.max(0, captured.active + direction), stop = captured.stops[active]; if (!stop) return false;
        cancelAuto(); release();
        applying = true;
        try {
            if (!view.setSelections(captured.revision, stop.ranges.map(range => ({ anchor: range.from, head: stop.index === 0 ? range.from : range.to })), primaryOccurrence(captured, stop))) return false;
            snippet = stop.index === 0 ? undefined : { ...captured, active };
        } finally { applying = false; }
        publish(stop.index === 0 ? "Snippet complete." : "Snippet placeholder selected."); editor.viewport.revealOffset(view.getSnapshot().selection.head); editor.focus(); return true;
    };
    const chooseSnippet = (index: number): boolean => {
        const captured = snippet, stop = captured?.stops[captured.active], value = stop?.choices[index];
        if (!captured || !stop || value === undefined || !snippetCurrent(captured) || !idle()) return false;
        const document = workspace.document(documentId); let plan;
        try { plan = planSnippetChoice(document.buffer, captured.stops, captured.active, index, primaryOccurrence(captured, stop), captured.maxUnits); }
        catch (error) { if (!(error instanceof RangeError)) throw error; publish("Snippet choice exceeds the document limit; no text changed."); return false; }
        if (!plan) return false; cancelAuto(); release(); applying = true;
        let result;
        try { result = workspace.edit({ documentId, expectedRevision: document.revision, origin: "human", edits: plan.edits, selectionSet: plan.selectionSet, view: editor.view, history: { kind: "replace" } }); }
        finally { applying = false; }
        if (!result.applied) return false;
        snippet = { ...captured, stops: plan.stops, revision: result.revision }; publish("Snippet choice applied."); editor.focus(); return true;
    };
    let stopTransform: () => void;
    try { stopTransform = editor.registerEditTransform(edit => {
        if (!snippet && options.automatic !== false && (job || inputIntent?.backspace)) {
            const before = view.getSnapshot(), caret = before.selection, change = edit.edits[0];
            const following = job?.revision === before.revision && job.selections === before.selectionSet
                || inputIntent?.backspace && inputIntent.target === before;
            if (following && change && edit.edits.length === 1 && before.selectionSet.ranges.length === 1 && caret.anchor === caret.head
                && change.to === caret.head && edit.expectedRevision === before.revision) {
                const typing = edit.kind === "typing" && change.from === caret.head && change.insert.length > 0 && change.insert.length <= 2048
                    && Array.from(change.insert).every(point => word.test(point));
                const backspace = edit.kind === "delete" && change.insert === "" && change.from < change.to && change.to - change.from <= 2048
                    && Array.from(workspace.document(documentId).buffer.slice(change.from, change.to)).every(point => word.test(point));
                if (typing || backspace) {
                    prefixEdit = { before, head: change.from + change.insert.length, backspace };
                    return { edits: edit.edits, selectionSet: edit.selectionSet, complete: () => { prefixEdit = undefined; } };
                }
            }
        }
        const captured = snippet; if (!captured) return;
        if (!snippetCurrent(captured) || edit.expectedRevision !== captured.revision) { snippet = undefined; return; }
        const plan = planSnippetEdit(workspace.document(documentId).buffer, captured.stops, captured.active, edit.edits, view.getSnapshot().selectionSet, edit.selectionSet, edit.adjustNewlines);
        if (!plan) { snippet = undefined; return; }
        snippetChanging = true;
        return { edits: plan.edits, selectionSet: plan.selectionSet, complete: applied => {
            snippetChanging = false;
            if (snippet !== captured) return;
            if (applied) { cancelAuto(); release(); }
            snippet = applied ? { ...captured, stops: plan.stops, revision: workspace.document(documentId).revision } : undefined;
            publish(applied ? "Snippet placeholder edited." : "Snippet edit rejected.");
        } };
    }); } catch (error) { releaseConnection(); throw error; }
    const triggers = () => new Set(scope.featureOptions(completionMethod, binding).flatMap(option => Array.isArray(option.triggerCharacters)
        ? option.triggerCharacters.filter((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 8).slice(0, 64) : []));
    const scheduleAuto = () => {
        if (options.automatic === false || !inputIntent || autoFrame !== undefined) return;
        autoFrame = clock.requestAnimationFrame(() => {
            autoFrame = undefined;
            const intent = inputIntent, state = editor.getSnapshot();
            if (!intent || view.getSnapshot() !== intent.target || !available() || !state.focused || state.readOnlyReason || state.composing) { cancelAuto(); return; }
            if (!idle() || scope.getSnapshot().phase !== "ready" && connecting) {
                if (++autoTurns < 120) scheduleAuto(); else cancelAuto();
                return;
            }
            if (!connecting && scope.getSnapshot().phase !== "ready" || scope.getSnapshot().phase === "ready" && !scope.canRequest(completionMethod, binding)) { cancelAuto(); return; }
            let character: string | undefined;
            for (const trigger of triggers()) if (intent.text.endsWith(trigger) && trigger.length > (character?.length ?? 0)) character = trigger;
            if (!intent.word && !character) { cancelAuto(); return; }
            const reused = job?.revision === intent.target.revision && job.selections === intent.target.selectionSet ? job : undefined;
            if (!character && reused?.choices && !reused.choices.incomplete && reused.visible.length) { cancelAuto(); resolveSelected(reused); return; }
            const kind = character ? 2 : reused?.choices?.incomplete ? 3 : 1;
            request({ kind, automatic: true, ...(character ? { character } : {}) });
        });
    };
    function acceptedText(event: Event): void {
        const after = view.getSnapshot();
        const text = acceptedTypedText(event, editor.element, after);
        if (!text || !available()) return;
        cancelAuto();
        if (options.automatic === false || !editor.getSnapshot().focused || !snippet && after.selectionSet.ranges.length !== 1
            || after.selection.head !== after.selection.anchor) return;
        const tail = text.slice(-8), head = after.selection.head;
        const buffer = workspace.document(documentId).buffer;
        if (head < tail.length || buffer.slice(head - tail.length, head) !== tail) return;
        const isWord = text.length <= 2048 && Array.from(text).every(point => word.test(point))
            && (!/\p{Nd}$/u.test(text) || hasNamedPrefix(buffer, head));
        inputIntent = { target: after, text: tail, word: isWord, backspace: false }; scheduleAuto();
    }
    function beforeInput(event: InputEvent): void {
        if (!event.cancelable || event.defaultPrevented || event.isComposing || editor.getSnapshot().composing
            || event.inputType !== "insertText" || event.data?.length !== 1) return;
        const captured = job, choice = captured?.visible[captured.choice];
        if (!captured || !choice?.commitCharacters.includes(event.data)) return;
        if (apply("replace", captured.id, event.data)) {
            event.preventDefault();
            if (!triggers().has(event.data)) cancelAuto();
        } else expire("Completion dismissed while resolution was pending.");
    }
    const stops = [provider.subscribe(() => {
        const previous = providerPhase, phase = scope.getSnapshot().phase;
        providerPhase = phase;
        if (phase === "disconnected" || phase === "disposed") { cancelAuto(); release(); }
        else if (job?.batch && !bindingCurrent(job)) { expire("LSP completion expired after provider capabilities changed."); return; }
        if (phase === "ready" && inputIntent) scheduleAuto();
        publish(phase !== previous && !job ? connectionMessage(phase) : cell.get().message);
    }),
    workspace.observeDocument(documentId).subscribe(() => {
        if (applying || snippetChanging) return;
        snippet = undefined;
        const document = workspace.document(documentId);
        const after = view.getSnapshot(), edit = prefixEdit, captured = job, selected = after.selectionSet, caret = after.selection;
        if (inputIntent && inputIntent.target !== after) cancelAuto();
        const follows = edit && document.change?.origin === "human" && document.change.previousRevision === edit.before.revision
            && selected.ranges.length === 1 && caret.anchor === edit.head && caret.head === edit.head;
        if (follows && edit.backspace) {
            if (!hasNamedPrefix(document.buffer, caret.head)) {
                cancelAuto(); expire("Completion dismissed after deleting the prefix."); return;
            }
            inputIntent = { target: after, text: "", word: true, backspace: true }; scheduleAuto();
        }
        if (follows && captured?.choices?.items.length && edit.before.revision === captured.revision && edit.before.selectionSet === captured.selections
            && authorityCurrent(captured.authority) && bindingCurrent(captured) && view.folding.getSnapshot().generation === captured.folding.generation + 1) {
            const selectedIndex = captured.choices.items.indexOf(captured.visible[captured.choice]!);
            const rebased = captured.batch && completion.rebase(captured.batch, document);
            if (rebased) {
                captured.acceptance = undefined; cancelResolution(captured);
                captured.batch = rebased; captured.choices = rebased; captured.revision = document.revision; captured.buffer = document.buffer;
                captured.caret = caret.head; captured.selections = selected; captured.folding = view.folding.getSnapshot();
                captured.pendingList = false; captured.requestGeneration++; captured.call?.cancel(); filter(captured, true);
                const choice = selectedIndex < 0 ? -1 : captured.visible.indexOf(rebased.items[selectedIndex]!); if (choice >= 0) captured.choice = choice;
                publish("LSP completion follows the typed prefix."); return;
            }
        }
        if (captured || publishedSession) expire("LSP results expired after an edit.");
    }), view.subscribe(() => { const selected = view.getSnapshot().selectionSet;
        if (snippet && !applying && !snippetChanging && !selected.ranges.every(selection => snippet!.stops[snippet!.active]!.ranges.some(range => range.from <= Math.min(selection.anchor, selection.head) && range.to >= Math.max(selection.anchor, selection.head)))) {
            snippet = undefined; publish("Snippet ended after selection left its placeholder.");
        }
        if (snippet && !applying && !snippetChanging) {
            const primary = selected.ranges[selected.primary]!, range = snippet.stops[snippet.active]!.ranges.find(range => range.from <= Math.min(primary.anchor, primary.head) && range.to >= Math.max(primary.anchor, primary.head));
            if (range) snippet.primaryGroup = range.group ?? 0;
        }
        if (inputIntent && view.getSnapshot() !== inputIntent.target) cancelAuto();
        if (!applying && job && selected !== job.selections) { cancelAuto(); expire("LSP completion expired after selection changed."); }
    }),
    view.folding.subscribe(() => {
        if (!job || workspace.document(documentId).revision !== job.revision) return;
        const folds = view.folding.getSnapshot();
        if (job.folding.index.sameProjection(folds.index)) job.folding = folds;
        else expire("LSP completion expired after visible folds changed.");
    }),
    resource.metadata.subscribe(() => { if (snippet && !authorityCurrent(snippet.authority)) { snippet = undefined; publish("Snippet ended after authority changed."); } if (job && !authorityCurrent(job.authority)) expire("LSP completion expired after authority changed."); })];
    if (target) stops.push(workspace.tabs.subscribe(() => { if (!available()) { snippet = undefined; expire("Captured LSP view is unavailable."); } }));
    input.addEventListener("blur", () => {
        cancelAuto();
        if (job) { counters.cancelled++; release(); publish("Completion dismissed after focus changed."); }
        if (snippet && !editor.activity().composing) { snippet = undefined; publish("Snippet ended after focus changed."); }
    }, { signal: listeners.signal });
    input.addEventListener("compositionstart", () => { cancelAuto(); expire("Finish composition before completion."); }, { signal: listeners.signal });
    input.addEventListener("beforeinput", event => { const started = clock.performance.now();
        try { beforeInput(event); } finally { counters.lastCompletionBeforeInputMs = clock.performance.now() - started; }
    }, { capture: true, signal: listeners.signal });
    editor.element.addEventListener(typedTextEvent, acceptedText, { signal: listeners.signal });
    input.addEventListener("compositionend", () => {
        if (snippet && !editor.getSnapshot().focused) { snippet = undefined; publish("Snippet ended after composition lost focus."); }
    }, { signal: listeners.signal });
    // Home and End dismiss the list even when the caret is already at the boundary.
    input.addEventListener("keydown", event => {
        if (!event.isComposing && !editor.activity().composing && job?.visible.length && (event.key === "Home" || event.key === "End")) {
            cancelAuto(); counters.cancelled++; release(); publish("Completion dismissed.");
        }
    }, { signal: listeners.signal });
    const registrations: { dispose(): void }[] = [];
    const visible = () => !!job?.visible.length;
    const navigatingSnippet = () => !!snippet;
    function register(id: string, label: string, keys: string[], enabled: () => boolean, run: () => boolean | void, priority = 30) {
        registrations.push(editor.commands.register({ id, label, enabled, run() {
            notifications.assertWritable();
            const started = clock.performance.now();
            try { return run(); } finally { counters.lastCompletionCommandMs = clock.performance.now() - started; }
        } }, { keys, priority }));
    }
    function navigate(direction: -1 | 1, page: boolean) {
        if (!job?.visible.length) return false;
        const count = job.visible.length;
        if (!page) return chooseCompletion((job.choice + direction + count) % count, job.id);
        const rows = options.getPageSize?.() ?? 10;
        if (!isPositiveInteger(rows)) return false;
        const next = Math.max(0, Math.min(count - 1, job.choice + direction * rows));
        return next === job.choice || chooseCompletion(next, job.id);
    }
    function cycleChoice(direction: -1 | 1) {
        if (!snippet) return false;
        const stop = snippet.stops[snippet.active]!, count = stop.choices.length;
        return count > 0 && chooseSnippet((Math.max(0, snippetChoiceIndex(snippet, stop)) + direction + count) % count);
    }
    const dispose = () => {
        if (disposed) return;
        notifications.assertWritable(); disposed = true; snippet = undefined;
        for (const registration of registrations) registration.dispose();
        stopTransform(); cancelAuto(); for (const stop of stops) stop();
        listeners.abort(); release(); releaseConnection();
        publish("Completion controller disposed.");
        cell.clearSnapshotListeners();
    };
    try {
        register("completion.request", "Show completions", ["Ctrl+Code:Space", "Meta+Code:Space"], available, () => { void request(); });
        register("completion.dismiss", "Dismiss completion", ["Escape"], () => !!(snippet || job || inputIntent || autoFrame !== undefined), () => {
            if (snippet && (job || inputIntent)) {
                cancelAuto(); if (job) counters.cancelled++; release(); publish("Completion dismissed."); return true;
            }
            const consumed = visible() || !!snippet;
            cancel(); return consumed;
        });
        for (const [id, label, direction, key] of [["previous", "Previous", -1, "Up"], ["next", "Next", 1, "Down"]] as const) {
            register("completion." + id, label + " completion", ["Arrow" + key], visible, () => navigate(direction, false));
            register("completion.page-" + id, label + " completion page", ["Page" + key], visible, () => navigate(direction, true));
            register("snippet." + id, label + " placeholder", [direction === 1 ? "Tab" : "Shift+Tab"], navigatingSnippet, () => moveSnippet(direction), 40);
            register("snippet.choice-" + id, label + " snippet choice", ["Alt+Arrow" + key, "Alt+Shift+Arrow" + key],
                () => !!snippet?.stops[snippet.active]?.choices.length, () => cycleChoice(direction));
        }
        for (const mode of ["insert", "replace"] as const) {
            register("completion." + mode, mode === "insert" ? "Insert completion" : "Replace with completion",
                mode === "insert" ? ["Tab"] : ["Enter", "Alt+Enter"], visible, () => { if (!accept(mode) && job) expire("Completion expired."); });
        }
    } catch (error) { dispose(); throw error; }
    if (options.autoConnect !== false) connect();
    return Object.freeze({ ...controllerObservable(cell, "Completion", () => disposed, notifications), request: () => request(),
        cancel: () => { notifications.assertWritable(); if (!disposed) cancel(); }, connect: () => { notifications.assertWritable(); connect(); },
        customRequest: (method, params) => { notifications.assertWritable(); return custom.request(method, params).result; },
        getDiagnostics: () => Object.freeze({ ...counters, received: completion.snapshot().received, connected: scope.getSnapshot().phase === "ready", pending: cell.get().pending, offer: !!job?.visible.length, transport: "lsp3.17", protocol: scope.snapshotOwnership() }),
        dispose });
}
