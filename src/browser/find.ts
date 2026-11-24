import { LiteralSearch } from "../core/search.ts";
import type { TextEditor } from "./text-editor.ts";
import type { DocumentSnapshot, DocumentView, EditResult, TabTarget, Workspace } from "../core/workspace.ts";
import { unchangedPositionEdges } from "../core/positions.ts";
import { FindIndex } from "../core/find-index.ts";
import { LiteralFindRepair } from "./find-index.ts";
import { createLiteralFindBackend, createFindReplacementPlan } from "../core/find.ts";
import type { FindBackend, FindQueryCapture, FindSearchCursor, FindPlanCursor, FindPlanStep } from "../core/find.ts";
import type { Observable } from "../core/observable.ts";
import type { SearchMatch, SearchStep } from "../core/search.ts";
import type { SelectionSet } from "../core/selections.ts";
import { Store } from "../core/observable.ts";
import { createCooperativeRunner } from "./cooperative-runner.ts";
import { visibleFindMatch } from "./find-preview.ts";
import type { TextViewport } from "./viewport.ts";
import type { DecorationLayers } from "./decoration-layers.ts";
const literalBudget = Object.freeze({ units: 4096, matches: 1024, calls: 32 });
export type FindFlags = Readonly<{ wholeWord?: boolean; matchCase?: boolean; regularExpression?: boolean }>;
export type FindControllerOptions = Readonly<{ regularExpressionBackend?: FindBackend; regularExpressionDelayMs?: number; highlightMatches?: boolean }>;
type FindEvents = Pick<EventTarget, "addEventListener" | "removeEventListener">;
/** View operations consumed by find. A mounted TextEditor satisfies this contract directly. */
export type FindHost = Readonly<{
    view: DocumentView;
    signal?: AbortSignal;
    decorations?: DecorationLayers;
    element: Readonly<{ ownerDocument: FindEvents & Readonly<{ defaultView: Readonly<{
        performance: Pick<Performance, "now">;
        setTimeout: (work: () => void, delay: number) => number; clearTimeout: (timer: number) => void;
    }> | null }> }>;
    getSnapshot: () => Pick<ReturnType<TextEditor["getSnapshot"]>, "readOnlyReason">;
    onEditIntent: TextEditor["onEditIntent"];
    activity: () => Readonly<{ disposed: boolean; composing: boolean }>;
    viewport: Pick<TextEditor["viewport"], "revealRange">;
    focus: () => void;
}>;
/** Stable cause of the last published notice, independent of its display message. */
export type FindReason = "editing-unavailable" | "composition-active" | "backend-unavailable" | "search-failed"
    | "replacement-failed" | "view-unavailable" | "cancelled" | "replaced" | Extract<EditResult, { applied: false }>["reason"];
export type FindSnapshot = Readonly<{ query: string; wholeWord: boolean; matchCase: boolean; regularExpression: boolean; revision: number; status: "idle" | "searching" | "ready" | "replacing" | "failed" | "cancelled" | "expired" | "disposed";
    count: number; scanned: number; length: number; retained: boolean; current: number | null; wrappedTo: "start" | "end" | null; matchesVersion: number; reason: FindReason | null; message: string }>;
export type FindDiagnostics = Readonly<{ maxScanStepMs: number; replaceTransactionMs: number }>;
export type FindController = Observable<FindSnapshot> & Readonly<{
    getDiagnostics: () => FindDiagnostics;
    matchesIn: (from: number, to: number, capture?: FindSnapshot) => readonly SearchMatch[];
    setQuery: (query: string, options?: Readonly<{ preview?: boolean }>) => void;
    setFlags: (flags: FindFlags) => void;
    acceptPreview: () => boolean;
    next: (direction?: 1 | -1, options?: Readonly<{ whenReady?: boolean }>) => boolean;
    replaceCurrent: (replacement: string) => boolean; replaceAll: (replacement: string, options?: Readonly<{ focusEditor?: boolean }>) => void; cancel: () => void; dispose: () => void }>;
// A notice is replaced atomically; progress-only patches retain both fields.
type FindPatch = Partial<Omit<FindSnapshot, "reason" | "message">> &
    (Pick<FindSnapshot, "reason" | "message"> | { reason?: never; message?: never });
function isAsync<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
    return value !== null && (typeof value === "object" || typeof value === "function") && typeof (value as PromiseLike<T>).then === "function";
}

/** Host-rendered find UI; scanning/planning yield, while replacement uses one captured transaction. */
export function createFindController(editor: TextEditor, options: FindControllerOptions = {}): FindController {
    return findForView(editor.workspace, editor.tab, editor, options, editor.viewport);
}

export function findForView(workspace: Workspace, target: TabTarget | undefined, editor: FindHost, options: FindControllerOptions = {}, viewport?: TextViewport): FindController {
    const backend = options.regularExpressionBackend, regexDelay = options.regularExpressionDelayMs ?? 80;
    if (!Number.isFinite(regexDelay) || regexDelay < 0 || regexDelay > 1000) throw new RangeError("Invalid regular-expression query delay.");
    if (editor.activity().disposed || !workspace.ownsDocumentView(editor.view, target)) throw new Error("Find requires the captured document view.");
    const documentId = editor.view.documentId, resource = workspace.resourceForDocument(documentId), lease = workspace.acquire(resource.id), owner = editor.element.ownerDocument, win = owner.defaultView!;
    const viewSnapshot = () => editor.view.getSnapshot();
    const currentSelection = () => viewSnapshot().selectionSet;
    const readDocument = () => workspace.document(documentId);
    const scope = workspace.createNotificationScope(), initial = readDocument();
    const store = new Store<FindSnapshot>(Object.freeze({ query: "", wholeWord: false, matchCase: true, regularExpression: false, revision: initial.revision, status: "idle", count: 0, scanned: 0, length: initial.buffer.length,
        retained: false, current: null, wrappedTo: null, matchesVersion: 0, reason: null, message: "" }), scope);
    const runner = createCooperativeRunner(win);
    let disposed = false, cursor: FindSearchCursor | undefined, planCursor: FindPlanCursor | undefined, generation = 0, focusGeneration = 0;
    let navigatedMatch: Readonly<{ index: number; selectionSet: SelectionSet }> | undefined;
    let replacedZero: Readonly<{ revision: number; head: number; selectionSet: SelectionSet }> | undefined;
    let advanceAfterReplace: SelectionSet | undefined;
    let focusOrigin: Element | null | undefined;
    let pendingNext: { direction: 1 | -1; selection: SelectionSet; origin: Element | null | undefined } | undefined;
    let pendingPreview: { selection: SelectionSet; followSelected: boolean; scrollUnchanged: () => boolean; listeners: AbortController } | undefined;
    let previewed: { index: number; selection: SelectionSet } | undefined;
    const cancelPreview = () => { pendingPreview?.listeners.abort(); pendingPreview = undefined; };
    let stopPlanAuthority: (() => void) | undefined;
    let matches = new FindIndex(), count = 0, navigationTo = 0, observed = initial;
    let pendingRepair: LiteralFindRepair | undefined;
    let literal: { document: DocumentSnapshot; index: FindIndex; query: string; wholeWord: boolean; matchCase: boolean } | undefined;
    let edges: { prefix: number; suffix: number } | undefined;
    const literalBackend = createLiteralFindBackend(() => matches, literalBudget.units, literalBudget.matches);
    const backendFor = (regularExpression: boolean) => regularExpression ? backend : literalBackend;
    const disposeBackends = () => { literalBackend.dispose(); backend?.dispose(); };
    let scanMaximum = 0, replaceTransactionMs = 0;
    const sameOwner = (a: DocumentSnapshot, b: DocumentSnapshot) => a.id === b.id && a.resourceId === b.resourceId && a.key === b.key;
    const valid = () => !disposed && lease.active() && workspace.ownsDocumentView(editor.view, target)
        && workspace.observeDocument(documentId).getSnapshot() !== undefined && !editor.activity().disposed;
    const publish = (patch: FindPatch) => {
        const previous = store.get(), next = Object.freeze({ ...previous, ...patch });
        scope.publish(store, next);
        if (next.matchesVersion !== previous.matchesVersion || next.revision !== previous.revision) layer?.invalidate();
        else if (layer && next.current !== previous.current && valid()) {
            const buffer = readDocument().buffer;
            for (const ordinal of [previous.current, next.current]) if (ordinal !== null && ordinal < matches.count) {
                const range = matches.at(ordinal); layer.invalidate(buffer.lineAt(range.from), buffer.lineAt(range.to) + 1);
            }
        }
    };
    const stop = () => { generation++; runner.cancel();
        pendingRepair = undefined;
        const active = cursor, plan = planCursor, authority = stopPlanAuthority; cursor = undefined; planCursor = undefined; stopPlanAuthority = undefined;
        navigatedMatch = undefined; replacedZero = undefined; advanceAfterReplace = undefined;
        cancelPreview(); previewed = undefined; pendingNext = undefined;
        active?.dispose(); plan?.dispose(); authority?.(); };
    const reset = (patch: FindPatch) => {
        matches = new FindIndex(); count = 0; literal = undefined; edges = undefined; navigationTo = 0;
        publish({ ...patch, retained: false, count: 0, scanned: 0, current: null, wrappedTo: null, matchesVersion: store.get().matchesVersion + 1 });
    };
    const later = (work: () => void, delay = 0) => { runner.schedule(work, delay); };
    const offsetAt = (index: number) => matches.at(index).from;
    const endAt = (index: number) => matches.at(index).to;
    const indexAt = (offset: number) => matches.lowerBound(offset);
    const matchesRange = (index: number, from: number, to: number) => {
        const range = index < count ? matches.at(index) : undefined;
        return range?.from === from && range.to === to;
    };
    function selectionIndex(): number | null {
        const { anchor, head } = viewSnapshot().selection;
        const from = Math.min(anchor, head), index = indexAt(from);
        if (anchor !== head) return matchesRange(index, from, Math.max(anchor, head)) ? index : null;
        if (index < count && offsetAt(index) === head) return index;
        return index > 0 && head < endAt(index - 1) ? index - 1 : null;
    }
    const emptyMatches: readonly SearchMatch[] = Object.freeze([]);
    const matchesIn = (from: number, to: number, capture = store.get()): readonly SearchMatch[] => {
        if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) throw new RangeError("Invalid match range.");
        const state = store.get();
        if (!valid() || capture.revision !== state.revision || capture.matchesVersion !== state.matchesVersion
            || readDocument().revision !== state.revision) return emptyMatches;
        if (to > state.length) throw new RangeError("Match range exceeds document length.");
        return matches.matchesIn(from, to);
    };
    const layer = options.highlightMatches === false ? undefined : editor.decorations?.addProvider({ name: "find matches", order: 60, minimap: false, provide: line => {
        const state = store.get();
        if (!state.count || state.revision !== line.revision) return [];
        const buffer = readDocument().buffer;
        const next = line.line + 1 < buffer.lineCount ? buffer.offsetAt(line.line + 1) : line.to;
        // CR and LF share a painted edge. Include their raw positions only at the real end of this line.
        const ending = next > line.to && next - line.to <= 2 && /^\r?\n$/.test(buffer.slice(line.to, next));
        const ranges = matchesIn(line.from, ending ? next : line.to);
        const end = ending || line.from === line.to ? [] : matchesIn(line.to, line.to);
        const selected = state.current === null ? undefined : matches.at(state.current);
        return [...ranges, ...end].map(range => ({ ...(ending && range.from >= line.to ? { from: line.to, to: line.to } : range), className: "st-search-match",
            ...(selected?.from === range.from && selected.to === range.to && { properties: { "--st-search-border": "var(--st-search-current-border, #ffe494)" } }) }));
    } });
    const canEdit = () => { const state = resource.getSnapshot(); return editor.getSnapshot().readOnlyReason === null && state.state === "ready" && state.metadata.capabilities.edit.includes("human") && state.metadata.editLock === null; };
    const observePlanAuthority = (token: number) => { stopPlanAuthority = resource.metadata.subscribe(() => {
        if (token !== generation || canEdit()) return;
        stop(); publish({ status: "ready", reason: "editing-unavailable", message: "Replacement cancelled because editing became unavailable." });
    }); };
    const capture = (query: string, wholeWord: boolean, matchCase: boolean): FindQueryCapture => {
        const document = readDocument(); return Object.freeze({ documentId, revision: document.revision, buffer: document.buffer, query, wholeWord, matchCase });
    };
    const failed = (error: unknown, token: number, planning = false, reason: FindReason = planning ? "replacement-failed" : "search-failed") => {
        if (token !== generation || disposed) return;
        stop(); const message = error instanceof Error && error.message.length <= 256 ? error.message : "Search is unavailable; editing remains available.";
        if (planning) publish({ status: "ready", reason, message });
        else reset({ status: "failed", reason, message });
    };
    const expire = () => {
        disposeBackends(); reset({ status: "expired", reason: "view-unavailable", message: "View is unavailable." });
    };
    function restart(query: string, wholeWord = store.get().wholeWord, matchCase = store.get().matchCase, regularExpression = store.get().regularExpression, retain = false): void {
        stop();
        if (!valid()) { expire(); return; }
        const document = readDocument(), token = generation;
        scanMaximum = 0;
        let repair: LiteralFindRepair | undefined;
        if (retain && literal && !regularExpression && literal.query === query && literal.wholeWord === wholeWord && literal.matchCase === matchCase
            && sameOwner(literal.document, document) && sameOwner(observed, document)) {
            const change = document.change, proof = document.buffer === observed.buffer ? { prefix: observed.buffer.length, suffix: observed.buffer.length }
                : change?.previousRevision === observed.revision && change.mapping.oldLength === observed.buffer.length && change.mapping.newLength === document.buffer.length
                    ? unchangedPositionEdges(change.mapping) : undefined;
            if (proof) {
                if (document.buffer === literal.document.buffer) {
                    matches = literal.index; count = matches.count; literal.document = document; edges = undefined; observed = document; navigationTo = document.buffer.length;
                    publish({ revision: document.revision, length: document.buffer.length, retained: false, status: "ready", count, scanned: document.buffer.length,
                        matchesVersion: store.get().matchesVersion + 1, current: null, wrappedTo: null, reason: null, message: "" }); return;
                }
                const prefix = Math.min(edges?.prefix ?? proof.prefix, proof.prefix, literal.document.buffer.length, document.buffer.length);
                edges = { prefix, suffix: Math.min(edges?.suffix ?? proof.suffix, proof.suffix, literal.document.buffer.length - prefix, document.buffer.length - prefix) };
                repair = new LiteralFindRepair(document.buffer, query, { wholeWord, matchCase }, literal.index, literal.document.buffer.length, edges);
            }
        }
        observed = document;
        const patch = { query, wholeWord, matchCase, regularExpression, revision: document.revision, length: document.buffer.length, reason: null, message: "" };
        if (repair) {
            pendingRepair = repair;
            matches = repair.index; count = matches.count; navigationTo = repair.start;
            publish({ ...patch, status: "searching", retained: true, count, scanned: repair.start, current: null, wrappedTo: null, matchesVersion: store.get().matchesVersion + 1 });
        } else reset({ ...patch, status: query ? "searching" : "idle" });
        if (!query) return;
        const initialSelection = currentSelection();
        let nextLiteral: ((units?: number) => SearchStep) | undefined;
        try {
            if (regularExpression && !backend) throw new Error("Regular-expression search is unavailable in this host.");
            let created: FindSearchCursor;
            if (regularExpression) created = backend!.search(capture(query, wholeWord, matchCase));
            else if (repair) {
                const repairing = repair; let first = true;
                // A nearby anchor usually settles in one small slice; ambiguous suffixes
                // continue with the same bounded advances as a fresh literal scan.
                nextLiteral = (units = literalBudget.units) => { const small = first; first = false; return repairing.next(units, small ? 64 : literalBudget.matches); };
                created = { next: nextLiteral, dispose: () => repairing.dispose() };
            } else { const literal = literalBackend.search(capture(query, wholeWord, matchCase)); created = literal; nextLiteral = literal.next; }
            if (token !== generation) { created.dispose(); return; } cursor = created;
        } catch (error) { failed(error, token, false, regularExpression && !backend ? "backend-unavailable" : "search-failed"); return; }
        let advanced = false;
        const step = (beforePaint = false) => {
            if (token !== generation || !valid()) { if (token === generation) restart(query); return; }
            advanced = true;
            const started = win.performance.now(); let scanned = store.get().scanned;
            let current: number | null | undefined;
            // Start the next literal timer's wait during this bounded slice, rather than after it.
            if (!regularExpression && !beforePaint) later(step);
            const accept = (result: SearchStep, began: number, dispatchMs: number): boolean => {
                if (token !== generation) return false;
                if (!valid() || readDocument().revision !== document.revision) { restart(query); return false; }
                if (result.matches.length > 8192
                    || !Number.isSafeInteger(result.scanned) || result.scanned < scanned || result.scanned > document.buffer.length) throw new Error("Invalid search result.");
                for (const match of repair ? [] : result.matches) {
                    if (!Number.isSafeInteger(match.from) || !Number.isSafeInteger(match.to) || match.from < 0 || match.to < match.from || match.to > document.buffer.length
                        || count > 0 && (match.from < endAt(count - 1) || match.from === offsetAt(count - 1) && match.to === endAt(count - 1))) throw new Error("Invalid search range.");
                    matches.append(match); count++;
                }
                if (repair) {
                    const index = repair.index, ordinal = store.get().current;
                    if (index !== matches && ordinal !== null) current = index.lowerBound(matches.at(ordinal).from);
                    matches = index; count = index.count;
                    if (!repair.hasRetainedSuffix) navigationTo = Math.max(navigationTo, count ? endAt(count - 1) : 0);
                }
                scanned = result.scanned;
                scanMaximum = Math.max(scanMaximum, dispatchMs, win.performance.now() - began);
                if (result.done) {
                    const moved = initialSelection !== currentSelection();
                    if (!pendingPreview && (!retain || moved)) current = selectionIndex();
                    if (!regularExpression) runner.cancel();
                    const finished = cursor; cursor = undefined; finished?.dispose();
                    if (!regularExpression) { literal = { document, index: matches, query, wholeWord, matchCase }; edges = undefined; pendingRepair = undefined; }
                }
                return token === generation && valid();
            };
            const present = (result: SearchStep) => {
                // Transfer acknowledgements can advance diagnostics without changing visible progress.
                const state = store.get();
                if (result.done || count !== state.count || result.scanned !== state.scanned)
                    publish({ count, ...(current !== undefined && { current }), matchesVersion: state.matchesVersion + (count !== state.count ? 1 : 0), scanned: result.scanned, status: result.done ? "ready" : "searching", retained: !!repair && !result.done });
                if (result.done && token === generation) { finishPreview(); finishAdvance(); finishNext(); }
                if (!result.done && token === generation && regularExpression) later(step);
            };
            const receive = (result: SearchStep, asynchronous: boolean, dispatchMs: number) => {
                if (accept(result, asynchronous ? win.performance.now() : started, dispatchMs)) present(result);
            };
            try {
                if (nextLiteral) {
                    const advance = nextLiteral;
                    const result = runner.slice(() => { const began = win.performance.now(), value = advance(beforePaint ? 512 : undefined); return accept(value, began, 0) ? value : undefined; },
                        value => !!value && !value.done && token === generation && valid(), beforePaint ? 1 : literalBudget.calls);
                    if (result && token === generation && valid()) present(result);
                } else {
                    const result = cursor!.next(), dispatchMs = win.performance.now() - started;
                    if (isAsync(result)) void Promise.resolve(result).then(value => { try { receive(value, true, dispatchMs); } catch (error) { failed(error, token); } }, error => failed(error, token));
                    else receive(result, false, 0);
                }
            } catch (error) { failed(error, token); }
        };
        // Coalesce pattern typing before a host worker starts; later steps still yield normally.
        if (token === generation) later(step, regularExpression ? regexDelay : 0);
        // Settle nearby matches before the browser paints. The timer owns all further work.
        if (repair) queueMicrotask(() => { if (!advanced && token === generation) step(true); });
    }
    const replacedHere = () => {
        if (!replacedZero || replacedZero.revision !== store.get().revision) return false;
        const selected = viewSnapshot(); return selected.selectionSet === replacedZero.selectionSet && selected.selection.anchor === replacedZero.head && selected.selection.head === replacedZero.head;
    };
    const currentRange = (): SearchMatch | undefined => {
        const state = store.get(); if (!valid() || state.status !== "ready" && !(state.status === "searching" && state.retained) || state.revision !== readDocument().revision) return undefined;
        const selected = viewSnapshot().selection, low = Math.min(selected.anchor, selected.head), high = Math.max(selected.anchor, selected.head);
        if (!state.query) return undefined;
        const index = indexAt(low);
        if (matchesRange(index, low, high) && !(low === high && replacedHere())) return { from: low, to: high };
        if (state.status !== "ready") return undefined;
        // A manually selected overlapping regex range is validated by the captured backend plan.
        if (state.regularExpression) return high > low && (index < count && offsetAt(index) < high && endAt(index) > low
            || index > 0 && endAt(index - 1) > low) ? { from: low, to: high } : undefined;
        if (state.wholeWord) return undefined;
        const buffer = readDocument().buffer;
        if (state.matchCase && !state.query.includes("\n")) return high - low === state.query.length && buffer.slice(low, high) === state.query ? { from: low, to: high } : undefined;
        // Recheck a manually selected overlap using the same newline and case rules as the index.
        if (high - low < Math.ceil(state.query.length / 2) || high - low > state.query.length * 2) return undefined;
        const selectedSearch = new LiteralSearch(buffer, state.query, { from: low, to: high, matchCase: state.matchCase, lineEndings: "equivalent" });
        try { const match = selectedSearch.next(high - low + 3, 1).matches[0]; return match?.from === low && match.to === high ? match : undefined; }
        finally { selectedSearch.dispose(); }
    };
    function nextMatch(direction: 1 | -1): { index: number; wrappedTo: FindSnapshot["wrappedTo"] } | undefined {
        const state = store.get();
        if (state.status !== "ready" && !(state.status === "searching" && state.retained) || !count) return;
        const selection = viewSnapshot(), selected = selection.selection, bound = direction === 1 ? Math.max(selected.anchor, selected.head) : Math.min(selected.anchor, selected.head);
        let low = indexAt(bound);
        if (previewed?.selection === selection.selectionSet) low = previewed.index;
        else if (direction === 1 && low < count && offsetAt(low) === bound && endAt(low) === bound
            && (navigatedMatch?.index === low && navigatedMatch.selectionSet === selection.selectionSet || replacedHere())) low++;
        const raw = direction === 1 ? low : low - 1;
        if (state.status !== "ready" && (raw < 0 || raw >= count)) return;
        if (state.status !== "ready") {
            if (pendingRepair?.hasRetainedSuffix && raw >= pendingRepair.prefixCount) {
                if (bound < pendingRepair.suffixStart) return;
            } else if (direction === -1 && bound > navigationTo) return;
        }
        return { index: (raw + count) % count, wrappedTo: raw < 0 ? "end" : raw >= count ? "start" : null };
    }
    function selectMatch(index: number, clearNotice: boolean, wrappedTo: FindSnapshot["wrappedTo"] = null): boolean {
        const { from, to } = matches.at(index);
        const selected = scope.batch(() => {
            if (!editor.view.setSelection(store.get().revision, { anchor: from, head: to })) return false;
            previewed = undefined;
            navigatedMatch = { index, selectionSet: currentSelection() }; replacedZero = undefined;
            publish({ current: index, wrappedTo, ...(clearNotice && { reason: null, message: "" }) });
            return true;
        });
        if (!selected) return false;
        editor.viewport.revealRange(from, to); return true;
    }
    function finishPreview(): void {
        const preview = pendingPreview;
        if (!preview) return;
        const current = () => valid() && preview.scrollUnchanged() && !editor.activity().composing && currentSelection() === preview.selection;
        if (!count || !current()) { cancelPreview(); return; }
        const selected = preview.selection.ranges[preview.selection.primary]!;
        const start = Math.min(selected.anchor, selected.head), preferred = indexAt(start) % count;
        if (preview.followSelected && !pendingNext && offsetAt(preferred) === start) {
            cancelPreview(); selectMatch(preferred, true); return;
        }
        const visible = viewport && visibleFindMatch(viewport, matches, preferred), index = visible ?? preferred;
        // Flushing painted fragments can notify a host, which may replace the search or the view.
        if (pendingPreview !== preview) return;
        cancelPreview();
        if (!current()) return;
        previewed = { index, selection: preview.selection }; publish({ current: index });
        const match = matches.at(index);
        editor.viewport.revealRange(match.from, match.to, visible === undefined ? "center-if-outside" : "nearest");
    }
    function capturePreview(previousSelection?: SelectionSet): void {
        if (options.highlightMatches === false || store.get().status !== "searching") return;
        const listeners = new AbortController(), events = { signal: listeners.signal, passive: true };
        const root = viewport?.element, top = root?.scrollTop, left = root?.scrollLeft;
        const scrollUnchanged = () => root?.scrollTop === top && root?.scrollLeft === left;
        captureFocus();
        const selection = currentSelection();
        pendingPreview = { selection, followSelected: previousSelection === selection, scrollUnchanged, listeners };
        owner.addEventListener("focusout", cancelPreview, events);
        if (root) {
            root.addEventListener("wheel", cancelPreview, events);
            root.addEventListener("scroll", () => { if (!scrollUnchanged()) cancelPreview(); }, events);
            root.ownerDocument.defaultView!.addEventListener("blur", cancelPreview, events);
        }
    }
    function finishAdvance(): void {
        const selection = advanceAfterReplace;
        advanceAfterReplace = undefined;
        if (!selection || !valid() || selection !== currentSelection() || editor.activity().composing) return;
        const next = nextMatch(1);
        if (next) selectMatch(next.index, false);
    }
    function finishNext(): void {
        const pending = pendingNext;
        pendingNext = undefined;
        if (pending && valid() && pending.selection === currentSelection()
            && (!pending.origin || pending.origin.matches(":focus:not(:disabled)"))) next(pending.direction);
    }
    const next: FindController["next"] = (direction = 1, options) => {
        scope.assertWritable();
        pendingNext = undefined;
        if (!valid()) return false;
        if (editor.activity().composing) { publish({ reason: "composition-active", message: "Finish composition before navigating." }); return false; }
        const match = nextMatch(direction);
        if (!match && options?.whenReady && store.get().status === "searching") {
            pendingNext = { direction, selection: currentSelection(), origin: captureFocus() };
            return true;
        }
        cancelPreview();
        if (!match) return false;
        advanceAfterReplace = undefined;
        return selectMatch(match.index, true, match.wrappedTo);
    };
    function replacementAllowed(): boolean {
        if (!canEdit()) { publish({ reason: "editing-unavailable", message: "read-only" }); return false; }
        if (editor.activity().composing) { publish({ reason: "composition-active", message: "Finish composition before replacing." }); return false; }
        return true;
    }
    function planReplacement(state: FindSnapshot, replacement: string, range?: SearchMatch, focusEditor = false): boolean {
        const selectedBackend = backendFor(state.regularExpression), immediate = !!range && !state.regularExpression;
        if (!selectedBackend || !valid() || state.revision !== readDocument().revision) return false;
        if (!replacementAllowed()) return false;
        advanceAfterReplace = undefined;
        const request = capture(state.query, state.wholeWord, state.matchCase), positions = matches, total = range ? 1 : count;
        const selectionSet = currentSelection(), acceptPlan = createFindReplacementPlan(positions, total, range);
        // A synchronous literal replacement must leave an in-progress repair alive on a no-op.
        // Yielding plans cancel scans and retain authority until their captured commit.
        if (!immediate) stop();
        captureFocus();
        const token = generation, focusToken = focusGeneration; let committed = false;
        if (!immediate) { observePlanAuthority(token); publish({ status: "replacing", reason: null, message: "" }); }
        if (token !== generation) return false;
        try { const created = selectedBackend.replace(request, replacement, range); if (token !== generation) { created.dispose(); return false; } planCursor = created; }
        catch (error) { failed(error, token, true); return false; }
        const current = () => {
            if (token !== generation) return false;
            if (!valid() || readDocument().revision !== state.revision || currentSelection() !== selectionSet) { restart(state.query); return false; }
            const reason = !canEdit() ? "editing-unavailable" : editor.activity().composing ? "composition-active" : null;
            if (reason) { stop(); publish({ status: "ready", reason, message: "Replacement cancelled because editing became unavailable." }); return false; }
            return true;
        };
        const receive = (result: FindPlanStep) => {
            if (!current()) return;
            const edits = acceptPlan(result);
            if (!edits) { later(step); return; }
            const finished = planCursor; planCursor = undefined; finished?.dispose(); if (!current()) return;
            const head = range ? range.from + edits[0]!.insert.length : undefined, started = win.performance.now();
            const applied = workspace.edit({ documentId, expectedRevision: state.revision, origin: "human", edits, view: editor.view,
                ...(head === undefined ? {} : { selection: { anchor: head, head } }), history: { kind: "replace" } });
            committed = applied.applied;
            stopPlanAuthority?.(); stopPlanAuthority = undefined;
            if (!valid()) return;
            replaceTransactionMs = win.performance.now() - started;
            if (!applied.applied) { publish({ status: "ready", reason: applied.reason, message: applied.reason }); return; }
            if (!immediate && readDocument().revision === state.revision) publish({ status: "ready" });
            if (range && range.from === range.to && store.get().query === state.query && store.get().regularExpression && valid()) {
                replacedZero = { revision: readDocument().revision, head: head!, selectionSet: currentSelection() };
            }
            publish({ reason: "replaced", message: `Replaced ${total} ${total === 1 ? "match" : "matches"}.` });
            if (valid() && focusGeneration === focusToken) {
                if (head !== undefined) {
                    advanceAfterReplace = currentSelection();
                    if (store.get().status === "ready") finishAdvance();
                    else editor.viewport.revealRange(head, head);
                }
                if (focusEditor) editor.focus();
            }
        };
        const step = () => {
            if (!current()) return;
            try { const result = planCursor!.next();
                if (isAsync(result)) void Promise.resolve(result).then(value => { try { receive(value); } catch (error) { failed(error, token, true); } }, error => failed(error, token, true));
                else receive(result);
            } catch (error) { failed(error, token, true); }
        };
        if (immediate) { step(); return committed; }
        later(step); return true;
    }
    const replaceCurrent = (replacement: string): boolean => {
        scope.assertWritable();
        if (!valid()) return false;
        if (!replacementAllowed()) return false;
        if (previewed?.selection === currentSelection() && !selectMatch(previewed.index, true)) return false;
        const match = currentRange();
        return match ? planReplacement(store.get(), replacement, match) : next(1);
    };
    const replaceAll: FindController["replaceAll"] = (replacement, options) => {
        scope.assertWritable();
        const state = store.get(); if (!valid() || state.status !== "ready" || !count) return;
        planReplacement(state, replacement, undefined, options?.focusEditor);
    };
    // Disabling the command button can clear activeElement without a new focus choice.
    const cancelNavigation = () => { advanceAfterReplace = undefined; pendingNext = undefined; };
    const focusChanged = () => { focusGeneration++; cancelNavigation(); };
    function originBlurred(event: Event) {
        focusOrigin = undefined;
        cancelPreview();
        if ((event as FocusEvent).relatedTarget) focusChanged();
    }
    function captureFocus() {
        if (!viewport) return;
        const root = viewport.element.getRootNode() as Document | ShadowRoot;
        let active = root.activeElement ?? viewport.element.ownerDocument.activeElement;
        while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
        // Focus changes between shadow siblings do not reach the document.
        if (active !== focusOrigin) {
            focusOrigin?.removeEventListener("blur", originBlurred);
            focusOrigin = active;
            active?.addEventListener("blur", originBlurred, { once: true });
        }
        return active;
    }
    owner.addEventListener("focusin", focusChanged);
    const window = viewport?.element.ownerDocument.defaultView;
    window?.addEventListener("blur", focusChanged);
    const compositionStarted = () => {
        cancelNavigation();
        if (store.get().status !== "replacing") return;
        stop(); publish({ status: "ready", reason: "composition-active", message: "Replacement cancelled for composition." });
    };
    const editIntent = editor.onEditIntent(kind => { if (kind === "compositionstart") compositionStarted(); });
    const folds = editor.view.folding;
    let projection = folds.getSnapshot().index;
    const stopFolds = folds.subscribe(() => {
        const next = folds.getSnapshot().index;
        if ((pendingNext || pendingPreview || advanceAfterReplace) && !projection.sameProjection(next)) {
            cancelNavigation(); cancelPreview();
        }
        projection = next;
    });
    let lastSelection = currentSelection();
    const stopSelection = editor.view.subscribe(() => {
        const view = viewSnapshot(), state = store.get();
        if (view.selectionSet === lastSelection) return;
        lastSelection = view.selectionSet;
        if (navigatedMatch?.selectionSet === lastSelection) return;
        cancelPreview(); previewed = undefined;
        if (state.status !== "ready" || state.revision !== view.revision) return;
        const current = selectionIndex();
        if (current !== state.current || state.wrappedTo) publish({ current, wrappedTo: null });
    });
    const subscriptions = [stopSelection, () => owner.removeEventListener("focusin", focusChanged), () => window?.removeEventListener("blur", focusChanged),
        () => focusOrigin?.removeEventListener("blur", originBlurred), editIntent.dispose, stopFolds, workspace.observeDocument(documentId).subscribe(() => {
        const current = workspace.observeDocument(documentId).getSnapshot();
        if (current && sameOwner(observed, current) && current.revision === observed.revision && current.buffer === observed.buffer) return;
        if (store.get().status === "cancelled" && valid()) { observed = readDocument(); publish({ revision: observed.revision, length: observed.buffer.length }); }
        else { const state = store.get(); restart(state.query, state.wholeWord, state.matchCase, state.regularExpression, true); }
    })];
    if (target) subscriptions.push(workspace.tabs.subscribe(() => { if (!valid()) { stop(); expire(); } }));
    const dispose = () => {
        if (disposed) return;
        scope.assertWritable();
        disposed = true;
        editor.signal?.removeEventListener("abort", dispose);
        stop(); disposeBackends(); subscriptions.forEach(unsubscribe => unsubscribe());
        layer?.dispose(); lease.release();
        reset({ status: "disposed", query: "", length: 0, reason: null, message: "" });
    };
    editor.signal?.addEventListener("abort", dispose, { once: true });
    return Object.freeze({ ...store.observable, getDiagnostics: () => Object.freeze({ maxScanStepMs: scanMaximum, replaceTransactionMs }), matchesIn,
        setQuery: (query, queryOptions) => {
            scope.assertWritable(); if (disposed) return;
            const previous = store.get().query;
            const selected = navigatedMatch?.selectionSet ?? (pendingPreview?.followSelected ? pendingPreview.selection : undefined);
            const refinement = !!previous && (query.startsWith(previous) || previous.startsWith(query));
            restart(query);
            if (queryOptions?.preview) capturePreview(refinement ? selected : undefined);
        },
        setFlags: (flags: FindFlags) => {
            scope.assertWritable();
            const state = store.get(), wholeWord = flags.wholeWord ?? state.wholeWord, matchCase = flags.matchCase ?? state.matchCase, regularExpression = flags.regularExpression ?? state.regularExpression;
            if (disposed || wholeWord === state.wholeWord && matchCase === state.matchCase && regularExpression === state.regularExpression) return;
            const preview = pendingPreview ?? previewed;
            const refresh = preview && preview.selection === currentSelection();
            restart(state.query, wholeWord, matchCase, regularExpression);
            if (refresh) capturePreview();
        },
        acceptPreview: () => {
            scope.assertWritable();
            if (!previewed || !valid() || editor.activity().composing || store.get().status !== "ready"
                || previewed.selection !== currentSelection()) return false;
            return selectMatch(previewed.index, true);
        },
        next, replaceCurrent, replaceAll, cancel: () => { scope.assertWritable(); if (!disposed) { stop(); reset({ status: "cancelled", reason: "cancelled", message: "Search cancelled." }); } },
        dispose });
}
