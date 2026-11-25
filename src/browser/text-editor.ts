import { isNonNegativeInteger, isPositiveInteger } from "../core/bounds.ts";
import { mountInputCaret } from "./input-caret.ts";
import { autoClosedPairs } from "./auto-closed-pairs.ts";
import { automaticIndentation } from "./automatic-indentation.ts";
import { clientBox, cssZoom } from "./dom-coordinates.ts";
import { isFocused } from "./dom-focus.ts";
import { Store, type Observable } from "../core/observable.ts";
import { textDifference } from "../core/changes.ts";
import { copyCaretLines, planClipboardPaste } from "../core/clipboard-edits.ts";
import { collapsedLineBlock } from "../core/folding.ts";
import { createWordCommandCursor, isCodeWordBase, WordCursor } from "../core/words.ts";
import { createGraphemeCursor } from "../core/graphemes.ts";
import { createSelectionSet, planSelectionEdits } from "../core/selections.ts";
import { selectionOccurrences } from "../core/selection-occurrences.ts";
import type { Affinity } from "../core/positions.ts";
import { captureTextSurface } from "../core/workspace.ts";
import type { DocumentId, DocumentView, DocumentViewSnapshot, TabId, TabTarget, Workspace } from "../core/workspace.ts";
import type { EditKind, Selection } from "../core/history.ts";
import type { SelectionSet } from "../core/selections.ts";
import type { BufferPosition, TextBuffer } from "../core/text-buffer.ts";
import type { TextEdit } from "../core/changes.ts";
import type { GraphemeCursor, GraphemeIndex } from "../core/graphemes.ts";
import type { ViewState } from "./view-state.ts";
import { inputContext, inputContextUnits } from "./input-context.ts";
import { localAsciiGraphemePoint } from "../core/grapheme-point.ts";
import type { GraphemePoint } from "../core/grapheme-point.ts";
import { captureNativeInsertion, resolveNativeInsertion } from "./input-target.ts";
import type { NativeInsertionTarget } from "./input-target.ts";
import type { InputContext } from "./input-context.ts";
import { dispatchTypedText, editRefusedEvent, inputConflictEvent } from "./input-events.ts";
import type { EditRefusedDetail, InputConflictDetail } from "./input-events.ts";
import { mountViewport, validateRevealAlignment } from "./viewport.ts";
import type { ComparisonPresentation, MountedViewport, RevealAlignment, RevealOptions, TextViewport, ViewportSettings } from "./viewport.ts";
import { mountTextDragDrop } from "./text-drag-drop.ts";
import { lineColumnScanner, planLanguageEdit, resolveLanguageConfiguration } from "../core/language-edits.ts";
import { exportText, lineBoundary, lineContentEnd, lineEnding } from "../core/newlines.ts";
import type { EditingCommand, LanguageConfiguration, ResolvedLanguageConfiguration } from "../core/language-edits.ts";
import { captureInsertion } from "./captured-insertion.ts";
import type { CapturedInsertion } from "./captured-insertion.ts";
import { mountBracketHighlights } from "./bracket-highlights.ts";
import type { BracketHighlights } from "./bracket-highlights.ts";
import type { BracketMatchOptions } from "../core/bracket-matching.ts";
import { bracketMatchLimits } from "../core/bracket-matching.ts";
import { CharacterWarnings } from "../core/character-warnings.ts";
import type { CharacterWarningConfiguration, CharacterWarningOptions } from "../core/character-warnings.ts";
import { mountCharacterWarnings } from "./character-warnings.ts";
import type { CharacterWarningHighlights } from "./character-warnings.ts";
import { createCommandRegistry, type EditorCommand, type EditorCommands, type EditorKeymap } from "./command-registry.ts";
import { defaultEditorShortcuts, editCommand, editorCommandLabels, editorKeyCommand } from "./editor-commands.ts";
import { classifyEditingKey, commandKey, historyKey, isDeletionCommand, nativeDeletion } from "./editing-keys.ts";
import type { DeletionCommand, KeyBinding, KeyStroke, ViewCommand } from "./editing-keys.ts";
import { commandBudget, createCooperativeRunner } from "./cooperative-runner.ts";
import { createEdgeAutoscroll, edgeVelocity } from "./edge-autoscroll.ts";
import { createOrderedInputQueue, typingRun } from "./ordered-input.ts";
import type { InputKey, InputIntent, OrderedInput } from "./ordered-input.ts";

export type TextEditorEdit = Readonly<{ expectedRevision: number; edits: readonly TextEdit[]; selectionSet: SelectionSet; kind: EditKind;
    /** The editor's newline command supplied contextual indentation, rather than literal text. */
    adjustNewlines?: boolean }>;
export type TextEditorEditTransform = (edit: TextEditorEdit) => Readonly<{ edits: readonly TextEdit[]; selectionSet: SelectionSet; complete?: (applied: boolean) => void }> | undefined;
export type TextEditorActivity = Readonly<{ disposed: boolean; composing: boolean; pendingInput: boolean; pendingCommand: boolean;
    pendingCaret: boolean; pendingDragScroll: boolean; pendingWord: boolean; pendingGrapheme: boolean }>;
export type TextEditorDiagnostics = TextEditorActivity & Readonly<{
    inputUnits: number; inputEvents: number; lastInputMs: number; beforeInputEvents: number; lastBeforeInputMs: number;
    maxQueuedInputTurnMs: number; keydownEvents: number; lastKeydownMs: number; navigationTurns: number;
    navigationPreparationMs: number; maxNavigationTurnMs: number; navigationWorkMs: number;
    commits: number; conflicts: number; queuedInputUnits: number;
}>;
export type TextEditorSnapshot = Readonly<{ focused: boolean; disabled: boolean; composing: boolean;
    readOnlyReason: EditRefusedDetail["reason"] | null }>;
export type TextEditorCommand = EditingCommand | ViewCommand | DeletionCommand | "undo" | "redo";
export type LinePrompt = (request: Readonly<{ currentLine: number; lineCount: number; signal: AbortSignal }>) =>
    number | undefined | PromiseLike<number | undefined>;
export type EditorSettings = Partial<ViewportSettings> & Readonly<{ language?: LanguageConfiguration;
    pasteLineEndings?: "local" | "preserve"; bracketMatching?: boolean | BracketMatchOptions; characterWarnings?: boolean | CharacterWarningOptions }>;
export type ResolvedEditorSettings = ViewportSettings & Readonly<{ language: ResolvedLanguageConfiguration;
    pasteLineEndings: "local" | "preserve"; bracketMatching: false | Required<BracketMatchOptions>; characterWarnings: false | CharacterWarningConfiguration }>;
export type EditorRevealRange = Readonly<{ from: number; to: number }>;
type RevealTarget = BufferPosition | EditorRevealRange | Readonly<{ start: BufferPosition; end: BufferPosition }>;
export type EditorRevealOptions = Readonly<{ align?: RevealAlignment; select?: boolean; focus?: boolean; expectedRevision?: number }>;
export type TextEditorOptions = Readonly<{ ariaLabel?: string; view?: DocumentView; readOnly?: boolean; requestLine?: LinePrompt; settings?: EditorSettings }>;
export type EditorPasteHandler = (data: DataTransfer) => ((insertion: CapturedInsertion) => void) | undefined;
const editIntents = ["beforeinput", "compositionstart", "paste", "cut"] as const;
export type EditorEditIntent = typeof editIntents[number];
type PasteOwner = { handler: EditorPasteHandler; pending?: CapturedInsertion };
export type TextEditor = Observable<TextEditorSnapshot> & Readonly<{ element: HTMLDivElement; workspace: Workspace; tab: TabTarget | undefined; signal: AbortSignal; view: DocumentView; viewport: TextViewport; decorations: TextViewport["decorations"];
    /** One pending host insertion, invalidated by later editing/selection/authority/lifecycle changes. */
    captureInsertion: (kind?: "paste" | "replace") => CapturedInsertion | undefined;
    registerPasteHandler: (handler: EditorPasteHandler) => () => void;
    /** Observe native editing gestures on this pane before they reach its editing handlers. */
    onEditIntent: (listener: (kind: EditorEditIntent) => void, signal?: AbortSignal) => { dispose(): void };
    /** One synchronous edit planner per view. Its result still passes Workspace validation/history. */
    registerEditTransform: (transform: TextEditorEditTransform) => () => void;
    configure: (changes: EditorSettings) => boolean;
    settings: () => ResolvedEditorSettings;
    bracketMatching: BracketHighlights;
    characterWarnings: CharacterWarningHighlights;
    /** Returns whether the command was accepted; long selections finish asynchronously. */
    commands: EditorCommands; keymap: EditorKeymap;
    reveal: (target: RevealTarget, options?: EditorRevealOptions) => EditorRevealRange | null;
    focus: () => void; captureView: () => ViewState; restoreView: TextViewport["restoreView"];
    /** Immutable activity capture, reused while its fields are unchanged. Does not collect metrics. */
    activity: () => TextEditorActivity;
    getDiagnostics: () => TextEditorDiagnostics;
    dispose: () => void }>;
export type MountedTextEditor = Readonly<{ editor: TextEditor; input: HTMLTextAreaElement; setComparisonRows: MountedViewport["setComparisonRows"] }>;

/** Text editor with bounded native input and virtualized rendering. Native IME qualification is separate. */
export function mountTextEditor(host: HTMLElement, workspace: Workspace, identity: DocumentId | TabId,
    options: TextEditorOptions = {}): TextEditor {
    return mountEditor(host, workspace, identity, options).editor;
}

/** Private pane mount; the comparison capability belongs to this exact editor lifetime. */
export function mountEditor(host: HTMLElement, workspace: Workspace, identity: DocumentId | TabId,
    options: TextEditorOptions = {}, comparison?: ComparisonPresentation & {
        commands: ReadonlyMap<string, EditorCommand>;
        epoch: () => number | undefined;
    }): MountedTextEditor & { commandScope: ReturnType<typeof createCommandRegistry>["scope"] } {
    const initial = options.settings;
    const matching = (value: boolean | BracketMatchOptions) => value === false ? false : bracketMatchLimits(value === true ? {} : value);
    const classifyWarnings = (value: boolean | CharacterWarningOptions) => value === false ? undefined : new CharacterWarnings(value === true ? {} : value);
    const pastePolicy = (value: string) => {
        if (value !== "local" && value !== "preserve") throw new TypeError("Invalid paste line-ending policy.");
        return value;
    };
    let language = resolveLanguageConfiguration(initial?.language);
    let pasteLineEndings: ResolvedEditorSettings["pasteLineEndings"] = pastePolicy(initial?.pasteLineEndings ?? "local");
    let bracketOptions: ResolvedEditorSettings["bracketMatching"] = matching(initial?.bracketMatching ?? false);
    let warningOptions = classifyWarnings(initial?.characterWarnings ?? false);
    const paired = autoClosedPairs();
    const automaticIndent = automaticIndentation();
    const readOnly = options.readOnly === true;
    let readOnlyReason: EditRefusedDetail["reason"] | undefined;
    const surface = captureTextSurface(workspace, identity), { documentId, resource, tab: target } = surface;
    if (options.view && (options.view.documentId !== documentId || !workspace.ownsDocumentView(options.view))) throw new Error("View belongs to a different document or workspace.");
    const view = options.view ?? workspace.createDocumentView(documentId);
    const source = workspace.observeDocument(documentId);
    const live = () => workspace.ownsDocumentView(view, target);
    let setComparisonRows: MountedTextEditor["setComparisonRows"], viewport: TextViewport, navigation: MountedViewport["navigation"], brackets: ReturnType<typeof mountBracketHighlights> | undefined, warnings: ReturnType<typeof mountCharacterWarnings> | undefined;
    try { const mounted = mountViewport(host, workspace, surface, { ...options, view }, comparison);
        viewport = mounted.viewport; navigation = mounted.navigation; setComparisonRows = mounted.setComparisonRows; }
    catch (error) { if (!options.view) view.dispose(); throw error; }
    const root = viewport.element;
    root.style.tabSize = String(language.tabSize);
    const owner = host.ownerDocument, win = owner.defaultView!, input = owner.createElement("textarea");
    const scope = workspace.allocateIdentity(), listeners = new AbortController();
    root.classList.add("st-editor");
    input.className = "st-input-context"; input.wrap = "off"; input.spellcheck = false; input.autocomplete = "off";
    // The native projection belongs to the editor, independently of enclosing host forms.
    input.setAttribute("form", "");
    const initialDocument = workspace.document(documentId);
    input.setAttribute("aria-label", options.ariaLabel ?? initialDocument.title);
    input.setAttribute("autocapitalize", "off");
    root.append(input);
    let contextBuffer: TextBuffer | undefined = initialDocument.buffer, contextSelection = view.getSnapshot().selection;
    let revision = initialDocument.revision, context: InputContext = inputContext(contextBuffer, contextSelection);
    let disposed = false, composing = false, selecting = false, committing = false;
    const notifications = workspace.createNotificationScope();
    const editorState = new Store<TextEditorSnapshot>(Object.freeze({ focused: false, disabled: false, composing: false, readOnlyReason: null }), notifications);
    const stateSubscriptions = new Set<() => void>();
    function publishState(): void {
        const prior = editorState.get(), focused = !disposed && isFocused(input), disabled = disposed || input.disabled;
        const reason = readOnlyReason ?? null;
        if (prior.focused !== focused || prior.disabled !== disabled || prior.composing !== composing || prior.readOnlyReason !== reason)
            notifications.publish(editorState, Object.freeze({ focused, disabled, composing, readOnlyReason: reason }));
    }
    let escapeSelection: SelectionSet | undefined;
    let editTransform: TextEditorEditTransform | undefined;
    let hostInsertion: CapturedInsertion | undefined;
    let pasteOwner: PasteOwner | undefined;
    const escapeState = (value: boolean) => {
        if (!!escapeSelection === value) return;
        escapeSelection = value ? view.getSnapshot().selectionSet : undefined;
        root.toggleAttribute("data-st-tab-escape", value);
    };
    let commits = 0, conflicts = 0, serial = 0, inputEvents = 0, lastInputMs = 0;
    let beforeInputEvents = 0, lastBeforeInputMs = 0, maxQueuedInputTurnMs = 0;
    let keydownEvents = 0, lastKeydownMs = 0;
    let navigationTurns = 0, navigationPreparationMs = 0, maxNavigationTurnMs = 0, navigationWorkMs = 0, navigationDepth = 0;
    type VisualColumns = Readonly<{ head: number | undefined; anchor?: number | undefined }>;
    let preferred: Readonly<{ selections: SelectionSet; revision: number; layout: string; columns: readonly (VisualColumns | undefined)[] }> | undefined;
    let group: Readonly<{ type: string; revision: number; selectionSet: SelectionSet; tail: ReturnType<typeof typingRun> | "spaces" | undefined; key: string }> | undefined;
    type ColumnDrag = { kind: "column"; middle: boolean; originRow: number; anchorColumn: number;
        projection?: { layout: string; column: number; direction: -1 | 1; count: number; ranges: (Selection & { reaches: boolean })[] } };
    type DragUnit = ColumnDrag | (({ kind: "line"; range: Selection; lineStart: number }
        | { kind: "word"; origin: number; range?: Selection }) & { lastHit?: number });
    let drag: Readonly<{ pointer: number; anchor: number; anchorAffinity: Affinity; revision: number; x: number; y: number; selectionSet: SelectionSet; baseRanges: readonly Selection[]; padding: boolean; unit?: DragUnit }> | undefined;
    let dragCaretRecorded = false;
    let pointerOrigin: Selection | undefined;
    const commandRunner = createCooperativeRunner(win);
    let wordJob: Readonly<{ cursor: Pick<WordCursor, "next" | "dispose">; revision: number }> | undefined, cancelWordTask: (() => void) | undefined;
    type CommandCapture = Readonly<{ buffer: TextBuffer; revision: number; selection: Selection; selectionSet: SelectionSet; deleting: boolean }>;
    let lineRequest: { capture: CommandCapture; abort: AbortController } | undefined;
    function cancelLineRequest(): void {
        const request = lineRequest; lineRequest = undefined; request?.abort.abort();
    }
    let graphemeJob: Readonly<{ cursor: GraphemeCursor; capture: CommandCapture; purpose: "word" | "grapheme" }> | undefined, cancelGraphemeTask: (() => void) | undefined;
    let graphemeCache: Readonly<{ buffer: TextBuffer; from: number; to: number; index: GraphemeIndex }> | undefined;
    const lineCopyFormat = "application/x-sttropez-lines";
    const copiedLines = (data: DataTransfer | null) => data?.getData(lineCopyFormat) === "1";
    type InputCapture = Readonly<{ revision: number; selectionSet: SelectionSet; context: InputContext; target?: NativeInsertionTarget; wholeLines?: boolean }>;
    let pendingDeletion: Readonly<{ revision: number; selectionSet: SelectionSet; command: DeletionCommand }> | undefined;
    let insertion: InputCapture | undefined, composition: InputCapture | undefined;
    let projectedSet = view.getSnapshot().selectionSet;
    let rangeCommand: Readonly<{ capture: CommandCapture; purpose: OrderedInput<CommandCapture>["purpose"]; release: () => void }> | undefined, cancelRangeTask: (() => void) | undefined;
    let nativeOrder: { order: OrderedInput<CommandCapture>; capture: InputCapture; type: string; data: string | null; action?: InputKey; invalid: boolean; reported: boolean } | undefined;
    const inputQueue = createOrderedInputQueue<CommandCapture>(win.performance, commandRunner, {
        command: () => rangeCommand, capture: () => commandCapture(false), disposed: () => disposed,
        validCommand: capture => validCommand(capture),
        valid: (capture, editing) => validCommand(capture) && root.isConnected && workspace.ownsDocumentView(view) && !(editing && input.readOnly),
        committed: capture => committing && source.getSnapshot()?.revision !== capture.revision,
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
    const registry = createCommandRegistry(apple,
        () => !disposed && !composing && !input.disabled && live() && (!comparison || comparison.epoch() !== undefined), () => {
            const version = revision, selection = view.getSnapshot().selectionSet, epoch = comparison?.epoch();
            return () => version === revision && selection === view.getSnapshot().selectionSet && epoch === comparison?.epoch();
        }, () => editor, comparison?.commands);
    for (const [id, label] of editorCommandLabels) {
        registry.commands.register({ id, label, owner: "editor", category: "Editing", run: () => runCommand(id), enabled: () => {
            if (id === "undo" || id === "redo") {
                const depth = workspace.observeHistory(documentId).getSnapshot();
                return !input.readOnly && (id === "undo" ? depth.undoDepth : depth.redoDepth) > 0;
            }
            if (id === "go-to-line") return !!options.requestLine;
            if (isDeletionCommand(id)) return !input.readOnly;
            if (!editCommand(id)) return true;
            if (input.readOnly) return false;
            if (id === "block-comment") return !!language.blockComment;
            return !["line-comment", "add-line-comment", "remove-line-comment"].includes(id) || !!language.lineComment;
        } });
    }
    for (const [keys, command] of apple ? defaultEditorShortcuts.apple : defaultEditorShortcuts.standard) {
        registry.keymap.bind(keys, command);
    }
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
        source.getSnapshot, () => composing);
    const scheduleCaret = caretLayer.schedule;
    function refresh(): void {
        if (escapeSelection && escapeSelection !== view.getSnapshot().selectionSet) escapeState(false);
        if (disposed || selecting || committing) return;
        const state = resource.getSnapshot(), disabled = !live() || state.state !== "ready";
        if (disabled) contextBuffer = undefined;
        const reason = readOnly || !state.metadata.capabilities.edit.includes("human") ? "read-only"
            : state.metadata.editLock !== null ? "edit-locked" : undefined;
        if (reason !== readOnlyReason || disabled !== input.disabled) {
            readOnlyReason = reason;
            input.readOnly = reason !== undefined;
            if (reason) root.dataset.readOnly = reason;
            else delete root.dataset.readOnly;
            input.disabled = disabled;
            publishState();
        }
        if (lineRequest && !validCommand(lineRequest.capture)) cancelLineRequest();
        if (inputQueue.executing?.edit && input.readOnly) inputQueue.recover(inputQueue.executing, "pending-input-expired");
        if (inputQueue.pending && (!inputQueue.current(inputQueue.pending) || inputQueue.pending.edit && input.readOnly)) cancelWord();

        if (!input.disabled && !composing) {
            const document = workspace.document(documentId), { selection: selected, selectionSet } = view.getSnapshot();
            paired.sync(document); automaticIndent.sync(document);
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
            projectSelection();
        }
        scheduleCaret();
    }
    function projectSelection(): void {
        const anchor = context.nativeAnchor, head = context.nativeHead;
        if (input.selectionStart !== Math.min(anchor, head) || input.selectionEnd !== Math.max(anchor, head)
            || (input.selectionDirection === "backward") !== (anchor > head)) input.setSelectionRange(Math.min(anchor, head), Math.max(anchor, head), anchor > head ? "backward" : "forward");
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
    function refuseEdit(event: Event): void {
        if (event.cancelable) event.preventDefault();
        if (readOnlyReason && !input.disabled && live()) root.dispatchEvent(new CustomEvent<EditRefusedDetail>(editRefusedEvent,
            { bubbles: true, detail: Object.freeze({ documentId, reason: readOnlyReason }) }));
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
            const unapplied = !executing && source.getSnapshot()?.revision === expectedRevision ? attemptedText : "";
            conflict("command-failed", undefined, expectedRevision, 0, unapplied, cause);
        }
    }
    const revealScope = workspace.createNotificationScope();
    function reveal(target: RevealTarget, options: EditorRevealOptions = {}): EditorRevealRange | null {
        const { align = "nearest", select = false, focus: takeFocus = false, expectedRevision } = options;
        validateRevealAlignment(align);
        if (typeof select !== "boolean" || typeof takeFocus !== "boolean") throw new TypeError("Invalid reveal flags.");
        if (expectedRevision !== undefined && !isNonNegativeInteger(expectedRevision))
            throw new RangeError("Invalid reveal revision.");
        if (disposed || input.disabled || !live() || resource.getSnapshot().state !== "ready") return null;
        const state = activity();
        if (state.composing || state.pendingInput || state.pendingCommand) return null;
        const { revision, buffer } = workspace.document(documentId);
        if (expectedRevision !== undefined && revision !== expectedRevision) return null;
        function offset(position: BufferPosition): number {
            if (!Number.isSafeInteger(position.line) || !Number.isSafeInteger(position.column)) {
                throw new RangeError("Invalid reveal position.");
            }
            const line = Math.max(0, Math.min(position.line, buffer.lineCount - 1));
            return buffer.offsetAt({ line, column: Math.max(0, position.column) });
        }
        let from: number, to: number;
        if ("line" in target) {
            from = to = offset(target);
        } else if ("start" in target) {
            const first = offset(target.start);
            const last = offset(target.end);
            from = Math.min(first, last);
            to = Math.max(first, last);
        } else {
            if (!Number.isSafeInteger(target.from) || !Number.isSafeInteger(target.to) || target.from > target.to)
                throw new RangeError("Invalid reveal range.");
            from = Math.max(0, Math.min(target.from, buffer.length));
            to = Math.max(0, Math.min(target.to, buffer.length));
        }
        const applied = revealScope.batch(() => {
            if (select && !view.setSelection(revision, { anchor: from, head: to })) return false;
            viewport.revealRange(from, to, align);
            return true;
        });
        if (!applied || disposed || !live() || workspace.document(documentId).revision !== revision) return null;
        if (takeFocus) focus();
        return Object.freeze({ from, to });
    }
    function revealCaret(selected = view.getSnapshot().selection, vertical: NonNullable<RevealOptions["vertical"]> = "nearest"): void {
        let offset = selected.head;
        if (selected.head !== selected.anchor) {
            const buffer = workspace.document(documentId).buffer;
            if (offset === buffer.length) {
                const block = view.folding.getSnapshot().index.hiddenBy(buffer.lineCount - 1);
                if (block) offset = lineContentEnd(buffer, block.lineFrom);
            }
        }
        viewport.revealOffset(offset, { horizontal: "nearest", vertical, affinity: selected.headAffinity ?? "after" });
    }
    type ApplyOptions = { type?: string | undefined; expectedRevision?: number; recoveryText?: string | undefined;
        adjustNewlines?: boolean; accepted?: ((edits: readonly TextEdit[]) => void) | undefined; typedText?: string | undefined };
    function apply(edits: readonly TextEdit[], selection: Selection | SelectionSet, kind: EditKind,
        { type, expectedRevision = revision, recoveryText, adjustNewlines, accepted, typedText }: ApplyOptions = {}): boolean {
        if (disposed) return false;
        hostInsertion?.cancel();
        if (readOnly) { conflict("read-only", edits[0], expectedRevision, context.from, recoveryText); refresh(); return false; }
        cancelWord(); preferred = undefined;
        if (!live()) { conflict("expired-view", edits[0], expectedRevision, context.from, recoveryText); refresh(); return false; }
        let key: string | undefined;
        const before = view.getSnapshot().selectionSet, typed = type === "insertText" ? edits[0]?.insert : undefined;
        let tail: NonNullable<typeof group>["tail"] = typed === undefined ? undefined : typingRun(typed);
        const document = workspace.document(documentId);
        const trimmed = document.revision === expectedRevision && automaticIndent.trim(document.buffer, edits, selection);
        if (trimmed) { edits = trimmed.edits; selection = trimmed.selectionSet; }
        const transformed = editTransform?.(Object.freeze({ expectedRevision, edits,
            selectionSet: "ranges" in selection ? selection : createSelectionSet(document.buffer.length + edits.reduce((n, edit) => n + edit.insert.length - (edit.to - edit.from), 0), [selection]), kind,
            ...(adjustNewlines ? { adjustNewlines: true } : {}) }));
        if (transformed) { edits = transformed.edits; selection = transformed.selectionSet; }
        if (type) {
            const adjacent = group?.type === type && group.revision === expectedRevision && group.selectionSet === before
                && tail !== "mixed" && group.tail !== "mixed"
                && !(tail === "space" && group.tail === "word" || tail === "word" && group.tail === "spaces");
            if (tail === "space" && (typed!.length > 1 || adjacent)) tail = "spaces";
            key = adjacent ? group!.key : `${view.id}:${scope}:${++serial}`;
        } else group = undefined;
        committing = true; let applied = false, typedAt: DocumentViewSnapshot | undefined;
        try {
            const result = workspace.edit({ documentId, expectedRevision, origin: "human", edits, view,
                ...("ranges" in selection ? { selectionSet: selection } : { selection }),
                history: { kind, ...(key ? { group: key } : {}) } });
            applied = result.applied;
            if (result.applied) { // A later presentation/completion failure must not recover this text twice.
                inputQueue.consumeRunning();
                if (accepted && workspace.document(documentId).revision === result.revision) accepted(edits);
                commits++; const after = view.getSnapshot(); revealCaret(after.selection);
                if (typedText && after.revision === result.revision && (!transformed || edits.some(edit => edit.insert.length > 0))) typedAt = after;
                if (type && key) group = { type, revision: result.revision, selectionSet: after.selectionSet, tail, key }; }
            else conflict(result.reason, edits[0], expectedRevision, context.from, recoveryText);
        } finally {
            committing = false;
            try { transformed?.complete?.(applied); } finally {
                refresh();
                if (typedAt && typedText && !disposed && live()) dispatchTypedText(root, typedAt, typedText);
            }
        }
        return applied;
    }
    function captureInput(type: string, data: string | null, wholeLines = false): InputCapture {
        const target = captureNativeInsertion(input, type, data);
        return { revision, selectionSet: view.getSnapshot().selectionSet, context, ...(target ? { target } : {}), wholeLines };
    }
    function commit(type: string, captured = insertion ?? { revision, selectionSet: projectedSet, context }): void {
        insertion = undefined;
        if (disposed || composing) return;
        if (type === "historyUndo" || type === "historyRedo") { history(type === "historyUndo" ? "undo" : "redo"); return; }
        const projection = captured.context;
        if (input.value === projection.text && input.selectionStart === (captured.target?.from ?? Math.min(projection.nativeAnchor, projection.nativeHead))
            && input.selectionEnd === (captured.target?.to ?? Math.max(projection.nativeAnchor, projection.nativeHead))) { refresh(); return; }
        if ((captured.target && captured.target.before !== projection.text) || captured.revision !== source.getSnapshot()?.revision || captured.selectionSet !== view.getSnapshot().selectionSet) {
            conflict(type === "insertCompositionText" && captured.revision !== source.getSnapshot()?.revision ? "stale-revision" : "stale-text-input", undefined, captured.revision, projection.from); refresh(); return;
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
        const options = { type: typing || deleting ? type : undefined, expectedRevision: captured.revision,
            typedText: type === "insertText" || type === "insertCompositionText" ? edit.insert : undefined };
        if (captured.selectionSet.ranges.length > 1 || kind === "paste" && captured.wholeLines && exactTarget) {
            // A native textarea describes one primary target. Replicate only an exact captured
            // selection replacement; neighbouring autocorrection/reconversion needs its own plan.
            if (from !== Math.min(selected.anchor, selected.head) || to !== Math.max(selected.anchor, selected.head)) {
                conflict("unsupported-multiple-input-target", { from, to, insert: edit.insert }, captured.revision, projection.from); refresh(); return;
            }
            const plan = planInput(workspace.document(documentId).buffer, captured.selectionSet, edit.insert, kind, captured.wholeLines);
            apply(plan.edits, plan.selectionSet, kind, options); return;
        }
        const buffer = workspace.document(documentId).buffer;
        const converted = kind === "paste" && pasteLineEndings !== "preserve" && /[\r\n]/.test(edit.insert)
            ? exportText(edit.insert, lineEnding(buffer, buffer.lineAt(from)) === "\n" ? "lf" : "crlf") : undefined;
        const insert = converted?.text ?? edit.insert, delta = insert.length - (to - from);
        const map = (offset: number) => offset <= edit.from ? projection.toModel(offset)
            : offset >= edit.from + edit.insert.length ? projection.toModel(offset - edit.insert.length + edit.to - edit.from) + delta
            : from + (converted?.mapping.map(offset - edit.from).offset ?? offset - edit.from);
        const backward = input.selectionDirection === "backward", selection = exactTarget ? { anchor: from + insert.length, head: from + insert.length }
            : { anchor: map(backward ? input.selectionEnd : input.selectionStart), head: map(backward ? input.selectionStart : input.selectionEnd) };
        apply([{ from, to, insert }], selection, kind, options);
    }
    function history(direction: "undo" | "redo"): boolean {
        if (disposed) return false; hostInsertion?.cancel(); cancelWord(); group = undefined; syncSelection();
        if (input.readOnly) { refresh(); return false; }
        if (!live()) { conflict("expired-view"); refresh(); return false; }
        const result = workspace[direction]({ documentId, expectedRevision: revision });
        if (!result.applied && result.reason !== "history-empty") conflict(result.reason);
        else if (result.applied) revealCaret(view.getSnapshot().selection, "center-if-outside");
        refresh(); return result.applied;
    }
    const focus = () => { if (!disposed) { input.focus({ preventScroll: true }); scheduleCaret(); } };
    const inputBinding = viewport.bindInput(focus);
    function planInput(buffer: TextBuffer, selections: SelectionSet, text: string, kind: EditKind, wholeLines = false) {
        return kind === "paste" ? planClipboardPaste(buffer, selections, text, wholeLines, pasteLineEndings === "preserve")
            : planSelectionEdits(buffer.length, selections, text);
    }
    function replaceSelection(insert: string, kind: EditKind, type?: string, recoveryText?: string, wholeLines = false): boolean {
        const document = workspace.document(documentId), plan = planInput(document.buffer, view.getSnapshot().selectionSet, insert, kind, wholeLines);
        return apply(plan.edits, plan.selectionSet, kind, { type: kind === "typing" ? type : undefined, expectedRevision: document.revision,
            recoveryText, typedText: type === "insertText" ? insert : undefined });
    }
    // Delayed commands belong to this captured tab, revision and complete selection set.
    // cancelWord releases scans, row preparation and ordered input; no focused-view lookup occurs later.
    const validCommand = (capture: CommandCapture) => !disposed && !composing && !input.disabled
        && !(capture.deleting && input.readOnly) && live()
        && source.getSnapshot()?.revision === capture.revision
        && view.getSnapshot().selectionSet === capture.selectionSet;
    function withGraphemes(capture: CommandCapture, offset: number, side: -1 | 1, purpose: "word" | "grapheme", done: (point: GraphemePoint) => void,
        turn: (work: () => void) => void = work => work()): void {
        cancelScans(); if (!validCommand(capture)) return;
        const local = localAsciiGraphemePoint(capture.buffer, offset);
        if (local) { done(local); return; }
        const point = (index: GraphemeIndex): GraphemePoint => Object.freeze({ offset, floor: index.floor(offset), ceil: index.ceil(offset), preceding: index.preceding(offset), following: index.following(offset) });
        const buffer = capture.buffer; let line = buffer.lineAt(offset); if (side < 0 && line > 0 && offset === buffer.offsetAt(line)) line--;
        const from = buffer.offsetAt(line), to = lineBoundary(buffer, line + 1);
        if (graphemeCache?.buffer === buffer && graphemeCache.from === from && graphemeCache.to === to) { done(point(graphemeCache.index)); return; }
        const job = { cursor: createGraphemeCursor(buffer, { from, to }), capture, purpose }; graphemeJob = job;
        const step = () => turn(() => commandTurn(() => {
            if (graphemeJob !== job) return; if (!validCommand(capture)) { cancelWord(); return; }
            const result = commandRunner.slice(() => job.cursor.next(commandBudget.cursorUnits), result => result.status === "running", commandBudget.graphemeCalls);
            if (result.status === "running") { cancelGraphemeTask = commandRunner.schedule(() => { if (graphemeJob === job) cancelGraphemeTask = undefined; step(); }, 0, turn); return; }
            const index = result.result!; job.cursor.dispose(); graphemeJob = undefined; graphemeCache = Object.freeze({ buffer, from, to, index }); done(point(index));
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
    function finishRanges(capture: CommandCapture, ranges: readonly Selection[], type?: string, primary = capture.selectionSet.primary): SelectionSet | undefined {
        if (!validCommand(capture)) return;
        const selections = createSelectionSet(capture.buffer.length, ranges, primary);
        completeCaptured(capture, () => {
        if (capture.deleting) { const plan = planSelectionEdits(capture.buffer.length, selections, "");
            return apply(plan.edits, plan.selectionSet, "delete", { type, expectedRevision: capture.revision }); }
        else { cancelWord(); group = undefined; view.setSelections(capture.revision, selections.ranges, selections.primary);
            revealCaret(); refresh(); }
        return true;
        });
        return view.getSnapshot().selectionSet;
    }
    function moved(range: Selection, offset: number, extend: boolean, affinity: Affinity = "after"): Selection {
        return { anchor: extend ? range.anchor : offset, head: offset, anchorAffinity: extend ? range.anchorAffinity ?? "after" : affinity, headAffinity: affinity };
    }
    function deleteGrapheme(direction: -1 | 1): boolean {
        if (disposed || composing || input.disabled || input.readOnly) return false;
        hostInsertion?.cancel(); view.folding.revealSelection(view.folding.getSnapshot()); cancelWord();
        syncSelection(); preferred = undefined;
        const capture = commandCapture(true);
        const scanColumns = lineColumnScanner((from, to) => capture.buffer.slice(from, to), language.tabSize);
        eachRange(capture, "grapheme", (range, done) => {
            if (range.anchor !== range.head) { done(range); return; }
            const offset = range.head;
            if (direction < 0 && paired.emptyAt(offset)) { done({ anchor: offset - 1, head: offset + 1 }); return; }
            const adjacent = () => withGraphemes(capture, offset, direction, "grapheme", point => {
                const from = direction < 0 && point.floor === offset ? point.preceding ?? offset : point.floor;
                const to = direction > 0 ? point.following ?? offset : point.ceil;
                done({ anchor: from, head: to });
            });
            if (direction > 0 || !offset || !/[ \t]/.test(capture.buffer.slice(offset - 1, offset))) { adjacent(); return; }
            const start = capture.buffer.offsetAt(capture.buffer.lineAt(offset));
            const columns = scanColumns(start, offset, true);
            const step = () => commandTurn(() => {
                if (!validCommand(capture)) { cancelWord(); return; }
                const result = commandRunner.slice(() => columns.next(), result => !result.done, commandBudget.wordCalls);
                if (!result.done) { cancelRangeTask = commandRunner.schedule(() => { cancelRangeTask = undefined; step(); }); return; }
                if (result.value.indentation) done({ anchor: result.value.previousStop, head: offset }); else adjacent();
            });
            step();
        }, ranges => finishRanges(capture, ranges, direction < 0 ? "deleteContentBackward" : "deleteContentForward"));
        return true;
    }
    function word(direction: -1 | 1, deleting: boolean, extend = false): boolean {
        if (disposed || composing || input.disabled || deleting && input.readOnly) return false;
        hostInsertion?.cancel(); view.folding.revealSelection(view.folding.getSnapshot()); cancelWord();
        group = undefined; preferred = undefined; syncSelection();
        const capture = commandCapture(deleting);
        eachRange(capture, "word", (selected, done) => {
        if (deleting && selected.anchor !== selected.head) { done(selected); return; }
        if (deleting && direction < 0 && paired.emptyAt(selected.head)) { done({ anchor: selected.head - 1, head: selected.head + 1 }); return; }
        withGraphemes(capture, selected.head, deleting ? direction < 0 ? 1 : -1 : direction, "word", point => {
        const start = (deleting ? -direction : direction) < 0 ? point.floor : point.ceil;
        const job = { cursor: createWordCommandCursor(capture.buffer, start, direction, deleting), revision: capture.revision }; wordJob = job;
        const step = () => commandTurn(() => {
            if (wordJob !== job) return;
            const current = source.getSnapshot();
            if (!validCommand(capture) || current?.revision !== job.revision) { cancelWord(); return; }
            const result = commandRunner.slice(() => job.cursor.next(commandBudget.cursorUnits), result => result.status === "running", commandBudget.wordCalls);
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
        return true;
    }
    function wordRange(capture: CommandCapture, offset: number, accept: (range?: Selection) => void, wordsOnly = false): void {
        const buffer = capture.buffer;
        const line = buffer.lineAt(offset), from = buffer.offsetAt(line);
        const to = lineContentEnd(buffer, line);
        if (to === from) { accept(); return; }
        const scan = (start: number, direction: -1 | 1, done: (offset: number) => void) => {
            if (!validCommand(capture)) return;
            const job = { cursor: new WordCursor(buffer, start, direction, { from, to, skipWhitespace: false }), revision: capture.revision }; wordJob = job;
            const step = () => commandTurn(() => {
                if (wordJob !== job) return; if (!validCommand(capture)) { cancelWord(); return; }
                const result = commandRunner.slice(() => job.cursor.next(commandBudget.cursorUnits), result => result.status === "running", commandBudget.wordCalls);
                if (result.status === "running") {
                    cancelWordTask = commandRunner.schedule(() => { if (wordJob === job) cancelWordTask = undefined; step(); }); return;
                }
                done(result.offset!);
            }); step();
        };
        withGraphemes(capture, Math.min(offset, to), -1, "word", point => {
            const characterAt = (at: number) => Array.from(buffer.slice(at, Math.min(to, at + 2)))[0] ?? "";
            let probe = Math.max(from, point.floor), character = characterAt(probe);
            if (probe === to || wordsOnly && probe === offset && !isCodeWordBase(character)) {
                probe = Math.max(from, point.preceding ?? from); character = characterAt(probe);
            }
            if (wordsOnly && !isCodeWordBase(character)) { accept(); return; }
            scan(probe + character.length, -1, left => scan(probe, 1, right => {
                withGraphemes(capture, left, -1, "word", low => withGraphemes(capture, right, 1, "word", high => {
                    if (rangeCommand?.capture === capture && validCommand(capture)) accept({ anchor: Math.max(from, low.floor), head: Math.min(to, high.ceil) });
                }));
            }));
        });
    }
    function selectWord(offset: number, add = false): void {
        cancelWord(); if (disposed || composing || input.disabled || !live()) return;
        stopDrag(); group = undefined; preferred = undefined; focus(); syncSelection();
        const capture = commandCapture(false);
        rangeCommand = { capture, purpose: "word", release: () => {} };
        wordRange(capture, offset, range => {
            rangeCommand = undefined; completeCaptured(capture, () => {
                if (!range) return true;
                if (add) view.setSelections(capture.revision, [...capture.selectionSet.ranges, range], capture.selectionSet.ranges.length);
                else view.setSelection(capture.revision, range);
                pointerOrigin = range;
                refresh(); return true;
            });
        });
    }
    let inferredOccurrence: SelectionSet | undefined;
    function selectOccurrences(all: boolean): void {
        cancelWord(); syncSelection(); group = undefined; preferred = undefined;
        const capture = commandCapture(false), { selection, selectionSet } = capture;
        const empty = selection.head === selection.anchor, wholeWord = empty || inferredOccurrence === selectionSet;
        let search: ReturnType<typeof selectionOccurrences> | undefined;
        rangeCommand = { capture, purpose: "word", release: () => { search?.return(selectionSet); } };
        const finish = (result: SelectionSet) => {
            rangeCommand = undefined;
            completeCaptured(capture, () => {
                if (!view.setSelections(capture.revision, result.ranges, result.primary)) return false;
                inferredOccurrence = wholeWord ? view.getSnapshot().selectionSet : undefined;
                revealCaret(); refresh(); return true;
            });
        };
        const begin = (seed?: Selection) => {
            if (!seed) { finish(selectionSet); return; }
            if (!all && empty) {
                const ranges = selectionSet.ranges.slice(); ranges[selectionSet.primary] = seed;
                finish({ ranges, primary: selectionSet.primary }); return;
            }
            const cursor = search = selectionOccurrences(capture.buffer, selectionSet, seed, all, wholeWord);
            const step = () => commandTurn(() => {
                if (!validCommand(capture)) { cancelWord(); return; }
                const result = commandRunner.slice(() => cursor.next(), result => !result.done, commandBudget.graphemeCalls);
                if (result.done) finish(result.value);
                else cancelRangeTask = commandRunner.schedule(() => { cancelRangeTask = undefined; step(); });
            });
            step();
        };
        if (empty) wordRange(capture, selection.head, begin, true); else begin(selection);
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
        const state = viewport.getSnapshot();
        return [style, root.clientWidth, root.clientHeight, state.width, state.height, state.lineHeight, state.columnWidth, viewport.activity().rowGeneration, view.folding.getSnapshot().generation].join("|");
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
        // Small selection sets on short rows can complete in the key handler.
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
        for (const line of lines) if (lineBoundary(buffer, line + 1) - buffer.offsetAt(line) > 514) return false;
        return true;
    }
    function verticalCount(page: boolean): number {
        const state = viewport.getSnapshot(); return page && state.lineHeight > 0 ? Math.max(1, Math.floor(state.height / state.lineHeight) - 1) : 1;
    }
    function verticalRows(buffer: TextBuffer, ranges: readonly Selection[], add: boolean, next: (line: number) => number): Set<number> {
        const lines = new Set<number>();
        const include = (offset: number) => { const line = buffer.lineAt(offset); lines.add(line); lines.add(next(line)); };
        for (const range of ranges) { include(range.head); if (add && range.anchor !== range.head) include(range.anchor); }
        return lines;
    }
    function shortVertical(capture: CommandCapture, direction: -1 | 1, page: boolean, add: boolean): boolean {
        if (capture.selectionSet.ranges.length > 2) return false;
        // Page destinations use current viewport dimensions, including a pending resize.
        viewport.flush();
        if (viewport.activity().aligned) return false;
        const buffer = capture.buffer, folds = view.folding.getSnapshot().index, count = verticalCount(page);
        return shortRows(buffer, verticalRows(buffer, capture.selectionSet.ranges, add, line =>
            folds.lineAt(Math.max(0, Math.min(folds.visibleLineCount - 1, folds.rowAt(line) + direction * count)))));
    }
    function prepareMovement(): void {
        hostInsertion?.cancel(); view.folding.revealSelection(view.folding.getSnapshot());
        syncSelection(); group = undefined;
    }
    function moveToBoundary(key: "Home" | "End", extend: boolean, documentBoundary = false): boolean {
        prepareMovement(); preferred = undefined; cancelWord();
        navigationTurns = 0; navigationPreparationMs = 0; maxNavigationTurnMs = 0; navigationWorkMs = 0;
        const capture = commandCapture(false), buffer = capture.buffer, firstNonblank = new Map<number, number>();
        if (!validCommand(capture)) return false;
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
        return true;
    }
    function horizontal(key: "ArrowLeft" | "ArrowRight", extend: boolean): boolean {
        prepareMovement(); preferred = undefined;
        beginNavigation((capture, style, inline) => {
        const began = win.performance.now(); viewport.flush();
        if (!validCommand(capture) || navigationStyle() !== style) { cancelWord(); return; }
        const layout = navigationLayout(style);
        const direction = key === "ArrowLeft" ? -1 : 1;
        navigationPreparationMs = win.performance.now() - began;
        eachRange(capture, "grapheme", (range, done) => {
            const point = navigation.horizontalPoint(capture.buffer, range, direction, extend);
            if (point) {
                done(moved(range, point.offset, extend, point.affinity));
                return;
            }
            if (!extend && range.anchor !== range.head) { done(moved(range, direction < 0 ? Math.min(range.anchor, range.head) : Math.max(range.anchor, range.head), false)); return; }
            withGraphemes(capture, range.head, direction, "grapheme", at => done(moved(range, direction < 0 ? at.preceding ?? range.head : at.following ?? range.head, extend)), navigationTurn);
        }, ranges => finishRanges(capture, ranges), { validLayout: () => navigationLayout() === layout, navigation: true, inline });
        }, shortHorizontal);
        return true;
    }
    function vertical(direction: -1 | 1, page: boolean, extend: boolean, add = false): boolean {
        prepareMovement();
        beginNavigation((capture, style, inline) => {
        const began = win.performance.now(); viewport.flush();
        const buffer = capture.buffer, selected = capture.selection;
        if (!viewport.coordsAt(selected.head, selected.headAffinity)) { revealCaret(selected); viewport.flush(); }
        if (!validCommand(capture) || navigationStyle() !== style) { cancelWord(); return; }
        const state = viewport.getSnapshot(), layout = navigationLayout(style);
        const prior = preferred?.selections === capture.selectionSet && preferred.revision === capture.revision && preferred.layout === layout ? preferred.columns : undefined;
        const columns: (VisualColumns | undefined)[] = [], count = verticalCount(page);
        navigationPreparationMs = win.performance.now() - began;
        let index = 0, pageDelta = 0;
        eachRange(capture, "grapheme", (range, done) => {
            const at = index++, line = buffer.lineAt(range.head), row = navigation.visualRowAt(line), next = navigation.navigationLine(line, direction, count, page);
            if (at === capture.selectionSet.primary) pageDelta = (navigation.visualRowAt(next) - row) * state.lineHeight;
            if (next === line) { columns.push(prior?.[at]); done(add ? range : moved(range, direction < 0 ? 0 : buffer.length, extend)); return; }
            const previous = prior?.[at], column = previous?.head ?? navigation.columnAt(range.head, range.headAffinity);
            const hit = column === undefined ? undefined : navigation.caretAtColumn(next, column);
            // Both ends can clamp to the same caret on a short row. Keep their goals for the next copy.
            if (add && (range.head !== range.anchor || previous?.anchor !== undefined)) {
                const anchorLine = buffer.lineAt(range.anchor), targetLine = navigation.navigationLine(anchorLine, direction, count, page);
                const anchor = previous?.anchor ?? navigation.columnAt(range.anchor, range.anchorAffinity);
                const anchorHit = anchor !== undefined && targetLine !== anchorLine ? navigation.caretAtColumn(targetLine, anchor) : undefined;
                columns.push({ head: column, anchor });
                done(hit && anchorHit ? { head: hit.offset, headAffinity: hit.affinity, anchor: anchorHit.offset, anchorAffinity: anchorHit.affinity } : range);
            } else {
                columns.push({ head: column }); done(hit ? moved(range, hit.offset, extend, hit.affinity) : range);
            }
        }, destinations => {
            if (page) viewport.scrollTo({ top: state.scrollTop + pageDelta });
            const ranges = add ? [...capture.selectionSet.ranges, ...destinations] : destinations;
            const primary = capture.selectionSet.primary + (add ? destinations.length : 0);
            const selections = finishRanges(capture, ranges, undefined, primary); if (!selections) return;
            // Normalization may reorder/coalesce targets. Carry the owning range's column,
            // using the same primary/first-supplied ownership as the public selection model.
            const ordered = ranges.map((range, at) => ({ from: Math.min(range.anchor, range.head), to: Math.max(range.anchor, range.head), at }))
                .sort((a, b) => a.from - b.from || a.to - b.to || a.at - b.at);
            let cursor = 0;
            const nextColumns = selections.ranges.map(range => {
                const from = Math.min(range.anchor, range.head), to = Math.max(range.anchor, range.head); let ownerIndex = Infinity;
                while (cursor < ordered.length && ordered[cursor]!.from >= from && ordered[cursor]!.to <= to) {
                    const at = ordered[cursor++]!.at;
                    if (at === primary || ownerIndex !== primary && at < ownerIndex) ownerIndex = at;
                }
                return columns[ownerIndex % columns.length];
            });
            preferred = { selections, revision: capture.revision, layout, columns: nextColumns };
        }, { validLayout: () => navigationLayout() === layout, navigation: true, inline, ...(capture.selectionSet.ranges.length > 1 ? {
            ...(capture.selectionSet.ranges.length <= commandBudget.inlineRanges ? { batchSize: commandBudget.shortRangeBatch } : {}),
            prepare: (ranges: readonly Selection[]) => navigation.prepareNavigationRows([...verticalRows(buffer, ranges, add,
                line => navigation.navigationLine(line, direction, count, page))]) } : {}) });
        }, capture => shortVertical(capture, direction, page, add));
        return true;
    }
    function languageCommand(command: EditingCommand | Readonly<{ character: string }>): boolean {
        if (disposed || composing || input.disabled || input.readOnly) return false;
        if ((command === "line-comment" || command === "add-line-comment" || command === "remove-line-comment") && !language.lineComment
            || command === "block-comment" && !language.blockComment) return false;
        cancelWord(); syncSelection();
        const capture = commandCapture(true), overtyped: number[] = [];
        const folds = typeof command === "string" && command !== "newline" && command !== "block-comment"
            ? view.folding.getSnapshot().index : undefined;
        const opening = typeof command === "object" ? language.pairs.find(pair => pair.open === command.character) : undefined;
        const planner = planLanguageEdit(capture.buffer, capture.selectionSet, typeof command === "string" ? command : {
            character: command.character, canOvertype: at => {
                if (!paired.has(at)) return false;
                overtyped.push(at); return true;
            },
        }, language, folds);
        const acceptPairs = (edits: readonly TextEdit[]) => paired.accept(workspace.document(documentId), capture.revision, edits, capture.selectionSet, opening, overtyped);
        let planning = false;
        const job = { capture, purpose: "grapheme" as const, release: () => { if (!planning) planner.dispose(); } }; rangeCommand = job;
        const step = () => commandTurn(() => {
            if (rangeCommand !== job) return;
            if (!validCommand(capture) || folds && !folds.sameProjection(view.folding.getSnapshot().index)) { cancelWord(); return; }
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
                const autoIndent = language.enter !== undefined && (command === "newline" || command === "insert-line-above" || command === "insert-line-below");
                if (plan.edits.length) return apply(plan.edits, plan.selectionSet, typeof command === "object" ? "typing" : "replace", {
                    expectedRevision: capture.revision, adjustNewlines: autoIndent, typedText: typeof command === "object" ? command.character : undefined,
                    accepted: autoIndent ? edits => automaticIndent.remember(workspace.document(documentId), edits, plan.edits)
                        : typeof command === "object" ? acceptPairs : undefined });
                if (overtyped.length) acceptPairs(plan.edits);
                group = undefined;
                if (!view.setSelections(capture.revision, plan.selectionSet.ranges, plan.selectionSet.primary)) return false;
                revealCaret(); refresh();
                if (overtyped.length && typeof command === "object") dispatchTypedText(root, view.getSnapshot(), command.character);
                return true;
            });
        }, typeof command === "object" ? command.character : "");
        group = undefined; step(); return true;
    }
    function runCommand(command: TextEditorCommand): boolean {
        if (disposed || composing || input.disabled || !live()) return false;
        switch (command) {
            case "undo": case "redo": return history(command);
            case "move-left": case "select-left": return horizontal("ArrowLeft", command === "select-left");
            case "move-right": case "select-right": return horizontal("ArrowRight", command === "select-right");
            case "move-up": case "select-up": return vertical(-1, false, command === "select-up");
            case "move-down": case "select-down": return vertical(1, false, command === "select-down");
            case "move-page-up": case "select-page-up": return vertical(-1, true, command === "select-page-up");
            case "move-page-down": case "select-page-down": return vertical(1, true, command === "select-page-down");
            case "delete-backward": return deleteGrapheme(-1);
            case "delete-forward": return deleteGrapheme(1);
            case "move-word-backward": return word(-1, false);
            case "move-word-forward": return word(1, false);
            case "select-word-backward": return word(-1, false, true);
            case "select-word-forward": return word(1, false, true);
            case "delete-word-backward": return word(-1, true);
            case "delete-word-forward": return word(1, true);
            case "move-to-line-start": return moveToBoundary("Home", false);
            case "move-to-line-end": return moveToBoundary("End", false);
            case "select-to-line-start": return moveToBoundary("Home", true);
            case "select-to-line-end": return moveToBoundary("End", true);
            case "move-to-document-start": return moveToBoundary("Home", false, true);
            case "move-to-document-end": return moveToBoundary("End", false, true);
            case "select-to-document-start": return moveToBoundary("Home", true, true);
            case "select-to-document-end": return moveToBoundary("End", true, true);
            case "select-all":
                hostInsertion?.cancel(); cancelWord(); group = undefined; preferred = undefined;
                view.folding.revealSelection(view.folding.getSnapshot());
                view.setSelection(revision, { anchor: 0, head: workspace.document(documentId).buffer.length });
                refresh(); return true;
            case "go-to-line": {
                const prompt = options.requestLine;
                if (!prompt) return false;
                cancelLineRequest(); cancelWord(); syncSelection(); group = undefined; preferred = undefined;
                const capture = commandCapture(false), { buffer } = capture;
                const request = lineRequest = { capture, abort: new AbortController() };
                const finish = async () => {
                    try {
                        const line = await prompt({ currentLine: buffer.lineAt(capture.selection.head) + 1, lineCount: buffer.lineCount, signal: request.abort.signal });
                        if (request !== lineRequest || !validCommand(capture) || !root.isConnected || !workspace.ownsDocumentView(view)) return;
                        if (line === undefined || !isPositiveInteger(line) || line > buffer.lineCount) return;
                        lineRequest = undefined;
                        reveal({ line: line - 1, column: 0 }, { align: "center-if-outside", select: true, focus: true, expectedRevision: capture.revision });
                    } catch (error) {
                        if (!request.abort.signal.aborted) conflict("command-failed", undefined, capture.revision, 0, "", error);
                    } finally { if (request === lineRequest) lineRequest = undefined; }
                };
                void finish(); return true;
            }
            case "select-next-occurrence": case "select-all-occurrences":
                selectOccurrences(command === "select-all-occurrences"); return true;
            case "add-caret-above": case "add-caret-below":
                return vertical(command === "add-caret-above" ? -1 : 1, false, false, true);
            case "undo-caret": {
                cancelWord(); syncSelection(); group = undefined; preferred = undefined;
                const previous = caretHistory.pop();
                if (previous) {
                    skipCaretHistory = true;
                    try { view.setSelections(revision, previous.ranges, previous.primary); revealCaret(); }
                    finally { skipCaretHistory = false; }
                }
                return true;
            }
            case "jump-to-bracket": {
                cancelWord(); syncSelection(); group = undefined; preferred = undefined;
                const capture = commandCapture(false);
                eachRange(capture, "grapheme", (range, done) => {
                    const cursor = brackets!.navigationCursor(capture.buffer, range.head);
                    const active = () => rangeCommand?.capture === capture && validCommand(capture);
                    const advance = () => commandTurn(() => {
                        const result = commandRunner.slice(() => cursor.next(commandBudget.languageUnits),
                            step => step.status === "running" && active(), commandBudget.graphemeCalls);
                        if (!active()) { cursor.dispose(); return; }
                        if (result.status === "running") {
                            const cancel = commandRunner.schedule(() => { cancelRangeTask = undefined; advance(); });
                            cancelRangeTask = () => { cancel(); cursor.dispose(); };
                            return;
                        }
                        cursor.dispose();
                        const destination = result.result?.match ?? result.result?.next;
                        done(destination == null ? range : moved(range, destination, false));
                    });
                    advance();
                }, ranges => finishRanges(capture, ranges), { navigation: true });
                return true;
            }
            case "select-line": {
                cancelWord(); syncSelection(); group = undefined; preferred = undefined;
                const capture = commandCapture(false), buffer = capture.buffer, folds = view.folding.getSnapshot().index;
                eachRange(capture, "grapheme", (range, done) => {
                    const from = Math.min(range.anchor, range.head), to = Math.max(range.anchor, range.head);
                    const { anchor } = wholeLine(buffer, from, folds);
                    const endsAtStart = from < to && to === buffer.offsetAt(buffer.lineAt(to));
                    const head = endsAtStart && from !== anchor ? to : wholeLine(buffer, to, folds).head;
                    done({ anchor, head });
                }, ranges => finishRanges(capture, ranges), { navigation: true, validLayout: () => folds.sameProjection(view.folding.getSnapshot().index) });
                return true;
            }
            case "scroll-line-up": case "scroll-line-down": case "scroll-page-up": case "scroll-page-down": {
                group = undefined;
                viewport.flush();
                const state = viewport.getSnapshot(), page = command === "scroll-page-up" || command === "scroll-page-down";
                const distance = page ? state.height : state.lineHeight;
                viewport.scrollTo({ top: state.scrollTop + (command.endsWith("-up") ? -distance : distance) });
                return true;
            }
            default: return languageCommand(command);
        }
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
            if (!replaceSelection(action.text, typing ? "typing" : action.type === "insertFromPaste" ? "paste" : "replace", action.type, action.text, action.wholeLines)) {
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
        if (type === "historyUndo" || type === "historyRedo") {
            const stroke = { key: "z", ctrlKey: true, metaKey: false, altKey: false, shiftKey: type === "historyRedo" };
            return captureKey(stroke, historyKey(type === "historyUndo" ? "undo" : "redo"));
        }
        const deletion = nativeDeletion(type);
        if (deletion) {
            const stroke = { key: type.endsWith("Backward") ? "Backspace" : "Delete", ctrlKey: type.startsWith("deleteWord"), metaKey: false, altKey: false, shiftKey: false };
            return captureKey(stroke, commandKey(deletion));
        }
    }
    function captureOrderedInput(event: InputEvent): boolean {
        if (composing || event.isComposing || input.disabled || input.readOnly || !inputQueue.pending && !rangeCommand) return false;
        const text = event.inputType === "insertText" || event.inputType === "insertLineBreak" || event.inputType === "insertFromPaste", action = nativeIntent(event.inputType);
        if (!text && !action) return false;
        const pending = inputQueue.ensure(); if (!pending) return false;
        const data = event.inputType === "insertLineBreak" ? "\n" : event.data ?? event.dataTransfer?.getData("text/plain") ?? null;
        if (event.inputType === "insertFromPaste" && event.cancelable && data === "") { event.preventDefault(); return true; }
        const wholeLines = event.inputType === "insertFromPaste" && copiedLines(event.dataTransfer);
        if (event.cancelable && (action || data !== null)) { event.preventDefault(); appendInput(action ?? { kind: "text", text: data!, type: event.inputType, wholeLines }); return true; }
        inputQueue.waitNative(pending);
        nativeOrder = { order: pending, capture: captureInput(event.inputType, event.data, wholeLines), type: event.inputType, data, ...(action ? { action } : {}), invalid: false, reported: false };
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
            appendInput({ kind: "text", text: edit.insert, type: event.inputType, literal: true, wholeLines: native.capture.wholeLines === true });
        else { cancelWord(); conflict("pending-native-input-target", undefined, native.capture.revision, 0, event.data ?? native.data ?? input.value); }
        refresh(); inputQueue.schedule(); return true;
    }
    // Some browsers send native undo to the last edited textarea while a host field has focus.
    function guardNativeHistory(event: Event): void {
        const type = (event as InputEvent).inputType;
        if ((type === "historyUndo" || type === "historyRedo") && !isFocused(input)) {
            if (event.cancelable) event.preventDefault();
            event.stopImmediatePropagation();
            if (event.type === "input") refresh();
        }
    }
    for (const type of ["beforeinput", "input"]) {
        input.addEventListener(type, guardNativeHistory, { capture: true, signal: listeners.signal });
    }
    function beforeInput(event: InputEvent): void {
        hostInsertion?.cancel();
        pendingDeletion = undefined; insertion = undefined;
        if (nativeOrder) { if (!nativeOrder.invalid) cancelWord(); nativeOrder = undefined; }
        if (event.defaultPrevented) return;
        if (input.readOnly) { refuseEdit(event); return; }
        if (captureOrderedInput(event)) return;
        const deletion = nativeDeletion(event.inputType);
        if (!composing && deletion && event.cancelable) { event.preventDefault(); runCommand(deletion); return; }
        if (!composing) view.folding.revealSelection(view.folding.getSnapshot());
        if (!composing && deletion) {
            syncSelection();
            pendingDeletion = { revision, selectionSet: view.getSnapshot().selectionSet, command: deletion };
            return;
        }
        if (!composing && event.cancelable && (event.inputType === "historyUndo" || event.inputType === "historyRedo")) { event.preventDefault(); history(event.inputType === "historyUndo" ? "undo" : "redo"); }
        else syncSelection();
        if (!composing && !event.isComposing && !input.disabled && !input.readOnly && input.value === context.text) {
            if (event.inputType === "insertFromPaste" && event.cancelable) {
                const pasted = event.data ?? event.dataTransfer?.getData("text/plain");
                if (pasted != null) { event.preventDefault(); if (pasted.length) replaceSelection(pasted, "paste", undefined, pasted, copiedLines(event.dataTransfer)); return; }
            }
            if (event.cancelable && configuredInput(event.inputType, event.data)) { event.preventDefault(); return; }
            // Keep the native projection bounded during insertion, not just after input. Browsers
            // may expand a multiline insertText into thousands of native edits before notifying us.
            // Composition and incomplete/noncancelable events retain the captured native path.
            if (event.cancelable && event.inputType === "insertText" && event.data !== null
                && input.value.length - (input.selectionEnd - input.selectionStart) + event.data.length > inputContextUnits) {
                event.preventDefault();
                const text = event.data.replace(/\r\n?/g, "\n"), typing = !text.includes("\n");
                replaceSelection(text, typing ? "typing" : "replace", "insertText");
                return;
            }
            insertion = captureInput(event.inputType, event.data, event.inputType === "insertFromPaste" && copiedLines(event.dataTransfer));
        }
    }
    input.addEventListener("beforeinput", event => { const began = win.performance.now();
        try { beforeInput(event); } finally { beforeInputEvents++; lastBeforeInputMs = win.performance.now() - began; }
    }, { signal: listeners.signal });
    input.addEventListener("input", event => {
        const start = win.performance.now(), type = (event as InputEvent).inputType;
        const captured = pendingDeletion; pendingDeletion = undefined;
        if (commitOrderedInput(event as InputEvent)) { lastInputMs = win.performance.now() - start; inputEvents++; return; }
        const deletion = nativeDeletion(type);
        if (!composing && deletion) {
            if (!captured || captured.command !== deletion || input.disabled || input.readOnly || !live()
                || captured.revision !== revision || captured.selectionSet !== view.getSnapshot().selectionSet) {
                conflict(type.startsWith("deleteWord") ? "stale-word-input" : "stale-delete-input", undefined, captured?.revision);
                refresh();
            }
            else { refresh(); runCommand(deletion); }
        } else commit(type);
        lastInputMs = win.performance.now() - start; inputEvents++;
    }, { signal: listeners.signal });
    function startComposition(): void {
        cancelLineRequest();
        registry.reset();
        escapeState(false);
        hostInsertion?.cancel();
        cancelWord();
        commandRunner.cancel();
        pendingDeletion = undefined;
        insertion = undefined;
        syncSelection();
        view.folding.revealSelection(view.folding.getSnapshot());
        composition = captureInput("insertCompositionText", null);
        composing = true;
        group = undefined;
        inputBinding.setComposing(true);
        publishState();
        scheduleCaret();
    }
    function endComposition(event: CompositionEvent): void {
        const captured = composition;
        composition = undefined;
        composing = false;
        caretLayer.showComposingText("");
        inputBinding.setComposing(false);
        publishState();
        // Cancellation can restore the native text or leave just the selected range erased.
        const target = captured?.target;
        if (event.data === "" && target && (input.value === target.before || resolveNativeInsertion(target, input, target.type)?.insert === "")) refresh();
        else commit("insertCompositionText", captured);
    }
    input.addEventListener("compositionstart", startComposition, { signal: listeners.signal });
    input.addEventListener("compositionupdate", event => { if (composing) caretLayer.showComposingText(event.data); }, { signal: listeners.signal });
    input.addEventListener("compositionend", endComposition, { signal: listeners.signal });
    input.addEventListener("select", syncSelection, { signal: listeners.signal });
    // Tab can reset the browser range after focus dispatch. It changes focus, not model selection.
    input.addEventListener("keyup", event => {
        // A held Shift qualifies the next Tab. Releasing Shift alone consumes the escape.
        if (event.key === "Shift") escapeState(false);
        if (event.key === "Tab") refresh(); else syncSelection();
    }, { signal: listeners.signal });
    input.addEventListener("focus", () => {
        // Dialog dismissal can reset the caret to the start of the textarea. A native select()
        // sets a nonempty range before focusing and must keep that range for the next input.
        if (!composing && !committing && input.selectionEnd === 0 && input.value === context.text) projectSelection();
        publishState(); scheduleCaret();
    }, { signal: listeners.signal });
    input.addEventListener("blur", () => { publishState(); syncSelection(); group = undefined; registry.reset(); scheduleCaret();
        // Clear the Escape prefix after the browser completes focus traversal.
        if (escapeSelection) queueMicrotask(() => { if (!disposed) escapeState(false); }); }, { signal: listeners.signal });
    function keydown(event: KeyboardEvent, captured?: KeyBinding): void {
        const repeatedEscape = event.key === "Escape" && event.repeat;
        if (escapeSelection && event.key !== "Tab" && event.key !== "Shift" && !repeatedEscape) escapeState(false);
        if (event.defaultPrevented || composing || event.isComposing || event.keyCode === 229) return;
        if (["Shift", "Control", "Meta", "Alt"].includes(event.key)) return;
        if (escapeSelection && event.key === "Tab" && !captured) return;
        if (hostInsertion && event.key === "Escape") { hostInsertion.cancel(); event.preventDefault(); return; }
        if (!captured && registry.handleEditor(event, id => {
            const binding = editorKeyCommand(id, event.key);
            if (!binding) return registry.commands.run(id);
            keydown(event, binding);
            return event.defaultPrevented;
        })) return;
        const binding = captured ?? classifyEditingKey(event, apple, pairKey);
        if (binding === "prevent-native") { event.preventDefault(); return; }
        // Host commands check pending input before capturing a document. Editing and
        // navigation supersede a host insertion; ordinary typing reaches beforeInput.
        if (typeof binding === "object") hostInsertion?.cancel();
        if (input.readOnly && event.key !== "Tab") {
            // A read-only textarea suppresses beforeinput for ordinary printable keys.
            const printable = ((!event.ctrlKey && !event.metaKey && !event.altKey) || event.getModifierState("AltGraph"))
                && [...event.key].length === 1;
            if (printable || typeof binding === "object" && binding.edit) { refuseEdit(event); return; }
        }
        if (typeof binding === "object" && binding.command.kind === "command" && binding.command.command === "go-to-line" && !options.requestLine) return;
        if (!inputQueue.draining && (inputQueue.pending || rangeCommand) && event.key !== "Escape") {
            if (typeof binding === "object" && (!binding.edit || !input.readOnly)) { event.preventDefault(); appendInput(captureKey(event, binding)); return; }
            if (!(event.ctrlKey || event.metaKey || event.altKey)) return;
        }
        const command = typeof binding === "object" ? binding.command : undefined;
        if (command?.kind === "command") { if (runCommand(command.command)) event.preventDefault(); return; }
        view.folding.revealSelection(view.folding.getSnapshot());
        if (command || binding === "escape") group = undefined;
        if (command?.kind === "history") { event.preventDefault(); history(command.direction); return; }
        if (binding === "escape") {
            cancelWord(); commandRunner.cancel(); preferred = undefined;
            const state = view.getSnapshot();
            if (state.selectionSet.ranges.length > 1) { event.preventDefault(); view.setSelection(revision, state.selection); refresh(); }
            else if (!event.repeat) escapeState(true);
            return;
        }
        escapeState(false); syncSelection();
        preferred = undefined;
        if (command?.kind === "language" && languageCommand(command.command)) event.preventDefault();
    }
    input.addEventListener("keydown", event => {
        const started = win.performance.now(); keydownEvents++;
        try { keydown(event); } finally { lastKeydownMs = win.performance.now() - started; }
    }, { signal: listeners.signal });
    root.addEventListener("keydown", event => {
        if (event.target !== input && event.target instanceof win.Element && event.target.closest(".st-editor") === root)
            registry.keymap.handle(event);
    }, { signal: listeners.signal });
    function pointerHit(event: MouseEvent, gutterInset = 0) {
        // Pointer capture can retarget a gutter double-click to the root. Scrollbars also target the root.
        if (event.target === root) {
            const bounds = clientBox(root, viewport.settings().minimap, gutterInset);
            if (event.clientX < bounds.left || event.clientX >= bounds.right
                || event.clientY < bounds.top || event.clientY >= bounds.bottom) return undefined;
        }
        const painted = viewport.activity();
        if (painted.revision !== revision || painted.foldGeneration !== view.folding.getSnapshot().generation) viewport.flush();
        return viewport.hitTest(event.clientX, event.clientY);
    }
    let draggedWord = false, foldSummaryClick = false;
    // Expansion removes the label before the next press in the browser's click sequence.
    root.addEventListener("click", event => {
        if (event.detail === 1) foldSummaryClick = (event.target as HTMLElement).dataset?.ornament === "fold";
    }, { capture: true, signal: listeners.signal });
    root.addEventListener("dblclick", event => {
        if (event.button !== 0 || disposed || composing || input.disabled || !live()
            || (event.target as Element | null)?.closest(".st-viewport-gutter")) return;
        const point = pointerHit(event, viewport.getSnapshot().gutterWidth); if (!point) return;
        event.preventDefault(); if (!draggedWord && !foldSummaryClick) selectWord(point.offset, event.altKey);
    }, { signal: listeners.signal });
    const textDrag = mountTextDragDrop({ workspace, tab: target, view, viewport, input,
        available: () => !disposed && !composing && !input.disabled,
        beforeStart: () => { stopDrag(); cancelWord(); commandRunner.cancel(); preferred = undefined; group = undefined; },
        afterDrop: () => { commits++; revealCaret(); focus(); refresh(); },
        rejected: reason => { conflict(reason); refresh(); } });
    let mousePress: { event: PointerEvent; armed: boolean; revision: number; selectionSet: SelectionSet } | undefined;
    root.addEventListener("pointerdown", () => { mousePress = undefined; draggedWord = false; registry.reset(); escapeState(false); }, { capture: true, signal: listeners.signal });
    root.addEventListener("pointerdown", event => {
        if (event.button < 0 || event.button > 2 || disposed || composing || input.disabled || !live()) return;
        const target = event.target as Element | null;
        if (target?.closest(".st-viewport-gutter")) {
            if (event.button === 0 && target.closest(".st-line-numbers span")) beginPointer(event, 1, event, true);
            return;
        }
        const armed = event.button === 0 && textDrag.arm(event);
        // All engines supply the native multi-click count on mousedown. Pointerdown also
        // supplies the pointer id used for capture and arms native drag before default handling.
        if (event.pointerType === "mouse" && event.button === 0) {
            mousePress = { event, armed, revision, selectionSet: view.getSnapshot().selectionSet };
            return;
        }
        if (!armed) beginPointer(event, 1, event);
    }, { signal: listeners.signal });
    root.addEventListener("mousedown", event => {
        const press = mousePress; mousePress = undefined;
        if (!press || event.button !== 0 || event.defaultPrevented) return;
        if (foldSummaryClick && event.detail > 1) { textDrag.disarm(); event.preventDefault(); return; }
        if (press.revision !== revision || press.selectionSet !== view.getSnapshot().selectionSet) { textDrag.disarm(); return; }
        if (press.armed && event.detail < 2) return;
        if (press.armed) textDrag.disarm();
        beginPointer(press.event, event.detail, event);
    }, { signal: listeners.signal });
    function wholeLine(buffer: TextBuffer, offset: number, folds = view.folding.getSnapshot().index): Selection {
        const line = buffer.lineAt(offset), block = collapsedLineBlock(folds, line);
        const next = block?.lineTo ?? line + 1;
        return { anchor: buffer.offsetAt(block?.lineFrom ?? line), head: lineBoundary(buffer, next) };
    }
    function extendPointerUnit(origin: Selection, target: Selection, lineStart?: number): Selection {
        if (target.anchor === lineStart) return origin;
        return target.anchor < origin.anchor ? { anchor: origin.head, head: target.anchor } : { anchor: origin.anchor, head: target.head };
    }
    function beginPointer(event: PointerEvent, clicks: number, native: MouseEvent, gutter = false): void {
        if (disposed || composing || input.disabled || !live()) return;
        // The transparent native context can overlap source text; its default hit test uses context coordinates.
        const point = pointerHit(event); if (!point) return;
        native.preventDefault(); stopDrag(); cancelWord(); preferred = undefined; focus(); group = undefined;
        const state = view.getSnapshot();
        const columns = !gutter && event.pointerType === "mouse"
            && (event.button === 1 && !point.padding || event.button === 0 && event.shiftKey && event.altKey && !event.ctrlKey && !event.metaKey);
        // A modified click needs the original caret until release distinguishes it from a drag.
        let keepSelection = columns;
        if (event.button !== 0) {
            keepSelection = state.selectionSet.ranges.some(({ anchor, head }) =>
                point.offset >= Math.min(anchor, head) && point.offset <= Math.max(anchor, head));
            if (!columns && !keepSelection) {
                view.setSelection(revision, { anchor: point.offset, head: point.offset, anchorAffinity: point.affinity, headAffinity: point.affinity });
                refresh();
            }
            if (!columns) return;
        }
        const extending = !columns && event.shiftKey && !event.altKey;
        const additive = !columns && !gutter && event.altKey;
        if (additive && clicks < 2) {
            const { ranges, primary } = state.selectionSet;
            const hit = ranges.findIndex(range => point.offset >= Math.min(range.anchor, range.head) && point.offset <= Math.max(range.anchor, range.head));
            if (hit >= 0) {
                if (ranges.length > 1) {
                    const remaining = ranges.filter((_, i) => i !== hit);
                    const next = hit < primary ? primary - 1 : Math.min(primary, remaining.length - 1);
                    view.setSelections(revision, remaining, next); refresh();
                }
                return;
            }
        }
        let origin = extending ? pointerOrigin : undefined;
        let anchor = extending ? state.selection.anchor : point.offset, head = point.offset;
        let anchorAffinity = extending ? state.selection.anchorAffinity ?? "after" : point.affinity;
        if (origin && !gutter) {
            const backward = point.offset < origin.anchor;
            anchor = backward ? origin.head : origin.anchor;
            anchorAffinity = backward ? "before" : "after";
            if (!backward) head = Math.max(head, origin.head);
        }
        const baseRanges = additive ? state.selectionSet.ranges : extending ? state.selectionSet.ranges.filter((_, index) => index !== state.selectionSet.primary) : [];
        let unit: DragUnit | undefined;
        if (columns) {
            const line = workspace.document(documentId).buffer.lineAt(point.offset);
            unit = { kind: "column", middle: event.button === 1, originRow: view.folding.getSnapshot().index.rowAt(line),
                anchorColumn: dragColumn(event.clientX, dragBounds()) };
        } else if (clicks >= 4) {
            view.setSelection(revision, { anchor: 0, head: workspace.document(documentId).buffer.length }); refresh(); return;
        } else if (gutter || clicks === 3) {
            const buffer = workspace.document(documentId).buffer, target = wholeLine(buffer, point.offset);
            origin = gutter && extending ? origin ?? { anchor, head: anchor } : target;
            const lineStart = origin === target ? target.anchor : wholeLine(buffer, origin.anchor).anchor;
            unit = { kind: "line", range: origin, lineStart };
            ({ anchor, head } = extendPointerUnit(origin, target, lineStart));
        } else if (clicks === 2) unit = { kind: "word", origin: point.offset };
        if (!keepSelection) view.setSelections(revision, [...baseRanges, { anchor, head, anchorAffinity, headAffinity: point.affinity }], baseRanges.length);
        refresh();
        pointerOrigin = origin;
        dragCaretRecorded = state.selectionSet !== view.getSnapshot().selectionSet;
        const padding = point.padding === true && !columns;
        if (padding) viewport.revealOffset(point.offset, { horizontal: "nearest", vertical: "nearest", affinity: point.affinity });
        drag = { pointer: event.pointerId, anchor, anchorAffinity, revision, x: event.clientX, y: event.clientY,
            selectionSet: view.getSnapshot().selectionSet, baseRanges, padding, ...(unit ? { unit } : {}) };
        root.setPointerCapture(event.pointerId);
    }
    root.addEventListener("pointermove", event => {
        if (drag?.pointer !== event.pointerId) return;
        const buttonMask = drag.unit?.kind === "column" && drag.unit.middle ? 4 : 1;
        if (!(event.buttons & buttonMask) || !validDrag()) { stopDrag(); return; }
        drag = { ...drag, x: event.clientX, y: event.clientY }; updateDragHead(); dragScrolling.schedule();
    }, { signal: listeners.signal });
    function validDrag(): boolean {
        return !!drag && !disposed && !composing && !input.disabled && root.isConnected && root.clientWidth > 0 && root.clientHeight > 0
            && drag.revision === revision && drag.selectionSet === view.getSnapshot().selectionSet && live() && root.hasPointerCapture(drag.pointer);
    }
    function dragBounds() {
        return clientBox(root, viewport.settings().minimap, viewport.getSnapshot().gutterWidth);
    }
    function dragColumn(x: number, bounds: ReturnType<typeof dragBounds>): number {
        return viewport.getSnapshot().scrollLeft + (Math.max(bounds.left, Math.min(bounds.right - 1, x)) - bounds.left) / bounds.zoom;
    }
    function updateColumnDrag(unit: ColumnDrag, localY: number, column: number, released: boolean): void {
        if (inputQueue.pending) return;
        const capture = commandCapture(false), folds = view.folding.getSnapshot().index;
        const targetRow = () => folds.rowAt(navigation.columnDragLine(localY, folds.lineAt(unit.originRow)));
        let row = targetRow();
        if (!unit.projection && row === unit.originRow && Math.abs(unit.anchorColumn - column) < 2) {
            if (!released || unit.middle) return;
            const { head, headAffinity } = capture.selection;
            const anchorColumn = navigation.columnAt(head, headAffinity);
            if (anchorColumn === undefined) return;
            unit.originRow = folds.rowAt(capture.buffer.lineAt(head));
            unit.anchorColumn = anchorColumn;
            row = targetRow();
        }
        const direction = row < unit.originRow ? -1 : 1;
        const count = Math.abs(row - unit.originRow) + 1, layout = navigationLayout();
        let projection = unit.projection;
        if (!projection || projection.layout !== layout || projection.direction !== direction || projection.column !== column) {
            projection = { layout, direction, column, ranges: [], count: 0 }; unit.projection = projection;
        }
        if (projection.count === count) return;
        cancelWord(); projection.count = count;
        // Extending down the same columns only measures newly crossed rows.
        const ranges = projection.ranges;
        const job = { capture, purpose: "column" as const, release: () => {} }; rangeCommand = job;
        const step = () => commandTurn(() => {
            if (rangeCommand !== job) return;
            if (!validCommand(capture) || !root.isConnected || navigationLayout() !== layout) { cancelWord(); return; }
            const more = commandRunner.slice(() => {
                if (ranges.length >= count) return false;
                const line = folds.lineAt(unit.originRow + direction * ranges.length);
                const range = navigation.selectionAtColumns(line, unit.anchorColumn, column);
                if (!range) { cancelWord(); return false; }
                ranges.push(range);
                return ranges.length < count;
            }, pending => pending, commandBudget.rangeCalls);
            if (rangeCommand !== job) return;
            if (more) { cancelRangeTask = commandRunner.schedule(step); return; }
            cancelRangeTask = undefined; rangeCommand = undefined;
            completeCaptured(capture, () => {
                // A long drag can finish after pointerup. It still has one caret-history entry.
                skipCaretHistory = dragCaretRecorded;
                const crossed = ranges.slice(0, count), reached = crossed.filter(range => range.reaches);
                const selected = reached.length ? reached : crossed;
                try { view.setSelections(capture.revision, selected, selected.length - 1); }
                finally { skipCaretHistory = false; }
                if (drag?.unit === unit) drag = { ...drag, selectionSet: view.getSnapshot().selectionSet };
                refresh(); return true;
            });
        });
        step();
    }
    function updateDragHead(released = false): void {
        const current = drag; if (!current) return; const bounds = dragBounds();
        const unit = current.unit, y = Math.max(bounds.top, Math.min(bounds.bottom - 1, current.y));
        if (unit?.kind === "column") {
            updateColumnDrag(unit, (y - bounds.top) / bounds.zoom, dragColumn(current.x, bounds), released);
            return;
        }
        const point = viewport.hitTest(Math.max(bounds.left, Math.min(bounds.right - 1, current.x)), y);
        if (!point || drag !== current) return;
        if (unit) {
            if (unit.lastHit === point.offset) return;
            unit.lastHit = point.offset;
            const applyUnits = (origin: Selection, target: Selection) => {
                const range = extendPointerUnit(origin, target, unit.kind === "line" ? unit.lineStart : undefined);
                view.setSelections(current.revision, [...current.baseRanges, range], current.baseRanges.length);
                if (drag?.unit === unit) drag = { ...drag, selectionSet: view.getSnapshot().selectionSet, padding: point.padding === true };
                pointerOrigin = origin;
                refresh();
            };
            if (unit.kind === "line") { applyUnits(unit.range, wholeLine(workspace.document(documentId).buffer, point.offset)); return; }
            draggedWord = true; cancelWord();
            const capture = commandCapture(false);
            rangeCommand = { capture, purpose: "word", release: () => {} };
            const extendWord = (origin: Selection = { anchor: unit.origin, head: unit.origin }) => {
                unit.range = origin;
                const finish = (target: Selection = { anchor: point.offset, head: point.offset }) => {
                    rangeCommand = undefined;
                    completeCaptured(capture, () => { applyUnits(origin, target); return true; });
                };
                if (point.offset >= origin.anchor && point.offset < origin.head) finish(origin);
                else wordRange(capture, point.offset, finish);
            };
            if (unit.range) extendWord(unit.range); else wordRange(capture, unit.origin, extendWord);
            return;
        }
        view.setSelections(current.revision, [...current.baseRanges, { anchor: current.anchor, head: point.offset, anchorAffinity: current.anchorAffinity, headAffinity: point.affinity }], current.baseRanges.length);
        if (drag === current) drag = { ...current, selectionSet: view.getSnapshot().selectionSet, padding: point.padding === true }; refresh();
    }
    const dragScrolling = createEdgeAutoscroll(win, viewport, {
        capture: () => drag, valid: () => validDrag(),
        velocity: captured => {
            const velocity = edgeVelocity(captured, dragBounds(), viewport.getSnapshot(), "outside");
            return captured.unit?.kind === "line" ? { x: 0, y: velocity.y } : velocity;
        },
        update: () => updateDragHead(), cancel: () => stopDrag(),
    });
    const stopDrag = (event?: PointerEvent) => {
        if (event && event.pointerId === mousePress?.event.pointerId) mousePress = undefined;
        if (event && event.pointerId !== drag?.pointer) return;
        if (drag?.unit?.kind === "column") {
            if (event?.type === "pointerup" && validDrag()) {
                drag = { ...drag, x: event.clientX, y: event.clientY }; updateDragHead(true);
            } else if (event?.type !== "pointerup" && rangeCommand?.purpose === "column") cancelWord();
        }
        if (drag?.unit?.kind === "word" && (event?.type === "pointercancel" || event?.type === "lostpointercapture")) cancelWord();
        dragScrolling.stop();
        const pointer = drag?.pointer, padding = drag?.padding; drag = undefined;
        if (pointer !== undefined && root.hasPointerCapture(pointer)) root.releasePointerCapture(pointer);
        if (event?.type === "pointerup" && padding && !disposed && live()) {
            const selected = view.getSnapshot().selection;
            viewport.revealOffset(selected.head, { horizontal: "nearest", vertical: "nearest", affinity: selected.headAffinity ?? "after" });
        }
    };
    root.addEventListener("pointerup", stopDrag, { signal: listeners.signal }); root.addEventListener("pointercancel", stopDrag, { signal: listeners.signal });
    root.addEventListener("lostpointercapture", stopDrag, { signal: listeners.signal });
    function canCaptureInsertion(): boolean {
        return !disposed && root.isConnected && !readOnly && !input.disabled && !input.readOnly && !composing
            && !inputQueue.pending && !inputQueue.executing && !rangeCommand && !wordJob && !graphemeJob && !insertion && !drag;
    }
    for (const type of ["copy", "cut", "paste"] as const) input.addEventListener(type, event => {
        if (event.defaultPrevented) { cancelWord(); group = undefined; if (type !== "copy") stopDrag(); return; }
        if (input.disabled || composing || !event.clipboardData) return;
        if (type === "paste" && !event.cancelable) return;
        if (type !== "copy" && input.readOnly) { refuseEdit(event); return; }
        if (type === "paste" && (inputQueue.pending || rangeCommand) && !input.disabled && !input.readOnly) {
            event.preventDefault(); stopDrag();
            const text = event.clipboardData.getData("text/plain");
            if (text.length) appendInput({ kind: "text", text, type: "insertFromPaste", wholeLines: copiedLines(event.clipboardData) });
            return;
        }
        event.preventDefault(); cancelWord(); syncSelection(); group = undefined;
        if (type !== "copy") view.folding.revealSelection(view.folding.getSnapshot());
        const selections = view.getSnapshot().selectionSet;
        if (type === "paste") {
            hostInsertion?.cancel();
            const owner = pasteOwner, data = event.clipboardData;
            const paste = owner && canCaptureInsertion() && notifications.read(() => owner.handler(data));
            if (owner && paste) {
                const capture = editor.captureInsertion();
                if (!capture) return;
                if (owner !== pasteOwner) { capture.cancel(); return; }
                owner.pending = capture;
                try { paste(capture); }
                catch (error) { capture.cancel(); throw error; }
                return;
            }
            const text = data.getData("text/plain");
            if (text.length) replaceSelection(text, "paste", undefined, text, copiedLines(data));
        } else {
            if (type === "cut") hostInsertion?.cancel();
            const buffer = workspace.document(documentId).buffer;
            if (selections.ranges.every(range => range.anchor === range.head)) {
                const lines = copyCaretLines(buffer, selections, type === "cut", view.folding.getSnapshot().index);
                event.clipboardData.setData("text/plain", lines.text);
                event.clipboardData.setData(lineCopyFormat, "1");
                if (lines.edits.length) apply(lines.edits, lines.selectionSet, "delete");
                return;
            }
            event.clipboardData.clearData(lineCopyFormat);
            event.clipboardData.setData("text/plain", selections.ranges.filter(range => range.anchor !== range.head)
                .map(range => buffer.slice(Math.min(range.anchor, range.head), Math.max(range.anchor, range.head))).join("\n"));
            if (type === "cut") replaceSelection("", "delete");
        }
    }, { signal: listeners.signal });
    let observedFoldRevision = view.folding.getSnapshot().revision;
    const caretHistory: SelectionSet[] = [];
    let lastCaret = view.getSnapshot(), skipCaretHistory = false;
    const observeCaret = () => {
        const next = view.getSnapshot();
        pointerOrigin = undefined;
        inferredOccurrence = undefined;
        if (next.revision !== lastCaret.revision) caretHistory.length = 0;
        else if (!skipCaretHistory && (!drag || !dragCaretRecorded) && next.selectionSet !== lastCaret.selectionSet) {
            if (caretHistory.length === 50) caretHistory.shift();
            caretHistory.push(lastCaret.selectionSet);
            if (drag) dragCaretRecorded = true;
        }
        lastCaret = next; refresh();
    };
    const subscriptions = [viewport.onRender(scheduleCaret), source.subscribe(refresh), view.subscribe(observeCaret),
        view.folding.subscribe(() => { const revision = view.folding.getSnapshot().revision;
            if (revision === observedFoldRevision) { cancelWord(); stopDrag(); preferred = undefined; }
            observedFoldRevision = revision; refresh(); }), resource.metadata.subscribe(refresh)];
    if (target) subscriptions.push(workspace.tabs.subscribe(refresh));
    let activitySnapshot: TextEditorActivity | undefined;
    function activity(): TextEditorActivity {
        const pendingInput = hostInsertion !== undefined || inputQueue.pending !== undefined || inputQueue.executing !== undefined || rangeCommand?.capture.deleting === true;
        const pendingCommand = rangeCommand !== undefined || wordJob !== undefined || graphemeJob !== undefined;
        const pendingCaret = caretLayer.pending(), pendingDragScroll = dragScrolling.pending();
        const pendingWord = rangeCommand?.purpose === "word" || wordJob !== undefined || graphemeJob?.purpose === "word" || inputQueue.pending?.purpose === "word";
        const pendingGrapheme = rangeCommand?.purpose === "grapheme" || graphemeJob !== undefined || inputQueue.pending?.purpose === "grapheme";
        if (activitySnapshot && activitySnapshot.disposed === disposed && activitySnapshot.composing === composing
            && activitySnapshot.pendingInput === pendingInput && activitySnapshot.pendingCommand === pendingCommand
            && activitySnapshot.pendingCaret === pendingCaret && activitySnapshot.pendingDragScroll === pendingDragScroll
            && activitySnapshot.pendingWord === pendingWord && activitySnapshot.pendingGrapheme === pendingGrapheme) return activitySnapshot;
        return activitySnapshot = Object.freeze({ disposed, composing, pendingInput, pendingCommand, pendingCaret, pendingDragScroll, pendingWord, pendingGrapheme });
    }
    refresh();
    brackets = mountBracketHighlights(workspace, target, view, viewport, input, () => language,
        () => { const state = activity(); return !state.disposed && !state.composing && !state.pendingInput && !state.pendingCommand; }, bracketOptions);
    warnings = mountCharacterWarnings(workspace, target, view, viewport, warningOptions);
    let cachedSettings: ResolvedEditorSettings | undefined, cachedViewport: ViewportSettings | undefined;
    const settings = (): ResolvedEditorSettings => {
        const presentation = viewport.settings();
        if (cachedSettings && cachedViewport === presentation) return cachedSettings;
        cachedViewport = presentation;
        return cachedSettings = Object.freeze({ ...presentation, language, pasteLineEndings, bracketMatching: bracketOptions,
            characterWarnings: warningOptions?.configuration ?? false });
    };
    const editor: TextEditor = Object.freeze({ element: root, workspace, tab: target, signal: listeners.signal, view, viewport, decorations: viewport.decorations, focus, activity, bracketMatching: brackets.handle, characterWarnings: warnings.handle,
        getSnapshot: editorState.observable.getSnapshot,
        subscribe(listener: () => void) {
            if (disposed) throw new Error("Editor is disposed.");
            const unsubscribe = editorState.observable.subscribe(listener);
            const stop = () => { unsubscribe(); stateSubscriptions.delete(stop); };
            stateSubscriptions.add(stop); return stop;
        },
        captureInsertion: (kind = "paste") => {
            hostInsertion?.cancel();
            if (!canCaptureInsertion()) return;
            syncSelection(); view.folding.revealSelection(view.folding.getSnapshot());
            let captured: CapturedInsertion | undefined;
            captured = captureInsertion(workspace, target, view, canCaptureInsertion, (plan, expected) => apply(plan.edits, plan.selectionSet, kind, { expectedRevision: expected }),
                () => { if (hostInsertion === captured) hostInsertion = undefined;
                    if (pasteOwner && pasteOwner.pending === captured) delete pasteOwner.pending; });
            hostInsertion = captured; return captured;
        },
        onEditIntent(listener, signal) {
            const lifetime = signal ? AbortSignal.any([listeners.signal, signal]) : listeners.signal;
            const notify = (event: Event) => listener(event.type as EditorEditIntent);
            for (const kind of editIntents) input.addEventListener(kind, notify, { capture: true, signal: lifetime });
            return { dispose() { for (const kind of editIntents) input.removeEventListener(kind, notify, true); } };
        },
        registerPasteHandler(handler: EditorPasteHandler) {
            notifications.assertWritable();
            if (disposed || pasteOwner) throw new Error("Editor is disposed or already owns a paste handler.");
            const owner: PasteOwner = { handler }; pasteOwner = owner;
            return () => {
                if (pasteOwner !== owner) return;
                notifications.assertWritable(); pasteOwner = undefined;
                const capture = owner.pending; delete owner.pending; capture?.cancel();
            };
        },
        commands: registry.commands, keymap: registry.keymap,
        settings,
        configure: changes => {
            if (disposed || composing && changes.language !== undefined) return false;
            const nextLanguage = changes.language === undefined ? language : resolveLanguageConfiguration(changes.language);
            const nextPaste = changes.pasteLineEndings === undefined ? pasteLineEndings : pastePolicy(changes.pasteLineEndings);
            const nextBrackets = changes.bracketMatching === undefined ? bracketOptions : matching(changes.bracketMatching);
            const nextWarnings = changes.characterWarnings === undefined ? warningOptions : classifyWarnings(changes.characterWarnings);
            if (!viewport.configure(changes)) return false;
            const languageChanged = nextLanguage !== language;
            if (languageChanged || nextPaste !== pasteLineEndings) hostInsertion?.cancel();
            if (languageChanged) {
                registry.reset();
                if (language.pairs.length !== nextLanguage.pairs.length || language.pairs.some((pair, i) =>
                    pair.open !== nextLanguage.pairs[i]!.open || pair.close !== nextLanguage.pairs[i]!.close)) paired.clear();
                cancelWord(); group = undefined; preferred = undefined;
            }
            if (languageChanged || nextPaste !== pasteLineEndings || nextWarnings !== warningOptions || nextBrackets !== bracketOptions)
                cachedSettings = undefined;
            language = nextLanguage; pasteLineEndings = nextPaste;
            const warningsChanged = nextWarnings !== warningOptions;
            bracketOptions = nextBrackets; warningOptions = nextWarnings;
            if (warningsChanged) warnings!.configure(nextWarnings);
            if (languageChanged) { root.style.tabSize = String(language.tabSize); viewport.invalidate(); refresh(); }
            if (changes.bracketMatching !== undefined) brackets!.configure(nextBrackets);
            if (languageChanged) brackets!.refresh();
            return true;
        },
        registerEditTransform: transform => {
            if (disposed || editTransform) throw new Error("Editor is disposed or already owns an edit planner.");
            editTransform = transform; return () => { if (editTransform === transform) editTransform = undefined; };
        },
        reveal,
        captureView: () => { syncSelection(); return viewport.captureView(); },
        restoreView: (state, options) => { const result = viewport.restoreView(state, options); if (result) refresh(); return result; },
        getDiagnostics: () => Object.freeze({ ...activity(), inputUnits: input.value.length, inputEvents, lastInputMs, beforeInputEvents, lastBeforeInputMs, maxQueuedInputTurnMs, keydownEvents, lastKeydownMs, navigationTurns, navigationPreparationMs, maxNavigationTurnMs, navigationWorkMs,
            commits, conflicts, queuedInputUnits: inputQueue.pending?.units ?? 0 }),
        dispose: () => {
            if (disposed) return;
            notifications.assertWritable(); disposed = true; activitySnapshot = undefined; editTransform = undefined;
            cancelLineRequest();
            registry.dispose(); brackets!.dispose(); paired.clear(); automaticIndent.clear();
            caretHistory.length = 0;
            pointerOrigin = undefined; mousePress = undefined;
            warnings!.dispose();
            hostInsertion?.cancel();
            pasteOwner = undefined;
            if (inputQueue.executing) inputQueue.recover(inputQueue.executing, "pending-input-detached");
            cancelWord();
            nativeOrder = undefined; pendingDeletion = undefined;
            insertion = undefined; composition = undefined;
            graphemeCache = undefined; preferred = undefined; contextBuffer = undefined;
            if (composing && input.value !== context.text) conflict("composition-detached");
            composing = false;
            publishState();
            for (const stop of stateSubscriptions) stop();
            stopDrag();
            textDrag.dispose();
            caretLayer.dispose();
            commandRunner.cancel();
            listeners.abort();
            subscriptions.forEach(unsubscribe => unsubscribe());
            input.value = "";
            inputBinding.dispose();
            viewport.dispose(); cachedSettings = undefined; language = resolveLanguageConfiguration();
            warningOptions = undefined; bracketOptions = false; pasteLineEndings = "local";
            if (!options.view) view.dispose();
        } });
    return Object.freeze({ editor, input, setComparisonRows, commandScope: registry.scope });
}
