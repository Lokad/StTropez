import { Store } from "../core/observable.ts";
import { validateWorkBudget } from "../core/kernel-cursor.ts";
import { partitionPoint } from "../core/bound-search.ts";
import type { Observable } from "../core/observable.ts";
import { compareText } from "../core/comparison.ts";
import type { ComparisonBaseline, ComparisonController, ComparisonHunk, ComparisonSnapshot } from "../core/comparison.ts";
import { lineContentEnd } from "../core/newlines.ts";
import { splitsSurrogatePair } from "../core/utf16.ts";
import type { DiffHunk } from "../core/diff.ts";
import type { TextBuffer } from "../core/text-buffer.ts";
import type { DocumentId, DocumentView, TabId, TextResourceHandle, Workspace } from "../core/workspace.ts";
import { mountEditor } from "./text-editor.ts";
import type { EditorSettings, MountedTextEditor, TextEditor, TextEditorOptions } from "./text-editor.ts";
import type { InlineDecoration, PresentedLine } from "./viewport.ts";
import { createComparisonScroll } from "./comparison-scroll.ts";
import { createComparisonAlignment } from "./comparison-alignment.ts";
import type { ComparisonAlignmentSnapshot } from "./comparison-alignment.ts";
import { mountComparisonControls } from "./comparison-controls.ts";
import { createComparisonPanes } from "./comparison-panes.ts";
import { createCooperativeRunner } from "./cooperative-runner.ts";

export type TextComparisonOptions = Readonly<{ ariaLabel?: string; workBudget?: number; view?: DocumentView; controls?: boolean; scrollLinked?: boolean; rowsAligned?: boolean; settings?: EditorSettings;
    requestLine?: NonNullable<TextEditorOptions["requestLine"]> }>;
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
    element: HTMLDivElement; controller: ComparisonController;
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
    const owner = host.ownerDocument, win = owner.defaultView;
    if (!win) throw new Error("Comparison requires an attached browser document.");
    let display: TextResourceHandle | undefined;
    const controller = compareText(workspace, identity, baseline, options, typeof baseline === "string" ? undefined : next =>
        !!display && workspace.adoptSaved(display.id, { text: next.buffer, serverVersion: next.version, history: "reset" }).applied);
    const runner = createCooperativeRunner(win);
    const root = owner.createElement("div"), panes = owner.createElement("div");
    root.className = "st-comparison"; root.setAttribute("role", "group"); root.setAttribute("aria-label", options.ariaLabel ?? "Text comparison");
    panes.className = "st-comparison-panes";
    const pane = () => {
        const section = owner.createElement("section"), content = owner.createElement("div");
        content.className = "st-comparison-editor"; section.append(content); panes.append(section); return { section, content };
    };
    const referencePane = pane(), workingPane = pane();
    root.append(panes); host.append(root);
    let state = controller.getSnapshot();
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
    const foldContainsChange = (side: "baseline" | "working") => (buffer: TextBuffer, from: number, to: number) =>
        state[side]?.buffer === buffer && firstHunkInLines(side, from, to) !== undefined;
    let workingMount: MountedTextEditor;
    try { workingMount = mountEditor(workingPane.content, workspace, identity, { view: controller.view, ...paneOptions, ariaLabel: "Comparison working source" }, foldContainsChange("working")); }
    catch (error) { root.remove(); controller.dispose(); throw error; }
    const working = workingMount.editor, pair = createComparisonPanes(workingMount, changed), referenceEditor = () => pair.reference()?.editor, referenceViewport = () => referenceEditor()?.viewport;
    const differences = (editor: TextEditor, side: "working" | "baseline") => editor.decorations.addProvider({
        name: "comparison", order: 10, provide: decorate(side), lineClass: lineClass(side)
    });
    const workingDiff = differences(working, "working");
    let referenceDiff: ReturnType<typeof differences> | undefined;
    const busy = (editor: TextEditor | undefined) => { const input = editor?.activity(); return !!input && (input.composing || input.pendingInput || input.pendingCommand); };
    const composing = () => working.activity().composing || referenceEditor()?.activity().composing === true;
    const alignment = createComparisonAlignment(win, pair, controller.getSnapshot, changed,
        () => busy(referenceEditor()) || referenceEditor()?.activity().pendingDragScroll === true);
    const scroll = createComparisonScroll(win, pair, controller.getSnapshot, () => {
        return !busy(working) && !busy(referenceEditor()) && !alignment.snapshot().pending;
    });
    let active = working;
    function caretPosition(comparison: ComparisonSnapshot) {
        const side = active === working ? "working" : "baseline";
        const { head, anchor } = active.view.getSnapshot().selection;
        const next = partitionPoint(comparison.hunks.length, i => comparison.hunks[i]![side].from <= head);
        const range = comparison.hunks[next - 1]?.[side];
        // A selected hunk ends at its exclusive boundary. A collapsed caret there is between changes.
        const selected = range && (head < range.to || head === range.to && (head === range.from || anchor === range.from))
            ? next - 1 : null;
        return { next, selected };
    }
    const stateScope = workspace.createNotificationScope(), stateStore = new Store(captureState(), stateScope);
    let stopControls: (() => void) | undefined;
    function captureState(): TextComparisonSnapshot {
        const comparison = controller.getSnapshot(), ready = !disposed && comparison.status === "ready";
        const canNavigate = ready && comparison.hunks.length > 0 && !!referenceViewport() && epoch === comparison.baseline?.epoch && !composing();
        const selectedHunk = ready && epoch === comparison.baseline?.epoch && comparison.hunks.length ? caretPosition(comparison).selected : null;
        const metadata = comparison.working ? workspace.resource(comparison.working.resourceId).metadata.getSnapshot() : undefined;
        const canRevert = canNavigate && selectedHunk !== null && !working.input.readOnly && !working.input.disabled
            && metadata?.capabilities.edit.includes("human") === true && metadata.editLock === null;
        return Object.freeze({ comparison, selectedHunk, canNavigate, canRevert, scrollLinked: scroll.snapshot().linked, alignment: alignment.snapshot(), disposed });
    }
    function publishState(): void {
        const next = captureState(), old = stateStore.get(), a = old.alignment, b = next.alignment;
        const sameAlignment = a.enabled === b.enabled && a.status === b.status && a.pending === b.pending && a.work === b.work && a.runs === b.runs && a.failure === b.failure;
        if (old.comparison === next.comparison && old.selectedHunk === next.selectedHunk && old.canNavigate === next.canNavigate
            && old.canRevert === next.canRevert && old.scrollLinked === next.scrollLinked && old.disposed === next.disposed && sameAlignment) return;
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
        if (disposed) return; state = controller.getSnapshot();
        if (state.baseline && !referenceEditor()) {
            if (typeof baseline !== "string") display = workspace.createTextResourceFromBuffer(workspace.createResourceKey("comparison", "baseline"), "Comparison baseline",
                { buffer: state.baseline.buffer, serverVersion: state.baseline.version }, { edit: [], save: false }, { visibility: "internal" });
            const referenceId = typeof baseline === "string" ? baseline : display!.documentId;
            const mounted = mountEditor(referencePane.content, workspace, referenceId, { ariaLabel: "Comparison baseline source", readOnly: true, ...paneOptions }, foldContainsChange("baseline"));
            const editor = mounted.editor;
            referenceDiff = differences(editor, "baseline");
            try { pair.setReference(mounted); } catch (error) { editor.dispose(); throw error; }
        } else if (!state.baseline && referenceViewport()) clearReference();
        epoch = state.baseline?.epoch ?? -1;
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
        const current = controller.getSnapshot();
        if (current.status === "running") {
            if (measuredGeneration !== current.generation) { measuredGeneration = current.generation; steps = advances = maxStepMs = totalStepMs = 0; }
            const start = win!.performance.now();
            runner.slice(() => { const next = controller.advance(budget); advances++; return next; },
                next => !disposed && next.status === "running" && next.generation === current.generation, 32);
            const elapsed = win!.performance.now() - start;
            steps++; totalStepMs += elapsed; maxStepMs = Math.max(maxStepMs, elapsed);
        }
        render(); if (controller.getSnapshot().status === "running") schedule();
    }
    function selectHunk(generation: number, index: number): boolean {
        stateScope.assertWritable();
        const current = controller.getSnapshot(), reference = referenceViewport();
        if (disposed || composing() || current.status !== "ready" || current.generation !== generation || !Number.isSafeInteger(index)) return false;
        const hunk = current.hunks[index]; if (!hunk || !current.working || !reference || epoch !== current.baseline?.epoch) return false;
        const document = reference.view.getSnapshot();
        const revision = current.working.revision;
        stateScope.batch(() => {
            reference.view.setSelection(document.revision, { anchor: hunk.baseline.from, head: hunk.baseline.to });
            controller.view.setSelection(revision, { anchor: hunk.working.from, head: hunk.working.to });
            reference.view.folding.reveal(reference.view.folding.getSnapshot(), hunk.baseline.from, hunk.baseline.to);
            working.view.folding.reveal(working.view.folding.getSnapshot(), hunk.working.from, hunk.working.to);
        });
        reference.revealOffset(hunk.baseline.from); working.viewport.revealOffset(hunk.working.from); render(); return true;
    }
    function navigateHunk(direction: -1 | 1): boolean {
        stateScope.assertWritable();
        const current = stateStore.get();
        if (!current.canNavigate || direction !== 1 && direction !== -1) return false;
        const { next, selected } = caretPosition(current.comparison), count = current.comparison.hunks.length;
        const index = direction === 1 ? next % count : ((selected ?? next) + count - 1) % count;
        return selectHunk(current.comparison.generation, index);
    }
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
        const generation = controller.getSnapshot().generation;
        return Object.freeze({ ...hunk, select: () => selectHunk(generation, index), revert: () => {
            stateScope.assertWritable();
            return !disposed && !composing() && !working.input.readOnly && !working.input.disabled && hunk.revert();
        } });
    }
    // A document notification can paint the working viewport before the scheduled controls.
    // Decoration queries must already see the mapped capture for that same revision.
    const unsubscribe = controller.subscribe(() => { state = controller.getSnapshot(); changed(); }),
        stopMetadata = workspace.resourceForDocument(controller.view.documentId).metadata.subscribe(changed);
    function dispose(): void {
        if (disposed) return; stateScope.assertWritable(); disposed = true; runner.cancel(); scheduled = false;
        try {
            unsubscribe(); stopMetadata(); scroll.dispose(); alignment.dispose();
            try { clearReference(); } finally { pair.dispose(); working.dispose(); }
        } finally {
            try { controller.dispose(); } finally { state = controller.getSnapshot(); publishState(); stopControls?.(); root.remove(); }
        }
    }
    try {
        render(); setRowsAligned(options.rowsAligned ?? false); setScrollLinked(options.scrollLinked ?? options.rowsAligned ?? false);
        const reference = referenceEditor();
        if (!reference) throw new Error("Comparison reference expired during mount.");
        const editors = Object.freeze({ working, reference });
        for (const editor of Object.values(editors)) {
            const stop = editor.view.subscribe(() => { if (active === editor && !disposed) publishState(); });
            editor.signal.addEventListener("abort", stop, { once: true });
            editor.element.addEventListener("focusin", () => { active = editor; publishState(); }, { signal: editor.signal });
            editor.input.addEventListener("keydown", event => {
                if (event.key === "F7" && !event.defaultPrevented && !event.isComposing && event.keyCode !== 229
                    && !event.altKey && !event.metaKey && !event.ctrlKey && navigateHunk(event.shiftKey ? -1 : 1)) event.preventDefault();
            }, { signal: editor.signal });
        }
        const review: TextComparison = Object.freeze({ element: root, controller, panes: editors, activePane: () => active, ...stateStore.observable, navigateHunk, revertSelectedHunk, hunkAt, setScrollLinked, setRowsAligned,
            getDiagnostics: () => Object.freeze({ generation: measuredGeneration, steps, advances, maxStepMs, totalStepMs, scrollLinked: scroll.snapshot().linked, pendingScroll: scroll.snapshot().pending, rowsAligned: alignment.snapshot().enabled, alignment: alignment.snapshot(), disposed }), dispose });
        if (options.controls !== false) stopControls = mountComparisonControls(review, referencePane.section, workingPane.section);
        schedule();
        return review;
    } catch (error) { dispose(); throw error; }
}
