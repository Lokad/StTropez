import type { Affinity } from "../core/positions.ts";
import { ownsTextSurface } from "../core/workspace.ts";
import { clientBox, cssZoom } from "./dom-coordinates.ts";
import type { TextEditor } from "./text-editor.ts";

export type OverlayAnchor = Readonly<{ revision: number; offset: number; affinity?: Affinity }>;
export type AnchoredOverlayOptions = Readonly<{ prefer?: "above" | "below" }>;

/** Positions a host popup against a painted source position without scrolling or focusing the editor. */
export function mountAnchoredOverlay(editor: TextEditor, element: HTMLElement, options: AnchoredOverlayOptions = {}) {
    const { viewport, view, workspace } = editor, owner = editor.element.ownerDocument, win = owner.defaultView!;
    if (element.ownerDocument !== owner || editor.signal.aborted) throw new Error("An overlay needs a live editor in the same document.");
    const style = element.style, original = { left: style.left, top: style.top, maxWidth: style.maxWidth, maxHeight: style.maxHeight };
    const alreadyStyled = element.classList.contains("st-editor-overlay");
    element.classList.add("st-editor-overlay"); element.hidden = true;
    let anchor: OverlayAnchor | undefined, events: AbortController | undefined, frame: number | undefined, disposed = false;
    let stopRender: (() => void) | undefined;
    function position(): void {
        frame = undefined;
        if (!anchor) return;
        const document = workspace.observeDocument(view.documentId).getSnapshot();
        if (!document || document.revision !== anchor.revision || !ownsTextSurface(workspace, view, editor.tab)) { hide(); return; }
        const point = viewport.coordsAt(anchor.offset, anchor.affinity);
        if (!point || !element.isConnected || view.folding.getSnapshot().index.hiddenBy(document.buffer.lineAt(anchor.offset))) {
            element.hidden = true; return;
        }
        const box = clientBox(viewport.element, viewport.settings().minimap, viewport.snapshot().gutterWidth);
        const visual = win.visualViewport, left = visual?.offsetLeft ?? 0, top = visual?.offsetTop ?? 0;
        const right = left + (visual?.width ?? owner.documentElement.clientWidth), bottom = top + (visual?.height ?? owner.documentElement.clientHeight);
        const lineEnd = point.top + point.height;
        if (point.left < Math.max(left, box.left) || point.left >= Math.min(right, box.right)
            || lineEnd <= Math.max(top, box.top) || point.top >= Math.min(bottom, box.bottom)) { element.hidden = true; return; }

        element.hidden = false;
        // Measure at the host's preferred size before choosing a side. A prior short window may have constrained it.
        style.maxWidth = original.maxWidth; style.maxHeight = original.maxHeight;
        const zoom = cssZoom(element), width = Math.max(0, right - left - 16);
        if (element.getBoundingClientRect().width > width) style.maxWidth = `${width / zoom}px`;
        const size = element.getBoundingClientRect();
        const above = Math.max(0, point.top - top - 12), below = Math.max(0, bottom - lineEnd - 12);
        const bothFit = Math.min(above, below) >= size.height;
        const openAbove = bothFit ? options.prefer === "above" : above > below;
        const room = openAbove ? above : below;
        if (size.height > room) style.maxHeight = `${room / zoom}px`;
        style.left = `${Math.max(left + 8, Math.min(point.left, right - size.width - 8)) / zoom}px`;
        style.top = `${(openAbove ? point.top - 4 - Math.min(room, size.height) : lineEnd + 4) / zoom}px`;
    }
    function schedule(): void {
        if (anchor && frame === undefined) frame = win.requestAnimationFrame(position);
    }
    const resize = new win.ResizeObserver(schedule);
    function hide(): void {
        element.hidden = true;
        if (!anchor) return;
        anchor = undefined;
        events?.abort(); events = undefined; resize.disconnect(); stopRender?.(); stopRender = undefined;
        if (frame !== undefined) { win.cancelAnimationFrame(frame); frame = undefined; }
    }
    function show(next: OverlayAnchor): void {
        if (disposed) return;
        if (!Number.isSafeInteger(next.offset) || next.offset < 0) throw new RangeError("Invalid overlay offset.");
        anchor = Object.freeze({ ...next });
        if (!events) {
            events = new AbortController();
            const signal = events.signal;
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
