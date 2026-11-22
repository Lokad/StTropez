import { comparisonLine } from "../core/comparison-scroll.ts";
import type { ComparisonSnapshot } from "../core/comparison.ts";
import { viewportPadding } from "./viewport.ts";
import type { TextViewport } from "./viewport.ts";
import type { ComparisonPanes } from "./comparison-panes.ts";

/** Optional view-only coordination; completed comparison identity owns each queued frame. */
export function createComparisonScroll(win: Window, panes: ComparisonPanes,
    snapshot: () => ComparisonSnapshot, canSync: () => boolean) {
    const working = panes.working.editor.viewport, reference = () => panes.reference()?.editor.viewport;
    let linked = false, disposed = false, paused = false, frame: number | undefined, leader = working, prior: ComparisonSnapshot | undefined;
    let workingRows = -1, referenceRows = -1;
    let stopObserving: (() => void) | undefined, stopReference: (() => void) | undefined;
    const positions = new Map<TextViewport, number>(), paintedRows = new Map<TextViewport, number>();
    const cancel = () => { if (frame !== undefined) win.cancelAnimationFrame(frame); frame = undefined; };
    function request(source: TextViewport, attempt = 0): void {
        if (!linked || disposed) return;
        const capture = snapshot(), baseline = reference();
        if (!baseline || source !== working && source !== baseline) return;
        cancel(); leader = source;
        if (capture.status !== "ready" || !capture.working || !capture.baseline || !canSync()) {
            paused = capture.status === "running" || capture.status === "ready"; return;
        }
        paused = false;
        const target = source === working ? baseline : working, sourceFolds = source.view.folding.getSnapshot(), targetFolds = target.view.folding.getSnapshot();
        const sourceRows = source.activity().rowGeneration, targetRows = target.activity().rowGeneration;
        frame = win.requestAnimationFrame(() => {
            frame = undefined;
            if (disposed || !linked || snapshot() !== capture || reference() !== baseline
                || source.view.folding.getSnapshot() !== sourceFolds || target.view.folding.getSnapshot() !== targetFolds) return;
            if (!canSync()) { paused = true; return; }
            const a = source.activity(), b = target.activity();
            if (a.rowGeneration !== sourceRows || b.rowGeneration !== targetRows) return;
            if (!source.element.isConnected || !target.element.isConnected || a.disposed || b.disposed) return;
            if (a.pending || b.pending) { if (attempt < 2) request(source, attempt + 1); else paused = true; return; }
            const sourceRevision = source === working ? capture.working!.revision : baseline.view.getSnapshot().revision;
            const targetRevision = target === working ? capture.working!.revision : baseline.view.getSnapshot().revision;
            if (a.revision !== sourceRevision || b.revision !== targetRevision || a.foldGeneration !== sourceFolds.generation || b.foldGeneration !== targetFolds.generation) return;
            if (a.aligned !== b.aligned || a.aligned && a.alignmentId !== b.alignmentId) return;
            const sourceGeometry = source.getSnapshot(), targetGeometry = target.getSnapshot();
            const row = Math.max(0, (sourceGeometry.scrollTop - viewportPadding) / sourceGeometry.lineHeight); let targetRow = row;
            if (!a.aligned) {
                const whole = Math.min(sourceFolds.index.visibleLineCount - 1, Math.floor(row)), line = sourceFolds.index.lineAt(whole) + row - whole;
                const mapped = comparisonLine(capture.hunks, source === working ? "working" : "baseline", line, capture.baseline!.buffer, capture.working!.buffer);
                const integer = Math.floor(mapped), hidden = targetFolds.index.hiddenBy(integer); targetRow = targetFolds.index.rowAt(integer) + (hidden ? 0 : mapped - integer);
            }
            const top = sourceGeometry.scrollTop < viewportPadding ? sourceGeometry.scrollTop : viewportPadding + targetRow * targetGeometry.lineHeight;
            if (Math.abs(targetGeometry.scrollTop - Math.min(Math.max(0, targetGeometry.verticalExtent - targetGeometry.height), top)) < .5) return;
            // Record the clamped follower before its synchronous render event can echo back.
            positions.set(target, Math.min(Math.max(0, targetGeometry.verticalExtent - targetGeometry.height), top));
            target.scrollTo({ top }); target.flush();
            // CSSOM scroll events arrive later, including for API writes. Remember the clamped
            // logical destination so that event cannot become a new source and feed back.
            positions.set(target, target.getSnapshot().scrollTop);
        });
    }
    function scrolled(view: TextViewport): void {
        const top = view.getSnapshot().scrollTop, previous = positions.get(view); positions.set(view, top);
        if (previous !== undefined && Math.abs(top - previous) < .5) return;
        request(view);
    }
    // A navigation/composition may consume its native scroll event before the command
    // releases its capture. Resume from that actual pane when its queued paint settles.
    const resume = () => { if (paused && canSync()) request(leader); };
    const rendered = (view: TextViewport) => {
        const { rowGeneration } = view.activity(), generation = paintedRows.get(view); paintedRows.set(view, rowGeneration);
        if (generation !== undefined && generation !== rowGeneration) {
            // A new grid may move its own source anchor. Keep the initiating pane as leader.
            positions.set(view, view.getSnapshot().scrollTop); request(leader);
        } else scrolled(view);
        resume();
    };
    function remember(view: TextViewport): void {
        positions.set(view, view.getSnapshot().scrollTop); paintedRows.set(view, view.activity().rowGeneration);
    }
    function unlisten(): void {
        stopObserving?.(); stopObserving = undefined; stopReference?.(); stopReference = undefined;
        positions.clear(); paintedRows.clear(); prior = undefined; leader = working;
        workingRows = referenceRows = -1;
    }
    function update(): void {
        if (disposed || !linked) return;
        const next = reference(), state = snapshot();
        const aRows = working.activity().rowGeneration, bRows = next?.activity().rowGeneration ?? -1;
        if (state !== prior || aRows !== workingRows || bRows !== referenceRows) { cancel(); prior = state; workingRows = aRows; referenceRows = bRows; request(leader); }
        else if (paused && state.status === "ready" && canSync()) request(leader);
    }
    return Object.freeze({ update, snapshot: () => Object.freeze({ linked, pending: frame !== undefined || paused }),
        setLinked(value: boolean): void {
            if (disposed || value === linked) return; cancel(); paused = false; linked = value;
            if (linked) {
                remember(working); const baseline = reference(); if (baseline) remember(baseline);
                stopObserving = panes.observe({ render: rendered, scroll: scrolled, fold: () => request(leader), resize: () => request(leader),
                    input: view => request(view), pointerdown: view => request(view) });
                stopReference = panes.onReferenceChange(previous => {
                    cancel(); paused = false; leader = working;
                    if (previous) { positions.delete(previous.editor.viewport); paintedRows.delete(previous.editor.viewport); }
                    const next = reference(); if (next) remember(next); update();
                });
                update();
            } else unlisten();
        },
        dispose(): void { if (disposed) return; disposed = true; cancel(); paused = false; unlisten(); }
    });
}
