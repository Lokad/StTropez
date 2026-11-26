import { listenUntil, onAbort, stopPopupPropagation } from "./listen.ts";
import { isOffsetRange } from "../core/bounds.ts";
import type { Affinity } from "../core/positions.ts";
import type { TextBuffer } from "../core/text-buffer.ts";
import { rowTextRanges } from "./text-geometry.ts";
import { clientBox, cssZoom } from "./dom-coordinates.ts";
import type { TextEditor } from "./text-editor.ts";

export type OverlayPosition = Readonly<{ revision: number; offset: number; affinity?: Affinity }>;
export type OverlayAnchor = OverlayPosition | Readonly<{ revision: number; from: number; to: number }>;
type DismissEvent = "focus-leave" | "outside-pointerdown";
export type OverlayHideReason = DismissEvent | "clipped" | "expired" | "hide" | "disposed";
export type AnchoredOverlayOptions = Readonly<{
    prefer?: "above" | "below";
    priority?: number;
    dismissOn?: readonly DismissEvent[];
    onHide?: (reason: OverlayHideReason, hadFocus: boolean) => void;
}>;
export type AnchoredOverlay = Readonly<{ show: (anchor: OverlayAnchor, focusTarget?: HTMLElement) => void; hide: () => void; dispose: () => void }>;

type Placement = { priority: number; rectangle: DOMRect | undefined; schedule: () => void };
const activeOverlays = new WeakMap<TextEditor, Set<Placement>>();

type Clip = Readonly<{ left: number; top: number; right: number; bottom: number }>;
type Point = Readonly<{ left: number; top: number; height: number }>;
type Slot = { top: number; bottom: number; above: boolean };

/** The anchor and higher-priority popups divide the window into free vertical intervals. */
function popupSlot(top: number, bottom: number, line: Point, occupied: { top: number; bottom: number }[],
    height: number, previous: Slot | undefined, preferAbove: boolean): Slot | undefined {
    occupied.push({ top: line.top - 4, bottom: line.top + line.height + 4 });
    occupied.sort((a, b) => a.top - b.top);
    let best: Slot | undefined, visible = 0, distance = Infinity;
    let start = top;
    for (const rect of [...occupied, { top: bottom, bottom }]) {
        const end = Math.min(bottom, rect.top);
        if (start < end) {
            const above = end <= line.top, fit = Math.min(height, end - start);
            if (fit === height && previous?.top === start && previous.bottom === end && previous.above === above) {
                return previous;
            }
            const gap = above ? line.top - end : start - (line.top + line.height);
            if (fit > visible || fit === visible && (gap < distance || gap === distance && above === preferAbove)) {
                best = { top: start, bottom: end, above };
                visible = fit;
                distance = gap;
            }
        }
        start = Math.max(start, rect.bottom);
        if (start >= bottom) break;
    }
    return best;
}

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
                const left = Math.max(rect.left, clip.left);
                if (left < Math.min(rect.right, clip.right) && rect.bottom > clip.top && rect.top < clip.bottom)
                    consider({ left, top: bounds.top, height: bounds.height });
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
export function mountAnchoredOverlay(editor: TextEditor, element: HTMLElement, options: AnchoredOverlayOptions = {}): AnchoredOverlay {
    const { viewport, view, workspace } = editor, owner = editor.element.ownerDocument, win = owner.defaultView!;
    if (element.ownerDocument !== owner || editor.signal.aborted) throw new Error("An overlay needs a live editor in the same document.");
    const { priority = 0, onHide } = options;
    const dismissOn = new Set(options.dismissOn);
    if (!Number.isFinite(priority)) throw new RangeError("Overlay priority must be finite.");
    const source = workspace.observeDocument(view.documentId);
    const peers = activeOverlays.get(editor) ?? new Set<Placement>();
    activeOverlays.set(editor, peers);
    let previousSlot: Slot | undefined;
    const placement: Placement = { priority, rectangle: undefined, schedule: reconsider };
    const style = element.style, original = { left: style.left, top: style.top, bottom: style.bottom, maxWidth: style.maxWidth, maxHeight: style.maxHeight };
    const alreadyStyled = element.classList.contains("st-editor-overlay");
    const detached = !element.parentNode;
    const scoped = detached || editor.element.contains(element);
    const priorPopover = element.popover;
    if (scoped) {
        element.popover = "manual";
        if (detached) editor.element.append(element);
    }
    element.classList.add("st-editor-overlay");
    element.hidden = true;
    let anchor: OverlayAnchor | undefined, events: AbortController | undefined, frame: number | undefined, disposed = false;
    let focusTarget: HTMLElement | undefined;
    function report(rectangle?: DOMRect): void {
        const old = placement.rectangle;
        if (old?.left === rectangle?.left && old?.right === rectangle?.right
            && old?.top === rectangle?.top && old?.bottom === rectangle?.bottom) return;
        placement.rectangle = rectangle;
        for (const peer of peers) if (peer.priority < priority) peer.schedule();
    }
    function position(): void {
        frame = undefined;
        if (!anchor) return;
        const document = source.getSnapshot();
        if (document?.revision !== anchor.revision || !workspace.ownsDocumentView(view, editor.tab)) return hide("expired");
        if (!element.isConnected) return hide("clipped");
        // A scroll can arrive before the rows for its new position have been painted.
        if (viewport.activity().pending) return;
        const box = clientBox(viewport.element, viewport.settings().minimap, viewport.getSnapshot().gutterWidth);
        const visual = win.visualViewport, left = visual?.offsetLeft ?? 0, top = visual?.offsetTop ?? 0;
        const right = left + (visual?.width ?? owner.documentElement.clientWidth), bottom = top + (visual?.height ?? owner.documentElement.clientHeight);
        const point = visibleAnchor(editor, anchor, document.buffer, { left: Math.max(left, box.left), right: Math.min(right, box.right),
            top: Math.max(top, box.top), bottom: Math.min(bottom, box.bottom) });
        if (!point) return hide("clipped");
        element.hidden = false;
        if (scoped && !element.matches(":popover-open")) element.showPopover();
        // Measure at the host's preferred size before choosing a side. A prior short window may have constrained it.
        style.maxWidth = original.maxWidth; style.maxHeight = original.maxHeight;
        const zoom = cssZoom(element), width = Math.max(0, right - left - 16);
        if (element.getBoundingClientRect().width > width) style.maxWidth = `${width / zoom}px`;
        const size = element.getBoundingClientRect();
        const x = Math.max(left + 8, Math.min(point.left, right - size.width - 8));
        const occupied: { top: number; bottom: number }[] = [];
        for (const peer of peers) {
            const rect = peer.rectangle;
            if (peer.priority > priority && rect && rect.right > x && rect.left < x + size.width)
                occupied.push({ top: rect.top - 4, bottom: rect.bottom + 4 });
        }
        const slot = popupSlot(top + 8, bottom - 8, point, occupied, size.height, previousSlot,
            previousSlot?.above ?? options.prefer === "above");
        if (!slot) return hide("clipped");
        previousSlot = slot;
        const room = slot.bottom - slot.top;
        if (size.height > room) style.maxHeight = `${room / zoom}px`;
        style.left = `${x / zoom}px`;
        // The edge beside the text stays fixed even when content grows before the next measurement.
        style.top = slot.above ? "auto" : `${slot.top / zoom}px`;
        style.bottom = slot.above ? `${(owner.documentElement.clientHeight - slot.bottom) / zoom}px` : "auto";
        report(element.getBoundingClientRect());
        const target = focusTarget;
        focusTarget = undefined;
        if (target && element.contains(target)) target.focus({ preventScroll: true });
    }
    function schedule(): void {
        if (anchor && frame === undefined) frame = win.requestAnimationFrame(position);
    }
    function reconsider(): void { previousSlot = undefined; schedule(); }
    const resize = new win.ResizeObserver(schedule);
    function hide(reason: OverlayHideReason = "hide"): void {
        if (!anchor) return;
        focusTarget = undefined;
        const notify = reason !== "clipped" || !!placement.rectangle;
        const hadFocus = element.matches(":focus-within");
        if (reason !== "clipped") {
            anchor = undefined;
            previousSlot = undefined;
            peers.delete(placement);
            events?.abort();
            events = undefined;
            resize.disconnect();
            if (frame !== undefined) win.cancelAnimationFrame(frame);
            frame = undefined;
        }
        if (scoped && element.matches(":popover-open")) element.hidePopover();
        element.hidden = true;
        report();
        if (notify) onHide?.(reason, hadFocus);
    }
    function show(next: OverlayAnchor, target?: HTMLElement): void {
        if (disposed) return;
        const from = "offset" in next ? next.offset : next.from, to = "offset" in next ? next.offset : next.to;
        if (!isOffsetRange(from, to)) throw new RangeError("Invalid overlay anchor.");
        if (target && !element.contains(target)) throw new RangeError("Focus target must belong to the overlay.");
        focusTarget = target;
        anchor = Object.freeze({ ...next });
        if (!events) {
            peers.add(placement);
            events = new AbortController();
            const signal = events.signal;
            const listen = listenUntil(signal);
            if (scoped) stopPopupPropagation(element, listen);
            if (dismissOn.has("focus-leave")) {
                const left = (event: FocusEvent) => {
                    // WebKit can run a microtask between focusout and focusin, with body temporarily active.
                    const next = event.relatedTarget;
                    if (next instanceof win.Node && (editor.element.contains(next) || element.contains(next))) return;
                    queueMicrotask(() => {
                        if (!signal.aborted && !editor.element.matches(":focus-within") && !element.matches(":focus-within")) hide("focus-leave");
                    });
                };
                listen(editor.element, "focusout", left);
                if (!scoped) listen(element, "focusout", left);
            }
            if (dismissOn.has("outside-pointerdown")) listen(owner, "pointerdown", event => {
                const path = event.composedPath();
                if (!path.includes(element) && !path.includes(editor.element)) hide("outside-pointerdown");
            }, { capture: true });
            onAbort(signal, viewport.onRender(schedule));
            resize.observe(element);
            onAbort(signal, source.subscribe(schedule));
            if (editor.tab) onAbort(signal, workspace.tabs.subscribe(schedule));
            listen(win, "scroll", schedule, { capture: true, passive: true });
            listen(win, "resize", reconsider);
            listen(win.visualViewport, "scroll", schedule);
            listen(win.visualViewport, "resize", reconsider);
        }
        schedule();
    }
    function dispose(): void {
        if (disposed) return;
        disposed = true;
        try {
            hide("disposed");
        } finally {
            if (scoped) {
                if (detached) element.remove();
                element.popover = priorPopover;
            }
            Object.assign(style, original);
            if (!alreadyStyled) element.classList.remove("st-editor-overlay");
            editor.signal.removeEventListener("abort", dispose);
        }
    }
    onAbort(editor.signal, dispose);
    return Object.freeze({ show, hide, dispose });
}
