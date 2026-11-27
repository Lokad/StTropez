import { moveChoice } from "./choice-rows.ts";
import { transientSurface } from "./transient-surface.ts";
import { builtinKeyPriority } from "./command-registry.ts";
import { listenUntil } from "./listen.ts";
import { mountCompletionList } from "./completion-list.ts";
import { done, failed, refused, stale, type Outcome } from "../core/outcome.ts";
import { emptyList } from "../core/empty-list.ts";
import { isIndex, isPositiveInteger } from "../core/bounds.ts";
import { completionMethod } from "../protocol/lsp-methods.ts";
import type { LspDocumentOwner } from "../protocol/lsp-client.ts";
import { completionClient, type LspCompletionBatch, type LspCompletionResolution } from "../protocol/lsp-completion.ts";
import { controllerObservable } from "./controller-observable.ts";
import { isStaleRequest, ProtocolDecodeError, staleRequest } from "../protocol/wire.ts";
import { lspCompletionPlan } from "../protocol/lsp-features.ts";
import { acceptedTypedText, dispatchTypedText, typedTextEvent } from "./input-events.ts";
import { completionWordRange, filterCompletions, hasNamedPrefix, isCompletionWord } from "./completion-prefix.ts";
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
import { isMountedEditor, sameEditAuthority } from "./captured-view.ts";
import type { LspCall, LspCompletion, LspCompletions, LspScopeAccess, LspWorkspaceSnapshot } from "../protocol/index.ts";
import { Store } from "../core/observable.ts";
import type { Observable } from "../core/observable.ts";

type Job = { id: number; revision: number; buffer: TextBuffer; caret: number; selections: SelectionSet; indentation: ReturnType<TextEditor["settings"]>["language"]; authority: ResourceMetadata; folding: FoldingSnapshot; lease: ResourceLease;
    call?: LspCall<LspCompletionBatch>; batch?: LspCompletionBatch;
    filterPrefix: boolean; visible: readonly LspCompletion[]; choice: number; listStatus: "pending" | "ready" | "cancelled";
    acceptance?: Readonly<{ id: number; item: LspCompletion; mode: "insert" | "replace" }> | undefined;
    resolution?: { item: LspCompletion; revision: number; call?: LspCall<LspCompletionResolution> } | undefined };
type AutomaticInput = { target: DocumentViewSnapshot; text: string; word: boolean; backspace: boolean };
type PrefixEdit = { before: DocumentViewSnapshot; head: number; backspace: boolean };
type Invocation = Readonly<{ kind: 1 | 2 | 3; character?: string; automatic?: boolean }>;
export type CompletionChoice = Readonly<{ label: string; select: () => boolean; accept: (mode: "insert" | "replace") => boolean }>;
export type CompletionSnippet = Readonly<{ stop: number; position: number; count: number; choices: readonly string[]; choiceIndex: number;
    move: (direction: -1 | 1) => boolean; choose: (index: number) => boolean; finish: () => boolean }>;
export type CompletionSnapshot = Readonly<{ status: "idle" | "connecting" | "disconnected" | "pending" | "ready" | "empty" | "busy" | "unsupported-selection"
        | "malformed" | "failed" | "expired" | "applied" | "rejected" | "resolving" | "accepting" | "snippet" | "disposed";
    reason: string | null; connected: boolean; pending: boolean;
    anchor: Readonly<{ revision: number; from: number; to: number }> | null;
    snippet: CompletionSnippet | null; omittedCompletions: LspCompletions["omitted"];
    choices: readonly string[]; choiceIndex: number; completionAt: (index: number) => CompletionChoice | undefined; completionIncomplete: boolean; completionDetail: string; resolving: boolean }>;
export type CompletionControllerOptions = Readonly<{ automatic?: boolean;
    /** Mount a caret-anchored list. Omit for host-rendered choices. */
    list?: boolean;
    /** Narrow explicit requests using each item's captured edit prefix, as automatic requests do. */
    filterManualCompletions?: boolean; canCapture?: () => boolean;
    /** Visible choice rows for PageUp/Down. Defaults to ten. Return zero for a hidden list. */
    getPageSize?: () => number;
    prepareCompletion?: (scope: LspScopeAccess) => Promise<unknown>; onError?: (error: unknown) => void }>;
export type CompletionController = Observable<CompletionSnapshot> & Readonly<{ request: () => Promise<Outcome<CompletionSnapshot>>; cancel: () => void; connect: () => void;
    dispose: () => void;
    getDiagnostics: () => Readonly<{ lastCompletionBeforeInputMs: number; lastCompletionCommandMs: number }> }>;
function connectionStatus(phase: LspWorkspaceSnapshot["phase"]): CompletionSnapshot["status"] {
    if (phase === "ready") return "idle";
    if (phase === "connecting" || phase === "initializing") return "connecting";
    return "disconnected";
}

/** The captured editor owns completion acceptance, snippet traversal and the optional list. */
export function mountCompletion(editor: TextEditor, ownerConnection: LspDocumentOwner,
    options: CompletionControllerOptions, autoConnect = true): CompletionController {
    const input = editorInput(editor);
    const { workspace, view } = editor, documentId = view.documentId, resource = workspace.resource(documentId);
    const listeners = new AbortController();
    const listen = listenUntil(listeners.signal);
    const { scope, binding, provider } = ownerConnection;
    const currentDocument = () => workspace.document(documentId);
    const currentView = view.getSnapshot;
    const currentFolding = view.folding.getSnapshot;
    const connectionPhase = () => scope.getSnapshot().phase;
    const completion = completionClient(ownerConnection);
    let lastCompletionBeforeInputMs = 0;
    let lastCompletionCommandMs = 0;
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
    let providerPhase = connectionPhase();
    const cell = new Store<CompletionSnapshot>(Object.freeze({ status: connectionStatus(providerPhase), reason: null, connected: providerPhase === "ready", pending: false, anchor: null, choices: emptyList, choiceIndex: 0, completionAt: () => undefined, completionIncomplete: false, completionDetail: "", resolving: false, snippet: null, omittedCompletions: emptyList }), notifications);
    const available = () => !disposed && isMountedEditor(editor);
    const idle = () => { const m = editor.activity(); return m.input === "idle" && !m.disposed && !editor.getSnapshot().disabled && (options.canCapture?.() ?? true); };
    const authority = resource.metadata.getSnapshot;
    const authorityCurrent = (before: ResourceMetadata) => sameEditAuthority(before, authority());
    const indentationCurrent = (before: Job["indentation"]) => { const after = editor.settings().language; return before.tabSize === after.tabSize && before.insertSpaces === after.insertSpaces; };
    const current = (captured: Job, selections = captured.selections) => job === captured && available() && idle() && indentationCurrent(captured.indentation) && currentDocument().revision === captured.revision && currentDocument().buffer === captured.buffer
        && currentView().selectionSet === selections && captured.folding.index.sameProjection(currentFolding().index) && authorityCurrent(captured.authority) && captured.lease.active();
    const bindingCurrent = (captured: Job) => captured.batch?.isBindingCurrent() ?? false;
    const primaryOccurrence = (captured: SnippetSession, stop: SnippetStop) => Math.max(0, stop.ranges.findIndex(range => (range.group ?? 0) === captured.primaryGroup));
    const snippetChoiceIndex = (captured: SnippetSession, stop: SnippetStop) => {
        if (!stop.choices.length) return -1;
        const range = stop.ranges[primaryOccurrence(captured, stop)]!, text = currentDocument().buffer.slice(range.from, range.to);
        return stop.choices.findIndex((_choice, index) => { try { return snippetChoiceText(stop, range, index, captured.maxUnits) === text; }
            catch (error) { if (error instanceof RangeError) return false; throw error; } });
    };
    function completionAt(generation: number | undefined, index: number): CompletionChoice | undefined {
        if (generation === undefined || disposed || !job?.batch || job.id !== generation || !Number.isSafeInteger(index)) return;
        const item = job.visible[index]; if (!item) return;
        return Object.freeze({ label: item.label,
            select: () => { notifications.assertWritable(); return !disposed && chooseCompletion(index, generation); },
            accept: mode => {
                notifications.assertWritable();
                if (disposed || job?.id !== generation || job.choice !== index && !chooseCompletion(index, generation)) return false;
                return accept(mode, generation);
            } });
    }
    const publish = (status: CompletionSnapshot["status"], reason: string | null = null, omitted = job?.batch?.omitted ?? emptyList) => {
        const visible = job?.visible, generation = job?.id;
        if (visible !== labelItems) {
            labelItems = visible;
            labels = visible ? Object.freeze(visible.map(item => item.label)) : emptyMessages;
        }
        if (publishedSession !== snippet) {
            const captured = publishedSession = snippet;
            if (captured) {
                const stop = captured.stops[captured.active]!;
                fieldMarkers ??= editor.decorations.add({ order: 25, minimap: false });
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
        const snapshot: CompletionSnapshot = Object.freeze({ status, reason, connected: connectionPhase() === "ready", pending: !!job && (job.listStatus === "pending" || !!job.resolution || !!selected?.resolve),
        anchor: selected && job ? Object.freeze({ revision: job.revision, from: Math.min(selected.primary.from, job.caret), to: job.caret }) : null,
        choices: labels, choiceIndex: job?.choice ?? 0, completionAt: (index: number) => completionAt(generation, index),
        completionIncomplete: job?.batch?.incomplete ?? false, completionDetail: selected ? [selected.detail, selected.documentation].filter(Boolean).join("\n") : "", resolving: !!job?.resolution,
        snippet: field,
        omittedCompletions: omitted });
        notifications.publish(cell, snapshot);
        return snapshot;
    };
    const surface = options.list ? transientSurface(editor, () => {
        cancelAuto();
        closeList("idle");
    }, "completion") : undefined;
    const release = (retain = false) => {
        if (!retain) surface?.release();
        const old = job; job = undefined; if (!old) return; old.call?.cancel(); old.resolution?.call?.cancel(); old.resolution = undefined;
        if (!retain) completion.cancel();
        // Workspace observers run during commit delivery; retention cleanup must follow that delivery.
        void Promise.resolve().then(() => old.lease.release());
    };
    const cancelAuto = () => { inputIntent = undefined; if (autoFrame !== undefined) clock.cancelAnimationFrame(autoFrame); autoFrame = undefined; autoTurns = 0; };
    const cancelResolution = (captured: Job) => { const old = captured.resolution; captured.resolution = undefined; old?.call?.cancel(); };
    const closeList = (status: CompletionSnapshot["status"], reason?: string) => {
        release();
        publish(status, reason);
    };
    const connect = () => {
        if (disposed || connecting || connectionPhase() === "ready") return;
        const work = scope.ensureConnected(); connecting = work; publish(connectionStatus(connectionPhase()));
        void work.then(() => { if (connecting === work) connecting = undefined; }, () => {
            if (connecting !== work || disposed) return;
            connecting = undefined;
            closeList("failed");
        });
    };
    function filter(captured: Job, prefix: boolean, selected = captured.visible[captured.choice]) {
        const result = filterCompletions(captured.batch?.items ?? emptyList, captured.buffer, captured.caret, prefix, selected);
        captured.visible = result.visible;
        captured.choice = result.choice;
        captured.id = workspace.allocateIdentity();
    }
    const request = async (invocation: Invocation = { kind: 1 }, moving?: Job): Promise<Outcome<CompletionSnapshot>> => {
        notifications.assertWritable();
        let owned: Job | undefined;
        try {
            if (disposed) return refused("unavailable-view");
            cancelAuto();
            if (editor.getSnapshot().readOnlyReason) return refused("not-writable");
            if (!available() || !idle()) {
                publish("busy");
                return refused("unavailable-view");
            }
            const selections = currentView().selectionSet, selected = selections.ranges[selections.primary]!;
            const document = currentDocument();
            if (!snippet && selections.ranges.some(range => range.anchor !== range.head && (selections.ranges.length > 1
                || document.buffer.lineAt(range.anchor) !== document.buffer.lineAt(range.head)))) {
                publish("unsupported-selection");
                return refused("unsupported-selection");
            }
            const caret = Math.max(selected.anchor, selected.head);
            const field = snippet?.stops[snippet.active]!.ranges.find(range => range.from <= Math.min(selected.anchor, selected.head) && caret <= range.to);
            if (!connecting && connectionPhase() !== "ready") {
                publish("disconnected");
                return refused("disconnected");
            }
            const previous = invocation.automatic && job?.batch && current(job) && bindingCurrent(job) ? job : undefined;
            const display = moving ?? previous;
            release(!!display);
            if (surface && !surface.claim(invocation.automatic ? "completion" : "explicit")) return refused("unavailable-view");
            const captured: Job = {
                // Only a refresh at the original caret retains actionable choices.
                id: previous?.id ?? workspace.allocateIdentity(), revision: document.revision, buffer: document.buffer,
                caret, selections,
                indentation: editor.settings().language, authority: authority(), folding: currentFolding(),
                lease: workspace.acquire(documentId), choice: display?.choice ?? 0, listStatus: "pending",
                visible: display?.visible ?? emptyList,
                filterPrefix: moving?.filterPrefix ?? (invocation.automatic === true || options.filterManualCompletions === true),
                ...(previous?.batch ? { batch: previous.batch } : {}),
            };
            owned = job = captured;
            publish("pending");
            if (!current(captured)) throw staleRequest();
            captured.call = completion.run({
                document, offset: caret,
                context: invocation.kind === 2 ? { triggerKind: 2, triggerCharacter: invocation.character! } : { triggerKind: invocation.kind },
                fallback: () => {
                    if (selected.anchor !== selected.head) return { from: Math.min(selected.anchor, selected.head), to: caret, replaceTo: caret };
                    const fallback = completionWordRange(document.buffer, caret);
                    return field ? { from: Math.max(field.from, fallback.from), to: caret, replaceTo: Math.min(field.to, fallback.replaceTo) } : fallback;
                }, indentation: captured.indentation,
                ...(previous?.batch ? { retain: previous.batch } : {}),
                prepare: async scope => {
                    if (options.prepareCompletion) await options.prepareCompletion(scope);
                    if (captured.listStatus === "cancelled" || !current(captured)) throw staleRequest();
                },
            });
            const choices = await captured.call.result;
            if (job !== captured || captured.listStatus === "cancelled") return stale;
            if (!current(captured) || !choices.isCurrent()) throw staleRequest();
            captured.batch = choices;
            captured.listStatus = "ready";
            filter(captured, captured.filterPrefix);
            if (!captured.visible.length) {
                const omitted = choices.omitted;
                release();
                return done(publish("empty", null, omitted));
            }
            const snapshot = publish("ready");
            resolveSelected(captured);
            return done(snapshot);
        } catch (error) {
            if (owned && (job !== owned || owned.listStatus === "cancelled")) return stale;
            release();
            if (isStaleRequest(error)) {
                publish("expired");
                return stale;
            }
            if (error instanceof ProtocolDecodeError) {
                publish("malformed");
            } else {
                publish("failed");
            }
            return failed(error);
        }
    };
    const resolveSelected = (captured: Job) => {
        const item = captured.visible[captured.choice];
        if (!item?.resolve || captured.listStatus === "pending" || captured.resolution?.item === item || !current(captured) || !bindingCurrent(captured)) return;
        cancelResolution(captured); const resolution: NonNullable<Job["resolution"]> = { item, revision: captured.revision }; captured.resolution = resolution;
        publish("resolving");
        void (async () => {
            resolution.call = completion.resolve(captured.batch!, item); const value = await resolution.call.result;
            // Resolution publishes a replacement batch; validate the view before adopting its identity.
            if (job !== captured || captured.resolution !== resolution) return;
            if (captured.visible[captured.choice] !== item || captured.revision !== resolution.revision || !current(captured) || !value.batch.isCurrent()) {
                closeList("expired");
                return;
            }
            captured.batch = value.batch;
            const resolved = value.item, acceptance = captured.acceptance;
            if (!resolved) {
                captured.acceptance = undefined; captured.resolution = undefined;
                captured.visible = captured.visible.filter(value => value !== item);
                captured.choice = Math.min(captured.choice, Math.max(0, captured.visible.length - 1));
                captured.id = workspace.allocateIdentity();
                publish(captured.visible.length ? "ready" : "empty", value.reason); resolveSelected(captured); return;
            }
            const previous = captured.visible;
            captured.visible = previous.map(value => value === item ? resolved : value);
            captured.resolution = undefined;
            // The decoder forbids label changes during resolution; the published labels still apply.
            if (labelItems === previous) labelItems = captured.visible;
            publish("ready");
            if (acceptance?.item === item) queueMicrotask(() => {
                if (job === captured && captured.acceptance === acceptance && captured.id === acceptance.id && captured.visible[captured.choice] === resolved && editor.getSnapshot().focused) {
                    captured.acceptance = undefined;
                    apply(captured, acceptance.mode);
                }
            });
        })().catch(() => {
            if (job === captured && captured.resolution === resolution)
                closeList("failed");
        });
    };
    const apply = (captured: Job, mode: "insert" | "replace", character?: string): boolean => {
        const completion = captured.visible[captured.choice];
        if (!completion) return false;
        if (!current(captured) || !bindingCurrent(captured) || editor.getSnapshot().readOnlyReason) { closeList("expired"); return false; }
        if (completion.resolve || captured.resolution) { resolveSelected(captured); publish("resolving"); return false; }
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
            closeList("unsupported-selection");
            return false;
        }
        applying = true;
        let result;
        const first = plan.snippet?.[0];
        const before = currentView();
        try { result = workspace.edit({ documentId, expectedRevision: captured.revision, origin: "human", edits: plan.edits, view: editor.view,
            selectionSet: plan.selectionSet, history: { kind: "replace" } }); } finally { applying = false; }
        if (result.status !== "done") { closeList("rejected", result.reason); return false; }
        if (parent && fieldPlan) snippet = { ...parent, stops: fieldPlan.stops, revision: result.value };
        else if (first && first.index !== 0) snippet = { stops: plan.snippet!, active: 0, revision: result.value, authority: authority(),
            indentation: captured.indentation, maxUnits: completion.insertion.maxUnits, primaryGroup: captured.selections.primary };
        const after = currentView();
        cancelAuto();
        closeList("applied");
        revealCaret(after.selection.head);
        if (character && available() && after.revision === result.value) dispatchTypedText(editor.element, before, after, character);
        return true;
    };
    function stopListRefresh(captured: Job) {
        if (captured.listStatus !== "pending") return;
        captured.listStatus = "cancelled";
        captured.call?.cancel();
    }
    const accept = (mode: "insert" | "replace", id?: number): boolean => {
        const captured = job, item = captured?.visible[captured.choice];
        if (!captured?.batch || !item || id !== undefined && captured.id !== id) return false;
        if (!current(captured) || !bindingCurrent(captured) || editor.getSnapshot().readOnlyReason) { closeList("expired"); return false; }
        stopListRefresh(captured);
        if (!item.resolve && !captured.resolution) return apply(captured, mode);
        captured.acceptance = { id: captured.id, item, mode };
        resolveSelected(captured);
        publish("accepting");
        return true;
    };
    const chooseCompletion = (index: number, completionId?: number): boolean => {
        const captured = job;
        if (!captured?.batch || completionId !== undefined && completionId !== captured.id
            || !isIndex(index, captured.visible.length) || !current(captured)) return false;
        captured.acceptance = undefined;
        cancelResolution(captured);
        captured.choice = index;
        stopListRefresh(captured);
        publish("ready");
        resolveSelected(captured);
        return true;
    };
    const cancel = () => { cancelAuto(); release();
        if (snippet) { snippet = undefined; if (available() && editor.activity().input !== "composing") view.setSelection(currentDocument().revision, currentView().selection); }
        publish("idle"); };
    const snippetCurrent = (captured: SnippetSession) => snippet === captured && available() && !editor.getSnapshot().readOnlyReason && indentationCurrent(captured.indentation) && authorityCurrent(captured.authority) && currentDocument().revision === captured.revision;
    function revealCaret(head: number) {
        editor.viewport.revealRange(head, head);
        editor.focus();
    }
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
        publish(stop.index === 0 ? "idle" : "snippet");
        revealCaret(currentView().selection.head);
        return true;
    };
    const chooseSnippet = (index: number): boolean => {
        const captured = snippet, stop = captured?.stops[captured.active], value = stop?.choices[index];
        if (!captured || !stop || value === undefined || !snippetCurrent(captured) || !idle()) return false;
        const document = currentDocument(); let plan;
        try { plan = planSnippetChoice(document.buffer, captured.stops, captured.active, index, primaryOccurrence(captured, stop), captured.maxUnits); }
        catch (error) { if (!(error instanceof RangeError)) throw error; publish("rejected"); return false; }
        if (!plan) return false; cancelAuto(); release(); applying = true;
        let result;
        try { result = workspace.edit({ documentId, expectedRevision: document.revision, origin: "human", edits: plan.edits, selectionSet: plan.selectionSet, view: editor.view, history: { kind: "replace" } }); }
        finally { applying = false; }
        if (result.status !== "done") return false;
        snippet = { ...captured, stops: plan.stops, revision: result.value }; publish("snippet"); editor.focus(); return true;
    };
    let stopTransform: () => void;
    try { stopTransform = editor.registerEditTransform(edit => {
        if (!snippet && options.automatic !== false && (job || inputIntent?.backspace)) {
            const before = currentView(), caret = before.selection, change = edit.edits[0];
            const following = job?.revision === before.revision && job.selections === before.selectionSet
                || inputIntent?.backspace && inputIntent.target === before;
            if (following && change && edit.edits.length === 1 && before.selectionSet.ranges.length === 1 && caret.anchor === caret.head
                && change.to === caret.head && edit.expectedRevision === before.revision) {
                const typing = edit.kind === "typing" && change.from === caret.head && change.insert.length > 0 && change.insert.length <= 2048
                    && isCompletionWord(change.insert);
                const backspace = edit.kind === "delete" && change.insert === "" && change.from < change.to && change.to - change.from <= 2048
                    && isCompletionWord(currentDocument().buffer.slice(change.from, change.to));
                if (typing || backspace) {
                    prefixEdit = { before, head: change.from + change.insert.length, backspace };
                    return { edits: edit.edits, selectionSet: edit.selectionSet, complete: () => { prefixEdit = undefined; } };
                }
            }
        }
        const captured = snippet; if (!captured) return;
        if (!snippetCurrent(captured) || edit.expectedRevision !== captured.revision) { snippet = undefined; return; }
        const plan = planSnippetEdit(currentDocument().buffer, captured.stops, captured.active, edit.edits, currentView().selectionSet, edit.selectionSet, edit.adjustNewlines);
        if (!plan) { snippet = undefined; return; }
        snippetChanging = true;
        return { edits: plan.edits, selectionSet: plan.selectionSet, complete: applied => {
            snippetChanging = false;
            if (snippet !== captured) return;
            if (applied) { cancelAuto(); release(); }
            snippet = applied ? { ...captured, stops: plan.stops, revision: currentDocument().revision } : undefined;
            publish(applied ? "snippet" : "rejected");
        } };
    }); } catch (error) { completion.dispose(); throw error; }
    const triggers = () => new Set(scope.featureOptions(completionMethod, binding).flatMap(option => Array.isArray(option.triggerCharacters)
        ? option.triggerCharacters.filter((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 8).slice(0, 64) : []));
    const scheduleAuto = () => {
        if (connectionPhase() === "disconnected" || connectionPhase() === "disposed") { cancelAuto(); return; }
        if (options.automatic === false || !inputIntent || autoFrame !== undefined) return;
        autoFrame = clock.requestAnimationFrame(() => {
            autoFrame = undefined;
            const intent = inputIntent, state = editor.getSnapshot();
            if (!intent || currentView() !== intent.target || !available() || !state.focused || state.readOnlyReason || state.composing) { cancelAuto(); return; }
            if (!idle() || connectionPhase() !== "ready" && connecting) {
                if (++autoTurns < 120) scheduleAuto(); else cancelAuto();
                return;
            }
            if (!connecting && connectionPhase() !== "ready" || connectionPhase() === "ready" && !scope.canRequest(completionMethod, binding)) { cancelAuto(); return; }
            let character: string | undefined;
            for (const trigger of triggers()) if (intent.text.endsWith(trigger) && trigger.length > (character?.length ?? 0)) character = trigger;
            if (!intent.word && !character) { cancelAuto(); return; }
            const reused = job?.revision === intent.target.revision && job.selections === intent.target.selectionSet ? job : undefined;
            if (!character && reused?.batch && !reused.batch.incomplete && reused.visible.length) { cancelAuto(); resolveSelected(reused); return; }
            const kind = character ? 2 : reused?.batch?.incomplete ? 3 : 1;
            request({ kind, automatic: true, ...(character ? { character } : {}) });
        });
    };
    function acceptedText(event: Event): void {
        const after = currentView();
        const text = acceptedTypedText(event, editor.element, after)?.text;
        if (!text || !available()) return;
        cancelAuto();
        if (options.automatic === false || !editor.getSnapshot().focused || !snippet && after.selectionSet.ranges.length !== 1
            || after.selection.head !== after.selection.anchor) return;
        const tail = text.slice(-8), head = after.selection.head;
        const buffer = currentDocument().buffer;
        if (head < tail.length || buffer.slice(head - tail.length, head) !== tail) return;
        const isWord = text.length <= 2048 && isCompletionWord(text)
            && (!/\p{Nd}$/u.test(text) || hasNamedPrefix(buffer, head));
        inputIntent = { target: after, text: tail, word: isWord, backspace: false }; scheduleAuto();
    }
    function beforeInput(event: InputEvent): void {
        if (!event.cancelable || event.defaultPrevented || event.isComposing || editor.getSnapshot().composing
            || event.inputType !== "insertText" || event.data?.length !== 1) return;
        const captured = job, choice = captured?.visible[captured.choice];
        if (!captured?.batch || !choice?.commitCharacters.includes(event.data)) return;
        if (apply(captured, "replace", event.data)) {
            event.preventDefault();
            if (!triggers().has(event.data)) cancelAuto();
        } else closeList("idle");
    }
    let movingCaret: Job | undefined;
    const stops = [provider.subscribe(() => {
        const previous = providerPhase, phase = connectionPhase();
        providerPhase = phase;
        if (phase === "disconnected" || phase === "disposed") { cancelAuto(); release(); }
        else if (job?.batch && !bindingCurrent(job)) { closeList("expired"); return; }
        if (phase === "ready" && inputIntent) scheduleAuto();
        if (phase !== previous && !job) publish(connectionStatus(phase));
    }),
    workspace.observeDocument(documentId).subscribe(() => {
        if (applying || snippetChanging) return;
        snippet = undefined;
        const document = currentDocument();
        const after = currentView(), edit = prefixEdit, captured = job, selected = after.selectionSet, caret = after.selection;
        if (inputIntent && inputIntent.target !== after) cancelAuto();
        const follows = edit && document.change?.origin === "human" && document.change.previousRevision === edit.before.revision
            && selected.ranges.length === 1 && caret.anchor === edit.head && caret.head === edit.head;
        if (follows && edit.backspace) {
            if (!hasNamedPrefix(document.buffer, caret.head)) {
                cancelAuto(); closeList("idle"); return;
            }
            inputIntent = { target: after, text: "", word: true, backspace: true }; scheduleAuto();
        }
        if (follows && captured?.batch?.items.length && edit.before.revision === captured.revision && edit.before.selectionSet === captured.selections
            && authorityCurrent(captured.authority) && bindingCurrent(captured) && currentFolding().generation === captured.folding.generation + 1) {
            const selectedIndex = captured.batch.items.indexOf(captured.visible[captured.choice]!);
            const rebased = completion.rebase(captured.batch, document);
            if (rebased) {
                captured.acceptance = undefined; cancelResolution(captured);
                captured.batch = rebased; captured.revision = document.revision; captured.buffer = document.buffer;
                captured.caret = caret.head; captured.selections = selected; captured.folding = currentFolding();
                stopListRefresh(captured);
                filter(captured, true, rebased.items[selectedIndex]);
                publish("ready"); return;
            }
        }
        if (captured || publishedSession) closeList("expired");
    }), view.subscribe(() => { const selected = currentView().selectionSet;
        if (snippet && !applying && !snippetChanging && !selected.ranges.every(selection => snippet!.stops[snippet!.active]!.ranges.some(range => range.from <= Math.min(selection.anchor, selection.head) && range.to >= Math.max(selection.anchor, selection.head)))) {
            snippet = undefined; publish("idle");
        }
        if (snippet && !applying && !snippetChanging) {
            const primary = selected.ranges[selected.primary]!, range = snippet.stops[snippet.active]!.ranges.find(range => range.from <= Math.min(primary.anchor, primary.head) && range.to >= Math.max(primary.anchor, primary.head));
            if (range) snippet.primaryGroup = range.group ?? 0;
        }
        if (inputIntent && currentView() !== inputIntent.target) cancelAuto();
        if (!applying && job && job !== movingCaret && selected !== job.selections) {
            cancelAuto();
            closeList("expired");
        }
    }),
    view.folding.subscribe(() => {
        if (!job || currentDocument().revision !== job.revision) return;
        const folds = currentFolding();
        if (job.folding.index.sameProjection(folds.index)) job.folding = folds;
        else closeList("expired");
    }),
    resource.metadata.subscribe(() => { if (snippet && !authorityCurrent(snippet.authority)) { snippet = undefined; publish("expired"); } if (job && !authorityCurrent(job.authority)) closeList("expired"); })];

    listen(input, "blur", () => {
        cancelAuto();
        if (job) closeList("idle");
        if (snippet && editor.activity().input !== "composing") { snippet = undefined; publish("idle"); }
    });
    listen(input, "compositionstart", () => { cancelAuto(); closeList("busy"); });
    listen(input, "beforeinput", event => { const started = clock.performance.now();
        try { beforeInput(event); } finally { lastCompletionBeforeInputMs = clock.performance.now() - started; }
    }, { capture: true });
    listen(editor.element, typedTextEvent, acceptedText);
    listen(input, "compositionend", () => {
        if (snippet && !editor.getSnapshot().focused) { snippet = undefined; publish("idle"); }
    });
    // Home and End dismiss the list even when the caret is already at the boundary.
    listen(input, "keydown", event => {
        if (!event.isComposing && editor.activity().input !== "composing" && job?.visible.length && (event.key === "Home" || event.key === "End")) {
            cancelAuto();
            closeList("idle");
        }
    });
    const registrations: { dispose(): void }[] = [];
    const visible = () => !!job?.visible.length;
    const navigatingSnippet = () => !!snippet;
    function register(id: string, label: string, keys: string[], enabled: () => boolean, run: () => boolean | void, priority: number = builtinKeyPriority.completion) {
        registrations.push(editor.commands.register({ id, label, owner: "editor", category: "Completion", enabled, run() {
            notifications.assertWritable();
            const started = clock.performance.now();
            try { return run(); } finally { lastCompletionCommandMs = clock.performance.now() - started; }
        } }, { keys, priority }));
    }
    function moveCaret(direction: "left" | "right") {
        const captured = job;
        if (!captured) return false;
        movingCaret = captured;
        let moved: boolean;
        try { moved = editor.commands.run("move-" + direction); }
        finally { movingCaret = undefined; }
        const { selectionSet, selection } = currentView();
        if (job !== captured || selectionSet === captured.selections) return moved;
        const before = captured.selections.ranges[captured.selections.primary]!;
        const from = Math.min(before.head, selection.head);
        const to = Math.max(before.head, selection.head);
        if (moved && captured.selections.ranges.length === 1 && selectionSet.ranges.length === 1
            && before.head === before.anchor && selection.head === selection.anchor && current(captured, selectionSet)
            && from < to && to - from <= 2048 && isCompletionWord(captured.buffer.slice(from, to))) {
            void request({ kind: 1, automatic: true }, captured);
        } else closeList("expired");
        return moved;
    }
    function navigate(direction: -1 | 1, page: boolean) {
        if (!job?.visible.length) return false;
        if (!job.batch) return true;
        const count = job.visible.length;
        const rows = page ? options.getPageSize?.() ?? list?.pageSize() ?? 10 : undefined;
        if (page && !isPositiveInteger(rows)) return false;
        const next = moveChoice(job.choice, count, direction, rows);
        return next === job.choice || chooseCompletion(next, job.id);
    }
    function cycleChoice(direction: -1 | 1) {
        if (!snippet) return false;
        const stop = snippet.stops[snippet.active]!, count = stop.choices.length;
        return count > 0 && chooseSnippet((Math.max(0, snippetChoiceIndex(snippet, stop)) + direction + count) % count);
    }
    let list: ReturnType<typeof mountCompletionList> | undefined;
    const dispose = () => {
        if (disposed) return;
        notifications.assertWritable(); disposed = true; snippet = undefined;
        for (const registration of registrations) registration.dispose();
        list?.dispose();
        stopTransform(); cancelAuto(); for (const stop of stops) stop();
        listeners.abort(); release(); completion.dispose();
        publish("disposed");
        cell.clearSnapshotListeners();
    };
    try {
        register("completion.request", "Show completions", ["Mod+Code:Space"],
            () => available() && !editor.getSnapshot().readOnlyReason, () => { void request(); });
        register("completion.dismiss", "Dismiss completion", ["Escape"], () => !!(snippet || job || inputIntent || autoFrame !== undefined), () => {
            if (snippet && (job || inputIntent)) {
                cancelAuto();
                closeList("idle");
                return true;
            }
            const consumed = visible() || !!snippet;
            cancel(); return consumed;
        });
        register("completion.move-left", "Move caret left", ["ArrowLeft"], visible, () => moveCaret("left"));
        register("completion.move-right", "Move caret right", ["ArrowRight"], visible, () => moveCaret("right"));
        for (const [id, label, direction, key] of [["previous", "Previous", -1, "Up"], ["next", "Next", 1, "Down"]] as const) {
            register("completion." + id, label + " completion", ["Arrow" + key], visible, () => navigate(direction, false));
            register("completion.page-" + id, label + " completion page", ["Page" + key], visible, () => navigate(direction, true));
            register("snippet." + id, label + " placeholder", [direction === 1 ? "Tab" : "Shift+Tab"], navigatingSnippet, () => moveSnippet(direction), builtinKeyPriority.field);
            register("snippet.choice-" + id, label + " snippet choice", ["Alt+Arrow" + key, "Alt+Shift+Arrow" + key],
                () => !!snippet?.stops[snippet.active]?.choices.length, () => cycleChoice(direction));
        }
        for (const mode of ["insert", "replace"] as const) {
            register("completion." + mode, mode === "insert" ? "Insert completion" : "Replace with completion",
                mode === "insert" ? ["Tab"] : ["Enter", "Alt+Enter"], visible, () => { if (job?.batch && !accept(mode) && job) closeList("expired"); });
        }
        if (options.list) list = mountCompletionList(editor, cell.observable, !!options.filterManualCompletions);
    } catch (error) { dispose(); throw error; }
    if (autoConnect) connect();
    return Object.freeze({ ...controllerObservable(cell, "Completion", () => disposed, notifications), request: () => request(),
        cancel: () => { notifications.assertWritable(); if (!disposed) cancel(); }, connect: () => { notifications.assertWritable(); connect(); },
        getDiagnostics: () => Object.freeze({ lastCompletionBeforeInputMs, lastCompletionCommandMs }),
        dispose });
}
