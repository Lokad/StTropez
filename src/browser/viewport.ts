import type { DocumentId, DocumentSnapshot, DocumentView, Selection, SelectionSet, TabId, TextBuffer, Workspace } from "../index.ts";
import type { ViewState } from "./index.ts";
import { scrollAxis } from "./scroll.ts";
import type { ScrollAxis } from "./scroll.ts";
import { rowGeometry } from "./text-geometry.ts";
import type { CaretRectangle } from "./text-geometry.ts";
import type { Affinity } from "../index.ts";

export type ViewportSnapshot = Readonly<{ revision: number | null; selection: Selection | null; selectionSet: SelectionSet | null; renders: number; firstLine: number; lastLine: number;
    rows: number; partialRows: number; textUnits: number; readUnits: number; lastRenderMs: number; scrollTop: number; scrollLeft: number; width: number; height: number;
    lineHeight: number; columnWidth: number; verticalExtent: number; horizontalExtent: number;
    physicalHeight: number; physicalWidth: number; pending: boolean; disposed: boolean }>;
export type TextViewport = Readonly<{ element: HTMLDivElement; view: DocumentView;
    captureView: () => ViewState; restoreView: (state: ViewState) => void;
    scrollTo: (position: Readonly<{ top?: number; left?: number }>) => void;
    coordsAt: (offset: number, affinity?: Affinity) => CaretRectangle | undefined;
    hitTest: (clientX: number, clientY: number) => CaretRectangle | undefined;
    moveVisual: (offset: number, affinity: Affinity, direction: -1 | 1) => CaretRectangle | undefined;
    collapseVisual: (from: number, to: number, direction: -1 | 1) => CaretRectangle | undefined;
    flush: () => void;
    invalidate: () => void;
    revealOffset: (offset: number, options?: RevealOptions) => void; snapshot: () => ViewportSnapshot; destroy: () => void }>;
type Row = Readonly<{ line: number; from: number; to: number; text: string; left: number; complete: boolean }>;
type RowPart = Readonly<{ text: string; className: string }>;
function renderRowChildren(element: HTMLElement, parts: readonly RowPart[]): void {
    if (element.childNodes.length === parts.length && parts.every((part, index) => {
        const node = element.childNodes.item(index); if (!node || node.textContent !== part.text) return false;
        return part.className ? node.nodeName === "SPAN" && (node as HTMLSpanElement).className === part.className
            && node.childNodes.length === 1 && node.firstChild?.nodeType === Node.TEXT_NODE : node.nodeType === Node.TEXT_NODE;
    })) return;
    const owner = element.ownerDocument;
    element.replaceChildren(...parts.map(part => {
        if (!part.className) return owner.createTextNode(part.text);
        const span = owner.createElement("span"); span.className = part.className; span.textContent = part.text; return span;
    }));
}
export type InlineDecoration = Readonly<{ from: number; to: number; className: string }>;
export type PresentedLine = Readonly<{ documentId: DocumentId; revision: number; line: number; lineStart: number; from: number; to: number; text: string }>;
export type LineDecorator = (line: PresentedLine) => readonly InlineDecoration[];
export type LineClass = (line: PresentedLine) => string | undefined;
export type RevealOptions = Readonly<{ horizontal?: "center" | "nearest"; vertical?: "center" | "nearest"; affinity?: Affinity }>;

/** Bounded DOM view layer with local native text geometry. Native-device qualification remains separate. */
export function mountTextViewport(host: HTMLElement, workspace: Workspace, tabId: TabId,
    options: Readonly<{ ariaLabel?: string; view?: DocumentView; overscanLines?: number; overscanUnits?: number; decorate?: LineDecorator; lineClass?: LineClass }> = {}): TextViewport {
    const target = workspace.captureTab(tabId), tab = workspace.resolveTab(target);
    if (!tab || tab.surface.kind !== "text") throw new Error("Expected a text surface.");
    const documentId = tab.surface.documentId, resource = workspace.resourceForDocument(documentId);
    if (options.view && (options.view.documentId !== documentId || !workspace.ownsDocumentView(options.view))) throw new Error("View belongs to a different document or workspace.");
    const overscanLines = options.overscanLines ?? 4, overscanUnits = options.overscanUnits ?? 32;
    if (![overscanLines, overscanUnits].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 256)) throw new RangeError("Invalid viewport overscan.");
    const view = options.view ?? workspace.createDocumentView(documentId), owner = host.ownerDocument, browserWindow = owner.defaultView;
    if (!browserWindow) { if (!options.view) view.dispose(); throw new Error("Viewport requires an attached browser document."); }
    const win = browserWindow;
    const root = owner.createElement("div"), spacer = owner.createElement("div"), layer = owner.createElement("div"), probe = owner.createElement("span");
    root.className = "st-viewport"; root.tabIndex = 0; root.setAttribute("role", "region"); root.setAttribute("aria-label", options.ariaLabel ?? workspace.document(documentId).title);
    spacer.className = "st-viewport-spacer"; spacer.setAttribute("aria-hidden", "true");
    layer.className = "st-viewport-layer"; probe.className = "st-viewport-measure"; probe.textContent = "M".repeat(64); probe.setAttribute("aria-hidden", "true");
    root.append(spacer, layer, probe); host.append(root);
    const listeners = new AbortController(), padding = 12;
    let frame: number | undefined, disposed = false, previous: DocumentSnapshot | undefined;
    let top = 0, left = 0, width = 0, height = 0, lineHeight = 22.4, columnWidth = 8.4;
    let x = scrollAxis(0, 0), y = scrollAxis(0, 0), renderedRevision: number | null = null;
    let renderedSelection: Selection | null = null;
    let renderedSelectionSet: SelectionSet | null = null;
    let renders = 0, firstLine = 0, lastLine = 0, partialRows = 0, textUnits = 0, readUnits = 0, lastRenderMs = 0;
    let anchor: Readonly<{ revision: number; offset: number; topRemainder: number; leftRemainder: number }> | undefined;
    let reveal: Readonly<{ revision: number; offset: number; horizontal: "center" | "nearest"; vertical: "center" | "nearest"; affinity: Affinity }> | undefined;
    let horizontalAnchor: ViewState["horizontalAnchor"];
    let fragmentPlacement: Readonly<{ revision: number; line: number; from: number; to: number; left: number; shift: number }> | undefined;
    let measuredWidth = 0, measuredFont = "", measuredRevision: number | null = null;
    const rows = new Map<number, HTMLDivElement>();
    const geometries = new Map<number, ReturnType<typeof rowGeometry>>();
    const geometry = (element: HTMLDivElement) => {
        const line = Number(element.dataset.line); let value = geometries.get(line);
        if (!value) { value = rowGeometry(element, Number(element.dataset.from), renderedRevision!, lineHeight); geometries.set(line, value); } return value;
    };
    const coordinates = (offset: number, affinity: Affinity = "after"): CaretRectangle | undefined => {
        if (disposed || !workspace.resolveTab(target) || workspace.observeDocument(documentId).getSnapshot()?.revision !== renderedRevision) return undefined;
        for (const element of rows.values()) if (offset >= Number(element.dataset.from) && offset <= Number(element.dataset.to)) return geometry(element).point(offset, affinity);
        return undefined;
    };
    const schedule = () => { if (!disposed && frame === undefined) frame = win.requestAnimationFrame(render); };
    const flush = () => { if (disposed) return; if (frame !== undefined) { win.cancelAnimationFrame(frame); frame = undefined; } render(); };
    const completeRow = (offset: number): HTMLDivElement | undefined => {
        const document = workspace.observeDocument(documentId).getSnapshot();
        if (disposed || !workspace.resolveTab(target) || document?.revision !== renderedRevision) return;
        const line = document.buffer.lineAt(offset); let element = rows.get(line);
        if (!element) { reveal = { revision: document.revision, offset, horizontal: "nearest", vertical: "nearest", affinity: "after" }; flush(); element = rows.get(line); }
        return document.revision === workspace.observeDocument(documentId).getSnapshot()?.revision && element?.dataset.complete === "true" ? element : undefined;
    };
    const position = (axis: ScrollAxis, value: number): number => Math.min(axis.maximum, Math.max(0, value));
    const setScroll = (position: Readonly<{ top?: number; left?: number }>) => {
        if (disposed) return;
        if ((position.top !== undefined && !Number.isFinite(position.top)) || (position.left !== undefined && !Number.isFinite(position.left))) throw new RangeError("Invalid scroll position.");
        if (position.top !== undefined) top = Math.max(0, position.top);
        if (position.left !== undefined) left = Math.max(0, position.left);
        anchor = undefined; horizontalAnchor = undefined; fragmentPlacement = undefined;
        schedule();
    };
    const documentChanged = () => {
        const current = workspace.observeDocument(documentId).getSnapshot();
        if (current && previous && current.revision !== previous.revision) {
            if (!anchor) {
                const line = Math.min(previous.buffer.lineCount - 1, Math.max(0, Math.floor((top - padding) / lineHeight)));
                const start = previous.buffer.offsetAt(line), end = line + 1 < previous.buffer.lineCount ? previous.buffer.offsetAt(line + 1) - 1 : previous.buffer.length;
                const offset = Math.min(end, start + Math.floor(left / columnWidth));
                anchor = { revision: previous.revision, offset, topRemainder: top - line * lineHeight, leftRemainder: left - (offset - start) * columnWidth };
            }
            anchor = current.change?.previousRevision === anchor.revision
                ? { ...anchor, revision: current.revision, offset: current.change.mapping.map(anchor.offset, "before").offset } : undefined;
            if (reveal && current.change?.previousRevision === reveal.revision) reveal = { ...reveal, revision: current.revision, offset: current.change.mapping.map(reveal.offset, reveal.affinity).offset };
            if (horizontalAnchor) horizontalAnchor = current.change?.previousRevision === horizontalAnchor.revision
                ? { ...horizontalAnchor, revision: current.revision, offset: current.change.mapping.map(horizontalAnchor.offset, horizontalAnchor.affinity).offset } : undefined;
            fragmentPlacement = undefined;
        } else if (!current) { anchor = undefined; reveal = undefined; horizontalAnchor = undefined; fragmentPlacement = undefined; }
        schedule();
    };
    const read = (buffer: TextBuffer, from: number, to: number): string => { readUnits += to - from; return buffer.slice(from, to); };
    const expose = (start: number, size: number, scroll: number, visible: number): number => {
        const margin = Math.min(padding, visible / 4);
        return start < scroll + margin ? Math.max(0, start - margin) : start + size > scroll + visible - margin ? Math.max(0, start + size - visible + margin) : scroll;
    };
    const horizontalPosition = (value: number): number => { const margin = Math.min(padding, width / 4); return Math.max(margin, Math.min(width - margin, value)); };
    const row = (buffer: TextBuffer, line: number): Row => {
        const start = buffer.offsetAt(line), end = line + 1 < buffer.lineCount ? buffer.offsetAt(line + 1) - 1 : buffer.length;
        const displayEnd = line + 1 < buffer.lineCount && end > start && read(buffer, end - 1, end) === "\r" ? end - 1 : end;
        let from = Math.min(displayEnd, start + Math.max(0, Math.floor((left - padding) / columnWidth) - overscanUnits));
        let to = Math.min(displayEnd, start + Math.max(0, Math.ceil((left + width) / columnWidth) + overscanUnits));
        if (displayEnd - start <= 512) { from = start; to = displayEnd; }
        // Do not split a surrogate pair at the edges of the bounded text window.
        if (from > start && from < displayEnd) { const pair = read(buffer, from - 1, from + 1); if (/[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(pair)) from--; }
        if (to > from && to < displayEnd) { const pair = read(buffer, to - 1, to + 1); if (/[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(pair)) to++; }
        return { line, from, to, text: read(buffer, from, to).replaceAll("\r", "␍"), left: padding + (from - start) * columnWidth - left, complete: from === start && to === displayEnd };
    };
    function render(): void {
        frame = undefined; if (disposed) return;
        const started = win.performance.now();
        // Read container metrics before writing rows; bounded shaping reads follow the writes.
        width = root.clientWidth; height = root.clientHeight;
        columnWidth = probe.getBoundingClientRect().width / 64 || 8.4;
        const style = win.getComputedStyle(root); lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.6;
        const font = [style.fontFamily, style.fontSize, style.fontWeight, style.fontStyle, style.letterSpacing, style.tabSize].join("|");
        if (font !== measuredFont) { measuredWidth = 0; measuredFont = font; }
        const document = workspace.resolveTab(target) ? workspace.observeDocument(documentId).getSnapshot() : undefined;
        if (!document) {
            layer.replaceChildren(); rows.clear(); geometries.clear(); measuredWidth = 0; measuredRevision = null; spacer.style.width = "0px"; spacer.style.height = "0px";
            layer.style.transform = "none"; layer.style.width = "0px"; layer.style.height = "0px";
            root.setAttribute("aria-disabled", "true"); root.setAttribute("aria-busy", String(resource.getSnapshot().state === "loading"));
            previous = undefined; anchor = undefined; renderedRevision = null; renderedSelection = null; renderedSelectionSet = null; partialRows = 0; textUnits = 0; readUnits = 0; firstLine = 0; lastLine = 0; return;
        }
        if (measuredRevision !== document.revision) { measuredWidth = 0; measuredRevision = document.revision; }
        if (anchor?.revision === document.revision) {
            const line = document.buffer.lineAt(anchor.offset);
            top = line * lineHeight + anchor.topRemainder; left = (anchor.offset - document.buffer.offsetAt(line)) * columnWidth + anchor.leftRemainder;
        } else if (previous && previous.revision !== document.revision && document.change === null) { top = 0; left = 0; }
        if (reveal?.revision === document.revision) {
            const line = document.buffer.lineAt(reveal.offset);
            top = reveal.vertical === "nearest" ? expose(padding + line * lineHeight, lineHeight, top, height) : Math.max(0, line * lineHeight - height / 2);
            const estimated = padding + (reveal.offset - document.buffer.offsetAt(line)) * columnWidth;
            left = reveal.horizontal === "nearest" ? expose(estimated, 1, left, width) : Math.max(0, estimated - width / 2);
        }
        const requested = reveal; anchor = undefined; reveal = undefined;
        x = scrollAxis(Math.max(document.buffer.longestLineLength * columnWidth, measuredWidth) + padding * 2, width);
        y = scrollAxis(document.buffer.lineCount * lineHeight + padding * 2, height);
        top = position(y, top); left = position(x, left); readUnits = 0;
        firstLine = Math.min(document.buffer.lineCount - 1, Math.max(0, Math.floor((top - padding) / lineHeight) - overscanLines));
        lastLine = Math.min(document.buffer.lineCount, Math.ceil((top + height) / lineHeight) + overscanLines);
        const { selection: selected, selectionSet } = view.getSnapshot();
        const next: Row[] = []; for (let line = firstLine; line < lastLine; line++) next.push(row(document.buffer, line));
        partialRows = next.filter(row => !row.complete).length;
        spacer.style.width = `${x.physicalExtent}px`; spacer.style.height = `${y.physicalExtent}px`;
        const physicalLeft = x.toPhysical(left), physicalTop = y.toPhysical(top);
        root.scrollLeft = physicalLeft; root.scrollTop = physicalTop;
        layer.style.width = `${width}px`; layer.style.height = `${height}px`;
        layer.style.transform = `translate(${physicalLeft}px, ${physicalTop}px)`;
        textUnits = 0;
        for (const item of next) {
            let element = rows.get(item.line);
            if (!element) { element = owner.createElement("div"); element.className = "st-viewport-row"; rows.set(item.line, element); layer.append(element); }
            element.dataset.line = String(item.line); element.dataset.from = String(item.from); element.dataset.to = String(item.to);
            element.dataset.complete = String(item.complete);
            const placement = fragmentPlacement, shift = placement?.revision === document.revision && placement.line === item.line
                && placement.from === item.from && placement.to === item.to && placement.left === left ? placement.shift : 0;
            element.style.transform = `translate(${item.left + shift}px, ${padding + item.line * lineHeight - top}px)`;
            element.style.height = `${lineHeight}px`;
            // Normalized ranges are ordered and disjoint. Seek directly to this bounded row;
            // offscreen ranges add no text reads, decoration boundaries or DOM nodes.
            let low = 0, high = selectionSet.ranges.length;
            while (low < high) { const middle = (low + high) >>> 1, range = selectionSet.ranges[middle]!;
                if (Math.max(range.anchor, range.head) <= item.from) low = middle + 1; else high = middle; }
            const selections: { from: number; to: number }[] = [];
            for (let index = low; index < selectionSet.ranges.length; index++) {
                const range = selectionSet.ranges[index]!, from = Math.max(item.from, Math.min(range.anchor, range.head)), to = Math.min(item.to, Math.max(range.anchor, range.head));
                if (from >= item.to) break;
                if (from < to) selections.push({ from, to });
            }
            const presented = { documentId, revision: document.revision, line: item.line, lineStart: document.buffer.offsetAt(item.line), from: item.from, to: item.to, text: item.text };
            const lineClass = options.lineClass?.(presented);
            element.className = "st-viewport-row" + (lineClass && /^[a-zA-Z][\w-]{0,63}$/.test(lineClass) ? ` ${lineClass}` : "");
            const decorations = options.decorate?.(presented);
            if (decorations?.length || selections.length) {
                const ranges = (decorations ?? []).filter(range => Number.isSafeInteger(range.from) && Number.isSafeInteger(range.to) && range.from >= 0 && range.to <= document.buffer.length && range.from < range.to
                    && range.from < item.to && range.to > item.from && /^[a-zA-Z][\w-]{0,63}$/.test(range.className));
                const boundaries = new Set([item.from, item.to]);
                for (const range of selections) { boundaries.add(range.from); boundaries.add(range.to); }
                for (const range of ranges) { boundaries.add(Math.max(item.from, range.from)); boundaries.add(Math.min(item.to, range.to)); }
                const offsets = [...boundaries].sort((a, b) => a - b), children: RowPart[] = [];
                let selectedIndex = 0;
                for (let index = 0; index + 1 < offsets.length; index++) {
                    const start = offsets[index]!, end = offsets[index + 1]!, classes = ranges.filter(range => range.from < end && range.to > start).map(range => range.className);
                    while (selectedIndex < selections.length && selections[selectedIndex]!.to <= start) selectedIndex++;
                    if (selections[selectedIndex] && start >= selections[selectedIndex]!.from && end <= selections[selectedIndex]!.to) classes.push("st-viewport-selected");
                    const text = item.text.slice(start - item.from, end - item.from);
                    children.push({ text, className: classes.join(" ") });
                }
                renderRowChildren(element, children);
            } else renderRowChildren(element, [{ text: item.text, className: "" }]);
            textUnits += item.text.length;
        }
        for (const [line, element] of rows) if (line < firstLine || line >= lastLine) { element.remove(); rows.delete(line); }
        next.forEach((item, index) => { const element = rows.get(item.line)!; if (layer.children.item(index) !== element) layer.insertBefore(element, layer.children.item(index)); });
        root.removeAttribute("aria-disabled"); root.setAttribute("aria-busy", "false"); root.dataset.revision = String(document.revision);
        renderedRevision = document.revision; renderedSelection = selected; renderedSelectionSet = selectionSet; previous = document; renders++; geometries.clear();
        // A bounded batch of native shaping measurements follows the row writes. Extent corrections
        // are scheduled for the next frame, without alternating reads and writes for each row.
        const measured = Math.max(0, ...[...rows.values()].filter(element => element.dataset.complete === "true").map(element => element.getBoundingClientRect().width));
        if (measured > measuredWidth + .01) { measuredWidth = measured; if (measuredWidth + padding * 2 > x.extent + .01) schedule(); }
        const requestedRow = requested?.revision === document.revision ? rows.get(document.buffer.lineAt(requested.offset)) : undefined;
        if (requestedRow?.dataset.complete === "false") {
            const caret = coordinates(requested!.offset, requested!.affinity), rectangle = root.getBoundingClientRect();
            if (caret) {
                const actual = caret.left - rectangle.left, desired = requested!.horizontal === "center" ? width / 2 : horizontalPosition(actual);
                if (Math.abs(desired - actual) > 1) horizontalAnchor = { revision: document.revision, offset: requested!.offset, affinity: requested!.affinity, left: desired };
            }
        }
        // A partial row has no measured global horizontal origin. Move only its bounded
        // fragment to expose the requested native caret; keep the logical scroll map intact.
        if (horizontalAnchor?.revision === document.revision) {
            const at = horizontalAnchor, line = document.buffer.lineAt(at.offset), item = next.find(item => item.line === line), element = rows.get(line);
            if (item && !item.complete && element && at.offset >= item.from && at.offset <= item.to) {
                const caret = coordinates(at.offset, at.affinity), rectangle = root.getBoundingClientRect();
                if (caret) {
                    const desired = horizontalPosition(at.left), delta = desired - (caret.left - rectangle.left);
                    if (Math.abs(delta) > 1) {
                        const prior = fragmentPlacement, shift = (prior?.revision === document.revision && prior.line === line && prior.from === item.from
                            && prior.to === item.to && prior.left === left ? prior.shift : 0) + delta;
                        element.style.transform = `translate(${item.left + shift}px, ${padding + line * lineHeight - top}px)`;
                        fragmentPlacement = { revision: document.revision, line, from: item.from, to: item.to, left, shift };
                    }
                }
            }
        } else if (requested?.revision === document.revision && requestedRow?.dataset.complete === "true") {
            const caret = coordinates(requested.offset, requested.affinity), rectangle = root.getBoundingClientRect();
            if (caret) {
                const actual = caret.left - rectangle.left + left;
                const desired = requested.horizontal === "nearest" ? expose(actual, 1, left, width) : Math.max(0, actual - width / 2);
                const maximum = Math.max(0, Math.max(document.buffer.longestLineLength * columnWidth, measuredWidth) + padding * 2 - width);
                if (Math.abs(Math.min(maximum, desired) - left) > 1) { left = Math.min(maximum, desired); schedule(); }
            }
        }
        lastRenderMs = win.performance.now() - started;
        root.dispatchEvent(new CustomEvent("sttropez-render"));
    }
    root.addEventListener("scroll", () => {
        const newTop = y.toLogical(root.scrollTop), newLeft = x.toLogical(root.scrollLeft);
        // Ignore quantization from writes to native fractional/scaled scroll offsets.
        if (Math.abs(root.scrollTop - y.toPhysical(top)) > 1 || Math.abs(root.scrollLeft - x.toPhysical(left)) > 1) { top = newTop; left = newLeft; anchor = undefined; horizontalAnchor = undefined; fragmentPlacement = undefined; schedule(); }
    }, { signal: listeners.signal });
    root.addEventListener("wheel", event => {
        const factor = event.deltaMode === 1 ? lineHeight : event.deltaMode === 2 ? height : 1;
        const nextTop = position(y, top + (event.shiftKey ? 0 : event.deltaY) * factor), nextLeft = position(x, left + (event.shiftKey ? event.deltaY : event.deltaX) * factor);
        if (nextTop !== top || nextLeft !== left) { event.preventDefault(); top = nextTop; left = nextLeft; anchor = undefined; horizontalAnchor = undefined; fragmentPlacement = undefined; schedule(); }
    }, { passive: false, signal: listeners.signal });
    root.addEventListener("keydown", event => {
        if (event.target !== root || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
        const delta = { ArrowUp: [0, -lineHeight], ArrowDown: [0, lineHeight], ArrowLeft: [-columnWidth, 0], ArrowRight: [columnWidth, 0],
            PageUp: [0, -height * .9], PageDown: [0, height * .9] }[event.key];
        if (delta) { event.preventDefault(); setScroll({ left: position(x, left + delta[0]!), top: position(y, top + delta[1]!) }); }
    }, { signal: listeners.signal });
    const observer = new ResizeObserver(schedule); observer.observe(root); observer.observe(probe);
    owner.fonts.addEventListener("loadingdone", schedule, { signal: listeners.signal });
    owner.fonts.addEventListener("loadingerror", schedule, { signal: listeners.signal });
    const subscriptions = [workspace.observeDocument(documentId).subscribe(documentChanged), view.subscribe(schedule), resource.metadata.subscribe(schedule), workspace.tabState.subscribe(schedule)];
    schedule();
    return Object.freeze({ element: root, view,
        invalidate: schedule,
        coordsAt: coordinates,
        hitTest: (clientX: number, clientY: number) => {
            if (!Number.isFinite(clientX) || !Number.isFinite(clientY) || disposed || !workspace.resolveTab(target)
                || workspace.observeDocument(documentId).getSnapshot()?.revision !== renderedRevision) return undefined;
            let element: HTMLDivElement | undefined, distance = Infinity;
            for (const candidate of rows.values()) {
                const rectangle = candidate.getBoundingClientRect(), next = Math.max(rectangle.top - clientY, clientY - rectangle.bottom, 0);
                if (next < distance) { element = candidate; distance = next; }
            }
            return element ? geometry(element).nearest(clientX) : undefined;
        },
        moveVisual: (offset: number, affinity: Affinity, direction: -1 | 1) => {
            const row = completeRow(offset); if (!row) return;
            const measured = geometry(row), before = measured.point(offset, "before"), after = measured.point(offset, "after"); if (!before || !after) return;
            if (before.offset !== offset && after.offset !== offset) return direction * before.left > direction * after.left ? before : after;
            const next = measured.visual(offset, affinity, direction); if (next) return next;
            const buffer = workspace.document(documentId).buffer, flow = win.getComputedStyle(row).direction === "rtl" ? -1 : 1, line = buffer.lineAt(offset) + direction * flow;
            if (line < 0 || line >= buffer.lineCount) return measured.edge(direction);
            const neighbor = completeRow(buffer.offsetAt(line)); return neighbor ? geometry(neighbor).edge(direction < 0 ? 1 : -1) : undefined;
        },
        collapseVisual: (from: number, to: number, direction: -1 | 1) => {
            const first = completeRow(from); if (!first) return;
            const flow = win.getComputedStyle(first).direction === "rtl" ? -1 : 1, row = direction * flow < 0 ? first : completeRow(to);
            return row ? geometry(row).edge(direction, from, to) : undefined;
        },
        flush,
        scrollTo: setScroll,
        captureView: () => { const { selection, selectionSet } = view.getSnapshot();
            return Object.freeze({ ...selection, selectionSet, scrollTop: top, scrollLeft: left,
                ...(horizontalAnchor ? { horizontalAnchor: Object.freeze({ ...horizontalAnchor }) } : {}) }); },
        restoreView: (state: ViewState) => {
            if (disposed) return; const document = workspace.document(documentId), value = state.horizontalAnchor;
            if (value && (!Number.isSafeInteger(value.revision) || value.revision < 0 || !Number.isSafeInteger(value.offset) || value.offset < 0
                || !Number.isFinite(value.left) || value.left < 0 || value.affinity !== "before" && value.affinity !== "after")) throw new RangeError("Invalid horizontal view anchor.");
            if (value?.revision === document.revision && value.offset > document.buffer.length) throw new RangeError("Horizontal view anchor is outside the document.");
            if (state.selectionSet) view.setSelections(document.revision, state.selectionSet.ranges, state.selectionSet.primary);
            else view.setSelection(document.revision, state);
            setScroll({ top: state.scrollTop, left: state.scrollLeft });
            if (value?.revision === document.revision) horizontalAnchor = { ...value };
        },
        revealOffset: (offset: number, options: RevealOptions = {}) => {
            if (disposed) return; const document = workspace.document(documentId); document.buffer.lineAt(offset);
            const horizontal = options.horizontal ?? "center", vertical = options.vertical ?? "center", affinity = options.affinity ?? "after";
            if (![horizontal, vertical].every(value => value === "center" || value === "nearest") || affinity !== "after" && affinity !== "before") throw new RangeError("Invalid reveal options.");
            horizontalAnchor = undefined; fragmentPlacement = undefined;
            reveal = { revision: document.revision, offset, horizontal, vertical, affinity }; schedule();
        },
        snapshot: () => Object.freeze({ revision: renderedRevision, selection: renderedSelection, selectionSet: renderedSelectionSet, renders, firstLine, lastLine, rows: rows.size, partialRows, textUnits, readUnits, lastRenderMs,
            scrollTop: top, scrollLeft: left, width, height, lineHeight, columnWidth, verticalExtent: y.extent, horizontalExtent: x.extent,
            physicalHeight: y.physicalExtent, physicalWidth: x.physicalExtent, pending: frame !== undefined, disposed }),
        destroy: () => {
            if (disposed) return; disposed = true; if (frame !== undefined) win.cancelAnimationFrame(frame); frame = undefined;
            observer.disconnect(); listeners.abort(); subscriptions.forEach(unsubscribe => unsubscribe()); rows.clear(); geometries.clear(); previous = undefined; anchor = undefined; reveal = undefined; horizontalAnchor = undefined; fragmentPlacement = undefined;
            renderedRevision = null; renderedSelection = null; renderedSelectionSet = null; partialRows = 0; textUnits = 0; readUnits = 0; layer.replaceChildren(); root.replaceChildren(); root.remove();
            if (!options.view) view.dispose();
        } });
}
