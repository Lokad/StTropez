import { clientBox, cssZoom } from "./dom-coordinates.ts";
import { isFocused } from "./dom-focus.ts";
import type { DocumentId, DocumentSnapshot, DocumentView, TabId, Workspace } from "../core/workspace.ts";
import type { Selection } from "../core/history.ts";
import type { SelectionSet } from "../core/selections.ts";
import type { TextBuffer } from "../core/text-buffer.ts";
import type { ViewState } from "./view-state.ts";
import { scrollAxis } from "./scroll.ts";
import type { ScrollAxis } from "./scroll.ts";
import { rowGeometry } from "./text-geometry.ts";
import type { CaretRectangle } from "./text-geometry.ts";
import type { Affinity } from "../core/positions.ts";
import { unchangedPositionEdges } from "../core/positions.ts";
import { createFoldRegions, FoldIndex } from "../core/folding.ts";
import { sameSelectionSet } from "../core/selections.ts";
import { partitionPoint } from "../core/bound-search.ts";
import { decorationParts, validDecorationClass } from "./decoration-parts.ts";
import type { RowPart } from "./decoration-parts.ts";
import type { ComparisonRowIndex } from "../core/comparison-rows.ts";
import { mountColumnRulers, resolveColumnRulers } from "./column-rulers.ts";
type RowIndex = FoldIndex | ComparisonRowIndex;
const emptyIndex = new FoldIndex(1, []);
const overscanLines = 4, overscanUnits = 32;
/** Shared by view-only scroll coordination; this is independent of source coordinates. */
export const viewportPadding = 12;
export type ViewportComparisonRows = Readonly<{ documentId: DocumentId; revision: number; foldGeneration: number; id: number; lineHeight: number; index: ComparisonRowIndex }>;
export type RenderedRowBounds = Readonly<{ revision: number; foldGeneration: number; line: number; top: number; height: number }>;

export type ViewportActivity = Readonly<{ revision: number | null; selectionSet: SelectionSet | null; foldGeneration: number;
    aligned: boolean; alignmentId: number | null; rowGeneration: number; pending: boolean; disposed: boolean }>;
export type ViewportSnapshot = ViewportActivity & Readonly<{ selection: Selection | null; renders: number; firstLine: number; lastLine: number;
    visibleLines: number; collapsedFolds: number; visualRows: number; paddingRows: number; naturalLineHeight: number;
    rows: number; partialRows: number; textUnits: number; readUnits: number; navigationReadUnits: number; navigationRows: number; navigationBatches: number; navigationPreparedRows: number; maxNavigationBatchRows: number; lastRenderMs: number; scrollTop: number; scrollLeft: number; width: number; height: number;
    lineHeight: number; columnWidth: number; verticalExtent: number; horizontalExtent: number;
    physicalHeight: number; physicalWidth: number }>;
export type ViewportInputBinding = Readonly<{ setComposing: (active: boolean) => boolean;
    setTabEscape: (active: boolean) => boolean; dispose: () => void }>;

type ViewportNavigation = Readonly<{
    visualRowAt: (line: number) => number;
    navigationLine: (line: number, direction: -1 | 1, count: number, page: boolean) => number;
    moveVisual: (offset: number, affinity: Affinity, direction: -1 | 1) => CaretRectangle | undefined;
    collapseVisual: (from: number, to: number, direction: -1 | 1) => CaretRectangle | undefined;
    columnAt: (offset: number, affinity?: Affinity) => number | undefined;
    caretAtColumn: (line: number, column: number) => Readonly<Pick<CaretRectangle, "offset" | "affinity" | "revision">> | undefined;
    prepareNavigationRows: (lines: readonly number[]) => () => void;
}>;
export type TextViewport = Readonly<{ element: HTMLDivElement; view: DocumentView;
    /** Observe completed paints and consumed scheduled renders, including unchanged paints. */
    onRender: (listener: () => void) => () => void;
    /** One input owner controls composition, fold tab stops and source-focus recovery. */
    bindInput: (focus: () => void) => ViewportInputBinding;
    columnRulers: () => readonly number[];
    configureColumnRulers: (columns: readonly number[]) => boolean;
    currentLineHighlight: () => boolean;
    configureCurrentLineHighlight: (enabled: boolean) => boolean;
    fontLigatures: () => boolean;
    configureFontLigatures: (enabled: boolean) => boolean;
    scrollBeyondLastLine: () => boolean;
    configureScrollBeyondLastLine: (enabled: boolean) => boolean;
    captureView: () => ViewState; restoreView: (state: ViewState) => void;
    scrollTo: (position: Readonly<{ top?: number; left?: number }>) => void;
    coordsAt: (offset: number, affinity?: Affinity) => CaretRectangle | undefined;
    rowBounds: (line: number) => RenderedRowBounds | undefined;
    hitTest: (clientX: number, clientY: number) => CaretRectangle | undefined;
    flush: () => void;
    invalidate: () => void;
    /** Immutable painted identities and scheduled-work state; reused while unchanged. Does not flush or measure layout. */
    activity: () => ViewportActivity;
    revealOffset: (offset: number, options?: RevealOptions) => void; snapshot: () => ViewportSnapshot; dispose: () => void }>;
type Row = Readonly<{ line: number; start: number; end: number; from: number; to: number; text: string; left: number; complete: boolean; endsLine: boolean }>;
/** CRLF has two raw positions at one painted line edge. Keep the requested model offset. */
function rowCaretOffset(buffer: TextBuffer, end: number, offset: number): number | undefined {
    if (offset <= end) return offset;
    return offset === end + 1 && offset < buffer.length && buffer.slice(end, end + 2) === "\r\n" ? end : undefined;
}
function renderRowChildren(element: HTMLElement, parts: readonly RowPart[]): boolean {
    if (element.childNodes.length === parts.length && parts.every((part, index) => {
        const node = element.childNodes.item(index); if (!node || node.textContent !== part.text) return false;
        return part.className ? node.nodeName === "SPAN" && (node as HTMLSpanElement).className === part.className
            && node.childNodes.length === 1 && node.firstChild?.nodeType === Node.TEXT_NODE : node.nodeType === Node.TEXT_NODE;
    })) return false;
    const owner = element.ownerDocument;
    element.replaceChildren(...parts.map(part => {
        if (!part.className) return owner.createTextNode(part.text);
        const span = owner.createElement("span"); span.className = part.className; span.textContent = part.text; return span;
    }));
    return true;
}
export type InlineDecoration = Readonly<{ from: number; to: number; className: string }>;
export type PresentedLine = Readonly<{ documentId: DocumentId; revision: number; line: number; lineStart: number; from: number; to: number; text: string }>;
export type LineDecorator = (line: PresentedLine) => readonly InlineDecoration[];
export type LineClass = (line: PresentedLine) => string | undefined;
export type RevealOptions = Readonly<{ horizontal?: "center" | "nearest"; vertical?: "center" | "nearest"; affinity?: Affinity }>;
export type TextViewportOptions = Readonly<{ ariaLabel?: string; view?: DocumentView; decorate?: LineDecorator; lineClass?: LineClass;
    columnRulers?: readonly number[]; highlightCurrentLine?: boolean; fontLigatures?: boolean; scrollBeyondLastLine?: boolean }>;

/** Bounded DOM view layer with local native text geometry. Native-device qualification remains separate. */
export function mountTextViewport(host: HTMLElement, workspace: Workspace, tabId: TabId,
    options: TextViewportOptions = {}): TextViewport {
    return mountViewport(host, workspace, tabId, options).viewport;
}

/** Internal mount: navigation and comparison publication share the viewport lifetime. */
export function mountViewport(host: HTMLElement, workspace: Workspace, tabId: TabId,
    options: TextViewportOptions = {}): Readonly<{ viewport: TextViewport; navigation: ViewportNavigation; setComparisonRows: (rows: ViewportComparisonRows | undefined) => boolean }> {
    let columns = resolveColumnRulers(options.columnRulers);
    let highlightCurrentLine = options.highlightCurrentLine === undefined ? false : options.highlightCurrentLine;
    if (typeof highlightCurrentLine !== "boolean") throw new TypeError("Current-line highlighting must be boolean.");
    let fontLigatures = options.fontLigatures === undefined ? false : options.fontLigatures;
    if (typeof fontLigatures !== "boolean") throw new TypeError("Font ligatures must be boolean.");
    let scrollBeyondLastLine = options.scrollBeyondLastLine === undefined ? false : options.scrollBeyondLastLine;
    if (typeof scrollBeyondLastLine !== "boolean") throw new TypeError("Scrolling beyond the last line must be boolean.");
    const target = workspace.captureTab(tabId), tab = workspace.resolveTab(target);
    if (!tab || tab.surface.kind !== "text") throw new Error("Expected a text surface.");
    const documentId = tab.surface.documentId, resource = workspace.resourceForDocument(documentId);
    if (options.view && (options.view.documentId !== documentId || !workspace.ownsDocumentView(options.view))) throw new Error("View belongs to a different document or workspace.");
    const view = options.view ?? workspace.createDocumentView(documentId), owner = host.ownerDocument, browserWindow = owner.defaultView;
    if (!browserWindow) { if (!options.view) view.dispose(); throw new Error("Viewport requires an attached browser document."); }
    const win = browserWindow;
    const root = owner.createElement("div"), spacer = owner.createElement("div"), layer = owner.createElement("div"), probeHost = owner.createElement("div"), probe = owner.createElement("span"), foldLayer = owner.createElement("div");
    root.className = "st-viewport"; root.tabIndex = 0; root.setAttribute("role", "region"); root.setAttribute("aria-label", options.ariaLabel ?? workspace.document(documentId).title);
    root.style.fontVariantLigatures = fontLigatures ? "normal" : "none";
    spacer.className = "st-viewport-spacer"; spacer.setAttribute("aria-hidden", "true");
    layer.className = "st-viewport-layer"; probe.className = "st-viewport-measure"; probe.textContent = "M".repeat(64); probe.setAttribute("aria-hidden", "true");
    probeHost.className = "st-viewport-measure-host"; probeHost.setAttribute("aria-hidden", "true"); probeHost.append(probe);
    foldLayer.className = "st-fold-controls"; const foldButtons = new Map<string, HTMLButtonElement>();
    root.append(spacer, layer, probeHost, foldLayer); host.append(root);
    const listeners = new AbortController(), padding = viewportPadding;
    // A private platform target preserves listener removal, reentrancy and error reporting
    // without routing editor coordination through the presentation DOM or model write guard.
    const events = new win.EventTarget(), observationStops = new Set<() => void>();
    let inputOwner: { composing: boolean; tabEscaped: boolean; detach: () => void } | undefined;
    const observe = (type: "render" | "focus", listener: () => void): (() => void) => {
        if (typeof listener !== "function") throw new TypeError("Viewport listener must be a function.");
        if (disposed || !workspace.resolveTab(target)) return () => {};
        const invoke = () => { if (!disposed && workspace.resolveTab(target)) listener(); };
        const stop = () => { events.removeEventListener(type, invoke); observationStops.delete(stop); };
        events.addEventListener(type, invoke); observationStops.add(stop);
        return stop;
    };
    const notify = (type: "render" | "focus") => events.dispatchEvent(new win.Event(type));
    const rulers = mountColumnRulers(layer, padding), notifications = workspace.createNotificationScope();
    let currentLineBackground: HTMLDivElement | undefined;
    const clearCurrentLine = () => { currentLineBackground?.remove(); currentLineBackground = undefined; };
    const currentLine = (document: DocumentSnapshot, selections: SelectionSet, index: RowIndex): number | undefined => {
        if (!highlightCurrentLine) return;
        const primary = selections.ranges[selections.primary]!; if (primary.anchor !== primary.head) return;
        const line = document.buffer.lineAt(primary.head); return index.hiddenBy(line)?.lineFrom ?? line;
    };
    let frame: number | undefined, disposed = false, previous: DocumentSnapshot | undefined;
    let top = 0, left = 0, width = 0, height = 0, lineHeight = 22.4, columnWidth = 8.4;
    let x = scrollAxis(0, 0), y = scrollAxis(0, 0), renderedRevision: number | null = null, renderedIndex: RowIndex = view.folding.getSnapshot().index, renderedFoldGeneration = -1, observedFoldRevision = view.folding.getSnapshot().revision;
    let comparisonRows: ViewportComparisonRows | undefined, rowGeneration = 0, renderedAlignmentId: number | null = null, naturalLineHeight = lineHeight;
    let renderedSelection: Selection | null = null;
    let renderedSelectionSet: SelectionSet | null = null;
    let renders = 0, firstLine = 0, lastLine = 0, partialRows = 0, textUnits = 0, readUnits = 0, lastRenderMs = 0;
    let navigationReadUnits = 0, navigationRows = 0, navigationBatches = 0, maxNavigationBatchRows = 0;
    const commandMeasure = owner.createElement("div"), commandRow = owner.createElement("div");
    commandMeasure.className = "st-viewport-command-measure"; commandMeasure.setAttribute("aria-hidden", "true"); commandMeasure.append(commandRow);
    let commandGeometry: ReturnType<typeof rowGeometry> | undefined;
    type CommandRow = { item: Row; element: HTMLDivElement; geometry?: ReturnType<typeof rowGeometry> };
    let preparedRows: Readonly<{ revision: number; selectionSet: SelectionSet; element: HTMLDivElement; rows: Map<number, CommandRow> }> | undefined;
    const clearPreparedRows = () => { if (preparedRows) { preparedRows.element.remove(); preparedRows.element.replaceChildren(); preparedRows.rows.clear(); preparedRows = undefined; } };
    let anchor: Readonly<{ revision: number; offset: number; topRemainder: number; leftRemainder: number; aligned?: true }> | undefined;
    let reveal: Readonly<{ revision: number; foldGeneration: number; offset: number; horizontal: "center" | "nearest"; vertical: "center" | "nearest"; affinity: Affinity }> | undefined;
    let horizontalAnchor: ViewState["horizontalAnchor"];
    let fragmentPlacement: Readonly<{ revision: number; line: number; from: number; to: number; left: number; shift: number }> | undefined;
    let measuredWidth = 0, measuredFont = "", measuredRevision: number | null = null;
    let paintEpoch = 0;
    let painted: Readonly<{ key: readonly unknown[]; horizontalAnchor: typeof horizontalAnchor; placement: typeof fragmentPlacement }> | undefined;
    const rows = new Map<number, HTMLDivElement>();
    // Source spans advance through transactions without changing the last painted DOM identities.
    const rowSources = new Map<HTMLDivElement, Pick<Row, "start" | "end">>();
    let rowSourceRevision: number | null = null;
    const paddingRows = new Map<number, HTMLDivElement>();
    type Geometry = Readonly<{ value: ReturnType<typeof rowGeometry>; from: number; revision: number; height: number }>;
    const geometries = new Map<number, Geometry>();
    const geometry = (element: HTMLDivElement) => {
        const line = Number(element.dataset.line), from = Number(element.dataset.from), height = lineHeight * cssZoom(root);
        let entry = geometries.get(line);
        if (!entry || entry.from !== from || entry.revision !== renderedRevision || entry.height !== height) {
            entry = { value: rowGeometry(element, from, renderedRevision!, height), from, revision: renderedRevision!, height }; geometries.set(line, entry);
        }
        return entry.value;
    };
    const coordinates = (offset: number, affinity: Affinity = "after"): CaretRectangle | undefined => {
        if (disposed || !workspace.resolveTab(target)) return undefined;
        const document = workspace.observeDocument(documentId).getSnapshot();
        if (document?.revision !== renderedRevision || view.folding.getSnapshot().generation !== renderedFoldGeneration
            || !Number.isSafeInteger(offset) || offset < 0 || offset > document.buffer.length) return undefined;
        const line = document.buffer.lineAt(offset), hidden = renderedIndex.hiddenBy(line);
        if (hidden) { const header = rows.get(hidden.lineFrom), point = header && geometry(header).point(Number(header.dataset.to), "before");
            return point ? Object.freeze({ ...point, offset, affinity }) : undefined; }
        const element = rows.get(line);
        if (element && offset >= Number(element.dataset.from) && offset <= Number(element.dataset.to) + 1) {
            const at = rowCaretOffset(document.buffer, Number(element.dataset.to), offset); if (at === undefined) return;
            const point = geometry(element).point(at, affinity); return point && at !== offset ? Object.freeze({ ...point, offset }) : point;
        }
        return undefined;
    };
    const schedule = () => { if (!disposed && frame === undefined) frame = win.requestAnimationFrame(() => render(true)); };
    // Host invalidation and font loading can change inline layout without changing text/classes.
    const invalidate = () => { paintEpoch++; geometries.clear(); commandGeometry = undefined; clearPreparedRows(); schedule(); };
    const flush = () => { if (disposed) return; const scheduled = frame !== undefined; if (scheduled) win.cancelAnimationFrame(frame!); render(scheduled); };
    const position = (axis: ScrollAxis, value: number): number => Math.min(axis.maximum, Math.max(0, value));
    const gapAt = (index: RowIndex, row: number) => "gapAt" in index ? index.gapAt(row) : undefined;
    function verticalAnchor(): ViewState["verticalAnchor"] {
        if (!previous || previous.revision !== workspace.observeDocument(documentId).getSnapshot()?.revision) return;
        const at = Math.min(renderedIndex.visibleLineCount - 1, Math.max(0, Math.floor((top - padding) / lineHeight))), gap = gapAt(renderedIndex, at);
        const offset = gap?.offset ?? previous.buffer.offsetAt(renderedIndex.lineAt(at));
        // Padding maps to a real boundary; keep its distance from that SOURCE row, which
        // may span several padding rows and therefore has a negative pixel remainder.
        return { revision: previous.revision, offset, topRemainder: top - renderedIndex.rowAt(previous.buffer.lineAt(offset)) * lineHeight,
            ...(renderedAlignmentId !== null ? { aligned: true } : {}) };
    }
    function setComparisonRows(value: ViewportComparisonRows | undefined): boolean {
        if (disposed || !workspace.resolveTab(target)) return false;
        const document = workspace.observeDocument(documentId).getSnapshot(), folds = view.folding.getSnapshot();
        if (value && (!document || value.documentId !== documentId || value.revision !== document.revision || value.foldGeneration !== folds.generation || !value.index.matches(document.buffer, folds.index))) return false;
        if (value && (!Number.isSafeInteger(value.id) || value.id < 1 || !Number.isFinite(value.lineHeight) || value.lineHeight <= 0)) throw new RangeError("Invalid comparison row capture.");
        if (comparisonRows?.id === value?.id) return true;
        const at = verticalAnchor(); if (at && !anchor) anchor = { revision: at.revision, offset: at.offset, topRemainder: at.topRemainder, leftRemainder: left - (at.offset - document!.buffer.offsetAt(document!.buffer.lineAt(at.offset))) * columnWidth };
        comparisonRows = value && Object.freeze({ ...value }); rowGeneration++; clearPreparedRows(); schedule(); return true;
    }
    const validateScroll = (position: Readonly<{ top?: number; left?: number }>) => {
        if ((position.top !== undefined && !Number.isFinite(position.top)) || (position.left !== undefined && !Number.isFinite(position.left))) throw new RangeError("Invalid scroll position.");
    };
    const setScroll = (position: Readonly<{ top?: number; left?: number }>) => {
        if (disposed) return;
        validateScroll(position);
        if (position.top !== undefined) top = Math.max(0, position.top);
        if (position.left !== undefined) left = Math.max(0, position.left);
        anchor = undefined; horizontalAnchor = undefined; fragmentPlacement = undefined;
        schedule();
    };
    function mapRowSources(current: DocumentSnapshot | undefined): void {
        if (current?.revision === rowSourceRevision) return;
        const change = current?.change;
        if (!current || !change || change.previousRevision !== rowSourceRevision) rowSources.clear();
        else {
            const mapping = change.mapping, edges = unchangedPositionEdges(mapping), delta = mapping.newLength - mapping.oldLength;
            for (const [element, source] of rowSources) {
                if (edges && source.start < edges.prefix && source.end <= edges.prefix) continue;
                if (edges && source.start >= mapping.oldLength - edges.suffix) {
                    if (delta) rowSources.set(element, { start: source.start + delta, end: source.end + delta });
                    continue;
                }
                // An empty row still owns a terminator; consuming it must not steal a neighboring empty row.
                const mapped = mapping.mapRange({ from: source.start, to: Math.min(mapping.oldLength, Math.max(source.end, source.start + 1)),
                    fromAffinity: "after", toAffinity: "before", onDelete: "invalidate" });
                if (mapped) rowSources.set(element, { start: mapped.from, end: source.start === source.end ? mapped.from : mapped.to });
                else rowSources.delete(element);
            }
        }
        rowSourceRevision = current?.revision ?? null;
    }
    function retainRows(document: DocumentSnapshot, next: readonly Row[]): void {
        // A host can flush before this viewport's document notification is delivered.
        mapRowSources(document);
        if (renderedRevision === document.revision || !rows.size) return;
        const targets = new Map(next.map(item => [item.start, item])), retained = new Map<number, HTMLDivElement>(), used = new Set<HTMLDivElement>();
        for (const [element, source] of rowSources) {
            const item = targets.get(source.start);
            if (item && item.end === source.end && !retained.has(item.line)) { retained.set(item.line, element); used.add(element); }
        }
        // Reserve every mapped row before recycling changed rows at their old line numbers.
        // The ordinary painter still validates text, decorations and selection parts for every node.
        for (const item of next) {
            const element = rows.get(item.line);
            if (!retained.has(item.line) && element && !used.has(element)) { retained.set(item.line, element); used.add(element); }
        }
        for (const element of rows.values()) if (!used.has(element)) { element.remove(); rowSources.delete(element); }
        rows.clear(); for (const [line, element] of retained) rows.set(line, element);
        geometries.clear();
    }
    const documentChanged = () => {
        clearPreparedRows();
        const current = workspace.observeDocument(documentId).getSnapshot();
        mapRowSources(current);
        if (current && previous && current.revision !== previous.revision) {
            if (!anchor) {
                const visibleRow = Math.min(renderedIndex.visibleLineCount - 1, Math.max(0, Math.floor((top - padding) / lineHeight))), line = renderedIndex.lineAt(visibleRow);
                const start = previous.buffer.offsetAt(line), end = line + 1 < previous.buffer.lineCount ? previous.buffer.offsetAt(line + 1) - 1 : previous.buffer.length;
                const offset = gapAt(renderedIndex, visibleRow)?.offset ?? Math.min(end, start + Math.floor(left / columnWidth));
                anchor = { revision: previous.revision, offset, topRemainder: top - renderedIndex.rowAt(previous.buffer.lineAt(offset)) * lineHeight, leftRemainder: left - (offset - start) * columnWidth };
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
    const foldsChanged = () => {
        clearPreparedRows();
        const folds = view.folding.getSnapshot(), documentAdvanced = folds.revision !== observedFoldRevision; observedFoldRevision = folds.revision;
        if (documentAdvanced) {
            if (reveal) reveal = { ...reveal, foldGeneration: folds.generation };
            schedule(); return;
        }
        if (previous && !anchor && previous.revision === workspace.observeDocument(documentId).getSnapshot()?.revision) {
            const visibleRow = Math.min(renderedIndex.visibleLineCount - 1, Math.max(0, Math.floor((top - padding) / lineHeight))), line = renderedIndex.lineAt(visibleRow);
            anchor = { revision: previous.revision, offset: previous.buffer.offsetAt(line), topRemainder: top - renderedIndex.rowAt(line) * lineHeight, leftRemainder: left };
        }
        if (reveal && reveal.foldGeneration !== folds.generation) reveal = undefined;
        horizontalAnchor = undefined; fragmentPlacement = undefined; schedule();
    };
    const read = (buffer: TextBuffer, from: number, to: number): string => { readUnits += to - from; return buffer.slice(from, to); };
    const expose = (start: number, size: number, scroll: number, visible: number): number => {
        const margin = Math.min(padding, visible / 4);
        return start < scroll + margin ? Math.max(0, start - margin) : start + size > scroll + visible - margin ? Math.max(0, start + size - visible + margin) : scroll;
    };
    const horizontalPosition = (value: number): number => { const margin = Math.min(padding, width / 4); return Math.max(margin, Math.min(width - margin, value)); };
    const row = (buffer: TextBuffer, line: number, scrollLeft = left, navigation = false): Row => {
        const readRow = navigation ? (buffer: TextBuffer, from: number, to: number) => { navigationReadUnits += to - from; return buffer.slice(from, to); } : read;
        const start = buffer.offsetAt(line), end = line + 1 < buffer.lineCount ? buffer.offsetAt(line + 1) - 1 : buffer.length;
        const displayEnd = line + 1 < buffer.lineCount && end > start && readRow(buffer, end - 1, end) === "\r" ? end - 1 : end;
        let from = Math.min(displayEnd, start + Math.max(0, Math.floor((scrollLeft - padding) / columnWidth) - overscanUnits));
        let to = Math.min(displayEnd, start + Math.max(0, Math.ceil((scrollLeft + width) / columnWidth) + overscanUnits));
        if (displayEnd - start <= 512) { from = start; to = displayEnd; }
        // Do not split a surrogate pair at the edges of the bounded text window.
        if (from > start && from < displayEnd) { const pair = readRow(buffer, from - 1, from + 1); if (/[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(pair)) from--; }
        if (to > from && to < displayEnd) { const pair = readRow(buffer, to - 1, to + 1); if (/[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(pair)) to++; }
        return { line, start, end: displayEnd, from, to, text: readRow(buffer, from, to).replaceAll("\r", "␍"), left: padding + (from - start) * columnWidth - scrollLeft, complete: from === start && to === displayEnd, endsLine: to === displayEnd };
    };
    const paintRow = (element: HTMLDivElement, item: Row, document: DocumentSnapshot, selectionSet: SelectionSet, highlightedLine?: number): boolean => {
        element.dataset.line = String(item.line); element.dataset.from = String(item.from); element.dataset.to = String(item.to); element.dataset.complete = String(item.complete);
        const low = partitionPoint(selectionSet.ranges.length, index => {
            const range = selectionSet.ranges[index]!;
            return Math.max(range.anchor, range.head) <= item.from;
        });
        const selections: { from: number; to: number }[] = [];
        for (let index = low; index < selectionSet.ranges.length; index++) {
            const range = selectionSet.ranges[index]!, from = Math.max(item.from, Math.min(range.anchor, range.head)), to = Math.min(item.to, Math.max(range.anchor, range.head));
            if (from >= item.to) break; if (from < to) selections.push({ from, to });
        }
        const presented = { documentId, revision: document.revision, line: item.line, lineStart: item.start, from: item.from, to: item.to, text: item.text };
        const lineClass = options.lineClass?.(presented), className = "st-viewport-row" + (lineClass && validDecorationClass(lineClass) ? ` ${lineClass}` : "")
            + (highlightedLine === item.line ? " st-current-line" : "");
        const changed = element.className !== className; element.className = className;
        const decorations = options.decorate?.(presented);
        return renderRowChildren(element, decorationParts(item.text, item.from, item.to, document.buffer.length, decorations, selections)) || changed;
    };
    type MeasuredRow = Readonly<{ complete: boolean; flow: -1 | 1; point: (offset: number, affinity?: Affinity) => CaretRectangle | undefined;
        visual: (offset: number, affinity: Affinity, direction: -1 | 1) => CaretRectangle | undefined;
        edge: (direction: -1 | 1, low?: number, high?: number) => CaretRectangle; nearest: (column: number) => CaretRectangle }>;
    function measuredRow(entry: CommandRow, revision: number, rectangle: ReturnType<typeof clientBox>): MeasuredRow {
        const { item, element } = entry, buffer = workspace.document(documentId).buffer, start = buffer.offsetAt(item.line);
        const value = entry.geometry ??= rowGeometry(element, 0, revision, lineHeight * rectangle.zoom), bounds = element.getBoundingClientRect(), origin = padding + (item.from - start) * columnWidth;
        const mapped = (point: CaretRectangle): CaretRectangle => Object.freeze({ ...point, offset: point.offset + item.from,
            left: rectangle.left + (origin - left) * rectangle.zoom + point.left - bounds.left, top: rectangle.top + (padding + renderedIndex.rowAt(item.line) * lineHeight - top) * rectangle.zoom + point.top - bounds.top });
        const optional = (point: CaretRectangle | undefined) => point && mapped(point);
        return { complete: item.complete, flow: win.getComputedStyle(element).direction === "rtl" ? -1 : 1,
            point: (offset, affinity) => {
                const at = rowCaretOffset(buffer, item.to, offset), point = at === undefined ? undefined : optional(value.point(at - item.from, affinity));
                return point && at !== offset ? Object.freeze({ ...point, offset }) : point;
            },
            visual: (offset, affinity, direction) => optional(value.visual(offset - item.from, affinity, direction)),
            edge: (direction, low = item.from, high = item.to) => mapped(value.edge(direction, low - item.from, high - item.from)),
            nearest: column => mapped(value.nearest(bounds.left + (column - origin) * rectangle.zoom)) };
    }
    function prepareNavigationRows(lines: readonly number[]): () => void {
        clearPreparedRows(); const document = workspace.observeDocument(documentId).getSnapshot();
        if (disposed || !workspace.resolveTab(target) || document?.revision !== renderedRevision) return () => {};
        if (lines.length > 64 || lines.some(line => !Number.isSafeInteger(line) || line < 0 || line >= document.buffer.lineCount)) throw new RangeError("Invalid navigation row batch.");
        const element = owner.createElement("div"), batchRows = new Map<number, CommandRow>(), selectionSet = view.getSnapshot().selectionSet;
        element.className = "st-viewport-command-measure"; element.setAttribute("aria-hidden", "true");
        const highlightedLine = currentLine(document, selectionSet, renderedIndex);
        for (const line of lines) {
            if (batchRows.has(line) || rows.get(line)?.dataset.complete === "true") continue;
            const buffer = document.buffer, start = buffer.offsetAt(line), end = line + 1 < buffer.lineCount ? buffer.offsetAt(line + 1) : buffer.length;
            // Complete short rows have a known origin. Contextual windows keep the existing fallback.
            if (end - start > 514) continue;
            const item = row(buffer, line, left, true); if (!item.complete) continue;
            const node = owner.createElement("div"); paintRow(node, item, document, selectionSet, highlightedLine); node.style.height = `${lineHeight}px`; node.style.lineHeight = comparisonRows ? `${lineHeight}px` : "";
            element.append(node); batchRows.set(line, { item, element: node });
        }
        // Identical painted rows already reuse the single-row probe's native geometry. Keep
        // that path instead of measuring separate copies of repeated text in a batch.
        const keys = new Map<CommandRow, string>(), counts = new Map<string, number>();
        for (const entry of batchRows.values()) { const key = entry.element.className + "\0" + entry.element.innerHTML;
            keys.set(entry, key); counts.set(key, (counts.get(key) ?? 0) + 1); }
        for (const [line, entry] of batchRows) if (counts.get(keys.get(entry)!)! > 1) { entry.element.remove(); batchRows.delete(line); }
        if (!batchRows.size) return () => {};
        // All writes precede native geometry reads. Keep the bounded batch across yielding turns;
        // the command owns its release, while document changes and destruction release eagerly.
        const batch = { revision: document.revision, selectionSet, element, rows: batchRows }; preparedRows = batch;
        root.append(element); navigationRows += batchRows.size; navigationBatches++; maxNavigationBatchRows = Math.max(maxNavigationBatchRows, batchRows.size);
        return () => { if (preparedRows === batch) clearPreparedRows(); };
    }
    function withRow<T>(line: number, scrollLeft: number, offset: number | undefined, complete: boolean, work: (row: MeasuredRow) => T): T | undefined {
        const document = workspace.observeDocument(documentId).getSnapshot();
        if (disposed || !workspace.resolveTab(target) || document?.revision !== renderedRevision) return;
        const existing = rows.get(line), rectangle = clientBox(root);
        if (existing && (existing.dataset.complete === "true" || !complete && scrollLeft === left
            && (offset === undefined || offset >= Number(existing.dataset.from) && offset <= Number(existing.dataset.to)))) {
            const value = geometry(existing);
            return work({ ...value, complete: existing.dataset.complete === "true", flow: win.getComputedStyle(existing).direction === "rtl" ? -1 : 1,
                nearest: column => value.nearest(rectangle.left + (column - left) * rectangle.zoom) });
        }
        if (preparedRows && (preparedRows.revision !== document.revision || preparedRows.selectionSet !== view.getSnapshot().selectionSet)) clearPreparedRows();
        const prepared = preparedRows?.rows.get(line); if (prepared) return work(measuredRow(prepared, document.revision, rectangle));
        const buffer = document.buffer, start = buffer.offsetAt(line), end = line + 1 < buffer.lineCount ? buffer.offsetAt(line + 1) : buffer.length;
        if (complete && end - start > 514) return;
        const item = row(buffer, line, scrollLeft, true); if (complete && !item.complete) return;
        const selectionSet = view.getSnapshot().selectionSet;
        const changed = paintRow(commandRow, item, document, selectionSet, currentLine(document, selectionSet, renderedIndex));
        commandRow.style.height = `${lineHeight}px`; commandRow.style.lineHeight = comparisonRows ? `${lineHeight}px` : ""; root.append(commandMeasure); navigationRows++;
        try {
            if (changed || !commandGeometry) commandGeometry = rowGeometry(commandRow, 0, document.revision, lineHeight * rectangle.zoom);
            return work(measuredRow({ item, element: commandRow, geometry: commandGeometry }, document.revision, rectangle));
        } finally { commandMeasure.remove(); }
    }
    const rowForOffset = <T>(offset: number, work: (row: MeasuredRow) => T): T | undefined => {
        if (disposed || !workspace.resolveTab(target)) return;
        const document = workspace.observeDocument(documentId).getSnapshot();
        if (disposed || !workspace.resolveTab(target) || document?.revision !== renderedRevision) return;
        const line = document.buffer.lineAt(offset);
        return withRow(line, left, offset, true, work);
    };
    function render(scheduled: boolean): void {
        frame = undefined; if (disposed) return;
        const started = win.performance.now();
        // Read container metrics before writing rows; bounded shaping reads follow the writes.
        width = root.clientWidth; height = root.clientHeight;
        const zoom = cssZoom(root);
        columnWidth = probe.getBoundingClientRect().width / zoom / 64 || 8.4;
        const style = win.getComputedStyle(root); naturalLineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.6; lineHeight = naturalLineHeight;
        const font = [style.fontFamily, style.fontSize, style.fontWeight, style.fontStyle, style.fontStretch, style.letterSpacing, style.wordSpacing,
            style.tabSize, style.direction, style.getPropertyValue("--st-text-direction"), style.fontVariant, style.fontVariantLigatures, style.fontKerning,
            style.fontFeatureSettings, style.fontVariationSettings, style.unicodeBidi, style.textAlign, style.textTransform, style.textIndent].join("|");
        if (font !== measuredFont) { measuredWidth = 0; measuredFont = font; }
        const document = workspace.resolveTab(target) ? workspace.observeDocument(documentId).getSnapshot() : undefined;
        if (!document) {
            rulers.clear();
            clearCurrentLine();
            painted = undefined; commandGeometry = undefined;
            layer.replaceChildren(); rows.clear(); rowSources.clear(); rowSourceRevision = null; geometries.clear(); measuredWidth = 0; measuredRevision = null; spacer.style.width = "0px"; spacer.style.height = "0px";
            layer.style.transform = "none"; layer.style.width = "0px"; layer.style.height = "0px";
            root.setAttribute("aria-disabled", "true");
            previous = undefined; anchor = undefined; renderedRevision = null; renderedSelection = null; renderedSelectionSet = null; partialRows = 0; textUnits = 0; readUnits = 0; firstLine = 0; lastLine = 0;
            renderedIndex = emptyIndex; renderedFoldGeneration = -1; renderedAlignmentId = null; comparisonRows = undefined; paddingRows.clear(); foldButtons.clear(); foldLayer.replaceChildren(); return;
        }
        const folds = view.folding.getSnapshot();
        if (comparisonRows && (comparisonRows.revision !== document.revision || comparisonRows.foldGeneration !== folds.generation || !comparisonRows.index.matches(document.buffer, folds.index))) { comparisonRows = undefined; rowGeneration++; }
        const index: RowIndex = comparisonRows?.index ?? folds.index;
        if (comparisonRows) lineHeight = Math.max(naturalLineHeight, comparisonRows.lineHeight);
        if (measuredRevision !== document.revision) { measuredWidth = 0; measuredRevision = document.revision; }
        // A ref replay can paint source-only rows before cooperative alignment is ready.
        // Retain the captured aligned source anchor until its intended grid exists.
        const deferAnchor = anchor?.revision === document.revision && anchor.aligned === true && !comparisonRows;
        if (anchor?.revision === document.revision && !deferAnchor) {
            const line = document.buffer.lineAt(anchor.offset);
            top = index.rowAt(line) * lineHeight + anchor.topRemainder; left = (anchor.offset - document.buffer.offsetAt(line)) * columnWidth + anchor.leftRemainder;
        } else if (previous && previous.revision !== document.revision && document.change === null) { top = 0; left = 0; }
        if (reveal?.revision === document.revision && reveal.foldGeneration === folds.generation) {
            const line = document.buffer.lineAt(reveal.offset);
            top = reveal.vertical === "nearest" ? expose(padding + index.rowAt(line) * lineHeight, lineHeight, top, height) : Math.max(0, index.rowAt(line) * lineHeight - height / 2);
            const estimated = padding + (reveal.offset - document.buffer.offsetAt(line)) * columnWidth;
            left = reveal.horizontal === "nearest" ? expose(estimated, 1, left, width) : Math.max(0, estimated - width / 2);
        }
        const requested = reveal; if (!deferAnchor || requested) anchor = undefined; reveal = undefined;
        x = scrollAxis(Math.max(document.buffer.longestLineLength * columnWidth, measuredWidth) + padding * 2, width);
        // A lone visible row is already at the top. Do not inflate it to rounded clientHeight:
        // fractional fitting viewports would acquire mutually triggering classic scrollbars.
        const trailingSpace = scrollBeyondLastLine && index.visibleLineCount > 1 ? Math.max(0, height - lineHeight - padding * 2) : 0;
        y = scrollAxis(index.visibleLineCount * lineHeight + padding * 2 + trailingSpace, height);
        top = position(y, top); left = position(x, left);
        // Presentation-only configuration can repaint guides without reading or rebuilding rows.
        rulers.paint(columns, columnWidth, left, width);
        const { selection: selected, selectionSet } = view.getSnapshot();
        const key = [document.revision, selectionSet, folds.generation, rowGeneration, comparisonRows?.id,
            top, left, width, height, zoom, columnWidth, naturalLineHeight, lineHeight, font, x.extent, y.extent, paintEpoch, highlightCurrentLine,
            inputOwner?.composing ?? false, inputOwner?.tabEscaped ?? false];
        if (!requested && painted && painted.horizontalAnchor === horizontalAnchor && painted.placement === fragmentPlacement
            && key.every((value, index) => value === painted!.key[index])
            && Math.abs(root.scrollTop - y.toPhysical(top)) <= 1 && Math.abs(root.scrollLeft - x.toPhysical(left)) <= 1) {
            // Consuming scheduled work still releases caret/alignment/linked-scroll listeners.
            // An idle synchronous flush needs neither row work nor a new caret frame.
            if (scheduled) notify("render");
            return;
        }
        const highlightedLine = currentLine(document, selectionSet, index);
        commandGeometry = undefined; readUnits = 0;
        const firstRow = Math.min(index.visibleLineCount - 1, Math.max(0, Math.floor((top - padding) / lineHeight) - overscanLines));
        const lastRow = Math.min(index.visibleLineCount, Math.max(firstRow + 1, Math.ceil((top + height) / lineHeight) + overscanLines));
        firstLine = index.lineAt(firstRow); lastLine = index.lineAt(lastRow - 1) + 1;
        const next: Row[] = [], blanks: number[] = [];
        for (let visible = firstRow; visible < lastRow; visible++) { if (gapAt(index, visible)) blanks.push(visible); else next.push(row(document.buffer, index.lineAt(visible))); }
        retainRows(document, next);
        partialRows = next.filter(row => !row.complete).length;
        // A fitting document must not fill rounded client metrics: a fractional viewport can be
        // slightly smaller, making classic scrollbars repeatedly add/remove each other.
        spacer.style.width = `${Math.min(x.extent, x.physicalExtent)}px`; spacer.style.height = `${Math.min(y.extent, y.physicalExtent)}px`;
        const physicalLeft = x.toPhysical(left), physicalTop = y.toPhysical(top);
        root.scrollLeft = physicalLeft; root.scrollTop = physicalTop;
        layer.style.width = "100%"; layer.style.height = "100%";
        layer.style.transform = `translate(${physicalLeft}px, ${physicalTop}px)`;
        const highlightedTop = highlightedLine === undefined ? undefined : padding + index.rowAt(highlightedLine) * lineHeight - top;
        if (highlightedTop === undefined || highlightedTop + lineHeight <= 0 || highlightedTop >= height) clearCurrentLine();
        else {
            if (!currentLineBackground) { currentLineBackground = owner.createElement("div"); currentLineBackground.className = "st-current-line-background";
                currentLineBackground.setAttribute("aria-hidden", "true"); layer.append(currentLineBackground); }
            currentLineBackground.style.top = `${highlightedTop}px`; currentLineBackground.style.height = `${lineHeight}px`;
        }
        textUnits = 0;
        for (const item of next) {
            let element = rows.get(item.line);
            if (!element) { element = owner.createElement("div"); element.className = "st-viewport-row"; rows.set(item.line, element); layer.append(element); }
            const placement = fragmentPlacement, shift = placement?.revision === document.revision && placement.line === item.line
                && placement.from === item.from && placement.to === item.to && placement.left === left ? placement.shift : 0;
            element.style.transform = `translate(${item.left + shift}px, ${padding + index.rowAt(item.line) * lineHeight - top}px)`;
            element.style.height = `${lineHeight}px`;
            element.style.lineHeight = comparisonRows ? `${lineHeight}px` : "";
            if (paintRow(element, item, document, selectionSet, highlightedLine)) geometries.delete(item.line);
            const fold = index.headerAt(item.line), hidden = fold?.collapsed && item.endsLine ? fold.lineTo - fold.lineFrom - 1 : 0;
            // Generated content stays outside text nodes, native text geometry and clipboard data.
            if (hidden) element.dataset.foldedSummary = `… ${hidden} ${hidden === 1 ? "line" : "lines"} hidden`;
            else delete element.dataset.foldedSummary;
            textUnits += item.text.length;
            rowSources.set(element, item);
        }
        const visibleLines = new Set(next.map(item => item.line));
        for (const [line, element] of rows) if (!visibleLines.has(line)) { element.remove(); rows.delete(line); rowSources.delete(element); geometries.delete(line); }
        next.forEach((item, index) => { const element = rows.get(item.line)!; if (layer.children.item(index) !== element) layer.insertBefore(element, layer.children.item(index)); });
        const visiblePadding = new Set(blanks);
        for (const [at, element] of paddingRows) if (!visiblePadding.has(at)) { element.remove(); paddingRows.delete(at); }
        for (const at of blanks) {
            let element = paddingRows.get(at); if (!element) { element = owner.createElement("div"); element.className = "st-comparison-padding"; element.setAttribute("aria-hidden", "true"); paddingRows.set(at, element); layer.append(element); }
            element.style.transform = `translate(0px, ${padding + at * lineHeight - top}px)`; element.style.height = `${lineHeight}px`; element.style.width = `${width}px`;
        }
        root.removeAttribute("aria-disabled"); root.dataset.revision = String(document.revision);
        renderedRevision = document.revision; rowSourceRevision = document.revision; renderedSelection = selected; renderedSelectionSet = selectionSet; previous = document; renderedIndex = index; renderedFoldGeneration = folds.generation; renderedAlignmentId = comparisonRows?.id ?? null; renders++;
        const visibleFolds = new Set<string>(), orderedButtons: HTMLButtonElement[] = [];
        for (const item of next) {
            const region = index.headerAt(item.line); if (!region) continue; visibleFolds.add(region.id);
            let button = foldButtons.get(region.id);
            if (!button) {
                button = owner.createElement("button"); button.type = "button"; button.className = "st-fold-button";
                foldButtons.set(region.id, button); foldLayer.append(button);
            }
            orderedButtons.push(button);
            button.dataset.fold = region.id; button.dataset.revision = String(document.revision); button.dataset.generation = String(folds.generation);
            const action = region.collapsed ? "Expand" : "Collapse";
            const first = region.lineFrom + 2;
            const body = region.group === "imports" ? "imports" : first === region.lineTo ? `line ${first}` : `lines ${first}–${region.lineTo}`;
            const label = `${action} ${body}`;
            button.setAttribute("aria-label", label); button.title = label; button.setAttribute("aria-expanded", String(!region.collapsed));
            // Replacing even identical text during a pointer press cancels WebKit's native click.
            const arrow = region.collapsed ? "▸" : "▾"; if (button.textContent !== arrow) button.textContent = arrow;
            button.disabled = inputOwner?.composing ?? false;
            button.tabIndex = inputOwner?.tabEscaped ? -1 : 0;
            button.style.left = `${physicalLeft + 1}px`; button.style.top = `${physicalTop + padding + index.rowAt(item.line) * lineHeight - top}px`; button.style.height = `${lineHeight}px`;
        }
        for (const [id, button] of foldButtons) if (!visibleFolds.has(id)) {
            const focused = isFocused(button); button.remove(); foldButtons.delete(id);
            if (focused) notify("focus");
            if (disposed || !workspace.resolveTab(target)) return;
        }
        orderedButtons.forEach((button, index) => { if (foldLayer.children.item(index) !== button) foldLayer.insertBefore(button, foldLayer.children.item(index)); });
        // A bounded batch of native shaping measurements follows the row writes. Extent corrections
        // are scheduled for the next frame, without alternating reads and writes for each row.
        // Full-row backgrounds can have a minimum width unrelated to their source text.
        const extentRange = owner.createRange();
        const measured = Math.max(0, ...[...rows.values()].filter(element => element.dataset.complete === "true").map(element => {
            extentRange.selectNodeContents(element); return extentRange.getBoundingClientRect().width / zoom;
        }));
        if (measured > measuredWidth + .01) { measuredWidth = measured; if (measuredWidth + padding * 2 > x.extent + .01) schedule(); }
        const requestedRow = requested?.revision === document.revision ? rows.get(document.buffer.lineAt(requested.offset)) : undefined;
        if (requestedRow?.dataset.complete === "false") {
            const caret = coordinates(requested!.offset, requested!.affinity), rectangle = clientBox(root);
            if (caret) {
                const actual = (caret.left - rectangle.left) / rectangle.zoom, desired = requested!.horizontal === "center" ? width / 2 : horizontalPosition(actual);
                if (Math.abs(desired - actual) > 1) horizontalAnchor = { revision: document.revision, offset: requested!.offset, affinity: requested!.affinity, left: desired };
            }
        }
        // A partial row has no measured global horizontal origin. Move only its bounded
        // fragment to expose the requested native caret; keep the logical scroll map intact.
        if (horizontalAnchor?.revision === document.revision) {
            const at = horizontalAnchor, line = document.buffer.lineAt(at.offset), item = next.find(item => item.line === line), element = rows.get(line);
            if (item && !item.complete && element && at.offset >= item.from && at.offset <= item.to) {
                const caret = coordinates(at.offset, at.affinity), rectangle = clientBox(root);
                if (caret) {
                    const desired = horizontalPosition(at.left), delta = desired - (caret.left - rectangle.left) / rectangle.zoom;
                    if (Math.abs(delta) > 1) {
                        const prior = fragmentPlacement, shift = (prior?.revision === document.revision && prior.line === line && prior.from === item.from
                            && prior.to === item.to && prior.left === left ? prior.shift : 0) + delta;
                        element.style.transform = `translate(${item.left + shift}px, ${padding + index.rowAt(line) * lineHeight - top}px)`;
                        fragmentPlacement = { revision: document.revision, line, from: item.from, to: item.to, left, shift };
                    }
                }
            }
        } else if (requested?.revision === document.revision && requestedRow?.dataset.complete === "true") {
            const caret = coordinates(requested.offset, requested.affinity), rectangle = clientBox(root);
            if (caret) {
                const actual = (caret.left - rectangle.left) / rectangle.zoom + left;
                const desired = requested.horizontal === "nearest" ? expose(actual, 1, left, width) : Math.max(0, actual - width / 2);
                const maximum = Math.max(0, Math.max(document.buffer.longestLineLength * columnWidth, measuredWidth) + padding * 2 - width);
                if (Math.abs(Math.min(maximum, desired) - left) > 1) { left = Math.min(maximum, desired); schedule(); }
            }
        }
        lastRenderMs = win.performance.now() - started;
        // Keep the scroll/extent values actually painted; reveal corrections may queue a newer one.
        painted = { key, horizontalAnchor, placement: fragmentPlacement };
        notify("render");
    }
    const foldButton = (target: EventTarget | null): HTMLButtonElement | undefined => {
        const button = (target as Element | null)?.closest?.("button.st-fold-button") as HTMLButtonElement | null | undefined;
        return button && foldLayer.contains(button) ? button : undefined;
    };
    foldLayer.addEventListener("pointerdown", event => { if (foldButton(event.target)) event.stopPropagation(); }, { signal: listeners.signal });
    foldLayer.addEventListener("click", event => {
        const button = foldButton(event.target); if (!button) return; event.stopPropagation();
        if (disposed || !workspace.resolveTab(target) || inputOwner?.composing) return;
        view.folding.setCollapsed({ revision: Number(button.dataset.revision), generation: Number(button.dataset.generation) }, button.dataset.fold!, button.getAttribute("aria-expanded") === "true");
    }, { signal: listeners.signal });
    foldLayer.addEventListener("keydown", event => { if (event.key === "Escape" && foldButton(event.target)) {
        event.preventDefault(); if (!disposed && workspace.resolveTab(target)) notify("focus");
    } }, { signal: listeners.signal });
    root.addEventListener("scroll", () => {
        const newTop = y.toLogical(root.scrollTop), newLeft = x.toLogical(root.scrollLeft);
        // Ignore quantization from writes to native fractional/scaled scroll offsets.
        if (Math.abs(root.scrollTop - y.toPhysical(top)) > 1 || Math.abs(root.scrollLeft - x.toPhysical(left)) > 1) { top = newTop; left = newLeft; anchor = undefined; horizontalAnchor = undefined; fragmentPlacement = undefined; schedule(); }
    }, { signal: listeners.signal });
    root.addEventListener("wheel", event => {
        if (event.defaultPrevented || event.ctrlKey || event.metaKey) return;
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
    owner.fonts.addEventListener("loadingdone", invalidate, { signal: listeners.signal });
    owner.fonts.addEventListener("loadingerror", invalidate, { signal: listeners.signal });
    const subscriptions = [workspace.observeDocument(documentId).subscribe(documentChanged), view.subscribe(schedule), view.folding.subscribe(foldsChanged), resource.metadata.subscribe(schedule), workspace.tabState.subscribe(schedule)];
    let activitySnapshot: ViewportActivity | undefined;
    function activity(): ViewportActivity {
        const pending = frame !== undefined;
        if (activitySnapshot && activitySnapshot.revision === renderedRevision && activitySnapshot.selectionSet === renderedSelectionSet
            && activitySnapshot.foldGeneration === renderedFoldGeneration && activitySnapshot.alignmentId === renderedAlignmentId
            && activitySnapshot.rowGeneration === rowGeneration && activitySnapshot.pending === pending && activitySnapshot.disposed === disposed) return activitySnapshot;
        return activitySnapshot = Object.freeze({ revision: renderedRevision, selectionSet: renderedSelectionSet, foldGeneration: renderedFoldGeneration,
            aligned: renderedAlignmentId !== null, alignmentId: renderedAlignmentId, rowGeneration, pending, disposed });
    }
    schedule();
    const viewport: TextViewport = Object.freeze({
        element: root,
        view,
        activity,
        onRender: listener => observe("render", listener),
        bindInput: focus => {
            if (disposed || !workspace.resolveTab(target) || inputOwner) throw new Error("Viewport requires one current input owner.");
            const binding = { composing: false, tabEscaped: false, detach: observe("focus", focus) };
            inputOwner = binding; root.tabIndex = -1; layer.setAttribute("aria-hidden", "true");
            const update = (key: "composing" | "tabEscaped", value: boolean): boolean => {
                if (typeof value !== "boolean") throw new TypeError("Input interaction state must be boolean.");
                if (disposed || inputOwner !== binding || !workspace.resolveTab(target) || binding[key] === value) return false;
                binding[key] = value;
                if (key === "composing") { root.classList.toggle("st-composing", value); invalidate(); }
                for (const button of foldButtons.values()) { button.disabled = binding.composing; button.tabIndex = binding.tabEscaped ? -1 : 0; }
                return true;
            };
            return Object.freeze({ setComposing: (active: boolean) => update("composing", active), setTabEscape: (active: boolean) => update("tabEscaped", active),
                dispose: () => {
                    if (inputOwner !== binding) return; binding.detach(); inputOwner = undefined;
                    root.classList.remove("st-composing"); root.tabIndex = 0; layer.removeAttribute("aria-hidden");
                    for (const button of foldButtons.values()) { button.disabled = false; button.tabIndex = 0; }
                    if (!disposed) invalidate();
                } });
        },
        columnRulers: () => columns,
        configureColumnRulers: value => {
            notifications.assertWritable(); if (disposed) return false;
            const next = resolveColumnRulers(value);
            if (next.length === columns.length && next.every((column, index) => column === columns[index])) return true;
            columns = next; schedule(); return true;
        },
        currentLineHighlight: () => highlightCurrentLine,
        configureCurrentLineHighlight: enabled => {
            notifications.assertWritable(); if (disposed) return false;
            if (typeof enabled !== "boolean") throw new TypeError("Current-line highlighting must be boolean.");
            if (highlightCurrentLine === enabled) return true;
            highlightCurrentLine = enabled; clearPreparedRows(); commandGeometry = undefined; schedule(); return true;
        },
        fontLigatures: () => fontLigatures,
        configureFontLigatures: enabled => {
            notifications.assertWritable(); if (disposed) return false;
            if (typeof enabled !== "boolean") throw new TypeError("Font ligatures must be boolean.");
            if (fontLigatures === enabled) return true;
            fontLigatures = enabled; root.style.fontVariantLigatures = enabled ? "normal" : "none"; invalidate(); return true;
        },
        scrollBeyondLastLine: () => scrollBeyondLastLine,
        configureScrollBeyondLastLine: enabled => {
            notifications.assertWritable(); if (disposed) return false;
            if (typeof enabled !== "boolean") throw new TypeError("Scrolling beyond the last line must be boolean.");
            if (scrollBeyondLastLine === enabled) return true;
            scrollBeyondLastLine = enabled; schedule(); return true;
        },
        invalidate,
        coordsAt: coordinates,
        rowBounds: (line: number) => {
            const current = workspace.observeDocument(documentId).getSnapshot(), folding = view.folding.getSnapshot();
            if (disposed || frame !== undefined || !workspace.resolveTab(target) || current?.revision !== renderedRevision || folding.generation !== renderedFoldGeneration
                || !Number.isSafeInteger(line) || line < 0 || line >= current.buffer.lineCount || renderedIndex.hiddenBy(line)) return undefined;
            const row = rows.get(line); if (!row) return undefined; const rectangle = row.getBoundingClientRect();
            return Object.freeze({ revision: current.revision, foldGeneration: folding.generation, line, top: rectangle.top, height: rectangle.height });
        },
        hitTest: (clientX: number, clientY: number) => {
            if (!Number.isFinite(clientX) || !Number.isFinite(clientY) || disposed || !workspace.resolveTab(target)
                || workspace.observeDocument(documentId).getSnapshot()?.revision !== renderedRevision) return undefined;
            const rectangle = clientBox(root), at = Math.max(0, Math.min(renderedIndex.visibleLineCount - 1, Math.floor(((clientY - rectangle.top) / rectangle.zoom + top - padding) / lineHeight))), gap = gapAt(renderedIndex, at);
            if (gap) return Object.freeze({ offset: gap.offset, affinity: "after", left: rectangle.left + (padding - left) * rectangle.zoom, top: rectangle.top + (padding + at * lineHeight - top) * rectangle.zoom, height: lineHeight * rectangle.zoom, revision: renderedRevision!, padding: true });
            let element: HTMLDivElement | undefined, distance = Infinity;
            for (const candidate of rows.values()) {
                const rectangle = candidate.getBoundingClientRect(), next = Math.max(rectangle.top - clientY, clientY - rectangle.bottom, 0);
                if (next < distance) { element = candidate; distance = next; }
            }
            return element ? geometry(element).nearest(clientX) : undefined;
        },
        flush,
        scrollTo: setScroll,
        captureView: () => { const { selection, selectionSet } = view.getSnapshot();
            // Ref replay may recapture an intermediate unaligned paint. Always retain source
            // coordinates, and prefer an anchor that has not yet reached its first paint.
            const folds = view.folding.getSnapshot(), vertical = anchor && anchor.revision === workspace.observeDocument(documentId).getSnapshot()?.revision
                ? { revision: anchor.revision, offset: anchor.offset, topRemainder: anchor.topRemainder, ...(anchor.aligned || renderedAlignmentId !== null ? { aligned: true as const } : {}) }
                : verticalAnchor();
            return Object.freeze({ ...selection, selectionSet, scrollTop: top, scrollLeft: left,
                ...(vertical ? { verticalAnchor: Object.freeze(vertical) } : {}),
                folding: Object.freeze({ documentId, viewId: view.id, revision: folds.revision, generation: folds.generation, regions: folds.regions }),
                ...(horizontalAnchor ? { horizontalAnchor: Object.freeze({ ...horizontalAnchor }) } : {}) }); },
        restoreView: (state: ViewState) => {
            if (disposed || !workspace.resolveTab(target)) return; const document = workspace.document(documentId), value = state.horizontalAnchor, vertical = state.verticalAnchor;
            validateScroll({ top: state.scrollTop, left: state.scrollLeft });
            if (value && (!Number.isSafeInteger(value.revision) || value.revision < 0 || !Number.isSafeInteger(value.offset) || value.offset < 0
                || !Number.isFinite(value.left) || value.left < 0 || value.affinity !== "before" && value.affinity !== "after")) throw new RangeError("Invalid horizontal view anchor.");
            if (value?.revision === document.revision && value.offset > document.buffer.length) throw new RangeError("Horizontal view anchor is outside the document.");
            if (vertical && (!Number.isSafeInteger(vertical.revision) || vertical.revision < 0 || !Number.isSafeInteger(vertical.offset) || vertical.offset < 0 || !Number.isFinite(vertical.topRemainder) || vertical.aligned !== undefined && vertical.aligned !== true)) throw new RangeError("Invalid vertical view anchor.");
            if (vertical?.revision === document.revision && vertical.offset > document.buffer.length) throw new RangeError("Vertical view anchor is outside the document.");
            const folds = view.folding.getSnapshot(), saved = state.folding;
            const restoreFolds = saved && saved.documentId === documentId && saved.revision === document.revision && saved.viewId !== view.id && folds.generation === 0 && !folds.regions.length;
            if (restoreFolds) createFoldRegions(document.buffer, saved.regions);
            if (state.selectionSet) { if (!sameSelectionSet(state.selectionSet, view.getSnapshot().selectionSet)) view.setSelections(document.revision, state.selectionSet.ranges, state.selectionSet.primary); }
            else if (state.anchor !== view.getSnapshot().selection.anchor || state.head !== view.getSnapshot().selection.head
                || state.anchorAffinity !== view.getSnapshot().selection.anchorAffinity || state.headAffinity !== view.getSnapshot().selection.headAffinity) view.setSelection(document.revision, state);
            if (restoreFolds) view.folding.setRanges(folds, saved.regions);
            setScroll({ top: state.scrollTop, left: state.scrollLeft });
            if (value?.revision === document.revision) horizontalAnchor = { ...value };
            if (vertical?.revision === document.revision) anchor = { ...vertical, leftRemainder: left - (vertical.offset - document.buffer.offsetAt(document.buffer.lineAt(vertical.offset))) * columnWidth };
        },
        revealOffset: (offset: number, options: RevealOptions = {}) => {
            if (disposed || !workspace.resolveTab(target)) return; const document = workspace.document(documentId); document.buffer.lineAt(offset);
            const horizontal = options.horizontal ?? "center", vertical = options.vertical ?? "center", affinity = options.affinity ?? "after";
            if (![horizontal, vertical].every(value => value === "center" || value === "nearest") || affinity !== "after" && affinity !== "before") throw new RangeError("Invalid reveal options.");
            view.folding.reveal(view.folding.getSnapshot(), offset);
            anchor = undefined; horizontalAnchor = undefined; fragmentPlacement = undefined;
            reveal = { revision: document.revision, foldGeneration: view.folding.getSnapshot().generation, offset, horizontal, vertical, affinity }; schedule();
        },
        snapshot: () => Object.freeze({ ...activity(), selection: renderedSelection, renders, firstLine, lastLine, rows: rows.size, partialRows, textUnits, readUnits, visibleLines: previous ? view.folding.getSnapshot().index.visibleLineCount : 0, collapsedFolds: previous ? renderedIndex.collapsedCount : 0, visualRows: previous ? renderedIndex.visibleLineCount : 0, paddingRows: paddingRows.size, naturalLineHeight, navigationReadUnits, navigationRows, navigationBatches, navigationPreparedRows: preparedRows?.rows.size ?? 0, maxNavigationBatchRows, lastRenderMs,
            scrollTop: top, scrollLeft: left, width, height, lineHeight, columnWidth, verticalExtent: y.extent, horizontalExtent: x.extent,
            physicalHeight: y.physicalExtent, physicalWidth: x.physicalExtent }),
        dispose: () => {
            if (disposed) return; disposed = true; activitySnapshot = undefined; if (frame !== undefined) win.cancelAnimationFrame(frame); frame = undefined;
            inputOwner?.detach(); inputOwner = undefined;
            for (const stop of observationStops) stop();
            rulers.clear(); columns = resolveColumnRulers();
            clearCurrentLine(); highlightCurrentLine = false;
            fontLigatures = false;
            scrollBeyondLastLine = false;
            observer.disconnect(); listeners.abort(); subscriptions.forEach(unsubscribe => unsubscribe()); rows.clear(); rowSources.clear(); rowSourceRevision = null; paddingRows.clear(); comparisonRows = undefined; renderedAlignmentId = null; geometries.clear(); previous = undefined; anchor = undefined; reveal = undefined; horizontalAnchor = undefined; fragmentPlacement = undefined;
            painted = undefined; commandGeometry = undefined; commandRow.replaceChildren(); commandMeasure.remove(); clearPreparedRows();
            navigationBatches = 0; maxNavigationBatchRows = 0;
            renderedIndex = emptyIndex; renderedFoldGeneration = -1; foldButtons.clear(); foldLayer.replaceChildren();
            renderedRevision = null; renderedSelection = null; renderedSelectionSet = null; partialRows = 0; textUnits = 0; readUnits = 0; navigationReadUnits = 0; navigationRows = 0; layer.replaceChildren(); root.replaceChildren(); root.remove();
            if (!options.view) view.dispose();
        }
    });
    const navigation: ViewportNavigation = Object.freeze({
        prepareNavigationRows,
        moveVisual: (offset: number, affinity: Affinity, direction: -1 | 1) => rowForOffset(offset, measured => {
            const before = measured.point(offset, "before"), after = measured.point(offset, "after"); if (!before || !after) return;
            if (before.offset !== offset && after.offset !== offset) return direction * before.left > direction * after.left ? before : after;
            const next = measured.visual(offset, affinity, direction); if (next) return next;
            const buffer = workspace.document(documentId).buffer, source = view.folding.getSnapshot().index, at = source.rowAt(buffer.lineAt(offset)) + direction * measured.flow;
            if (at < 0 || at >= source.visibleLineCount) return measured.edge(direction);
            const line = source.lineAt(at);
            return rowForOffset(buffer.offsetAt(line), neighbor => neighbor.edge(direction < 0 ? 1 : -1));
        }),
        collapseVisual: (from: number, to: number, direction: -1 | 1) => rowForOffset(from, first => direction * first.flow < 0
            ? first.edge(direction, from, to) : rowForOffset(to, last => last.edge(direction, from, to))),
        columnAt: (offset: number, affinity: Affinity = "after") => {
            if (disposed || !workspace.resolveTab(target)) return;
            const document = workspace.observeDocument(documentId).getSnapshot();
            if (document?.revision !== renderedRevision || view.folding.getSnapshot().generation !== renderedFoldGeneration) return;
            const visible = coordinates(offset, affinity), rectangle = clientBox(root);
            if (visible) return (visible.left - rectangle.left) / rectangle.zoom + left;
            const originalLine = document.buffer.lineAt(offset), hidden = renderedIndex.hiddenBy(originalLine), line = hidden?.lineFrom ?? originalLine;
            const projected = hidden ? row(document.buffer, line).to : offset, scroll = Math.max(0, padding + (projected - document.buffer.offsetAt(line)) * columnWidth - width / 2);
            return withRow(line, scroll, projected, false, measured => { const point = measured.point(projected, affinity); return point && (point.left - rectangle.left) / rectangle.zoom + left; });
        },
        caretAtColumn: (line: number, column: number) => {
            if (disposed || !workspace.resolveTab(target)) return;
            const document = workspace.observeDocument(documentId).getSnapshot();
            if (document?.revision !== renderedRevision || view.folding.getSnapshot().generation !== renderedFoldGeneration) return;
            if (!Number.isSafeInteger(line) || line < 0 || line >= document.buffer.lineCount || !Number.isFinite(column)) throw new RangeError("Invalid navigation column.");
            if (renderedIndex.hiddenBy(line)) return;
            const scroll = column < left || column > left + width ? Math.max(0, column - width / 2) : left;
            return withRow(line, scroll, undefined, false, measured => { const point = measured.nearest(column);
                return Object.freeze({ offset: point.offset, affinity: point.affinity, revision: point.revision }); });
        },
        visualRowAt: line => renderedIndex.rowAt(line),
        navigationLine: (line, direction, count, page) => {
            if (!Number.isSafeInteger(count) || count < 1 || direction !== -1 && direction !== 1) throw new RangeError("Invalid row navigation.");
            const index = page ? renderedIndex : view.folding.getSnapshot().index, at = Math.max(0, Math.min(index.visibleLineCount - 1, index.rowAt(line) + direction * count));
            return "nextLine" in index ? index.nextLine(at, direction) : index.lineAt(at);
        }
    });
    return Object.freeze({ viewport, navigation, setComparisonRows });
}
