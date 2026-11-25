import { onAbort } from "./listen.ts";
import { editorElement } from "./editor-element.ts";
import { Store } from "../core/observable.ts";
import { validateWorkBudget } from "../core/kernel-cursor.ts";
import { partitionPoint } from "../core/bound-search.ts";
import type { Observable } from "../core/observable.ts";
import { compareText } from "../core/comparison.ts";
import type { ComparisonBaseline, ComparisonController, ComparisonHunk, ComparisonSnapshot } from "../core/comparison.ts";
import { lineContentEnd } from "../core/newlines.ts";
import { splitsSurrogatePair } from "../core/utf16.ts";
import type { DiffHunk, DiffRange } from "../core/diff.ts";
import type { TextBuffer } from "../core/text-buffer.ts";
import type { DocumentId, DocumentView, TabId, TextResourceHandle, Workspace } from "../core/workspace.ts";
import { mountEditor } from "./text-editor.ts";
import type { EditorSettings, TextEditor, TextEditorOptions } from "./text-editor.ts";
import type { InlineDecoration, PresentedLine, TextViewport } from "./viewport.ts";
import { createComparisonScroll } from "./comparison-scroll.ts";
import { createComparisonAlignment } from "./comparison-alignment.ts";
import type { ComparisonAlignmentSnapshot } from "./comparison-alignment.ts";
import { mountComparisonControls, sameControlState } from "./comparison-controls.ts";
import { commandRegistration, type EditorCommand, type EditorCommands } from "./command-registry.ts";
import { createComparisonPanes } from "./comparison-panes.ts";
import { createCooperativeRunner } from "./cooperative-runner.ts";

export type TextComparisonStrings = Readonly<{
    baselineInput?: string;
    workingInput?: string;
    commandCategory?: string;
    previousChange?: string;
    nextChange?: string;
    useBaseline?: string;
    linkScrolling?: string;
    alignRows?: string;
    updating?: string;
    preparingRows?: string;
    shortcutSeparator?: string;
    previewLabel?: string;
    selectChange?: string;
    lastCompleted?: string;
    heading?: (side: "baseline" | "working", state: TextComparisonSnapshot) => string | undefined;
    excerpt?: (side: "baseline" | "working", range: DiffRange, visibleText: string) => string | undefined;
    statusText?: (state: TextComparisonSnapshot) => string | undefined;
    restoreHint?: (state: TextComparisonSnapshot) => string | undefined;
}>;
export type TextComparisonOptions = Readonly<{
    ariaLabel?: string;
    workBudget?: number;
    view?: DocumentView;
    controls?: boolean;
    strings?: TextComparisonStrings;
    scrollLinked?: boolean;
    rowsAligned?: boolean;
    settings?: EditorSettings;
    requestLine?: NonNullable<TextEditorOptions["requestLine"]>;
}>;
export type TextComparisonSnapshot = Readonly<{
    comparison: ComparisonSnapshot;
    /** Ready hunk at the active caret, including an explicitly selected hunk. */
    selectedHunk: number | null;
    canNavigate: boolean; canRevert: boolean;
    scrollLinked: boolean; alignment: ComparisonAlignmentSnapshot; disposed: boolean;
}>;
export type TextComparisonDiagnostics = Readonly<{ generation: number; steps: number; advances: number; maxStepMs: number; totalStepMs: number; scrollLinked: boolean; pendingScroll: boolean; rowsAligned: boolean; alignment: ComparisonAlignmentSnapshot; disposed: boolean }>;
export type TextComparisonHunk = ComparisonHunk & Readonly<{ select: () => boolean }>;
export type TextComparison = Observable<TextComparisonSnapshot> & Readonly<{
    element: HTMLDivElement; controller: ComparisonController; commands: EditorCommands;
    panes: Readonly<{ working: TextEditor; reference: TextEditor }>; activePane: () => TextEditor;
    getDiagnostics: () => TextComparisonDiagnostics;
    setScrollLinked: (linked: boolean) => void;
    setRowsAligned: (aligned: boolean) => void;
    navigateHunk: (direction: -1 | 1) => boolean;
    revertSelectedHunk: (shown?: TextComparisonSnapshot) => boolean;
    hunkAt: (index: number) => TextComparisonHunk | undefined; dispose: () => void;
}>;

/** Refine only painted rows. A long or unpaired replacement keeps its line tint. */
function inlineChange(line: number, side: "working" | "baseline", hunk: DiffHunk, buffer: TextBuffer, other: TextBuffer) {
    const range = hunk[side], peer = side === "working" ? hunk.baseline : hunk.working;
    const rows = range.lineTo - range.lineFrom, otherRows = peer.lineTo - peer.lineFrom;
    if (range.from === range.to || peer.from === peer.to || rows <= 1 && otherRows <= 1) return range;
    if (rows !== otherRows) return;
    const otherLine = peer.lineFrom + line - range.lineFrom;
    const start = buffer.offsetAt(line), end = lineContentEnd(buffer, line);
    const otherStart = other.offsetAt(otherLine), otherEnd = lineContentEnd(other, otherLine);
    if (end - start > 4096 || otherEnd - otherStart > 4096) return;
    const text = buffer.slice(start, end), otherText = other.slice(otherStart, otherEnd);
    if (text === otherText) return;
    const limit = Math.min(text.length, otherText.length);
    let prefix = 0, suffix = 0;
    while (prefix < limit && text.charCodeAt(prefix) === otherText.charCodeAt(prefix)) prefix++;
    while (suffix < limit - prefix && text.charCodeAt(text.length - suffix - 1) === otherText.charCodeAt(otherText.length - suffix - 1)) suffix++;
    if (splitsSurrogatePair(text, prefix) || splitsSurrogatePair(otherText, prefix)) prefix--;
    if (splitsSurrogatePair(text, text.length - suffix) || splitsSurrogatePair(otherText, otherText.length - suffix)) suffix--;
    return { from: start + prefix, to: end - suffix };
}

/** Two independently virtualized panes. Hosts own reference retrieval, acceptance, saving and execution. */
export function mountTextComparison(host: HTMLElement, workspace: Workspace, identity: DocumentId | TabId, baseline: ComparisonBaseline | DocumentId,
    options: TextComparisonOptions = {}): TextComparison {
    const requestedBudget = options.workBudget ?? 4096;
    validateWorkBudget(requestedBudget, "Comparison");
    const budget = Math.min(requestedBudget, 4096);
    const strings = { ...options.strings };
    const owner = host.ownerDocument, win = owner.defaultView;
    if (!win) throw new Error("Comparison requires an attached browser document.");
    let display: TextResourceHandle | undefined;
    const controller = compareText(workspace, identity, baseline, options, typeof baseline === "string" ? undefined : next =>
        !!display && workspace.adoptSaved(display.id, { text: next.buffer, serverVersion: next.version, history: "reset" }).applied);
    const runner = createCooperativeRunner(win);
    const root = editorElement(owner, "div", "comparison");
    const panes = editorElement(owner, "div", "comparison-panes");
    root.setAttribute("role", "group"); root.setAttribute("aria-label", options.ariaLabel ?? "Text comparison");
    const pane = () => {
        const section = owner.createElement("section");
        const content = editorElement(owner, "div", "comparison-editor");
        section.append(content);
        panes.append(section);
        return { section, content };
    };
    const referencePane = pane(), workingPane = pane();
    root.append(panes); host.append(root);
    const comparisonState = controller.getSnapshot;
    let state = comparisonState();
    let referenceBuffer = state.baseline?.buffer;
    let epoch = -1, scheduled = false, disposed = false;
    let measuredGeneration = -1, steps = 0, advances = 0, maxStepMs = 0, totalStepMs = 0;
    let decoratedGeneration = -1, decoratedStatus: string | undefined;
    function firstHunkInLines(side: "baseline" | "working", from: number, to = from + 1): DiffHunk | undefined {
        if (state.status !== "ready" && state.status !== "running") return;
        const low = partitionPoint(state.hunks.length, index => { const range = state.hunks[index]![side]; return Math.max(range.lineFrom + 1, range.lineTo) <= from; });
        const hunk = state.hunks[low]; return hunk && hunk[side].lineFrom < to ? hunk : undefined;
    }
    const decorate = (side: "baseline" | "working") => (line: PresentedLine): readonly InlineDecoration[] => {
        if (side === "working" && line.revision !== state.working?.revision) return [];
        const hunk = firstHunkInLines(side, line.line);
        if (!hunk) return [];
        const buffer = state[side]!.buffer;
        const range = inlineChange(line.line, side, hunk, buffer, state[side === "working" ? "baseline" : "working"]!.buffer);
        if (!range) return [];
        if (range.from === range.to) {
            let at = range.from;
            // A position between CR and LF shares the painted end of the line.
            if (at === line.to + 1 && at < buffer.length && buffer.slice(line.to, at + 1) === "\r\n") at = line.to;
            return at >= line.from && at <= line.to ? [{ from: at, to: at, className: "st-comparison-anchor" }] : [];
        }
        if (range.from >= line.to || range.to <= line.from) return [];
        return [{ from: range.from, to: range.to, className: side === "baseline" ? "st-comparison-removed" : "st-comparison-added" }];
    };
    const lineClass = (side: "baseline" | "working") => (line: PresentedLine) => {
        if (side === "working" && line.revision !== state.working?.revision) return;
        const range = firstHunkInLines(side, line.line)?.[side];
        return range && range.from < range.to ? `st-comparison-line-${side}` : undefined;
    };
    const paneOptions = { ...(options.settings ? { settings: options.settings } : {}), ...(options.requestLine ? { requestLine: options.requestLine } : {}) };
    const sharedCommands = new Map<string, EditorCommand>();
    const presentation = (side: "baseline" | "working") => ({
        commands: sharedCommands,
        epoch: () => comparisonState().baseline?.epoch,
        foldContainsChange: (buffer: TextBuffer, from: number, to: number) =>
            (side === "baseline" ? referenceBuffer : state.working?.buffer) === buffer && firstHunkInLines(side, from, to) !== undefined,
        gutterLineCount: () => Math.max(state.working?.buffer.lineCount ?? 0, state.baseline?.buffer.lineCount ?? 0),
    });
    let workingMount: ReturnType<typeof mountEditor>;
    try {
        workingMount = mountEditor(workingPane.content, workspace, identity, {
            view: controller.view, ...paneOptions, ariaLabel: strings.workingInput ?? "Comparison working source",
        }, presentation("working"));
    }
    catch (error) { root.remove(); controller.dispose(); throw error; }
    const commandScopes = [workingMount.commandScope];
    const working = workingMount.editor, pair = createComparisonPanes(workingMount, changed), referenceEditor = () => pair.reference()?.editor, referenceViewport = () => referenceEditor()?.viewport;
    const differences = (editor: TextEditor, side: "working" | "baseline") => editor.decorations.addProvider({
        order: 10, provide: decorate(side), lineClass: lineClass(side)
    });
    const workingDiff = differences(working, "working");
    let referenceDiff: ReturnType<typeof differences> | undefined;
    const busy = (editor: TextEditor | undefined, includeDrag: boolean) => {
        const input = editor?.activity();
        return input && (input.composing || input.pendingInput || input.pendingCommand || includeDrag && input.pendingDragScroll);
    };
    const panesIdle = (includeDrag: boolean) => !busy(working, includeDrag) && !busy(referenceEditor(), includeDrag);
    const composing = () => working.activity().composing || referenceEditor()?.activity().composing === true;
    const alignment = createComparisonAlignment(win, pair, controller.getSnapshot, changed, () => panesIdle(true));
    const scroll = createComparisonScroll(win, pair, controller.getSnapshot, () => panesIdle(false) && !alignment.snapshot().pending);
    let lastFocused: TextEditor | undefined;
    const activePane = () => lastFocused ?? working;
    function caretPosition(comparison: ComparisonSnapshot, pane: TextEditor) {
        const side = pane === working ? "working" : "baseline";
        const { head, anchor } = pane.view.getSnapshot().selection;
        const next = partitionPoint(comparison.hunks.length, i => comparison.hunks[i]![side].from <= head);
        const buffer = comparison[side]?.buffer;
        if (!buffer || head > buffer.length) return { next, selected: null };
        const range = comparison.hunks[next - 1]?.[side];
        if (range && (head < range.to || head === range.to && (head === range.from || anchor === range.from)))
            return { next, selected: next - 1 };
        // Opening a comparison leaves Next at the first change until the user places a caret.
        if (lastFocused || head !== 0 || anchor !== 0) {
            const line = buffer.lineAt(head > anchor ? head - 1 : head);
            for (const index of [next - 1, next]) {
                const candidate = comparison.hunks[index]?.[side];
                if (candidate && candidate.lineFrom <= line && line < candidate.lineTo)
                    return { next: index + 1, selected: index };
            }
        }
        return { next, selected: null };
    }
    const stateScope = workspace.createNotificationScope(), stateStore = new Store(captureState(), stateScope);
    let stopControls: (() => void) | undefined;
    function captureState(): TextComparisonSnapshot {
        const comparison = comparisonState(), ready = !disposed && comparison.status === "ready";
        const canNavigate = ready && comparison.hunks.length > 0 && !!referenceViewport() && epoch === comparison.baseline?.epoch && !composing();
        const selectedHunk = ready && epoch === comparison.baseline?.epoch && comparison.hunks.length ? caretPosition(comparison, activePane()).selected : null;
        const metadata = comparison.working ? workspace.resource(comparison.working.resourceId).metadata.getSnapshot() : undefined;
        const access = working.getSnapshot();
        const canRevert = canNavigate && selectedHunk !== null && access.readOnlyReason === null && !access.disabled
            && metadata?.capabilities.edit.includes("human") === true && metadata.editLock === null;
        return Object.freeze({ comparison, selectedHunk, canNavigate, canRevert, scrollLinked: scroll.snapshot().linked, alignment: alignment.snapshot(), disposed });
    }
    function publishState(): void {
        const next = captureState(), old = stateStore.get(), a = old.alignment, b = next.alignment;
        if (old.comparison === next.comparison && sameControlState(old, next)
            && a.work === b.work && a.runs === b.runs && a.failure === b.failure) return;
        stateScope.publish(stateStore, next);
    }
    function changed(): void { publishState(); schedule(); }
    const setScrollLinked = (value: boolean) => { stateScope.assertWritable(); scroll.setLinked(value); publishState(); };
    const setRowsAligned = (value: boolean) => {
        stateScope.assertWritable();
        if (value && !alignment.snapshot().enabled) scroll.setLinked(true);
        alignment.setEnabled(value); publishState();
    };
    function clearReference(): void {
        referenceDiff?.dispose(); referenceDiff = undefined;
        const retiredEditor = referenceEditor(); try { pair.setReference(undefined); } finally { retiredEditor?.dispose(); }
        if (display) { const retired = display; display = undefined; workspace.releaseResourceWhenUnowned(retired.id); }
    }
    function render(): void {
        if (disposed) return; state = comparisonState();
        if (state.baseline && !referenceEditor()) {
            if (typeof baseline !== "string") display = workspace.createTextResourceFromBuffer(workspace.createResourceKey("comparison", "baseline"), "Comparison baseline",
                { buffer: state.baseline.buffer, serverVersion: state.baseline.version }, { edit: [], save: false }, { visibility: "internal" });
            const referenceId = typeof baseline === "string" ? baseline : display!.documentId;
            const mounted = mountEditor(referencePane.content, workspace, referenceId, {
                ariaLabel: strings.baselineInput ?? "Comparison baseline source", readOnly: true, ...paneOptions,
            }, presentation("baseline"));
            commandScopes[1] = mounted.commandScope;
            const editor = mounted.editor;
            referenceDiff = differences(editor, "baseline");
            try { pair.setReference(mounted); } catch (error) { editor.dispose(); throw error; }
        } else if (!state.baseline && referenceViewport()) clearReference();
        const nextEpoch = state.baseline?.epoch ?? -1;
        if (epoch !== nextEpoch) {
            // An equal saved reference keeps the editor's existing document buffer.
            referenceBuffer = display ? workspace.document(display.documentId).buffer : state.baseline?.buffer;
            epoch = nextEpoch;
        }
        if (root.dataset.status !== state.status) root.dataset.status = state.status;
        alignment.update(); scroll.update();
        const generation = String(state.generation); if (root.dataset.generation !== generation) root.dataset.generation = generation;
        publishState();
        // Progress-only publications change no decorations. Selection and scroll invalidate
        // their own viewports; redraw hunks once on restart, completion or expiration.
        if (state.generation !== decoratedGeneration || state.status !== decoratedStatus) {
            decoratedGeneration = state.generation; decoratedStatus = state.status;
            referenceDiff?.invalidate(); workingDiff.invalidate();
        }
    }
    function schedule(): void { if (!disposed && !scheduled) { runner.schedule(step); scheduled = true; } }
    function step(): void {
        scheduled = false; if (disposed) return;
        const current = comparisonState();
        if (current.status === "running") {
            if (measuredGeneration !== current.generation) { measuredGeneration = current.generation; steps = advances = maxStepMs = totalStepMs = 0; }
            const start = win!.performance.now();
            runner.slice(() => { const next = controller.advance(budget); advances++; return next; },
                next => !disposed && next.status === "running" && next.generation === current.generation, 32);
            const elapsed = win!.performance.now() - start;
            steps++; totalStepMs += elapsed; maxStepMs = Math.max(maxStepMs, elapsed);
        }
        render(); if (comparisonState().status === "running") schedule();
    }
    function revealHunk(generation: number, index: number, selectRange: boolean): boolean {
        stateScope.assertWritable();
        const current = comparisonState(), reference = referenceViewport();
        if (disposed || composing() || current.status !== "ready" || current.generation !== generation || !Number.isSafeInteger(index)) return false;
        const hunk = current.hunks[index]; if (!hunk || !current.working || !current.baseline || !reference || epoch !== current.baseline.epoch) return false;
        const target = (pane: TextViewport, range: DiffRange, buffer: TextBuffer, revision: number) => ({
            pane, range, revision,
            start: selectRange || range.from === range.to ? range.from : buffer.offsetAt(range.lineFrom),
        });
        const targets = [
            target(reference, hunk.baseline, current.baseline.buffer, reference.view.getSnapshot().revision),
            target(working.viewport, hunk.working, current.working.buffer, current.working.revision),
        ];
        lastFocused ??= working;
        stateScope.batch(() => {
            for (const { pane, range, revision, start } of targets) {
                pane.view.setSelection(revision, { anchor: start, head: selectRange ? range.to : start });
            }
            for (const { pane, range } of targets) {
                const folds = pane.view.folding;
                folds.reveal(folds.getSnapshot(), range.from, range.to);
            }
        });
        for (const { pane, start } of targets) pane.revealOffset(start);
        render();
        return true;
    }
    function navigateFrom(pane: TextEditor, direction: -1 | 1): boolean {
        stateScope.assertWritable();
        const current = stateStore.get();
        if (!current.canNavigate || direction !== 1 && direction !== -1) return false;
        const { next, selected } = caretPosition(current.comparison, pane), count = current.comparison.hunks.length;
        const index = direction === 1 ? next % count : ((selected ?? next) + count - 1) % count;
        return revealHunk(current.comparison.generation, index, false);
    }
    const navigateHunk = (direction: -1 | 1) => navigateFrom(activePane(), direction);
    function revertSelectedHunk(shown = stateStore.get()): boolean {
        stateScope.assertWritable();
        const current = stateStore.get();
        if (!current.canRevert || !shown.canRevert || current.selectedHunk === null
            || current.comparison !== shown.comparison || current.selectedHunk !== shown.selectedHunk) return false;
        const hunk = hunkAt(current.selectedHunk);
        if (!hunk) return false;
        // Focusing the working pane can publish another selection or retire this generation.
        working.focus();
        return hunk.revert();
    }
    function hunkAt(index: number): TextComparisonHunk | undefined {
        const hunk = controller.hunkAt(index);
        if (!hunk) return;
        const generation = comparisonState().generation;
        return Object.freeze({ ...hunk, select: () => revealHunk(generation, index, true), revert: () => {
            stateScope.assertWritable();
            const access = working.getSnapshot();
            return !disposed && !composing() && access.readOnlyReason === null && !access.disabled && hunk.revert();
        } });
    }
    // A document notification can paint the working viewport before the scheduled controls.
    // Decoration queries must already see the mapped capture for that same revision.
    const unsubscribe = controller.subscribe(() => { state = comparisonState(); changed(); }),
        stopMetadata = workspace.resourceForDocument(controller.view.documentId).metadata.subscribe(changed);
    function dispose(): void {
        if (disposed) return; stateScope.assertWritable(); disposed = true; runner.cancel(); scheduled = false;
        try {
            sharedCommands.clear();
            unsubscribe(); stopMetadata(); scroll.dispose(); alignment.dispose();
            try { clearReference(); } finally { pair.dispose(); working.dispose(); }
        } finally {
            try { controller.dispose(); } finally { state = comparisonState(); publishState(); stopControls?.(); root.remove(); }
        }
    }
    try {
        render(); setRowsAligned(options.rowsAligned ?? false); setScrollLinked(options.scrollLinked ?? options.rowsAligned ?? false);
        const reference = referenceEditor();
        if (!reference) throw new Error("Comparison reference expired during mount.");
        const editors = Object.freeze({ working, reference });
        for (const editor of Object.values(editors)) {
            const stop = editor.view.subscribe(() => { if (activePane() === editor && !disposed) publishState(); });
            onAbort(editor.signal, stop);
            editor.element.addEventListener("focusin", () => { lastFocused = editor; publishState(); }, { signal: editor.signal });
        }
        const commands: EditorCommands = Object.freeze({
            register: commandRegistration(sharedCommands, commandScopes),
            get: (id, arg) => activePane().commands.get(id, arg),
            run: (id, arg) => activePane().commands.run(id, arg),
            list: () => activePane().commands.list(),
        });
        for (const [id, label, key, direction] of [
            ["comparison.nextChange", strings.nextChange ?? "Next change", "F7", 1],
            ["comparison.previousChange", strings.previousChange ?? "Previous change", "Shift+F7", -1],
        ] as const) commands.register({ id, label, owner: "editor", category: strings.commandCategory ?? "Comparison",
            enabled: () => stateStore.get().canNavigate, run: (_, pane) => navigateFrom(pane, direction) }, { keys: [key] });
        const review: TextComparison = Object.freeze({ element: root, controller, commands, panes: editors, activePane, ...stateStore.observable, navigateHunk, revertSelectedHunk, hunkAt, setScrollLinked, setRowsAligned,
            getDiagnostics: () => {
                const { linked, pending } = scroll.snapshot();
                const rows = alignment.snapshot();
                return Object.freeze({ generation: measuredGeneration, steps, advances, maxStepMs, totalStepMs,
                    scrollLinked: linked, pendingScroll: pending, rowsAligned: rows.enabled, alignment: rows, disposed });
            }, dispose });
        if (options.controls !== false) {
            stopControls = mountComparisonControls(review, referencePane.section, workingPane.section, strings);
        }
        schedule();
        return review;
    } catch (error) { dispose(); throw error; }
}
