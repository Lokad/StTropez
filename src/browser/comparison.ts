import { Store } from "../core/observable.ts";
import { validateWorkBudget } from "../core/kernel-cursor.ts";
import { partitionPoint } from "../core/bound-search.ts";
import type { Observable } from "../core/observable.ts";
import { compareText } from "../core/comparison.ts";
import type { ComparisonBaseline, ComparisonController, ComparisonHunk, ComparisonSnapshot } from "../core/comparison.ts";
import type { DiffRange } from "../core/diff.ts";
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
    /** Index in comparison.hunks; cleared when the comparison generation changes. */
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
    hunkAt: (index: number) => TextComparisonHunk | undefined; dispose: () => void;
}>;
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
    let epoch = -1, selected = -1, selectedGeneration = -1, scheduled = false, disposed = false;
    let measuredGeneration = -1, steps = 0, advances = 0, maxStepMs = 0, totalStepMs = 0;
    let decoratedGeneration = -1, decoratedStatus: string | undefined;
    function rangeAt(side: "baseline" | "working", line: number): DiffRange | undefined {
        if (state.status !== "ready" && state.status !== "running") return;
        const low = partitionPoint(state.hunks.length, index => { const range = state.hunks[index]![side]; return Math.max(range.lineFrom + 1, range.lineTo) <= line; });
        const range = state.hunks[low]?.[side]; return range && range.lineFrom <= line ? range : undefined;
    }
    const decorate = (side: "baseline" | "working") => (line: PresentedLine): readonly InlineDecoration[] => {
        if (side === "working" && line.revision !== state.working?.revision) return [];
        const range = rangeAt(side, line.line);
        if (!range) return [];
        if (range.from === range.to) {
            let at = range.from;
            const buffer = state[side]!.buffer;
            // A position between CR and LF shares the painted end of the line.
            if (at === line.to + 1 && at < buffer.length && buffer.slice(line.to, at + 1) === "\r\n") at = line.to;
            return at >= line.from && at <= line.to ? [{ from: at, to: at, className: "st-comparison-anchor" }] : [];
        }
        if (range.from >= line.to || range.to <= line.from) return [];
        return [{ from: range.from, to: range.to, className: side === "baseline" ? "st-comparison-removed" : "st-comparison-added" }];
    };
    const lineClass = (side: "baseline" | "working") => (line: PresentedLine) => {
        if (side === "working" && line.revision !== state.working?.revision) return;
        const range = rangeAt(side, line.line);
        return range && range.from < range.to ? `st-comparison-line-${side}` : undefined;
    };
    const paneOptions = { ...(options.settings ? { settings: options.settings } : {}), ...(options.requestLine ? { requestLine: options.requestLine } : {}) };
    let workingMount: MountedTextEditor;
    try { workingMount = mountEditor(workingPane.content, workspace, identity, { view: controller.view, ...paneOptions, ariaLabel: "Comparison working source" }); }
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
    const stateScope = workspace.createNotificationScope(), stateStore = new Store(captureState(), stateScope);
    let stopControls: (() => void) | undefined;
    function captureState(): TextComparisonSnapshot {
        const comparison = controller.getSnapshot(), ready = !disposed && comparison.status === "ready";
        const selectedHunk = selectedGeneration === comparison.generation && comparison.hunks[selected] ? selected : null;
        const canNavigate = ready && comparison.hunks.length > 0 && !!referenceViewport() && epoch === comparison.baseline?.epoch && !composing();
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
                { buffer: state.baseline.buffer, serverVersion: state.baseline.version }, { edit: [], save: false, run: false }, { visibility: "internal" });
            const referenceId = typeof baseline === "string" ? baseline : display!.documentId;
            const mounted = mountEditor(referencePane.content, workspace, referenceId, { ariaLabel: "Comparison baseline source", readOnly: true, ...paneOptions });
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
        selected = index; selectedGeneration = generation; const document = reference.view.getSnapshot();
        reference.view.setSelection(document.revision, { anchor: hunk.baseline.from, head: hunk.baseline.to });
        controller.view.setSelection(current.working.revision, { anchor: hunk.working.from, head: hunk.working.to });
        reference.view.folding.reveal(reference.view.folding.getSnapshot(), hunk.baseline.from, hunk.baseline.to);
        working.view.folding.reveal(working.view.folding.getSnapshot(), hunk.working.from, hunk.working.to);
        reference.revealOffset(hunk.baseline.from); working.viewport.revealOffset(hunk.working.from); render(); return true;
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
            try { controller.dispose(); } finally { state = controller.getSnapshot(); selected = -1; publishState(); stopControls?.(); root.remove(); }
        }
    }
    try {
        render(); setRowsAligned(options.rowsAligned ?? false); setScrollLinked(options.scrollLinked ?? options.rowsAligned ?? false);
        const reference = referenceEditor();
        if (!reference) throw new Error("Comparison reference expired during mount.");
        const editors = Object.freeze({ working, reference });
        let active = working;
        for (const editor of Object.values(editors))
            editor.element.addEventListener("focusin", () => { active = editor; }, { signal: editor.signal });
        const review: TextComparison = Object.freeze({ element: root, controller, panes: editors, activePane: () => active, ...stateStore.observable, hunkAt, setScrollLinked, setRowsAligned,
            getDiagnostics: () => Object.freeze({ generation: measuredGeneration, steps, advances, maxStepMs, totalStepMs, scrollLinked: scroll.snapshot().linked, pendingScroll: scroll.snapshot().pending, rowsAligned: alignment.snapshot().enabled, alignment: alignment.snapshot(), disposed }), dispose });
        if (options.controls !== false) stopControls = mountComparisonControls(review, referencePane.section, workingPane.section);
        schedule();
        return review;
    } catch (error) { dispose(); throw error; }
}
