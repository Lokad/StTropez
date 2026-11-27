import { done, failed as failure, refused, stale, type Outcome } from "../core/outcome.ts";
import type { TextEdit } from "../core/changes.ts";
import { onAbort } from "./listen.ts";
import { emptyList } from "../core/empty-list.ts";
import { invalidRange, isOffsetRange } from "../core/bounds.ts";
import { LiteralSearch } from "../core/search.ts";
import type { TextEditor, TextEditorActivity } from "./text-editor.ts";
import type { DocumentSnapshot, DocumentView, EditResult, Workspace } from "../core/workspace.ts";
import { unchangedPositionEdges } from "../core/positions.ts";
import { FindIndex } from "../core/find-index.ts";
import { LiteralFindRepair } from "./find-index.ts";
import { createFindReplacementPlan } from "../core/find.ts";
import type { FindBackend, FindQueryCapture, FindSearchCursor, FindPlanCursor, FindPlanStep } from "../core/find.ts";
import type { Observable } from "../core/observable.ts";
import { controllerObservable } from "./controller-observable.ts";
import type { SearchMatch, SearchStep } from "../core/search.ts";
import type { SelectionSet } from "../core/selections.ts";
import { Store } from "../core/observable.ts";
import { createCooperativeRunner } from "./cooperative-runner.ts";
import { indexedSelection, matchesRange, replacementRange, nextIndexedMatch } from "./find-navigation.ts";
import { visibleFindMatch } from "./find-preview.ts";
import { humanEditRefusal } from "./input-events.ts";
import type { TextViewport } from "./viewport.ts";
import type { DecorationLayers } from "./decoration-layers.ts";
const literalBudget = Object.freeze({ units: 4096, matches: 1024, calls: 32 });
type ReplacementRefusal = Exclude<EditResult, { status: "done" }>["reason"] | "composition-active";
const replacementMessages: Partial<Record<ReplacementRefusal, string>> = {
    "read-only": "This document is read-only.",
    "not-ready": "The document is unavailable.",
    "composition-active": "Finish composition before replacing."
};
/** Case, whole-word and regular-expression options for one query. */
export type FindFlags = Readonly<{ wholeWord?: boolean; matchCase?: boolean; regularExpression?: boolean }>;
/** Choose highlights, an optional regex backend and its query delay at construction. */
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
    activity: () => Pick<TextEditorActivity, "disposed" | "input">;
    viewport: Pick<TextEditor["viewport"], "revealRange">;
    focus: () => void;
}>;
/** Stable cause of the last published notice, independent of its display message. */
export type FindReason = ReplacementRefusal | "backend-unavailable" | "invalid-pattern" | "search-failed"
    | "replacement-failed" | "view-unavailable" | "cancelled" | "replaced";
type FindNotice = Readonly<{ reason: FindReason | null; message: string; replacedCount: number }>;
/** Current query, revision, match count and replacement notice. */
export type FindSnapshot = FindNotice & Readonly<{
    highlightMatches: boolean;
    query: string;
    wholeWord: boolean;
    matchCase: boolean;
    regularExpression: boolean;
    revision: number;
    status: "idle" | "searching" | "ready" | "replacing" | "failed" | "cancelled" | "expired" | "disposed";
    count: number;
    scanned: number;
    length: number;
    retained: boolean;
    current: number | null;
    wrappedTo: "start" | "end" | null;
    matchesVersion: number;
}>;
/** Maximum search step and last replacement transaction durations, in milliseconds. */
export type FindDiagnostics = Readonly<{ maxScanStepMs: number; replaceTransactionMs: number }>;
/** Immediate effect of a Find command. A queued operation publishes its final state to the controller. */
type FindAction = Outcome<"selected" | "replaced" | "queued">;
const selected = done("selected" as const);
const replaced = done("replaced" as const);
const queued = done("queued" as const);
/** Find and replace within one captured editor view and observe progress as matches arrive. */
export type FindController = Observable<FindSnapshot> & Readonly<{
    getDiagnostics: () => FindDiagnostics;
    matchesIn: (from: number, to: number, capture?: FindSnapshot) => readonly SearchMatch[];
    setQuery: (query: string, options?: Readonly<{ preview?: boolean }>) => void;
    setFlags: (flags: FindFlags) => void;
    setHighlightMatches: (visible: boolean) => void;
    acceptPreview: () => FindAction;
    next: (direction?: 1 | -1, options?: Readonly<{ whenReady?: boolean }>) => FindAction;
    replaceCurrent: (replacement: string) => FindAction; replaceAll: (replacement: string, options?: Readonly<{ focusEditor?: boolean }>) => FindAction; cancel: () => void; dispose: () => void }>;
// A progress update retains the entire previous notice.
type FindPatch = Partial<Omit<FindSnapshot, keyof FindNotice>> &
    (FindNotice | { [K in keyof FindNotice]?: never });
function notice(reason: FindReason | null, message: string, replacedCount = 0): FindNotice {
    return { reason, message, replacedCount };
}
function isAsync<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
    return typeof (value as PromiseLike<T> | null)?.then === "function";
}
const hasResults = (state: FindSnapshot) => state.status === "ready" || state.status === "searching" && state.retained;

/** Host-rendered find UI; scanning/planning yield, while replacement uses one captured transaction. */
export function createFindController(editor: TextEditor, options: FindControllerOptions = {}): FindController {
    return findForView(editor.workspace, editor, options, editor.viewport);
}

export function findForView(workspace: Workspace, editor: FindHost, options: FindControllerOptions = {}, viewport?: TextViewport): FindController {
    const backend = options.regularExpressionBackend, regexDelay = options.regularExpressionDelayMs ?? 80;
    if (!Number.isFinite(regexDelay) || regexDelay < 0 || regexDelay > 1000) invalidRange("regular-expression query delay");
    if (editor.activity().disposed || !workspace.ownsDocumentView(editor.view)) throw new Error("Find requires the captured document view.");
    const documentId = editor.view.documentId, resource = workspace.resource(documentId), lease = workspace.acquire(documentId), owner = editor.element.ownerDocument, win = owner.defaultView!;
    const viewSnapshot = () => editor.view.getSnapshot();
    const currentSelection = () => viewSnapshot().selectionSet;
    const readDocument = () => workspace.document(documentId);
    const documentChanges = workspace.observeDocument(documentId);
    const scope = workspace.createNotificationScope(), initial = readDocument();
    const noNotice = notice(null, "");
    const cancelledReplacement = notice("cancelled", "Replacement cancelled.");
    const store = new Store<FindSnapshot>(Object.freeze({ highlightMatches: options.highlightMatches !== false, query: "", wholeWord: false, matchCase: true, regularExpression: false, revision: initial.revision, status: "idle", count: 0, scanned: 0, length: initial.buffer.length,
        retained: false, current: null, wrappedTo: null, matchesVersion: 0, ...noNotice }), scope);
    const runner = createCooperativeRunner(win);
    let disposed = false, cursor: FindSearchCursor | undefined, planCursor: FindPlanCursor | undefined, generation = 0, focusGeneration = 0;
    let navigatedMatch: Readonly<{ index: number; selectionSet: SelectionSet }> | undefined;
    let replacedZero: Readonly<{ revision: number; head: number; selectionSet: SelectionSet }> | undefined;
    let advanceAfterReplace: SelectionSet | undefined;
    let focusOrigin: Element | null | undefined;
    let finishLiteral: (() => void) | undefined;
    let pendingNext: (() => void) | undefined;
    let pendingPreview: { selection: SelectionSet; followSelected: boolean; scrollUnchanged: () => boolean; listeners: AbortController } | undefined;
    let previewed: { index: number; selection: SelectionSet } | undefined;
    const cancelPreview = () => { pendingPreview?.listeners.abort(); pendingPreview = undefined; };
    let stopPlanAuthority: (() => void) | undefined;
    let matches = new FindIndex(), navigationTo = 0, observed = initial;
    let pendingRepair: LiteralFindRepair | undefined;
    let literal: { document: DocumentSnapshot; index: FindIndex; query: string; wholeWord: boolean; matchCase: boolean } | undefined;
    let edges: { prefix: number; suffix: number } | undefined;
    let scanMaximum = 0, replaceTransactionMs = 0;
    const sameOwner = (a: DocumentSnapshot, b: DocumentSnapshot) => a.id === b.id && a.key === b.key;
    const valid = () => !disposed && lease.active() && workspace.ownsDocumentView(editor.view)
        && documentChanges.getSnapshot() !== undefined && !editor.activity().disposed;
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
        finishLiteral = undefined;
        const active = cursor, plan = planCursor, authority = stopPlanAuthority; cursor = undefined; planCursor = undefined; stopPlanAuthority = undefined;
        navigatedMatch = undefined; replacedZero = undefined; advanceAfterReplace = undefined;
        cancelPreview(); previewed = undefined; pendingNext = undefined;
        active?.dispose(); plan?.dispose(); authority?.(); };
    function publishNewIndex(patch: FindPatch): void {
        publish({ ...patch, current: null, wrappedTo: null, matchesVersion: store.get().matchesVersion + 1 });
    }
    const reset = (patch: FindPatch) => {
        matches = new FindIndex(); literal = undefined; edges = undefined; navigationTo = 0;
        publishNewIndex({ ...patch, retained: false, count: 0, scanned: 0 });
    };
    const later = (work: () => void, delay = 0) => { runner.schedule(work, delay); };
    const selectionIndex = () => indexedSelection(matches, viewSnapshot().selection);
    const emptyMatches: readonly SearchMatch[] = emptyList;
    const matchesIn = (from: number, to: number, capture = store.get()): readonly SearchMatch[] => {
        if (!isOffsetRange(from, to)) invalidRange("match range");
        const state = store.get();
        if (!valid() || capture.revision !== state.revision || capture.matchesVersion !== state.matchesVersion
            || readDocument().revision !== state.revision) return emptyMatches;
        if (to > state.length) invalidRange("match range");
        return matches.matchesIn(from, to);
    };
    const addHighlights = () => editor.decorations?.addProvider({ order: 60, minimap: false, provide: line => {
        const state = store.get();
        if (!state.count || state.revision !== line.revision || !valid()) return emptyList;
        const doc = readDocument();
        if (doc.revision !== line.revision) return emptyList;
        const buffer = doc.buffer;
        const next = line.line + 1 < buffer.lineCount ? buffer.offsetAt(line.line + 1) : line.to;
        // CR and LF share a painted edge. Include their raw positions only at the real end of this line.
        const ending = next > line.to && next - line.to <= 2 && /^\r?\n$/.test(buffer.slice(line.to, next));
        const ranges = matches.matchesIn(line.from, ending ? next : line.to);
        const end = ending || line.from === line.to ? emptyList : matches.matchesIn(line.to, line.to);
        const selected = state.current === null ? undefined : matches.at(state.current);
        return [...ranges, ...end].map(range => ({
            ...(ending && range.from >= line.to ? { from: line.to, to: line.to } : range),
            className: selected?.from === range.from && selected.to === range.to
                ? "st-search-match st-search-current" : "st-search-match",
        }));
    } });
    let layer = store.get().highlightMatches ? addHighlights() : undefined;
    function refuseReplacement(reason: ReplacementRefusal, planning: boolean) {
        const message = replacementMessages[reason] ?? "Could not apply the replacement.";
        if (planning) {
            stop();
            publish({ status: "ready", ...notice(reason, "Replacement cancelled. " + message) });
        } else publish(notice(reason, message));
        return refused(reason);
    }
    function replacementRefusal(planning = false) {
        const metadata = resource.metadata.getSnapshot();
        const reason = metadata.state !== "ready" ? "not-ready" : editor.getSnapshot().readOnlyReason
            ?? humanEditRefusal(metadata) ?? (editor.activity().input === "composing" ? "composition-active" : null);
        return reason ? refuseReplacement(reason, planning) : undefined;
    }
    const observePlanAuthority = (token: number) => { stopPlanAuthority = resource.metadata.subscribe(() => {
        if (token === generation) replacementRefusal(true);
    }); };
    const capture = ({ query, wholeWord, matchCase }: Pick<FindQueryCapture, "query" | "wholeWord" | "matchCase">): FindQueryCapture => {
        const document = readDocument(); return Object.freeze({ documentId, revision: document.revision, buffer: document.buffer, query, wholeWord, matchCase });
    };
    const failed = (error: unknown, token: number, planning = false, reason: FindReason = planning ? "replacement-failed" : "search-failed") => {
        if (token !== generation || disposed) return;
        stop(); const message = error instanceof Error && error.message.length <= 256 ? error.message : "Search is unavailable; editing remains available.";
        const failure = notice(reason === "search-failed" && store.get().regularExpression && error instanceof SyntaxError
            ? "invalid-pattern" : reason, message);
        if (planning) publish({ status: "ready", ...failure });
        else reset({ status: "failed", ...failure });
    };
    const expire = () => {
        backend?.dispose(); reset({ status: "expired", ...notice("view-unavailable", "View is unavailable.") });
    };
    function restart(query: string, flags: Required<FindFlags> = store.get(), retain = false): void {
        const { wholeWord, matchCase, regularExpression } = flags;
        // A committing plan releases its cursor before the document publishes the edit.
        const notice = planCursor ? cancelledReplacement : noNotice;
        stop();
        if (!valid()) { expire(); return; }
        const document = readDocument(), token = generation;
        const patch = { query, wholeWord, matchCase, regularExpression, revision: document.revision, length: document.buffer.length, ...notice };
        scanMaximum = 0;
        let repair: LiteralFindRepair | undefined;
        if (retain && literal && !regularExpression && literal.query === query && literal.wholeWord === wholeWord && literal.matchCase === matchCase
            && sameOwner(literal.document, document) && sameOwner(observed, document)) {
            const change = document.change, proof = document.buffer === observed.buffer ? { prefix: observed.buffer.length, suffix: observed.buffer.length }
                : change?.previousRevision === observed.revision && change.mapping.oldLength === observed.buffer.length && change.mapping.newLength === document.buffer.length
                    ? unchangedPositionEdges(change.mapping) : undefined;
            if (proof) {
                if (document.buffer === literal.document.buffer) {
                    matches = literal.index; literal.document = document; edges = undefined; observed = document; navigationTo = document.buffer.length;
                    publishNewIndex({ ...patch, retained: false, status: "ready", count: matches.count, scanned: patch.length });
                    return;
                }
                const prefix = Math.min(edges?.prefix ?? proof.prefix, proof.prefix, literal.document.buffer.length, document.buffer.length);
                edges = { prefix, suffix: Math.min(edges?.suffix ?? proof.suffix, proof.suffix, literal.document.buffer.length - prefix, document.buffer.length - prefix) };
                repair = new LiteralFindRepair(document.buffer, query, { wholeWord, matchCase }, literal.index, literal.document.buffer.length, edges);
            }
        }
        observed = document;
        if (repair) {
            pendingRepair = repair;
            matches = repair.index; navigationTo = repair.start;
            publishNewIndex({ ...patch, status: "searching", retained: true, count: matches.count, scanned: repair.start });
        } else reset({ ...patch, status: query ? "searching" : "idle" });
        if (!query) return;
        const initialSelection = currentSelection();
        let nextLiteral: ((units?: number) => SearchStep) | undefined;
        try {
            if (regularExpression && !backend) throw new Error("Regular-expression search is unavailable in this host.");
            let created: FindSearchCursor;
            if (regularExpression) created = backend!.search(capture(patch));
            else {
                const search = repair ?? new LiteralSearch(document.buffer, query, { wholeWord, matchCase, lineEndings: "equivalent" });
                // Nearby repairs first try a small slice before the next paint.
                let matchLimit = repair ? 64 : literalBudget.matches;
                nextLiteral = (units = literalBudget.units) => {
                    const result = search.next(units, matchLimit);
                    matchLimit = literalBudget.matches;
                    return result;
                };
                created = { next: nextLiteral, dispose: () => search.dispose() };
            }
            if (token !== generation) { created.dispose(); return; } cursor = created;
        } catch (error) { failed(error, token, false, regularExpression && !backend ? "backend-unavailable" : "search-failed"); return; }
        let advanced = false;
        const step = (beforePaint = false, immediate = false) => {
            if (token !== generation || !valid()) { if (token === generation) restart(query); return; }
            advanced = true;
            const started = win.performance.now(); let scanned = store.get().scanned;
            let current: number | null | undefined;
            // Start the next literal timer's wait during this bounded slice, rather than after it.
            if (!regularExpression && !beforePaint && !immediate) later(step);
            const accept = (result: SearchStep, began: number, dispatchMs: number): boolean => {
                if (token !== generation) return false;
                if (!valid() || readDocument().revision !== document.revision) { restart(query); return false; }
                if (result.matches.length > 8192
                    || !isOffsetRange(scanned, result.scanned, document.buffer.length)) throw new Error("Invalid search result.");
                let previous = matches.count ? matches.at(matches.count - 1) : undefined;
                for (const match of repair ? [] : result.matches) {
                    if (!isOffsetRange(match.from, match.to, document.buffer.length)
                        || previous && (match.from < previous.to || match.from === previous.from && match.to === previous.to)) {
                        throw new Error("Invalid search range.");
                    }
                    matches.append(match);
                    previous = match;
                }
                if (repair) {
                    const index = repair.index, ordinal = store.get().current;
                    if (index !== matches && ordinal !== null) current = index.lowerBound(matches.at(ordinal).from);
                    matches = index;
                    if (!repair.hasRetainedSuffix) navigationTo = Math.max(navigationTo, matches.count ? matches.at(matches.count - 1).to : 0);
                }
                scanned = result.scanned;
                scanMaximum = Math.max(scanMaximum, dispatchMs, win.performance.now() - began);
                if (result.done) {
                    const moved = initialSelection !== currentSelection();
                    if (!pendingPreview && (!retain || moved)) current = selectionIndex();
                    if (!regularExpression) { runner.cancel(); finishLiteral = undefined; }
                    const finished = cursor; cursor = undefined; finished?.dispose();
                    if (!regularExpression) { literal = { document, index: matches, query, wholeWord, matchCase }; edges = undefined; pendingRepair = undefined; }
                }
                return token === generation && valid();
            };
            const present = (result: SearchStep) => {
                const count = matches.count;
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
                    const batch = () => {
                        const began = win.performance.now();
                        const value = advance(beforePaint ? 512 : undefined);
                        return accept(value, began, 0) ? value : undefined;
                    };
                    let result = immediate ? batch() : runner.slice(batch, value => !!value && !value.done,
                        beforePaint ? 1 : literalBudget.calls);
                    if (immediate) {
                        while (result && !result.done) result = batch();
                    }
                    if (result && token === generation && valid()) present(result);
                } else {
                    const result = cursor!.next(), dispatchMs = win.performance.now() - started;
                    if (isAsync(result)) void Promise.resolve(result)
                        .then(value => receive(value, true, dispatchMs)).catch(error => failed(error, token));
                    else receive(result, false, 0);
                }
            } catch (error) { failed(error, token); }
        };
        if (!regularExpression) finishLiteral = () => step(false, true);
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
        const state = store.get();
        if (!valid() || !hasResults(state) || state.revision !== readDocument().revision) return;
        return replacementRange(matches, state, readDocument().buffer, viewSnapshot().selection, replacedHere());
    };
    function nextMatch(direction: 1 | -1) {
        const state = store.get();
        if (!hasResults(state) || !matches.count) return;
        const { selectionSet, selection } = viewSnapshot();
        return nextIndexedMatch(matches, direction, selection,
            previewed?.selection === selectionSet ? previewed.index : undefined,
            navigatedMatch?.selectionSet === selectionSet ? navigatedMatch.index : undefined,
            replacedHere(), state.status === "ready", pendingRepair, navigationTo);
    }
    function selectMatch(index: number, clearNotice: boolean, wrappedTo: FindSnapshot["wrappedTo"] = null): boolean {
        const { from, to } = matches.at(index);
        const selected = scope.batch(() => {
            if (!editor.view.setSelection(store.get().revision, { anchor: from, head: to })) return false;
            previewed = undefined;
            navigatedMatch = { index, selectionSet: currentSelection() }; replacedZero = undefined;
            publish({ current: index, wrappedTo, ...(clearNotice && noNotice) });
            return true;
        });
        if (!selected) return false;
        editor.viewport.revealRange(from, to); return true;
    }
    function finishPreview(): void {
        const preview = pendingPreview;
        if (!preview) return;
        const current = () => valid() && preview.scrollUnchanged() && editor.activity().input !== "composing" && currentSelection() === preview.selection;
        if (!matches.count || !current()) { cancelPreview(); return; }
        const selected = preview.selection.ranges[preview.selection.primary]!;
        const start = Math.min(selected.anchor, selected.head), preferred = matches.lowerBound(start) % matches.count;
        if (preview.followSelected && !pendingNext && matches.at(preferred).from === start) {
            cancelPreview(); selectMatch(preferred, true); return;
        }
        const fold = projection.collapsedCount ? projection.hiddenBy(readDocument().buffer.lineAt(matches.at(preferred).from)) : undefined;
        const visible = viewport && visibleFindMatch(viewport, matches, preferred, fold?.lineFrom);
        const index = visible ?? preferred;
        // Flushing painted fragments can notify a host, which may replace the search or the view.
        if (pendingPreview !== preview) return;
        cancelPreview();
        if (!current()) return;
        previewed = { index, selection: preview.selection }; publish({ current: index });
        const match = matches.at(index);
        editor.viewport.revealRange(match.from, match.to, visible === undefined ? "center-if-outside" : "nearest");
    }
    function capturePreview(previousSelection?: SelectionSet): void {
        if (!store.get().highlightMatches || store.get().status !== "searching") return;
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
        if (!selection || !valid() || selection !== currentSelection() || editor.activity().input === "composing") return;
        const next = nextMatch(1);
        if (next) selectMatch(next.index, false);
    }
    function finishNext(): void {
        const navigate = pendingNext;
        pendingNext = undefined;
        navigate?.();
    }
    function acceptPreview(): FindAction {
        scope.assertWritable();
        if (!valid()) return stale;
        if (editor.activity().input === "composing") return refused("composition-active");
        if (!previewed || store.get().status !== "ready") return refused("no-preview");
        if (previewed.selection !== currentSelection()) return stale;
        return selectMatch(previewed.index, true) ? selected : stale;
    }
    const next: FindController["next"] = (direction = 1, options) => {
        scope.assertWritable();
        pendingNext = undefined;
        if (!valid()) return stale;
        if (editor.activity().input === "composing") {
            publish(notice("composition-active", "Finish composition before navigating."));
            return refused("composition-active");
        }
        const match = nextMatch(direction);
        if (!match && options?.whenReady && store.get().status === "searching") {
            const selection = currentSelection(), origin = captureFocus();
            let result: FindAction = queued;
            pendingNext = () => {
                if (!valid() || selection !== currentSelection() || origin !== captureFocus() || origin?.matches(":disabled")) {
                    result = stale;
                    return;
                }
                result = direction === 1 && acceptPreview().status === "done" ? selected : next(direction);
            };
            finishLiteral?.();
            return result;
        }
        cancelPreview();
        if (!match) return refused("no-match");
        advanceAfterReplace = undefined;
        return selectMatch(match.index, true, match.wrappedTo) ? selected : stale;
    };
    function planReplacement(state: FindSnapshot, replacement: string, range?: SearchMatch, focusEditor = false): FindAction {
        if (!valid() || state.revision !== readDocument().revision) return stale;
        if (state.regularExpression && !backend) return refused("backend-unavailable");
        const refusal = replacementRefusal();
        if (refusal) return refusal;
        advanceAfterReplace = undefined;
        const request = state.regularExpression ? capture(state) : undefined;
        const positions = matches, total = range ? 1 : matches.count;
        const selectionSet = currentSelection();
        // Regex replies may outlive this turn. A literal index is already local and validated.
        if (request) stop();
        captureFocus();
        const token = generation, focusToken = focusGeneration;
        const expired = () => {
            if (token !== generation) return stale;
            if (!valid() || readDocument().revision !== state.revision || currentSelection() !== selectionSet) {
                restart(state.query);
                return stale;
            }
            return replacementRefusal(true);
        };
        const commit = (edits: readonly TextEdit[]): FindAction => {
            const refusal = expired();
            if (refusal) return refusal;
            if (!edits.length) {
                stop();
                scope.batch(() => {
                    publish({ status: "ready" });
                    if (focusGeneration === focusToken) next(1);
                });
                return refused("no-change");
            }
            const head = range ? range.from + edits[0]!.insert.length : undefined, started = win.performance.now();
            const applied = workspace.edit({ documentId, expectedRevision: state.revision, origin: "human", edits, view: editor.view,
                ...(head === undefined ? {} : { selection: { anchor: head, head } }), history: { kind: "replace" } });
            stopPlanAuthority?.(); stopPlanAuthority = undefined;
            if (!valid()) return applied.status === "done" ? replaced : stale;
            replaceTransactionMs = win.performance.now() - started;
            if (applied.status !== "done") return refuseReplacement(applied.reason, true);
            if (request && readDocument().revision === state.revision) publish({ status: "ready" });
            if (range && range.from === range.to && store.get().query === state.query && store.get().regularExpression && valid()) {
                replacedZero = { revision: readDocument().revision, head: head!, selectionSet: currentSelection() };
            }
            publish(notice("replaced", `Replaced ${total} ${total === 1 ? "match" : "matches"}.`, total));
            if (valid() && focusGeneration === focusToken) {
                if (head !== undefined) {
                    advanceAfterReplace = currentSelection();
                    if (store.get().status === "ready") finishAdvance();
                    else editor.viewport.revealRange(head, head);
                }
                if (focusEditor) editor.focus();
            }
            return replaced;
        };
        if (!request) {
            try {
                const edits = Array.from({ length: total }, (_, index) => {
                    const { from, to } = range ?? positions.at(index);
                    return { from, to, insert: replacement };
                });
                return commit(edits);
            } catch (error) { failed(error, token, true); return failure(error); }
        }
        const unindexed = !!range && !matchesRange(matches, matches.lowerBound(range.from), range.from, range.to);
        const acceptPlan = createFindReplacementPlan(positions, total, range, unindexed);
        observePlanAuthority(token);
        publish({ status: "replacing", ...noNotice });
        if (token !== generation) return stale;
        try {
            const created = backend!.replace(request, replacement, range);
            if (token !== generation) { created.dispose(); return stale; }
            planCursor = created;
        } catch (error) { failed(error, token, true); return failure(error); }
        const receive = (result: FindPlanStep) => {
            if (expired()) return;
            const edits = acceptPlan(result);
            if (!edits) { later(step); return; }
            const finished = planCursor;
            planCursor = undefined;
            finished?.dispose();
            commit(edits);
        };
        const step = () => {
            if (expired()) return;
            try { const result = planCursor!.next();
                if (isAsync(result)) void Promise.resolve(result).then(receive).catch(error => failed(error, token, true));
                else receive(result);
            } catch (error) { failed(error, token, true); }
        };
        later(step);
        return queued;
    }
    const replaceCurrent = (replacement: string): FindAction => {
        scope.assertWritable();
        if (!valid()) return stale;
        const refusal = replacementRefusal();
        if (refusal) return refusal;
        if (previewed?.selection === currentSelection() && !selectMatch(previewed.index, true)) return stale;
        const match = currentRange();
        return match ? planReplacement(store.get(), replacement, match) : next(1);
    };
    const replaceAll: FindController["replaceAll"] = (replacement, options) => {
        scope.assertWritable();
        if (!valid()) return stale;
        const state = store.get();
        if (state.status !== "ready") return refused("not-ready");
        if (!matches.count) return refused("no-match");
        return planReplacement(state, replacement, undefined, options?.focusEditor);
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
        refuseReplacement("composition-active", true);
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
        if (state.revision !== view.revision) return;
        if (planCursor && state.status === "replacing") {
            stop();
            publish({ status: "ready", current: selectionIndex(), wrappedTo: null, ...cancelledReplacement });
            return;
        }
        if (state.status !== "ready") return;
        const current = selectionIndex();
        if (current !== state.current || state.wrappedTo) publish({ current, wrappedTo: null });
    });
    const subscriptions = [stopSelection, () => owner.removeEventListener("focusin", focusChanged), () => window?.removeEventListener("blur", focusChanged),
        () => focusOrigin?.removeEventListener("blur", originBlurred), editIntent.dispose, stopFolds, documentChanges.subscribe(() => {
        const current = documentChanges.getSnapshot();
        if (current && sameOwner(observed, current) && current.revision === observed.revision && current.buffer === observed.buffer) return;
        if (store.get().status === "cancelled" && valid()) { observed = readDocument(); publish({ revision: observed.revision, length: observed.buffer.length }); }
        else {
            const state = store.get();
            restart(state.query, state, true);
        }
    })];

    const dispose = () => {
        if (disposed) return;
        scope.assertWritable();
        disposed = true;
        editor.signal?.removeEventListener("abort", dispose);
        const notice = planCursor ? cancelledReplacement : noNotice;
        stop(); backend?.dispose(); subscriptions.forEach(unsubscribe => unsubscribe());
        layer?.dispose(); lease.release();
        reset({ status: "disposed", query: "", length: 0, ...notice });
        store.clearSnapshotListeners();
    };
    onAbort(editor.signal, dispose);
    return Object.freeze({ ...controllerObservable(store, "Find", () => disposed),
        getDiagnostics: () => Object.freeze({ maxScanStepMs: scanMaximum, replaceTransactionMs }), matchesIn,
        setQuery: (query, queryOptions) => {
            scope.assertWritable(); if (disposed) return;
            const previous = store.get().query;
            const selected = navigatedMatch?.selectionSet ?? (pendingPreview?.followSelected ? pendingPreview.selection : undefined);
            const refinement = !!previous && (query.startsWith(previous) || previous.startsWith(query));
            restart(query);
            if (queryOptions?.preview) capturePreview(refinement ? selected : undefined);
        },
        setHighlightMatches(visible) {
            scope.assertWritable();
            const state = store.get();
            if (visible === state.highlightMatches || !valid()) return;
            const current = previewed && hasResults(state) ? selectionIndex() : state.current;
            if (!visible) {
                cancelPreview();
                previewed = undefined;
                layer?.dispose();
            }
            layer = visible ? addHighlights() : undefined;
            publish({ highlightMatches: visible, current });
        },
        setFlags: (flags: FindFlags) => {
            scope.assertWritable();
            const state = store.get(), wholeWord = flags.wholeWord ?? state.wholeWord, matchCase = flags.matchCase ?? state.matchCase, regularExpression = flags.regularExpression ?? state.regularExpression;
            if (disposed || wholeWord === state.wholeWord && matchCase === state.matchCase && regularExpression === state.regularExpression) return;
            const preview = pendingPreview ?? previewed;
            const refresh = preview && preview.selection === currentSelection();
            restart(state.query, { wholeWord, matchCase, regularExpression });
            if (refresh) capturePreview();
        },
        acceptPreview, next, replaceCurrent, replaceAll, cancel: () => {
            scope.assertWritable();
            if (disposed) return;
            stop();
            reset({ status: "cancelled", ...notice("cancelled", "Search cancelled.") });
        },
        dispose });
}
