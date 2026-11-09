import { comparisonLine } from "../core/comparison-scroll.ts";
import type { ComparisonSnapshot } from "../core/comparison.ts";
import { viewportPadding } from "./viewport.ts";
import type { TextViewport } from "./viewport.ts";

/** Optional view-only coordination; completed comparison identity owns each queued frame. */
export function createComparisonScroll(win: Window, working: TextViewport, reference: () => TextViewport | undefined,
    snapshot: () => ComparisonSnapshot, canSync: () => boolean) {
    let linked = false, disposed = false, frame: number | undefined, leader = working, prior: ComparisonSnapshot | undefined;
    let currentReference: TextViewport | undefined, referenceEvents: AbortController | undefined, stopReference: (() => void) | undefined;
    let workingRows = -1, referenceRows = -1;
    const events = new AbortController(), positions = new Map<TextViewport, number>();
    const cancel = () => { if (frame !== undefined) win.cancelAnimationFrame(frame); frame = undefined; };
    const observer = new ResizeObserver(() => request(leader));
    function request(source: TextViewport, attempt = 0): void {
        if (!linked || disposed || !canSync()) return;
        const capture = snapshot(), baseline = reference();
        if (capture.status !== "ready" || !capture.working || !capture.baseline || !baseline || source !== working && source !== baseline) return;
        cancel(); leader = source;
        const target = source === working ? baseline : working, sourceFolds = source.view.folding.getSnapshot(), targetFolds = target.view.folding.getSnapshot();
        const sourceRows = source.snapshot().rowGeneration, targetRows = target.snapshot().rowGeneration;
        frame = win.requestAnimationFrame(() => {
            frame = undefined;
            if (disposed || !linked || !canSync() || snapshot() !== capture || reference() !== baseline
                || source.view.folding.getSnapshot() !== sourceFolds || target.view.folding.getSnapshot() !== targetFolds) return;
            const a = source.snapshot(), b = target.snapshot();
            if (a.rowGeneration !== sourceRows || b.rowGeneration !== targetRows) return;
            if (!source.element.isConnected || !target.element.isConnected || a.disposed || b.disposed) return;
            if (a.pending || b.pending) { if (attempt < 2) request(source, attempt + 1); return; }
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
    working.element.addEventListener("scroll", () => scrolled(working), { signal: events.signal, passive: true });
    const stopWorking = working.view.folding.subscribe(() => request(leader));
    function update(): void {
        if (disposed) return;
        const next = reference(), state = snapshot();
        if (next !== currentReference) {
            cancel(); referenceEvents?.abort(); stopReference?.();
            if (currentReference) { observer.unobserve(currentReference.element); positions.delete(currentReference); }
            currentReference = next; referenceEvents = undefined; stopReference = undefined; leader = working;
            if (next) {
                referenceEvents = new AbortController(); positions.set(next, next.snapshot().scrollTop);
                next.element.addEventListener("scroll", () => scrolled(next), { signal: referenceEvents.signal, passive: true });
                stopReference = next.view.folding.subscribe(() => request(leader)); if (linked) observer.observe(next.element);
            }
        }
        const aRows = working.snapshot().rowGeneration, bRows = next?.snapshot().rowGeneration ?? -1;
        if (state !== prior || aRows !== workingRows || bRows !== referenceRows) { cancel(); prior = state; workingRows = aRows; referenceRows = bRows; request(leader); }
    }
    return Object.freeze({ update, snapshot: () => Object.freeze({ linked, pending: frame !== undefined }),
        setLinked(value: boolean): void {
            if (typeof value !== "boolean") throw new TypeError("Expected a scroll-link preference.");
            if (disposed || value === linked) return; cancel(); linked = value;
            if (linked) { observer.observe(working.element); if (currentReference) observer.observe(currentReference.element); request(working); }
            else observer.disconnect();
        },
        dispose(): void { if (disposed) return; disposed = true; cancel(); observer.disconnect(); events.abort(); referenceEvents?.abort(); stopWorking(); stopReference?.(); positions.clear(); currentReference = undefined; prior = undefined; }
    });
}
