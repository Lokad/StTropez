import { clientBox } from "./dom-coordinates.ts";
import type { DocumentSnapshot, DocumentView } from "../core/workspace.ts";
import type { TextViewport } from "./viewport.ts";

/** Owns only caret DOM, placement cache and its animation frame; input/model state stays with the adapter. */
export function mountInputCaret(root: HTMLDivElement, input: HTMLTextAreaElement, view: DocumentView,
    viewport: TextViewport, readDocument: () => DocumentSnapshot | undefined, isComposing: () => boolean) {
    const owner = root.ownerDocument, win = owner.defaultView!;
    const caret = owner.createElement("div"), secondaryCarets = owner.createElement("div");
    const caretNodes: HTMLDivElement[] = [];
    caret.className = "st-input-caret"; caret.setAttribute("aria-hidden", "true");
    secondaryCarets.setAttribute("aria-hidden", "true"); root.append(caret, secondaryCarets);
    let disposed = false, frame: number | undefined;
    const schedule = () => { if (!disposed && frame === undefined) frame = win.requestAnimationFrame(positionCaret); };
    let caretLayout: Readonly<{ state: ReturnType<TextViewport["snapshot"]>; visible: boolean; focused: boolean }> | undefined;
    function positionCaret(): void {
        frame = undefined;
        if (disposed) return;
        const composing = isComposing();
        const { selection: selected, selectionSet } = view.getSnapshot(), rectangle = clientBox(root), focused = owner.activeElement === input;
        const currentDocument = readDocument();
        let state = viewport.snapshot(), point = viewport.coordsAt(selected.head, selected.headAffinity);
        let visible = point && point.left >= rectangle.left && point.left < rectangle.right
            && point.top + point.height > rectangle.top && point.top < rectangle.bottom;
        const prior = caretLayout;
        // Reuse bounded reveal after layout changes hide a previously visible focused head.
        // Explicit scrolling, new selections/revisions and inactive views retain their own positions.
        const retainLayout = !visible && focused && !composing && prior?.visible && prior.focused && state.revision === prior.state.revision
            && currentDocument?.revision === state.revision && selectionSet === state.selectionSet && state.selectionSet === prior.state.selectionSet
            && state.foldGeneration === prior.state.foldGeneration && view.folding.getSnapshot().generation === state.foldGeneration
            && state.scrollTop === prior.state.scrollTop && state.scrollLeft === prior.state.scrollLeft;
        const layoutChanged = retainLayout && (state.width !== prior.state.width || state.height !== prior.state.height
            || state.columnWidth !== prior.state.columnWidth || state.lineHeight !== prior.state.lineHeight);
        if (layoutChanged) {
            viewport.revealOffset(selected.head, { horizontal: "nearest", vertical: "nearest", affinity: selected.headAffinity ?? "after" });
            viewport.flush();
            state = viewport.snapshot(); point = viewport.coordsAt(selected.head, selected.headAffinity);
            visible = point && point.left >= rectangle.left && point.left < rectangle.right && point.top + point.height > rectangle.top && point.top < rectangle.bottom;
        }
        // DOM layout can advance before ResizeObserver queues a render. Retain the last valid
        // placement until measured metrics arrive, then attempt reveal once even if no point exists.
        if (!retainLayout || layoutChanged) caretLayout = { state, visible: !!visible, focused: focused && !composing };
        caret.hidden = !visible || selected.anchor !== selected.head || composing || owner.activeElement !== input;
        const left = ((point?.left ?? rectangle.left) - rectangle.left) / rectangle.zoom;
        const top = ((point?.top ?? rectangle.top) - rectangle.top) / rectangle.zoom;
        // Bound the native input anchor while the display caret follows the text, including clipped rows.
        input.style.left = `${root.scrollLeft + Math.max(0, Math.min(root.clientWidth - 2, left))}px`;
        input.style.top = `${root.scrollTop + Math.max(0, Math.min(root.clientHeight - 24, top))}px`;
        caret.style.left = `${root.scrollLeft + left}px`;
        caret.style.top = `${root.scrollTop + top}px`;
        for (const element of [input, caret]) element.style.height = `${point ? point.height / rectangle.zoom : viewport.snapshot().lineHeight}px`;
        const buffer = currentDocument?.buffer;
        const points = [];
        if (!composing && owner.activeElement === input && buffer && state.selectionSet === selectionSet && state.lastLine > state.firstLine) {
            const from = buffer.offsetAt(state.firstLine), to = state.lastLine < buffer.lineCount ? buffer.offsetAt(state.lastLine) : buffer.length;
            // Heads of normalized disjoint ranges are ordered. Measure only visible candidates,
            // using the same bounded native row geometry as the primary caret.
            let low = 0, high = selectionSet.ranges.length;
            while (low < high) {
                const middle = (low + high) >>> 1;
                if (selectionSet.ranges[middle]!.head < from) low = middle + 1;
                else high = middle;
            }
            for (let index = low; index < selectionSet.ranges.length; index++) {
                const range = selectionSet.ranges[index]!;
                if (range.head > to) break;
                if (index === selectionSet.primary || range.anchor !== range.head) continue;
                if (view.folding.getSnapshot().index.hiddenBy(buffer.lineAt(range.head))) continue;
                const at = viewport.coordsAt(range.head, range.headAffinity);
                if (at && at.left >= rectangle.left && at.left < rectangle.right
                    && at.top + at.height > rectangle.top && at.top < rectangle.bottom) points.push(at);
            }
        }
        while (caretNodes.length > points.length) caretNodes.pop()!.remove();
        points.forEach((at, index) => {
            let node = caretNodes[index];
            if (!node) {
                node = owner.createElement("div");
                node.className = "st-input-secondary-caret";
                caretNodes.push(node);
                secondaryCarets.append(node);
            }
            node.style.left = `${root.scrollLeft + (at.left - rectangle.left) / rectangle.zoom}px`;
            node.style.top = `${root.scrollTop + (at.top - rectangle.top) / rectangle.zoom}px`;
            node.style.height = `${at.height / rectangle.zoom}px`;
        });
    }
    return Object.freeze({ schedule, pending: () => frame !== undefined,
        dispose: () => {
            if (disposed) return;
            disposed = true;
            if (frame !== undefined) win.cancelAnimationFrame(frame);
            frame = undefined; caretLayout = undefined;
            caretNodes.length = 0; secondaryCarets.replaceChildren();
            caret.remove(); secondaryCarets.remove();
        } });
}
