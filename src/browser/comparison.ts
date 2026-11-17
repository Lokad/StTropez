import { Store } from "../core/observable.ts";
import { validateWorkBudget } from "../core/kernel-cursor.ts";
import { partitionPoint } from "../core/bound-search.ts";
import type { Observable } from "../core/observable.ts";
import { createComparisonController } from "../core/comparison.ts";
import type { ComparisonBaseline, ComparisonController, ComparisonSnapshot } from "../core/comparison.ts";
import type { DiffRange } from "../core/diff.ts";
import type { DocumentView, TabId, TabTarget, TextResourceHandle, Workspace } from "../core/workspace.ts";
import { mountEditingCandidate } from "./editing-candidate.ts";
import type { EditingCandidate } from "./editing-candidate.ts";
import type { InlineDecoration, PresentedLine, TextViewport } from "./viewport.ts";
import { createComparisonScroll } from "./comparison-scroll.ts";
import { createComparisonAlignment } from "./comparison-alignment.ts";
import type { ComparisonAlignmentSnapshot } from "./comparison-alignment.ts";
import { mountComparisonControls } from "./comparison-controls.ts";
import { createComparisonPanes } from "./comparison-panes.ts";
import { createCooperativeRunner } from "./cooperative-runner.ts";

export type ComparisonReferenceView = Readonly<{ editor: EditingCandidate; target: TabTarget; epoch: number; version: string }>;
export type TextComparisonSnapshot = Readonly<{
    comparison: ComparisonSnapshot;
    /** Index in comparison.hunks; cleared when the comparison generation changes. */
    selectedHunk: number | null;
    canNavigate: boolean; canRevert: boolean;
    scrollLinked: boolean; alignment: ComparisonAlignmentSnapshot; disposed: boolean;
}>;
export type TextComparison = Readonly<{
    element: HTMLDivElement; controller: ComparisonController; working: EditingCandidate;
    referenceViewport: () => TextViewport | undefined;
    referenceEditor: () => EditingCandidate | undefined;
    reference: Observable<ComparisonReferenceView | undefined>;
    state: Observable<TextComparisonSnapshot>;
    snapshot: () => Readonly<{ generation: number; steps: number; advances: number; maxStepMs: number; totalStepMs: number; scrollLinked: boolean; pendingScroll: boolean; rowsAligned: boolean; alignment: ComparisonAlignmentSnapshot; referenceSubscriptions: number; disposed: boolean }>;
    setScrollLinked: (linked: boolean) => void;
    setRowsAligned: (aligned: boolean) => void;
    selectHunk: (generation: number, index: number) => boolean;
    revertHunk: (generation: number, index: number) => boolean; destroy: () => void;
}>;
/** Two independently virtualized panes. Hosts own reference retrieval, acceptance, saving and execution. */
export function mountTextComparison(host: HTMLElement, workspace: Workspace, workingTab: TabId, baseline: ComparisonBaseline,
    options: Readonly<{ ariaLabel?: string; workBudget?: number; view?: DocumentView; controls?: boolean; scrollLinked?: boolean; rowsAligned?: boolean;
        workingDecorate?: (line: PresentedLine) => readonly InlineDecoration[]; baselineDecorate?: (line: PresentedLine) => readonly InlineDecoration[] }> = {}): TextComparison {
    const requestedBudget = options.workBudget ?? 4096;
    validateWorkBudget(requestedBudget, "Comparison");
    const budget = Math.min(requestedBudget, 4096);
    if (options.scrollLinked !== undefined && typeof options.scrollLinked !== "boolean") throw new TypeError("Expected a scroll-link preference.");
    if (options.rowsAligned !== undefined && typeof options.rowsAligned !== "boolean") throw new TypeError("Expected a row-alignment preference.");
    if (options.controls !== undefined && typeof options.controls !== "boolean") throw new TypeError("Expected a default-controls preference.");
    const owner = host.ownerDocument, win = owner.defaultView;
    if (!win) throw new Error("Comparison requires an attached browser document.");
    const controller = createComparisonController(workspace, workingTab, baseline, options), runner = createCooperativeRunner(win);
    const root = owner.createElement("div"), panes = owner.createElement("div");
    root.className = "st-comparison"; root.setAttribute("role", "group"); root.setAttribute("aria-label", options.ariaLabel ?? "Text comparison");
    panes.className = "st-comparison-panes";
    const pane = () => {
        const section = owner.createElement("section"), content = owner.createElement("div");
        content.className = "st-comparison-editor"; section.append(content); panes.append(section); return { section, content };
    };
    const referencePane = pane(), workingPane = pane();
    root.append(panes); host.append(root);
    let state = controller.getSnapshot(), display: TextResourceHandle | undefined, displayTab: TabId | undefined;
    let displayTarget: TabTarget | undefined;
    let epoch = -1, selected = -1, selectedGeneration = -1, scheduled = false, disposed = false;
    let measuredGeneration = -1, steps = 0, advances = 0, maxStepMs = 0, totalStepMs = 0;
    let decoratedGeneration = -1, decoratedStatus: string | undefined;
    const referenceScope = workspace.createNotificationScope(), referenceStore = new Store<ComparisonReferenceView | undefined>(undefined, referenceScope);
    const publishReference = (value: ComparisonReferenceView | undefined) => { referenceScope.publish(referenceStore, value); };
    function rangeAt(side: "baseline" | "working", line: number): DiffRange | undefined {
        if (state.status !== "ready" && state.status !== "running") return;
        const low = partitionPoint(state.hunks.length, index => { const range = state.hunks[index]![side]; return Math.max(range.lineFrom + 1, range.lineTo) <= line; });
        const range = state.hunks[low]?.[side]; return range && range.lineFrom <= line ? range : undefined;
    }
    const decorate = (side: "baseline" | "working") => (line: PresentedLine): readonly InlineDecoration[] => {
        const decorations = (side === "working" ? options.workingDecorate : options.baselineDecorate)?.(line) ?? [];
        if (side === "working" && line.revision !== state.working?.revision) return decorations;
        const range = rangeAt(side, line.line);
        if (!range || range.from === range.to || range.from >= line.to || range.to <= line.from) return decorations;
        return [...decorations, { from: range.from, to: range.to, className: side === "baseline" ? "st-comparison-removed" : "st-comparison-added" }];
    };
    const lineClass = (side: "baseline" | "working") => (line: PresentedLine) => (side !== "working" || line.revision === state.working?.revision) && rangeAt(side, line.line) ? `st-comparison-line-${side}` : undefined;
    let working: EditingCandidate;
    try { working = mountEditingCandidate(workingPane.content, workspace, workingTab, { view: controller.view, ariaLabel: "Comparison working source", decorate: decorate("working"), lineClass: lineClass("working") }); }
    catch (error) { root.remove(); controller.dispose(); throw error; }
    const pair = createComparisonPanes(working, changed), referenceEditor = pair.reference, referenceViewport = () => referenceEditor()?.viewport;
    const busy = (editor: EditingCandidate | undefined) => { const input = editor?.activity(); return !!input && (input.composing || input.pendingInput || input.pendingCommand); };
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
    const setScrollLinked = (value: boolean) => { referenceScope.assertWritable(); scroll.setLinked(value); publishState(); };
    const setRowsAligned = (value: boolean) => {
        referenceScope.assertWritable();
        if (typeof value !== "boolean") throw new TypeError("Expected a row-alignment preference.");
        if (value && !alignment.snapshot().enabled) scroll.setLinked(true);
        alignment.setEnabled(value); publishState();
    };
    function clearReference(): void {
        publishReference(undefined);
        const retiredEditor = referenceEditor(); try { pair.setReference(undefined); } finally { retiredEditor?.destroy(); }
        if (displayTarget && workspace.resolveTab(displayTarget)) workspace.close(displayTarget.id);
        displayTab = undefined; displayTarget = undefined;
        if (display) { const retired = display; display = undefined; workspace.releaseResourceWhenUnowned(retired.id); }
    }
    function render(): void {
        if (disposed) return; state = controller.getSnapshot();
        if (state.baseline && state.baseline.epoch !== epoch) {
            clearReference(); epoch = state.baseline.epoch;
            display = workspace.createTextResourceFromBuffer(workspace.createResourceKey("comparison", "baseline"), "Comparison baseline",
                { buffer: state.baseline.buffer, serverVersion: state.baseline.version }, { edit: [], save: false, run: false }, { visibility: "internal" });
            displayTab = workspace.open({ kind: "text", documentId: display.documentId }, display.id);
            displayTarget = workspace.captureTab(displayTab);
            const editor = mountEditingCandidate(referencePane.content, workspace, displayTab, { ariaLabel: "Comparison baseline source", decorate: decorate("baseline"), lineClass: lineClass("baseline") });
            try { pair.setReference(editor); } catch (error) { editor.destroy(); throw error; }
            publishReference(Object.freeze({ editor, target: displayTarget, epoch, version: state.baseline.version }));
        } else if (!state.baseline && referenceViewport()) clearReference();
        if (root.dataset.status !== state.status) root.dataset.status = state.status;
        alignment.update(); scroll.update();
        const generation = String(state.generation); if (root.dataset.generation !== generation) root.dataset.generation = generation;
        publishState();
        // Progress-only publications change no decorations. Selection and scroll invalidate
        // their own viewports; redraw hunks once on restart, completion or expiration.
        if (state.generation !== decoratedGeneration || state.status !== decoratedStatus) {
            decoratedGeneration = state.generation; decoratedStatus = state.status;
            referenceViewport()?.invalidate(); working.viewport.invalidate();
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
        referenceScope.assertWritable();
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
    function revertHunk(generation: number, index: number): boolean {
        referenceScope.assertWritable();
        if (disposed || composing() || working.input.readOnly || working.input.disabled) return false;
        return controller.revert(generation, index);
    }
    // A document notification can paint the working viewport before the scheduled controls.
    // Decoration queries must already see the mapped capture for that same revision.
    const unsubscribe = controller.subscribe(() => { state = controller.getSnapshot(); changed(); }),
        stopMetadata = workspace.resourceForDocument(controller.view.documentId).metadata.subscribe(changed);
    function destroy(): void {
        if (disposed) return; referenceScope.assertWritable(); disposed = true; runner.cancel(); scheduled = false;
        try {
            unsubscribe(); stopMetadata(); scroll.dispose(); alignment.dispose();
            try { clearReference(); } finally { pair.dispose(); working.destroy(); }
        } finally {
            try { controller.dispose(); } finally { state = controller.getSnapshot(); selected = -1; publishState(); stopControls?.(); root.remove(); }
        }
    }
    try {
        render(); setRowsAligned(options.rowsAligned ?? false); setScrollLinked(options.scrollLinked ?? options.rowsAligned ?? false);
        if (options.controls !== false) stopControls = mountComparisonControls({ element: root, state: stateStore.observable, selectHunk, revertHunk, setScrollLinked, setRowsAligned }, referencePane.section, workingPane.section);
        schedule();
    } catch (error) { destroy(); throw error; }
    return Object.freeze({ element: root, controller, working, referenceViewport, referenceEditor, reference: referenceStore.observable, state: stateStore.observable, selectHunk, revertHunk, setScrollLinked, setRowsAligned,
        snapshot: () => Object.freeze({ generation: measuredGeneration, steps, advances, maxStepMs, totalStepMs, scrollLinked: scroll.snapshot().linked, pendingScroll: scroll.snapshot().pending, rowsAligned: alignment.snapshot().enabled, alignment: alignment.snapshot(), referenceSubscriptions: referenceScope.subscriptionCount(), disposed }), destroy });
}
