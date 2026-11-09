import { ComparisonRowsCursor } from "../core/comparison-rows.ts";
import type { ComparisonRows } from "../core/comparison-rows.ts";
import type { ComparisonSnapshot } from "../core/comparison.ts";
import type { FoldingSnapshot } from "../core/folding.ts";
import type { EditingCandidate } from "./editing-candidate.ts";
import type { TextViewport } from "./viewport.ts";
type Capture = { state: ComparisonSnapshot; reference: TextViewport; a: FoldingSnapshot; b: FoldingSnapshot };
export type ComparisonAlignmentSnapshot = Readonly<{ enabled: boolean; status: "idle" | "building" | "waiting" | "ready" | "failed"; pending: boolean; work: number; runs: number; failure: string | undefined }>;
let serial = 0;

/** Cooperative, view-only publication against one immutable comparison/fold capture. */
export function createComparisonAlignment(win: Window, working: EditingCandidate, reference: () => TextViewport | undefined,
    getComparison: () => ComparisonSnapshot, changed: () => void, referenceBusy: () => boolean) {
    let enabled = false, disposed = false, timer: number | undefined, cursor: ComparisonRowsCursor | undefined, capture: Capture | undefined, result: ComparisonRows | undefined;
    let status: "idle" | "building" | "waiting" | "ready" | "failed" = "idle", failure: string | undefined, work = 0, installedPitch = 0;
    let oldReference: TextViewport | undefined, referenceEvents: AbortController | undefined, stopReference: (() => void) | undefined;
    const events = new AbortController(), pointers = new Set<number>();
    const stableInput = () => { const s = working.snapshot(); return !s.composing && !s.pendingCommand && !s.pendingInput && !s.pendingDragScroll && !pointers.size && !referenceBusy(); };
    const cancel = () => { if (timer !== undefined) win.clearTimeout(timer); timer = undefined; cursor?.dispose(); cursor = undefined; };
    const schedule = () => { if (!disposed && enabled && timer === undefined) timer = win.setTimeout(step, 0); };
    const clear = () => { working.viewport.setComparisonRows(undefined); oldReference?.setComparisonRows(undefined); };
    const current = (c: Capture) => getComparison() === c.state && reference() === c.reference && working.view.folding.getSnapshot() === c.b && c.reference.view.folding.getSnapshot() === c.a;
    const pitch = (c: Capture) => Math.max(working.viewport.snapshot().naturalLineHeight, c.reference.snapshot().naturalLineHeight);
    function watch(view: TextViewport, signal: AbortSignal): void {
        view.element.addEventListener("sttropez-render", () => {
            if (enabled && (!capture || !current(capture) || result && (status === "waiting" && stableInput() || pitch(capture) !== installedPitch))) schedule();
        }, { signal });
        view.element.addEventListener("compositionend", schedule, { signal, capture: true });
        view.element.addEventListener("pointerdown", e => { if (enabled) pointers.add(e.pointerId); }, { signal, capture: true });
    }
    const releasePointer = (event: PointerEvent) => { if (pointers.delete(event.pointerId)) schedule(); };
    win.addEventListener("pointerup", releasePointer, { signal: events.signal, capture: true }); win.addEventListener("pointercancel", releasePointer, { signal: events.signal, capture: true });
    for (const type of ["blur", "dragend", "drop"] as const) win.addEventListener(type, () => { if (pointers.size) { pointers.clear(); schedule(); } }, { signal: events.signal });
    watch(working.viewport, events.signal);
    const stopWorking = working.view.folding.subscribe(schedule);
    function update(): void {
        if (disposed) return;
        const next = reference(), state = getComparison();
        if (next !== oldReference) {
            cancel(); oldReference?.setComparisonRows(undefined); referenceEvents?.abort(); stopReference?.(); pointers.clear();
            oldReference = next; referenceEvents = undefined; stopReference = undefined; capture = undefined; result = undefined;
            if (next) { referenceEvents = new AbortController(); watch(next, referenceEvents.signal); stopReference = next.view.folding.subscribe(schedule); }
        }
        if (!enabled || state.status !== "ready" || !state.baseline || !state.working || !next) {
            cancel(); clear(); capture = undefined; result = undefined; installedPitch = 0;
            const nextStatus = enabled && state.status === "running" ? "building" : "idle";
            if (status !== nextStatus) { status = nextStatus; changed(); } return;
        }
        if (!capture || !current(capture)) {
            cancel(); clear(); result = undefined; installedPitch = 0; work = 0; failure = undefined;
            capture = { state, reference: next, a: next.view.folding.getSnapshot(), b: working.view.folding.getSnapshot() };
            cursor = new ComparisonRowsCursor(state.baseline.buffer, state.working.buffer, state.hunks, capture.a.index, capture.b.index);
            status = "building"; schedule(); changed();
        } else if (result && (status === "waiting" || pitch(capture) !== installedPitch)) publish(capture);
    }
    function publish(c: Capture): void {
        if (!result || !current(c) || !c.state.working) return;
        if (!stableInput()) { if (status !== "waiting") { status = "waiting"; changed(); } return; }
        const lineHeight = pitch(c), id = ++serial, a = c.reference.view.getSnapshot();
        const baseline = c.reference.setComparisonRows({ documentId: c.reference.view.documentId, revision: a.revision, foldGeneration: c.a.generation, id, lineHeight, index: result.baseline });
        const source = working.viewport.setComparisonRows({ documentId: working.view.documentId, revision: c.state.working.revision, foldGeneration: c.b.generation, id, lineHeight, index: result.working });
        if (!baseline || !source) { clear(); capture = undefined; result = undefined; schedule(); return; }
        installedPitch = lineHeight; status = "ready"; changed();
    }
    function step(): void {
        timer = undefined; if (disposed || !enabled) return;
        try {
            update();
            if (timer !== undefined) { win.clearTimeout(timer); timer = undefined; }
            if (!capture || !cursor || !current(capture)) return;
            const from = win.performance.now(); let batches = 0;
            do { const next = cursor.next(64); work = next.work; if (next.result) { result = next.result; cursor.dispose(); cursor = undefined; publish(capture); break; } }
            while (++batches < 4 && win.performance.now() - from < 4);
            if (cursor) { schedule(); changed(); }
        } catch (error) { cancel(); clear(); result = undefined; status = "failed"; failure = error instanceof Error ? error.message : "Row alignment failed."; changed(); }
    }
    return Object.freeze({ update,
        snapshot: (): ComparisonAlignmentSnapshot => {
            const state = getComparison(), target = state.status === "ready" || state.status === "running";
            const stale = enabled && target && (state.status === "running" || !capture || !current(capture) || status === "ready" && pitch(capture) !== installedPitch);
            const phase = stale ? "building" : status;
            return Object.freeze({ enabled, status: phase, pending: enabled && target && (phase === "building" || phase === "waiting"), work, runs: result?.runCount ?? 0, failure });
        },
        setEnabled(value: boolean): void { if (typeof value !== "boolean") throw new TypeError("Expected a row-alignment preference."); if (disposed || value === enabled) return; enabled = value; if (enabled) { failure = undefined; update(); } else { cancel(); clear(); capture = undefined; result = undefined; status = "idle"; installedPitch = 0; } changed(); },
        dispose(): void { if (disposed) return; disposed = true; cancel(); clear(); events.abort(); referenceEvents?.abort(); stopWorking(); stopReference?.(); pointers.clear(); oldReference = undefined; capture = undefined; result = undefined; status = "idle"; }
    });
}
