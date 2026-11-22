import type { Affinity } from "../core/positions.ts";
import { ownsTextSurface } from "../core/workspace.ts";
import type { TextBuffer } from "../core/text-buffer.ts";
import { rowTextRanges } from "./text-geometry.ts";
import { clientBox, cssZoom } from "./dom-coordinates.ts";
import type { TextEditor } from "./text-editor.ts";

export type OverlayPosition = Readonly<{ revision: number; offset: number; affinity?: Affinity }>;
export type OverlayAnchor = OverlayPosition | Readonly<{ revision: number; from: number; to: number }>;
export type OverlayDismissEvent = "focus-leave" | "outside-pointerdown";
export type AnchoredOverlayOptions = Readonly<{ prefer?: "above" | "below"; priority?: number;
    dismissOn?: readonly OverlayDismissEvent[]; onDismiss?: (event: OverlayDismissEvent) => void;
    /** Called before an offscreen popup hides if one of its controls has focus. */
    onFocusedAnchorHidden?: () => void }>;
type Placement = { priority: number; rectangle: DOMRect | undefined; schedule: () => void };
const activeOverlays = new WeakMap<TextEditor, Set<Placement>>();

type Clip = Readonly<{ left: number; top: number; right: number; bottom: number }>;
type Point = Readonly<{ left: number; top: number; height: number }>;

function visibleAnchor(editor: TextEditor, anchor: OverlayAnchor, buffer: TextBuffer, clip: Clip): Point | undefined {
    const { viewport, view } = editor, folds = view.folding.getSnapshot();
    if (clip.left >= clip.right || clip.top >= clip.bottom) return;
    const caret = (offset: number, affinity?: Affinity) => {
        if (offset > buffer.length || folds.index.hiddenBy(buffer.lineAt(offset))) return;
        const point = viewport.coordsAt(offset, affinity);
        if (point && point.left >= clip.left && point.left < clip.right && point.top + point.height > clip.top && point.top < clip.bottom) return point;
    };
    if ("offset" in anchor) return caret(anchor.offset, anchor.affinity);
    if (anchor.from === anchor.to) return caret(anchor.from);
    const paint = viewport.activity();
    if (anchor.to > buffer.length || paint.revision !== anchor.revision || paint.foldGeneration !== folds.generation) return;
    let first: Point | undefined;
    function consider(rect: Point): void {
        if (!first || rect.top < first.top || rect.top === first.top && rect.left < first.left) first = rect;
    }
    // Mounted rows include overscan and may be out of DOM order after scrolling.
    for (const row of viewport.element.querySelectorAll<HTMLElement>(".st-viewport-row")) {
        const start = Number(row.dataset.from), end = Number(row.dataset.to);
        const from = Math.max(anchor.from, start), to = Math.min(anchor.to, end);
        if (from < to) {
            const bounds = row.getBoundingClientRect();
            if (bounds.bottom <= clip.top || bounds.top >= clip.bottom) continue;
            const range = rowTextRanges(row).range(from - start, to - start);
            for (const rect of range?.getClientRects() ?? []) {
                const left = Math.max(rect.left, clip.left), top = Math.max(rect.top, clip.top);
                const height = Math.min(rect.bottom, clip.bottom) - top;
                if (left < Math.min(rect.right, clip.right) && height > 0) consider({ left, top, height });
            }
        } else if (anchor.from <= end + 1 && end < anchor.to && end < buffer.length) {
            // CRLF has two source units at one painted edge. A clipped row is not a line ending.
            const line = Number(row.dataset.line);
            if (line + 1 < buffer.lineCount && end === buffer.line(line).to && anchor.from < buffer.offsetAt(line + 1)) {
                const point = caret(end, "before"); if (point) consider(point);
            }
        }
    }
    return first;
}

/** Positions a host popup against a painted source position without scrolling or focusing the editor. */
export function mountAnchoredOverlay(editor: TextEditor, element: HTMLElement, options: AnchoredOverlayOptions = {}) {
    const { viewport, view, workspace } = editor, owner = editor.element.ownerDocument, win = owner.defaultView!;
    if (element.ownerDocument !== owner || editor.signal.aborted) throw new Error("An overlay needs a live editor in the same document.");
    const priority = options.priority ?? 0, dismissOn = new Set(options.dismissOn);
    if (!Number.isFinite(priority)) throw new RangeError("Overlay priority must be finite.");
    const peers = activeOverlays.get(editor) ?? new Set<Placement>();
    activeOverlays.set(editor, peers);
    const placement: Placement = { priority, rectangle: undefined, schedule };
    const style = element.style, original = { left: style.left, top: style.top, maxWidth: style.maxWidth, maxHeight: style.maxHeight };
    const alreadyStyled = element.classList.contains("st-editor-overlay");
    element.classList.add("st-editor-overlay"); element.hidden = true;
    let anchor: OverlayAnchor | undefined, events: AbortController | undefined, frame: number | undefined, disposed = false;
    let stopRender: (() => void) | undefined;
    function report(rectangle?: DOMRect): void {
        const old = placement.rectangle;
        if (old?.left === rectangle?.left && old?.right === rectangle?.right
            && old?.top === rectangle?.top && old?.bottom === rectangle?.bottom) return;
        placement.rectangle = rectangle;
        for (const peer of peers) if (peer.priority < priority) peer.schedule();
    }
    function conceal(): void {
        if (!element.hidden && element.matches(":focus-within")) options.onFocusedAnchorHidden?.();
        element.hidden = true; report();
    }
    function position(): void {
        frame = undefined;
        if (!anchor) return;
        const document = workspace.observeDocument(view.documentId).getSnapshot();
        if (!document || document.revision !== anchor.revision || !ownsTextSurface(workspace, view, editor.tab)) { hide(); return; }
        if (!element.isConnected) { conceal(); return; }
        const box = clientBox(viewport.element, viewport.settings().minimap, viewport.snapshot().gutterWidth);
        const visual = win.visualViewport, left = visual?.offsetLeft ?? 0, top = visual?.offsetTop ?? 0;
        const right = left + (visual?.width ?? owner.documentElement.clientWidth), bottom = top + (visual?.height ?? owner.documentElement.clientHeight);
        const point = visibleAnchor(editor, anchor, document.buffer, { left: Math.max(left, box.left), right: Math.min(right, box.right),
            top: Math.max(top, box.top), bottom: Math.min(bottom, box.bottom) });
        if (!point) { conceal(); return; }
        const lineEnd = point.top + point.height;

        element.hidden = false;
        // Measure at the host's preferred size before choosing a side. A prior short window may have constrained it.
        style.maxWidth = original.maxWidth; style.maxHeight = original.maxHeight;
        const zoom = cssZoom(element), width = Math.max(0, right - left - 16);
        if (element.getBoundingClientRect().width > width) style.maxWidth = `${width / zoom}px`;
        const size = element.getBoundingClientRect();
        const x = Math.max(left + 8, Math.min(point.left, right - size.width - 8));
        let upperEdge = top + 8, lowerEdge = bottom - 8;
        for (const peer of peers) {
            const occupied = peer.rectangle;
            if (peer.priority <= priority || !occupied || occupied.right <= x || occupied.left >= x + size.width) continue;
            if (occupied.top < point.top) upperEdge = Math.max(upperEdge, occupied.bottom + 4);
            if (occupied.bottom > lineEnd) lowerEdge = Math.min(lowerEdge, occupied.top - 4);
        }
        const above = Math.max(0, point.top - 4 - upperEdge), below = Math.max(0, lowerEdge - lineEnd - 4);
        const bothFit = Math.min(above, below) >= size.height;
        const openAbove = bothFit ? options.prefer === "above" : above > below;
        const room = openAbove ? above : below;
        if (!room) { conceal(); return; }
        if (size.height > room) style.maxHeight = `${room / zoom}px`;
        style.left = `${x / zoom}px`;
        style.top = `${(openAbove ? point.top - 4 - Math.min(room, size.height) : lineEnd + 4) / zoom}px`;
        report(element.getBoundingClientRect());
    }
    function schedule(): void {
        if (anchor && frame === undefined) frame = win.requestAnimationFrame(position);
    }
    const resize = new win.ResizeObserver(schedule);
    function hide(): void {
        element.hidden = true; report();
        if (!anchor) return;
        anchor = undefined; peers.delete(placement);
        events?.abort(); events = undefined; resize.disconnect(); stopRender?.(); stopRender = undefined;
        if (frame !== undefined) { win.cancelAnimationFrame(frame); frame = undefined; }
    }
    function show(next: OverlayAnchor): void {
        if (disposed) return;
        const from = "offset" in next ? next.offset : next.from, to = "offset" in next ? next.offset : next.to;
        if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) throw new RangeError("Invalid overlay anchor.");
        anchor = Object.freeze({ ...next });
        if (!events) {
            peers.add(placement);
            events = new AbortController();
            const signal = events.signal;
            const dismiss = (reason: OverlayDismissEvent) => { hide(); options.onDismiss?.(reason); };
            if (dismissOn.has("focus-leave")) {
                const left = (event: FocusEvent) => {
                    // WebKit can run a microtask between focusout and focusin, with body temporarily active.
                    const next = event.relatedTarget;
                    if (next instanceof win.Node && (editor.element.contains(next) || element.contains(next))) return;
                    queueMicrotask(() => {
                        if (!signal.aborted && !editor.element.matches(":focus-within") && !element.matches(":focus-within")) dismiss("focus-leave");
                    });
                };
                editor.element.addEventListener("focusout", left, { signal });
                element.addEventListener("focusout", left, { signal });
            }
            if (dismissOn.has("outside-pointerdown")) owner.addEventListener("pointerdown", event => {
                const path = event.composedPath();
                if (!path.includes(element) && !path.includes(editor.element)) dismiss("outside-pointerdown");
            }, { capture: true, signal });
            stopRender = viewport.onRender(schedule); resize.observe(element);
            if (editor.tab) signal.addEventListener("abort", workspace.tabs.subscribe(schedule), { once: true });
            win.addEventListener("scroll", schedule, { capture: true, passive: true, signal });
            win.addEventListener("resize", schedule, { signal });
            win.visualViewport?.addEventListener("scroll", schedule, { signal });
            win.visualViewport?.addEventListener("resize", schedule, { signal });
        }
        schedule();
    }
    function dispose(): void {
        if (disposed) return;
        disposed = true; hide(); Object.assign(style, original);
        if (!alreadyStyled) element.classList.remove("st-editor-overlay");
        editor.signal.removeEventListener("abort", dispose);
    }
    editor.signal.addEventListener("abort", dispose, { once: true });
    return Object.freeze({ show, hide, dispose });
}
export type AnchoredOverlay = ReturnType<typeof mountAnchoredOverlay>;
