import { done, refused, stale, type Outcome } from "../core/outcome.ts";
import { resolveControlStrings, type ControlStrings } from "./control-strings.ts";
import { listenUntil } from "./listen.ts";
import { invalidType, invalidRange, isNonNegativeInteger, isPositiveInteger } from "../core/bounds.ts";
import { mountInputCaret } from "./input-caret.ts";
import { autoClosedPairs } from "./auto-closed-pairs.ts";
import { automaticIndentation } from "./automatic-indentation.ts";
import { createVerticalMovement, moved, type VisualColumns } from "./caret-navigation.ts";
import { clientBox, cssZoom } from "./dom-coordinates.ts";
import { isFocused } from "./dom-focus.ts";
import { Store, type Observable, type ObservableListener } from "../core/observable.ts";
import { textDifference } from "../core/changes.ts";
import { copyCaretLines, planClipboardPaste } from "../core/clipboard-edits.ts";
import { collapsedLineBlock } from "../core/folding.ts";
import { isCodeWordBase, wordBoundary, wordCommandOffset } from "../core/words.ts";
import { graphemeBoundaries, pointAtBoundaries } from "../core/graphemes.ts";
import { createSelectionSet, normalizeSelectionSet, planSelectionEdits, sameSelectionSet } from "../core/selections.ts";
import { selectionOccurrences } from "../core/selection-occurrences.ts";
import type { Affinity } from "../core/positions.ts";
import type { DocumentId, DocumentView, DocumentViewSnapshot, Workspace } from "../core/workspace.ts";
import type { EditKind, Selection } from "../core/history.ts";
import type { SelectionSet } from "../core/selections.ts";
import type { BufferPosition, TextBuffer } from "../core/text-buffer.ts";
import type { TextEdit } from "../core/changes.ts";
import type { ViewState } from "./view-state.ts";
import { inputContext, inputContextUnits } from "./input-context.ts";
import { localAsciiGraphemePoint } from "../core/grapheme-point.ts";
import type { GraphemePoint } from "../core/grapheme-point.ts";
import { captureNativeInsertion, resolveNativeInsertion } from "./input-target.ts";
import type { NativeInsertionTarget } from "./input-target.ts";
import type { InputContext } from "./input-context.ts";
import { dispatchTypedText, editRefusedEvent, humanEditRefusal, inputConflictEvent } from "./input-events.ts";
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
import { builtinKeyPriority, createCommandRegistry, isModifierKey, type EditorCommand, type EditorCommands, type EditorKeymap } from "./command-registry.ts";
import { defaultEditorShortcuts, editCommand, editorCommandLabels, editorKeyCommand } from "./editor-commands.ts";
import { classifyEditingKey, isDeletionCommand, nativeDeletion } from "./editing-keys.ts";
import type { DeletionCommand, KeyBinding, ViewCommand } from "./editing-keys.ts";
import { createEdgeAutoscroll, edgeVelocity } from "./edge-autoscroll.ts";
function typingRun(text: string): "word" | "space" | "mixed" {
    if (!text || /[\r\n\t]/.test(text)) return "mixed";
    return !text.includes(" ") ? "word" : /^ +$/.test(text) ? "space" : "mixed";
}

export type TextEditorEdit = Readonly<{ expectedRevision: number; edits: readonly TextEdit[]; selectionSet: SelectionSet; kind: EditKind;
    /** The editor's newline command supplied contextual indentation, rather than literal text. */
    adjustNewlines?: boolean }>;
export type TextEditorEditTransform = (edit: TextEditorEdit) => Readonly<{ edits: readonly TextEdit[]; selectionSet: SelectionSet; complete?: (applied: boolean) => void }> | undefined;
export type TextEditorActivity = Readonly<{
    disposed: boolean;
    input: "idle" | "composing" | "host-insertion";
    pendingCaret: boolean;
    pendingDragScroll: boolean;
}>;
/** Input-handler measurements and activity captured when diagnostics are read. */
export type TextEditorDiagnostics = TextEditorActivity & Readonly<{
    inputUnits: number; inputEvents: number; lastInputMs: number; beforeInputEvents: number; lastBeforeInputMs: number;
    keydownEvents: number; lastKeydownMs: number;
    conflicts: number;
}>;
/** The mount’s focus, composition and edit availability. */
export type TextEditorSnapshot = Readonly<{ focused: boolean; disabled: boolean; composing: boolean;
    readOnlyReason: EditRefusedDetail["reason"] | null }>;
export type TextEditorCommand = EditingCommand | ViewCommand | DeletionCommand | "undo" | "redo";
/** Ask the host for a one-based line number and cancel the prompt if its target expires. */
export type LinePrompt = (request: Readonly<{ currentLine: number; lineCount: number; signal: AbortSignal }>) =>
    number | undefined | PromiseLike<number | undefined>;
/** Per-view language rules, drawing options and input preferences accepted by configure. */
export type EditorSettings = Partial<ViewportSettings> & Readonly<{ language?: LanguageConfiguration;
    pasteLineEndings?: "local" | "preserve"; bracketMatching?: boolean | BracketMatchOptions; characterWarnings?: boolean | CharacterWarningOptions }>;
export type ResolvedEditorSettings = ViewportSettings & Readonly<{ language: ResolvedLanguageConfiguration;
    pasteLineEndings: "local" | "preserve"; bracketMatching: false | Required<BracketMatchOptions>; characterWarnings: false | CharacterWarningConfiguration }>;
export type EditorRevealRange = Readonly<{ from: number; to: number }>;
type RevealTarget = BufferPosition | EditorRevealRange | Readonly<{ start: BufferPosition; end: BufferPosition }>;
/** Set scrolling, selection and focus behavior and optionally require a specific revision. */
export type EditorRevealOptions = Readonly<{ align?: RevealAlignment; select?: boolean; focus?: boolean; expectedRevision?: number }>;
/** Choose the retained view, initial settings, read-only mode and Go to Line prompt at mount. */
export type TextEditorOptions = Readonly<{ strings?: ControlStrings; ariaLabel?: string; view?: DocumentView; readOnly?: boolean; requestLine?: LinePrompt; settings?: EditorSettings }>;
/** Read custom formats during the paste event and return a converter for the captured insertion. */
export type EditorPasteHandler = (data: DataTransfer) => ((insertion: CapturedInsertion) => void) | undefined;
const editIntents = ["beforeinput", "compositionstart", "paste", "cut"] as const;
export type EditorEditIntent = typeof editIntents[number];
type PasteOwner = { handler: EditorPasteHandler; pending?: CapturedInsertion };
/** One mounted editor with its own input, viewport, commands and lifetime signal. */
export type TextEditor = Observable<TextEditorSnapshot> & Readonly<{ element: HTMLDivElement; strings: ReturnType<typeof resolveControlStrings>; workspace: Workspace; signal: AbortSignal; view: DocumentView; viewport: TextViewport; decorations: TextViewport["decorations"];
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
    /** Runs registered commands on this mount and reports whether they were accepted. */
    commands: EditorCommands; keymap: EditorKeymap;
    reveal: (target: RevealTarget, options?: EditorRevealOptions) => Outcome<EditorRevealRange>;
    focus: () => void; captureView: () => ViewState; restoreView: TextViewport["restoreView"];
    /** Immutable activity capture, reused while its fields are unchanged. Does not collect metrics. */
    activity: () => TextEditorActivity;
    getDiagnostics: () => TextEditorDiagnostics;
    dispose: () => void }>;
export type MountedTextEditor = Readonly<{ editor: TextEditor; input: HTMLTextAreaElement; setComparisonRows: MountedViewport["setComparisonRows"] }>;

/** Text editor with bounded native input and virtualized rendering. Native IME qualification is separate. */
export function mountTextEditor(host: HTMLElement, workspace: Workspace, documentId: DocumentId,
    options: TextEditorOptions = {}): TextEditor {
    return mountEditor(host, workspace, documentId, options).editor;
}

/** Private pane mount; the comparison capability belongs to this exact editor lifetime. */
export function mountEditor(host: HTMLElement, workspace: Workspace, documentId: DocumentId,
    options: TextEditorOptions = {}, comparison?: ComparisonPresentation & {
        commands: ReadonlyMap<string, EditorCommand>;
        epoch: () => number | undefined;
    }): MountedTextEditor & { commandScope: ReturnType<typeof createCommandRegistry>["scope"] } {
    const initial = options.settings;
    const matching = (value: boolean | BracketMatchOptions) => value === false ? false : bracketMatchLimits(value === true ? {} : value);
    const classifyWarnings = (value: boolean | CharacterWarningOptions) => value === false ? undefined : new CharacterWarnings(value === true ? {} : value);
    const pastePolicy = (value: string) => {
        if (value !== "local" && value !== "preserve") invalidType("paste line-ending policy");
        return value;
    };
    const strings = resolveControlStrings(options.strings);
    let language = resolveLanguageConfiguration(initial?.language);
    let pasteLineEndings: ResolvedEditorSettings["pasteLineEndings"] = pastePolicy(initial?.pasteLineEndings ?? "local");
    let bracketOptions: ResolvedEditorSettings["bracketMatching"] = matching(initial?.bracketMatching ?? false);
    let warningOptions = classifyWarnings(initial?.characterWarnings ?? false);
    const paired = autoClosedPairs();
    const automaticIndent = automaticIndentation();
    const readOnly = options.readOnly === true;
    let readOnlyReason: EditRefusedDetail["reason"] | undefined;
    const resource = workspace.resource(documentId);
    if (options.view && (options.view.documentId !== documentId || !workspace.ownsDocumentView(options.view))) throw new Error("View belongs to a different document or workspace.");
    const view = options.view ?? workspace.createDocumentView(documentId);
    const source = workspace.observeDocument(documentId);
    const currentView = view.getSnapshot;
    const currentFolding = view.folding.getSnapshot;
    const currentDocument = () => workspace.document(documentId);
    const currentSelections = () => currentView().selectionSet;
    const currentFolds = () => currentFolding().index;
    const live = () => workspace.ownsDocumentView(view);
    let mounted: MountedViewport;
    try {
        mounted = mountViewport(host, workspace, documentId, { ...options, view }, comparison);
    } catch (error) {
        if (!options.view) view.dispose();
        throw error;
    }
    const { viewport, bindInput, navigation, setComparisonRows } = mounted;
    let brackets: ReturnType<typeof mountBracketHighlights> | undefined;
    let warnings: ReturnType<typeof mountCharacterWarnings> | undefined;
    const root = viewport.element;
    root.style.tabSize = String(language.tabSize);
    const owner = host.ownerDocument, win = owner.defaultView!, input = owner.createElement("textarea");
    const scope = workspace.allocateIdentity(), listeners = new AbortController();
    const listen = listenUntil(listeners.signal);
    root.classList.add("st-editor");
    input.className = "st-input-context"; input.wrap = "off"; input.spellcheck = false; input.autocomplete = "off";
    // The native projection belongs to the editor, independently of enclosing host forms.
    input.setAttribute("form", "");
    const initialDocument = currentDocument();
    input.setAttribute("aria-label", options.ariaLabel ?? initialDocument.title);
    input.setAttribute("autocapitalize", "off");
    root.append(input);
    let contextBuffer: TextBuffer | undefined = initialDocument.buffer, contextSelection = currentView().selection;
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
        escapeSelection = value ? currentSelections() : undefined;
        root.toggleAttribute("data-st-tab-escape", value);
    };
    let conflicts = 0, serial = 0, inputEvents = 0, lastInputMs = 0;
    let beforeInputEvents = 0, lastBeforeInputMs = 0;
    let keydownEvents = 0, lastKeydownMs = 0;
    let preferred: Readonly<{ selections: SelectionSet; revision: number; layout: string; columns: readonly (VisualColumns | undefined)[] }> | undefined;
    let group: Readonly<{ type: string; revision: number; selectionSet: SelectionSet; tail: ReturnType<typeof typingRun> | "spaces" | undefined; key: string }> | undefined;
    type ColumnDrag = { kind: "column"; middle: boolean; originRow: number; anchorColumn: number; anchorOffset: number; anchorAffinity: Affinity;
        projection?: { layout: string; column: number; direction: -1 | 1; count: number; select: ReturnType<typeof navigation.columnSelections>; ranges: (Selection & { reaches: boolean })[] } };
    type DragUnit = ColumnDrag | (({ kind: "line"; range: Selection; lineStart: number }
        | { kind: "word"; origin: number; range?: Selection }) & { lastHit?: number });
    let drag: Readonly<{ pointer: number; anchor: number; anchorAffinity: Affinity; revision: number; x: number; y: number; selectionSet: SelectionSet; baseRanges: readonly Selection[]; padding: boolean; unit?: DragUnit }> | undefined;
    let columnAnchor: { selections: SelectionSet; revision: number; offset: number; affinity: Affinity;
        column: number; layout: string } | undefined;
    let dragCaretRecorded = false;
    let pointerOrigin: Selection | undefined;
    type CommandCapture = Readonly<{ buffer: TextBuffer; revision: number; selection: Selection; selectionSet: SelectionSet; deleting: boolean }>;
    let lineRequest: { capture: CommandCapture; abort: AbortController } | undefined;
    function cancelLineRequest(): void {
        const request = lineRequest; lineRequest = undefined; request?.abort.abort();
    }
    let graphemeCache: Readonly<{ buffer: TextBuffer; from: number; to: number; boundaries: readonly number[] }> | undefined;
    const lineCopyFormat = "application/x-sttropez-lines";
    const copiedLines = (data: DataTransfer | null) => data?.getData(lineCopyFormat) === "1";
    type InputCapture = Readonly<{ revision: number; selectionSet: SelectionSet; context: InputContext; target?: NativeInsertionTarget; wholeLines?: boolean }>;
    let pendingDeletion: Readonly<{ revision: number; selectionSet: SelectionSet; command: DeletionCommand }> | undefined;
    let insertion: InputCapture | undefined, composition: InputCapture | undefined;
    let projectedSet = currentSelections();
    const apple = /Mac|iPhone|iPad|iPod/.test(win.navigator.platform);
    const registry = createCommandRegistry(apple,
        () => !disposed && !composing && !input.disabled && live() && (!comparison || comparison.epoch() !== undefined), () => {
            const version = revision, selection = currentSelections(), epoch = comparison?.epoch();
            return () => version === revision && selection === currentSelections() && epoch === comparison?.epoch();
        }, () => editor, comparison?.commands, (id, fallback) => strings.commandLabel?.(id, fallback) ?? strings.text(fallback));
    listen(win, "keyup", registry.releaseKey, { capture: true });
    listen(win, "blur", () => registry.releaseKey());
    for (const [id, label] of editorCommandLabels) {
        registry.commands.register({ id, label, owner: "editor", category: "Editing", run: () => runCommand(id), enabled: () => {
            if (id === "undo" || id === "redo") {
                const depth = workspace.observeHistory(documentId).getSnapshot();
                return !input.readOnly && (id === "undo" ? depth.undoDepth : depth.redoDepth) > 0;
            }
            if (id === "go-to-line") return !!options.requestLine;
            if (isDeletionCommand(id)) return !input.readOnly;
            if (!editCommand(id)) return true;
            return !input.readOnly && hasCommentSyntax(id);
        } });
    }
    for (const [keys, command] of apple ? defaultEditorShortcuts.apple : defaultEditorShortcuts.standard) {
        registry.keymap.bind(keys, command, { priority: builtinKeyPriority.editor });
    }
    const caretLayer = mountInputCaret(root, input, view, viewport,
        source.getSnapshot, () => composing);
    const scheduleCaret = caretLayer.schedule;
    function refresh(): void {
        if (escapeSelection && escapeSelection !== currentSelections()) escapeState(false);
        if (disposed || selecting || committing) return;
        const state = resource.getSnapshot(), disabled = !live() || state.state !== "ready";
        if (disabled) contextBuffer = undefined;
        const reason = readOnly ? "read-only" : humanEditRefusal(state.metadata);
        if (reason !== readOnlyReason || disabled !== input.disabled) {
            readOnlyReason = reason;
            input.readOnly = reason !== undefined;
            if (reason) root.dataset.readOnly = reason;
            else delete root.dataset.readOnly;
            input.disabled = disabled;
            publishState();
        }
        if (lineRequest && !validCommand(lineRequest.capture)) cancelLineRequest();
        if (!input.disabled && !composing) {
            const document = currentDocument(), { selection: selected, selectionSet } = currentView();
            paired.sync(document); automaticIndent.sync(document);
            if (graphemeCache?.buffer !== document.buffer) graphemeCache = undefined;
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
        if (currentSelections() === projectedSet && input.selectionStart === Math.min(context.nativeAnchor, context.nativeHead)
            && input.selectionEnd === Math.max(context.nativeAnchor, context.nativeHead) && backward === (context.nativeAnchor > context.nativeHead)) return;
        const anchor = context.toModel(backward ? input.selectionEnd : input.selectionStart), head = context.toModel(backward ? input.selectionStart : input.selectionEnd);
        const current = currentView(); if (current.revision === revision && current.selection.anchor === anchor && current.selection.head === head) return;
        selecting = true;
        try { if (view.setSelection(revision, { anchor, head })) projectedSet = currentSelections(); }
        finally { selecting = false; }
        scheduleCaret();
    }
    function refuseEdit(event: Event): void {
        if (event.cancelable) event.preventDefault();
        if (readOnlyReason && !input.disabled && live()) root.dispatchEvent(new CustomEvent<EditRefusedDetail>(editRefusedEvent,
            { bubbles: true, detail: Object.freeze({ documentId, reason: readOnlyReason }) }));
    }
    const conflict = (reason: string, edit?: TextEdit, expectedRevision = revision, contextFrom = context.from, attemptedText = input.value, cause?: unknown) => {
        conflicts++;
        group = undefined;
        input.dispatchEvent(new CustomEvent<InputConflictDetail>(inputConflictEvent, { bubbles: true, detail: Object.freeze({ documentId, expectedRevision, reason,
            attemptedText, contextFrom, ...(edit ? { attemptedEdit: Object.freeze({ ...edit }) } : {}), ...(cause === undefined ? {} : { cause }) }) }));
    };
    function commandFailure(error: unknown, expectedRevision: number, attemptedText: string): void {
        let cause = error;
        try { refresh(); }
        catch (cleanupError) { cause = new AggregateError([error, cleanupError], "Command and cleanup failed."); }
        conflict("command-failed", undefined, expectedRevision, 0, attemptedText, cause);
    }
    function commandTurn(work: () => void, attemptedText = ""): void {
        const expectedRevision = revision;
        try { work(); }
        catch (error) {
            commandFailure(error, expectedRevision, source.getSnapshot()?.revision === expectedRevision ? attemptedText : "");
        }
    }
    const revealScope = workspace.createNotificationScope();
    function reveal(target: RevealTarget, options: EditorRevealOptions = {}): Outcome<EditorRevealRange> {
        const { align = "nearest", select = false, focus: takeFocus = false, expectedRevision } = options;
        validateRevealAlignment(align);
        if (typeof select !== "boolean" || typeof takeFocus !== "boolean") invalidType("reveal flags");
        if (expectedRevision !== undefined && !isNonNegativeInteger(expectedRevision))
            invalidRange("reveal revision");
        if (disposed || !live()) return stale;
        if (input.disabled || resource.getSnapshot().state !== "ready" || composing || hostInsertion) {
            return refused("unavailable-view");
        }
        const { revision, buffer } = currentDocument();
        if (expectedRevision !== undefined && revision !== expectedRevision) return stale;
        function offset(position: BufferPosition): number {
            if (!Number.isSafeInteger(position.line) || !Number.isSafeInteger(position.column)) {
                invalidRange("reveal position");
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
                invalidRange("reveal range");
            from = Math.max(0, Math.min(target.from, buffer.length));
            to = Math.max(0, Math.min(target.to, buffer.length));
        }
        const applied = revealScope.batch(() => {
            if (select && !view.setSelection(revision, { anchor: from, head: to })) return false;
            viewport.revealRange(from, to, align);
            return true;
        });
        if (!applied || disposed || !live() || currentDocument().revision !== revision) return stale;
        if (takeFocus) focus();
        return done(Object.freeze({ from, to }));
    }
    function revealCaret(selected = currentView().selection, vertical: NonNullable<RevealOptions["vertical"]> = "nearest"): void {
        let offset = selected.head;
        if (selected.head !== selected.anchor) {
            const buffer = currentDocument().buffer;
            if (offset === buffer.length) {
                const block = currentFolds().hiddenBy(buffer.lineCount - 1);
                if (block) offset = lineContentEnd(buffer, block.lineFrom);
            }
        }
        viewport.revealOffset(offset, { horizontal: "nearest", vertical, affinity: selected.headAffinity ?? "after" });
    }
    type ApplyOptions = { type?: string | undefined; expectedRevision?: number; recoveryText?: string | undefined; commandText?: string;
        adjustNewlines?: boolean; accepted?: ((edits: readonly TextEdit[]) => void) | undefined; typedText?: string | undefined };
    function apply(edits: readonly TextEdit[], selection: Selection | SelectionSet, kind: EditKind,
        { type, expectedRevision = revision, recoveryText, adjustNewlines, accepted, typedText,
            commandText = recoveryText ?? typedText ?? "" }: ApplyOptions = {}): boolean {
        if (disposed) return false;
        hostInsertion?.cancel();
        const refusal = readOnly ? "read-only" : live() ? undefined : "expired-view";
        if (refusal) {
            conflict(refusal, edits[0], expectedRevision, context.from, recoveryText);
            refresh();
            return false;
        }
        preferred = undefined;
        let key: string | undefined;
        const before = currentView(), typed = type === "insertText" ? edits[0]?.insert : undefined;
        let tail: NonNullable<typeof group>["tail"] = typed === undefined ? undefined : typingRun(typed);
        const document = currentDocument();
        const trimmed = document.revision === expectedRevision && automaticIndent.trim(document.buffer, edits, selection);
        if (trimmed) { edits = trimmed.edits; selection = trimmed.selectionSet; }
        let transformed: ReturnType<TextEditorEditTransform>;
        try {
            transformed = editTransform?.(Object.freeze({ expectedRevision, edits,
                selectionSet: "ranges" in selection ? selection : createSelectionSet(document.buffer.length
                    + edits.reduce((n, edit) => n + edit.insert.length - (edit.to - edit.from), 0), [selection]), kind,
                ...(adjustNewlines ? { adjustNewlines: true } : {}) }));
        } catch (error) {
            commandFailure(error, expectedRevision, commandText);
            return false;
        }
        if (transformed) { edits = transformed.edits; selection = transformed.selectionSet; }
        if (type) {
            const adjacent = group?.type === type && group.revision === expectedRevision && group.selectionSet === before.selectionSet
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
            applied = result.status === "done";
            if (result.status === "done") {
                if (accepted && currentDocument().revision === result.value) accepted(edits);
                const after = currentView();
                revealCaret(after.selection);
                if (typedText && after.revision === result.value && (!transformed || edits.some(edit => edit.insert.length > 0))) typedAt = after;
                if (type && key) group = { type, revision: result.value, selectionSet: after.selectionSet, tail, key }; }
            else conflict(result.reason, edits[0], expectedRevision, context.from, recoveryText);
        } finally {
            committing = false;
            try { transformed?.complete?.(applied); }
            catch (error) { commandFailure(error, expectedRevision, applied ? "" : commandText); }
            finally {
                refresh();
                if (typedAt && typedText && !disposed && live()) dispatchTypedText(root, before, typedAt, typedText);
            }
        }
        return applied;
    }
    function captureInput(type: string, data: string | null, wholeLines = false): InputCapture {
        const target = captureNativeInsertion(input, type, data);
        return { revision, selectionSet: currentSelections(), context, ...(target ? { target } : {}), wholeLines };
    }
    function commit(type: string, captured = insertion ?? { revision, selectionSet: projectedSet, context }): void {
        insertion = undefined;
        if (disposed || composing) return;
        if (type === "historyUndo" || type === "historyRedo") { history(type === "historyUndo" ? "undo" : "redo"); return; }
        const projection = captured.context;
        if (input.value === projection.text && input.selectionStart === (captured.target?.from ?? Math.min(projection.nativeAnchor, projection.nativeHead))
            && input.selectionEnd === (captured.target?.to ?? Math.max(projection.nativeAnchor, projection.nativeHead))) { refresh(); return; }
        if ((captured.target && captured.target.before !== projection.text) || captured.revision !== source.getSnapshot()?.revision || captured.selectionSet !== currentSelections()) {
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
        const options = { type: typing || deleting ? type : undefined, expectedRevision: captured.revision, commandText: edit.insert,
            typedText: type === "insertText" || type === "insertCompositionText" ? edit.insert : undefined };
        if (captured.selectionSet.ranges.length > 1 || kind === "paste" && captured.wholeLines && exactTarget) {
            // A native textarea describes one primary target. Replicate only an exact captured
            // selection replacement; neighbouring autocorrection/reconversion needs its own plan.
            if (from !== Math.min(selected.anchor, selected.head) || to !== Math.max(selected.anchor, selected.head)) {
                conflict("unsupported-multiple-input-target", { from, to, insert: edit.insert }, captured.revision, projection.from); refresh(); return;
            }
            const plan = planInput(currentDocument().buffer, captured.selectionSet, edit.insert, kind, captured.wholeLines);
            apply(plan.edits, plan.selectionSet, kind, options); return;
        }
        const buffer = currentDocument().buffer;
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
        if (disposed) return false; hostInsertion?.cancel(); group = undefined; syncSelection();
        if (input.readOnly) { refresh(); return false; }
        if (!live()) { conflict("expired-view"); refresh(); return false; }
        const result = workspace[direction]({ documentId, expectedRevision: revision });
        if (result.status !== "done" && result.reason !== "history-empty") conflict(result.reason);
        else if (result.status === "done") revealCaret(currentView().selection, "center-if-outside");
        refresh(); return result.status === "done";
    }
    const focus = () => { if (!disposed) { input.focus({ preventScroll: true }); scheduleCaret(); } };
    const inputBinding = bindInput(focus);
    function planInput(buffer: TextBuffer, selections: SelectionSet, text: string, kind: EditKind, wholeLines = false) {
        return kind === "paste" ? planClipboardPaste(buffer, selections, text, wholeLines, pasteLineEndings === "preserve")
            : planSelectionEdits(buffer.length, selections, text);
    }
    function replaceSelection(insert: string, kind: EditKind, type?: string, recoveryText?: string, wholeLines = false): boolean {
        const document = currentDocument(), plan = planInput(document.buffer, currentSelections(), insert, kind, wholeLines);
        return apply(plan.edits, plan.selectionSet, kind, { type: kind === "typing" ? type : undefined, expectedRevision: document.revision,
            recoveryText, typedText: type === "insertText" ? insert : undefined });
    }
    // A host callback can replace the revision or selections during a command.
    const validCommand = (capture: CommandCapture) => !disposed && !composing && !input.disabled
        && !(capture.deleting && input.readOnly) && live()
        && source.getSnapshot()?.revision === capture.revision
        && currentSelections() === capture.selectionSet;
    function graphemePoint(buffer: TextBuffer, offset: number, side: -1 | 1): GraphemePoint {
        const local = localAsciiGraphemePoint(buffer, offset);
        if (local) return local;
        let line = buffer.lineAt(offset);
        if (side < 0 && line > 0 && offset === buffer.offsetAt(line)) line--;
        const from = buffer.offsetAt(line), to = lineBoundary(buffer, line + 1);
        if (graphemeCache?.buffer !== buffer || graphemeCache.from !== from || graphemeCache.to !== to) {
            graphemeCache = { buffer, from, to, boundaries: graphemeBoundaries(buffer.slice(from, to), from) };
        }
        return pointAtBoundaries(graphemeCache.boundaries, offset);
    }
    function commandCapture(deleting: boolean): CommandCapture {
        const document = currentDocument(), { selection, selectionSet } = currentView();
        return { buffer: document.buffer, revision: document.revision, selection, selectionSet, deleting };
    }
    function eachRange(capture: CommandCapture, resolve: (range: Selection) => Selection,
        complete: (ranges: readonly Selection[]) => void, layoutValid?: () => boolean): void {
        commandTurn(() => {
            const ranges = capture.selectionSet.ranges.map(resolve);
            if (validCommand(capture) && (!layoutValid || layoutValid())) complete(ranges);
        });
    }
    function completeCaptured(capture: CommandCapture, work: () => boolean): boolean {
        if (!validCommand(capture)) return false;
        return work();
    }
    function setSelectionSet(revision: number, { ranges, primary }: SelectionSet): boolean {
        return view.setSelections(revision, ranges, primary);
    }
    function finishRanges(capture: CommandCapture, ranges: readonly Selection[], type?: string,
        primary = capture.selectionSet.primary, owners?: number[]): SelectionSet | undefined {
        if (!validCommand(capture)) return;
        const selections = normalizeSelectionSet(capture.buffer.length, ranges, primary, owners);
        completeCaptured(capture, () => {
            if (capture.deleting) {
                const plan = planSelectionEdits(capture.buffer.length, selections, "");
                return apply(plan.edits, plan.selectionSet, "delete", { type, expectedRevision: capture.revision });
            }
            group = undefined;
            setSelectionSet(capture.revision, selections);
            revealCaret();
            refresh();
            return true;
        });
        const current = currentSelections();
        return owners && !sameSelectionSet(current, selections) ? undefined : current;
    }
    function revealSelectionForMovement(): void {
        hostInsertion?.cancel();
        view.folding.revealSelection(currentFolding());
    }
    function captureTextMovement(deleting: boolean): CommandCapture | undefined {
        if (deleting && input.readOnly) return;
        revealSelectionForMovement();
        syncSelection();
        preferred = undefined;
        return commandCapture(deleting);
    }
    function deleteGrapheme(direction: -1 | 1): boolean {
        const capture = captureTextMovement(true);
        if (!capture) return false;
        const scanColumns = lineColumnScanner((from, to) => capture.buffer.slice(from, to), language.tabSize);
        eachRange(capture, range => {
            if (range.anchor !== range.head) return range;
            const at = range.head;
            if (direction < 0 && paired.emptyAt(at)) return { anchor: at - 1, head: at + 1 };
            if (direction < 0 && at && /[ \t]/.test(capture.buffer.slice(at - 1, at))) {
                const start = capture.buffer.offsetAt(capture.buffer.lineAt(at));
                const columns = scanColumns(start, at, true);
                if (columns.indentation) return { anchor: columns.previousStop, head: at };
            }
            const point = graphemePoint(capture.buffer, at, direction);
            const from = direction < 0 && point.floor === at ? point.preceding ?? at : point.floor;
            const to = direction > 0 ? point.following ?? at : point.ceil;
            return { anchor: from, head: to };
        }, ranges => finishRanges(capture, ranges, direction < 0 ? "deleteContentBackward" : "deleteContentForward"));
        return true;
    }
    function word(direction: -1 | 1, deleting: boolean, extend = false): boolean {
        const capture = captureTextMovement(deleting);
        if (!capture) return false;
        group = undefined;
        eachRange(capture, selected => {
            if (deleting && selected.anchor !== selected.head) {
                return selected;
            }
            if (deleting && direction < 0 && paired.emptyAt(selected.head)) {
                return { anchor: selected.head - 1, head: selected.head + 1 };
            }
            const side = deleting ? (direction < 0 ? 1 : -1) : direction;
            const startPoint = graphemePoint(capture.buffer, selected.head, side);
            const start = side < 0 ? startPoint.floor : startPoint.ceil;
            const offset = wordCommandOffset(capture.buffer, start, direction, deleting, capture.selectionSet.ranges.length);
            const endPoint = graphemePoint(capture.buffer, offset, direction);
            const end = direction < 0 ? endPoint.floor : endPoint.ceil;
            return deleting ? { anchor: Math.min(start, end), head: Math.max(start, end) } : moved(selected, end, extend);
        }, ranges => finishRanges(capture, ranges));
        return true;
    }
    function wordRange(buffer: TextBuffer, offset: number, wordsOnly = false): Selection | undefined {
        const line = buffer.lineAt(offset), from = buffer.offsetAt(line);
        const to = lineContentEnd(buffer, line);
        if (to === from) return;
        const point = graphemePoint(buffer, Math.min(offset, to), -1);
        const characterAt = (at: number) => Array.from(buffer.slice(at, Math.min(to, at + 2)))[0] ?? "";
        let probe = Math.max(from, point.floor), character = characterAt(probe);
        if (probe === to || wordsOnly && probe === offset && !isCodeWordBase(character)) {
            probe = Math.max(from, point.preceding ?? from); character = characterAt(probe);
        }
        if (wordsOnly && !isCodeWordBase(character)) return;
        const bounds = { from, to };
        const left = wordBoundary(buffer, probe + character.length, -1, bounds);
        const right = wordBoundary(buffer, probe, 1, bounds);
        const low = graphemePoint(buffer, left, -1), high = graphemePoint(buffer, right, 1);
        return { anchor: Math.max(from, low.floor), head: Math.min(to, high.ceil) };
    }
    function selectWord(offset: number, add = false): void {
        if (disposed || composing || input.disabled || !live()) return;
        stopDrag(); group = undefined; preferred = undefined; focus(); syncSelection();
        const capture = commandCapture(false);
        commandTurn(() => {
            const range = wordRange(capture.buffer, offset);
            if (!range || !validCommand(capture)) return;
            if (add) view.setSelections(capture.revision, [...capture.selectionSet.ranges, range], capture.selectionSet.ranges.length);
            else view.setSelection(capture.revision, range);
            pointerOrigin = range;
            refresh();
        });
    }
    function prepareSelectionCommand(): void {
        syncSelection();
        group = undefined;
        preferred = undefined;
    }
    const wholeWordSelections = new WeakMap<DocumentViewSnapshot, boolean>();
    function selectAndReveal(revision: number, selections: SelectionSet, wholeWord: boolean): boolean {
        if (!setSelectionSet(revision, selections)) return false;
        wholeWordSelections.set(currentView(), wholeWord);
        revealCaret();
        return true;
    }
    function selectOccurrences(all: boolean): void {
        prepareSelectionCommand();
        const capture = commandCapture(false);
        const { selection, selectionSet } = capture;
        const empty = selection.head === selection.anchor;
        const wholeWord = empty || wholeWordSelections.get(currentView()) === true;
        commandTurn(() => {
            const seed = empty ? wordRange(capture.buffer, selection.head, true) : selection;
            let result = selectionSet;
            if (seed && empty && !all) {
                const ranges = selectionSet.ranges.slice();
                ranges[selectionSet.primary] = seed;
                result = { ranges, primary: selectionSet.primary };
            } else if (seed) {
                result = selectionOccurrences(capture.buffer, selectionSet, seed, all, wholeWord);
            }
            if (validCommand(capture) && selectAndReveal(capture.revision, result, wholeWord)) refresh();
        });
    }
    function navigationStyle(): string {
        const style = win.getComputedStyle(root);
        return [root.isConnected, style.width, style.height, style.fontFamily, style.fontSize, style.fontWeight, style.fontStyle, style.lineHeight,
            style.letterSpacing, style.wordSpacing, style.tabSize,
            style.fontVariantLigatures, style.fontKerning, style.fontFeatureSettings, style.fontVariationSettings, style.transform, cssZoom(root), owner.fonts.status].join("|");
    }
    function navigationLayout(style = navigationStyle()): string {
        const state = viewport.getSnapshot();
        return [style, root.clientWidth, root.clientHeight, state.width, state.height, state.lineHeight, state.columnWidth, viewport.activity().rowGeneration, currentFolding().generation].join("|");
    }
    function beginNavigation(prepare: (capture: CommandCapture, style: string) => void): void {
        commandTurn(() => {
            const capture = commandCapture(false);
            if (validCommand(capture)) prepare(capture, navigationStyle());
        });
    }
    function prepareMovement(): void {
        revealSelectionForMovement();
        syncSelection(); group = undefined;
    }
    function moveToBoundary(key: "Home" | "End", extend: boolean, documentBoundary = false): boolean {
        prepareMovement(); preferred = undefined;
        const capture = commandCapture(false), buffer = capture.buffer, firstNonblank = new Map<number, number>();
        if (!validCommand(capture)) return false;
        eachRange(capture, range => {
            if (documentBoundary) return moved(range, key === "Home" ? 0 : buffer.length, extend);
            const line = buffer.lineAt(range.head);
            if (key === "End") return moved(range, lineContentEnd(buffer, line), extend);
            const start = buffer.offsetAt(line);
            let first = firstNonblank.get(line);
            if (first === undefined) {
                const indent = buffer.line(line).text.search(/\S/u);
                first = start + Math.max(0, indent);
                firstNonblank.set(line, first);
            }
            return moved(range, range.head === first ? start : first, extend);
        }, ranges => finishRanges(capture, ranges));
        return true;
    }
    function horizontal(key: "ArrowLeft" | "ArrowRight", extend: boolean): boolean {
        prepareMovement(); preferred = undefined;
        beginNavigation((capture, style) => {
            viewport.flush();
            if (!validCommand(capture) || navigationStyle() !== style) return;
            const layout = navigationLayout(style);
            const direction = key === "ArrowLeft" ? -1 : 1;
            eachRange(capture, range => {
                const point = navigation.horizontalPoint(capture.buffer, range, direction, extend);
                if (point) return moved(range, point.offset, extend, point.affinity);
                if (!extend && range.anchor !== range.head) {
                    return moved(range, direction < 0 ? Math.min(range.anchor, range.head) : Math.max(range.anchor, range.head), false);
                }
                const at = graphemePoint(capture.buffer, range.head, direction);
                return moved(range, direction < 0 ? at.preceding ?? range.head : at.following ?? range.head, extend);
            }, ranges => finishRanges(capture, ranges), () => navigationLayout() === layout);
        });
        return true;
    }
    function vertical(direction: -1 | 1, page: boolean, extend: boolean, add = false): boolean {
        prepareMovement();
        // Use source columns on ordinary fixed-pitch rows. Tabs, shaped text and proportional fonts keep their geometry.
        beginNavigation((capture, style) => {
            viewport.flush();
            const buffer = capture.buffer, selected = capture.selection;
            if (!viewport.coordsAt(selected.head, selected.headAffinity)) { revealCaret(selected); viewport.flush(); }
            if (!validCommand(capture) || navigationStyle() !== style) return;
            const state = viewport.getSnapshot(), layout = navigationLayout(style);
            const prior = preferred?.selections === capture.selectionSet && preferred.revision === capture.revision && preferred.layout === layout ? preferred.columns : undefined;
            const movement = createVerticalMovement(navigation, state, buffer, capture.selectionSet,
                direction, page, extend, add, prior);
            eachRange(capture, movement.move, destinations => {
                if (page) viewport.scrollTo({ top: state.scrollTop + movement.pageDelta() });
                const ranges = add ? [...capture.selectionSet.ranges, ...destinations] : destinations;
                const primary = capture.selectionSet.primary + (add ? destinations.length : 0);
                const owners: number[] = [];
                const selections = finishRanges(capture, ranges, undefined, primary, owners);
                if (selections) {
                    const columns = owners.map(at => movement.columns[at % destinations.length]);
                    preferred = { selections, revision: capture.revision, layout, columns };
                }
            }, () => navigationLayout() === layout);
        });
        return true;
    }
    function hasCommentSyntax(command: TextEditorCommand | Readonly<{ character: string }>): boolean {
        switch (command) {
            case "line-comment": case "add-line-comment": case "remove-line-comment": return !!language.lineComment;
            case "block-comment": return !!language.blockComment;
            default: return true;
        }
    }
    function languageCommand(command: EditingCommand | Readonly<{ character: string }>): boolean {
        if (disposed || composing || input.disabled || input.readOnly || !hasCommentSyntax(command)) return false;
        syncSelection();
        const capture = commandCapture(true), overtyped: number[] = [];
        const folds = typeof command === "string" && command !== "newline" && command !== "block-comment"
            ? currentFolds() : undefined;
        const opening = typeof command === "object" ? language.pairs.find(pair => pair.open === command.character) : undefined;
        const acceptPairs = (edits: readonly TextEdit[]) => paired.accept(currentDocument(), capture.revision, edits, capture.selectionSet, opening, overtyped);
        const configuration = language;
        group = undefined;
        commandTurn(() => {
            const plan = planLanguageEdit(capture.buffer, capture.selectionSet, typeof command === "string" ? command : {
                character: command.character, canOvertype: at => {
                    if (!paired.has(at)) return false;
                    overtyped.push(at); return true;
                },
            }, configuration, folds);
            if (language !== configuration || folds && !folds.sameProjection(currentFolds())) return;
            completeCaptured(capture, () => {
                const autoIndent = language.enter !== undefined && (command === "newline" || command === "insert-line-above" || command === "insert-line-below");
                if (plan.edits.length) return apply(plan.edits, plan.selectionSet, typeof command === "object" ? "typing" : "replace", {
                    expectedRevision: capture.revision, adjustNewlines: autoIndent, typedText: typeof command === "object" ? command.character : undefined,
                    accepted: autoIndent ? edits => automaticIndent.remember(currentDocument(), edits, plan.edits)
                        : typeof command === "object" ? acceptPairs : undefined });
                if (overtyped.length) acceptPairs(plan.edits);
                group = undefined;
                const before = currentView();
                if (!setSelectionSet(capture.revision, plan.selectionSet)) return false;
                revealCaret(); refresh();
                if (overtyped.length && typeof command === "object") dispatchTypedText(root, before, currentView(), command.character);
                return true;
            });
        }, typeof command === "object" ? command.character : "");
        return true;
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
                hostInsertion?.cancel(); group = undefined; preferred = undefined;
                view.folding.revealSelection(currentFolding());
                view.setSelection(revision, { anchor: 0, head: currentDocument().buffer.length });
                refresh(); return true;
            case "go-to-line": {
                const prompt = options.requestLine;
                if (!prompt) return false;
                cancelLineRequest();
                prepareSelectionCommand();
                const capture = commandCapture(false);
                const { buffer } = capture;
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
                prepareSelectionCommand();
                const previous = caretHistory.pop();
                if (previous) {
                    skipCaretHistory = true;
                    try {
                        const wholeWord = wholeWordSelections.get(previous) === true;
                        selectAndReveal(previous.revision, previous.selectionSet, wholeWord);
                    } finally { skipCaretHistory = false; }
                }
                return true;
            }
            case "jump-to-bracket": {
                prepareSelectionCommand();
                const capture = commandCapture(false);
                let navigate: ((caret: number) => number | undefined) | undefined;
                eachRange(capture, range => {
                    navigate ??= brackets!.navigation(capture.buffer, capture.selectionSet.ranges.length,
                        () => validCommand(capture));
                    const destination = navigate(range.head);
                    return destination === undefined ? range : moved(range, destination, false);
                }, ranges => finishRanges(capture, ranges));
                return true;
            }
            case "select-line": {
                prepareSelectionCommand();
                const capture = commandCapture(false);
                const buffer = capture.buffer, folds = currentFolds();
                eachRange(capture, range => {
                    const from = Math.min(range.anchor, range.head), to = Math.max(range.anchor, range.head);
                    const { anchor } = wholeLine(buffer, from, folds);
                    const endsAtStart = from < to && to === buffer.offsetAt(buffer.lineAt(to));
                    const head = endsAtStart && from !== anchor ? to : wholeLine(buffer, to, folds).head;
                    return { anchor, head };
                }, ranges => finishRanges(capture, ranges), () => folds.sameProjection(currentFolds()));
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
        listen(input, type, guardNativeHistory, { capture: true });
    }
    function beforeInput(event: InputEvent): void {
        hostInsertion?.cancel();
        pendingDeletion = undefined; insertion = undefined;
        if (event.defaultPrevented) return;
        if (input.readOnly) { refuseEdit(event); return; }
        const deletion = nativeDeletion(event.inputType);
        if (!composing && deletion && event.cancelable) { event.preventDefault(); runCommand(deletion); return; }
        if (!composing) view.folding.revealSelection(currentFolding());
        if (!composing && deletion) {
            syncSelection();
            pendingDeletion = { revision, selectionSet: currentSelections(), command: deletion };
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
    listen(input, "beforeinput", event => { const began = win.performance.now();
        try { beforeInput(event); } finally { beforeInputEvents++; lastBeforeInputMs = win.performance.now() - began; }
    });
    listen(input, "input", event => {
        const start = win.performance.now(), type = (event as InputEvent).inputType;
        const captured = pendingDeletion; pendingDeletion = undefined;
        const deletion = nativeDeletion(type);
        if (!composing && deletion) {
            if (!captured || captured.command !== deletion || input.disabled || input.readOnly || !live()
                || captured.revision !== revision || captured.selectionSet !== currentSelections()) {
                conflict(type.startsWith("deleteWord") ? "stale-word-input" : "stale-delete-input", undefined, captured?.revision);
                refresh();
            }
            else { refresh(); runCommand(deletion); }
        } else commit(type);
        lastInputMs = win.performance.now() - start; inputEvents++;
    });
    function startComposition(): void {
        cancelLineRequest();
        registry.reset();
        escapeState(false);
        hostInsertion?.cancel();

        pendingDeletion = undefined;
        insertion = undefined;
        syncSelection();
        view.folding.revealSelection(currentFolding());
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
    listen(input, "compositionstart", startComposition);
    listen(input, "compositionupdate", event => { if (composing) caretLayer.showComposingText(event.data); });
    listen(input, "compositionend", endComposition);
    listen(input, "select", syncSelection);
    // Tab can reset the browser range after focus dispatch. It changes focus, not model selection.
    listen(input, "keyup", event => {
        // A held Shift qualifies the next Tab. Releasing Shift alone consumes the escape.
        if (event.key === "Shift") escapeState(false);
        if (event.key === "Tab") refresh(); else syncSelection();
    });
    listen(input, "focus", () => {
        // Dialog dismissal can reset the caret to the start of the textarea. A native select()
        // sets a nonempty range before focusing and must keep that range for the next input.
        if (!composing && !committing && input.selectionEnd === 0 && input.value === context.text) projectSelection();
        publishState(); scheduleCaret();
    });
    listen(input, "blur", () => { publishState(); syncSelection(); group = undefined; registry.reset(); scheduleCaret();
        // Clear the Escape prefix after the browser completes focus traversal.
        if (escapeSelection) queueMicrotask(() => { if (!disposed) escapeState(false); }); });
    function keydown(event: KeyboardEvent, captured?: KeyBinding): void {
        const repeatedEscape = event.key === "Escape" && event.repeat;
        if (escapeSelection && event.key !== "Tab" && event.key !== "Shift" && !repeatedEscape) escapeState(false);
        if (event.defaultPrevented || composing || event.isComposing || event.keyCode === 229) return;
        if (isModifierKey(event.key)) return;
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
        const action = typeof binding === "object" ? binding : undefined;
        const command = action?.command;
        // Editing and navigation supersede a host insertion. Ordinary typing reaches beforeInput.
        if (action) hostInsertion?.cancel();
        if (input.readOnly && event.key !== "Tab") {
            // A read-only textarea suppresses beforeinput for ordinary printable keys.
            const printable = ((!event.ctrlKey && !event.metaKey && !event.altKey) || event.getModifierState("AltGraph"))
                && [...event.key].length === 1;
            if (printable || action?.edit) { refuseEdit(event); return; }
        }
        if (command?.kind === "command" && command.command === "go-to-line" && !options.requestLine) return;
        if (command?.kind === "command") { if (runCommand(command.command)) event.preventDefault(); return; }
        view.folding.revealSelection(currentFolding());
        if (command || binding === "escape") group = undefined;
        if (command?.kind === "history") { event.preventDefault(); history(command.direction); return; }
        if (binding === "escape") {
            preferred = undefined;
            const state = currentView();
            if (state.selectionSet.ranges.length > 1) { event.preventDefault(); view.setSelection(revision, state.selection); refresh(); }
            else if (!event.repeat) escapeState(true);
            return;
        }
        escapeState(false); syncSelection();
        preferred = undefined;
        if (command?.kind === "language" && languageCommand(command.command)) event.preventDefault();
    }
    listen(input, "keydown", event => {
        const started = win.performance.now(); keydownEvents++;
        try { keydown(event); } finally { lastKeydownMs = win.performance.now() - started; }
    });
    listen(root, "keydown", event => {
        if (event.target !== input && event.target instanceof win.Element && event.target.closest(".st-editor") === root)
            registry.keymap.handle(event);
    });
    function pointerHit(event: MouseEvent, gutterInset = 0) {
        // Pointer capture can retarget a gutter double-click to the root. Scrollbars also target the root.
        if (event.target === root) {
            const bounds = clientBox(root, viewport.settings().minimap, gutterInset);
            if (event.clientX < bounds.left || event.clientX >= bounds.right
                || event.clientY < bounds.top || event.clientY >= bounds.bottom) return undefined;
        }
        const painted = viewport.activity();
        if (painted.revision !== revision || painted.foldGeneration !== currentFolding().generation) viewport.flush();
        return viewport.hitTest(event.clientX, event.clientY);
    }
    let draggedWord = false, foldSummaryClick = false;
    // Expansion removes the label before the next press in the browser's click sequence.
    listen(root, "click", event => {
        if (event.detail === 1) foldSummaryClick = (event.target as HTMLElement).dataset?.ornament === "fold";
    }, { capture: true });
    listen(root, "dblclick", event => {
        if (event.button !== 0 || disposed || composing || input.disabled || !live()
            || (event.target as Element | null)?.closest(".st-viewport-gutter")) return;
        const point = pointerHit(event, viewport.getSnapshot().gutterWidth); if (!point) return;
        event.preventDefault(); if (!draggedWord && !foldSummaryClick) selectWord(point.offset, event.altKey);
    });
    const textDrag = mountTextDragDrop({ workspace, view, viewport, input,
        available: () => !disposed && !composing && !input.disabled,
        beforeStart: () => { stopDrag(); preferred = undefined; group = undefined; },
        afterDrop: () => { revealCaret(); focus(); refresh(); },
        rejected: reason => { conflict(reason); refresh(); } });
    let mousePress: { event: PointerEvent; armed: boolean; revision: number; selectionSet: SelectionSet } | undefined;
    listen(root, "pointerdown", () => { mousePress = undefined; draggedWord = false; registry.reset(); escapeState(false); }, { capture: true });
    listen(root, "pointerdown", event => {
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
            mousePress = { event, armed, revision, selectionSet: currentSelections() };
            return;
        }
        if (!armed) beginPointer(event, 1, event);
    });
    listen(root, "mousedown", event => {
        const press = mousePress; mousePress = undefined;
        if (!press || event.button !== 0 || event.defaultPrevented) return;
        if (foldSummaryClick && event.detail > 1) { textDrag.disarm(); event.preventDefault(); return; }
        if (press.revision !== revision || press.selectionSet !== currentSelections()) { textDrag.disarm(); return; }
        if (press.armed && event.detail < 2) return;
        if (press.armed) textDrag.disarm();
        beginPointer(press.event, event.detail, event);
    });
    function wholeLine(buffer: TextBuffer, offset: number, folds = currentFolds()): Selection {
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
        native.preventDefault(); stopDrag(); preferred = undefined; focus(); group = undefined;
        const state = currentView();
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
            const line = currentDocument().buffer.lineAt(point.offset);
            unit = { kind: "column", middle: event.button === 1, originRow: currentFolds().rowAt(line),
                anchorColumn: dragColumn(event.clientX, dragBounds()), anchorOffset: point.offset, anchorAffinity: point.affinity };
        } else if (clicks >= 4) {
            view.setSelection(revision, { anchor: 0, head: currentDocument().buffer.length }); refresh(); return;
        } else if (gutter || clicks === 3) {
            const buffer = currentDocument().buffer, target = wholeLine(buffer, point.offset);
            origin = gutter && extending ? origin ?? { anchor, head: anchor } : target;
            const lineStart = origin === target ? target.anchor : wholeLine(buffer, origin.anchor).anchor;
            unit = { kind: "line", range: origin, lineStart };
            ({ anchor, head } = extendPointerUnit(origin, target, lineStart));
        } else if (clicks === 2) unit = { kind: "word", origin: point.offset };
        if (!keepSelection) view.setSelections(revision, [...baseRanges, { anchor, head, anchorAffinity, headAffinity: point.affinity }], baseRanges.length);
        refresh();
        pointerOrigin = origin;
        dragCaretRecorded = state.selectionSet !== currentSelections();
        const padding = point.padding === true && !columns;
        if (padding) viewport.revealOffset(point.offset, { horizontal: "nearest", vertical: "nearest", affinity: point.affinity });
        drag = { pointer: event.pointerId, anchor, anchorAffinity, revision, x: event.clientX, y: event.clientY,
            selectionSet: currentSelections(), baseRanges, padding, ...(unit ? { unit } : {}) };
        root.setPointerCapture(event.pointerId);
    }
    listen(root, "pointermove", event => {
        if (drag?.pointer !== event.pointerId) return;
        const buttonMask = drag.unit?.kind === "column" && drag.unit.middle ? 4 : 1;
        if (!(event.buttons & buttonMask) || !validDrag()) { stopDrag(); return; }
        drag = { ...drag, x: event.clientX, y: event.clientY }; updateDragHead(); dragScrolling.schedule();
    });
    function validDrag(): boolean {
        return !!drag && !disposed && !composing && !input.disabled && root.isConnected && root.clientWidth > 0 && root.clientHeight > 0
            && drag.revision === revision && drag.selectionSet === currentSelections() && live() && root.hasPointerCapture(drag.pointer);
    }
    function dragBounds() {
        return clientBox(root, viewport.settings().minimap, viewport.getSnapshot().gutterWidth);
    }
    function dragColumn(x: number, bounds: ReturnType<typeof dragBounds>): number {
        return viewport.getSnapshot().scrollLeft + (Math.max(bounds.left, Math.min(bounds.right - 1, x)) - bounds.left) / bounds.zoom;
    }
    function updateColumnDrag(unit: ColumnDrag, localY: number, column: number, released: boolean): void {
        const capture = commandCapture(false), folds = currentFolds();
        const targetRow = () => folds.rowAt(navigation.columnDragLine(localY, folds.lineAt(unit.originRow)));
        const layout = navigationLayout();
        let row = targetRow();
        if (!unit.projection && row === unit.originRow && Math.abs(unit.anchorColumn - column) < 2) {
            if (!released || unit.middle) return;
            const prior = columnAnchor?.selections === capture.selectionSet && columnAnchor.revision === capture.revision
                ? columnAnchor : undefined;
            unit.anchorOffset = prior?.offset ?? capture.selection.head;
            unit.anchorAffinity = prior?.affinity ?? capture.selection.headAffinity ?? "after";
            const anchorColumn = prior?.layout === layout ? prior.column
                : navigation.columnAt(unit.anchorOffset, unit.anchorAffinity);
            if (anchorColumn === undefined) return;
            unit.originRow = folds.rowAt(capture.buffer.lineAt(unit.anchorOffset));
            unit.anchorColumn = anchorColumn;
            row = targetRow();
        }
        const direction = row < unit.originRow ? -1 : 1;
        const count = Math.abs(row - unit.originRow) + 1;
        let projection = unit.projection;
        if (!projection || projection.layout !== layout || projection.direction !== direction || projection.column !== column) {
            projection = { layout, direction, column, select: navigation.columnSelections(unit.anchorColumn, column),
                ranges: [], count: 0 };
            unit.projection = projection;
        }
        if (projection.count === count) return;
        const { ranges, select } = projection;
        commandTurn(() => {
            while (ranges.length < count) {
                const line = folds.lineAt(unit.originRow + direction * ranges.length);
                const range = select(line);
                if (!range) break;
                ranges.push(range);
            }
            if (ranges.length < count || !validCommand(capture) || drag?.unit !== unit || navigationLayout() !== layout) {
                delete unit.projection;
                return;
            }
            projection.count = count;
            completeCaptured(capture, () => {
                skipCaretHistory = dragCaretRecorded;
                const crossed = ranges.slice(0, count);
                const reached = crossed.filter(range => range.reaches);
                const selected = reached.length ? reached : crossed;
                try { view.setSelections(capture.revision, selected, selected.length - 1); }
                finally { skipCaretHistory = false; }
                columnAnchor = { selections: currentSelections(), revision: capture.revision, offset: unit.anchorOffset,
                    affinity: unit.anchorAffinity, column: unit.anchorColumn, layout };
                if (drag?.unit === unit) drag = { ...drag, selectionSet: currentSelections() };
                refresh();
                return true;
            });
        });
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
                if (drag?.unit === unit) drag = { ...drag, selectionSet: currentSelections(), padding: point.padding === true };
                pointerOrigin = origin;
                refresh();
            };
            if (unit.kind === "line") { applyUnits(unit.range, wholeLine(currentDocument().buffer, point.offset)); return; }
            draggedWord = true;
            const capture = commandCapture(false);
            commandTurn(() => {
                const origin = unit.range ?? wordRange(capture.buffer, unit.origin) ?? { anchor: unit.origin, head: unit.origin };
                const target = point.offset >= origin.anchor && point.offset < origin.head ? origin
                    : wordRange(capture.buffer, point.offset) ?? { anchor: point.offset, head: point.offset };
                if (drag !== current || !validCommand(capture)) return;
                unit.range = origin;
                applyUnits(origin, target);
            });
            return;
        }
        view.setSelections(current.revision, [...current.baseRanges, { anchor: current.anchor, head: point.offset, anchorAffinity: current.anchorAffinity, headAffinity: point.affinity }], current.baseRanges.length);
        if (drag === current) drag = { ...current, selectionSet: currentSelections(), padding: point.padding === true }; refresh();
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
            }
        }
        dragScrolling.stop();
        const pointer = drag?.pointer, padding = drag?.padding; drag = undefined;
        if (pointer !== undefined && root.hasPointerCapture(pointer)) root.releasePointerCapture(pointer);
        if (event?.type === "pointerup" && padding && !disposed && live()) {
            const selected = currentView().selection;
            viewport.revealOffset(selected.head, { horizontal: "nearest", vertical: "nearest", affinity: selected.headAffinity ?? "after" });
        }
    };
    listen(root, "pointerup", stopDrag); listen(root, "pointercancel", stopDrag);
    listen(root, "lostpointercapture", stopDrag);
    function canCaptureInsertion(): boolean {
        return !disposed && root.isConnected && !readOnly && !input.disabled && !input.readOnly && !composing
            && !insertion && !drag;
    }
    for (const type of ["copy", "cut", "paste"] as const) listen(input, type, event => {
        if (event.defaultPrevented) { group = undefined; if (type !== "copy") stopDrag(); return; }
        if (input.disabled || composing || !event.clipboardData) return;
        if (type === "paste" && !event.cancelable) return;
        if (type !== "copy" && input.readOnly) { refuseEdit(event); return; }
        event.preventDefault(); syncSelection(); group = undefined;
        if (type !== "copy") view.folding.revealSelection(currentFolding());
        const selections = currentSelections();
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
            const buffer = currentDocument().buffer;
            if (selections.ranges.every(range => range.anchor === range.head)) {
                const lines = copyCaretLines(buffer, selections, type === "cut", currentFolds());
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
    });
    let observedFoldRevision = currentFolding().revision;
    const caretHistory: DocumentViewSnapshot[] = [];
    let lastCaret = currentView(), skipCaretHistory = false;
    const observeCaret = () => {
        const next = currentView();
        if (columnAnchor?.selections !== next.selectionSet) columnAnchor = undefined;
        pointerOrigin = undefined;
        if (next.revision !== lastCaret.revision) caretHistory.length = 0;
        else if (!skipCaretHistory && (!drag || !dragCaretRecorded) && next.selectionSet !== lastCaret.selectionSet) {
            if (caretHistory.length === 50) caretHistory.shift();
            caretHistory.push(lastCaret);
            if (drag) dragCaretRecorded = true;
        }
        lastCaret = next;
        refresh();
    };
    const subscriptions = [viewport.onRender(scheduleCaret), source.subscribe(refresh), view.subscribe(observeCaret),
        view.folding.subscribe(() => { const revision = currentFolding().revision;
            if (revision === observedFoldRevision) { stopDrag(); preferred = undefined; }
            observedFoldRevision = revision; refresh(); }), resource.metadata.subscribe(refresh)];

    let activitySnapshot: TextEditorActivity | undefined;
    function activity(): TextEditorActivity {
        const input = composing ? "composing" : hostInsertion ? "host-insertion" : "idle";
        const pendingCaret = caretLayer.pending();
        const pendingDragScroll = dragScrolling.pending();
        if (activitySnapshot?.disposed === disposed && activitySnapshot.input === input
            && activitySnapshot.pendingCaret === pendingCaret && activitySnapshot.pendingDragScroll === pendingDragScroll) {
            return activitySnapshot;
        }
        return activitySnapshot = Object.freeze({ disposed, input, pendingCaret, pendingDragScroll });
    }
    refresh();
    brackets = mountBracketHighlights(workspace, view, viewport, input, () => language,
        () => !disposed && !composing && !hostInsertion, bracketOptions);
    warnings = mountCharacterWarnings(workspace, view, viewport, warningOptions);
    let cachedSettings: ResolvedEditorSettings | undefined, cachedViewport: ViewportSettings | undefined;
    const settings = (): ResolvedEditorSettings => {
        const presentation = viewport.settings();
        if (cachedSettings && cachedViewport === presentation) return cachedSettings;
        cachedViewport = presentation;
        return cachedSettings = Object.freeze({ ...presentation, language, pasteLineEndings, bracketMatching: bracketOptions,
            characterWarnings: warningOptions?.configuration ?? false });
    };
    const editor: TextEditor = Object.freeze({ element: root, strings, workspace, signal: listeners.signal, view, viewport, decorations: viewport.decorations, focus, activity, bracketMatching: brackets.handle, characterWarnings: warnings.handle,
        getSnapshot: editorState.observable.getSnapshot,
        subscribe(listener: ObservableListener) {
            if (disposed) throw new Error("Editor is disposed.");
            const unsubscribe = editorState.observable.subscribe(listener);
            const stop = () => { unsubscribe(); stateSubscriptions.delete(stop); };
            stateSubscriptions.add(stop); return stop;
        },
        captureInsertion: (kind = "paste") => {
            hostInsertion?.cancel();
            if (!canCaptureInsertion()) return;
            syncSelection(); view.folding.revealSelection(currentFolding());
            let captured: CapturedInsertion | undefined;
            captured = captureInsertion(editor, canCaptureInsertion, (plan, expected) => apply(plan.edits, plan.selectionSet, kind, { expectedRevision: expected }),
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
                group = undefined; preferred = undefined;
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
        getDiagnostics: () => Object.freeze({ ...activity(), inputUnits: input.value.length, inputEvents, lastInputMs, beforeInputEvents, lastBeforeInputMs, keydownEvents, lastKeydownMs,
            conflicts }),
        dispose: () => {
            if (disposed) return;
            notifications.assertWritable(); disposed = true; activitySnapshot = undefined; editTransform = undefined;
            cancelLineRequest();
            registry.dispose(); brackets!.dispose(); paired.clear(); automaticIndent.clear();
            caretHistory.length = 0;
            columnAnchor = undefined;
            pointerOrigin = undefined; mousePress = undefined;
            warnings!.dispose();
            hostInsertion?.cancel();
            pasteOwner = undefined;
            pendingDeletion = undefined;
            insertion = undefined; composition = undefined;
            graphemeCache = undefined; preferred = undefined; contextBuffer = undefined;
            if (composing && input.value !== context.text) conflict("composition-detached");
            composing = false;
            publishState();
            for (const stop of stateSubscriptions) stop();
            stopDrag();
            textDrag.dispose();
            caretLayer.dispose();

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
