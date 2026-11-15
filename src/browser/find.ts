import { LiteralSearch } from "../core/search.ts";
import type { DocumentId, DocumentSnapshot, TabId, Workspace } from "../core/workspace.ts";
import { unchangedPositionEdges } from "../core/positions.ts";
import { FindIndex, LiteralFindRepair } from "./find-index.ts";
import type { Observable } from "../core/observable.ts";
import type { SearchMatch, SearchStep } from "../core/search.ts";
import type { SelectionSet } from "../core/selections.ts";
import type { TextBuffer } from "../core/text-buffer.ts";
import type { TextEdit } from "../core/changes.ts";
import { Store } from "../core/observable.ts";
import type { EditingCandidate } from "./editing-candidate.ts";
export type FindOptions = Readonly<{ wholeWord?: boolean; matchCase?: boolean; regularExpression?: boolean }>;
export type FindQueryCapture = Readonly<{ documentId: DocumentId; revision: number; buffer: TextBuffer; query: string; wholeWord: boolean; matchCase: boolean }>;
export type FindSearchCursor = Readonly<{ next: () => SearchStep | PromiseLike<SearchStep>; dispose: () => void }>;
export type FindPlanStep = Readonly<{ done: boolean; edits: readonly TextEdit[] }>;
export type FindPlanCursor = Readonly<{ next: () => FindPlanStep | PromiseLike<FindPlanStep>; dispose: () => void }>;
/** One controller owns the backend until expiry/destruction. Disposal must be idempotent.
 * The backend produces one edit per indexed match, including no-ops. Only this controller commits. */
export type FindBackend = Readonly<{ search: (capture: FindQueryCapture) => FindSearchCursor;
    replace: (capture: FindQueryCapture, replacement: string, range?: SearchMatch) => FindPlanCursor; dispose: () => void }>;
export type FindConfiguration = Readonly<{ regularExpression?: FindBackend; regularExpressionDelayMs?: number }>;
export type FindSnapshot = Readonly<{ query: string; wholeWord: boolean; matchCase: boolean; regularExpression: boolean; revision: number; status: "idle" | "searching" | "ready" | "replacing" | "failed" | "cancelled" | "expired" | "disposed";
    count: number; scanned: number; length: number; retained: boolean; current: number | null; preview: readonly SearchMatch[]; message: string; maxScanStepMs: number; replaceTransactionMs: number }>;
export type FindController = Readonly<{ state: Observable<FindSnapshot>; setQuery: (query: string) => void; setOptions: (options: FindOptions) => void; next: (direction?: 1 | -1) => boolean;
    replaceCurrent: (replacement: string) => boolean; replaceAll: (replacement: string) => void; cancel: () => void; destroy: () => void }>;
function isAsync<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
    return value !== null && (typeof value === "object" || typeof value === "function") && typeof (value as PromiseLike<T>).then === "function";
}

/** Host-rendered find UI; scanning/planning yield, while replacement uses one captured transaction. */
export function createFindController(workspace: Workspace, tabId: TabId, editor: EditingCandidate, configuration: FindConfiguration = {}): FindController {
    const backend = configuration.regularExpression, regexDelay = configuration.regularExpressionDelayMs ?? 80;
    if (!Number.isFinite(regexDelay) || regexDelay < 0 || regexDelay > 1000) throw new RangeError("Invalid regular-expression query delay.");
    if (backend !== undefined && (typeof backend?.search !== "function" || typeof backend.replace !== "function" || typeof backend.dispose !== "function")) throw new TypeError("Expected a find backend.");
    const target = workspace.captureTab(tabId), tab = workspace.resolveTab(target);
    if (!tab || tab.surface.kind !== "text" || tab.surface.documentId !== editor.view.documentId || !workspace.ownsDocumentView(editor.view)) throw new Error("Find requires the captured document view.");
    const documentId = tab.surface.documentId, resource = workspace.resourceForDocument(documentId), lease = workspace.acquire(resource.id), owner = editor.element.ownerDocument, win = owner.defaultView!;
    const scope = workspace.createNotificationScope(), initial = workspace.document(documentId);
    const store = new Store<FindSnapshot>(Object.freeze({ query: "", wholeWord: false, matchCase: true, regularExpression: false, revision: initial.revision, status: "idle", count: 0, scanned: 0, length: initial.buffer.length,
        retained: false, current: null, preview: Object.freeze([]), message: "", maxScanStepMs: 0, replaceTransactionMs: 0 }), scope);
    let disposed = false, timer: number | undefined, cursor: FindSearchCursor | undefined, planCursor: FindPlanCursor | undefined, generation = 0, focusGeneration = 0;
    let navigatedZero: Readonly<{ index: number; selectionSet: SelectionSet }> | undefined;
    let replacedZero: Readonly<{ revision: number; head: number; selectionSet: SelectionSet }> | undefined;
    let stopPlanAuthority: (() => void) | undefined;
    let matches = new FindIndex(), count = 0, navigationTo = 0, observed = initial;
    let literal: { document: DocumentSnapshot; index: FindIndex; query: string; wholeWord: boolean; matchCase: boolean } | undefined;
    let edges: { prefix: number; suffix: number } | undefined;
    let scanMaximum = 0;
    const sameOwner = (a: DocumentSnapshot, b: DocumentSnapshot) => a.id === b.id && a.resourceId === b.resourceId && a.key === b.key;
    const valid = () => !disposed && lease.active() && workspace.resolveTab(target) !== undefined && workspace.ownsDocumentView(editor.view)
        && workspace.observeDocument(documentId).getSnapshot() !== undefined && !editor.activity().disposed;
    const publish = (patch: Partial<FindSnapshot>) => {
        scanMaximum = patch.maxScanStepMs ?? scanMaximum;
        const changed = new Set<Store<unknown>>(); store.set(Object.freeze({ ...store.get(), ...patch, maxScanStepMs: scanMaximum }), changed); scope.deliver([...changed]);
    };
    const stop = () => { generation++; if (timer !== undefined) win.clearTimeout(timer); timer = undefined;
        const active = cursor, plan = planCursor, authority = stopPlanAuthority; cursor = undefined; planCursor = undefined; stopPlanAuthority = undefined;
        navigatedZero = undefined; replacedZero = undefined;
        active?.dispose(); plan?.dispose(); authority?.(); };
    const reset = (patch: Partial<FindSnapshot>) => {
        matches = new FindIndex(); count = 0; literal = undefined; edges = undefined; navigationTo = 0;
        publish({ ...patch, retained: false, count: 0, scanned: 0, current: null, preview: Object.freeze([]) });
    };
    const later = (work: () => void, delay = 0) => { timer = win.setTimeout(() => { timer = undefined; work(); }, delay); };
    const offsetAt = (index: number) => matches.at(index).from;
    const endAt = (index: number) => matches.at(index).to;
    const indexAt = (offset: number) => matches.lowerBound(offset);
    const retainedPreview = () => {
        const previous = store.get().preview, preview = matches.preview();
        return previous.length === preview.length && previous.every((m, i) => m.from === preview[i]!.from && m.to === preview[i]!.to) ? previous : preview;
    };
    const canEdit = () => { const state = resource.getSnapshot(); return !editor.input.readOnly && state.state === "ready" && state.metadata.capabilities.edit.includes("human") && state.metadata.editLock === null; };
    const observePlanAuthority = (token: number) => { stopPlanAuthority = resource.metadata.subscribe(() => {
        if (token !== generation || canEdit()) return;
        stop(); publish({ status: "ready", message: "Replacement cancelled because editing became unavailable." });
    }); };
    const capture = (query: string, wholeWord: boolean, matchCase: boolean): FindQueryCapture => {
        const document = workspace.document(documentId); return Object.freeze({ documentId, revision: document.revision, buffer: document.buffer, query, wholeWord, matchCase });
    };
    const failed = (error: unknown, token: number, planning = false) => {
        if (token !== generation || disposed) return;
        stop(); const message = error instanceof Error && error.message.length <= 256 ? error.message : "Search is unavailable; editing remains available.";
        if (planning) publish({ status: "ready", message });
        else reset({ status: "failed", message });
    };
    function restart(query: string, wholeWord = store.get().wholeWord, matchCase = store.get().matchCase, regularExpression = store.get().regularExpression, retain = false): void {
        stop();
        if (!valid()) { backend?.dispose(); reset({ status: "expired", message: "View is unavailable." }); return; }
        const document = workspace.document(documentId), token = generation;
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
                        preview: retainedPreview(), current: null, message: "", maxScanStepMs: 0 }); return;
                }
                const prefix = Math.min(edges?.prefix ?? proof.prefix, proof.prefix, literal.document.buffer.length, document.buffer.length);
                edges = { prefix, suffix: Math.min(edges?.suffix ?? proof.suffix, proof.suffix, literal.document.buffer.length - prefix, document.buffer.length - prefix) };
                repair = new LiteralFindRepair(document.buffer, query, { wholeWord, matchCase }, literal.index, literal.document.buffer.length, edges);
            }
        }
        observed = document;
        const patch = { query, wholeWord, matchCase, regularExpression, revision: document.revision, length: document.buffer.length, message: "", maxScanStepMs: 0 };
        if (repair) {
            matches = repair.index; count = matches.count; navigationTo = repair.start;
            publish({ ...patch, status: "searching", retained: true, count, scanned: repair.start, current: null, preview: retainedPreview() });
        } else reset({ ...patch, status: query ? "searching" : "idle" });
        if (!query) return;
        try {
            if (regularExpression && !backend) throw new Error("Regular-expression search is unavailable in this host.");
            let created: FindSearchCursor;
            if (repair) {
                const repairing = repair; let first = true;
                // A nearby anchor usually settles in one small slice. If it does not,
                // use the ordinary scan budget so ambiguous suffixes do not yield per 64 matches.
                created = { next: () => { const small = first; first = false; return repairing.next(small ? 4096 : 131_072, small ? 64 : 8192); }, dispose: () => repairing.dispose() };
            }
            else if (regularExpression) created = backend!.search(capture(query, wholeWord, matchCase));
            else {
                const search = new LiteralSearch(document.buffer, query, { wholeWord, matchCase });
                // Amortize timer yields while retaining bounded scans and match publication.
                created = { next: () => search.next(131_072, 8_192), dispose: () => search.dispose() };
            }
            if (token !== generation) { created.dispose(); return; } cursor = created;
        } catch (error) { failed(error, token); return; }
        const step = () => {
            if (token !== generation || !valid()) { if (token === generation) restart(query); return; }
            const started = win.performance.now();
            // Start the next literal timer's wait during this bounded slice, rather than after it.
            if (!regularExpression) later(step);
            const receive = (result: SearchStep, asynchronous: boolean, dispatchMs: number) => {
                if (token !== generation) return;
                if (!valid() || workspace.document(documentId).revision !== document.revision) { restart(query); return; }
                const began = asynchronous ? win.performance.now() : started;
                if (!result || typeof result.done !== "boolean" || !Array.isArray(result.matches) || result.matches.length > 8192
                    || !Number.isSafeInteger(result.scanned) || result.scanned < store.get().scanned || result.scanned > document.buffer.length) throw new Error("Invalid search result.");
                for (const match of repair ? [] : result.matches) {
                    if (!Number.isSafeInteger(match.from) || !Number.isSafeInteger(match.to) || match.from < 0 || match.to < match.from || match.to > document.buffer.length
                        || count > 0 && (match.from < endAt(count - 1) || match.from === offsetAt(count - 1) && match.to === endAt(count - 1))) throw new Error("Invalid search range.");
                    matches.append(match); count++;
                }
                if (repair) { count = matches.count; navigationTo = Math.max(navigationTo, count ? endAt(count - 1) : 0); }
                const previous = store.get().preview, extra = result.matches.slice(0, 200 - previous.length);
                const preview = repair ? retainedPreview() : previous.length < 200 && extra.length ? Object.freeze([...previous, ...(regularExpression ? extra.map(m => Object.freeze({ from: m.from, to: m.to })) : extra)]) : previous;
                scanMaximum = Math.max(scanMaximum, dispatchMs, win.performance.now() - began);
                if (result.done) {
                    if (!regularExpression && timer !== undefined) { win.clearTimeout(timer); timer = undefined; }
                    const finished = cursor; cursor = undefined; finished?.dispose();
                    if (!regularExpression) { literal = { document, index: matches, query, wholeWord, matchCase }; edges = undefined; }
                }
                if (token !== generation || !valid()) return;
                // Transfer acknowledgements can change work/timing without changing visible
                // progress. Keep their maximum privately until the next real publication.
                const state = store.get();
                if (result.done || count !== state.count || result.scanned !== state.scanned)
                    publish({ count, preview, scanned: result.scanned, status: result.done ? "ready" : "searching", retained: !!repair && !result.done });
                if (!result.done && token === generation && regularExpression) later(step);
            };
            try { const result = cursor!.next(), dispatchMs = win.performance.now() - started;
                if (isAsync(result)) void Promise.resolve(result).then(value => { try { receive(value, true, dispatchMs); } catch (error) { failed(error, token); } }, error => failed(error, token));
                else receive(result, false, 0);
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
        scope.assertWritable(); if (direction !== 1 && direction !== -1) throw new RangeError("Invalid search direction.");
        const state = store.get(); if (!valid() || state.status !== "ready" && !(state.status === "searching" && state.retained) || !count) return false;
        if (editor.activity().composing) { publish({ message: "Finish composition before navigating." }); return false; }
        const selection = editor.view.getSnapshot(), selected = selection.selection, bound = direction === 1 ? Math.max(selected.anchor, selected.head) : Math.min(selected.anchor, selected.head);
        let low = indexAt(bound);
        if (state.status !== "ready" && (direction === 1 ? low === count : low === 0 || bound > navigationTo)) return false;
        if (direction === 1 && low < count && offsetAt(low) === bound && endAt(low) === bound
            && (navigatedZero?.index === low && navigatedZero.selectionSet === selection.selectionSet || replacedHere())) low++;
        const index = direction === 1 ? low % count : (low + count - 1) % count, from = offsetAt(index), to = endAt(index);
        if (!editor.view.setSelection(state.revision, { anchor: from, head: to })) return false;
        navigatedZero = from === to ? { index, selectionSet: editor.view.getSnapshot().selectionSet } : undefined; replacedZero = undefined;
        publish({ current: index, message: "" }); editor.viewport.revealOffset(from); editor.focus(); return true;
    };
    function regexPlan(state: FindSnapshot, replacement: string, range?: SearchMatch): boolean {
        if (!backend || !valid() || state.revision !== workspace.document(documentId).revision) return false;
        if (!canEdit()) { publish({ message: "read-only" }); return false; }
        if (editor.activity().composing) { publish({ message: "Finish composition before replacing." }); return false; }
        const request = capture(state.query, state.wholeWord, state.matchCase), positions = matches, total = range ? 1 : count;
        const selectionSet = editor.view.getSnapshot().selectionSet, edits: TextEdit[] = [];
        stop(); const token = generation, focusToken = focusGeneration; observePlanAuthority(token); publish({ status: "replacing", message: "" });
        if (token !== generation) return false;
        try { const created = backend.replace(request, replacement, range); if (token !== generation) { created.dispose(); return false; } planCursor = created; }
        catch (error) { failed(error, token, true); return false; }
        const current = () => {
            if (token !== generation) return false;
            if (!valid() || workspace.document(documentId).revision !== state.revision || editor.view.getSnapshot().selectionSet !== selectionSet) { restart(state.query); return false; }
            if (!canEdit() || editor.activity().composing) { stop(); publish({ status: "ready", message: "Replacement cancelled because editing became unavailable." }); return false; }
            return true;
        };
        const receive = (result: FindPlanStep) => {
            if (!current()) return;
            if (!result || typeof result.done !== "boolean" || !Array.isArray(result.edits) || result.edits.length > 1024) throw new Error("Invalid replacement plan step.");
            for (const edit of result.edits) {
                const index = edits.length;
                if (index >= total || typeof edit.insert !== "string") throw new Error("Invalid replacement plan.");
                const at = range ?? positions.at(index);
                if (edit.from !== at.from || edit.to !== at.to) throw new Error("Replacement plan does not match the captured search.");
                edits.push(Object.freeze({ from: edit.from, to: edit.to, insert: edit.insert }));
            }
            if (!result.done) { later(step); return; }
            if (edits.length !== total) throw new Error("Incomplete replacement plan.");
            const finished = planCursor; planCursor = undefined; finished?.dispose(); if (!current()) return;
            const head = range ? range.from + edits[0]!.insert.length : undefined, started = win.performance.now();
            const applied = workspace.edit({ documentId, expectedRevision: state.revision, origin: "human", edits, view: editor.view,
                ...(head === undefined ? {} : { selection: { anchor: head, head } }), history: { kind: "replace" } });
            stopPlanAuthority?.(); stopPlanAuthority = undefined; publish({ replaceTransactionMs: win.performance.now() - started });
            if (!applied.applied) { publish({ status: "ready", message: applied.reason }); return; }
            if (workspace.document(documentId).revision === state.revision) publish({ status: "ready" });
            if (range && range.from === range.to && store.get().query === state.query && store.get().regularExpression && valid()) {
                replacedZero = { revision: workspace.document(documentId).revision, head: head!, selectionSet: editor.view.getSnapshot().selectionSet };
            }
            publish({ message: `Replaced ${total} ${total === 1 ? "match" : "matches"}.` });
            if (valid()) { if (head !== undefined) editor.viewport.revealOffset(head); if (focusGeneration === focusToken) editor.focus(); }
        };
        const step = () => {
            if (!current()) return;
            try { const result = planCursor!.next();
                if (isAsync(result)) void Promise.resolve(result).then(value => { try { receive(value); } catch (error) { failed(error, token, true); } }, error => failed(error, token, true));
                else receive(result);
            } catch (error) { failed(error, token, true); }
        };
        later(step); return true;
    }
    const replaceCurrent = (replacement: string): boolean => {
        scope.assertWritable(); if (typeof replacement !== "string") throw new TypeError("Expected replacement text.");
        if (!valid()) return false;
        if (!canEdit()) { publish({ message: "read-only" }); return false; }
        if (editor.activity().composing) { publish({ message: "Finish composition before replacing." }); return false; }
        const match = currentRange(); if (!match) return next();
        if (store.get().regularExpression) return regexPlan(store.get(), replacement, match);
        const head = match.from + replacement.length;
        const result = workspace.edit({ documentId, expectedRevision: store.get().revision, origin: "human", edits: [{ ...match, insert: replacement }], view: editor.view,
            selection: { anchor: head, head }, history: { kind: "replace" } });
        if (!result.applied) { publish({ message: result.reason }); return false; }
        editor.viewport.revealOffset(head); editor.focus(); return true;
    };
    const replaceAll = (replacement: string): void => {
        scope.assertWritable(); if (typeof replacement !== "string") throw new TypeError("Expected replacement text.");
        const state = store.get(); if (!valid() || state.status !== "ready" || !count) return;
        if (!canEdit()) { publish({ message: "read-only" }); return; }
        if (editor.activity().composing) { publish({ message: "Finish composition before replacing." }); return; }
        if (state.regularExpression) { regexPlan(state, replacement); return; }
        stop(); const token = generation, focusToken = focusGeneration, positions = matches, total = count, edits: TextEdit[] = [], selectionSet = editor.view.getSnapshot().selectionSet; let index = 0;
        // A restored permission/lock does not revive an interrupted human command.
        // Observe only while planning; disposal does not mutate workspace state in delivery.
        observePlanAuthority(token);
        publish({ status: "replacing", message: "" });
        const step = () => {
            if (token !== generation) return;
            if (!valid() || workspace.document(documentId).revision !== state.revision || editor.view.getSnapshot().selectionSet !== selectionSet) { restart(state.query); return; }
            const stopAt = Math.min(total, index + 1024);
            for (; index < stopAt; index++) edits.push({ ...positions.at(index), insert: replacement });
            if (index < total) { later(step); return; }
            const started = win.performance.now(), result = workspace.edit({ documentId, expectedRevision: state.revision, origin: "human", edits, view: editor.view, history: { kind: "replace" } });
            stopPlanAuthority?.(); stopPlanAuthority = undefined;
            publish({ replaceTransactionMs: win.performance.now() - started });
            if (!result.applied) { publish({ status: "ready", message: result.reason }); return; }
            if (workspace.document(documentId).revision === state.revision) publish({ status: "ready" });
            publish({ message: `Replaced ${total} matches.` });
            if (focusGeneration === focusToken) editor.focus();
        }; if (token === generation) later(step);
    };
    // Disabling the command button can clear activeElement without a new focus choice.
    const focusChanged = () => { focusGeneration++; };
    owner.addEventListener("focusin", focusChanged);
    const compositionStarted = () => {
        if (store.get().status !== "replacing") return;
        stop(); publish({ status: "ready", message: "Replacement cancelled for composition." });
    };
    editor.input.addEventListener("compositionstart", compositionStarted);
    const subscriptions = [() => owner.removeEventListener("focusin", focusChanged), () => editor.input.removeEventListener("compositionstart", compositionStarted), workspace.observeDocument(documentId).subscribe(() => {
        const current = workspace.observeDocument(documentId).getSnapshot();
        if (current && sameOwner(observed, current) && current.revision === observed.revision && current.buffer === observed.buffer) return;
        if (store.get().status === "cancelled" && valid()) { observed = workspace.document(documentId); publish({ revision: observed.revision, length: observed.buffer.length }); }
        else { const state = store.get(); restart(state.query, state.wholeWord, state.matchCase, state.regularExpression, true); }
    }), workspace.tabState.subscribe(() => { if (!valid()) { stop(); backend?.dispose(); reset({ status: "expired", message: "View is unavailable." }); } })];
    return Object.freeze({ state: store.observable, setQuery: (query: string) => { scope.assertWritable(); if (typeof query !== "string") throw new TypeError("Expected a search string."); if (!disposed) restart(query); },
        setOptions: (options: FindOptions) => {
            scope.assertWritable(); if (options === null || typeof options !== "object" || (options.wholeWord !== undefined && typeof options.wholeWord !== "boolean" || options.matchCase !== undefined && typeof options.matchCase !== "boolean" || options.regularExpression !== undefined && typeof options.regularExpression !== "boolean")) throw new TypeError("Expected find options.");
            const state = store.get(), wholeWord = options.wholeWord ?? state.wholeWord, matchCase = options.matchCase ?? state.matchCase, regularExpression = options.regularExpression ?? state.regularExpression;
            if (!disposed && (wholeWord !== store.get().wholeWord || matchCase !== store.get().matchCase || regularExpression !== store.get().regularExpression)) restart(store.get().query, wholeWord, matchCase, regularExpression);
        },
        next, replaceCurrent, replaceAll, cancel: () => { scope.assertWritable(); if (!disposed) { stop(); reset({ status: "cancelled", message: "Search cancelled." }); } },
        destroy: () => { if (disposed) return; scope.assertWritable(); disposed = true; stop(); backend?.dispose(); subscriptions.forEach(unsubscribe => unsubscribe()); lease.release(); reset({ status: "disposed", query: "", length: 0, message: "" }); } });
}
