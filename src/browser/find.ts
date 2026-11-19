import { LiteralSearch } from "../core/search.ts";
import type { DocumentSnapshot, DocumentView, EditResult, TabId, Workspace } from "../core/workspace.ts";
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
const literalBudget = Object.freeze({ units: 4096, matches: 1024, calls: 32 });
export type FindFlags = Readonly<{ wholeWord?: boolean; matchCase?: boolean; regularExpression?: boolean }>;
export type FindControllerOptions = Readonly<{ regularExpressionBackend?: FindBackend; regularExpressionDelayMs?: number }>;
type FindEvents = Pick<EventTarget, "addEventListener" | "removeEventListener">;
/** View operations consumed by find. A mounted TextEditor satisfies this contract directly. */
export type FindHost = Readonly<{
    view: DocumentView;
    element: Readonly<{ ownerDocument: FindEvents & Readonly<{ defaultView: Readonly<{
        performance: Pick<Performance, "now">;
        setTimeout: (work: () => void, delay: number) => number; clearTimeout: (timer: number) => void;
    }> | null }> }>;
    input: FindEvents & Readonly<{ readOnly: boolean }>;
    activity: () => Readonly<{ disposed: boolean; composing: boolean }>;
    viewport: Readonly<{ revealOffset: (offset: number) => void }>;
    focus: () => void;
}>;
/** Stable cause of the last published notice, independent of its display message. */
export type FindReason = "editing-unavailable" | "composition-active" | "backend-unavailable" | "search-failed"
    | "replacement-failed" | "view-unavailable" | "cancelled" | "replaced" | Extract<EditResult, { applied: false }>["reason"];
export type FindSnapshot = Readonly<{ query: string; wholeWord: boolean; matchCase: boolean; regularExpression: boolean; revision: number; status: "idle" | "searching" | "ready" | "replacing" | "failed" | "cancelled" | "expired" | "disposed";
    count: number; scanned: number; length: number; retained: boolean; current: number | null; matchesVersion: number; reason: FindReason | null; message: string }>;
export type FindDiagnostics = Readonly<{ maxScanStepMs: number; replaceTransactionMs: number }>;
export type FindController = Observable<FindSnapshot> & Readonly<{
    getDiagnostics: () => FindDiagnostics;
    matchesIn: (from: number, to: number, capture?: FindSnapshot) => readonly SearchMatch[];
    setQuery: (query: string) => void;
    setFlags: (flags: FindFlags) => void;
    next: (direction?: 1 | -1) => boolean;
    replaceCurrent: (replacement: string) => boolean; replaceAll: (replacement: string) => void; cancel: () => void; dispose: () => void }>;
// A notice is replaced atomically; progress-only patches retain both fields.
type FindPatch = Partial<Omit<FindSnapshot, "reason" | "message">> &
    (Pick<FindSnapshot, "reason" | "message"> | { reason?: never; message?: never });
function isAsync<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
    return value !== null && (typeof value === "object" || typeof value === "function") && typeof (value as PromiseLike<T>).then === "function";
}

/** Host-rendered find UI; scanning/planning yield, while replacement uses one captured transaction. */
export function createFindController(workspace: Workspace, tabId: TabId, editor: FindHost, options: FindControllerOptions = {}): FindController {
    const backend = options.regularExpressionBackend, regexDelay = options.regularExpressionDelayMs ?? 80;
    if (!Number.isFinite(regexDelay) || regexDelay < 0 || regexDelay > 1000) throw new RangeError("Invalid regular-expression query delay.");
    const target = workspace.captureTab(tabId), tab = workspace.resolveTab(target);
    if (!tab || tab.surface.kind !== "text" || tab.surface.documentId !== editor.view.documentId || !workspace.ownsDocumentView(editor.view)) throw new Error("Find requires the captured document view.");
    const documentId = tab.surface.documentId, resource = workspace.resourceForDocument(documentId), lease = workspace.acquire(resource.id), owner = editor.element.ownerDocument, win = owner.defaultView!;
    const scope = workspace.createNotificationScope(), initial = workspace.document(documentId);
    const store = new Store<FindSnapshot>(Object.freeze({ query: "", wholeWord: false, matchCase: true, regularExpression: false, revision: initial.revision, status: "idle", count: 0, scanned: 0, length: initial.buffer.length,
        retained: false, current: null, matchesVersion: 0, reason: null, message: "" }), scope);
    const runner = createCooperativeRunner(win);
    let disposed = false, cursor: FindSearchCursor | undefined, planCursor: FindPlanCursor | undefined, generation = 0, focusGeneration = 0;
    let navigatedZero: Readonly<{ index: number; selectionSet: SelectionSet }> | undefined;
    let replacedZero: Readonly<{ revision: number; head: number; selectionSet: SelectionSet }> | undefined;
    let stopPlanAuthority: (() => void) | undefined;
    let matches = new FindIndex(), count = 0, navigationTo = 0, observed = initial;
    let literal: { document: DocumentSnapshot; index: FindIndex; query: string; wholeWord: boolean; matchCase: boolean } | undefined;
    let edges: { prefix: number; suffix: number } | undefined;
    const literalBackend = createLiteralFindBackend(() => matches, literalBudget.units, literalBudget.matches);
    const backendFor = (regularExpression: boolean) => regularExpression ? backend : literalBackend;
    const disposeBackends = () => { literalBackend.dispose(); backend?.dispose(); };
    let scanMaximum = 0, replaceTransactionMs = 0;
    const sameOwner = (a: DocumentSnapshot, b: DocumentSnapshot) => a.id === b.id && a.resourceId === b.resourceId && a.key === b.key;
    const valid = () => !disposed && lease.active() && workspace.resolveTab(target) !== undefined && workspace.ownsDocumentView(editor.view)
        && workspace.observeDocument(documentId).getSnapshot() !== undefined && !editor.activity().disposed;
    const publish = (patch: FindPatch) => {
        scope.publish(store, Object.freeze({ ...store.get(), ...patch }));
    };
    const stop = () => { generation++; runner.cancel();
        const active = cursor, plan = planCursor, authority = stopPlanAuthority; cursor = undefined; planCursor = undefined; stopPlanAuthority = undefined;
        navigatedZero = undefined; replacedZero = undefined;
        active?.dispose(); plan?.dispose(); authority?.(); };
    const reset = (patch: FindPatch) => {
        matches = new FindIndex(); count = 0; literal = undefined; edges = undefined; navigationTo = 0;
        publish({ ...patch, retained: false, count: 0, scanned: 0, current: null, matchesVersion: store.get().matchesVersion + 1 });
    };
    const later = (work: () => void, delay = 0) => { runner.schedule(work, delay); };
    const offsetAt = (index: number) => matches.at(index).from;
    const endAt = (index: number) => matches.at(index).to;
    const indexAt = (offset: number) => matches.lowerBound(offset);
    const emptyMatches: readonly SearchMatch[] = Object.freeze([]);
    const matchesIn = (from: number, to: number, capture = store.get()): readonly SearchMatch[] => {
        if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) throw new RangeError("Invalid match range.");
        const state = store.get();
        if (!valid() || capture.revision !== state.revision || capture.matchesVersion !== state.matchesVersion
            || workspace.document(documentId).revision !== state.revision) return emptyMatches;
        if (to > state.length) throw new RangeError("Match range exceeds document length.");
        return matches.matchesIn(from, to);
    };
    const canEdit = () => { const state = resource.getSnapshot(); return !editor.input.readOnly && state.state === "ready" && state.metadata.capabilities.edit.includes("human") && state.metadata.editLock === null; };
    const observePlanAuthority = (token: number) => { stopPlanAuthority = resource.metadata.subscribe(() => {
        if (token !== generation || canEdit()) return;
        stop(); publish({ status: "ready", reason: "editing-unavailable", message: "Replacement cancelled because editing became unavailable." });
    }); };
    const capture = (query: string, wholeWord: boolean, matchCase: boolean): FindQueryCapture => {
        const document = workspace.document(documentId); return Object.freeze({ documentId, revision: document.revision, buffer: document.buffer, query, wholeWord, matchCase });
    };
    const failed = (error: unknown, token: number, planning = false, reason: FindReason = planning ? "replacement-failed" : "search-failed") => {
        if (token !== generation || disposed) return;
        stop(); const message = error instanceof Error && error.message.length <= 256 ? error.message : "Search is unavailable; editing remains available.";
        if (planning) publish({ status: "ready", reason, message });
        else reset({ status: "failed", reason, message });
    };
    function restart(query: string, wholeWord = store.get().wholeWord, matchCase = store.get().matchCase, regularExpression = store.get().regularExpression, retain = false): void {
        stop();
        if (!valid()) { disposeBackends(); reset({ status: "expired", reason: "view-unavailable", message: "View is unavailable." }); return; }
        const document = workspace.document(documentId), token = generation;
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
                        matchesVersion: store.get().matchesVersion + 1, current: null, reason: null, message: "" }); return;
                }
                const prefix = Math.min(edges?.prefix ?? proof.prefix, proof.prefix, literal.document.buffer.length, document.buffer.length);
                edges = { prefix, suffix: Math.min(edges?.suffix ?? proof.suffix, proof.suffix, literal.document.buffer.length - prefix, document.buffer.length - prefix) };
                repair = new LiteralFindRepair(document.buffer, query, { wholeWord, matchCase }, literal.index, literal.document.buffer.length, edges);
            }
        }
        observed = document;
        const patch = { query, wholeWord, matchCase, regularExpression, revision: document.revision, length: document.buffer.length, reason: null, message: "" };
        if (repair) {
            matches = repair.index; count = matches.count; navigationTo = repair.start;
            publish({ ...patch, status: "searching", retained: true, count, scanned: repair.start, current: null, matchesVersion: store.get().matchesVersion + 1 });
        } else reset({ ...patch, status: query ? "searching" : "idle" });
        if (!query) return;
        let nextLiteral: (() => SearchStep) | undefined;
        try {
            if (regularExpression && !backend) throw new Error("Regular-expression search is unavailable in this host.");
            let created: FindSearchCursor;
            if (regularExpression) created = backend!.search(capture(query, wholeWord, matchCase));
            else if (repair) {
                const repairing = repair; let first = true;
                // A nearby anchor usually settles in one small slice; ambiguous suffixes
                // continue with the same bounded advances as a fresh literal scan.
                nextLiteral = () => { const small = first; first = false; return repairing.next(literalBudget.units, small ? 64 : literalBudget.matches); };
                created = { next: nextLiteral, dispose: () => repairing.dispose() };
            } else { const literal = literalBackend.search(capture(query, wholeWord, matchCase)); created = literal; nextLiteral = literal.next; }
            if (token !== generation) { created.dispose(); return; } cursor = created;
        } catch (error) { failed(error, token, false, regularExpression && !backend ? "backend-unavailable" : "search-failed"); return; }
        const step = () => {
            if (token !== generation || !valid()) { if (token === generation) restart(query); return; }
            const started = win.performance.now(); let scanned = store.get().scanned;
            // Start the next literal timer's wait during this bounded slice, rather than after it.
            if (!regularExpression) later(step);
            const accept = (result: SearchStep, began: number, dispatchMs: number): boolean => {
                if (token !== generation) return false;
                if (!valid() || workspace.document(documentId).revision !== document.revision) { restart(query); return false; }
                if (result.matches.length > 8192
                    || !Number.isSafeInteger(result.scanned) || result.scanned < scanned || result.scanned > document.buffer.length) throw new Error("Invalid search result.");
                for (const match of repair ? [] : result.matches) {
                    if (!Number.isSafeInteger(match.from) || !Number.isSafeInteger(match.to) || match.from < 0 || match.to < match.from || match.to > document.buffer.length
                        || count > 0 && (match.from < endAt(count - 1) || match.from === offsetAt(count - 1) && match.to === endAt(count - 1))) throw new Error("Invalid search range.");
                    matches.append(match); count++;
                }
                if (repair) { count = matches.count; navigationTo = Math.max(navigationTo, count ? endAt(count - 1) : 0); }
                scanned = result.scanned;
                scanMaximum = Math.max(scanMaximum, dispatchMs, win.performance.now() - began);
                if (result.done) {
                    if (!regularExpression) runner.cancel();
                    const finished = cursor; cursor = undefined; finished?.dispose();
                    if (!regularExpression) { literal = { document, index: matches, query, wholeWord, matchCase }; edges = undefined; }
                }
                return token === generation && valid();
            };
            const present = (result: SearchStep) => {
                // Transfer acknowledgements can advance diagnostics without changing visible progress.
                const state = store.get();
                if (result.done || count !== state.count || result.scanned !== state.scanned)
                    publish({ count, matchesVersion: state.matchesVersion + (count !== state.count ? 1 : 0), scanned: result.scanned, status: result.done ? "ready" : "searching", retained: !!repair && !result.done });
                if (!result.done && token === generation && regularExpression) later(step);
            };
            const receive = (result: SearchStep, asynchronous: boolean, dispatchMs: number) => {
                if (accept(result, asynchronous ? win.performance.now() : started, dispatchMs)) present(result);
            };
            try {
                if (nextLiteral) {
                    const advance = nextLiteral;
                    const result = runner.slice(() => { const began = win.performance.now(), value = advance(); return accept(value, began, 0) ? value : undefined; },
                        value => !!value && !value.done && token === generation && valid(), literalBudget.calls);
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
    }
    const replacedHere = () => {
        if (!replacedZero || replacedZero.revision !== store.get().revision) return false;
        const selected = editor.view.getSnapshot(); return selected.selectionSet === replacedZero.selectionSet && selected.selection.anchor === replacedZero.head && selected.selection.head === replacedZero.head;
    };
    const currentRange = (): SearchMatch | undefined => {
        const state = store.get(); if (!valid() || state.status !== "ready" && !(state.status === "searching" && state.retained) || state.revision !== workspace.document(documentId).revision) return undefined;
        const selected = editor.view.getSnapshot().selection, low = Math.min(selected.anchor, selected.head), high = Math.max(selected.anchor, selected.head);
        if (!state.query) return undefined;
        const index = indexAt(low);
        if (index < count && offsetAt(index) === low && endAt(index) === high && !(low === high && replacedHere())) return { from: low, to: high };
        if (state.status !== "ready") return undefined;
        // A manually selected overlapping regex range is validated by the captured backend plan.
        if (state.regularExpression) return high > low && (index < count && offsetAt(index) < high && endAt(index) > low
            || index > 0 && endAt(index - 1) > low) ? { from: low, to: high } : undefined;
        if (state.wholeWord) return undefined;
        const buffer = workspace.document(documentId).buffer;
        if (state.matchCase) return high - low === state.query.length && buffer.slice(low, high) === state.query ? { from: low, to: high } : undefined;
        // Preserve replacement of a manually selected literal, including a non-indexed overlap.
        // Simple folding keeps code-point count; reject impossible spans before rescanning.
        if (high - low < Math.ceil(state.query.length / 2) || high - low > state.query.length * 2) return undefined;
        const selectedSearch = new LiteralSearch(buffer, state.query, { from: low, to: high, matchCase: false });
        try { const match = selectedSearch.next(high - low + 1, 1).matches[0]; return match?.from === low && match.to === high ? match : undefined; }
        finally { selectedSearch.dispose(); }
    };
    const next = (direction: 1 | -1 = 1): boolean => {
        scope.assertWritable();
        const state = store.get(); if (!valid() || state.status !== "ready" && !(state.status === "searching" && state.retained) || !count) return false;
        if (editor.activity().composing) { publish({ reason: "composition-active", message: "Finish composition before navigating." }); return false; }
        const selection = editor.view.getSnapshot(), selected = selection.selection, bound = direction === 1 ? Math.max(selected.anchor, selected.head) : Math.min(selected.anchor, selected.head);
        let low = indexAt(bound);
        if (state.status !== "ready" && (direction === 1 ? low === count : low === 0 || bound > navigationTo)) return false;
        if (direction === 1 && low < count && offsetAt(low) === bound && endAt(low) === bound
            && (navigatedZero?.index === low && navigatedZero.selectionSet === selection.selectionSet || replacedHere())) low++;
        const index = direction === 1 ? low % count : (low + count - 1) % count, from = offsetAt(index), to = endAt(index);
        if (!editor.view.setSelection(state.revision, { anchor: from, head: to })) return false;
        navigatedZero = from === to ? { index, selectionSet: editor.view.getSnapshot().selectionSet } : undefined; replacedZero = undefined;
        publish({ current: index, reason: null, message: "" }); editor.viewport.revealOffset(from); editor.focus(); return true;
    };
    function planReplacement(state: FindSnapshot, replacement: string, range?: SearchMatch): boolean {
        const selectedBackend = backendFor(state.regularExpression), immediate = !!range && !state.regularExpression;
        if (!selectedBackend || !valid() || state.revision !== workspace.document(documentId).revision) return false;
        if (!canEdit()) { publish({ reason: "editing-unavailable", message: "read-only" }); return false; }
        if (editor.activity().composing) { publish({ reason: "composition-active", message: "Finish composition before replacing." }); return false; }
        const request = capture(state.query, state.wholeWord, state.matchCase), positions = matches, total = range ? 1 : count;
        const selectionSet = editor.view.getSnapshot().selectionSet, acceptPlan = createFindReplacementPlan(positions, total, range);
        // A synchronous literal replacement must leave an in-progress repair alive on a no-op.
        // Yielding plans cancel scans and retain authority until their captured commit.
        if (!immediate) stop();
        const token = generation, focusToken = focusGeneration; let committed = false;
        if (!immediate) { observePlanAuthority(token); publish({ status: "replacing", reason: null, message: "" }); }
        if (token !== generation) return false;
        try { const created = selectedBackend.replace(request, replacement, range); if (token !== generation) { created.dispose(); return false; } planCursor = created; }
        catch (error) { failed(error, token, true); return false; }
        const current = () => {
            if (token !== generation) return false;
            if (!valid() || workspace.document(documentId).revision !== state.revision || editor.view.getSnapshot().selectionSet !== selectionSet) { restart(state.query); return false; }
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
            if (!immediate && workspace.document(documentId).revision === state.revision) publish({ status: "ready" });
            if (range && range.from === range.to && store.get().query === state.query && store.get().regularExpression && valid()) {
                replacedZero = { revision: workspace.document(documentId).revision, head: head!, selectionSet: editor.view.getSnapshot().selectionSet };
            }
            publish({ reason: "replaced", message: `Replaced ${total} ${total === 1 ? "match" : "matches"}.` });
            if (valid()) { if (head !== undefined) editor.viewport.revealOffset(head); if (focusGeneration === focusToken) editor.focus(); }
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
        if (!canEdit()) { publish({ reason: "editing-unavailable", message: "read-only" }); return false; }
        if (editor.activity().composing) { publish({ reason: "composition-active", message: "Finish composition before replacing." }); return false; }
        const match = currentRange(); if (!match) return next();
        return planReplacement(store.get(), replacement, match);
    };
    const replaceAll = (replacement: string): void => {
        scope.assertWritable();
        const state = store.get(); if (!valid() || state.status !== "ready" || !count) return;
        planReplacement(state, replacement);
    };
    // Disabling the command button can clear activeElement without a new focus choice.
    const focusChanged = () => { focusGeneration++; };
    owner.addEventListener("focusin", focusChanged);
    const compositionStarted = () => {
        if (store.get().status !== "replacing") return;
        stop(); publish({ status: "ready", reason: "composition-active", message: "Replacement cancelled for composition." });
    };
    editor.input.addEventListener("compositionstart", compositionStarted);
    const subscriptions = [() => owner.removeEventListener("focusin", focusChanged), () => editor.input.removeEventListener("compositionstart", compositionStarted), workspace.observeDocument(documentId).subscribe(() => {
        const current = workspace.observeDocument(documentId).getSnapshot();
        if (current && sameOwner(observed, current) && current.revision === observed.revision && current.buffer === observed.buffer) return;
        if (store.get().status === "cancelled" && valid()) { observed = workspace.document(documentId); publish({ revision: observed.revision, length: observed.buffer.length }); }
        else { const state = store.get(); restart(state.query, state.wholeWord, state.matchCase, state.regularExpression, true); }
    }), workspace.tabState.subscribe(() => { if (!valid()) { stop(); disposeBackends(); reset({ status: "expired", reason: "view-unavailable", message: "View is unavailable." }); } })];
    return Object.freeze({ ...store.observable, getDiagnostics: () => Object.freeze({ maxScanStepMs: scanMaximum, replaceTransactionMs }), matchesIn, setQuery: (query: string) => { scope.assertWritable(); if (!disposed) restart(query); },
        setFlags: (flags: FindFlags) => {
            scope.assertWritable();
            const state = store.get(), wholeWord = flags.wholeWord ?? state.wholeWord, matchCase = flags.matchCase ?? state.matchCase, regularExpression = flags.regularExpression ?? state.regularExpression;
            if (!disposed && (wholeWord !== store.get().wholeWord || matchCase !== store.get().matchCase || regularExpression !== store.get().regularExpression)) restart(store.get().query, wholeWord, matchCase, regularExpression);
        },
        next, replaceCurrent, replaceAll, cancel: () => { scope.assertWritable(); if (!disposed) { stop(); reset({ status: "cancelled", reason: "cancelled", message: "Search cancelled." }); } },
        dispose: () => { if (disposed) return; scope.assertWritable(); disposed = true; stop(); disposeBackends(); subscriptions.forEach(unsubscribe => unsubscribe()); lease.release(); reset({ status: "disposed", query: "", length: 0, reason: null, message: "" }); } });
}
