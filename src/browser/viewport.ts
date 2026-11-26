import { listenUntil } from "./listen.ts";
import { editorElement } from "./editor-element.ts";
import { isIndex, isNonNegativeInteger, isOffset, isPositiveInteger } from "../core/bounds.ts";
import { clientBox, cssZoom, minimapWidth } from "./dom-coordinates.ts";
import { isFocused } from "./dom-focus.ts";
import { Store, type Observable } from "../core/observable.ts";
import { lineContentEnd } from "../core/newlines.ts";
import { localAsciiGraphemePoint } from "../core/grapheme-point.ts";
import { graphemeBoundaries } from "../core/graphemes.ts";
import type { DocumentId, DocumentSnapshot, DocumentView, Workspace } from "../core/workspace.ts";
import type { Selection } from "../core/history.ts";
import type { SelectionSet } from "../core/selections.ts";
import type { TextBuffer } from "../core/text-buffer.ts";
import { mapViewAnchor, selectionToRestore } from "./view-state.ts";
import type { ViewRestoreOptions, ViewRestoreResult, ViewState } from "./view-state.ts";
import { scrollAxis } from "./scroll.ts";
import type { ScrollAxis } from "./scroll.ts";
import { rowGeometry } from "./text-geometry.ts";
import type { CaretRectangle } from "./text-geometry.ts";
import type { Affinity } from "../core/positions.ts";
import { unchangedPositionEdges } from "../core/positions.ts";
import { createFoldRegions, FoldIndex } from "../core/folding.ts";
import type { FoldingSnapshot, FoldRegion, FoldVersion } from "../core/folding.ts";
import { sameSelectionSet } from "../core/selections.ts";
import { partitionPoint } from "../core/bound-search.ts";
import { applyDecorationProperties, decorationParts } from "./decoration-parts.ts";
import type { RowPart } from "./decoration-parts.ts";
import { createDecorationLayers } from "./decoration-layers.ts";
import type { DecorationLayers } from "./decoration-layers.ts";
import type { ComparisonRowIndex } from "../core/comparison-rows.ts";
import { mountColumnRulers, resolveColumnRulers } from "./column-rulers.ts";
import { mountMinimap } from "./minimap.ts";
type RowIndex = FoldIndex | ComparisonRowIndex;
const emptyIndex = new FoldIndex(1);
const overscanLines = 4, overscanUnits = 32;
/** Shared by view-only scroll coordination; this is independent of source coordinates. */
export const viewportPadding = 12;
export type ViewportComparisonRows = Readonly<{ documentId: DocumentId; revision: number; foldGeneration: number; id: number; lineHeight: number; index: ComparisonRowIndex }>;
export type RenderedRowBounds = Readonly<{ revision: number; foldGeneration: number; line: number; top: number; height: number }>;

export type ViewportActivity = Readonly<{ revision: number | null; selectionSet: SelectionSet | null; foldGeneration: number;
    aligned: boolean; alignmentId: number | null; rowGeneration: number; pending: boolean; disposed: boolean }>;
export type ViewportSnapshot = Readonly<{ lineFrom: number; lineTo: number; scrollTop: number; scrollLeft: number;
    width: number; height: number; gutterWidth: number; lineHeight: number; naturalLineHeight: number; columnWidth: number;
    verticalExtent: number; horizontalExtent: number }>;
const emptyViewport: ViewportSnapshot = Object.freeze({ lineFrom: 0, lineTo: 0, scrollTop: 0, scrollLeft: 0,
    width: 0, height: 0, gutterWidth: 0, lineHeight: 0, naturalLineHeight: 0, columnWidth: 0, verticalExtent: 0, horizontalExtent: 0 });
const geometryKeys = Object.keys(emptyViewport) as (keyof ViewportSnapshot)[];
export type ViewportDiagnostics = ViewportActivity & Readonly<{ selection: Selection | null; renders: number; firstLine: number; lastLine: number;
    visibleLines: number; collapsedFolds: number; visualRows: number; paddingRows: number; naturalLineHeight: number;
    rows: number; partialRows: number; textUnits: number; readUnits: number; lastRenderMs: number;
    scrollTop: number; scrollLeft: number; width: number; height: number; gutterWidth: number;
    lineHeight: number; columnWidth: number; verticalExtent: number; horizontalExtent: number;
    physicalHeight: number; physicalWidth: number }>;
export type ViewportInputBinding = Readonly<{ setComposing: (active: boolean) => boolean;
    dispose: () => void }>;

type ViewportNavigation = Readonly<{
    visualRowAt: (line: number) => number;
    columnDragLine: (localY: number, originLine: number) => number;
    navigationLine: (line: number, direction: -1 | 1, count: number, page: boolean) => number;
    horizontalPoint: (buffer: TextBuffer, range: Selection, direction: -1 | 1, extend: boolean) =>
        Pick<CaretRectangle, "offset" | "affinity"> | undefined;
    columnAt: (offset: number, affinity?: Affinity) => number | undefined;
    caretAtColumn: (line: number, column: number) => Readonly<Pick<CaretRectangle, "offset" | "affinity" | "revision">> | undefined;
    columnSelections: (anchor: number, head: number) => (line: number) => (Selection & { reaches: boolean }) | undefined;
    fixedPitch: () => boolean;
}>;
export type TextViewport = Observable<ViewportSnapshot> & Readonly<{ element: HTMLDivElement; view: DocumentView; decorations: DecorationLayers;
    /** Observe completed paints and consumed scheduled renders, including unchanged paints. */
    onRender: (listener: () => void) => () => void;
    /** One input owner controls composition and source-focus recovery. */
    bindInput: (focus: () => void) => ViewportInputBinding;
    settings: () => ViewportSettings;
    configure: (changes: Partial<ViewportSettings>) => boolean;
    captureView: () => ViewState; restoreView: (state: ViewState, options?: ViewRestoreOptions) => ViewRestoreResult | null;
    scrollTo: (position: Readonly<{ top?: number; left?: number }>) => void;
    coordsAt: (offset: number, affinity?: Affinity) => CaretRectangle | undefined;
    rowBounds: (line: number) => RenderedRowBounds | undefined;
    hitTest: (clientX: number, clientY: number) => CaretRectangle | undefined;
    flush: () => void;
    invalidate: () => void;
    /** Immutable painted identities and scheduled-work state; reused while unchanged. Does not flush or measure layout. */
    activity: () => ViewportActivity;
    revealOffset: (offset: number, options?: RevealOptions) => void;
    revealRange: (from: number, to: number, align?: RevealAlignment) => void;
    getDiagnostics: () => ViewportDiagnostics; dispose: () => void }>;
type Row = Readonly<{ line: number; start: number; end: number; breakEnd: number; from: number; to: number; text: string; left: number; complete: boolean; endsLine: boolean }>;
/** CRLF has two raw positions at one painted line edge. Keep the requested model offset. */
function rowCaretOffset(buffer: TextBuffer, end: number, offset: number): number | undefined {
    if (offset <= end) return offset;
    return offset === end + 1 && offset < buffer.length && buffer.slice(end, end + 2) === "\r\n" ? end : undefined;
}
type RowChild = RowPart | { tokens: readonly RowPart[] };
function selectedTokenRuns(parts: readonly RowPart[]): RowChild[] {
    const children: RowChild[] = [];
    const selected = (part: RowPart) => part.className === "st-viewport-selected" || part.className.endsWith(" st-viewport-selected");
    for (let i = 0; i < parts.length;) {
        const part = parts[i]!, start = i++;
        if (selected(part)) {
            for (let j = i; j < parts.length; j++) {
                const next = parts[j]!;
                if (selected(next)) i = j + 1;
                else if (!next.ornament) break;
            }
        }
        children.push(i === start + 1 ? part : { tokens: parts.slice(start, i) });
    }
    return children;
}
function matchesRowChildren(element: HTMLElement, parts: readonly RowChild[]): boolean {
    return element.childNodes.length === parts.length && parts.every((part, index) => {
        const node = element.childNodes.item(index);
        if ("tokens" in part) {
            const run = node as HTMLSpanElement;
            return node?.nodeName === "SPAN" && run.className === "st-selection-run" && matchesRowChildren(run, part.tokens);
        }
        if (!node || node.textContent !== part.text) return false;
        if (!part.className) return node.nodeType === Node.TEXT_NODE;
        const span = node as HTMLSpanElement;
        if (node.nodeName !== "SPAN" || span.className !== part.className || span.dataset.ornament !== part.ornament || span.dataset.label !== part.label) return false;
        if (part.properties || span.style.length) {
            const valid = Object.entries(part.properties ?? {}).filter(([name, value]) => /^--[\w-]+$/.test(name) && typeof value === "string" && value.length);
            if (valid.length !== span.style.length || valid.some(([name, value]) => span.style.getPropertyValue(name) !== value)) return false;
        }
        return part.ornament ? !span.childNodes.length : span.childNodes.length === 1 && span.firstChild?.nodeType === Node.TEXT_NODE;
    });
}
function rowNode(owner: Document, part: RowChild): Node {
    if ("tokens" in part) {
        const span = owner.createElement("span"); span.className = "st-selection-run";
        span.append(...part.tokens.map(token => rowNode(owner, token))); return span;
    }
    if (!part.className) return owner.createTextNode(part.text);
    const span = owner.createElement("span"); span.className = part.className; span.textContent = part.text;
    if (part.properties) applyDecorationProperties(span, part.properties);
    if (part.ornament) { span.dataset.ornament = part.ornament; span.setAttribute("aria-hidden", "true"); }
    if (part.label !== undefined) span.dataset.label = part.label;
    return span;
}
function renderRowChildren(element: HTMLElement, parts: readonly RowChild[]): boolean {
    if (matchesRowChildren(element, parts)) return false;
    element.replaceChildren(...parts.map(part => rowNode(element.ownerDocument, part)));
    return true;
}
export type InlineDecoration = Readonly<{ from: number; to: number; className: string;
    properties?: Readonly<Record<`--${string}`, string>>; before?: string; afterLine?: string }>;
export type PresentedLine = Readonly<{ documentId: DocumentId; revision: number; line: number; lineStart: number; from: number; to: number; text: string }>;
export type LineDecorator = (line: PresentedLine) => readonly InlineDecoration[];
export type LineClass = (line: PresentedLine) => string | undefined;
export type RevealAlignment = "start" | "center" | "nearest" | "center-if-outside";
export function validateRevealAlignment(align: RevealAlignment): void {
    if (align !== "start" && align !== "center" && align !== "nearest" && align !== "center-if-outside") throw new RangeError("Invalid reveal alignment.");
}
export type RevealOptions = Readonly<{ horizontal?: "center" | "nearest"; vertical?: "center" | "nearest" | "center-if-outside"; affinity?: Affinity }>;
export type FoldLabels = Readonly<{
    action?: (region: FoldRegion) => string | undefined;
    summary?: (region: FoldRegion, containsChanges: boolean) => string | undefined;
}>;
export type ViewportSettings = Readonly<{ columnRulers: readonly number[]; highlightCurrentLine: boolean; gutter: boolean;
    fontLigatures: boolean; scrollBeyondLastLine: boolean; minimap: boolean; minimapLabel: (line: number | null) => string; foldLabels: FoldLabels }>;
export type TextViewportOptions = Readonly<{ ariaLabel?: string; view?: DocumentView; settings?: Partial<ViewportSettings> }>;
export type ComparisonPresentation = Readonly<{
    foldContainsChange: (buffer: TextBuffer, firstHiddenLine: number, lineTo: number) => boolean;
    gutterLineCount: () => number;
}>;

const defaultSettings: ViewportSettings = Object.freeze({ columnRulers: resolveColumnRulers(), highlightCurrentLine: false,
    fontLigatures: false, scrollBeyondLastLine: false, minimap: false, gutter: true,
    minimapLabel: line => line === null ? "Alignment gap" : "Line " + line.toLocaleString(), foldLabels: Object.freeze({}) });
const settingKeys = Object.keys(defaultSettings) as (keyof ViewportSettings)[];
function viewportSettings(previous: ViewportSettings, changes?: Partial<ViewportSettings>): ViewportSettings {
    if (!changes) return previous;
    const next = { ...previous };
    for (const key of settingKeys) {
        if (key === "columnRulers" || key === "foldLabels") continue;
        const value = changes[key];
        if (value === undefined) continue;
        if (key === "minimapLabel") {
            if (typeof value !== "function") throw new TypeError("Invalid minimap label.");
            next.minimapLabel = value;
            continue;
        }
        if (typeof value !== "boolean") throw new TypeError(`${key} must be a boolean.`);
        next[key] = value;
    }
    if (changes.columnRulers !== undefined && changes.columnRulers !== previous.columnRulers) {
        const columns = resolveColumnRulers(changes.columnRulers);
        if (columns.length !== previous.columnRulers.length || columns.some((value, i) => value !== previous.columnRulers[i])) {
            next.columnRulers = columns;
        }
    }
    const labels = changes.foldLabels;
    if (labels !== undefined && labels !== previous.foldLabels) {
        if (!labels || typeof labels !== "object" || Array.isArray(labels)
            || [labels.action, labels.summary].some(value => value !== undefined && typeof value !== "function")) {
            throw new TypeError("Invalid fold labels.");
        }
        if (labels.action !== previous.foldLabels.action || labels.summary !== previous.foldLabels.summary) {
            next.foldLabels = Object.freeze({ ...labels });
        }
    }
    return settingKeys.every(key => next[key] === previous[key]) ? previous : Object.freeze(next);
}

/** Bounded DOM view layer with local native text geometry. Native-device qualification remains separate. */
export function mountTextViewport(host: HTMLElement, workspace: Workspace, documentId: DocumentId,
    options: TextViewportOptions = {}): TextViewport {
    return mountViewport(host, workspace, documentId, options).viewport;
}

/** Internal mount: navigation and comparison publication share the viewport lifetime. */
export type MountedViewport = Readonly<{
    viewport: TextViewport; navigation: ViewportNavigation; setComparisonRows: (rows: ViewportComparisonRows | undefined) => boolean;
}>;

export function mountViewport(host: HTMLElement, workspace: Workspace, documentId: DocumentId,
    options: TextViewportOptions = {}, comparison?: ComparisonPresentation): MountedViewport {
    let settings = viewportSettings(defaultSettings, options.settings);
    const resource = workspace.resourceForDocument(documentId);
    if (options.view && (options.view.documentId !== documentId || !workspace.ownsDocumentView(options.view))) throw new Error("View belongs to a different document or workspace.");
    const view = options.view ?? workspace.createDocumentView(documentId), owner = host.ownerDocument, browserWindow = owner.defaultView;
    if (!browserWindow) { if (!options.view) view.dispose(); throw new Error("Viewport requires an attached browser document."); }
    const win = browserWindow;
    const source = workspace.observeDocument(documentId);
    const currentDocument = source.getSnapshot;
    const viewState = view.getSnapshot;
    const currentFolds = view.folding.getSnapshot;
    const live = () => workspace.ownsDocumentView(view);
    const root = editorElement(owner, "div", "viewport");
    const surface = editorElement(owner, "div", "viewport-surface");
    const spacer = editorElement(owner, "div", "viewport-spacer");
    const layer = editorElement(owner, "div", "viewport-layer");
    const probeHost = editorElement(owner, "div", "viewport-measure-host");
    const probe = editorElement(owner, "span", "viewport-measure");
    const gutter = editorElement(owner, "div", "viewport-gutter");
    const numbers = editorElement(owner, "div", "line-numbers");
    const foldLayer = editorElement(owner, "div", "fold-controls");
    const lineNumbers = new Map<number, HTMLSpanElement>();
    const foldButtons = new Map<string, HTMLButtonElement>();
    root.tabIndex = 0;
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", options.ariaLabel ?? workspace.document(documentId).title);
    root.style.fontVariantLigatures = settings.fontLigatures ? "normal" : "none";
    for (const element of [spacer, probe, probeHost, numbers]) element.setAttribute("aria-hidden", "true");
    probe.textContent = "M".repeat(64);
    const narrowProbe = probe.cloneNode() as HTMLSpanElement;
    narrowProbe.textContent = "i".repeat(64);
    probeHost.append(probe, narrowProbe);
    gutter.append(numbers, foldLayer);
    surface.append(layer, gutter);
    root.append(surface, spacer, probeHost);
    host.append(root);
    const listeners = new AbortController(), padding = viewportPadding;
    const listen = listenUntil(listeners.signal);
    // A private platform target preserves listener removal, reentrancy and error reporting
    // without routing editor coordination through the presentation DOM or model write guard.
    const events = new win.EventTarget(), observationStops = new Set<() => void>();
    let inputOwner: { composing: boolean; detach: () => void } | undefined;
    const observe = (type: "render" | "focus", listener: () => void): (() => void) => {
        if (disposed || !live()) return () => {};
        const invoke = () => { if (!disposed && live()) listener(); };
        const stop = () => { events.removeEventListener(type, invoke); observationStops.delete(stop); };
        events.addEventListener(type, invoke); observationStops.add(stop);
        return stop;
    };
    const notify = (type: "render" | "focus") => events.dispatchEvent(new win.Event(type));
    const rulers = mountColumnRulers(layer, padding), notifications = workspace.createNotificationScope();
    const geometryState = new Store(emptyViewport, notifications);
    function publishGeometry(next: ViewportSnapshot): void {
        const prior = geometryState.get();
        if (geometryKeys.some(key => prior[key] !== next[key])) notifications.publish(geometryState, Object.freeze(next));
    }
    let currentLineBackground: HTMLDivElement | undefined;
    const clearCurrentLine = () => { currentLineBackground?.remove(); currentLineBackground = undefined; };
    const currentLine = (document: DocumentSnapshot, selections: SelectionSet, index: RowIndex): number | undefined => {
        if (!settings.highlightCurrentLine) return;
        const primary = selections.ranges[selections.primary]!; if (primary.anchor !== primary.head) return;
        const line = document.buffer.lineAt(primary.head); return index.hiddenBy(line)?.lineFrom ?? line;
    };
    let frame: number | undefined, disposed = false, previous: DocumentSnapshot | undefined;
    let scrollbarPressed = false, revealSettling: number | undefined;
    function releaseScrollbar(): void {
        scrollbarPressed = false;
        if (revealSettling !== undefined) win.cancelAnimationFrame(revealSettling);
        revealSettling = undefined;
    }
    function correctScrollbarReveal(): boolean {
        const targetTop = y.toPhysical(top), targetLeft = x.toPhysical(left);
        if (Math.abs(root.scrollTop - targetTop) <= 1 && Math.abs(root.scrollLeft - targetLeft) <= 1) return false;
        root.scrollTo({ top: targetTop, left: targetLeft, behavior: "instant" });
        return true;
    }
    function settleScrollbarReveal(): void {
        if (revealSettling !== undefined) win.cancelAnimationFrame(revealSettling);
        // A native track animation can move the viewport before its scroll event arrives.
        let alignedLastFrame = false;
        const check = () => {
            const aligned = !correctScrollbarReveal();
            if (aligned && alignedLastFrame) { releaseScrollbar(); return; }
            alignedLastFrame = aligned;
            revealSettling = win.requestAnimationFrame(check);
        };
        revealSettling = win.requestAnimationFrame(check);
    }
    let top = 0, left = 0, width = 0, height = 0, gutterWidth = 0, lineHeight = 22.4, columnWidth = 8.4;
    let x = scrollAxis(0, 0), y = scrollAxis(0, 0), renderedRevision: number | null = null, renderedIndex: RowIndex = currentFolds().index, renderedFoldGeneration = -1, observedFoldRevision = currentFolds().revision;
    let comparisonRows: ViewportComparisonRows | undefined, rowGeneration = 0, renderedAlignmentId: number | null = null, naturalLineHeight = lineHeight;
    let renderedSelection: Selection | null = null;
    let renderedSelectionSet: SelectionSet | null = null;
    let renders = 0, firstLine = 0, lastLine = 0, partialRows = 0, textUnits = 0, readUnits = 0, lastRenderMs = 0;
    const commandMeasure = editorElement(owner, "div", "viewport-command-measure");
    commandMeasure.setAttribute("aria-hidden", "true");
    const commandRow = owner.createElement("div");
    commandMeasure.append(commandRow);
    let commandGeometry: ReturnType<typeof rowGeometry> | undefined;
    let anchor: Readonly<{ revision: number; offset: number; topRemainder: number; leftRemainder: number; aligned?: true }> | undefined;
    let reveal: Readonly<{ revision: number; foldGeneration: number; offset: number; end?: number; align?: RevealAlignment }> & Required<RevealOptions> | undefined;
    let horizontalAnchor: ViewState["horizontalAnchor"];
    let restoredHorizontal: ViewState["horizontalAnchor"];
    let fragmentPlacement: Readonly<{ revision: number; line: number; from: number; to: number; left: number; shift: number }> | undefined;
    let fixedPitch = false, measuredWidth = 0, measuredFont = "", measuredRevision: number | null = null, spacerWidth = -1;
    let selectionMetrics: { font: string; height: number; zoom: number } | undefined;
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
        if (disposed || !live()) return undefined;
        const document = currentDocument();
        if (document?.revision !== renderedRevision || currentFolds().generation !== renderedFoldGeneration
            || !isOffset(offset, document.buffer.length)) return undefined;
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
    let visibleItems: readonly Row[] = [], overviewEpoch = 0;
    const dirtyRows = new Set<number>();
    const decorations = createDecorationLayers(
        () => !disposed && live() ? currentDocument() : undefined,
        (dirty, overview) => {
            for (const row of visibleItems) if (dirty(row)) dirtyRows.add(row.line);
            commandGeometry = undefined;
            if (overview) overviewEpoch++;
            if (dirtyRows.size || overview && minimap) schedule();
        }, () => live());
    // Host invalidation and font loading can change inline layout without changing text/classes.
    const invalidate = () => { measuredFont = ""; paintEpoch++; selectionMetrics = undefined; geometries.clear(); commandGeometry = undefined; schedule(); };
    const flush = () => { if (disposed) return; const scheduled = frame !== undefined; if (scheduled) win.cancelAnimationFrame(frame!); render(scheduled); };
    const position = (axis: ScrollAxis, value: number): number => Math.min(axis.maximum, Math.max(0, value));
    const gapAt = (index: RowIndex, row: number) => "gapAt" in index ? index.gapAt(row) : undefined;
    const visualRowAtY = (localY: number) => Math.max(0, Math.min(renderedIndex.visibleLineCount - 1, Math.floor((localY + top - padding) / lineHeight)));
    function verticalAnchor(): ViewState["verticalAnchor"] {
        if (!previous || previous.revision !== currentDocument()?.revision) return;
        const at = Math.min(renderedIndex.visibleLineCount - 1, Math.max(0, Math.floor((top - padding) / lineHeight))), gap = gapAt(renderedIndex, at);
        const offset = gap?.offset ?? previous.buffer.offsetAt(renderedIndex.lineAt(at));
        // Padding maps to a real boundary; keep its distance from that SOURCE row, which
        // may span several padding rows and therefore has a negative pixel remainder.
        return { revision: previous.revision, offset, topRemainder: top - renderedIndex.rowAt(previous.buffer.lineAt(offset)) * lineHeight,
            ...(renderedAlignmentId !== null ? { aligned: true } : {}) };
    }
    function visibleCaretAnchor(selection: Selection): ViewState["horizontalAnchor"] {
        const affinity = selection.headAffinity ?? "after";
        const caret = coordinates(selection.head, affinity);
        if (!caret || !previous) return;
        const box = clientBox(root, !!minimap, gutterWidth);
        if (caret.left < box.left || caret.left >= box.right || caret.top >= box.bottom || caret.top + caret.height <= box.top) return;
        return { revision: previous.revision, offset: selection.head, affinity, left: (caret.left - box.left) / box.zoom };
    }
    function setComparisonRows(value: ViewportComparisonRows | undefined): boolean {
        if (disposed || !live()) return false;
        const document = currentDocument(), folds = currentFolds();
        if (value && (!document || value.documentId !== documentId || value.revision !== document.revision || value.foldGeneration !== folds.generation || !value.index.matches(document.buffer, folds.index))) return false;
        if (value && (!isPositiveInteger(value.id) || !Number.isFinite(value.lineHeight) || value.lineHeight <= 0)) throw new RangeError("Invalid comparison row capture.");
        if (comparisonRows?.id === value?.id) return true;
        // At the top edge, newly inserted leading gaps must remain in view. At
        // other positions keep the same source row under the reader's eye.
        const at = top > 0 && !anchor ? verticalAnchor() : undefined;
        if (at) anchor = { revision: at.revision, offset: at.offset, topRemainder: at.topRemainder, leftRemainder: left - (at.offset - document!.buffer.offsetAt(document!.buffer.lineAt(at.offset))) * columnWidth };
        comparisonRows = value && Object.freeze({ ...value }); rowGeneration++; schedule(); return true;
    }
    const validateScroll = (position: Readonly<{ top?: number; left?: number }>) => {
        if ((position.top !== undefined && !Number.isFinite(position.top)) || (position.left !== undefined && !Number.isFinite(position.left))) throw new RangeError("Invalid scroll position.");
    };
    const setScroll = (position: Readonly<{ top?: number; left?: number }>) => {
        if (disposed) return;
        validateScroll(position);
        releaseScrollbar();
        if (position.top !== undefined) top = Math.max(0, position.top);
        if (position.left !== undefined) left = Math.max(0, position.left);
        anchor = undefined; horizontalAnchor = undefined; fragmentPlacement = undefined;
        schedule();
    };
    const createMinimap = () => mountMinimap(root, top => {
        if (!live()) return;
        setScroll({ top });
        // A native scroll notification from the preceding drag step can arrive before
        // the next render. Make it observe the current destination, as a real thumb does.
        root.scrollTop = y.toPhysical(top);
    }, line => decorations.present(line, true), line => decorations.lineClasses(line, true));
    let minimap = settings.minimap ? createMinimap() : undefined;
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
    function rebindComparison(document: DocumentSnapshot, folds: FoldingSnapshot) {
        if (!comparisonRows || comparisonRows.index.matches(document.buffer, folds.index)) return;
        const change = document.change;
        const index = comparisonRows.index.rebind(document.buffer, folds.index,
            change?.previousRevision === comparisonRows.revision ? change.mapping : undefined);
        comparisonRows = index && { ...comparisonRows, revision: document.revision, foldGeneration: folds.generation, index };
        rowGeneration++;
    }
    const documentChanged = () => {
        const current = currentDocument();
        mapRowSources(current);
        if (current && previous && current.revision !== previous.revision) {
            if (comparisonRows) rebindComparison(current, currentFolds());
            if (!anchor) {
                const visibleRow = Math.min(renderedIndex.visibleLineCount - 1, Math.max(0, Math.floor((top - padding) / lineHeight))), line = renderedIndex.lineAt(visibleRow);
                const start = previous.buffer.offsetAt(line), end = line + 1 < previous.buffer.lineCount ? previous.buffer.offsetAt(line + 1) - 1 : previous.buffer.length;
                const offset = gapAt(renderedIndex, visibleRow)?.offset ?? Math.min(end, start + Math.floor(left / columnWidth));
                anchor = { revision: previous.revision, offset, topRemainder: top - renderedIndex.rowAt(previous.buffer.lineAt(offset)) * lineHeight, leftRemainder: left - (offset - start) * columnWidth };
            }
            anchor = mapViewAnchor(anchor, current.revision, current.change);
            if (reveal && current.change?.previousRevision === reveal.revision) {
                const offset = current.change.mapViewOffset(reveal.offset, reveal.affinity);
                reveal = { ...reveal, revision: current.revision, offset,
                    ...(reveal.end !== undefined && { end: Math.max(offset, current.change.mapViewOffset(reveal.end, "before")) }) };
            }
            horizontalAnchor = mapViewAnchor(horizontalAnchor, current.revision, current.change);
            fragmentPlacement = undefined;
        } else if (!current) { anchor = undefined; reveal = undefined; horizontalAnchor = undefined; fragmentPlacement = undefined; }
        schedule();
    };
    let restoredFolds: FoldingSnapshot | undefined;
    const foldsChanged = () => {
        const folds = currentFolds(), documentAdvanced = folds.revision !== observedFoldRevision; observedFoldRevision = folds.revision;
        const restored = folds === restoredFolds; restoredFolds = undefined;
        if (restored) { schedule(); return; }
        if (documentAdvanced) {
            if (reveal) reveal = { ...reveal, foldGeneration: folds.generation };
            schedule(); return;
        }
        if (previous && !anchor && previous.revision === currentDocument()?.revision) {
            const visibleRow = Math.min(renderedIndex.visibleLineCount - 1, Math.max(0, Math.floor((top - padding) / lineHeight))), line = renderedIndex.lineAt(visibleRow);
            anchor = { revision: previous.revision, offset: previous.buffer.offsetAt(line), topRemainder: top - renderedIndex.rowAt(line) * lineHeight, leftRemainder: left };
        }
        if (reveal && reveal.foldGeneration !== folds.generation) reveal = undefined;
        horizontalAnchor = undefined; fragmentPlacement = undefined; schedule();
    };
    const expose = (start: number, size: number, scroll: number, visible: number): number => {
        const margin = Math.min(padding, visible / 4);
        return start < scroll + margin ? Math.max(0, start - margin) : start + size > scroll + visible - margin ? Math.max(0, start + size - visible + margin) : scroll;
    };
    const horizontalPosition = (value: number): number => { const margin = Math.min(padding, width / 4); return Math.max(margin, Math.min(width - margin, value)); };
    // Keep a visible interval still on this axis. For an oversized interval, show its start.
    const rangeScroll = (start: number, end: number, scroll: number, visible: number): number => {
        if (Math.abs(end - start) > visible) end = start;
        if (Math.min(start, end) >= scroll && Math.max(start, end) <= scroll + visible) return scroll;
        return Math.max(0, (start + end - visible) / 2);
    };
    const measuredRangeLeft = (from: number, to: number): number | undefined => {
        const start = coordinates(from), end = from === to ? start : coordinates(to, "before");
        if (!start || !end || start.top !== end.top) return;
        const box = clientBox(root, false, gutterWidth);
        return rangeScroll(left + (start.left - box.left) / box.zoom, left + (end.left - box.left) / box.zoom, left, width);
    };
    const row = (buffer: TextBuffer, line: number, scrollLeft = left, navigation = false): Row => {
        const read = (from: number, to: number) => {
            if (!navigation) readUnits += to - from;
            return buffer.slice(from, to);
        };
        const start = buffer.offsetAt(line), end = line + 1 < buffer.lineCount ? buffer.offsetAt(line + 1) - 1 : buffer.length;
        const displayEnd = line + 1 < buffer.lineCount && end > start && read(end - 1, end) === "\r" ? end - 1 : end;
        let from = Math.min(displayEnd, start + Math.max(0, Math.floor((scrollLeft - padding) / columnWidth) - overscanUnits));
        let to = Math.min(displayEnd, start + Math.max(0, Math.ceil((scrollLeft + width) / columnWidth) + overscanUnits));
        if (displayEnd - start <= 512) { from = start; to = displayEnd; }
        // Do not split a surrogate pair at the edges of the bounded text window.
        if (from > start && from < displayEnd) { const pair = read(from - 1, from + 1); if (/[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(pair)) from--; }
        if (to > from && to < displayEnd) { const pair = read(to - 1, to + 1); if (/[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(pair)) to++; }
        return { line, start, end: displayEnd, breakEnd: line + 1 < buffer.lineCount ? end + 1 : end,
            from, to, text: read(from, to).replaceAll("\r", "␍"), left: padding + (from - start) * columnWidth - scrollLeft, complete: from === start && to === displayEnd, endsLine: to === displayEnd };
    };
    const paintRow = (element: HTMLDivElement, item: Row, document: DocumentSnapshot, selectionSet: SelectionSet, highlightedLine?: number, index?: RowIndex): boolean => {
        element.dataset.line = String(item.line); element.dataset.from = String(item.from); element.dataset.to = String(item.to); element.dataset.complete = String(item.complete);
        const low = partitionPoint(selectionSet.ranges.length, index => {
            const range = selectionSet.ranges[index]!;
            return Math.max(range.anchor, range.head) <= item.from;
        });
        const selections: { from: number; to: number }[] = [];
        let selectedBreak = false;
        for (let index = low; index < selectionSet.ranges.length; index++) {
            const range = selectionSet.ranges[index]!, start = Math.min(range.anchor, range.head), end = Math.max(range.anchor, range.head);
            if (start >= (item.endsLine ? item.breakEnd : item.to)) break;
            if (start === end) continue;
            if (item.endsLine && end > item.to && item.breakEnd > item.to) selectedBreak = true;
            const from = Math.max(item.from, start), to = Math.min(item.to, end);
            if (from < to) selections.push({ from, to });
        }
        const presented = { documentId, revision: document.revision, line: item.line, lineStart: item.start, from: item.from, to: item.to, text: item.text };
        const lineClass = decorations.lineClasses(presented), className = "st-viewport-row" + (lineClass ? ` ${lineClass}` : "")
            + (highlightedLine === item.line ? " st-current-line" : "");
        const changed = element.className !== className; element.className = className;
        const inline = decorations.present(presented, false, item.endsLine);
        const marks = selectedBreak ? [...inline, { from: item.to, to: item.to, className: "st-selected-line-break" }] : inline;
        const parts = decorationParts(item.text, item.from, item.to, document.buffer.length, marks, selections, item.endsLine ? item.start : undefined);
        const fold = item.endsLine && index?.headerAt(item.line);
        if (fold && fold.collapsed) {
            const count = fold.lineTo - fold.lineFrom - 1;
            const changed = comparison?.foldContainsChange(document.buffer, fold.lineFrom + 1, fold.lineTo) ?? false;
            const label = settings.foldLabels.summary?.(fold, changed)
                ?? `… ${count} ${count === 1 ? "line" : "lines"} hidden${changed ? " · contains changes" : ""}`;
            parts.push({ text: "", className: "st-fold-summary", ornament: "fold", label });
        }
        return renderRowChildren(element, selections.length && parts.length > 1 ? selectedTokenRuns(parts) : parts) || changed;
    };
    type MeasuredRow = Readonly<{ complete: boolean; point: (offset: number, affinity?: Affinity) => CaretRectangle | undefined;
        nearest: (column: number) => CaretRectangle }>;
    function measuredRow(item: Row, value: ReturnType<typeof rowGeometry>, rectangle: ReturnType<typeof clientBox>): MeasuredRow {
        const buffer = workspace.document(documentId).buffer, start = buffer.offsetAt(item.line);
        const bounds = commandRow.getBoundingClientRect(), origin = padding + (item.from - start) * columnWidth;
        const mapped = (point: CaretRectangle): CaretRectangle => Object.freeze({ ...point, offset: point.offset + item.from,
            left: rectangle.left + (origin - left) * rectangle.zoom + point.left - bounds.left, top: rectangle.top + (padding + renderedIndex.rowAt(item.line) * lineHeight - top) * rectangle.zoom + point.top - bounds.top });
        return { complete: item.complete,
            point(offset, affinity) {
                const at = rowCaretOffset(buffer, item.to, offset);
                if (at === undefined) return;
                const point = value.point(at - item.from, affinity);
                if (!point) return;
                const result = mapped(point);
                return at === offset ? result : Object.freeze({ ...result, offset });
            },
            nearest: column => mapped(value.nearest(bounds.left + (column - origin) * rectangle.zoom)) };
    }
    function withRow<T>(line: number, scrollLeft: number, offset: number | undefined, work: (row: MeasuredRow) => T): T | undefined {
        const document = currentDocument();
        if (disposed || !live() || document?.revision !== renderedRevision) return;
        const existing = rows.get(line), rectangle = clientBox(root, false, gutterWidth);
        if (existing && (existing.dataset.complete === "true" || scrollLeft === left
            && (offset === undefined || offset >= Number(existing.dataset.from) && offset <= Number(existing.dataset.to)))) {
            const value = geometry(existing);
            return work({ complete: existing.dataset.complete === "true", point: value.point,
                nearest: column => value.nearest(rectangle.left + (column - left) * rectangle.zoom) });
        }
        const item = row(document.buffer, line, scrollLeft, true);
        const selectionSet = viewState().selectionSet;
        const changed = paintRow(commandRow, item, document, selectionSet, currentLine(document, selectionSet, renderedIndex));
        commandRow.style.height = `${lineHeight}px`;
        commandRow.style.lineHeight = comparisonRows ? `${lineHeight}px` : "";
        if (!commandMeasure.parentNode) root.append(commandMeasure);
        try {
            if (changed || !commandGeometry) commandGeometry = rowGeometry(commandRow, 0, document.revision, lineHeight * rectangle.zoom);
            return work(measuredRow(item, commandGeometry, rectangle));
        } finally {
            commandMeasure.remove();
        }
    }
    // Measure the contents: a full-row background can be wider than its source text.
    function measureRowWidths(elements: Iterable<HTMLElement>, zoom: number): void {
        const extent = owner.createRange();
        let widest = measuredWidth;
        for (const element of elements) {
            if (element.dataset.complete !== "true") continue;
            extent.selectNodeContents(element);
            widest = Math.max(widest, extent.getBoundingClientRect().width / zoom);
        }
        if (widest <= measuredWidth + .01) return;
        measuredWidth = widest;
        if (widest + padding * 2 > x.extent + .01) schedule();
    }
    function render(scheduled: boolean): void {
        frame = undefined; if (disposed) return;
        const started = win.performance.now();
        // Read container metrics before writing rows; bounded shaping reads follow the writes.
        const clientWidth = root.clientWidth, mapWidth = minimap ? minimapWidth(clientWidth) : 0;
        height = root.clientHeight;
        const zoom = cssZoom(root);
        // At multi-million-pixel scroll offsets a client rectangle loses fractional width.
        // Use the probe's layout width in CSS pixels before scaling logical columns.
        columnWidth = parseFloat(win.getComputedStyle(probe).width) / 64 || 8.4;
        const style = win.getComputedStyle(root); naturalLineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.6; lineHeight = naturalLineHeight;
        const font = [style.fontFamily, style.fontSize, style.fontWeight, style.fontStyle, style.fontStretch, style.letterSpacing, style.wordSpacing,
            style.tabSize, style.fontVariant, style.fontVariantLigatures, style.fontKerning,
            style.fontFeatureSettings, style.fontVariationSettings, style.textAlign, style.textTransform, style.textIndent].join("|");
        if (font !== measuredFont) {
            measuredWidth = 0;
            measuredFont = font;
            const narrow = parseFloat(win.getComputedStyle(narrowProbe).width);
            fixedPitch = Math.abs(narrow - 64 * columnWidth) < .1 && style.fontVariantLigatures === "none"
                && (style.wordSpacing === "normal" || parseFloat(style.wordSpacing) === 0);
        }
        const document = live() ? currentDocument() : undefined;
        // Reserve space by document line count. Scrolling and folding keep the text origin fixed.
        const lineCount = Math.max(document?.buffer.lineCount ?? 0, comparison?.gutterLineCount() ?? 0);
        const gutterDigits = Math.max(4, String(lineCount).length);
        gutterWidth = document && settings.gutter ? Math.min(Math.floor(clientWidth / 3), Math.ceil(columnWidth * gutterDigits) + 26) : 0;
        width = clientWidth - mapWidth - gutterWidth;
        if (!document) {
            clearPresentation();
            measuredWidth = 0;
            measuredRevision = null;
            spacerWidth = 0;
            spacer.style.width = "0px";
            spacer.style.height = "0px";
            root.setAttribute("aria-disabled", "true");
            firstLine = 0;
            lastLine = 0;
            publishGeometry(emptyViewport);
            return;
        }
        const folds = currentFolds();
        rebindComparison(document, folds);
        const index: RowIndex = comparisonRows?.index ?? folds.index;
        if (comparisonRows) lineHeight = Math.max(naturalLineHeight, comparisonRows.lineHeight);
        if (measuredRevision !== document.revision) { measuredWidth = 0; measuredRevision = document.revision; }
        // A ref replay can paint source-only rows before cooperative alignment is ready.
        // Retain the captured aligned source anchor until its intended grid exists.
        if (document.change && renderedRevision !== document.revision) decorations.advance(document.change);
        const deferAnchor = anchor?.revision === document.revision && anchor.aligned === true && !comparisonRows;
        if (anchor?.revision === document.revision && !deferAnchor) {
            const line = document.buffer.lineAt(anchor.offset);
            top = index.rowAt(line) * lineHeight + anchor.topRemainder; left = (anchor.offset - document.buffer.offsetAt(line)) * columnWidth + anchor.leftRemainder;
        } else if (previous && previous.revision !== document.revision && document.change === null) { top = 0; left = 0; }
        if (horizontalAnchor && horizontalAnchor === restoredHorizontal && width > 0 && !deferAnchor) {
            restoredHorizontal = undefined;
            if (horizontalAnchor.left >= width) {
                const fitted = horizontalPosition(horizontalAnchor.left);
                left += horizontalAnchor.left - fitted;
                horizontalAnchor = { ...horizontalAnchor, left: fitted };
            }
        }
        let horizontalEnd: number | undefined;
        if (reveal?.revision === document.revision && reveal.foldGeneration === folds.generation) {
            const line = document.buffer.lineAt(reveal.offset);
            const estimated = padding + (reveal.offset - document.buffer.offsetAt(line)) * columnWidth;
            const rowTop = padding + index.rowAt(line) * lineHeight;
            if (reveal.end !== undefined) {
                const lastLine = document.buffer.lineAt(Math.max(reveal.offset, reveal.end - 1));
                const bottom = padding + (index.rowAt(lastLine) + 1) * lineHeight;
                const visibleEnd = bottom - rowTop > height ? rowTop + lineHeight : bottom;
                switch (reveal.align) {
                    case "start": top = rowTop - padding; break;
                    case "center": top = (rowTop + visibleEnd - height) / 2; break;
                    case "nearest":
                        if (rowTop < top) top = rowTop - padding;
                        else if (visibleEnd > top + height) top = visibleEnd - height + padding;
                        break;
                    case "center-if-outside": top = rangeScroll(rowTop, bottom, top, height); break;
                }
                horizontalEnd = document.buffer.lineAt(reveal.end) === line ? reveal.end : reveal.offset;
                left = measuredRangeLeft(reveal.offset, horizontalEnd)
                    ?? rangeScroll(estimated, estimated + (horizontalEnd - reveal.offset) * columnWidth, left, width);
            } else {
                if (reveal.vertical === "nearest") top = expose(rowTop, lineHeight, top, height);
                else if (reveal.vertical === "center-if-outside") top = rangeScroll(rowTop, rowTop + lineHeight, top, height);
                else top = Math.max(0, rowTop - padding - height / 2);
                left = reveal.horizontal === "nearest" ? expose(estimated, 1, left, width) : Math.max(0, estimated - width / 2);
            }
        }
        const requested = reveal; if (!deferAnchor || requested) anchor = undefined; reveal = undefined;
        const documentWidth = () => Math.max(document.buffer.longestLineLength * columnWidth, measuredWidth) + padding * 2;
        x = scrollAxis(documentWidth(), width);
        // A lone visible row is already at the top. Do not inflate it to rounded clientHeight:
        // fractional fitting viewports would acquire mutually triggering classic scrollbars.
        const trailingSpace = settings.scrollBeyondLastLine && index.visibleLineCount > 1 ? Math.max(0, height - lineHeight - padding * 2) : 0;
        y = scrollAxis(index.visibleLineCount * lineHeight + padding * 2 + trailingSpace, height);
        // A measured label can widen the spacer without introducing a scrollbar. Only a
        // change in scroll range or viewport size affects which source fragments to paint.
        const nextWidth = Math.min(x.extent, x.physicalExtent) + mapWidth + gutterWidth;
        if (nextWidth !== spacerWidth) { spacerWidth = nextWidth; spacer.style.width = `${spacerWidth}px`; }
        top = position(y, top); left = position(x, left);
        minimap?.paint(document, index, mapWidth, height, top, y.extent, lineHeight, padding, style.color,
            Math.max(1, parseFloat(style.tabSize) || 4), Math.max(2, Math.min(3, win.devicePixelRatio * zoom)), paintEpoch + overviewEpoch, settings.minimapLabel);
        // Presentation-only configuration can repaint guides without reading or rebuilding rows.
        rulers.paint(settings.columnRulers, columnWidth, left, width);
        const { selection: selected, selectionSet } = viewState();
        if ((selected.anchor !== selected.head || selectionSet.ranges.length > 1)
            && (selectionMetrics?.font !== font || selectionMetrics.height !== lineHeight || selectionMetrics.zoom !== zoom)) {
            // Inline padding extends the painted background without changing shaping, advances or row height.
            const range = owner.createRange(); range.selectNodeContents(probe);
            const glyph = range.getBoundingClientRect(), probeBox = probe.getBoundingClientRect(), extra = (lineHeight - naturalLineHeight) / 2;
            layer.style.setProperty("--st-selection-pad-top", `${Math.max(0, extra + (glyph.top - probeBox.top) / zoom)}px`);
            layer.style.setProperty("--st-selection-pad-bottom", `${Math.max(0, extra + (probeBox.bottom - glyph.bottom) / zoom)}px`);
            selectionMetrics = { font, height: lineHeight, zoom };
        }
        const key = [document.revision, selectionSet, folds.generation, rowGeneration, comparisonRows?.id,
            top, left, width, height, gutterWidth, zoom, columnWidth, naturalLineHeight, lineHeight, font, x.maximum, y.extent, paintEpoch, settings.highlightCurrentLine,
            settings.gutter, inputOwner?.composing ?? false];
        if (!requested && painted && painted.horizontalAnchor === horizontalAnchor && painted.placement === fragmentPlacement
            && key.every((value, index) => value === painted!.key[index])
            && Math.abs(root.scrollTop - y.toPhysical(top)) <= 1 && Math.abs(root.scrollLeft - x.toPhysical(left)) <= 1) {
            if (dirtyRows.size) {
                const highlighted = currentLine(document, selectionSet, index);
                const changed: HTMLDivElement[] = [];
                for (const item of visibleItems) if (dirtyRows.has(item.line)) {
                    const element = rows.get(item.line)!;
                    if (paintRow(element, item, document, selectionSet, highlighted, index)) {
                        geometries.delete(item.line);
                        changed.push(element);
                    }
                }
                dirtyRows.clear();
                measureRowWidths(changed, zoom);
                renders++; lastRenderMs = win.performance.now() - started;
            }
            // Consuming scheduled work still releases caret/alignment/linked-scroll listeners.
            // An idle synchronous flush needs neither row work nor a new caret frame.
            if (geometryState.get().horizontalExtent !== x.extent) publishGeometry({ ...geometryState.get(), horizontalExtent: x.extent });
            if (scheduled) notify("render");
            return;
        }
        const highlightedLine = currentLine(document, selectionSet, index);
        commandGeometry = undefined; readUnits = 0;
        const firstRow = Math.min(index.visibleLineCount - 1, Math.max(0, Math.floor((top - padding) / lineHeight) - overscanLines));
        const lastRow = Math.min(index.visibleLineCount, Math.max(firstRow + 1, Math.ceil((top + height) / lineHeight) + overscanLines));
        firstLine = index.lineAt(firstRow); lastLine = index.lineAt(lastRow - 1) + 1;
        const next: Row[] = [], blanks: number[] = [];
        const visibleFrom = Math.floor((top - padding) / lineHeight), visibleTo = Math.ceil((top + height - padding) / lineHeight);
        let lineFrom = 0, lineTo = 0;
        for (let visible = firstRow; visible < lastRow; visible++) {
            if (gapAt(index, visible)) { blanks.push(visible); continue; }
            const line = index.lineAt(visible); next.push(row(document.buffer, line));
            if (height > 0 && visible >= visibleFrom && visible < visibleTo) {
                if (!lineTo) lineFrom = line;
                lineTo = line + 1;
            }
        }
        const paintedGeometry = { lineFrom, lineTo, scrollTop: top, scrollLeft: left, width, height, gutterWidth,
            lineHeight, naturalLineHeight, columnWidth, verticalExtent: y.extent, horizontalExtent: x.extent };
        visibleItems = next; dirtyRows.clear();
        retainRows(document, next);
        partialRows = next.filter(row => !row.complete).length;
        // A fitting document must not fill rounded client metrics: a fractional viewport can be
        // slightly smaller, making classic scrollbars repeatedly add/remove each other.
        spacer.style.height = `${Math.min(y.extent, y.physicalExtent)}px`;
        if (requested && scrollbarPressed) settleScrollbarReveal();
        root.scrollLeft = x.toPhysical(left);
        const physicalTop = y.toPhysical(top);
        root.scrollTop = physicalTop;
        // Keep old rows at their document Y until the next render replaces them.
        surface.style.transform = `translateY(${physicalTop}px)`;
        surface.style.setProperty("--st-gutter-width", `${gutterWidth}px`);
        surface.style.setProperty("--st-minimap-width", `${mapWidth}px`);
        layer.style.setProperty("--st-text-area-width", `${width}px`);
        gutter.toggleAttribute("data-scrolled", left > 0);
        const highlightedTop = highlightedLine === undefined ? undefined : padding + index.rowAt(highlightedLine) * lineHeight - top;
        if (highlightedTop === undefined || highlightedTop + lineHeight <= 0 || highlightedTop >= height) clearCurrentLine();
        else {
            if (!currentLineBackground) { currentLineBackground = editorElement(owner, "div", "current-line-background");
                currentLineBackground.setAttribute("aria-hidden", "true"); surface.append(currentLineBackground); }
            currentLineBackground.style.top = `${highlightedTop}px`; currentLineBackground.style.height = `${lineHeight}px`;
        }
        textUnits = 0;
        for (const item of next) {
            let element = rows.get(item.line);
            if (!element) { element = editorElement(owner, "div", "viewport-row"); rows.set(item.line, element); layer.append(element); }
            const placement = fragmentPlacement, shift = placement?.revision === document.revision && placement.line === item.line
                && placement.from === item.from && placement.to === item.to && placement.left === left ? placement.shift : 0;
            element.style.setProperty("--st-fragment-left", `${item.left + shift}px`);
            element.style.transform = `translate(var(--st-fragment-left), ${padding + index.rowAt(item.line) * lineHeight - top}px)`;
            element.style.height = `${lineHeight}px`;
            element.style.lineHeight = comparisonRows ? `${lineHeight}px` : "";
            if (paintRow(element, item, document, selectionSet, highlightedLine, index)) geometries.delete(item.line);
            textUnits += item.text.length;
            rowSources.set(element, item);
        }
        const visibleLines = new Set(next.map(item => item.line));
        for (const [line, element] of rows) if (!visibleLines.has(line)) { element.remove(); rows.delete(line); rowSources.delete(element); geometries.delete(line); }
        next.forEach((item, index) => { const element = rows.get(item.line)!; if (layer.children.item(index) !== element) layer.insertBefore(element, layer.children.item(index)); });
        const visiblePadding = new Set(blanks);
        for (const [at, element] of paddingRows) if (!visiblePadding.has(at)) { element.remove(); paddingRows.delete(at); }
        for (const at of blanks) {
            let element = paddingRows.get(at); if (!element) { element = editorElement(owner, "div", "comparison-padding"); element.setAttribute("aria-hidden", "true"); paddingRows.set(at, element); layer.append(element); }
            element.style.transform = `translate(0px, ${padding + at * lineHeight - top}px)`; element.style.height = `${lineHeight}px`; element.style.width = `${width}px`;
        }
        root.removeAttribute("aria-disabled"); root.dataset.revision = String(document.revision);
        renderedRevision = document.revision; rowSourceRevision = document.revision; renderedSelection = selected; renderedSelectionSet = selectionSet; previous = document; renderedIndex = index; renderedFoldGeneration = folds.generation; renderedAlignmentId = comparisonRows?.id ?? null; renders++;
        const visibleFolds = new Set<string>(), orderedButtons: HTMLButtonElement[] = [];
        let nextHead = -1;
        let headRow = -1;
        for (const item of settings.gutter ? next : []) {
            const visualRow = index.rowAt(item.line);
            const rowTop = padding + visualRow * lineHeight - top;
            if (settings.highlightCurrentLine && nextHead < item.start) {
                const ranges = selectionSet.ranges;
                const at = partitionPoint(ranges.length, i => ranges[i]!.head < item.start);
                nextHead = ranges[at]?.head ?? Infinity;
                headRow = at < ranges.length ? index.rowAt(document.buffer.lineAt(nextHead)) : -1;
            }
            let number = lineNumbers.get(item.line);
            if (!number) {
                number = owner.createElement("span"); number.textContent = String(item.line + 1);
                lineNumbers.set(item.line, number); numbers.append(number);
            }
            number.style.top = `${rowTop}px`; number.style.lineHeight = `${lineHeight}px`;
            number.toggleAttribute("data-current", headRow === visualRow);
            const region = index.headerAt(item.line); if (!region) continue; visibleFolds.add(region.id);
            let button = foldButtons.get(region.id);
            if (!button) {
                button = editorElement(owner, "button", "fold-button"); button.type = "button";
                button.dataset.fold = region.id;
                foldButtons.set(region.id, button); foldLayer.append(button);
            }
            orderedButtons.push(button);
            const action = region.collapsed ? "Expand" : "Collapse";
            const first = region.lineFrom + 2;
            const body = region.group === "imports" ? "imports" : first === region.lineTo ? `line ${first}` : `lines ${first}–${region.lineTo}`;
            const label = settings.foldLabels.action?.(region) ?? `${action} ${body}`;
            button.setAttribute("aria-label", label); button.title = label; button.setAttribute("aria-expanded", String(!region.collapsed));
            // Replacing even identical text during a pointer press cancels WebKit's native click.
            const arrow = region.collapsed ? "▸" : "▾"; if (button.textContent !== arrow) button.textContent = arrow;
            button.disabled = inputOwner?.composing ?? false;
            button.tabIndex = -1;
            button.style.top = `${rowTop}px`; button.style.height = `${lineHeight}px`;
        }
        for (const [line, number] of lineNumbers) if (!settings.gutter || !rows.has(line)) { number.remove(); lineNumbers.delete(line); }
        for (const [id, button] of foldButtons) if (!visibleFolds.has(id)) {
            const focused = isFocused(button); button.remove(); foldButtons.delete(id);
            if (focused) notify("focus");
            if (disposed || !live()) return;
        }
        orderedButtons.forEach((button, index) => { if (foldLayer.children.item(index) !== button) foldLayer.insertBefore(button, foldLayer.children.item(index)); });
        gutter.hidden = !settings.gutter;
        measureRowWidths(rows.values(), zoom);
        const requestedRow = requested?.revision === document.revision ? rows.get(document.buffer.lineAt(requested.offset)) : undefined;
        const rangeLeft = requested && horizontalEnd !== undefined ? measuredRangeLeft(requested.offset, horizontalEnd) : undefined;
        if (requestedRow?.dataset.complete === "false") {
            const caret = coordinates(requested!.offset, requested!.affinity), rectangle = clientBox(root, false, gutterWidth);
            if (caret) {
                const actual = (caret.left - rectangle.left) / rectangle.zoom;
                const desired = rangeLeft !== undefined ? actual + left - rangeLeft
                    : requested!.horizontal === "center" ? width / 2 : horizontalPosition(actual);
                if (Math.abs(desired - actual) > 1) horizontalAnchor = { revision: document.revision, offset: requested!.offset, affinity: requested!.affinity, left: desired };
            }
        }
        // A partial row has no measured global horizontal origin. Move only its bounded
        // fragment to expose the requested native caret; keep the logical scroll map intact.
        if (horizontalAnchor?.revision === document.revision) {
            const at = horizontalAnchor, line = document.buffer.lineAt(at.offset), item = next.find(item => item.line === line), element = rows.get(line);
            if (item?.complete) horizontalAnchor = undefined;
            else if (item && element && at.offset >= item.from && at.offset <= item.to) {
                const caret = coordinates(at.offset, at.affinity), rectangle = clientBox(root, false, gutterWidth);
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
            const caret = coordinates(requested.offset, requested.affinity), rectangle = clientBox(root, false, gutterWidth);
            if (caret) {
                const actual = (caret.left - rectangle.left) / rectangle.zoom + left;
                const desired = rangeLeft ?? (requested.horizontal === "nearest" ? expose(actual, 1, left, width) : Math.max(0, actual - width / 2));
                const maximum = Math.max(0, documentWidth() - width);
                if (Math.abs(Math.min(maximum, desired) - left) > 1) { left = Math.min(maximum, desired); schedule(); }
            }
        }
        lastRenderMs = win.performance.now() - started;
        // Keep the scroll/extent values actually painted; reveal corrections may queue a newer one.
        painted = { key, horizontalAnchor, placement: fragmentPlacement };
        publishGeometry(paintedGeometry);
        notify("render");
    }
    const foldButton = (target: EventTarget | null): HTMLButtonElement | undefined => {
        const button = (target as Element | null)?.closest?.("button.st-fold-button") as HTMLButtonElement | null | undefined;
        return button && foldLayer.contains(button) ? button : undefined;
    };
    const activateFold = (version: FoldVersion, id: string, collapse: boolean, focus: boolean) => {
        if (disposed || !live() || inputOwner?.composing) return false;
        const binding = inputOwner;
        if (!view.folding.setCollapsed(version, id, collapse, { moveHiddenCarets: true })) return false;
        // A second press may arrive before the next animation frame.
        flush();
        if (focus && binding && inputOwner === binding) notify("focus");
        return true;
    };
    let pressedSummary: { marker: Element; id: string; version: FoldVersion } | undefined;
    listen(layer, "pointerdown", event => {
        pressedSummary = undefined;
        const marker = event.target as HTMLElement;
        if (!event.isPrimary || event.button !== 0 || marker.dataset?.ornament !== "fold") return;
        event.stopPropagation(); event.preventDefault();
        const fold = renderedIndex.headerAt(Number(marker.parentElement?.dataset.line));
        if (fold?.collapsed && renderedRevision !== null && !inputOwner?.composing)
            pressedSummary = { marker, id: fold.id, version: { revision: renderedRevision, generation: renderedFoldGeneration } };
    });
    listen(layer, "pointercancel", () => { pressedSummary = undefined; });
    listen(layer, "click", event => {
        const pressed = pressedSummary; pressedSummary = undefined;
        if (!pressed || event.target !== pressed.marker) return;
        event.stopPropagation();
        if (activateFold(pressed.version, pressed.id, false, true) && !inputOwner && !disposed) root.focus({ preventScroll: true });
    });
    listen(foldLayer, "pointerdown", event => {
        if (!foldButton(event.target)) return;
        event.stopPropagation();
        if (event.button !== 0) return;
        if (inputOwner) event.preventDefault();
        if (frame !== undefined) flush();
    });
    listen(foldLayer, "dblclick", event => { if (foldButton(event.target)) event.stopPropagation(); });
    listen(foldLayer, "click", event => {
        const button = foldButton(event.target); if (!button) return; event.stopPropagation();
        if (renderedRevision !== null) activateFold({ revision: renderedRevision, generation: renderedFoldGeneration }, button.dataset.fold!,
            button.getAttribute("aria-expanded") === "true", event.detail > 0);
    });
    listen(foldLayer, "keydown", event => { if (event.key === "Escape" && foldButton(event.target)) {
        event.preventDefault(); if (!disposed && live()) notify("focus");
    } });
    // A native scrollbar press can focus the scroll container despite its negative tab index.
    // Moving focus during a native selection drag cancels dragstart in Chromium.
    listen(root, "focus", () => { if (inputOwner && !root.draggable) notify("focus"); });
    listen(root, "pointerdown", event => {
        releaseScrollbar();
        if (event.target !== root || event.button !== 0) return;
        const box = clientBox(root);
        scrollbarPressed = event.clientX >= box.right || event.clientY >= box.bottom;
    }, { capture: true });
    listen(root, "mousedown", event => {
        // The native track scrolls independently of mousedown's focus default.
        if (inputOwner && scrollbarPressed && event.target === root && event.button === 0) event.preventDefault();
    });
    listen(root, "scroll", () => {
        if (revealSettling !== undefined) {
            if (correctScrollbarReveal()) settleScrollbarReveal();
            return;
        }
        const newTop = y.toLogical(root.scrollTop), newLeft = x.toLogical(root.scrollLeft);
        // Ignore quantization from writes to native fractional/scaled scroll offsets.
        if (Math.abs(root.scrollTop - y.toPhysical(top)) > 1 || Math.abs(root.scrollLeft - x.toPhysical(left)) > 1) { top = newTop; left = newLeft; anchor = undefined; horizontalAnchor = undefined; fragmentPlacement = undefined; schedule(); }
    });
    listen(root, "wheel", event => {
        if (event.defaultPrevented || event.ctrlKey || event.metaKey) return;
        releaseScrollbar();
        const factor = event.deltaMode === 1 ? lineHeight : event.deltaMode === 2 ? height : 1;
        const nextTop = position(y, top + (event.shiftKey ? 0 : event.deltaY) * factor), nextLeft = position(x, left + (event.shiftKey ? event.deltaY : event.deltaX) * factor);
        if (nextTop !== top || nextLeft !== left) { event.preventDefault(); top = nextTop; left = nextLeft; anchor = undefined; horizontalAnchor = undefined; fragmentPlacement = undefined; schedule(); }
    }, { passive: false });
    listen(root, "keydown", event => {
        if (event.target !== root || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
        const delta = { ArrowUp: [0, -lineHeight], ArrowDown: [0, lineHeight], ArrowLeft: [-columnWidth, 0], ArrowRight: [columnWidth, 0],
            PageUp: [0, -height * .9], PageDown: [0, height * .9] }[event.key];
        if (delta) { event.preventDefault(); setScroll({ left: position(x, left + delta[0]!), top: position(y, top + delta[1]!) }); }
    });
    const observer = new ResizeObserver(schedule); observer.observe(root); observer.observe(probe);
    listen(owner.fonts, "loadingdone", invalidate);
    listen(owner.fonts, "loadingerror", invalidate);
    const subscriptions = [workspace.onDocumentChange(documentId, change => {
        // A host can flush inside an earlier listener, even before a batch has delivered all its maps.
        if (decorations.advance(change) && renderedRevision === change.revision) {
            for (const item of visibleItems) dirtyRows.add(item.line);
            overviewEpoch++; schedule();
        }
    }), source.subscribe(documentChanged), view.subscribe(schedule), view.folding.subscribe(foldsChanged), resource.metadata.subscribe(schedule)];

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
        decorations: decorations.handle,
        element: root,
        view,
        activity,
        getSnapshot: geometryState.observable.getSnapshot,
        subscribe(listener) {
            if (disposed) throw new Error("Viewport is disposed.");
            const unsubscribe = geometryState.observable.subscribe(listener);
            const stop = () => { unsubscribe(); observationStops.delete(stop); };
            observationStops.add(stop); return stop;
        },
        onRender: listener => observe("render", listener),
        bindInput: focus => {
            if (disposed || !live() || inputOwner) throw new Error("Viewport requires one current input owner.");
            const binding = { composing: false, detach: observe("focus", focus) };
            inputOwner = binding; root.tabIndex = -1; layer.setAttribute("aria-hidden", "true");
            const setComposing = (value: boolean): boolean => {
                if (disposed || inputOwner !== binding || !live() || binding.composing === value) return false;
                binding.composing = value;
                root.classList.toggle("st-composing", value); invalidate();
                for (const button of foldButtons.values()) button.disabled = value;
                return true;
            };
            return Object.freeze({ setComposing,
                dispose: () => {
                    if (inputOwner !== binding) return; binding.detach(); inputOwner = undefined;
                    root.classList.remove("st-composing"); root.tabIndex = 0; layer.removeAttribute("aria-hidden");
                    for (const button of foldButtons.values()) button.disabled = false;
                    if (!disposed) invalidate();
                } });
        },
        settings: () => settings,
        configure: changes => {
            notifications.assertWritable();
            if (disposed || !live()) return false;
            const previous = settings, next = viewportSettings(previous, changes);
            if (next === previous) return true;
            settings = next;
            if (next.minimap !== previous.minimap) {
                if (next.minimap) minimap = createMinimap();
                else { minimap?.dispose(); minimap = undefined; }
            }
            if (next.highlightCurrentLine !== previous.highlightCurrentLine) { commandGeometry = undefined; }
            if (next.fontLigatures !== previous.fontLigatures) root.style.fontVariantLigatures = next.fontLigatures ? "normal" : "none";
            if (next.fontLigatures !== previous.fontLigatures || next.foldLabels !== previous.foldLabels) invalidate();
            else schedule();
            return true;
        },
        invalidate,
        coordsAt: coordinates,
        rowBounds: (line: number) => {
            const current = currentDocument(), folding = currentFolds();
            // A queued paint can update widths while the current row is still on screen.
            if (disposed || !live() || current?.revision !== renderedRevision || folding.generation !== renderedFoldGeneration
                || !isIndex(line, current.buffer.lineCount) || renderedIndex.hiddenBy(line)) return undefined;
            const row = rows.get(line); if (!row) return undefined; const rectangle = row.getBoundingClientRect();
            return Object.freeze({ revision: current.revision, foldGeneration: folding.generation, line, top: rectangle.top, height: rectangle.height });
        },
        hitTest: (clientX: number, clientY: number) => {
            if (!Number.isFinite(clientX) || !Number.isFinite(clientY) || disposed || !live()
                || currentDocument()?.revision !== renderedRevision) return undefined;
            const rectangle = clientBox(root, !!minimap, gutterWidth);
            if (minimap && clientX >= rectangle.right) return undefined;
            const at = visualRowAtY((clientY - rectangle.top) / rectangle.zoom), gap = gapAt(renderedIndex, at);
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
        captureView: () => { const { selection, selectionSet } = viewState();
            // Ref replay may recapture an intermediate unaligned paint. Always retain source
            // coordinates, and prefer an anchor that has not yet reached its first paint.
            const folds = currentFolds(), vertical = anchor && anchor.revision === currentDocument()?.revision
                ? { revision: anchor.revision, offset: anchor.offset, topRemainder: anchor.topRemainder, ...(anchor.aligned || renderedAlignmentId !== null ? { aligned: true as const } : {}) }
                : verticalAnchor();
            const horizontal = horizontalAnchor ?? visibleCaretAnchor(selection);
            return Object.freeze({ ...selection, selectionSet, scrollTop: top, scrollLeft: left,
                ...(vertical ? { verticalAnchor: Object.freeze(vertical) } : {}),
                folding: Object.freeze({ documentId, viewId: view.id, revision: folds.revision, generation: folds.generation, get regions() { return folds.regions; } }),
                ...(horizontal ? { horizontalAnchor: Object.freeze({ ...horizontal }) } : {}) }); },
        restoreView: (state, options = {}) => {
            if (disposed || !live() || resource.getSnapshot().state !== "ready") return null;
            const document = workspace.document(documentId), saved = state.folding;
            if (saved && saved.documentId !== documentId) return null;
            let value = state.horizontalAnchor, vertical = state.verticalAnchor;
            const scroll = { top: state.scrollTop, left: state.scrollLeft };
            validateScroll(scroll);
            if (value && (!isNonNegativeInteger(value.revision) || !isNonNegativeInteger(value.offset)
                || !Number.isFinite(value.left) || value.left < 0 || value.affinity !== "before" && value.affinity !== "after")) throw new RangeError("Invalid horizontal view anchor.");
            if (value?.revision === document.revision && value.offset > document.buffer.length) throw new RangeError("Horizontal view anchor is outside the document.");
            if (vertical && (!isNonNegativeInteger(vertical.revision) || !isNonNegativeInteger(vertical.offset) || !Number.isFinite(vertical.topRemainder) || vertical.aligned !== undefined && vertical.aligned !== true)) throw new RangeError("Invalid vertical view anchor.");
            if (vertical?.revision === document.revision && vertical.offset > document.buffer.length) throw new RangeError("Vertical view anchor is outside the document.");
            const selected = selectionToRestore(document, view, state, options);
            const folds = currentFolds();
            const regions = saved && saved.revision === document.revision && saved.viewId !== view.id
                && folds.generation === 0 && !folds.regions.length
                ? createFoldRegions(document.buffer, saved.regions) : undefined;
            if (value && selected.source === "current" && value.offset === state.head && value.affinity === (state.headAffinity ?? "after")
                && (!saved || value.revision === saved.revision)) {
                const primary = selected.set.ranges[selected.set.primary]!;
                value = { ...value, revision: document.revision, offset: primary.head, affinity: primary.headAffinity ?? "after" };
            } else value = mapViewAnchor(value, document.revision, document.change);
            vertical = mapViewAnchor(vertical, document.revision, document.change);
            notifications.batch(() => {
                if (!sameSelectionSet(selected.set, viewState().selectionSet)) view.setSelections(document.revision, selected.set.ranges, selected.set.primary);
                if (regions) view.folding.setRanges(currentFolds(), regions);
                if (currentFolds() !== folds) restoredFolds = currentFolds();
                reveal = undefined;
                setScroll(scroll);
                if (value) restoredHorizontal = horizontalAnchor = { ...value };
                if (vertical) anchor = { ...vertical, leftRemainder: left - (vertical.offset - document.buffer.offsetAt(document.buffer.lineAt(vertical.offset))) * columnWidth };
            });
            return Object.freeze({ selection: selected.source, foldsRestored: regions !== undefined,
                horizontalAnchorRestored: !!value, verticalAnchorRestored: !!vertical });
        },
        revealOffset: (offset: number, options: RevealOptions = {}) => {
            if (disposed || !live()) return; const document = workspace.document(documentId); document.buffer.lineAt(offset);
            const horizontal = options.horizontal ?? "center", vertical = options.vertical ?? "center", affinity = options.affinity ?? "after";
            if (horizontal !== "center" && horizontal !== "nearest"
                || vertical !== "center" && vertical !== "nearest" && vertical !== "center-if-outside"
                || affinity !== "after" && affinity !== "before") throw new RangeError("Invalid reveal options.");
            view.folding.reveal(currentFolds(), offset);
            anchor = undefined; horizontalAnchor = undefined; fragmentPlacement = undefined;
            reveal = { revision: document.revision, foldGeneration: currentFolds().generation, offset, horizontal, vertical, affinity }; schedule();
        },
        revealRange: (from, to, align = "center-if-outside") => {
            if (disposed || !live()) return;
            validateRevealAlignment(align);
            const document = workspace.document(documentId);
            view.folding.reveal(currentFolds(), from, to);
            anchor = undefined; horizontalAnchor = undefined;
            reveal = { revision: document.revision, foldGeneration: currentFolds().generation, offset: from, end: to, align,
                horizontal: "nearest", vertical: "nearest", affinity: "after" };
            schedule();
        },
        getDiagnostics: () => Object.freeze({ ...activity(), selection: renderedSelection, renders, firstLine, lastLine, rows: rows.size, partialRows, textUnits, readUnits,
            visibleLines: previous ? currentFolds().index.visibleLineCount : 0, collapsedFolds: previous ? renderedIndex.collapsedCount : 0,
            visualRows: previous ? renderedIndex.visibleLineCount : 0, paddingRows: paddingRows.size, naturalLineHeight, lastRenderMs,
            scrollTop: top, scrollLeft: left, width, height, gutterWidth, lineHeight, columnWidth, verticalExtent: y.extent, horizontalExtent: x.extent,
            physicalHeight: y.physicalExtent, physicalWidth: x.physicalExtent }),
        dispose: () => {
            if (disposed) return; disposed = true; activitySnapshot = undefined; if (frame !== undefined) win.cancelAnimationFrame(frame); frame = undefined;
            releaseScrollbar(); pressedSummary = undefined;
            decorations.dispose();
            inputOwner?.detach(); inputOwner = undefined;
            settings = defaultSettings;
            observer.disconnect();
            listeners.abort();
            subscriptions.forEach(unsubscribe => unsubscribe());
            clearPresentation();
            reveal = undefined;
            horizontalAnchor = undefined;
            fragmentPlacement = undefined;
            commandRow.replaceChildren();
            root.replaceChildren();
            root.remove();
            publishGeometry(emptyViewport);
            for (const stop of observationStops) stop();
            if (!options.view) view.dispose();
        }
    });
    function clearPresentation(): void {
        minimap?.dispose();
        minimap = undefined;
        rulers.clear();
        clearCurrentLine();
        lineNumbers.clear();
        numbers.replaceChildren();
        foldButtons.clear();
        foldLayer.replaceChildren();
        layer.replaceChildren();
        rows.clear();
        rowSources.clear();
        rowSourceRevision = null;
        geometries.clear();
        dirtyRows.clear();
        visibleItems = [];
        paddingRows.clear();
        comparisonRows = undefined;
        renderedAlignmentId = null;
        renderedIndex = emptyIndex;
        renderedFoldGeneration = -1;
        renderedRevision = null;
        renderedSelection = null;
        renderedSelectionSet = null;
        previous = undefined;
        anchor = undefined;
        commandGeometry = undefined;
        painted = undefined;
        partialRows = 0;
        textUnits = 0;
        readUnits = 0;
    }
    const columnScroll = (column: number) => column < left || column > left + width ? Math.max(0, column - width / 2) : left;
    function withColumnRow<T>(line: number, column: number, work: (row: MeasuredRow) => T): T | undefined {
        if (disposed || !live()) return;
        const document = currentDocument();
        if (document?.revision !== renderedRevision || currentFolds().generation !== renderedFoldGeneration) return;
        if (!isIndex(line, document.buffer.lineCount) || !Number.isFinite(column)) throw new RangeError("Invalid navigation column.");
        if (!renderedIndex.hiddenBy(line)) return withRow(line, columnScroll(column), undefined, work);
    }
    function isCompleteLine(buffer: TextBuffer, line: number, span = buffer.line(line)): boolean {
        if (span.to - span.from <= 512 || rows.get(line)?.dataset.complete === "true") return true;
        // Rows just above the short-line limit can fit in a wide viewport.
        const end = line + 1 === buffer.lineCount ? buffer.length : buffer.offsetAt(line + 1);
        return end - span.from <= 514 && row(buffer, line, left, true).complete;
    }
    function measuredColumnSelection(line: number, anchor: number, head: number) {
        return withColumnRow(line, anchor, row => {
            const start = row.nearest(anchor);
            const sameFragment = row.complete || columnScroll(anchor) === columnScroll(head);
            const end = anchor === head ? start : sameFragment ? row.nearest(head) : withColumnRow(line, head, other => other.nearest(head));
            if (!end) return;
            let reaches = true;
            if (start.offset === end.offset && start.offset === lineContentEnd(workspace.document(documentId).buffer, line)) {
                const bounds = clientBox(root, false, gutterWidth);
                const endColumn = left + (start.left - bounds.left) / bounds.zoom;
                reaches = Math.min(anchor, head) <= endColumn + columnWidth / 2;
            }
            return { anchor: start.offset, anchorAffinity: start.affinity, head: end.offset, headAffinity: end.affinity, reaches };
        });
    }
    function columnSelections(anchor: number, head: number) {
        const document = currentDocument();
        const measured = (line: number) => measuredColumnSelection(line, anchor, head);
        if (!fixedPitch || !document || document.revision !== renderedRevision) return measured;
        const widths = new Map<string, boolean>();
        // Bold or colored text can keep the same cell grid. Measure each class once per projection.
        function preservesCells(name: string) {
            const known = widths.get(name);
            if (known !== undefined) return known;
            const sample = owner.createElement("div");
            sample.className = "st-viewport-row";
            const styled = owner.createElement("span");
            styled.className = name;
            const letters = owner.createTextNode(Array.from({ length: 95 }, (_, i) => String.fromCharCode(i + 32)).join(""));
            styled.append(letters);
            const tail = owner.createTextNode("x");
            sample.append(styled, tail);
            commandMeasure.append(sample);
            root.append(commandMeasure);
            try {
                const style = win.getComputedStyle(styled);
                const range = owner.createRange();
                const origin = sample.getBoundingClientRect().left;
                const width = columnWidth * cssZoom(root);
                let same = style.fontVariantLigatures === "none" && style.direction === "ltr";
                for (let i = 0; same && i <= letters.length; i++) {
                    if (i === letters.length) range.selectNodeContents(tail);
                    else {
                        range.setStart(letters, i);
                        range.setEnd(letters, i + 1);
                    }
                    const box = range.getBoundingClientRect();
                    same = Math.abs(box.left - origin - i * width) < .1 && Math.abs(box.width - width) < .1;
                }
                widths.set(name, same);
                return same;
            } finally {
                sample.remove();
                commandMeasure.remove();
            }
        }
        const position = (column: number, from: number, to: number) => {
            const cell = (column - padding) / columnWidth;
            const offset = Math.max(from, Math.min(to, from + Math.ceil(cell - .5)));
            const affinity: Affinity = offset > from && (offset === to || offset - from > cell) ? "before" : "after";
            return { offset, affinity };
        };
        return (line: number) => {
            const span = document.buffer.line(line);
            if (span.to - span.from > 512) return measured(line);
            const text = span.text;
            if (/[^ -~]/.test(text)) return measured(line);
            const presented = { documentId, revision: document.revision, line, lineStart: span.from,
                from: span.from, to: span.to, text };
            if (decorations.lineClasses(presented)) return measured(line);
            let end = span.from;
            for (const mark of decorations.present(presented, false, true)) {
                if (mark.before || mark.afterLine || mark.properties || mark.from < end || !preservesCells(mark.className)) {
                    return measured(line);
                }
                end = mark.to;
            }
            const start = position(anchor, span.from, span.to);
            const finish = position(head, span.from, span.to);
            const reaches = Math.min(anchor, head) <= padding + (span.to - span.from + .5) * columnWidth;
            return { anchor: start.offset, anchorAffinity: start.affinity,
                head: finish.offset, headAffinity: finish.affinity, reaches };
        };
    }
    const navigation = Object.freeze<ViewportNavigation>({
        fixedPitch: () => fixedPitch,
        horizontalPoint(buffer, range, direction, extend) {
            const collapse = !extend && range.anchor !== range.head;
            const leftward = direction < 0;
            const low = Math.min(range.anchor, range.head);
            let offset = range.head;
            if (collapse) offset = leftward ? low : Math.max(range.anchor, range.head);
            const line = buffer.lineAt(offset);
            const span = buffer.line(line);
            const affinity = leftward ? "after" : "before";
            if (!collapse && (leftward ? offset === span.from : offset >= span.to)) {
                const index = currentFolds().index;
                const next = index.rowAt(line) + direction;
                if (next < 0 || next >= index.visibleLineCount) return { offset: leftward ? span.from : span.to, affinity };
                const neighbor = index.lineAt(next);
                return { offset: leftward ? lineContentEnd(buffer, neighbor) : buffer.offsetAt(neighbor),
                    affinity: leftward ? "before" : "after" };
            }
            if (!isCompleteLine(buffer, line, span)) return;
            if (collapse && !leftward && low < span.from && !isCompleteLine(buffer, buffer.lineAt(low))) return;
            // The interior CRLF position paints at the content end.
            if (offset > span.to) return { offset: span.to, affinity };
            const local = localAsciiGraphemePoint(buffer, offset);
            if (local) {
                if (!collapse) offset = (leftward ? local.preceding : local.following)!;
                return { offset, affinity };
            }
            const stops = graphemeBoundaries(span.text.replaceAll("\r", "␍"));
            const column = offset - span.from;
            const ceil = partitionPoint(stops.length, index => stops[index]! < column);
            const exact = stops[ceil] === column;
            if (collapse) {
                const edge = !leftward && !exact ? ceil - 1 : ceil;
                return { offset: span.from + stops[edge]!, affinity };
            }
            const next = leftward ? ceil - 1 : ceil + Number(exact);
            const insideAffinity = leftward ? "before" : "after";
            return { offset: span.from + stops[next]!, affinity: exact ? affinity : insideAffinity };
        },
        columnAt: (offset: number, affinity: Affinity = "after") => {
            if (disposed || !live()) return;
            const document = currentDocument();
            if (document?.revision !== renderedRevision || currentFolds().generation !== renderedFoldGeneration) return;
            const visible = coordinates(offset, affinity), rectangle = clientBox(root, false, gutterWidth);
            if (visible) return (visible.left - rectangle.left) / rectangle.zoom + left;
            const originalLine = document.buffer.lineAt(offset), hidden = renderedIndex.hiddenBy(originalLine), line = hidden?.lineFrom ?? originalLine;
            const projected = hidden ? row(document.buffer, line).to : offset, scroll = Math.max(0, padding + (projected - document.buffer.offsetAt(line)) * columnWidth - width / 2);
            return withRow(line, scroll, projected, measured => { const point = measured.point(projected, affinity); return point && (point.left - rectangle.left) / rectangle.zoom + left; });
        },
        caretAtColumn: (line, column) => withColumnRow(line, column, row => row.nearest(column)),
        columnSelections,
        visualRowAt: line => renderedIndex.rowAt(line),
        columnDragLine: (localY, originLine) => {
            const row = visualRowAtY(localY);
            // In comparison padding, stop at the last source row crossed from the origin.
            return "nextLine" in renderedIndex ? renderedIndex.nextLine(row, row < renderedIndex.rowAt(originLine) ? 1 : -1) : renderedIndex.lineAt(row);
        },
        navigationLine: (line, direction, count, page) => {
            if (!isPositiveInteger(count)) throw new RangeError("Invalid row navigation.");
            const index = page ? renderedIndex : currentFolds().index, at = Math.max(0, Math.min(index.visibleLineCount - 1, index.rowAt(line) + direction * count));
            return "nextLine" in index ? index.nextLine(at, direction) : index.lineAt(at);
        }
    });
    return Object.freeze({ viewport, navigation, setComparisonRows });
}
