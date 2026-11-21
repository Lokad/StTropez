import { mountInputCaret } from "./input-caret.ts";
import { clientBox, cssZoom } from "./dom-coordinates.ts";
import { textDifference } from "../core/changes.ts";
import { createWordCommandCursor, WordCursor } from "../core/words.ts";
import { createGraphemeCursor } from "../core/graphemes.ts";
import { createSelectionSet, planSelectionEdits } from "../core/selections.ts";
import type { Affinity } from "../core/positions.ts";
import type { DocumentView, TabId, Workspace } from "../core/workspace.ts";
import type { EditKind, Selection } from "../core/history.ts";
import type { SelectionSet } from "../core/selections.ts";
import type { TextBuffer } from "../core/text-buffer.ts";
import type { TextEdit } from "../core/changes.ts";
import type { GraphemeCursor, GraphemeIndex } from "../core/graphemes.ts";
import type { ViewState } from "./view-state.ts";
import { inputContext, inputContextUnits } from "./input-context.ts";
import { localAsciiGraphemePoint } from "../core/grapheme-point.ts";
import type { GraphemePoint } from "../core/grapheme-point.ts";
import { captureNativeInsertion, resolveNativeInsertion } from "./input-target.ts";
import type { NativeInsertionTarget } from "./input-target.ts";
import type { InputContext } from "./input-context.ts";
import { inputConflictEvent } from "./input-conflict.ts";
import type { InputConflictDetail } from "./input-conflict.ts";
import { mountViewport } from "./viewport.ts";
import type { LineClass, LineDecorator, TextViewport } from "./viewport.ts";
import { mountTextDragDrop } from "./text-drag-drop.ts";
import { lineContentEnd, lineEnding, planLanguageEdit, resolveLanguageConfiguration } from "../core/language-edits.ts";
import { exportText } from "../core/newlines.ts";
import type { EditingCommand, LanguageConfiguration, ResolvedLanguageConfiguration } from "../core/language-edits.ts";
import { captureInsertion } from "./captured-insertion.ts";
import type { CapturedInsertion } from "./captured-insertion.ts";
import { mountBracketHighlights } from "./bracket-highlights.ts";
import type { BracketHighlights } from "./bracket-highlights.ts";
import type { BracketMatchOptions } from "../core/bracket-matching.ts";
import { bracketMatchLimits } from "../core/bracket-matching.ts";
import { CharacterWarnings } from "../core/character-warnings.ts";
import type { CharacterWarningOptions } from "../core/character-warnings.ts";
import { mountCharacterWarnings } from "./character-warnings.ts";
import type { CharacterWarningHighlights } from "./character-warnings.ts";
import { classifyEditingKey } from "./editing-keys.ts";
import type { KeyBinding, KeyStroke } from "./editing-keys.ts";
import { commandBudget, createCooperativeRunner } from "./cooperative-runner.ts";
import { createEdgeAutoscroll, edgeVelocity } from "./edge-autoscroll.ts";
import { createOrderedInputQueue } from "./ordered-input.ts";
import type { InputKey, InputIntent, OrderedInput } from "./ordered-input.ts";

export type TextEditorEdit = Readonly<{ expectedRevision: number; edits: readonly TextEdit[]; selectionSet: SelectionSet; kind: EditKind;
    /** The editor's newline command supplied contextual indentation, rather than literal text. */
    adjustNewlines?: boolean }>;
export type TextEditorEditTransform = (edit: TextEditorEdit) => Readonly<{ edits: readonly TextEdit[]; selectionSet: SelectionSet; complete?: (applied: boolean) => void }> | undefined;
export type TextEditorActivity = Readonly<{ disposed: boolean; composing: boolean; pendingInput: boolean; pendingCommand: boolean;
    pendingCaret: boolean; pendingDragScroll: boolean; pendingWord: boolean; pendingGrapheme: boolean }>;
export type TextEditorOptions = Readonly<{ ariaLabel?: string; view?: DocumentView; readOnly?: boolean; decorate?: LineDecorator; lineClass?: LineClass; language?: LanguageConfiguration;
        pasteLineEndings?: "local" | "preserve";
        bracketMatching?: boolean | BracketMatchOptions; characterWarnings?: boolean | CharacterWarningOptions;
        columnRulers?: readonly number[]; highlightCurrentLine?: boolean; fontLigatures?: boolean; scrollBeyondLastLine?: boolean; minimap?: boolean }>;
export type TextEditor = Readonly<{ element: HTMLDivElement; input: HTMLTextAreaElement; view: DocumentView; viewport: TextViewport;
    /** One pending host insertion, invalidated by later editing/selection/authority/lifecycle changes. */
    captureInsertion: (kind?: "paste" | "replace") => CapturedInsertion | undefined;
    /** One synchronous edit planner per view. Its result still passes Workspace validation/history. */
    registerEditTransform: (transform: TextEditorEditTransform) => () => void;
    configureLanguage: (configuration: LanguageConfiguration) => boolean;
    languageConfiguration: () => ResolvedLanguageConfiguration;
    bracketMatching: BracketHighlights;
    characterWarnings: CharacterWarningHighlights;
    /** Returns whether the command was accepted; long selections finish asynchronously. */
    runCommand: (command: EditingCommand) => boolean;
    focus: () => void; captureView: () => ViewState; restoreView: (state: ViewState) => void;
    /** Immutable activity capture, reused while its fields are unchanged. Does not collect metrics. */
    activity: () => TextEditorActivity;
    snapshot: () => TextEditorActivity & Readonly<{ inputUnits: number; inputEvents: number; lastInputMs: number; beforeInputEvents: number; lastBeforeInputMs: number; maxQueuedInputTurnMs: number; keydownEvents: number; lastKeydownMs: number; navigationTurns: number; navigationPreparationMs: number; maxNavigationTurnMs: number; navigationWorkMs: number; wordSelectionEvents: number; lastWordSelectionMs: number; maxWordSelectionTurnMs: number; dragScrollFrames: number; maxDragScrollStepMs: number; commits: number; conflicts: number; queuedInputUnits: number; wordScanSteps: number; maxWordScanStepMs: number; graphemeScanSteps: number; maxGraphemeScanStepMs: number; visualMoves: number }>;
    dispose: () => void }>;
export type MountedTextEditor = Readonly<{ editor: TextEditor; setComparisonRows: ReturnType<typeof mountViewport>["setComparisonRows"] }>;

const emptyDecorations = Object.freeze([]);

/** Text editor with bounded native input and virtualized rendering. Native IME qualification is separate. */
export function mountTextEditor(host: HTMLElement, workspace: Workspace, tabId: TabId,
    options: TextEditorOptions = {}): TextEditor {
    return mountEditor(host, workspace, tabId, options).editor;
}

/** Private pane mount; the comparison capability belongs to this exact editor lifetime. */
export function mountEditor(host: HTMLElement, workspace: Workspace, tabId: TabId,
    options: TextEditorOptions = {}): MountedTextEditor {
    let language = resolveLanguageConfiguration(options.language);
    const bracketOptions = options.bracketMatching === undefined || options.bracketMatching === false ? false
        : bracketMatchLimits(options.bracketMatching === true ? {} : options.bracketMatching);
    const warningOptions = options.characterWarnings === undefined || options.characterWarnings === false ? undefined
        : new CharacterWarnings(options.characterWarnings === true ? {} : options.characterWarnings);
    const readOnly = options.readOnly === true;
    const target = workspace.captureTab(tabId), tab = workspace.resolveTab(target);
    if (!tab || tab.surface.kind !== "text") throw new Error("Expected a text surface.");
    const documentId = tab.surface.documentId, resource = workspace.resourceForDocument(documentId);
    if (options.view && (options.view.documentId !== documentId || !workspace.ownsDocumentView(options.view))) throw new Error("View belongs to a different document or workspace.");
    const view = options.view ?? workspace.createDocumentView(documentId);
    let setComparisonRows: MountedTextEditor["setComparisonRows"], viewport: TextViewport, navigation: ReturnType<typeof mountViewport>["navigation"], brackets: ReturnType<typeof mountBracketHighlights> | undefined, warnings: ReturnType<typeof mountCharacterWarnings> | undefined;
    try { const mounted = mountViewport(host, workspace, tabId, { ...options, view, decorate: line => {
        const own = brackets?.decorate(line), flagged = warnings?.decorate(line), host = options.decorate?.(line);
        return own?.length || flagged?.length ? [...(host ?? emptyDecorations), ...(own ?? emptyDecorations), ...(flagged ?? emptyDecorations)] : host ?? emptyDecorations;
    } }, options); viewport = mounted.viewport; navigation = mounted.navigation; setComparisonRows = mounted.setComparisonRows; }
    catch (error) { if (!options.view) view.dispose(); throw error; }
    const root = viewport.element;
    root.style.tabSize = String(language.tabSize);
    const owner = host.ownerDocument, win = owner.defaultView!, input = owner.createElement("textarea");
    const scope = workspace.allocateIdentity(), listeners = new AbortController();
    root.classList.add("st-editor");
    input.className = "st-input-context"; input.wrap = "off"; input.spellcheck = false; input.autocomplete = "off";
    // The native projection belongs to the editor, independently of enclosing host forms.
    input.setAttribute("form", "");
    input.setAttribute("aria-label", options.ariaLabel ?? workspace.document(documentId).title);
    input.setAttribute("autocapitalize", "off");
    root.append(input);
    let contextBuffer: TextBuffer | undefined = workspace.document(documentId).buffer, contextSelection = view.getSnapshot().selection;
    let revision = workspace.document(documentId).revision, context: InputContext = inputContext(contextBuffer, contextSelection);
    let disposed = false, composing = false, selecting = false, committing = false;
    let escapeSelection: SelectionSet | undefined;
    let editTransform: TextEditorEditTransform | undefined;
    let hostInsertion: CapturedInsertion | undefined;
    const escapeState = (value: boolean) => {
        if (!!escapeSelection === value) return;
        escapeSelection = value ? view.getSnapshot().selectionSet : undefined;
        root.toggleAttribute("data-st-tab-escape", value);
        inputBinding.setTabEscape(value);
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
    let dragScrollFrames = 0, maxDragScrollStepMs = 0;
    const commandRunner = createCooperativeRunner(win);
    let wordJob: Readonly<{ cursor: Pick<WordCursor, "next" | "dispose">; revision: number }> | undefined, cancelWordTask: (() => void) | undefined;
    type CommandCapture = Readonly<{ buffer: TextBuffer; revision: number; selection: Selection; selectionSet: SelectionSet; deleting: boolean }>;
    let graphemeJob: Readonly<{ cursor: GraphemeCursor; capture: CommandCapture; purpose: "word" | "word-selection" | "grapheme" }> | undefined, cancelGraphemeTask: (() => void) | undefined;
    let graphemeCache: Readonly<{ buffer: TextBuffer; from: number; to: number; index: GraphemeIndex }> | undefined;
    type InputCapture = Readonly<{ revision: number; selectionSet: SelectionSet; context: InputContext; target?: NativeInsertionTarget }>;
    let wordInput: Readonly<{ revision: number; selectionSet: SelectionSet; direction: -1 | 1; word: boolean }> | undefined;
    let insertion: InputCapture | undefined, composition: InputCapture | undefined;
    let projectedSet = view.getSnapshot().selectionSet;
    let rangeCommand: Readonly<{ capture: CommandCapture; purpose: "word" | "grapheme"; release: () => void }> | undefined, cancelRangeTask: (() => void) | undefined;
    let nativeOrder: { order: OrderedInput<CommandCapture>; capture: InputCapture; type: string; data: string | null; action?: InputKey; invalid: boolean; reported: boolean } | undefined;
    const inputQueue = createOrderedInputQueue<CommandCapture>(win.performance, commandRunner, {
        command: () => rangeCommand, capture: () => commandCapture(false), disposed: () => disposed,
        validCommand: capture => validCommand(capture),
        valid: (capture, editing) => validCommand(capture) && root.isConnected && workspace.ownsDocumentView(view) && !(editing && input.readOnly),
        committed: capture => committing && workspace.observeDocument(documentId).getSnapshot()?.revision !== capture.revision,
        pairKey: text => pairKey(text), replay: replayInput, commandTurn,
        recover: (pending, text, reason) => {
            if (nativeOrder?.order === pending) { nativeOrder.invalid = true;
                if (!nativeOrder.reported && nativeOrder.data !== null) { text += nativeOrder.data; nativeOrder.reported = true; } }
            if (text.length) conflict(reason, undefined, pending.capture.revision, 0, text);
        },
        deferredTurn: work => { const began = win.performance.now();
            try { work(); } finally { maxQueuedInputTurnMs = Math.max(maxQueuedInputTurnMs, win.performance.now() - began); } },
    });
    const apple = /Mac|iPhone|iPad|iPod/.test(win.navigator.platform);
    function cancelScans(): void {
        wordJob?.cursor.dispose(); wordJob = undefined;
        cancelWordTask?.(); cancelWordTask = undefined;
        graphemeJob?.cursor.dispose(); graphemeJob = undefined;
        cancelGraphemeTask?.(); cancelGraphemeTask = undefined;
    }
    function cancelWord(): void {
        const command = rangeCommand; rangeCommand = undefined;
        cancelRangeTask?.(); cancelRangeTask = undefined;
        const pending = inputQueue.take();
        try { cancelScans(); command?.release(); }
        finally { if (pending) inputQueue.recover(pending, "pending-input-cancelled"); }
    }
    const caretLayer = mountInputCaret(root, input, view, viewport,
        () => workspace.observeDocument(documentId).getSnapshot(), () => composing);
    const scheduleCaret = caretLayer.schedule;
    function refresh(): void {
        if (escapeSelection && escapeSelection !== view.getSnapshot().selectionSet) escapeState(false);
        if (disposed || selecting || committing) return;
        const state = resource.getSnapshot(); input.disabled = !workspace.resolveTab(target) || state.state !== "ready";
        if (input.disabled) contextBuffer = undefined;
        input.readOnly = readOnly || !state.metadata.capabilities.edit.includes("human") || state.metadata.editLock !== null;
        if (inputQueue.executing?.edit && input.readOnly) inputQueue.recover(inputQueue.executing, "pending-input-expired");
        if (inputQueue.pending && (!inputQueue.current(inputQueue.pending) || inputQueue.pending.edit && input.readOnly)) cancelWord();

        if (!input.disabled && !composing) {
            const document = workspace.document(documentId), { selection: selected, selectionSet } = view.getSnapshot();
            if (graphemeCache?.buffer !== document.buffer) graphemeCache = undefined;
            const capture = rangeCommand?.capture ?? graphemeJob?.capture;
            if (capture && (capture.revision !== document.revision || capture.selectionSet !== selectionSet || capture.deleting && input.readOnly)) cancelWord();
            // Projection is refreshed only outside composition. The captured model selection and
            // LF mapping remain together until the native edit is committed or recovered.
            // Projection limits are fixed. Only computation is reused; native state and captures still refresh.
            if (contextBuffer !== document.buffer || contextSelection.anchor !== selected.anchor || contextSelection.head !== selected.head) {
                context = inputContext(document.buffer, selected); contextBuffer = document.buffer; contextSelection = selected;
            }
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
        input.dispatchEvent(new CustomEvent<InputConflictDetail>(inputConflictEvent, { bubbles: true, detail: Object.freeze({ documentId, expectedRevision, reason,
            attemptedText, contextFrom, ...(edit ? { attemptedEdit: Object.freeze({ ...edit }) } : {}), ...(cause === undefined ? {} : { cause }) }) }));
    };
    // One failure boundary for inline and deferred command work. Detach ownership before
    // notifying the host; reporting must not leave a failed job blocking later input.
    function commandTurn(work: () => void, attemptedText = ""): void {
        const expectedRevision = rangeCommand?.capture.revision ?? inputQueue.executing?.capture.revision ?? revision;
        try { work(); }
        catch (error) {
            const pending = inputQueue.take(), executing = inputQueue.executing;
            let cause = error;
            try { cancelWord(); refresh(); }
            catch (cleanupError) { cause = new AggregateError([error, cleanupError], "Command and cleanup failed."); }
            finally { commandRunner.cancel(); }
            if (pending) inputQueue.recover(pending, "pending-input-failed");
            if (executing && executing !== pending) inputQueue.recover(executing, "pending-input-failed");
            const unapplied = !executing && workspace.observeDocument(documentId).getSnapshot()?.revision === expectedRevision ? attemptedText : "";
            conflict("command-failed", undefined, expectedRevision, 0, unapplied, cause);
        }
    }
    function revealCaret(selected = view.getSnapshot().selection): void {
        viewport.revealOffset(selected.head, { horizontal: "nearest", vertical: "nearest", affinity: selected.headAffinity ?? "after" });
    }
    function apply(edits: readonly TextEdit[], selection: Selection | SelectionSet, kind: EditKind, type?: string, expectedRevision = revision, recoveryText?: string, adjustNewlines = false): boolean {
        if (disposed) return false;
        hostInsertion?.cancel();
        if (readOnly) { conflict("read-only", edits[0], expectedRevision, context.from, recoveryText); refresh(); return false; }
        cancelWord(); preferred = undefined;
        if (!workspace.resolveTab(target)) { conflict("expired-view", edits[0], expectedRevision, context.from, recoveryText); refresh(); return false; }
        let key: string | undefined;
        const now = inputQueue.time ?? win.performance.now(), before = view.getSnapshot().selectionSet;
        const transformed = editTransform?.(Object.freeze({ expectedRevision, edits,
            selectionSet: "ranges" in selection ? selection : createSelectionSet(workspace.document(documentId).buffer.length + edits.reduce((n, edit) => n + edit.insert.length - (edit.to - edit.from), 0), [selection]), kind,
            ...(adjustNewlines ? { adjustNewlines: true } : {}) }));
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
                inputQueue.consumeRunning();
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
        const to = exactTarget ? Math.max(selected.anchor, selected.head) : edit.from === edit.to ? from : projection.toModel(edit.to);
        const typing = type === "insertText" && !edit.insert.includes("\n"), deleting = type === "deleteContentBackward" || type === "deleteContentForward";
        const kind = typing ? "typing" : deleting ? "delete" : type === "insertCompositionText" ? "composition" : type === "insertFromPaste" ? "paste" : "replace";
        if (captured.selectionSet.ranges.length > 1) {
            // A native textarea describes one primary target. Replicate only an exact captured
            // selection replacement; neighbouring autocorrection/reconversion needs its own plan.
            if (from !== Math.min(selected.anchor, selected.head) || to !== Math.max(selected.anchor, selected.head)) {
                conflict("unsupported-multiple-input-target", { from, to, insert: edit.insert }, captured.revision, projection.from); refresh(); return;
            }
            const plan = planInput(workspace.document(documentId).buffer, captured.selectionSet, edit.insert, kind);
            apply(plan.edits, plan.selectionSet, kind, typing || deleting ? type : undefined, captured.revision); return;
        }
        const buffer = workspace.document(documentId).buffer;
        const converted = kind === "paste" && options.pasteLineEndings !== "preserve" && /[\r\n]/.test(edit.insert)
            ? exportText(edit.insert, lineEnding(buffer, buffer.lineAt(from)) === "\n" ? "lf" : "crlf") : undefined;
        const insert = converted?.text ?? edit.insert, delta = insert.length - (to - from);
        const map = (offset: number) => offset <= edit.from ? projection.toModel(offset)
            : offset >= edit.from + edit.insert.length ? projection.toModel(offset - edit.insert.length + edit.to - edit.from) + delta
            : from + (converted?.mapping.map(offset - edit.from).offset ?? offset - edit.from);
        const backward = input.selectionDirection === "backward", selection = exactTarget ? { anchor: from + insert.length, head: from + insert.length }
            : { anchor: map(backward ? input.selectionEnd : input.selectionStart), head: map(backward ? input.selectionStart : input.selectionEnd) };
        apply([{ from, to, insert }], selection, kind, typing || deleting ? type : undefined, captured.revision);
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
    const inputBinding = viewport.bindInput(focus);
    function planInput(buffer: TextBuffer, selections: SelectionSet, text: string, kind: EditKind) {
        if (kind !== "paste" || options.pasteLineEndings === "preserve" || !/[\r\n]/.test(text))
            return planSelectionEdits(buffer.length, selections, text);
        const lf = text.replace(/\r\n?/g, "\n");
        let crlf: string | undefined;
        const inserts = selections.ranges.map(range => {
            const line = buffer.lineAt(Math.min(range.anchor, range.head));
            if (lineEnding(buffer, line) === "\n") return lf;
            return crlf ??= lf.replace(/\n/g, "\r\n");
        });
        return planSelectionEdits(buffer.length, selections, inserts);
    }
    function replaceSelection(insert: string, kind: EditKind, type?: string, recoveryText?: string): boolean {
        const document = workspace.document(documentId), plan = planInput(document.buffer, view.getSnapshot().selectionSet, insert, kind);
        return apply(plan.edits, plan.selectionSet, kind, type, document.revision, recoveryText);
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
            const began = win.performance.now();
            const result = commandRunner.slice(() => job.cursor.next(commandBudget.cursorUnits), result => result.status === "running", commandBudget.graphemeCalls);
            graphemeScanSteps++; maxGraphemeScanStepMs = Math.max(maxGraphemeScanStepMs, win.performance.now() - began);
            if (result.status === "running") { cancelGraphemeTask = commandRunner.schedule(() => { if (graphemeJob === job) cancelGraphemeTask = undefined; step(); }, 0, turn); return; }
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
            if (options.prepare && index === batchEnd) { job.release(); batchEnd = Math.min(capture.selectionSet.ranges.length, index + (options.batchSize ?? commandBudget.rangeBatch));
                release = options.prepare(capture.selectionSet.ranges.slice(index, batchEnd)); }
            while (index < batchEnd && !waiting && count++ < commandBudget.rangeCalls && (options.inline || win.performance.now() - began < commandBudget.sliceMs)) {
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
            else if (!waiting) cancelRangeTask = commandRunner.schedule(() => { if (rangeCommand === job) cancelRangeTask = undefined; pump(); }, 0, turn);
        })); pump();
    }
    function completeCaptured(capture: CommandCapture, work: () => boolean): boolean {
        if (!validCommand(capture)) { cancelWord(); return false; }
        return inputQueue.complete(capture, work);
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
        const job = { cursor: createWordCommandCursor(capture.buffer, start, direction, deleting), revision: capture.revision }; wordJob = job;
        const step = () => commandTurn(() => {
            if (wordJob !== job) return;
            const current = workspace.observeDocument(documentId).getSnapshot();
            if (!validCommand(capture) || current?.revision !== job.revision) { cancelWord(); return; }
            const began = win.performance.now();
            const result = commandRunner.slice(() => job.cursor.next(commandBudget.cursorUnits), result => result.status === "running", commandBudget.wordCalls);
            wordScanSteps++; maxWordScanStepMs = Math.max(maxWordScanStepMs, win.performance.now() - began);
            if (result.status === "running") {
                cancelWordTask = commandRunner.schedule(() => { if (wordJob === job) cancelWordTask = undefined; step(); }); return;
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
        const to = lineContentEnd(buffer, line);
        if (to === from) return;
        const command = { capture, purpose: "word" as const, release: () => {} }; rangeCommand = command;
        wordScanSteps = 0; maxWordScanStepMs = 0; graphemeScanSteps = 0; maxGraphemeScanStepMs = 0;
        const scan = (start: number, direction: -1 | 1, done: (offset: number) => void) => {
            if (!validCommand(capture)) return;
            const job = { cursor: new WordCursor(buffer, start, direction, { from, to, skipWhitespace: false }), revision: capture.revision }; wordJob = job;
            const step = () => commandTurn(() => {
                const started = win.performance.now();
                try {
                if (wordJob !== job) return; if (!validCommand(capture)) { cancelWord(); return; }
                const began = win.performance.now();
                const result = commandRunner.slice(() => job.cursor.next(commandBudget.cursorUnits), result => result.status === "running", commandBudget.wordCalls);
                wordScanSteps++; maxWordScanStepMs = Math.max(maxWordScanStepMs, win.performance.now() - began);
                if (result.status === "running") {
                    cancelWordTask = commandRunner.schedule(() => { if (wordJob === job) cancelWordTask = undefined; step(); }); return;
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
            style.letterSpacing, style.wordSpacing, style.tabSize,
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
            else cancelRangeTask = commandRunner.schedule(() => { if (rangeCommand === job) cancelRangeTask = undefined; initialize(true); }, 0, navigationTurn);
        }));
    }
    function shortHorizontal(capture: CommandCapture): boolean {
        // Bounded selection sets and bounded native rows; longer contexts keep cooperative scans.
        if (capture.selectionSet.ranges.length > commandBudget.inlineRanges) return false;
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
        if (viewport.activity().aligned) return false;
        const buffer = capture.buffer, folds = view.folding.getSnapshot().index, count = verticalCount(page), lines = new Set<number>();
        for (const range of capture.selectionSet.ranges) {
            const line = buffer.lineAt(range.head), row = folds.rowAt(line);
            lines.add(line); lines.add(folds.lineAt(Math.max(0, Math.min(folds.visibleLineCount - 1, row + direction * count))));
        }
        return shortRows(buffer, lines);
    }
    function moveToBoundary(key: "Home" | "End", extend: boolean, documentBoundary: boolean): void {
        cancelWord();
        navigationTurns = 0; navigationPreparationMs = 0; maxNavigationTurnMs = 0; navigationWorkMs = 0;
        const capture = commandCapture(false), buffer = capture.buffer, firstNonblank = new Map<number, number>();
        if (!validCommand(capture)) return;
        eachRange(capture, "grapheme", (range, done) => {
            const move = (offset: number) => done(moved(range, offset, extend));
            if (documentBoundary) { move(key === "Home" ? 0 : buffer.length); return; }
            const line = buffer.lineAt(range.head), end = lineContentEnd(buffer, line);
            if (key === "End") { move(end); return; }
            const start = buffer.offsetAt(line);
            const home = (offset: number) => move(range.head === offset ? start : offset);
            const cached = firstNonblank.get(line);
            if (cached !== undefined) { home(cached); return; }
            let at = start;
            const scan = () => commandTurn(() => {
                if (!validCommand(capture)) { cancelWord(); return; }
                const result = commandRunner.slice(() => {
                    const to = Math.min(end, at + commandBudget.cursorUnits), index = buffer.slice(at, to).search(/\S/u);
                    if (index >= 0) return at + index;
                    at = to; return at === end ? start : undefined;
                }, result => result === undefined, commandBudget.wordCalls);
                if (result === undefined) {
                    cancelRangeTask = commandRunner.schedule(() => { cancelRangeTask = undefined; scan(); }, 0, navigationTurn);
                } else { firstNonblank.set(line, result); home(result); }
            });
            scan();
        }, ranges => finishRanges(capture, ranges), { navigation: true, inline: capture.selectionSet.ranges.length <= commandBudget.inlineRanges });
    }
    function horizontal(key: string, extend: boolean, documentBoundary = false): void {
        preferred = undefined;
        graphemeScanSteps = 0; maxGraphemeScanStepMs = 0;
        if (key === "Home" || key === "End") { moveToBoundary(key, extend, documentBoundary); return; }
        beginNavigation((capture, style, inline) => {
        const began = win.performance.now(); viewport.flush();
        if (!validCommand(capture) || navigationStyle() !== style) { cancelWord(); return; }
        const layout = navigationLayout(style), buffer = capture.buffer, foldIndex = view.folding.getSnapshot().index;
        navigationPreparationMs = win.performance.now() - began;
        eachRange(capture, "grapheme", (range, done) => {
            const direction = key === "ArrowLeft" ? -1 : 1;
            const point = !extend && range.anchor !== range.head
                ? navigation.collapseVisual(Math.min(range.anchor, range.head), Math.max(range.anchor, range.head), direction)
                : navigation.moveVisual(range.head, direction);
            if (point) { visualMoves++; done(moved(range, point.offset, extend, point.affinity)); return; }
            if (!extend && range.anchor !== range.head) { done(moved(range, direction < 0 ? Math.min(range.anchor, range.head) : Math.max(range.anchor, range.head), false)); return; }
            withGraphemes(capture, range.head, direction, "grapheme", at => done(moved(range, direction < 0 ? at.preceding ?? range.head : at.following ?? range.head, extend)), navigationTurn);
        }, ranges => finishRanges(capture, ranges), { validLayout: () => navigationLayout() === layout, navigation: true, inline, ...(capture.selectionSet.ranges.length > 1 ? {
            batchSize: commandBudget.shortRangeBatch, prepare: (ranges: readonly Selection[]) => {
                const lines = new Set<number>();
                for (const range of ranges) {
                    const line = buffer.lineAt(range.head); lines.add(line);
                    if (!extend && range.anchor !== range.head) lines.add(buffer.lineAt(range.anchor));
                    else { const row = foldIndex.rowAt(line); if (row) lines.add(foldIndex.lineAt(row - 1)); if (row + 1 < foldIndex.visibleLineCount) lines.add(foldIndex.lineAt(row + 1)); }
                }
                return navigation.prepareNavigationRows([...lines]);
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
            const at = index++, line = buffer.lineAt(range.head), row = navigation.visualRowAt(line), next = navigation.navigationLine(line, direction, count, page);
            if (at === capture.selectionSet.primary) pageDelta = (navigation.visualRowAt(next) - row) * state.lineHeight;
            if (next === line) { columns.push(undefined); done(moved(range, direction < 0 ? 0 : buffer.length, extend)); return; }
            const column = prior?.[at] ?? navigation.columnAt(range.head, range.headAffinity);
            const hit = column === undefined ? undefined : navigation.caretAtColumn(next, column);
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
            ...(capture.selectionSet.ranges.length <= commandBudget.inlineRanges ? { batchSize: commandBudget.shortRangeBatch } : {}),
            prepare: (ranges: readonly Selection[]) => navigation.prepareNavigationRows([...new Set(ranges.flatMap(range => {
                const line = buffer.lineAt(range.head); return [line, navigation.navigationLine(line, direction, count, page)];
            }))]) } : {}) });
        }, capture => shortVertical(capture, direction, page));
    }
    function languageCommand(command: EditingCommand | Readonly<{ character: string }>): boolean {
        if (disposed || composing || input.disabled || input.readOnly) return false;
        if (command === "line-comment" && !language.lineComment || command === "block-comment" && !language.blockComment) return false;
        cancelWord(); syncSelection();
        const capture = commandCapture(true), planner = planLanguageEdit(capture.buffer, capture.selectionSet, command, language);
        let planning = false;
        const job = { capture, purpose: "grapheme" as const, release: () => { if (!planning) planner.dispose(); } }; rangeCommand = job;
        const step = () => commandTurn(() => {
            if (rangeCommand !== job) return;
            if (!validCommand(capture)) { cancelWord(); return; }
            let result;
            try {
                planning = true;
                result = commandRunner.slice(() => planner.next(commandBudget.languageUnits),
                    result => result.status === "running" && rangeCommand === job, commandBudget.languageCalls);
            }
            finally { planning = false; }
            if (rangeCommand !== job) { planner.dispose(); return; }
            if (result.status === "running") {
                cancelRangeTask = commandRunner.schedule(() => { if (rangeCommand === job) cancelRangeTask = undefined; step(); }); return;
            }
            rangeCommand = undefined; planner.dispose();
            completeCaptured(capture, () => {
                const plan = result.result!;
                if (plan.edits.length) return apply(plan.edits, plan.selectionSet, typeof command === "object" ? "typing" : "replace", undefined, capture.revision, undefined, command === "newline" && language.enter !== undefined);
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
    function appendInput(action: InputIntent): void {
        const rejected = inputQueue.append(action); if (!rejected) return;
        const capture = rejected.capture; cancelWord();
        if (action.text.length) conflict("pending-input-limit-or-expiry", undefined, capture.revision, 0, action.text);
    }
    function replayInput(action: InputIntent): boolean | "reported" {
        const beforeConflicts = conflicts;
        if (action.kind === "text" && !action.literal && configuredInput(action.type, action.text)) {
            // The same captured command path serves keyboard and cancellable native input.
        } else if (action.kind === "text") {
            const typing = action.type === "insertText" && !action.text.includes("\n");
            if (!replaceSelection(action.text, typing ? "typing" : action.type === "insertFromPaste" ? "paste" : "replace", typing ? "insertText" : undefined, action.text)) {
                return "reported";
            }
        } else {
            const event = new win.KeyboardEvent("keydown", { ...action, cancelable: true }); keydown(event, action);
            if (action.fallback && action.text && !event.defaultPrevented) replaceSelection(action.text, "typing", "insertText");
        }
        return conflicts === beforeConflicts;
    }
    function captureKey(event: KeyStroke, binding: KeyBinding): InputKey {
        return { kind: "key", key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey, ...binding };
    }
    function nativeIntent(type: string): InputKey | undefined {
        const word = type.startsWith("deleteWord"), backward = type.endsWith("Backward");
        let stroke: KeyStroke;
        if (["deleteWordBackward", "deleteWordForward", "deleteContentBackward", "deleteContentForward"].includes(type))
            stroke = { key: backward ? "Backspace" : "Delete", ctrlKey: word, metaKey: false, altKey: false, shiftKey: false };
        else if (type === "historyUndo" || type === "historyRedo") stroke = { key: "z", ctrlKey: true, metaKey: false, altKey: false, shiftKey: type === "historyRedo" };
        else return;
        const binding = classifyEditingKey(stroke, apple, !!escapeSelection, pairKey); return typeof binding === "object" ? captureKey(stroke, binding) : undefined;
    }
    function captureOrderedInput(event: InputEvent): boolean {
        if (composing || event.isComposing || input.disabled || input.readOnly || !inputQueue.pending && !rangeCommand) return false;
        const text = event.inputType === "insertText" || event.inputType === "insertLineBreak" || event.inputType === "insertFromPaste", action = nativeIntent(event.inputType);
        if (!text && !action) return false;
        const pending = inputQueue.ensure(); if (!pending) return false;
        const data = event.inputType === "insertLineBreak" ? "\n" : event.data ?? event.dataTransfer?.getData("text/plain") ?? null;
        if (event.inputType === "insertFromPaste" && event.cancelable && data === "") { event.preventDefault(); return true; }
        if (event.cancelable && (action || data !== null)) { event.preventDefault(); appendInput(action ?? { kind: "text", text: data!, type: event.inputType }); return true; }
        inputQueue.waitNative(pending);
        nativeOrder = { order: pending, capture: captureInput(event.inputType, event.data), type: event.inputType, data, ...(action ? { action } : {}), invalid: false, reported: false };
        return true;
    }
    function commitOrderedInput(event: InputEvent): boolean {
        let pendingNative = nativeOrder; nativeOrder = undefined;
        if (!pendingNative && !composing && !event.isComposing && (inputQueue.pending || rangeCommand) && ["insertText", "insertLineBreak"].includes(event.inputType)) {
            const pending = inputQueue.ensure(); if (!pending) return false;
            pendingNative = { order: pending, capture: { revision, selectionSet: projectedSet, context, target: { type: event.inputType, before: context.text,
                from: Math.min(context.nativeAnchor, context.nativeHead), to: Math.max(context.nativeAnchor, context.nativeHead), data: event.data } }, type: event.inputType, data: event.data, invalid: false, reported: false };
        }
        if (!pendingNative) return false;
        const native = pendingNative, pending = native.order; inputQueue.finishNative(pending);
        if (native.invalid || inputQueue.pending !== pending || !inputQueue.current(pending) || event.inputType !== native.type) {
            const text = event.data ?? native.data ?? input.value;
            if (!native.reported || text !== native.data) conflict("pending-native-input-expired", undefined, native.capture.revision, 0, text);
            if (inputQueue.pending === pending) cancelWord(); refresh(); return true;
        }
        const projection = native.capture.context, edit = native.capture.target && resolveNativeInsertion(native.capture.target, input, event.inputType);
        if (native.action) appendInput(native.action);
        else if (edit && edit.from === Math.min(projection.nativeAnchor, projection.nativeHead) && edit.to === Math.max(projection.nativeAnchor, projection.nativeHead))
            appendInput({ kind: "text", text: edit.insert, type: event.inputType, literal: true });
        else { cancelWord(); conflict("pending-native-input-target", undefined, native.capture.revision, 0, event.data ?? native.data ?? input.value); }
        refresh(); inputQueue.schedule(); return true;
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
            if (event.inputType === "insertFromPaste" && event.cancelable) {
                const pasted = event.data ?? event.dataTransfer?.getData("text/plain");
                if (pasted != null) { event.preventDefault(); if (pasted.length) replaceSelection(pasted, "paste", undefined, pasted); return; }
            }
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
        escapeState(false);
        hostInsertion?.cancel();
        cancelWord();
        commandRunner.cancel();
        wordInput = undefined;
        insertion = undefined;
        syncSelection();
        view.folding.revealSelection(view.folding.getSnapshot());
        composition = captureInput("insertCompositionText", null);
        composing = true;
        group = undefined;
        inputBinding.setComposing(true);
        scheduleCaret();
    }
    function endComposition(): void {
        const captured = composition;
        composition = undefined;
        composing = false;
        inputBinding.setComposing(false);
        commit("insertCompositionText", captured);
    }
    input.addEventListener("compositionstart", startComposition, { signal: listeners.signal });
    input.addEventListener("compositionend", endComposition, { signal: listeners.signal });
    input.addEventListener("select", syncSelection, { signal: listeners.signal });
    // Tab can reset the browser range after focus dispatch. It changes focus, not model selection.
    input.addEventListener("keyup", event => {
        // A held Shift qualifies the next Tab. Releasing Shift alone consumes the escape.
        if (event.key === "Shift") escapeState(false);
        if (event.key === "Tab") refresh(); else syncSelection();
    }, { signal: listeners.signal });
    input.addEventListener("focus", scheduleCaret, { signal: listeners.signal });
    input.addEventListener("blur", () => { syncSelection(); group = undefined; scheduleCaret();
        // Restore disclosure tab stops after the browser has completed focus traversal.
        if (escapeSelection) queueMicrotask(() => { if (!disposed) escapeState(false); }); }, { signal: listeners.signal });
    function keydown(event: KeyboardEvent, captured?: KeyBinding): void {
        if (escapeSelection && event.key !== "Tab" && event.key !== "Shift") escapeState(false);
        if (event.defaultPrevented || composing || event.isComposing || event.keyCode === 229) return;
        if (["Shift", "Control", "Meta", "Alt"].includes(event.key)) return;
        if (hostInsertion) { hostInsertion.cancel(); if (event.key === "Escape") { event.preventDefault(); return; } }
        const binding = captured ?? classifyEditingKey(event, apple, !!escapeSelection, pairKey);
        if (!inputQueue.draining && (inputQueue.pending || rangeCommand) && event.key !== "Escape") {
            if (typeof binding === "object" && (!binding.edit || !input.readOnly)) { event.preventDefault(); appendInput(captureKey(event, binding)); return; }
            if (!(event.ctrlKey || event.metaKey || event.altKey)) return;
        }
        view.folding.revealSelection(view.folding.getSnapshot());
        const command = typeof binding === "object" ? binding.command : undefined;
        if (command?.kind === "history") { event.preventDefault(); history(command.direction); return; }
        if (command?.kind === "select-all") { event.preventDefault(); cancelWord(); preferred = undefined; const length = workspace.document(documentId).buffer.length; view.setSelection(revision, { anchor: 0, head: length }); refresh(); return; }
        if (binding === "escape") {
            cancelWord(); commandRunner.cancel(); preferred = undefined;
            const state = view.getSnapshot();
            if (state.selectionSet.ranges.length > 1) { event.preventDefault(); view.setSelection(revision, state.selection); refresh(); }
            escapeState(true); return;
        }
        if (binding === "tab-escape") return;
        escapeState(false); syncSelection();
        if (command?.kind === "word") {
            event.preventDefault(); word(command.direction, command.deleting, command.extend); return;
        }
        if (command?.kind === "vertical") {
            event.preventDefault(); vertical(command.direction, command.page, command.extend); return;
        }
        if (command?.kind === "horizontal") {
            event.preventDefault(); horizontal(command.key, command.extend, command.document); return;
        }
        preferred = undefined;
        if (command?.kind === "delete") { event.preventDefault(); grapheme(command.direction, true); }
        else if (command?.kind === "language" && languageCommand(command.command)) event.preventDefault();
        // Unhandled command-navigation must not move inside the bounded textarea context.
        else if (binding === "prevent-navigation") event.preventDefault();
    }
    input.addEventListener("keydown", event => {
        const started = win.performance.now(); keydownEvents++;
        try { keydown(event); } finally { lastKeydownMs = win.performance.now() - started; }
    }, { signal: listeners.signal });
    function pointerHit(event: MouseEvent) {
        // A native scrollbar press targets the scroll container. Only its client area is text.
        if (event.target === root) {
            const bounds = clientBox(root, viewport.minimap());
            if (event.clientX < bounds.left || event.clientX >= bounds.right
                || event.clientY < bounds.top || event.clientY >= bounds.bottom) return undefined;
        }
        return viewport.hitTest(event.clientX, event.clientY);
    }
    root.addEventListener("dblclick", event => {
        const began = win.performance.now();
        try {
        wordSelectionEvents++;
        if (event.button !== 0 || disposed || composing || input.disabled || !workspace.resolveTab(target)) return;
        const point = pointerHit(event); if (!point) return;
        event.preventDefault(); selectWord(point.offset, event.altKey);
        } finally { lastWordSelectionMs = win.performance.now() - began; maxWordSelectionTurnMs = Math.max(maxWordSelectionTurnMs, lastWordSelectionMs); }
    }, { signal: listeners.signal });
    const textDrag = mountTextDragDrop({ workspace, tab: target, view, viewport, input,
        available: () => !disposed && !composing && !input.disabled,
        beforeStart: () => { stopDrag(); cancelWord(); commandRunner.cancel(); preferred = undefined; group = undefined; },
        afterDrop: () => { commits++; revealCaret(); focus(); refresh(); },
        rejected: reason => { conflict(reason); refresh(); } });
    root.addEventListener("pointerdown", () => escapeState(false), { capture: true, signal: listeners.signal });
    root.addEventListener("pointerdown", event => {
        if (event.button < 0 || event.button > 2 || disposed || composing || input.disabled || !workspace.resolveTab(target)) return;
        if (event.button === 0 && textDrag.arm(event)) return;
        // The transparent native context can overlap source text; its default hit test uses context coordinates.
        const point = pointerHit(event); if (!point) return;
        event.preventDefault(); stopDrag(); cancelWord(); preferred = undefined; focus(); group = undefined;
        const state = view.getSnapshot();
        if (event.button !== 0) {
            const inside = state.selectionSet.ranges.some(({ anchor, head }) =>
                point.offset >= Math.min(anchor, head) && point.offset <= Math.max(anchor, head));
            if (!inside) {
                view.setSelection(revision, { anchor: point.offset, head: point.offset, anchorAffinity: point.affinity, headAffinity: point.affinity });
                refresh();
            }
            return;
        }
        const extending = event.shiftKey && !event.altKey;
        const anchor = extending ? state.selection.anchor : point.offset, anchorAffinity = extending ? state.selection.anchorAffinity ?? "after" : point.affinity;
        const baseRanges = event.altKey ? state.selectionSet.ranges : extending ? state.selectionSet.ranges.filter((_, index) => index !== state.selectionSet.primary) : [];
        view.setSelections(revision, [...baseRanges, { anchor, head: point.offset, anchorAffinity, headAffinity: point.affinity }], baseRanges.length); refresh();
        if (point.padding) viewport.revealOffset(point.offset, { horizontal: "nearest", vertical: "nearest", affinity: point.affinity });
        drag = { pointer: event.pointerId, anchor, anchorAffinity, revision, x: event.clientX, y: event.clientY, selectionSet: view.getSnapshot().selectionSet, baseRanges, padding: point.padding === true }; root.setPointerCapture(event.pointerId);
    }, { signal: listeners.signal });
    root.addEventListener("pointermove", event => {
        if (drag?.pointer !== event.pointerId) return;
        if (!(event.buttons & 1) || !validDrag()) { stopDrag(); return; }
        drag = { ...drag, x: event.clientX, y: event.clientY }; updateDragHead(); dragScrolling.schedule();
    }, { signal: listeners.signal });
    function validDrag(): boolean {
        return !!drag && !disposed && !composing && !input.disabled && root.isConnected && root.clientWidth > 0 && root.clientHeight > 0
            && drag.revision === revision && drag.selectionSet === view.getSnapshot().selectionSet && !!workspace.resolveTab(target) && root.hasPointerCapture(drag.pointer);
    }
    function dragBounds() {
        return clientBox(root, viewport.minimap());
    }
    function updateDragHead(): void {
        const current = drag; if (!current) return; const bounds = dragBounds();
        const point = viewport.hitTest(Math.max(bounds.left, Math.min(bounds.right - 1, current.x)), Math.max(bounds.top, Math.min(bounds.bottom - 1, current.y)));
        if (!point || drag !== current) return;
        view.setSelections(current.revision, [...current.baseRanges, { anchor: current.anchor, head: point.offset, anchorAffinity: current.anchorAffinity, headAffinity: point.affinity }], current.baseRanges.length);
        if (drag === current) drag = { ...current, selectionSet: view.getSnapshot().selectionSet, padding: point.padding === true }; refresh();
    }
    const dragScrolling = createEdgeAutoscroll(win, viewport, {
        capture: () => drag, valid: () => validDrag(),
        velocity: captured => edgeVelocity(captured, dragBounds(), viewport.snapshot(), "outside"),
        update: () => { updateDragHead(); dragScrollFrames++; }, cancel: () => stopDrag(),
        turn: work => { const started = win.performance.now();
            try { work(); } finally { maxDragScrollStepMs = Math.max(maxDragScrollStepMs, win.performance.now() - started); } },
    });
    const stopDrag = (event?: PointerEvent) => {
        if (event && event.pointerId !== drag?.pointer) return;
        dragScrolling.stop();
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
        if (type === "paste" && (inputQueue.pending || rangeCommand) && !input.disabled && !input.readOnly) {
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
    let observedFoldRevision = view.folding.getSnapshot().revision;
    const subscriptions = [viewport.onRender(scheduleCaret), workspace.observeDocument(documentId).subscribe(refresh), view.subscribe(refresh),
        view.folding.subscribe(() => { const revision = view.folding.getSnapshot().revision;
            if (revision === observedFoldRevision) { cancelWord(); stopDrag(); preferred = undefined; group = undefined; }
            observedFoldRevision = revision; refresh(); }), resource.metadata.subscribe(refresh), workspace.tabState.subscribe(refresh)];
    let activitySnapshot: TextEditorActivity | undefined;
    function activity(): TextEditorActivity {
        const pendingInput = hostInsertion !== undefined || inputQueue.pending !== undefined || inputQueue.executing !== undefined || rangeCommand?.capture.deleting === true;
        const pendingCommand = rangeCommand !== undefined || wordJob !== undefined || graphemeJob !== undefined;
        const pendingCaret = caretLayer.pending(), pendingDragScroll = dragScrolling.pending();
        const pendingWord = rangeCommand?.purpose === "word" || wordJob !== undefined || graphemeJob?.purpose === "word" || graphemeJob?.purpose === "word-selection" || inputQueue.pending?.purpose === "word";
        const pendingGrapheme = rangeCommand?.purpose === "grapheme" || graphemeJob !== undefined || inputQueue.pending?.purpose === "grapheme";
        if (activitySnapshot && activitySnapshot.disposed === disposed && activitySnapshot.composing === composing
            && activitySnapshot.pendingInput === pendingInput && activitySnapshot.pendingCommand === pendingCommand
            && activitySnapshot.pendingCaret === pendingCaret && activitySnapshot.pendingDragScroll === pendingDragScroll
            && activitySnapshot.pendingWord === pendingWord && activitySnapshot.pendingGrapheme === pendingGrapheme) return activitySnapshot;
        return activitySnapshot = Object.freeze({ disposed, composing, pendingInput, pendingCommand, pendingCaret, pendingDragScroll, pendingWord, pendingGrapheme });
    }
    refresh();
    brackets = mountBracketHighlights(workspace, tabId, view, viewport, input, () => language,
        () => { const state = activity(); return !state.disposed && !state.composing && !state.pendingInput && !state.pendingCommand; }, bracketOptions);
    warnings = mountCharacterWarnings(workspace, tabId, view, viewport, warningOptions);
    const editor: TextEditor = Object.freeze({ element: root, input, view, viewport, focus, activity, bracketMatching: brackets.handle, characterWarnings: warnings.handle,
        captureInsertion: (kind = "paste") => {
            hostInsertion?.cancel();
            const available = () => !disposed && root.isConnected && !readOnly && !input.disabled && !input.readOnly && !composing
                && !inputQueue.pending && !inputQueue.executing && !rangeCommand && !wordJob && !graphemeJob && !insertion && !drag;
            if (!available()) return;
            syncSelection(); view.folding.revealSelection(view.folding.getSnapshot());
            let captured: CapturedInsertion | undefined;
            captured = captureInsertion(workspace, target, view, available, (plan, expected) => apply(plan.edits, plan.selectionSet, kind, undefined, expected),
                () => { if (hostInsertion === captured) hostInsertion = undefined; });
            hostInsertion = captured; return captured;
        },
        runCommand: languageCommand,
        languageConfiguration: () => language,
        configureLanguage: configuration => {
            if (disposed || composing) return false;
            hostInsertion?.cancel();
            const next = resolveLanguageConfiguration(configuration);
            cancelWord(); group = undefined; preferred = undefined; language = next;
            root.style.tabSize = String(language.tabSize); viewport.invalidate(); refresh(); brackets!.refresh(); return true;
        },
        registerEditTransform: transform => {
            if (disposed || editTransform) throw new Error("Editor is disposed or already owns an edit planner.");
            editTransform = transform; return () => { if (editTransform === transform) editTransform = undefined; };
        },
        captureView: () => { syncSelection(); return viewport.captureView(); },
        restoreView: (state: ViewState) => { viewport.restoreView(state); refresh(); },
        snapshot: () => Object.freeze({ ...activity(), inputUnits: input.value.length, inputEvents, lastInputMs, beforeInputEvents, lastBeforeInputMs, maxQueuedInputTurnMs, keydownEvents, lastKeydownMs, navigationTurns, navigationPreparationMs, maxNavigationTurnMs, navigationWorkMs, wordSelectionEvents, lastWordSelectionMs, maxWordSelectionTurnMs,
            dragScrollFrames, maxDragScrollStepMs, commits, conflicts, queuedInputUnits: inputQueue.pending?.units ?? 0, wordScanSteps, maxWordScanStepMs, graphemeScanSteps, maxGraphemeScanStepMs, visualMoves }),
        dispose: () => {
            if (disposed) return; disposed = true; activitySnapshot = undefined; editTransform = undefined;
            brackets!.dispose();
            warnings!.dispose();
            hostInsertion?.cancel();
            if (inputQueue.executing) inputQueue.recover(inputQueue.executing, "pending-input-detached");
            cancelWord();
            nativeOrder = undefined; wordInput = undefined;
            insertion = undefined; composition = undefined;
            graphemeCache = undefined; preferred = undefined; contextBuffer = undefined;
            if (composing && input.value !== context.text) conflict("composition-detached");
            composing = false;
            stopDrag();
            textDrag.dispose();
            caretLayer.dispose();
            commandRunner.cancel();
            listeners.abort();
            subscriptions.forEach(unsubscribe => unsubscribe());
            input.value = "";
            inputBinding.dispose();
            viewport.dispose();
            if (!options.view) view.dispose();
        } });
    return Object.freeze({ editor, setComparisonRows });
}
