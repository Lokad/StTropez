import { listenUntil, onAbort } from "./listen.ts";
import type { DocumentId } from "../core/workspace.ts";
import type { Affinity } from "../core/positions.ts";
import { clientBox } from "./dom-coordinates.ts";
import type { TextEditor } from "./text-editor.ts";

export type PointerDwellPosition = Readonly<{ documentId: DocumentId; revision: number; offset: number; affinity: Affinity }>;
export type PointerDwellOptions = Readonly<{ delayMs?: number; enabled?: () => boolean; onMiss?: () => void }>;
export type PointerDwell = Readonly<{ isPending: () => boolean; cancel: () => void; dispose: () => void }>;

/** Observe a stationary pointer over this editor's painted text without changing selection or focus. */
export function observePointerDwell(editor: TextEditor, listener: (position: PointerDwellPosition) => void,
    options: PointerDwellOptions = {}): PointerDwell {
    const { element, view, viewport } = editor, win = element.ownerDocument.defaultView!;
    const delay = options.delayMs ?? 300;
    if (!Number.isFinite(delay) || delay < 0 || delay > 2147483647) throw new RangeError("Invalid pointer dwell delay.");
    if (editor.signal.aborted) throw new Error("Pointer dwell needs a live editor.");
    const events = new AbortController(), signal = events.signal;
    const listen = listenUntil(signal);
    let timer: number | undefined, last: PointerDwellPosition | undefined;
    let pending: { x: number; y: number; offset?: number; revision: number; folds: number; alignment: number | null; scrolled: boolean } | undefined;
    function cancel(): void {
        win.clearTimeout(timer); timer = undefined; pending = undefined; last = undefined;
    }
    function hit(x: number, y: number) {
        const state = viewport.getSnapshot(), box = clientBox(viewport.element, viewport.settings().minimap, state.gutterWidth);
        if (x < box.left || x >= box.right || y < box.top || y >= box.bottom) return;
        const point = viewport.hitTest(x, y);
        if (point && !point.padding && Math.abs(point.left - x) <= state.columnWidth * box.zoom * 1.5
            && Math.abs(point.top + point.height / 2 - y) <= point.height) return point;
    }
    listen(element, "pointermove", event => {
        if (options.enabled?.() === false) { cancel(); return; }
        if (event.buttons || event.pointerType === "touch" || event.ctrlKey || event.metaKey || editor.getSnapshot().composing) {
            cancel(); options.onMiss?.(); return;
        }
        const x = event.clientX, y = event.clientY, paint = viewport.activity();
        const revision = view.getSnapshot().revision, folds = view.folding.getSnapshot().generation, alignment = paint.alignmentId;
        const point = paint.pending ? undefined : hit(x, y);
        if (!paint.pending && (!point || point.revision !== revision)) { cancel(); options.onMiss?.(); return; }
        if (last && point && last.revision === revision && last.offset === point.offset && last.affinity === point.affinity) return;
        if (pending && pending.revision === revision && pending.folds === folds && pending.alignment === alignment
            && (point ? pending.offset === point.offset : pending.x === x && pending.y === y)) {
            pending.x = x; pending.y = y; return;
        }
        cancel();
        const target = pending = { x, y, revision, folds, alignment, ...(point && { offset: point.offset }), scrolled: false };
        timer = win.setTimeout(() => {
            timer = undefined; pending = undefined;
            const settled = viewport.activity();
            if (settled.pending || settled.revision !== revision || settled.foldGeneration !== folds || settled.alignmentId !== alignment
                || view.getSnapshot().revision !== revision || options.enabled?.() === false || editor.getSnapshot().composing) return;
            const point = hit(target.x, target.y);
            if (!point || point.revision !== revision || (target.offset !== undefined || target.scrolled) && point.offset !== target.offset) return;
            last = Object.freeze({ documentId: view.documentId, revision, offset: point.offset, affinity: point.affinity });
            listener(last);
        }, delay);
    });
    for (const type of ["pointerleave", "pointercancel", "pointerdown", "compositionstart", "beforeinput"]) listen(element, type, cancel);
    listen(win, "scroll", event => {
        const target = event.target;
        if (target === win || target instanceof win.Node && (element.contains(target) || target.contains(element))) {
            if (pending) pending.scrolled = true;
            last = undefined;
        }
    }, { capture: true, passive: true });
    listen(win, "keydown", event => { if (event.ctrlKey || event.metaKey || event.isComposing) cancel(); }, { capture: true });
    listen(win, "blur", cancel); listen(win, "resize", cancel);
    function dispose(): void { cancel(); events.abort(); editor.signal.removeEventListener("abort", dispose); }
    onAbort(editor.signal, dispose);
    return Object.freeze({ isPending: () => timer !== undefined, cancel, dispose });
}
