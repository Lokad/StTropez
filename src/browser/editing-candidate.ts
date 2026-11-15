import { mountInputCaret } from "./input-caret.ts";
import { clientBox, cssZoom } from "./dom-coordinates.ts";
import { textDifference } from "../core/changes.ts";
import { WordCursor } from "../core/words.ts";
import { createGraphemeCursor } from "../core/graphemes.ts";
import { createSelectionSet, planSelectionEdits } from "../core/selections.ts";
import type { Affinity } from "../core/positions.ts";
import type { DocumentView, TabId, Workspace } from "../core/workspace.ts";
import type { EditKind, Selection } from "../core/history.ts";
import type { SelectionSet } from "../core/selections.ts";
import type { TextBuffer } from "../core/text-buffer.ts";
import type { TextEdit } from "../core/changes.ts";
import type { GraphemeCursor, GraphemeIndex } from "../core/graphemes.ts";
import type { ViewState } from "./index.ts";
import { inputContext, inputContextUnits } from "./input-context.ts";
import { localAsciiGraphemePoint } from "../core/grapheme-point.ts";
import type { GraphemePoint } from "../core/grapheme-point.ts";
import { captureNativeInsertion, resolveNativeInsertion } from "./input-target.ts";
import type { NativeInsertionTarget } from "./input-target.ts";
import type { InputContext } from "./input-context.ts";
import { mountTextViewport } from "./viewport.ts";
import type { LineClass, LineDecorator, TextViewport } from "./viewport.ts";
import { mountTextDragDrop } from "./text-drag-drop.ts";
import { planLanguageEdit, resolveLanguageConfiguration } from "../core/language-edits.ts";
import type { EditingCommand, LanguageConfiguration } from "../core/language-edits.ts";
import { captureInsertion } from "./captured-insertion.ts";
import type { CapturedInsertion } from "./captured-insertion.ts";

export type CandidateEdit = Readonly<{ expectedRevision: number; edits: readonly TextEdit[]; selectionSet: SelectionSet; kind: EditKind }>;
export type CandidateEditTransform = (edit: CandidateEdit) => Readonly<{ edits: readonly TextEdit[]; selectionSet: SelectionSet; complete?: (applied: boolean) => void }> | undefined;
export type EditingCandidate = Readonly<{ element: HTMLDivElement; input: HTMLTextAreaElement; view: DocumentView; viewport: TextViewport;
    /** One pending host insertion, invalidated by later editing/selection/authority/lifecycle changes. */
    captureInsertion: (kind?: "paste" | "replace") => CapturedInsertion | undefined;
    /** One synchronous edit planner per view. Its result still passes Workspace validation/history. */
    registerEditTransform: (transform: CandidateEditTransform) => () => void;
    configureLanguage: (configuration: LanguageConfiguration) => boolean;
    /** Returns whether the command was accepted; long selections finish asynchronously. */
    runCommand: (command: EditingCommand) => boolean;
    focus: () => void; captureView: () => ViewState; restoreView: (state: ViewState) => void;
    snapshot: () => Readonly<{ inputUnits: number; inputEvents: number; lastInputMs: number; beforeInputEvents: number; lastBeforeInputMs: number; maxQueuedInputTurnMs: number; keydownEvents: number; lastKeydownMs: number; navigationTurns: number; navigationPreparationMs: number; maxNavigationTurnMs: number; navigationWorkMs: number; wordSelectionEvents: number; lastWordSelectionMs: number; maxWordSelectionTurnMs: number; pendingCaret: boolean; pendingCommand: boolean; pendingDragScroll: boolean; dragScrollFrames: number; maxDragScrollStepMs: number; commits: number; conflicts: number; composing: boolean; pendingInput: boolean; queuedInputUnits: number; pendingWord: boolean; wordScanSteps: number; maxWordScanStepMs: number; pendingGrapheme: boolean; graphemeScanSteps: number; maxGraphemeScanStepMs: number; visualMoves: number; disposed: boolean }>;
    destroy: () => void }>;
let nextMount = 0;

/** Experimental bounded-input adapter. Long contextual lines and native IME remain qualification gates. */
export function mountEditingCandidate(host: HTMLElement, workspace: Workspace, tabId: TabId,
    options: Readonly<{ ariaLabel?: string; view?: DocumentView; readOnly?: boolean; decorate?: LineDecorator; lineClass?: LineClass; language?: LanguageConfiguration }> = {}): EditingCandidate {
    let language = resolveLanguageConfiguration(options.language);
    const readOnly = options.readOnly === true;
    const target = workspace.captureTab(tabId), tab = workspace.resolveTab(target);
    if (!tab || tab.surface.kind !== "text") throw new Error("Expected a text surface.");
    const documentId = tab.surface.documentId, resource = workspace.resourceForDocument(documentId);
    if (options.view && (options.view.documentId !== documentId || !workspace.ownsDocumentView(options.view))) throw new Error("View belongs to a different document or workspace.");
    const view = options.view ?? workspace.createDocumentView(documentId);
    let viewport: TextViewport;
    try { viewport = mountTextViewport(host, workspace, tabId, { ...options, view }); }
    catch (error) { if (!options.view) view.dispose(); throw error; }
    const root = viewport.element;
    root.style.tabSize = String(language.tabSize);
    const owner = host.ownerDocument, win = owner.defaultView!, input = owner.createElement("textarea");
    const scope = ++nextMount, listeners = new AbortController();
    root.classList.add("st-editing-candidate"); root.tabIndex = -1;
    root.querySelector(".st-viewport-layer")!.setAttribute("aria-hidden", "true");
    input.className = "st-input-context"; input.wrap = "off"; input.spellcheck = false; input.autocomplete = "off";
    // The native projection belongs to the editor, independently of enclosing host forms.
    input.setAttribute("form", "");
    input.setAttribute("aria-label", options.ariaLabel ?? workspace.document(documentId).title);
    input.setAttribute("autocapitalize", "off");
    root.append(input);
    let revision = workspace.document(documentId).revision, context: InputContext = inputContext(workspace.document(documentId).buffer, view.getSnapshot().selection);
    let disposed = false, composing = false, selecting = false, committing = false, escaped = false;
    let editTransform: CandidateEditTransform | undefined;
    let hostInsertion: CapturedInsertion | undefined;
    const escapeState = (value: boolean) => {
        if (escaped === value) return;
        escaped = value; root.toggleAttribute("data-st-tab-escape", value);
        for (const button of root.querySelectorAll<HTMLButtonElement>(".st-fold-button")) button.tabIndex = value ? -1 : 0;
    };
    let commits = 0, conflicts = 0, serial = 0, inputEvents = 0, lastInputMs = 0;
    let beforeInputEvents = 0, lastBeforeInputMs = 0, maxQueuedInputTurnMs = 0;
    let keydownEvents = 0, lastKeydownMs = 0;
    let navigationTurns = 0, navigationPreparationMs = 0, maxNavigationTurnMs = 0, navigationWorkMs = 0, navigationDepth = 0;
    let wordSelectionEvents = 0, lastWordSelectionMs = 0, maxWordSelectionTurnMs = 0;
    let preferred: Readonly<{ selections: SelectionSet; revision: number; layout: string; columns: readonly (number | undefined)[] }> | undefined;
    let wordScanSteps = 0, maxWordScanStepMs = 0;
    let graphemeScanSteps = 0, maxGraphemeScanStepMs = 0;
    let visualMoves = 0;
    let group: Readonly<{ type: string; revision: number; selectionSet: SelectionSet; time: number; key: string }> | undefined;
    let drag: Readonly<{ pointer: number; anchor: number; anchorAffinity: Affinity; revision: number; x: number; y: number; selectionSet: SelectionSet; baseRanges: readonly Selection[]; padding: boolean }> | undefined;
    let dragFrame: number | undefined, dragTime: number | undefined, dragScrollFrames = 0, maxDragScrollStepMs = 0;
    const commandTimers = new Set<number>();
    let wordJob: Readonly<{ cursor: WordCursor; revision: number; selection: Selection }> | undefined, wordTimer: number | undefined;
    type CommandCapture = Readonly<{ buffer: TextBuffer; revision: number; selection: Selection; selectionSet: SelectionSet; deleting: boolean }>;
    let graphemeJob: Readonly<{ cursor: GraphemeCursor; capture: CommandCapture; purpose: "word" | "word-selection" | "grapheme" }> | undefined, graphemeTimer: number | undefined;
    let graphemeCache: Readonly<{ buffer: TextBuffer; from: number; to: number; index: GraphemeIndex }> | undefined;
    type InputCapture = Readonly<{ revision: number; selectionSet: SelectionSet; context: InputContext; target?: NativeInsertionTarget }>;
    let wordInput: Readonly<{ revision: number; selectionSet: SelectionSet; direction: -1 | 1; word: boolean }> | undefined;
    let insertion: InputCapture | undefined, composition: InputCapture | undefined;
    let projectedSet = view.getSnapshot().selectionSet;
    let rangeCommand: Readonly<{ capture: CommandCapture; purpose: "word" | "grapheme"; release: () => void }> | undefined, rangeTimer: number | undefined;
    type InputKey = { kind: "key"; key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; text: string; edit: boolean };
    type InputIntent = (InputKey | { kind: "text"; text: string; type: string; literal?: true }) & { at?: number };
    type OrderedInput = { capture: CommandCapture; purpose: "word" | "grapheme"; actions: InputIntent[]; units: number; edit: boolean; native: boolean; running?: InputIntent; cancelled?: boolean };
    let ordered: OrderedInput | undefined, executingInput: OrderedInput | undefined, orderedTimer: number | undefined, drainingInput = false, replayTime: number | undefined;
    let nativeOrder: { order: OrderedInput; capture: InputCapture; type: string; data: string | null; action?: InputKey; invalid: boolean; reported: boolean } | undefined;
    const apple = /Mac|iPhone|iPad|iPod/.test(win.navigator.platform);
    function cancelScans(): void {
        wordJob?.cursor.dispose(); wordJob = undefined;
        if (wordTimer !== undefined) { win.clearTimeout(wordTimer); commandTimers.delete(wordTimer); wordTimer = undefined; }
        graphemeJob?.cursor.dispose(); graphemeJob = undefined;
        if (graphemeTimer !== undefined) { win.clearTimeout(graphemeTimer); commandTimers.delete(graphemeTimer); graphemeTimer = undefined; }
    }
    function cancelWord(): void {
        const command = rangeCommand; rangeCommand = undefined;
        if (rangeTimer !== undefined) { win.clearTimeout(rangeTimer); commandTimers.delete(rangeTimer); rangeTimer = undefined; }
        const pending = takeInput();
        try { cancelScans(); command?.release(); }
        finally { if (pending) recoverInput(pending, "pending-input-cancelled"); }
    }
    function cancelCommandTimers(): void {
        commandTimers.forEach(timer => win.clearTimeout(timer)); commandTimers.clear();
    }
    const caretLayer = mountInputCaret(root, input, view, viewport,
        () => workspace.observeDocument(documentId).getSnapshot(), () => composing);
    const scheduleCaret = caretLayer.schedule;
    function refresh(): void {
        if (disposed || selecting || committing) return;
        const state = resource.getSnapshot(); input.disabled = !workspace.resolveTab(target) || state.state !== "ready";
        input.readOnly = readOnly || !state.metadata.capabilities.edit.includes("human") || state.metadata.editLock !== null;
        if (executingInput?.edit && input.readOnly) recoverInput(executingInput, "pending-input-expired");
        if (ordered && (!currentInput(ordered) || ordered.edit && input.readOnly)) cancelWord();

        if (!input.disabled && !composing) {
            const document = workspace.document(documentId), { selection: selected, selectionSet } = view.getSnapshot();
            if (graphemeCache?.buffer !== document.buffer) graphemeCache = undefined;
            const capture = rangeCommand?.capture ?? graphemeJob?.capture;
            if (capture && (capture.revision !== document.revision || capture.selectionSet !== selectionSet || capture.deleting && input.readOnly)) cancelWord();
            // Projection is refreshed only outside composition. The captured model selection and
            // LF mapping remain together until the native edit is committed or recovered.
            context = inputContext(document.buffer, selected);
            revision = document.revision;
            projectedSet = selectionSet;
            if (input.value !== context.text) input.value = context.text;
            const anchor = context.nativeAnchor, head = context.nativeHead;
            if (input.selectionStart !== Math.min(anchor, head) || input.selectionEnd !== Math.max(anchor, head)
                || (input.selectionDirection === "backward") !== (anchor > head)) input.setSelectionRange(Math.min(anchor, head), Math.max(anchor, head), anchor > head ? "backward" : "forward");
        }
        scheduleCaret();
    }
    function syncSelection(): void {
        if (disposed || composing || committing || input.disabled || input.value !== context.text) return;
        const backward = input.selectionDirection === "backward";
        // LF projection cannot distinguish both sides of a removed CR. An unchanged native
        // range still represents the exact captured model selection, including a raw CRLF interior.
        if (view.getSnapshot().selectionSet === projectedSet && input.selectionStart === Math.min(context.nativeAnchor, context.nativeHead)
            && input.selectionEnd === Math.max(context.nativeAnchor, context.nativeHead) && backward === (context.nativeAnchor > context.nativeHead)) return;
        const anchor = context.toModel(backward ? input.selectionEnd : input.selectionStart), head = context.toModel(backward ? input.selectionStart : input.selectionEnd);
        const current = view.getSnapshot(); if (current.revision === revision && current.selection.anchor === anchor && current.selection.head === head) return;
        selecting = true;
        try { if (view.setSelection(revision, { anchor, head })) projectedSet = view.getSnapshot().selectionSet; }
        finally { selecting = false; }
        scheduleCaret();
    }
    const conflict = (reason: string, edit?: TextEdit, expectedRevision = revision, contextFrom = context.from, attemptedText = input.value, cause?: unknown) => {
        conflicts++; group = undefined;
        input.dispatchEvent(new CustomEvent("sttropez-conflict", { bubbles: true, detail: Object.freeze({ documentId, expectedRevision, reason,
            attemptedText, contextFrom, ...(edit ? { attemptedEdit: Object.freeze({ ...edit }) } : {}), ...(cause === undefined ? {} : { cause }) }) }));
    };
    // One failure boundary for inline and deferred command work. Detach ownership before
    // notifying the host; reporting must not leave a failed job blocking later input.
    function commandTurn(work: () => void, attemptedText = ""): void {
        const expectedRevision = rangeCommand?.capture.revision ?? executingInput?.capture.revision ?? revision;
        try { work(); }
        catch (error) {
            const pending = takeInput(), executing = executingInput;
            let cause = error;
            try { cancelWord(); refresh(); }
            catch (cleanupError) { cause = new AggregateError([error, cleanupError], "Command and cleanup failed."); }
            finally { cancelCommandTimers(); }
            if (pending) recoverInput(pending, "pending-input-failed");
            if (executing && executing !== pending) recoverInput(executing, "pending-input-failed");
            const unapplied = !executing && workspace.observeDocument(documentId).getSnapshot()?.revision === expectedRevision ? attemptedText : "";
            conflict("command-failed", undefined, expectedRevision, 0, unapplied, cause);
        }
    }
    function revealCaret(selected = view.getSnapshot().selection): void {
        viewport.revealOffset(selected.head, { horizontal: "nearest", vertical: "nearest", affinity: selected.headAffinity ?? "after" });
    }
    function apply(edits: readonly TextEdit[], selection: Selection | SelectionSet, kind: EditKind, type?: string, expectedRevision = revision, recoveryText?: string): boolean {
        if (disposed) return false;
        hostInsertion?.cancel();
        if (readOnly) { conflict("read-only", edits[0], expectedRevision, context.from, recoveryText); refresh(); return false; }
        cancelWord(); preferred = undefined;
        if (!workspace.resolveTab(target)) { conflict("expired-view", edits[0], expectedRevision, context.from, recoveryText); refresh(); return false; }
        let key: string | undefined;
        const now = replayTime ?? win.performance.now(), before = view.getSnapshot().selectionSet;
        const transformed = editTransform?.(Object.freeze({ expectedRevision, edits,
            selectionSet: "ranges" in selection ? selection : createSelectionSet(workspace.document(documentId).buffer.length + edits.reduce((n, edit) => n + edit.insert.length - (edit.to - edit.from), 0), [selection]), kind }));
        if (transformed) { edits = transformed.edits; selection = transformed.selectionSet; }
        if (type) {
            const adjacent = group?.type === type && group.revision === expectedRevision && group.selectionSet === before && now - group.time < 1000;
            key = adjacent ? group!.key : `${view.id}:${scope}:${++serial}`;
        } else group = undefined;
        committing = true; let applied = false;
        try {
            const result = workspace.edit({ documentId, expectedRevision, origin: "human", edits, view,
                ...("ranges" in selection ? { selectionSet: selection } : { selection }),
                history: { kind, ...(key ? { group: key } : {}) } });
            applied = result.applied;
            if (result.applied) { // A later presentation/completion failure must not recover this text twice.
                if (executingInput) delete executingInput.running;
                commits++; const after = view.getSnapshot(); revealCaret(after.selection);
                if (type && key) group = { type, revision: result.revision, selectionSet: after.selectionSet, time: now, key }; }
            else conflict(result.reason, edits[0], expectedRevision, context.from, recoveryText);
        } finally { committing = false; try { transformed?.complete?.(applied); } finally { refresh(); } }
        return applied;
    }
    function captureInput(type: string, data: string | null): InputCapture {
        const target = captureNativeInsertion(input, type, data);
        return { revision, selectionSet: view.getSnapshot().selectionSet, context, ...(target ? { target } : {}) };
    }
    function commit(type: string, captured = insertion ?? { revision, selectionSet: projectedSet, context }): void {
        insertion = undefined;
        if (disposed || composing) return;
        if (type === "historyUndo" || type === "historyRedo") { history(type === "historyUndo" ? "undo" : "redo"); return; }
        const projection = captured.context;
        if (input.value === projection.text && input.selectionStart === (captured.target?.from ?? Math.min(projection.nativeAnchor, projection.nativeHead))
            && input.selectionEnd === (captured.target?.to ?? Math.max(projection.nativeAnchor, projection.nativeHead))) { refresh(); return; }
        if ((captured.target && captured.target.before !== projection.text) || captured.revision !== workspace.observeDocument(documentId).getSnapshot()?.revision || captured.selectionSet !== view.getSnapshot().selectionSet) {
            conflict(type === "insertCompositionText" && captured.revision !== workspace.observeDocument(documentId).getSnapshot()?.revision ? "stale-revision" : "stale-text-input", undefined, captured.revision, projection.from); refresh(); return;
        }
        const native = captured.target && resolveNativeInsertion(captured.target, input, type);
        const edit = native || textDifference(projection.text, input.value);
        if (!edit) { refresh(); return; }
        const selected = captured.selectionSet.ranges[captured.selectionSet.primary]!;
        const exactTarget = native && edit.from === Math.min(projection.nativeAnchor, projection.nativeHead) && edit.to === Math.max(projection.nativeAnchor, projection.nativeHead);
        const from = exactTarget ? Math.min(selected.anchor, selected.head) : projection.toModel(edit.from);
        const to = exactTarget ? Math.max(selected.anchor, selected.head) : edit.from === edit.to ? from : projection.toModel(edit.to), delta = edit.insert.length - (to - from);
        const typing = type === "insertText" && !edit.insert.includes("\n"), deleting = type === "deleteContentBackward" || type === "deleteContentForward";
        const kind = typing ? "typing" : deleting ? "delete" : type === "insertCompositionText" ? "composition" : type === "insertFromPaste" ? "paste" : "replace";
        if (captured.selectionSet.ranges.length > 1) {
            // A native textarea describes one primary target. Replicate only an exact captured
            // selection replacement; neighbouring autocorrection/reconversion needs its own plan.
            if (from !== Math.min(selected.anchor, selected.head) || to !== Math.max(selected.anchor, selected.head)) {
                conflict("unsupported-multiple-input-target", { from, to, insert: edit.insert }, captured.revision, projection.from); refresh(); return;
            }
            const plan = planSelectionEdits(workspace.document(documentId).buffer.length, captured.selectionSet, edit.insert);
            apply(plan.edits, plan.selectionSet, kind, typing || deleting ? type : undefined, captured.revision); return;
        }
        const map = (offset: number) => offset <= edit.from ? projection.toModel(offset)
            : offset >= edit.from + edit.insert.length ? projection.toModel(offset - edit.insert.length + edit.to - edit.from) + delta : from + offset - edit.from;
        const backward = input.selectionDirection === "backward", selection = exactTarget ? { anchor: from + edit.insert.length, head: from + edit.insert.length }
            : { anchor: map(backward ? input.selectionEnd : input.selectionStart), head: map(backward ? input.selectionStart : input.selectionEnd) };
        apply([{ from, to, insert: edit.insert }], selection, kind, typing || deleting ? type : undefined, captured.revision);
    }
    function history(direction: "undo" | "redo"): void {
        if (disposed) return; hostInsertion?.cancel(); cancelWord(); group = undefined; syncSelection();
        if (readOnly) { refresh(); return; }
        if (!workspace.resolveTab(target)) { conflict("expired-view"); refresh(); return; }
        const result = workspace[direction]({ documentId, expectedRevision: revision });
        if (!result.applied && result.reason !== "history-empty") conflict(result.reason);
        else if (result.applied) revealCaret();
        refresh();
    }
    const focus = () => { if (!disposed) { input.focus({ preventScroll: true }); scheduleCaret(); } };
    function replaceSelection(insert: string, kind: EditKind, type?: string): void {
        const document = workspace.document(documentId), plan = planSelectionEdits(document.buffer.length, view.getSnapshot().selectionSet, insert);
        apply(plan.edits, plan.selectionSet, kind, type, document.revision);
    }
    // Delayed commands belong to this captured tab, revision and complete selection set.
    // cancelWord releases scans, row preparation and ordered input; no focused-view lookup occurs later.
    const validCommand = (capture: CommandCapture) => !disposed && !composing && !input.disabled
        && !(capture.deleting && input.readOnly) && !!workspace.resolveTab(target)
        && workspace.observeDocument(documentId).getSnapshot()?.revision === capture.revision
        && view.getSnapshot().selectionSet === capture.selectionSet;
    function withGraphemes(capture: CommandCapture, offset: number, side: -1 | 1, purpose: "word" | "word-selection" | "grapheme", done: (point: GraphemePoint) => void,
        turn: (work: () => void) => void = work => work()): void {
        cancelScans(); if (!validCommand(capture)) return;
        const local = localAsciiGraphemePoint(capture.buffer, offset);
        if (local) { done(local); return; }
        const point = (index: GraphemeIndex): GraphemePoint => Object.freeze({ offset, floor: index.floor(offset), ceil: index.ceil(offset), preceding: index.preceding(offset), following: index.following(offset) });
        const buffer = capture.buffer; let line = buffer.lineAt(offset); if (side < 0 && line > 0 && offset === buffer.offsetAt(line)) line--;
        const from = buffer.offsetAt(line), to = line + 1 < buffer.lineCount ? buffer.offsetAt(line + 1) : buffer.length;
        if (graphemeCache?.buffer === buffer && graphemeCache.from === from && graphemeCache.to === to) { done(point(graphemeCache.index)); return; }
        const job = { cursor: createGraphemeCursor(buffer, { from, to }), capture, purpose }; graphemeJob = job;
        const step = () => turn(() => commandTurn(() => {
            const started = purpose === "word-selection" ? win.performance.now() : 0;
            try {
            if (graphemeJob !== job) return; if (!validCommand(capture)) { cancelWord(); return; }
            const began = win.performance.now(); let result, calls = 0;
            do { result = job.cursor.next(4096); calls++; } while (result.status === "running" && calls < 8 && win.performance.now() - began < 4);
            graphemeScanSteps++; maxGraphemeScanStepMs = Math.max(maxGraphemeScanStepMs, win.performance.now() - began);
            if (result.status === "running") { const timer = win.setTimeout(() => turn(() => { commandTimers.delete(timer); if (graphemeJob === job) graphemeTimer = undefined; step(); }), 0); graphemeTimer = timer; commandTimers.add(timer); return; }
            const index = result.result!; job.cursor.dispose(); graphemeJob = undefined; graphemeCache = Object.freeze({ buffer, from, to, index }); done(point(index));
            } finally { if (purpose === "word-selection") maxWordSelectionTurnMs = Math.max(maxWordSelectionTurnMs, win.performance.now() - started); }
        })); step();
    }
    function commandCapture(deleting: boolean): CommandCapture {
        const document = workspace.document(documentId), { selection, selectionSet } = view.getSnapshot();
        return { buffer: document.buffer, revision: document.revision, selection, selectionSet, deleting };
    }
    function eachRange(capture: CommandCapture, purpose: "word" | "grapheme", resolve: (range: Selection, done: (range: Selection) => void) => void,
        done: (ranges: readonly Selection[]) => void,
        options: Readonly<{ validLayout?: () => boolean; prepare?: (ranges: readonly Selection[]) => () => void; batchSize?: number; navigation?: boolean; inline?: boolean }> = {}): void {
        let release: (() => void) | undefined, batchEnd = options.prepare ? 0 : capture.selectionSet.ranges.length;
        const validLayout = options.validLayout ?? (() => true), turn = options.navigation ? navigationTurn : (work: () => void) => work();
        const job = { capture, purpose, release: () => { const previous = release; release = undefined; previous?.(); } }; rangeCommand = job;
        const ranges: Selection[] = []; let index = 0, pumping = false, waiting = false;
        const active = () => rangeCommand === job && validCommand(capture);
        const pump = () => turn(() => commandTurn(() => {
            if (!active() || !validLayout()) { if (rangeCommand === job) cancelWord(); return; }
            const began = win.performance.now(); let count = 0; pumping = true;
            try {
            if (options.prepare && index === batchEnd) { job.release(); batchEnd = Math.min(capture.selectionSet.ranges.length, index + (options.batchSize ?? 32));
                release = options.prepare(capture.selectionSet.ranges.slice(index, batchEnd)); }
            while (index < batchEnd && !waiting && count++ < 64 && (options.inline || win.performance.now() - began < 4)) {
                waiting = true;
                resolve(capture.selectionSet.ranges[index]!, range => {
                    if (!active()) return;
                    ranges.push(range); index++; waiting = false; if (!pumping) pump();
                });
            }
            } finally { pumping = false; }
            if (!active()) return;
            if (index === capture.selectionSet.ranges.length) { job.release(); rangeCommand = undefined; if (validLayout()) done(ranges); }
            else if (!waiting && options.inline) pump();
            else if (!waiting) { const timer = win.setTimeout(() => turn(() => { commandTimers.delete(timer); if (rangeCommand === job) rangeTimer = undefined; pump(); }), 0);
                rangeTimer = timer; commandTimers.add(timer); }
        })); pump();
    }
    function completeCaptured(capture: CommandCapture, work: () => boolean): boolean {
        if (!validCommand(capture)) { cancelWord(); return false; }
        const pending = ordered?.capture === capture ? takeInput() : undefined;
        if (pending) executingInput = pending;
        let applied = false;
        try { applied = work(); return applied; }
        finally {
            if (pending && !pending.cancelled) {
                if (applied && !disposed) { pending.capture = commandCapture(false); ordered = pending; scheduleInput(); }
                else recoverInput(pending, "pending-input-expired");
            }
            if (executingInput === pending) executingInput = undefined;
        }
    }
    function finishRanges(capture: CommandCapture, ranges: readonly Selection[], type?: string): SelectionSet | undefined {
        if (!validCommand(capture)) return;
        const selections = createSelectionSet(capture.buffer.length, ranges, capture.selectionSet.primary);
        completeCaptured(capture, () => {
        if (capture.deleting) { const plan = planSelectionEdits(capture.buffer.length, selections, "");
            return apply(plan.edits, plan.selectionSet, "delete", type, capture.revision); }
        else { cancelWord(); group = undefined; view.setSelections(capture.revision, selections.ranges, selections.primary);
            const selected = view.getSnapshot().selection;
            viewport.revealOffset(selected.head, { horizontal: "nearest", vertical: "nearest", affinity: selected.headAffinity ?? "after" }); refresh(); }
        return true;
        });
        return view.getSnapshot().selectionSet;
    }
    function moved(range: Selection, offset: number, extend: boolean, affinity: Affinity = "after"): Selection {
        return { anchor: extend ? range.anchor : offset, head: offset, anchorAffinity: extend ? range.anchorAffinity ?? "after" : affinity, headAffinity: affinity };
    }
    function grapheme(direction: -1 | 1, deleting: boolean, extend = false): void {
        cancelWord(); if (disposed || composing || input.disabled || deleting && input.readOnly) return; syncSelection();
        const capture = commandCapture(deleting); graphemeScanSteps = 0; maxGraphemeScanStepMs = 0;
        eachRange(capture, "grapheme", (range, done) => {
            if (range.anchor !== range.head && (deleting || !extend)) {
                done(deleting ? range : moved(range, direction < 0 ? Math.min(range.anchor, range.head) : Math.max(range.anchor, range.head), false)); return;
            }
            const offset = range.head;
            withGraphemes(capture, offset, direction, "grapheme", point => {
                if (deleting) { const from = direction < 0 && point.floor === offset ? point.preceding ?? offset : point.floor, to = direction > 0 ? point.following ?? offset : point.ceil;
                    done({ anchor: from, head: to }); }
                else done(moved(range, direction < 0 ? point.preceding ?? offset : point.following ?? offset, extend));
            });
        }, ranges => finishRanges(capture, ranges, deleting ? direction < 0 ? "deleteContentBackward" : "deleteContentForward" : undefined));
    }
    function word(direction: -1 | 1, deleting: boolean, extend = false): void {
        cancelWord(); if (disposed || composing || input.disabled || deleting && input.readOnly) return;
        group = undefined; preferred = undefined; syncSelection();
        wordScanSteps = 0; maxWordScanStepMs = 0; graphemeScanSteps = 0; maxGraphemeScanStepMs = 0;
        const capture = commandCapture(deleting);
        eachRange(capture, "word", (selected, done) => {
        if (deleting && selected.anchor !== selected.head) { done(selected); return; }
        withGraphemes(capture, selected.head, deleting ? direction < 0 ? 1 : -1 : direction, "word", point => {
        const start = (deleting ? -direction : direction) < 0 ? point.floor : point.ceil;
        const job = { cursor: new WordCursor(capture.buffer, start, direction), revision: capture.revision, selection: selected }; wordJob = job;
        const step = () => commandTurn(() => {
            if (wordJob !== job) return;
            const current = workspace.observeDocument(documentId).getSnapshot();
            if (!validCommand(capture) || current?.revision !== job.revision) { cancelWord(); return; }
            const began = win.performance.now(); let result, count = 0;
            do { result = job.cursor.next(4096); count++; } while (result.status === "running" && count < 32 && win.performance.now() - began < 4);
            wordScanSteps++; maxWordScanStepMs = Math.max(maxWordScanStepMs, win.performance.now() - began);
            if (result.status === "running") {
                const timer = win.setTimeout(() => { commandTimers.delete(timer); if (wordJob === job) wordTimer = undefined; step(); }, 0);
                wordTimer = timer; commandTimers.add(timer); return;
            }
            withGraphemes(capture, result.offset!, direction, "word", point => {
            const end = direction < 0 ? point.floor : point.ceil;
            done(deleting ? { anchor: Math.min(start, end), head: Math.max(start, end) } : moved(selected, end, extend));
            });
        }); step();
        });
        }, ranges => finishRanges(capture, ranges));
    }
    function selectWord(offset: number, add = false): void {
        cancelWord(); if (disposed || composing || input.disabled || !workspace.resolveTab(target)) return;
        stopDrag(); group = undefined; preferred = undefined; focus(); syncSelection();
        const document = workspace.document(documentId), buffer = document.buffer, selected = view.getSnapshot().selection;
        const capture = { buffer, revision: document.revision, selection: selected, selectionSet: view.getSnapshot().selectionSet, deleting: false };
        const line = buffer.lineAt(offset), from = buffer.offsetAt(line);
        let to = line + 1 < buffer.lineCount ? buffer.offsetAt(line + 1) - 1 : buffer.length;
        if (line + 1 < buffer.lineCount && to > from && buffer.slice(to - 1, to) === "\r") to--;
        if (to === from) return;
        const command = { capture, purpose: "word" as const, release: () => {} }; rangeCommand = command;
        wordScanSteps = 0; maxWordScanStepMs = 0; graphemeScanSteps = 0; maxGraphemeScanStepMs = 0;
        const scan = (start: number, direction: -1 | 1, done: (offset: number) => void) => {
            if (!validCommand(capture)) return;
            const job = { cursor: new WordCursor(buffer, start, direction, { from, to, skipWhitespace: false }), revision: capture.revision, selection: selected }; wordJob = job;
            const step = () => commandTurn(() => {
                const started = win.performance.now();
                try {
                if (wordJob !== job) return; if (!validCommand(capture)) { cancelWord(); return; }
                const began = win.performance.now(); let result, count = 0;
                do { result = job.cursor.next(4096); count++; } while (result.status === "running" && count < 32 && win.performance.now() - began < 4);
                wordScanSteps++; maxWordScanStepMs = Math.max(maxWordScanStepMs, win.performance.now() - began);
                if (result.status === "running") {
                    const timer = win.setTimeout(() => { commandTimers.delete(timer); if (wordJob === job) wordTimer = undefined; step(); }, 0);
                    wordTimer = timer; commandTimers.add(timer); return;
                }
                done(result.offset!);
                } finally { maxWordSelectionTurnMs = Math.max(maxWordSelectionTurnMs, win.performance.now() - started); }
            }); step();
        };
        withGraphemes(capture, Math.min(offset, to), -1, "word-selection", point => {
            const probe = Math.max(from, offset >= to ? point.preceding ?? from : point.floor);
            const width = buffer.slice(probe, Math.min(to, probe + 2)).codePointAt(0)! > 0xffff ? 2 : 1;
            scan(Math.min(to, probe + width), -1, left => scan(probe, 1, right => {
                withGraphemes(capture, left, -1, "word-selection", low => withGraphemes(capture, right, 1, "word-selection", high => {
                    if (rangeCommand !== command || !validCommand(capture)) return;
                    const range = { anchor: Math.max(from, low.floor), head: Math.min(to, high.ceil) };
                    rangeCommand = undefined; completeCaptured(capture, () => {
                    if (add) view.setSelections(capture.revision, [...capture.selectionSet.ranges, range], capture.selectionSet.ranges.length);
                    else view.setSelection(capture.revision, range);
                    refresh(); return true;
                    });
                }));
            }));
        });
    }
    function navigationTurn(work: () => void): void {
        if (navigationDepth) { work(); return; }
        const began = win.performance.now(); navigationDepth++;
        try { work(); } finally { navigationDepth--; const elapsed = win.performance.now() - began;
            navigationTurns++; navigationWorkMs += elapsed; maxNavigationTurnMs = Math.max(maxNavigationTurnMs, elapsed); }
    }
    function navigationStyle(): string {
        const style = win.getComputedStyle(root);
        return [root.isConnected, style.width, style.height, style.fontFamily, style.fontSize, style.fontWeight, style.fontStyle, style.lineHeight,
            style.letterSpacing, style.wordSpacing, style.tabSize, style.direction, style.getPropertyValue("--st-text-direction"),
            style.fontVariantLigatures, style.fontKerning, style.fontFeatureSettings, style.fontVariationSettings, style.transform, cssZoom(root), owner.fonts.status].join("|");
    }
    function navigationLayout(style = navigationStyle()): string {
        const state = viewport.snapshot();
        return [style, root.clientWidth, root.clientHeight, state.width, state.height, state.lineHeight, state.columnWidth, state.rowGeneration, view.folding.getSnapshot().generation].join("|");
    }
    function beginNavigation(prepare: (capture: CommandCapture, style: string, inline: boolean) => void, canInline?: (capture: CommandCapture) => boolean): void {
        cancelWord(); navigationTurns = 0; navigationPreparationMs = 0; maxNavigationTurnMs = 0; navigationWorkMs = 0;
        navigationTurn(() => commandTurn(() => {
            const capture = commandCapture(false), job = { capture, purpose: "grapheme" as const, release: () => {} };
            if (!validCommand(capture)) return; rangeCommand = job;
            const inline = canInline?.(capture) ?? false, style = navigationStyle();
            const initialize = (resumed: boolean) => commandTurn(() => {
                if (rangeCommand !== job) return;
                // No host callback separates an immediate initializer from its capture.
                // Resumed work and preparation after viewport callbacks still recheck style.
                if (!validCommand(capture) || resumed && navigationStyle() !== style) { cancelWord(); return; }
                prepare(capture, style, inline);
                if (rangeCommand === job) cancelWord();
            });
            if (capture.selectionSet.ranges.length === 1 || inline) initialize(false);
            else { const timer = win.setTimeout(() => navigationTurn(() => { commandTimers.delete(timer); if (rangeCommand === job) rangeTimer = undefined; initialize(true); }), 0);
                rangeTimer = timer; commandTimers.add(timer); }
        }));
    }
    function shortHorizontal(capture: CommandCapture): boolean {
        // At most32 ranges and bounded native rows; longer contexts keep cooperative scans.
        if (capture.selectionSet.ranges.length > 32) return false;
        const buffer = capture.buffer, folds = view.folding.getSnapshot().index, lines = new Set<number>();
        for (const range of capture.selectionSet.ranges) {
            const line = buffer.lineAt(range.head), row = folds.rowAt(line);
            lines.add(line); lines.add(buffer.lineAt(range.anchor));
            if (line) lines.add(line - 1); if (line + 1 < buffer.lineCount) lines.add(line + 1);
            if (row) lines.add(folds.lineAt(row - 1)); if (row + 1 < folds.visibleLineCount) lines.add(folds.lineAt(row + 1));
        }
        return shortRows(buffer, lines);
    }
    function shortRows(buffer: TextBuffer, lines: Iterable<number>): boolean {
        for (const line of lines) if ((line + 1 < buffer.lineCount ? buffer.offsetAt(line + 1) : buffer.length) - buffer.offsetAt(line) > 514) return false;
        return true;
    }
    function verticalCount(page: boolean): number {
        const state = viewport.snapshot(); return page ? Math.max(1, Math.floor(state.height / state.lineHeight) - 1) : 1;
    }
    function shortVertical(capture: CommandCapture, direction: -1 | 1, page: boolean): boolean {
        if (capture.selectionSet.ranges.length > 2) return false;
        // Page destinations use current viewport dimensions, including a pending resize.
        viewport.flush();
        if (viewport.snapshot().aligned) return false;
        const buffer = capture.buffer, folds = view.folding.getSnapshot().index, count = verticalCount(page), lines = new Set<number>();
        for (const range of capture.selectionSet.ranges) {
            const line = buffer.lineAt(range.head), row = folds.rowAt(line);
            lines.add(line); lines.add(folds.lineAt(Math.max(0, Math.min(folds.visibleLineCount - 1, row + direction * count))));
        }
        return shortRows(buffer, lines);
    }
    function boundaryOffset(buffer: TextBuffer, head: number, key: string, documentBoundary: boolean): number {
        if (documentBoundary) return key === "Home" ? 0 : buffer.length;
        const line = buffer.lineAt(head), start = buffer.offsetAt(line);
        if (key === "Home") return start;
        let end = line + 1 < buffer.lineCount ? buffer.offsetAt(line + 1) - 1 : buffer.length;
        if (line + 1 < buffer.lineCount && end > start && buffer.slice(end - 1, end) === "\r") end--;
        return end;
    }
    function horizontal(key: string, extend: boolean, documentBoundary = false): void {
        preferred = undefined;
        graphemeScanSteps = 0; maxGraphemeScanStepMs = 0;
        // Indexed endpoints need no geometry. Finish bounded sets before the next input,
        // which would otherwise cancel queued navigation and edit the previous ranges.
        if ((key === "Home" || key === "End") && view.getSnapshot().selectionSet.ranges.length <= 32) {
            cancelWord(); navigationTurns = 0; navigationPreparationMs = 0; maxNavigationTurnMs = 0; navigationWorkMs = 0;
            navigationTurn(() => {
                const capture = commandCapture(false); if (!validCommand(capture)) return;
                finishRanges(capture, capture.selectionSet.ranges.map(range => moved(range, boundaryOffset(capture.buffer, range.head, key, documentBoundary), extend)));
            }); return;
        }
        beginNavigation((capture, style, inline) => {
        const began = win.performance.now(); viewport.flush();
        if (!validCommand(capture) || navigationStyle() !== style) { cancelWord(); return; }
        const layout = navigationLayout(style), buffer = capture.buffer, arrows = key === "ArrowLeft" || key === "ArrowRight", foldIndex = view.folding.getSnapshot().index;
        navigationPreparationMs = win.performance.now() - began;
        eachRange(capture, "grapheme", (range, done) => {
            if (key === "Home" || key === "End") {
                done(moved(range, boundaryOffset(buffer, range.head, key, documentBoundary), extend)); return;
            }
            const direction = key === "ArrowLeft" ? -1 : 1;
            const point = !extend && range.anchor !== range.head
                ? viewport.collapseVisual(Math.min(range.anchor, range.head), Math.max(range.anchor, range.head), direction, false)
                : viewport.moveVisual(range.head, range.headAffinity ?? "after", direction, false);
            if (point) { visualMoves++; done(moved(range, point.offset, extend, point.affinity)); return; }
            if (!extend && range.anchor !== range.head) { done(moved(range, direction < 0 ? Math.min(range.anchor, range.head) : Math.max(range.anchor, range.head), false)); return; }
            withGraphemes(capture, range.head, direction, "grapheme", at => done(moved(range, direction < 0 ? at.preceding ?? range.head : at.following ?? range.head, extend)), navigationTurn);
        }, ranges => finishRanges(capture, ranges), { validLayout: () => navigationLayout() === layout, navigation: true, inline, ...(arrows && capture.selectionSet.ranges.length > 1 ? {
            batchSize: 16, prepare: (ranges: readonly Selection[]) => {
                const lines = new Set<number>();
                for (const range of ranges) {
                    const line = buffer.lineAt(range.head); lines.add(line);
                    if (!extend && range.anchor !== range.head) lines.add(buffer.lineAt(range.anchor));
                    else { const row = foldIndex.rowAt(line); if (row) lines.add(foldIndex.lineAt(row - 1)); if (row + 1 < foldIndex.visibleLineCount) lines.add(foldIndex.lineAt(row + 1)); }
                }
                return viewport.prepareNavigationRows([...lines]);
            } } : {}) });
        }, shortHorizontal);
    }
    function vertical(direction: -1 | 1, page: boolean, extend: boolean): void {
        beginNavigation((capture, style, inline) => {
        const began = win.performance.now(); viewport.flush();
        const buffer = capture.buffer, selected = capture.selection;
        if (!viewport.coordsAt(selected.head, selected.headAffinity)) { revealCaret(selected); viewport.flush(); }
        if (!validCommand(capture) || navigationStyle() !== style) { cancelWord(); return; }
        const state = viewport.snapshot(), layout = navigationLayout(style);
        const prior = preferred?.selections === capture.selectionSet && preferred.revision === capture.revision && preferred.layout === layout ? preferred.columns : undefined;
        const columns: (number | undefined)[] = [], count = verticalCount(page);
        navigationPreparationMs = win.performance.now() - began;
        let index = 0, pageDelta = 0;
        eachRange(capture, "grapheme", (range, done) => {
            const at = index++, line = buffer.lineAt(range.head), row = viewport.visualRowAt(line), next = viewport.navigationLine(line, direction, count, page);
            if (at === capture.selectionSet.primary) pageDelta = (viewport.visualRowAt(next) - row) * state.lineHeight;
            if (next === line) { columns.push(undefined); done(moved(range, direction < 0 ? 0 : buffer.length, extend)); return; }
            const column = prior?.[at] ?? viewport.columnAt(range.head, range.headAffinity);
            const hit = column === undefined ? undefined : viewport.caretAtColumn(next, column);
            columns.push(column); done(hit ? moved(range, hit.offset, extend, hit.affinity) : range);
        }, ranges => {
            if (page) viewport.scrollTo({ top: state.scrollTop + pageDelta });
            const selections = finishRanges(capture, ranges); if (!selections) return;
            // Normalization may reorder/coalesce targets. Carry the owning range's column,
            // using the same primary/first-supplied ownership as the public selection model.
            const ordered = ranges.map((range, at) => ({ from: Math.min(range.anchor, range.head), to: Math.max(range.anchor, range.head), at }))
                .sort((a, b) => a.from - b.from || a.to - b.to || a.at - b.at);
            let cursor = 0;
            const nextColumns = selections.ranges.map(range => {
                const from = Math.min(range.anchor, range.head), to = Math.max(range.anchor, range.head); let ownerIndex = Infinity;
                while (cursor < ordered.length && ordered[cursor]!.from >= from && ordered[cursor]!.to <= to) {
                    const at = ordered[cursor++]!.at;
                    if (at === capture.selectionSet.primary || ownerIndex !== capture.selectionSet.primary && at < ownerIndex) ownerIndex = at;
                }
                return columns[ownerIndex];
            });
            preferred = { selections, revision: capture.revision, layout, columns: nextColumns };
        }, { validLayout: () => navigationLayout() === layout, navigation: true, inline, ...(capture.selectionSet.ranges.length > 1 ? {
            ...(capture.selectionSet.ranges.length <= 32 ? { batchSize: 16 } : {}),
            prepare: (ranges: readonly Selection[]) => viewport.prepareNavigationRows([...new Set(ranges.flatMap(range => {
                const line = buffer.lineAt(range.head); return [line, viewport.navigationLine(line, direction, count, page)];
            }))]) } : {}) });
        }, capture => shortVertical(capture, direction, page));
    }
    function languageCommand(command: EditingCommand | Readonly<{ character: string }>): boolean {
        if (disposed || composing || input.disabled || input.readOnly) return false;
        if (command === "line-comment" && !language.lineComment || command === "block-comment" && !language.blockComment) return false;
        cancelWord(); syncSelection();
        const capture = commandCapture(true), planner = planLanguageEdit(capture.buffer, capture.selectionSet, command, language);
        let planning = false;
        const job = { capture, purpose: "grapheme" as const, release: () => { if (!planning) planner.return({ edits: [], selectionSet: capture.selectionSet }); } }; rangeCommand = job;
        const step = () => commandTurn(() => {
            if (rangeCommand !== job) return;
            if (!validCommand(capture)) { cancelWord(); return; }
            let result;
            try {
                planning = true; const began = win.performance.now(); let batches = 0;
                do { result = planner.next(); }
                while (!result.done && rangeCommand === job && ++batches < 8 && win.performance.now() - began < 4);
            }
            finally { planning = false; }
            if (rangeCommand !== job) { planner.return({ edits: [], selectionSet: capture.selectionSet }); return; }
            if (!result.done) {
                const timer = win.setTimeout(() => { commandTimers.delete(timer); if (rangeCommand === job) rangeTimer = undefined; step(); }, 0);
                rangeTimer = timer; commandTimers.add(timer); return;
            }
            rangeCommand = undefined;
            completeCaptured(capture, () => {
                const plan = result.value;
                if (plan.edits.length) return apply(plan.edits, plan.selectionSet, typeof command === "object" ? "typing" : "replace", undefined, capture.revision);
                group = undefined; view.setSelections(capture.revision, plan.selectionSet.ranges, plan.selectionSet.primary);
                revealCaret(); refresh(); return true;
            });
        }, typeof command === "object" ? command.character : "");
        group = undefined; step(); return true;
    }
    const pairKey = (key: string) => key.length === 1 && language.pairs.some(pair => pair.open === key || pair.close === key);
    function configuredInput(type: string, text: string | null): boolean {
        if (type === "insertLineBreak") return languageCommand("newline");
        return type === "insertText" && text !== null && pairKey(text) && languageCommand({ character: text });
    }
    function takeInput(): OrderedInput | undefined {
        if (orderedTimer !== undefined) { win.clearTimeout(orderedTimer); commandTimers.delete(orderedTimer); orderedTimer = undefined; }
        const pending = ordered; ordered = undefined; return pending;
    }
    function recoverInput(pending: OrderedInput, reason: string): void {
        if (pending.cancelled) return; pending.cancelled = true;
        const committed = committing && workspace.observeDocument(documentId).getSnapshot()?.revision !== pending.capture.revision;
        let text = (committed ? "" : pending.running?.text ?? "") + pending.actions.map(action => action.text).join(""); delete pending.running; pending.actions = []; pending.units = 0;
        if (nativeOrder?.order === pending) { nativeOrder.invalid = true;
            if (!nativeOrder.reported && nativeOrder.data !== null) { text += nativeOrder.data; nativeOrder.reported = true; } }
        if (text.length) conflict(reason, undefined, pending.capture.revision, 0, text);

    }
    function currentInput(pending: OrderedInput): boolean {
        return !pending.cancelled && validCommand(pending.capture) && root.isConnected && workspace.ownsDocumentView(view) && !(pending.edit && input.readOnly);
    }
    function inputOrder(): OrderedInput | undefined {
        if (ordered) return ordered;
        if (!rangeCommand || !validCommand(rangeCommand.capture)) return;
        return ordered = { capture: rangeCommand.capture, purpose: rangeCommand.purpose, actions: [], units: 0, edit: rangeCommand.capture.deleting, native: false };
    }
    function appendInput(action: InputIntent): void {
        const pending = inputOrder(); if (!pending) return;
        action.at = win.performance.now();
        if (!currentInput(pending) || pending.actions.length >= 256 || pending.units + action.text.length > 65536) {
            const capture = pending.capture; cancelWord();
            if (action.text.length) conflict("pending-input-limit-or-expiry", undefined, capture.revision, 0, action.text); return;
        }
        const last = pending.actions.at(-1);
        if (last?.kind === "text" && action.kind === "text" && last.type === "insertText" && action.type === "insertText" && last.literal === action.literal && !pairKey(last.text) && !pairKey(action.text) && action.at - (last.at ?? action.at) < 1000) { last.text += action.text; last.at = action.at; }
        else pending.actions.push(action);
        pending.units += action.text.length; pending.edit ||= action.kind === "text" || action.edit;
        scheduleInput();
    }
    function scheduleInput(): void {
        if (!ordered || rangeCommand || ordered.native || orderedTimer !== undefined) return;
        const timer = win.setTimeout(() => { const began = win.performance.now();
            try { commandTimers.delete(timer); if (orderedTimer === timer) orderedTimer = undefined; drainInput(); }
            finally { const elapsed = win.performance.now() - began; maxQueuedInputTurnMs = Math.max(maxQueuedInputTurnMs, elapsed); }
        }, 0);
        orderedTimer = timer; commandTimers.add(timer);
    }
    function drainInput(): void {
        const pending = takeInput(); if (!pending) return;
        if (!currentInput(pending)) { recoverInput(pending, "pending-input-expired"); return; }
        const began = win.performance.now(); let count = 0; drainingInput = true; executingInput = pending;
        try { commandTurn(() => {
            while (pending.actions.length && count++ < 8 && win.performance.now() - began < 4) {
                const action = pending.actions.shift()!; pending.running = action;
                const beforeConflicts = conflicts;
                replayTime = action.at;
                if (action.kind === "text" && !action.literal && configuredInput(action.type, action.text)) {
                    // The same captured command path serves keyboard and cancellable native input.
                } else if (action.kind === "text") {
                    const document = workspace.document(documentId), plan = planSelectionEdits(document.buffer.length, view.getSnapshot().selectionSet, action.text);
                    const typing = action.type === "insertText" && !action.text.includes("\n");
                    if (!apply(plan.edits, plan.selectionSet, typing ? "typing" : action.type === "insertFromPaste" ? "paste" : "replace", typing ? "insertText" : undefined, document.revision, action.text)) {
                        delete pending.running; recoverInput(pending, "pending-input-rejected"); return;
                    }
                } else {
                    const event = new win.KeyboardEvent("keydown", { ...action, cancelable: true }); keydown(event);
                    if (action.text && action.key !== "Tab" && !event.defaultPrevented) replaceSelection(action.text, "typing", "insertText");
                }
                if (conflicts !== beforeConflicts) { recoverInput(pending, "pending-input-rejected"); return; }
                replayTime = undefined; delete pending.running; pending.units -= action.text.length;
                if (pending.cancelled || disposed) return;
                if (rangeCommand) {
                    if (pending.actions.length || pending.native || rangeCommand.capture.deleting) { pending.capture = rangeCommand.capture; pending.purpose = rangeCommand.purpose; ordered = pending; }
                    return;
                }
                pending.capture = commandCapture(false);
                if (!currentInput(pending)) { recoverInput(pending, "pending-input-expired"); return; }
            }
            if (pending.actions.length || pending.native) { ordered = pending; scheduleInput(); }
        }); }
        finally { replayTime = undefined; if (executingInput === pending) executingInput = undefined; drainingInput = false;
            }
    }
    function caretChord(event: KeyboardEvent): Readonly<{ edge: "Home" | "End"; document: boolean }> | undefined {
        if (!apple || !event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") return { edge: event.key === "ArrowLeft" ? "Home" : "End", document: false };
        if (event.key === "ArrowUp" || event.key === "ArrowDown") return { edge: event.key === "ArrowUp" ? "Home" : "End", document: true };
        return;
    }
    function inputKey(event: KeyboardEvent): InputKey | undefined {
        const command = (event.ctrlKey || event.metaKey) && !event.altKey, key = event.key.toLowerCase();
        const word = !event.metaKey && (event.ctrlKey && !event.altKey || apple && event.altKey && !event.ctrlKey);
        const navigation = !!caretChord(event) || command && ["a", "home", "end"].includes(key) || word && ["ArrowLeft", "ArrowRight"].includes(event.key)
            || !command && !event.altKey && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key);
        const historyKey = command && (key === "z" || event.ctrlKey && key === "y"), deletion = (!command && !event.altKey || word) && ["Backspace", "Delete"].includes(event.key);
        const tab = event.key === "Tab" && !escaped && !command && !event.altKey, bracketKey = !command && !event.altKey && pairKey(event.key);
        const enter = event.key === "Enter" && !command && !event.altKey, comment = command && (key === "/" || key === "?" && event.shiftKey);
        if (!navigation && !historyKey && !deletion && !tab && !bracketKey && !enter && !comment) return;
        return { kind: "key", key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey,
            text: tab ? "\t" : enter ? "\n" : bracketKey ? event.key : "", edit: !navigation };
    }
    function nativeIntent(type: string): InputKey | undefined {
        const word = type.startsWith("deleteWord"), backward = type.endsWith("Backward");
        if (["deleteWordBackward", "deleteWordForward", "deleteContentBackward", "deleteContentForward"].includes(type))
            return { kind: "key", key: backward ? "Backspace" : "Delete", ctrlKey: word, metaKey: false, altKey: false, shiftKey: false, text: "", edit: true };
        if (type === "historyUndo" || type === "historyRedo") return { kind: "key", key: "z", ctrlKey: true, metaKey: false, altKey: false, shiftKey: type === "historyRedo", text: "", edit: true };
        return;
    }
    function captureOrderedInput(event: InputEvent): boolean {
        if (composing || event.isComposing || input.disabled || input.readOnly || !ordered && !rangeCommand) return false;
        const text = event.inputType === "insertText" || event.inputType === "insertLineBreak", action = nativeIntent(event.inputType);
        if (!text && !action) return false;
        const pending = inputOrder(); if (!pending) return false;
        const data = event.inputType === "insertLineBreak" ? "\n" : event.data;
        if (event.cancelable && (action || data !== null)) { event.preventDefault(); appendInput(action ?? { kind: "text", text: data!, type: event.inputType }); return true; }
        pending.native = true; pending.edit = true;
        nativeOrder = { order: pending, capture: captureInput(event.inputType, event.data), type: event.inputType, data, ...(action ? { action } : {}), invalid: false, reported: false };
        return true;
    }
    function commitOrderedInput(event: InputEvent): boolean {
        let pendingNative = nativeOrder; nativeOrder = undefined;
        if (!pendingNative && !composing && !event.isComposing && (ordered || rangeCommand) && ["insertText", "insertLineBreak"].includes(event.inputType)) {
            const pending = inputOrder(); if (!pending) return false;
            pendingNative = { order: pending, capture: { revision, selectionSet: projectedSet, context, target: { type: event.inputType, before: context.text,
                from: Math.min(context.nativeAnchor, context.nativeHead), to: Math.max(context.nativeAnchor, context.nativeHead), data: event.data } }, type: event.inputType, data: event.data, invalid: false, reported: false };
        }
        if (!pendingNative) return false;
        const native = pendingNative, pending = native.order; pending.native = false;
        if (native.invalid || ordered !== pending || !currentInput(pending) || event.inputType !== native.type) {
            const text = event.data ?? native.data ?? input.value;
            if (!native.reported || text !== native.data) conflict("pending-native-input-expired", undefined, native.capture.revision, 0, text);
            if (ordered === pending) cancelWord(); refresh(); return true;
        }
        const projection = native.capture.context, edit = native.capture.target && resolveNativeInsertion(native.capture.target, input, event.inputType);
        if (native.action) appendInput(native.action);
        else if (edit && edit.from === Math.min(projection.nativeAnchor, projection.nativeHead) && edit.to === Math.max(projection.nativeAnchor, projection.nativeHead))
            appendInput({ kind: "text", text: edit.insert, type: event.inputType, literal: true });
        else { cancelWord(); conflict("pending-native-input-target", undefined, native.capture.revision, 0, event.data ?? native.data ?? input.value); }
        refresh(); scheduleInput(); return true;
    }
    function beforeInput(event: InputEvent): void {
        hostInsertion?.cancel();
        wordInput = undefined; insertion = undefined;
        if (nativeOrder) { if (!nativeOrder.invalid) cancelWord(); nativeOrder = undefined; }
        if (event.defaultPrevented) return;
        if (input.readOnly) { if (event.cancelable) event.preventDefault(); return; }
        if (captureOrderedInput(event)) return;
        if (!composing) view.folding.revealSelection(view.folding.getSnapshot());
        if (!composing && ["deleteWordBackward", "deleteWordForward", "deleteContentBackward", "deleteContentForward"].includes(event.inputType)) {
            syncSelection(); const direction = event.inputType.endsWith("Backward") ? -1 : 1, wholeWord = event.inputType.startsWith("deleteWord");
            if (event.cancelable) { event.preventDefault(); (wholeWord ? word : grapheme)(direction, true); }
            else wordInput = { revision, selectionSet: view.getSnapshot().selectionSet, direction, word: wholeWord };
        } else if (!composing && event.cancelable && (event.inputType === "historyUndo" || event.inputType === "historyRedo")) { event.preventDefault(); history(event.inputType === "historyUndo" ? "undo" : "redo"); }
        else syncSelection();
        if (!composing && !event.isComposing && !input.disabled && !input.readOnly && input.value === context.text) {
            if (event.cancelable && configuredInput(event.inputType, event.data)) { event.preventDefault(); return; }
            // Keep the native projection bounded during insertion, not just after input. Browsers
            // may expand a multiline insertText into thousands of native edits before notifying us.
            // Composition and incomplete/noncancelable events retain the captured native path.
            if (event.cancelable && event.inputType === "insertText" && event.data !== null
                && input.value.length - (input.selectionEnd - input.selectionStart) + event.data.length > inputContextUnits) {
                event.preventDefault();
                const text = event.data.replace(/\r\n?/g, "\n"), typing = !text.includes("\n");
                replaceSelection(text, typing ? "typing" : "replace", typing ? "insertText" : undefined);
                return;
            }
            insertion = captureInput(event.inputType, event.data);
        }
    }
    input.addEventListener("beforeinput", event => { const began = win.performance.now();
        try { beforeInput(event); } finally { beforeInputEvents++; lastBeforeInputMs = win.performance.now() - began; }
    }, { signal: listeners.signal });
    input.addEventListener("input", event => {
        const start = win.performance.now(), type = (event as InputEvent).inputType;
        if (commitOrderedInput(event as InputEvent)) { lastInputMs = win.performance.now() - start; inputEvents++; return; }
        if (!composing && ["deleteWordBackward", "deleteWordForward", "deleteContentBackward", "deleteContentForward"].includes(type)) {
            const captured = wordInput; wordInput = undefined;
            if (!captured || input.disabled || input.readOnly || !workspace.resolveTab(target) || captured.direction !== (type.endsWith("Backward") ? -1 : 1)
                || captured.revision !== revision || captured.selectionSet !== view.getSnapshot().selectionSet) { conflict(type.startsWith("deleteWord") ? "stale-word-input" : "stale-delete-input"); refresh(); }
            else { refresh(); (captured.word ? word : grapheme)(captured.direction, true); }
        } else commit(type);
        lastInputMs = win.performance.now() - start; inputEvents++;
    }, { signal: listeners.signal });
    function startComposition(): void {
        hostInsertion?.cancel();
        cancelWord();
        cancelCommandTimers();
        wordInput = undefined;
        insertion = undefined;
        syncSelection();
        view.folding.revealSelection(view.folding.getSnapshot());
        composition = captureInput("insertCompositionText", null);
        composing = true;
        group = undefined;
        root.classList.add("st-composing");
        viewport.invalidate();
        scheduleCaret();
    }
    function endComposition(): void {
        const captured = composition;
        composition = undefined;
        composing = false;
        root.classList.remove("st-composing");
        viewport.invalidate();
        commit("insertCompositionText", captured);
    }
    input.addEventListener("compositionstart", startComposition, { signal: listeners.signal });
    input.addEventListener("compositionend", endComposition, { signal: listeners.signal });
    input.addEventListener("select", syncSelection, { signal: listeners.signal });
    // Tab can reset the browser range after focus dispatch. It changes focus, not model selection.
    input.addEventListener("keyup", event => { if (event.key === "Tab") refresh(); else syncSelection(); }, { signal: listeners.signal });
    input.addEventListener("focus", scheduleCaret, { signal: listeners.signal });
    input.addEventListener("blur", () => { syncSelection(); group = undefined; scheduleCaret();
        // Restore disclosure tab stops after the browser has completed focus traversal.
        if (escaped) queueMicrotask(() => { if (!disposed) escapeState(false); }); }, { signal: listeners.signal });
    function keydown(event: KeyboardEvent): void {
        if (event.defaultPrevented || composing || event.isComposing || event.keyCode === 229) return;
        if (["Shift", "Control", "Meta", "Alt"].includes(event.key)) return;
        if (hostInsertion) { hostInsertion.cancel(); if (event.key === "Escape") { event.preventDefault(); return; } }
        if (!drainingInput && (ordered || rangeCommand) && event.key !== "Escape") {
            const action = inputKey(event);
            if (action && (!action.edit || !input.readOnly)) { event.preventDefault(); appendInput(action); return; }
            if (!(event.ctrlKey || event.metaKey || event.altKey)) return;
        }
        if (escaped && event.key !== "Escape" && event.key !== "Tab") escapeState(false);
        view.folding.revealSelection(view.folding.getSnapshot());
        const command = (event.ctrlKey || event.metaKey) && !event.altKey, key = event.key.toLowerCase();
        if (command && (key === "z" || (event.ctrlKey && key === "y"))) { event.preventDefault(); history(event.shiftKey || key === "y" ? "redo" : "undo"); return; }
        if (command && key === "a") { event.preventDefault(); cancelWord(); preferred = undefined; const length = workspace.document(documentId).buffer.length; view.setSelection(revision, { anchor: 0, head: length }); refresh(); return; }
        if (command && (event.key === "Home" || event.key === "End")) { event.preventDefault(); syncSelection(); horizontal(event.key, event.shiftKey, true); return; }
        const chord = caretChord(event);
        if (chord) { event.preventDefault(); syncSelection(); horizontal(chord.edge, event.shiftKey, chord.document); return; }
        if (event.key === "Escape") {
            cancelWord(); cancelCommandTimers(); preferred = undefined;
            const state = view.getSnapshot();
            if (state.selectionSet.ranges.length > 1) { event.preventDefault(); view.setSelection(revision, state.selection); refresh(); }
            escapeState(true); return;
        }
        // Backward focus traversal presses Shift before Tab.
        if (escaped && event.key === "Shift") return;
        if (event.key === "Tab" && escaped) return;
        escapeState(false); syncSelection();
        const wordModifier = !event.metaKey && (event.ctrlKey && !event.altKey || apple && event.altKey && !event.ctrlKey);
        if (wordModifier && ["ArrowLeft", "ArrowRight", "Backspace", "Delete"].includes(event.key)) {
            event.preventDefault(); word(event.key === "ArrowLeft" || event.key === "Backspace" ? -1 : 1, event.key === "Backspace" || event.key === "Delete", event.shiftKey); return;
        }
        if (!event.altKey && !command && ["ArrowUp", "ArrowDown", "PageUp", "PageDown"].includes(event.key)) {
            event.preventDefault(); vertical(event.key === "ArrowUp" || event.key === "PageUp" ? -1 : 1, event.key.startsWith("Page"), event.shiftKey); return;
        }
        if (!event.altKey && !command && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
            event.preventDefault(); horizontal(event.key, event.shiftKey); return;
        }
        preferred = undefined;
        if (!command && !event.altKey && (event.key === "Backspace" || event.key === "Delete")) {
            event.preventDefault(); grapheme(event.key === "Backspace" ? -1 : 1, true);
        } else if (event.key === "Tab" && !command && !event.altKey) { if (languageCommand(event.shiftKey ? "outdent" : "indent")) event.preventDefault(); }
        else if (command && (key === "/" || key === "?" && event.shiftKey) && languageCommand(event.shiftKey ? "block-comment" : "line-comment")) event.preventDefault();
        else if (!command && !event.altKey && event.key === "Enter" && languageCommand("newline")) event.preventDefault();
        else if (!command && !event.altKey && pairKey(event.key) && languageCommand({ character: event.key })) event.preventDefault();
        // Unhandled command-navigation must not move inside the bounded textarea context.
        else if (command && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown"].includes(event.key)) event.preventDefault();
    }
    input.addEventListener("keydown", event => {
        const started = win.performance.now(); keydownEvents++;
        try { keydown(event); } finally { lastKeydownMs = win.performance.now() - started; }
    }, { signal: listeners.signal });
    root.addEventListener("dblclick", event => {
        const began = win.performance.now();
        try {
        wordSelectionEvents++;
        if (event.button !== 0 || disposed || composing || input.disabled || !workspace.resolveTab(target)) return;
        const point = viewport.hitTest(event.clientX, event.clientY); if (!point) return;
        event.preventDefault(); selectWord(point.offset, event.altKey);
        } finally { lastWordSelectionMs = win.performance.now() - began; maxWordSelectionTurnMs = Math.max(maxWordSelectionTurnMs, lastWordSelectionMs); }
    }, { signal: listeners.signal });
    const textDrag = mountTextDragDrop({ workspace, tab: target, view, viewport, input,
        available: () => !disposed && !composing && !input.disabled,
        beforeStart: () => { stopDrag(); cancelWord(); cancelCommandTimers(); preferred = undefined; group = undefined; },
        afterDrop: () => { commits++; revealCaret(); focus(); refresh(); },
        rejected: reason => { conflict(reason); refresh(); } });
    root.addEventListener("pointerdown", event => {
        if (event.button !== 0 || disposed || composing || input.disabled || !workspace.resolveTab(target)) return;
        if (textDrag.arm(event)) return;
        // The transparent native context can overlap source text; its default hit test uses context coordinates.
        const point = viewport.hitTest(event.clientX, event.clientY); if (!point) return;
        event.preventDefault(); stopDrag(); cancelWord(); preferred = undefined; focus(); group = undefined;
        const state = view.getSnapshot(), extending = event.shiftKey && !event.altKey;
        const anchor = extending ? state.selection.anchor : point.offset, anchorAffinity = extending ? state.selection.anchorAffinity ?? "after" : point.affinity;
        const baseRanges = event.altKey ? state.selectionSet.ranges : extending ? state.selectionSet.ranges.filter((_, index) => index !== state.selectionSet.primary) : [];
        view.setSelections(revision, [...baseRanges, { anchor, head: point.offset, anchorAffinity, headAffinity: point.affinity }], baseRanges.length); refresh();
        if (point.padding) viewport.revealOffset(point.offset, { horizontal: "nearest", vertical: "nearest", affinity: point.affinity });
        drag = { pointer: event.pointerId, anchor, anchorAffinity, revision, x: event.clientX, y: event.clientY, selectionSet: view.getSnapshot().selectionSet, baseRanges, padding: point.padding === true }; root.setPointerCapture(event.pointerId);
    }, { signal: listeners.signal });
    root.addEventListener("pointermove", event => {
        if (drag?.pointer !== event.pointerId) return;
        if (!(event.buttons & 1) || !validDrag()) { stopDrag(); return; }
        drag = { ...drag, x: event.clientX, y: event.clientY }; updateDragHead(); scheduleDragScroll();
    }, { signal: listeners.signal });
    function validDrag(): boolean {
        return !!drag && !disposed && !composing && !input.disabled && root.isConnected && root.clientWidth > 0 && root.clientHeight > 0
            && drag.revision === revision && drag.selectionSet === view.getSnapshot().selectionSet && !!workspace.resolveTab(target) && root.hasPointerCapture(drag.pointer);
    }
    function dragBounds() {
        return clientBox(root);
    }
    function updateDragHead(): void {
        const current = drag; if (!current) return; const bounds = dragBounds();
        const point = viewport.hitTest(Math.max(bounds.left, Math.min(bounds.right - 1, current.x)), Math.max(bounds.top, Math.min(bounds.bottom - 1, current.y)));
        if (!point) return;
        view.setSelections(current.revision, [...current.baseRanges, { anchor: current.anchor, head: point.offset, anchorAffinity: current.anchorAffinity, headAffinity: point.affinity }], current.baseRanges.length);
        if (drag === current) drag = { ...current, selectionSet: view.getSnapshot().selectionSet, padding: point.padding === true }; refresh();
    }
    function dragVelocity(): Readonly<{ x: number; y: number }> {
        if (!drag) return { x: 0, y: 0 }; const bounds = dragBounds(), metrics = viewport.snapshot();
        const speed = (point: number, low: number, high: number, unit: number) => {
            const outside = point < low ? point - low : point >= high ? point - high + 1 : 0;
            return Math.sign(outside) * Math.min((high - low) / bounds.zoom * 3, Math.max(unit * 5, Math.abs(outside) / bounds.zoom * 20));
        };
        return { x: speed(drag.x, bounds.left, bounds.right, metrics.columnWidth), y: speed(drag.y, bounds.top, bounds.bottom, metrics.lineHeight) };
    }
    function scheduleDragScroll(): void {
        const velocity = dragVelocity();
        if (!velocity.x && !velocity.y) { if (dragFrame !== undefined) win.cancelAnimationFrame(dragFrame); dragFrame = undefined; dragTime = undefined; }
        else if (dragFrame === undefined) dragFrame = win.requestAnimationFrame(scrollDrag);
    }
    function scrollDrag(time: number): void {
        const started = win.performance.now();
        try {
            dragFrame = undefined; if (!validDrag()) { stopDrag(); return; }
            const velocity = dragVelocity(); if (!velocity.x && !velocity.y) { dragTime = undefined; return; }
            const elapsed = dragTime === undefined ? 1000 / 60 : Math.max(0, Math.min(32, time - dragTime)); dragTime = time;
            const before = viewport.snapshot();
            viewport.scrollTo({ left: before.scrollLeft + velocity.x * elapsed / 1000, top: before.scrollTop + velocity.y * elapsed / 1000 }); viewport.flush();
            if (!validDrag()) { stopDrag(); return; } updateDragHead();
            dragScrollFrames++;
            const after = viewport.snapshot();
            if (drag && (after.scrollLeft !== before.scrollLeft || after.scrollTop !== before.scrollTop)) dragFrame = win.requestAnimationFrame(scrollDrag);
            else dragTime = undefined;
        } finally { maxDragScrollStepMs = Math.max(maxDragScrollStepMs, win.performance.now() - started); }
    }
    const stopDrag = (event?: PointerEvent) => {
        if (event && event.pointerId !== drag?.pointer) return;
        if (dragFrame !== undefined) win.cancelAnimationFrame(dragFrame); dragFrame = undefined; dragTime = undefined;
        const pointer = drag?.pointer, padding = drag?.padding; drag = undefined;
        if (pointer !== undefined && root.hasPointerCapture(pointer)) root.releasePointerCapture(pointer);
        if (event?.type === "pointerup" && padding && !disposed && workspace.resolveTab(target)) {
            const selected = view.getSnapshot().selection;
            viewport.revealOffset(selected.head, { horizontal: "nearest", vertical: "nearest", affinity: selected.headAffinity ?? "after" });
        }
    };
    root.addEventListener("pointerup", stopDrag, { signal: listeners.signal }); root.addEventListener("pointercancel", stopDrag, { signal: listeners.signal });
    root.addEventListener("lostpointercapture", stopDrag, { signal: listeners.signal });
    for (const type of ["copy", "cut", "paste"] as const) input.addEventListener(type, event => {
        if (event.defaultPrevented) { cancelWord(); group = undefined; if (type !== "copy") stopDrag(); return; }
        if (composing || !event.clipboardData) return;
        if (type === "paste" && (ordered || rangeCommand) && !input.disabled && !input.readOnly) {
            event.preventDefault(); stopDrag();
            const text = event.clipboardData.getData("text/plain");
            if (text.length) appendInput({ kind: "text", text, type: "insertFromPaste" });
            return;
        }
        if (type !== "paste") {
            syncSelection();
            if (!view.getSnapshot().selectionSet.ranges.some(range => range.anchor !== range.head)) return;
        }
        event.preventDefault(); cancelWord(); syncSelection(); group = undefined;
        if (type !== "copy") view.folding.revealSelection(view.folding.getSnapshot());
        const selections = view.getSnapshot().selectionSet;
        if (type === "paste") { const text = event.clipboardData.getData("text/plain"); if (text.length) replaceSelection(text, "paste"); }
        else {
            if (type === "cut" && input.readOnly) return;
            const buffer = workspace.document(documentId).buffer;
            event.clipboardData.setData("text/plain", selections.ranges.filter(range => range.anchor !== range.head)
                .map(range => buffer.slice(Math.min(range.anchor, range.head), Math.max(range.anchor, range.head))).join("\n"));
            if (type === "cut") replaceSelection("", "delete");
        }
    }, { signal: listeners.signal });
    root.addEventListener("sttropez-render", scheduleCaret, { signal: listeners.signal });
    root.addEventListener("sttropez-focus-source", focus, { signal: listeners.signal });
    let observedFoldRevision = view.folding.getSnapshot().revision;
    const subscriptions = [workspace.observeDocument(documentId).subscribe(refresh), view.subscribe(refresh),
        view.folding.subscribe(() => { const revision = view.folding.getSnapshot().revision;
            if (revision === observedFoldRevision) { cancelWord(); stopDrag(); preferred = undefined; group = undefined; }
            observedFoldRevision = revision; refresh(); }), resource.metadata.subscribe(refresh), workspace.tabState.subscribe(refresh)];
    refresh();
    return Object.freeze({ element: root, input, view, viewport, focus,
        captureInsertion: (kind = "paste") => {
            if (kind !== "paste" && kind !== "replace") throw new TypeError("Unknown captured insertion kind.");
            hostInsertion?.cancel();
            const available = () => !disposed && root.isConnected && !readOnly && !input.disabled && !input.readOnly && !composing
                && !ordered && !executingInput && !rangeCommand && !wordJob && !graphemeJob && !insertion && !drag;
            if (!available()) return;
            syncSelection(); view.folding.revealSelection(view.folding.getSnapshot());
            let captured: CapturedInsertion | undefined;
            captured = captureInsertion(workspace, target, view, available, (plan, expected) => apply(plan.edits, plan.selectionSet, kind, undefined, expected),
                () => { if (hostInsertion === captured) hostInsertion = undefined; });
            hostInsertion = captured; return captured;
        },
        runCommand: languageCommand,
        configureLanguage: configuration => {
            if (disposed || composing) return false;
            hostInsertion?.cancel();
            const next = resolveLanguageConfiguration(configuration);
            cancelWord(); group = undefined; preferred = undefined; language = next;
            root.style.tabSize = String(language.tabSize); viewport.invalidate(); refresh(); return true;
        },
        registerEditTransform: transform => {
            if (disposed || editTransform) throw new Error("Editor is disposed or already owns an edit planner.");
            editTransform = transform; return () => { if (editTransform === transform) editTransform = undefined; };
        },
        captureView: () => { syncSelection(); return viewport.captureView(); },
        restoreView: (state: ViewState) => { viewport.restoreView(state); refresh(); },
        snapshot: () => Object.freeze({ inputUnits: input.value.length, inputEvents, lastInputMs, beforeInputEvents, lastBeforeInputMs, maxQueuedInputTurnMs, keydownEvents, lastKeydownMs, navigationTurns, navigationPreparationMs, maxNavigationTurnMs, navigationWorkMs, wordSelectionEvents, lastWordSelectionMs, maxWordSelectionTurnMs, pendingCaret: caretLayer.pending(), pendingCommand: rangeCommand !== undefined || wordJob !== undefined || graphemeJob !== undefined,
            pendingDragScroll: dragFrame !== undefined, dragScrollFrames, maxDragScrollStepMs, commits, conflicts, composing, pendingInput: hostInsertion !== undefined || ordered !== undefined || executingInput !== undefined || rangeCommand?.capture.deleting === true,
            queuedInputUnits: ordered?.units ?? 0, pendingWord: rangeCommand?.purpose === "word" || wordJob !== undefined || graphemeJob?.purpose === "word" || graphemeJob?.purpose === "word-selection" || ordered?.purpose === "word", wordScanSteps, maxWordScanStepMs, pendingGrapheme: rangeCommand?.purpose === "grapheme" || graphemeJob !== undefined || ordered?.purpose === "grapheme", graphemeScanSteps, maxGraphemeScanStepMs, visualMoves, disposed }),
        destroy: () => {
            if (disposed) return; disposed = true; editTransform = undefined;
            hostInsertion?.cancel();
            if (executingInput) recoverInput(executingInput, "pending-input-detached");
            cancelWord();
            nativeOrder = undefined; wordInput = undefined;
            insertion = undefined; composition = undefined;
            graphemeCache = undefined; preferred = undefined;
            if (composing && input.value !== context.text) conflict("composition-detached");
            composing = false;
            stopDrag();
            textDrag.destroy();
            caretLayer.dispose();
            cancelCommandTimers();
            listeners.abort();
            subscriptions.forEach(unsubscribe => unsubscribe());
            input.value = "";
            viewport.destroy();
            if (!options.view) view.dispose();
        } });
}
