import { Store } from "../core/observable.ts";
import { validateWorkBudget } from "../core/kernel-cursor.ts";
import type { Observable } from "../core/observable.ts";
import { createComparisonController } from "../core/comparison.ts";
import type { ComparisonBaseline, ComparisonController } from "../core/comparison.ts";
import type { DiffRange } from "../core/diff.ts";
import type { DocumentView, TabId, TabTarget, TextResourceHandle, Workspace } from "../core/workspace.ts";
import { mountEditingCandidate } from "./editing-candidate.ts";
import type { EditingCandidate } from "./editing-candidate.ts";
import type { InlineDecoration, PresentedLine, TextViewport } from "./viewport.ts";
import { createComparisonScroll } from "./comparison-scroll.ts";
import { createComparisonAlignment } from "./comparison-alignment.ts";
import type { ComparisonAlignmentSnapshot } from "./comparison-alignment.ts";

export type ComparisonReferenceView = Readonly<{ editor: EditingCandidate; target: TabTarget; epoch: number; version: string }>;
export type TextComparison = Readonly<{
    element: HTMLDivElement; controller: ComparisonController; working: EditingCandidate;
    referenceViewport: () => TextViewport | undefined;
    referenceEditor: () => EditingCandidate | undefined;
    reference: Observable<ComparisonReferenceView | undefined>;
    snapshot: () => Readonly<{ generation: number; steps: number; advances: number; maxStepMs: number; totalStepMs: number; scrollLinked: boolean; pendingScroll: boolean; rowsAligned: boolean; alignment: ComparisonAlignmentSnapshot; referenceSubscriptions: number; disposed: boolean }>;
    setScrollLinked: (linked: boolean) => void;
    setRowsAligned: (aligned: boolean) => void;
    selectHunk: (generation: number, index: number) => boolean; destroy: () => void;
}>;
/** Two independently virtualized panes. Hosts own reference retrieval, acceptance, saving and execution. */
export function mountTextComparison(host: HTMLElement, workspace: Workspace, workingTab: TabId, baseline: ComparisonBaseline,
    options: Readonly<{ ariaLabel?: string; workBudget?: number; view?: DocumentView; scrollLinked?: boolean; rowsAligned?: boolean;
        workingDecorate?: (line: PresentedLine) => readonly InlineDecoration[]; baselineDecorate?: (line: PresentedLine) => readonly InlineDecoration[] }> = {}): TextComparison {
    const requestedBudget = options.workBudget ?? 4096;
    validateWorkBudget(requestedBudget, "Comparison");
    const budget = Math.min(requestedBudget, 4096);
    if (options.scrollLinked !== undefined && typeof options.scrollLinked !== "boolean") throw new TypeError("Expected a scroll-link preference.");
    if (options.rowsAligned !== undefined && typeof options.rowsAligned !== "boolean") throw new TypeError("Expected a row-alignment preference.");
    const owner = host.ownerDocument, win = owner.defaultView;
    if (!win) throw new Error("Comparison requires an attached browser document.");
    const controller = createComparisonController(workspace, workingTab, baseline, options);
    const root = owner.createElement("div"), controls = owner.createElement("div"), panes = owner.createElement("div");
    root.className = "st-comparison"; root.setAttribute("role", "group"); root.setAttribute("aria-label", options.ariaLabel ?? "Text comparison");
    controls.className = "st-comparison-controls"; panes.className = "st-comparison-panes";
    const button = (label: string) => { const result = owner.createElement("button"); result.type = "button"; result.textContent = label; controls.append(result); return result; };
    const previous = button("Previous change"), next = button("Next change"), revert = button("Use baseline");
    const linkLabel = owner.createElement("label"), link = owner.createElement("input"); link.type = "checkbox";
    linkLabel.append(link, " Link review scrolling"); controls.append(linkLabel);
    const alignLabel = owner.createElement("label"), align = owner.createElement("input"); align.type = "checkbox"; alignLabel.append(align, " Align review rows"); controls.append(alignLabel);
    const status = owner.createElement("output"); controls.append(status);
    const pane = (label: string) => {
        const section = owner.createElement("section"), heading = owner.createElement("h3"), content = owner.createElement("div");
        heading.textContent = label; content.className = "st-comparison-editor"; section.append(heading, content); panes.append(section); return { heading, content };
    };
    const referencePane = pane("Baseline"), workingPane = pane("Working");
    const preview = owner.createElement("div"), referencePreview = owner.createElement("pre"), workingPreview = owner.createElement("pre");
    preview.className = "st-comparison-preview"; preview.setAttribute("aria-label", "Selected change with visible whitespace");
    preview.append(referencePreview, workingPreview); root.append(controls, panes, preview); host.append(root);
    let state = controller.getSnapshot(), reference: TextViewport | undefined, display: TextResourceHandle | undefined, displayTab: TabId | undefined;
    let displayTarget: TabTarget | undefined, referenceInput: EditingCandidate | undefined, referenceEvents: AbortController | undefined;
    let epoch = -1, selected = -1, selectedGeneration = -1, timer: number | undefined, disposed = false;
    let measuredGeneration = -1, steps = 0, advances = 0, maxStepMs = 0, totalStepMs = 0;
    let decoratedGeneration = -1, decoratedStatus: string | undefined;
    const listeners = new AbortController();
    const referenceScope = workspace.createNotificationScope(), referenceStore = new Store<ComparisonReferenceView | undefined>(undefined, referenceScope);
    const publishReference = (value: ComparisonReferenceView | undefined) => { const changed = new Set<Store<unknown>>(); referenceStore.set(value, changed); referenceScope.deliver([...changed]); };
    function rangeAt(side: "baseline" | "working", line: number): DiffRange | undefined {
        if (state.status !== "ready" && state.status !== "running") return;
        let low = 0, high = state.hunks.length;
        while (low < high) { const mid = (low + high) >>> 1, range = state.hunks[mid]![side]; if (Math.max(range.lineFrom + 1, range.lineTo) <= line) low = mid + 1; else high = mid; }
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
    const busy = (editor: EditingCandidate | undefined) => { const input = editor?.activity(); return !!input && (input.composing || input.pendingInput || input.pendingCommand); };
    const composing = () => working.activity().composing || referenceInput?.activity().composing === true;
    const alignment = createComparisonAlignment(win, working, () => reference, controller.getSnapshot, schedule,
        () => busy(referenceInput) || referenceInput?.activity().pendingDragScroll === true);
    const scroll = createComparisonScroll(win, working.viewport, () => reference, controller.getSnapshot, () => {
        return !busy(working) && !busy(referenceInput) && !alignment.snapshot().pending;
    });
    const setScrollLinked = (value: boolean) => { referenceScope.assertWritable(); scroll.setLinked(value); link.checked = scroll.snapshot().linked; };
    const setRowsAligned = (value: boolean) => { referenceScope.assertWritable(); const old = alignment.snapshot().enabled; alignment.setEnabled(value); align.checked = alignment.snapshot().enabled; if (value && !old) setScrollLinked(true); };
    function clearReference(): void {
        publishReference(undefined);
        referenceEvents?.abort(); referenceEvents = undefined; referenceInput?.destroy(); referenceInput = undefined; reference = undefined;
        if (displayTarget && workspace.resolveTab(displayTarget)) workspace.close(displayTarget.id);
        displayTab = undefined; displayTarget = undefined;
        if (display) { const retired = display; display = undefined; workspace.releaseResourceWhenUnowned(retired.id); }
    }
    function visible(value: string): string { return value.replaceAll(" ", "·").replaceAll("\t", "⇥").replaceAll("\r", "␍").replaceAll("\n", "↵\n"); }
    const setText = (element: HTMLElement, text: string) => { if (element.textContent !== text) element.textContent = text; };
    function render(): void {
        if (disposed) return; state = controller.getSnapshot();
        if (state.baseline && state.baseline.epoch !== epoch) {
            clearReference(); epoch = state.baseline.epoch;
            display = workspace.createTextResourceFromBuffer(workspace.createResourceKey("comparison", "baseline"), "Comparison baseline",
                { buffer: state.baseline.buffer, serverVersion: state.baseline.version }, { edit: [], save: false, run: false });
            displayTab = workspace.open({ kind: "text", documentId: display.documentId }, display.id);
            displayTarget = workspace.captureTab(displayTab);
            referenceInput = mountEditingCandidate(referencePane.content, workspace, displayTab, { ariaLabel: "Comparison baseline source", decorate: decorate("baseline"), lineClass: lineClass("baseline") });
            reference = referenceInput.viewport; referenceEvents = new AbortController();
            // Preserve the viewport focus entry point while exposing the read-only input to Tab.
            reference.element.addEventListener("focus", () => referenceInput?.focus(), { signal: referenceEvents.signal });
            referenceInput.input.addEventListener("compositionstart", schedule, { signal: referenceEvents.signal });
            referenceInput.input.addEventListener("compositionend", schedule, { signal: referenceEvents.signal });
            publishReference(Object.freeze({ editor: referenceInput, target: displayTarget, epoch, version: state.baseline.version }));
        } else if (!state.baseline && reference) clearReference();
        if (root.dataset.status !== state.status) root.dataset.status = state.status;
        link.disabled = align.disabled = !state.baseline || !state.working; alignment.update(); scroll.update();
        const generation = String(state.generation); if (root.dataset.generation !== generation) root.dataset.generation = generation;
        setText(referencePane.heading, state.baseline ? `Baseline · ${state.baseline.version}` : "Baseline unavailable");
        setText(workingPane.heading, state.working ? `Working · revision ${state.working.revision}` : "Working unavailable");
        const count = state.hunks.length; selected = selectedGeneration === state.generation ? Math.min(selected, count - 1) : -1;
        const hunk = selected >= 0 ? state.hunks[selected] : undefined;
        const layout = alignment.snapshot(), message = state.status === "ready" ? count ? `${hunk ? `Change ${selected + 1} of ${count}` : `${count} changes`}${hunk?.whitespaceOnly ? " · whitespace only" : ""}` : "No changes" : state.failure ?? `Comparison ${state.status}`;
        setText(status, message + (layout.pending ? " · preparing aligned rows" : layout.status === "failed" ? " · row alignment unavailable" : ""));
        const navigationDisabled = state.status !== "ready" || count === 0 || composing();
        for (const button of [previous, next]) if (button.disabled !== navigationDisabled) button.disabled = navigationDisabled;
        const metadata = state.working ? workspace.resource(state.working.resourceId).metadata.getSnapshot() : undefined;
        const revertDisabled = state.status !== "ready" || !hunk || !metadata?.capabilities.edit.includes("human") || metadata.editLock !== null || composing();
        if (revert.disabled !== revertDisabled) revert.disabled = revertDisabled;
        if (preview.hidden !== !hunk) preview.hidden = !hunk;
        if (hunk && state.baseline && state.working) {
            const text = (side: "baseline" | "working") => { const range = hunk[side], buffer = side === "baseline" ? state.baseline!.buffer : state.working!.buffer;
                return `${side === "baseline" ? "Baseline" : "Working"} lines ${range.lineFrom + 1}–${Math.max(range.lineFrom + 1, range.lineTo)}: ${range.from === range.to ? "∅" : visible(buffer.slice(range.from, Math.min(range.to, range.from + 160))) + (range.to - range.from > 160 ? "…" : "")}`; };
            setText(referencePreview, text("baseline")); setText(workingPreview, text("working"));
        } else { setText(referencePreview, ""); setText(workingPreview, ""); }
        // Progress-only publications change no decorations. Selection and scroll invalidate
        // their own viewports; redraw hunks once on restart, completion or expiration.
        if (state.generation !== decoratedGeneration || state.status !== decoratedStatus) {
            decoratedGeneration = state.generation; decoratedStatus = state.status;
            reference?.invalidate(); working.viewport.invalidate();
        }
    }
    function schedule(): void { if (!disposed && timer === undefined) timer = win!.setTimeout(step, 0); }
    function step(): void {
        timer = undefined; if (disposed) return;
        const current = controller.getSnapshot();
        if (current.status === "running") {
            if (measuredGeneration !== current.generation) { measuredGeneration = current.generation; steps = advances = maxStepMs = totalStepMs = 0; }
            const start = win!.performance.now(); let count = 0;
            do { controller.advance(budget); count++; advances++; }
            // Cheap advances may share a task; the elapsed-time budget still yields to input.
            while (controller.getSnapshot().status === "running" && count < 32 && win!.performance.now() - start < 4);
            const elapsed = win!.performance.now() - start;
            steps++; totalStepMs += elapsed; maxStepMs = Math.max(maxStepMs, elapsed);
        }
        render(); if (controller.getSnapshot().status === "running") schedule();
    }
    function selectHunk(generation: number, index: number): boolean {
        referenceScope.assertWritable();
        const current = controller.getSnapshot();
        if (disposed || composing() || current.status !== "ready" || current.generation !== generation || !Number.isSafeInteger(index)) return false;
        const hunk = current.hunks[index]; if (!hunk || !current.working || !reference) return false;
        selected = index; selectedGeneration = generation; const document = reference.view.getSnapshot();
        reference.view.setSelection(document.revision, { anchor: hunk.baseline.from, head: hunk.baseline.to });
        controller.view.setSelection(current.working.revision, { anchor: hunk.working.from, head: hunk.working.to });
        reference.view.folding.reveal(reference.view.folding.getSnapshot(), hunk.baseline.from, hunk.baseline.to);
        working.view.folding.reveal(working.view.folding.getSnapshot(), hunk.working.from, hunk.working.to);
        reference.revealOffset(hunk.baseline.from); working.viewport.revealOffset(hunk.working.from); render(); return true;
    }
    previous.addEventListener("click", () => selectHunk(state.generation, (selected < 0 ? state.hunks.length - 1 : selected - 1 + state.hunks.length) % state.hunks.length), { signal: listeners.signal });
    next.addEventListener("click", () => selectHunk(state.generation, (selected + 1) % state.hunks.length), { signal: listeners.signal });
    revert.addEventListener("click", () => { if (!composing()) controller.revert(state.generation, selected); }, { signal: listeners.signal });
    working.input.addEventListener("compositionstart", schedule, { signal: listeners.signal }); working.input.addEventListener("compositionend", schedule, { signal: listeners.signal });
    link.addEventListener("change", () => setScrollLinked(link.checked), { signal: listeners.signal });
    align.addEventListener("change", () => setRowsAligned(align.checked), { signal: listeners.signal });
    // A document notification can paint the working viewport before the scheduled controls.
    // Decoration queries must already see the mapped capture for that same revision.
    const unsubscribe = controller.subscribe(() => { state = controller.getSnapshot(); schedule(); }),
        stopMetadata = workspace.resourceForDocument(controller.view.documentId).metadata.subscribe(schedule);
    function destroy(): void {
        if (disposed) return; referenceScope.assertWritable(); disposed = true; if (timer !== undefined) win!.clearTimeout(timer);
        try {
            unsubscribe(); stopMetadata(); listeners.abort(); scroll.dispose(); alignment.dispose();
            try { working.destroy(); } finally { clearReference(); }
        } finally {
            try { controller.dispose(); } finally { state = controller.getSnapshot(); selected = -1; root.remove(); }
        }
    }
    try { render(); setRowsAligned(options.rowsAligned ?? false); setScrollLinked(options.scrollLinked ?? options.rowsAligned ?? false); schedule(); } catch (error) { destroy(); throw error; }
    return Object.freeze({ element: root, controller, working, referenceViewport: () => reference, referenceEditor: () => referenceInput, reference: referenceStore.observable, selectHunk, setScrollLinked, setRowsAligned,
        snapshot: () => Object.freeze({ generation: measuredGeneration, steps, advances, maxStepMs, totalStepMs, scrollLinked: scroll.snapshot().linked, pendingScroll: scroll.snapshot().pending, rowsAligned: alignment.snapshot().enabled, alignment: alignment.snapshot(), referenceSubscriptions: referenceScope.subscriptionCount(), disposed }), destroy });
}
