import { createComparisonController } from "../core/comparison.ts";
import type { ComparisonBaseline, ComparisonController } from "../core/comparison.ts";
import type { DiffRange } from "../core/diff.ts";
import type { DocumentView, TabId, TabTarget, TextResourceHandle, Workspace } from "../core/workspace.ts";
import { mountEditingCandidate } from "./editing-candidate.ts";
import type { EditingCandidate } from "./editing-candidate.ts";
import { mountTextViewport } from "./viewport.ts";
import type { InlineDecoration, PresentedLine, TextViewport } from "./viewport.ts";

export type TextComparison = Readonly<{
    element: HTMLDivElement; controller: ComparisonController; working: EditingCandidate;
    referenceViewport: () => TextViewport | undefined;
    snapshot: () => Readonly<{ generation: number; steps: number; advances: number; maxStepMs: number; totalStepMs: number; disposed: boolean }>;
    selectHunk: (generation: number, index: number) => boolean; destroy: () => void;
}>;
let nextMount = 0;
/** Two independently virtualized panes. Hosts own reference retrieval, acceptance, saving and execution. */
export function mountTextComparison(host: HTMLElement, workspace: Workspace, workingTab: TabId, baseline: ComparisonBaseline,
    options: Readonly<{ ariaLabel?: string; workBudget?: number; view?: DocumentView }> = {}): TextComparison {
    const budget = options.workBudget ?? 32768;
    if (!Number.isSafeInteger(budget) || budget < 512) throw new RangeError("Comparison budget must be at least 512.");
    const owner = host.ownerDocument, win = owner.defaultView;
    if (!win) throw new Error("Comparison requires an attached browser document.");
    const controller = createComparisonController(workspace, workingTab, baseline, options), mount = ++nextMount;
    const root = owner.createElement("div"), controls = owner.createElement("div"), panes = owner.createElement("div");
    root.className = "st-comparison"; root.setAttribute("role", "group"); root.setAttribute("aria-label", options.ariaLabel ?? "Text comparison");
    controls.className = "st-comparison-controls"; panes.className = "st-comparison-panes";
    const button = (label: string) => { const result = owner.createElement("button"); result.type = "button"; result.textContent = label; controls.append(result); return result; };
    const previous = button("Previous change"), next = button("Next change"), revert = button("Use baseline");
    const status = owner.createElement("output"); status.setAttribute("aria-live", "polite"); controls.append(status);
    const pane = (label: string) => {
        const section = owner.createElement("section"), heading = owner.createElement("h3"), content = owner.createElement("div");
        heading.textContent = label; content.className = "st-comparison-editor"; section.append(heading, content); panes.append(section); return { heading, content };
    };
    const referencePane = pane("Baseline"), workingPane = pane("Working");
    const preview = owner.createElement("div"), referencePreview = owner.createElement("pre"), workingPreview = owner.createElement("pre");
    preview.className = "st-comparison-preview"; preview.setAttribute("aria-label", "Selected change with visible whitespace");
    preview.append(referencePreview, workingPreview); root.append(controls, panes, preview); host.append(root);
    let state = controller.getSnapshot(), reference: TextViewport | undefined, display: TextResourceHandle | undefined, displayTab: TabId | undefined;
    let displayTarget: TabTarget | undefined;
    let epoch = -1, selected = -1, selectedGeneration = -1, timer: number | undefined, disposed = false;
    let measuredGeneration = -1, steps = 0, advances = 0, maxStepMs = 0, totalStepMs = 0;
    let decoratedGeneration = -1, decoratedStatus: string | undefined;
    const listeners = new AbortController();
    function rangeAt(side: "baseline" | "working", line: number): DiffRange | undefined {
        if (state.status !== "ready") return;
        let low = 0, high = state.hunks.length;
        while (low < high) { const mid = (low + high) >>> 1, range = state.hunks[mid]![side]; if (Math.max(range.lineFrom + 1, range.lineTo) <= line) low = mid + 1; else high = mid; }
        const range = state.hunks[low]?.[side]; return range && range.lineFrom <= line ? range : undefined;
    }
    const decorate = (side: "baseline" | "working") => (line: PresentedLine): readonly InlineDecoration[] => {
        if (side === "working" && line.revision !== state.working?.revision) return [];
        const range = rangeAt(side, line.line);
        if (!range || range.from === range.to || range.from >= line.to || range.to <= line.from) return [];
        return [{ from: range.from, to: range.to, className: side === "baseline" ? "st-comparison-removed" : "st-comparison-added" }];
    };
    const lineClass = (side: "baseline" | "working") => (line: PresentedLine) => (side !== "working" || line.revision === state.working?.revision) && rangeAt(side, line.line) ? `st-comparison-line-${side}` : undefined;
    let working: EditingCandidate;
    try { working = mountEditingCandidate(workingPane.content, workspace, workingTab, { view: controller.view, ariaLabel: "Comparison working source", decorate: decorate("working"), lineClass: lineClass("working") }); }
    catch (error) { root.remove(); controller.dispose(); throw error; }
    function clearReference(): void {
        reference?.destroy(); reference = undefined;
        if (displayTarget && workspace.resolveTab(displayTarget)) workspace.close(displayTarget.id);
        displayTab = undefined; displayTarget = undefined;
        if (display) { workspace.releaseResource(display.id); display = undefined; }
    }
    function visible(value: string): string { return value.replaceAll(" ", "·").replaceAll("\t", "⇥").replaceAll("\r", "␍").replaceAll("\n", "↵\n"); }
    function render(): void {
        if (disposed) return; state = controller.getSnapshot();
        if (state.baseline && state.baseline.epoch !== epoch) {
            clearReference(); epoch = state.baseline.epoch;
            display = workspace.createTextResourceFromBuffer({ scope: `comparison-${mount}`, resource: "baseline", variant: String(epoch) }, "Comparison baseline",
                { buffer: state.baseline.buffer, serverVersion: state.baseline.version }, { edit: [], save: false, run: false });
            displayTab = workspace.open({ kind: "text", documentId: display.documentId }, `comparison-${mount}`);
            displayTarget = workspace.captureTab(displayTab);
            reference = mountTextViewport(referencePane.content, workspace, displayTab, { ariaLabel: "Comparison baseline source", decorate: decorate("baseline"), lineClass: lineClass("baseline") });
        } else if (!state.baseline && reference) clearReference();
        root.dataset.status = state.status; root.dataset.generation = String(state.generation);
        referencePane.heading.textContent = state.baseline ? `Baseline · ${state.baseline.version}` : "Baseline unavailable";
        workingPane.heading.textContent = state.working ? `Working · revision ${state.working.revision}` : "Working unavailable";
        const count = state.hunks.length; selected = selectedGeneration === state.generation ? Math.min(selected, count - 1) : -1;
        const hunk = selected >= 0 ? state.hunks[selected] : undefined;
        status.textContent = state.status === "ready" ? count ? `${hunk ? `Change ${selected + 1} of ${count}` : `${count} changes`}${hunk?.whitespaceOnly ? " · whitespace only" : ""}` : "No changes" : state.failure ?? `Comparison ${state.status}`;
        previous.disabled = next.disabled = state.status !== "ready" || count === 0 || working.snapshot().composing;
        const metadata = state.working ? workspace.resource(state.working.resourceId).metadata.getSnapshot() : undefined;
        revert.disabled = !hunk || !metadata?.capabilities.edit.includes("human") || metadata.editLock !== null || working.snapshot().composing;
        preview.hidden = !hunk;
        if (hunk && state.baseline && state.working) {
            const text = (side: "baseline" | "working") => { const range = hunk[side], buffer = side === "baseline" ? state.baseline!.buffer : state.working!.buffer;
                return `${side === "baseline" ? "Baseline" : "Working"} lines ${range.lineFrom + 1}–${Math.max(range.lineFrom + 1, range.lineTo)}: ${range.from === range.to ? "∅" : visible(buffer.slice(range.from, Math.min(range.to, range.from + 160))) + (range.to - range.from > 160 ? "…" : "")}`; };
            referencePreview.textContent = text("baseline"); workingPreview.textContent = text("working");
        } else { referencePreview.textContent = workingPreview.textContent = ""; }
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
        const current = controller.getSnapshot();
        if (disposed || working.snapshot().composing || current.status !== "ready" || current.generation !== generation || !Number.isSafeInteger(index)) return false;
        const hunk = current.hunks[index]; if (!hunk || !current.working || !reference) return false;
        selected = index; selectedGeneration = generation; const document = reference.view.getSnapshot();
        reference.view.setSelection(document.revision, { anchor: hunk.baseline.from, head: hunk.baseline.to });
        controller.view.setSelection(current.working.revision, { anchor: hunk.working.from, head: hunk.working.to });
        reference.revealOffset(hunk.baseline.from); working.viewport.revealOffset(hunk.working.from); render(); return true;
    }
    previous.addEventListener("click", () => selectHunk(state.generation, (selected < 0 ? state.hunks.length - 1 : selected - 1 + state.hunks.length) % state.hunks.length), { signal: listeners.signal });
    next.addEventListener("click", () => selectHunk(state.generation, (selected + 1) % state.hunks.length), { signal: listeners.signal });
    revert.addEventListener("click", () => { if (!working.snapshot().composing) controller.revert(state.generation, selected); }, { signal: listeners.signal });
    working.input.addEventListener("compositionstart", schedule, { signal: listeners.signal }); working.input.addEventListener("compositionend", schedule, { signal: listeners.signal });
    const unsubscribe = controller.subscribe(schedule), unsubscribeWorkspace = workspace.subscribe(schedule);
    function destroy(): void {
        if (disposed) return; disposed = true; if (timer !== undefined) win!.clearTimeout(timer);
        unsubscribe(); unsubscribeWorkspace(); listeners.abort(); working.destroy(); clearReference(); controller.dispose();
        state = controller.getSnapshot(); selected = -1; root.remove();
    }
    try { render(); schedule(); } catch (error) { destroy(); throw error; }
    return Object.freeze({ element: root, controller, working, referenceViewport: () => reference, selectHunk,
        snapshot: () => Object.freeze({ generation: measuredGeneration, steps, advances, maxStepMs, totalStepMs, disposed }), destroy });
}
