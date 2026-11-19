import { ComparisonRowsCursor } from "../core/comparison-rows.ts";
import type { ComparisonRows } from "../core/comparison-rows.ts";
import type { ComparisonSnapshot } from "../core/comparison.ts";
import type { FoldingSnapshot } from "../core/folding.ts";
import type { MountedTextEditor } from "./text-editor.ts";
import type { ComparisonPanes } from "./comparison-panes.ts";
import { createCooperativeRunner } from "./cooperative-runner.ts";
type Capture = { state: ComparisonSnapshot; reference: MountedTextEditor; a: FoldingSnapshot; b: FoldingSnapshot };
export type ComparisonAlignmentSnapshot = Readonly<{ enabled: boolean; status: "idle" | "building" | "waiting" | "ready" | "failed"; pending: boolean; work: number; runs: number; failure: string | undefined }>;

/** Cooperative, view-only publication against one immutable comparison/fold capture. */
export function createComparisonAlignment(win: Window, panes: ComparisonPanes,
    getComparison: () => ComparisonSnapshot, changed: () => void, referenceBusy: () => boolean) {
    let serial = 0;
    const workingMount = panes.working, working = workingMount.editor, reference = panes.reference, runner = createCooperativeRunner(win);
    let enabled = false, disposed = false, scheduled = false, cursor: ComparisonRowsCursor | undefined, capture: Capture | undefined, result: ComparisonRows | undefined;
    let status: "idle" | "building" | "waiting" | "ready" | "failed" = "idle", failure: string | undefined, work = 0, installedPitch = 0;
    let events: AbortController | undefined, stopObserving: (() => void) | undefined, stopReference: (() => void) | undefined;
    const pointers = new Set<number>();
    const stableInput = () => { const s = working.activity(); return !s.composing && !s.pendingCommand && !s.pendingInput && !s.pendingDragScroll && !pointers.size && !referenceBusy(); };
    const cancel = () => { runner.cancel(); scheduled = false; cursor?.dispose(); cursor = undefined; };
    const schedule = () => { if (!disposed && enabled && !scheduled) { runner.schedule(step); scheduled = true; } };
    const clear = () => { workingMount.setComparisonRows(undefined); reference()?.setComparisonRows(undefined); };
    const current = (c: Capture) => getComparison() === c.state && reference() === c.reference && working.view.folding.getSnapshot() === c.b && c.reference.editor.view.folding.getSnapshot() === c.a;
    const pitch = (c: Capture) => Math.max(working.viewport.snapshot().naturalLineHeight, c.reference.editor.viewport.snapshot().naturalLineHeight);
    function listen(): void {
        stopObserving = panes.observe({ render: () => {
            if (enabled && (!capture || !current(capture) || result && (status === "waiting" && stableInput() || pitch(capture) !== installedPitch))) schedule();
        }, fold: schedule, compositionend: schedule, pointerdown: (_view, event) => { if (enabled) pointers.add((event as PointerEvent).pointerId); } });
        stopReference = panes.onReferenceChange(previous => {
            cancel(); previous?.setComparisonRows(undefined); clear(); pointers.clear(); capture = undefined; result = undefined; installedPitch = 0; update();
        });
        events = new AbortController();
        const releasePointer = (event: PointerEvent) => { if (pointers.delete(event.pointerId)) schedule(); };
        win.addEventListener("pointerup", releasePointer, { signal: events.signal, capture: true }); win.addEventListener("pointercancel", releasePointer, { signal: events.signal, capture: true });
        for (const type of ["blur", "dragend", "drop"] as const) win.addEventListener(type, () => { if (pointers.size) { pointers.clear(); schedule(); } }, { signal: events.signal });
    }
    function unlisten(): void {
        events?.abort(); events = undefined; stopObserving?.(); stopObserving = undefined; stopReference?.(); stopReference = undefined;
        pointers.clear();
    }
    function update(): void {
        if (disposed || !enabled) return;
        const next = reference(), state = getComparison();
        if (state.status !== "ready" || !state.baseline || !state.working || !next) {
            cancel(); clear(); capture = undefined; result = undefined; installedPitch = 0;
            const nextStatus = state.status === "running" ? "building" : "idle";
            if (status !== nextStatus) { status = nextStatus; changed(); } return;
        }
        if (!capture || !current(capture)) {
            cancel(); clear(); result = undefined; installedPitch = 0; work = 0; failure = undefined;
            capture = { state, reference: next, a: next.editor.view.folding.getSnapshot(), b: working.view.folding.getSnapshot() };
            cursor = new ComparisonRowsCursor(state.baseline.buffer, state.working.buffer, state.hunks, capture.a.index, capture.b.index);
            status = "building"; schedule(); changed();
        } else if (result && (status === "waiting" || pitch(capture) !== installedPitch)) publish(capture);
    }
    function publish(c: Capture): void {
        if (!result || !current(c) || !c.state.working) return;
        if (!stableInput()) { if (status !== "waiting") { status = "waiting"; changed(); } return; }
        const lineHeight = pitch(c), id = ++serial, a = c.reference.editor.view.getSnapshot();
        const baseline = c.reference.setComparisonRows({ documentId: c.reference.editor.view.documentId, revision: a.revision, foldGeneration: c.a.generation, id, lineHeight, index: result.baseline });
        const source = workingMount.setComparisonRows({ documentId: working.view.documentId, revision: c.state.working.revision, foldGeneration: c.b.generation, id, lineHeight, index: result.working });
        if (!baseline || !source) { clear(); capture = undefined; result = undefined; schedule(); return; }
        installedPitch = lineHeight; status = "ready"; changed();
    }
    function step(): void {
        scheduled = false; if (disposed || !enabled) return;
        try {
            update();
            runner.cancel(); scheduled = false;
            if (!capture || !cursor || !current(capture)) return;
            const job = cursor, planned = capture, start = work;
            const next = runner.slice(() => { const next = job.next(256); work = next.work; return next; },
                next => next.status === "running" && work - start < 4096 && cursor === job && capture === planned && current(planned), 16);
            if (cursor !== job || capture !== planned || !current(planned)) { schedule(); return; }
            if (next.status === "ready") { result = next.result!; job.dispose(); cursor = undefined; publish(planned); }
            // Progress is readable from snapshot(); it does not invalidate either pane.
            if (cursor) schedule();
        } catch (error) { cancel(); clear(); result = undefined; status = "failed"; failure = error instanceof Error ? error.message : "Row alignment failed."; changed(); }
    }
    return Object.freeze({ update,
        snapshot: (): ComparisonAlignmentSnapshot => {
            const state = getComparison(), target = state.status === "ready" || state.status === "running";
            const stale = enabled && target && (state.status === "running" || !capture || !current(capture) || status === "ready" && pitch(capture) !== installedPitch);
            const phase = stale ? "building" : status;
            return Object.freeze({ enabled, status: phase, pending: enabled && target && (phase === "building" || phase === "waiting"), work, runs: result?.runCount ?? 0, failure });
        },
        setEnabled(value: boolean): void { if (typeof value !== "boolean") throw new TypeError("Expected a row-alignment preference."); if (disposed || value === enabled) return; enabled = value; if (enabled) { failure = undefined; listen(); update(); } else { cancel(); clear(); unlisten(); capture = undefined; result = undefined; status = "idle"; installedPitch = 0; } changed(); },
        dispose(): void { if (disposed) return; disposed = true; cancel(); clear(); unlisten(); capture = undefined; result = undefined; status = "idle"; }
    });
}
