import { comparisonLine } from "../core/comparison-scroll.ts";
import type { ComparisonSnapshot } from "../core/comparison.ts";
import { viewportPadding } from "./viewport.ts";
import type { TextViewport } from "./viewport.ts";

/** Optional view-only coordination; completed comparison identity owns each queued frame. */
export function createComparisonScroll(win: Window, working: TextViewport, reference: () => TextViewport | undefined,
    snapshot: () => ComparisonSnapshot, canSync: () => boolean) {
    let linked = false, disposed = false, paused = false, frame: number | undefined, leader = working, prior: ComparisonSnapshot | undefined;
    let currentReference: TextViewport | undefined, referenceEvents: AbortController | undefined, stopReference: (() => void) | undefined;
    let workingRows = -1, referenceRows = -1;
    let events: AbortController | undefined, stopWorking: (() => void) | undefined;
    const positions = new Map<TextViewport, number>(), paintedRows = new Map<TextViewport, number>();
    const cancel = () => { if (frame !== undefined) win.cancelAnimationFrame(frame); frame = undefined; };
    const observer = new ResizeObserver(() => request(leader));
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
            const a = source.snapshot(), b = target.snapshot();
            if (a.rowGeneration !== sourceRows || b.rowGeneration !== targetRows) return;
            if (!source.element.isConnected || !target.element.isConnected || a.disposed || b.disposed) return;
            if (a.pending || b.pending) { if (attempt < 2) request(source, attempt + 1); else paused = true; return; }
            const sourceRevision = source === working ? capture.working!.revision : baseline.view.getSnapshot().revision;
            const targetRevision = target === working ? capture.working!.revision : baseline.view.getSnapshot().revision;
            if (a.revision !== sourceRevision || b.revision !== targetRevision || a.foldGeneration !== sourceFolds.generation || b.foldGeneration !== targetFolds.generation) return;
            if (a.aligned !== b.aligned || a.aligned && a.alignmentId !== b.alignmentId) return;
            const row = Math.max(0, (a.scrollTop - viewportPadding) / a.lineHeight); let targetRow = row;
            if (!a.aligned) {
                const whole = Math.min(sourceFolds.index.visibleLineCount - 1, Math.floor(row)), line = sourceFolds.index.lineAt(whole) + row - whole;
                const mapped = comparisonLine(capture.hunks, source === working ? "working" : "baseline", line, capture.baseline!.buffer, capture.working!.buffer);
                const integer = Math.floor(mapped), hidden = targetFolds.index.hiddenBy(integer); targetRow = targetFolds.index.rowAt(integer) + (hidden ? 0 : mapped - integer);
            }
            const top = a.scrollTop < viewportPadding ? a.scrollTop : viewportPadding + targetRow * b.lineHeight;
            if (Math.abs(b.scrollTop - Math.min(Math.max(0, b.verticalExtent - b.height), top)) < .5) return;
            // Record the clamped follower before its synchronous render event can echo back.
            positions.set(target, Math.min(Math.max(0, b.verticalExtent - b.height), top));
            target.scrollTo({ top }); target.flush();
            // CSSOM scroll events arrive later, including for API writes. Remember the clamped
            // logical destination so that event cannot become a new source and feed back.
            positions.set(target, target.snapshot().scrollTop);
        });
    }
    function scrolled(view: TextViewport): void {
        const top = view.snapshot().scrollTop, previous = positions.get(view); positions.set(view, top);
        if (previous !== undefined && Math.abs(top - previous) < .5) return;
        request(view);
    }
    // A navigation/composition may consume its native scroll event before the command
    // releases its capture. Resume from that actual pane when its queued paint settles.
    const resume = () => { if (paused && canSync()) request(leader); };
    const rendered = (view: TextViewport) => {
        const state = view.snapshot(), generation = paintedRows.get(view); paintedRows.set(view, state.rowGeneration);
        if (generation !== undefined && generation !== state.rowGeneration) {
            // A new grid may move its own source anchor. Keep the initiating pane as leader.
            positions.set(view, state.scrollTop); request(leader);
        } else scrolled(view);
        resume();
    };
    function watch(view: TextViewport, signal: AbortSignal): void {
        const state = view.snapshot(); positions.set(view, state.scrollTop); paintedRows.set(view, state.rowGeneration);
        view.element.addEventListener("sttropez-render", () => rendered(view), { signal });
        view.element.addEventListener("scroll", () => scrolled(view), { signal, passive: true });
        // Capture the event's actual view before navigation or an edit changes the grid.
        for (const type of ["keydown", "beforeinput", "pointerdown"] as const)
            view.element.addEventListener(type, () => request(view), { signal, capture: true });
    }
    function unlisten(): void {
        observer.disconnect(); events?.abort(); events = undefined; stopWorking?.(); stopWorking = undefined;
        referenceEvents?.abort(); referenceEvents = undefined; stopReference?.(); stopReference = undefined;
        positions.clear(); paintedRows.clear(); currentReference = undefined; prior = undefined; leader = working;
        workingRows = referenceRows = -1;
    }
    function update(): void {
        if (disposed || !linked) return;
        const next = reference(), state = snapshot();
        if (next !== currentReference) {
            cancel(); paused = false; referenceEvents?.abort(); stopReference?.();
            if (currentReference) { observer.unobserve(currentReference.element); positions.delete(currentReference); paintedRows.delete(currentReference); }
            currentReference = next; referenceEvents = undefined; stopReference = undefined; leader = working;
            if (next) {
                referenceEvents = new AbortController(); watch(next, referenceEvents.signal);
                stopReference = next.view.folding.subscribe(() => request(leader)); observer.observe(next.element);
            }
        }
        const aRows = working.activity().rowGeneration, bRows = next?.activity().rowGeneration ?? -1;
        if (state !== prior || aRows !== workingRows || bRows !== referenceRows) { cancel(); prior = state; workingRows = aRows; referenceRows = bRows; request(leader); }
        else if (paused && state.status === "ready" && canSync()) request(leader);
    }
    return Object.freeze({ update, snapshot: () => Object.freeze({ linked, pending: frame !== undefined || paused }),
        setLinked(value: boolean): void {
            if (typeof value !== "boolean") throw new TypeError("Expected a scroll-link preference.");
            if (disposed || value === linked) return; cancel(); paused = false; linked = value;
            if (linked) {
                events = new AbortController(); watch(working, events.signal);
                stopWorking = working.view.folding.subscribe(() => request(leader)); observer.observe(working.element); update();
            } else unlisten();
        },
        dispose(): void { if (disposed) return; disposed = true; cancel(); paused = false; unlisten(); }
    });
}
