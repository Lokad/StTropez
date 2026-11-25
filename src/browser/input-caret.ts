import { clientBox } from "./dom-coordinates.ts";
import { isFocused } from "./dom-focus.ts";
import { partitionPoint } from "../core/bound-search.ts";
import type { SelectionSet } from "../core/selections.ts";
import type { DocumentSnapshot, DocumentView } from "../core/workspace.ts";
import type { TextViewport, ViewportActivity, ViewportSnapshot } from "./viewport.ts";

const pageReveals = new WeakMap<HTMLElement, () => void>();

export function revealCaretInPage(root: HTMLElement): void {
    pageReveals.get(root)?.();
}

/** Owns only caret DOM, placement cache and its animation frame; input/model state stays with the adapter. */
export function mountInputCaret(root: HTMLDivElement, input: HTMLTextAreaElement, view: DocumentView,
    viewport: TextViewport, readDocument: () => DocumentSnapshot | undefined, isComposing: () => boolean) {
    const owner = root.ownerDocument, win = owner.defaultView!;
    const group = owner.createElement("div"), caret = owner.createElement("div"), secondaryCarets = owner.createElement("div");
    const caretNodes: HTMLDivElement[] = [];
    group.className = "st-caret-layer"; group.setAttribute("aria-hidden", "true");
    caret.className = "st-input-caret"; group.append(caret, secondaryCarets); root.append(group);
    const reducedMotion = win.matchMedia("(prefers-reduced-motion: reduce)");
    let blink: Animation | undefined, blinkSelection: SelectionSet | undefined;
    let disposed = false, frame: number | undefined;
    const schedule = () => { if (!disposed && frame === undefined) frame = win.requestAnimationFrame(positionCaret); };
    reducedMotion.addEventListener("change", schedule);
    let caretLayout: Readonly<{ state: ViewportSnapshot; activity: ViewportActivity; visible: boolean; focused: boolean }> | undefined;
    function positionCaret(): void {
        // A host edit can queue the viewport behind this frame. Paint its rows before measuring the focused caret.
        if (!disposed && isFocused(input) && viewport.activity().pending) viewport.flush();
        frame = undefined;
        if (disposed) return;
        const composing = isComposing();
        const { selection: selected, selectionSet } = view.getSnapshot(), focused = isFocused(input);
        const startOfSelection = composing && selected.anchor < selected.head;
        const offset = startOfSelection ? selected.anchor : selected.head, affinity = startOfSelection ? selected.anchorAffinity : selected.headAffinity;
        let rectangle = clientBox(root, viewport.settings().minimap);
        const currentDocument = readDocument();
        let state = viewport.getSnapshot(), activity = viewport.activity(), point = viewport.coordsAt(offset, affinity);
        const pointVisible = () => point && point.left >= rectangle.left + state.gutterWidth * rectangle.zoom && point.left < rectangle.right
            && point.top + point.height > rectangle.top && point.top < rectangle.bottom;
        let visible = pointVisible();
        const prior = caretLayout;
        // Reuse bounded reveal after layout changes hide a previously visible focused head.
        // Explicit scrolling, new selections/revisions and inactive views retain their own positions.
        const retainLayout = !visible && focused && !composing && prior?.visible && prior.focused && activity.revision === prior.activity.revision
            && currentDocument?.revision === activity.revision && selectionSet === activity.selectionSet && activity.selectionSet === prior.activity.selectionSet
            && activity.foldGeneration === prior.activity.foldGeneration && view.folding.getSnapshot().generation === activity.foldGeneration
            && state.scrollTop === prior.state.scrollTop && state.scrollLeft === prior.state.scrollLeft;
        const layoutChanged = retainLayout && (state.width !== prior.state.width || state.height !== prior.state.height
            || state.columnWidth !== prior.state.columnWidth || state.lineHeight !== prior.state.lineHeight);
        if (layoutChanged) {
            viewport.revealOffset(selected.head, { horizontal: "nearest", vertical: "nearest", affinity: selected.headAffinity ?? "after" });
            viewport.flush();
            rectangle = clientBox(root, viewport.settings().minimap);
            state = viewport.getSnapshot(); activity = viewport.activity(); point = viewport.coordsAt(selected.head, selected.headAffinity);
            visible = pointVisible();
        }
        // DOM layout can advance before ResizeObserver queues a render. Retain the last valid
        // placement until measured metrics arrive, then attempt reveal once even if no point exists.
        if (!retainLayout || layoutChanged) caretLayout = { state, activity, visible: !!visible, focused: focused && !composing };
        const buffer = currentDocument?.buffer, active = isFocused(input);
        let lastLine = -1, lastRow: ReturnType<TextViewport["rowBounds"]>;
        const bounds = (line: number) => {
            if (line !== lastLine) { lastLine = line; lastRow = viewport.rowBounds(line); }
            return lastRow;
        };
        const points = [];
        let ranged = selected.anchor !== selected.head;
        if (!composing && active && buffer && activity.selectionSet === selectionSet && state.lineTo > state.lineFrom) {
            const from = buffer.offsetAt(state.lineFrom), to = state.lineTo < buffer.lineCount ? buffer.offsetAt(state.lineTo) : buffer.length;
            // Heads of normalized disjoint ranges are ordered. Measure only visible candidates,
            // using the same bounded native row geometry as the primary caret.
            const low = partitionPoint(selectionSet.ranges.length, index => selectionSet.ranges[index]!.head < from);
            for (let index = low; index < selectionSet.ranges.length; index++) {
                const range = selectionSet.ranges[index]!;
                if (range.head > to) break;
                if (index === selectionSet.primary) continue;
                const line = buffer.lineAt(range.head);
                if (view.folding.getSnapshot().index.hiddenBy(line)) continue;
                const at = viewport.coordsAt(range.head, range.headAffinity);
                if (at && at.left >= rectangle.left + state.gutterWidth * rectangle.zoom && at.left < rectangle.right
                    && at.top + at.height > rectangle.top && at.top < rectangle.bottom) {
                    const row = bounds(line); points.push({ left: at.left, top: row?.top ?? at.top, height: row?.height ?? at.height });
                    if (range.anchor !== range.head) ranged = true;
                }
            }
        }
        const scrollLeft = root.scrollLeft, scrollTop = root.scrollTop, width = (rectangle.right - rectangle.left) / rectangle.zoom, height = root.clientHeight;
        const left = ((point?.left ?? rectangle.left) - rectangle.left) / rectangle.zoom;
        const top = ((point?.top ?? rectangle.top) - rectangle.top) / rectangle.zoom;
        const caretHeight = point ? point.height / rectangle.zoom : state.lineHeight;
        const row = point && buffer && bounds(buffer.lineAt(offset));
        // All geometry, including secondary heads and any post-reveal layout, is captured above.
        // Bound the native input anchor while the display caret follows the text, including clipped rows.
        caret.hidden = !visible || !active || composing && !caret.textContent;
        input.style.left = `${scrollLeft + Math.max(0, Math.min(width - 2, left))}px`;
        input.style.top = `${scrollTop + Math.max(0, Math.min(height - 24, top))}px`;
        caret.style.left = `${scrollLeft + left}px`;
        caret.style.top = `${scrollTop + (row ? (row.top - rectangle.top) / rectangle.zoom : top)}px`;
        caret.style.height = `${row ? row.height / rectangle.zoom : caretHeight}px`;
        input.style.height = `${caretHeight}px`;
        while (caretNodes.length > points.length) caretNodes.pop()!.remove();
        points.forEach((at, index) => {
            let node = caretNodes[index];
            if (!node) {
                node = owner.createElement("div");
                node.className = "st-input-secondary-caret";
                caretNodes.push(node);
                secondaryCarets.append(node);
            }
            node.style.left = `${scrollLeft + (at.left - rectangle.left) / rectangle.zoom}px`;
            node.style.top = `${scrollTop + (at.top - rectangle.top) / rectangle.zoom}px`;
            node.style.height = `${at.height / rectangle.zoom}px`;
        });
        // All visible insertion carets share one animation. Typing restarts the solid interval.
        if ((!caret.hidden || points.length) && !composing && !ranged && !reducedMotion.matches) {
            if (!blink) blink = group.animate([{ opacity: 1, easing: "steps(1, end)" },
                { opacity: 0, offset: .5, easing: "steps(1, end)" }, { opacity: 1 }], { delay: 400, duration: 1000, iterations: Infinity });
            else if (blinkSelection !== selectionSet) blink.currentTime = 0;
            blinkSelection = selectionSet;
        } else if (blink) { blink.cancel(); blink = undefined; blinkSelection = undefined; }
    }
    pageReveals.set(root, () => {
        // An explicit reveal can move the virtual viewport before its next caret frame.
        viewport.flush();
        if (frame !== undefined) win.cancelAnimationFrame(frame);
        positionCaret();
        // When a toolbar has focus, the source input still marks the selection head.
        const anchor = caret.hidden ? input : caret;
        anchor.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    return Object.freeze({ schedule, pending: () => frame !== undefined,
        showComposingText(text: string) { caret.textContent = text; schedule(); },
        dispose: () => {
            if (disposed) return;
            disposed = true;
            pageReveals.delete(root);
            if (frame !== undefined) win.cancelAnimationFrame(frame);
            reducedMotion.removeEventListener("change", schedule); blink?.cancel(); blink = undefined; blinkSelection = undefined;
            frame = undefined; caretLayout = undefined;
            caretNodes.length = 0; secondaryCarets.replaceChildren();
            group.remove();
        } });
}
