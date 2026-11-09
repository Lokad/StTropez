import { LiteralSearch } from "../index.ts";
import type { Observable, SearchMatch, TabId, TextEdit, Workspace } from "../index.ts";
import { NotificationScope, Store } from "../core/observable.ts";
import type { EditingCandidate } from "./editing-candidate.ts";
export type FindOptions = Readonly<{ wholeWord?: boolean; matchCase?: boolean }>;
export type FindSnapshot = Readonly<{ query: string; wholeWord: boolean; matchCase: boolean; revision: number; status: "idle" | "searching" | "ready" | "replacing" | "cancelled" | "expired" | "disposed";
    count: number; scanned: number; length: number; current: number | null; preview: readonly SearchMatch[]; message: string; maxScanStepMs: number; replaceTransactionMs: number }>;
export type FindController = Readonly<{ state: Observable<FindSnapshot>; setQuery: (query: string) => void; setOptions: (options: FindOptions) => void; next: (direction?: 1 | -1) => boolean;
    replaceCurrent: (replacement: string) => boolean; replaceAll: (replacement: string) => void; cancel: () => void; destroy: () => void }>;

/** Host-rendered find UI; scanning/planning yield, while replacement uses one captured transaction. */
export function createFindController(workspace: Workspace, tabId: TabId, editor: EditingCandidate): FindController {
    const target = workspace.captureTab(tabId), tab = workspace.resolveTab(target);
    if (!tab || tab.surface.kind !== "text" || tab.surface.documentId !== editor.view.documentId || !workspace.ownsDocumentView(editor.view)) throw new Error("Find requires the captured document view.");
    const documentId = tab.surface.documentId, resource = workspace.resourceForDocument(documentId), lease = workspace.acquire(resource.id), owner = editor.element.ownerDocument, win = owner.defaultView!;
    const scope = new NotificationScope(() => {}), initial = workspace.document(documentId);
    const store = new Store<FindSnapshot>(Object.freeze({ query: "", wholeWord: false, matchCase: true, revision: initial.revision, status: "idle", count: 0, scanned: 0, length: initial.buffer.length,
        current: null, preview: Object.freeze([]), message: "", maxScanStepMs: 0, replaceTransactionMs: 0 }), scope);
    let disposed = false, timer: number | undefined, cursor: LiteralSearch | undefined, generation = 0, focusGeneration = 0;
    let pages: number[][] = [], count = 0;
    const valid = () => !disposed && lease.active() && workspace.resolveTab(target) !== undefined && workspace.ownsDocumentView(editor.view)
        && workspace.observeDocument(documentId).getSnapshot() !== undefined && !editor.snapshot().disposed;
    const publish = (patch: Partial<FindSnapshot>) => { const changed = new Set<Store<unknown>>(); store.set(Object.freeze({ ...store.get(), ...patch }), changed); scope.deliver([...changed]); };
    const stop = () => { generation++; if (timer !== undefined) win.clearTimeout(timer); timer = undefined; cursor?.dispose(); cursor = undefined; };
    const later = (work: () => void) => { timer = win.setTimeout(() => { timer = undefined; work(); }, 0); };
    const offsetAt = (index: number) => pages[Math.floor(index / 1024)]![(index % 1024) * 2]!;
    const endAt = (index: number) => pages[Math.floor(index / 1024)]![(index % 1024) * 2 + 1]!;
    const indexAt = (offset: number) => {
        let low = 0, high = count;
        while (low < high) { const middle = (low + high) >>> 1; if (offsetAt(middle) < offset) low = middle + 1; else high = middle; }
        return low;
    };
    const canEdit = () => { const state = resource.getSnapshot(); return state.state === "ready" && state.metadata.capabilities.edit.includes("human") && state.metadata.editLock === null; };
    function restart(query: string, wholeWord = store.get().wholeWord, matchCase = store.get().matchCase): void {
        stop(); pages = []; count = 0;
        if (!valid()) { publish({ status: "expired", count: 0, current: null, preview: Object.freeze([]), message: "View is unavailable." }); return; }
        const document = workspace.document(documentId), token = generation;
        publish({ query, wholeWord, matchCase, revision: document.revision, status: query ? "searching" : "idle", count: 0, scanned: 0, length: document.buffer.length,
            current: null, preview: Object.freeze([]), message: "", maxScanStepMs: 0 });
        if (!query) return;
        cursor = new LiteralSearch(document.buffer, query, { wholeWord, matchCase });
        const step = () => {
            if (token !== generation || !valid()) { if (token === generation) restart(query); return; }
            const started = win.performance.now(), result = cursor!.next();
            for (const match of result.matches) { if (count % 1024 === 0) pages.push([]); pages.at(-1)!.push(match.from, match.to); count++; }
            const previous = store.get().preview, preview = previous.length < 200 && result.matches.length ? Object.freeze([...previous, ...result.matches.slice(0, 200 - previous.length)]) : previous;
            publish({ count, preview, scanned: result.scanned, status: result.done ? "ready" : "searching", maxScanStepMs: Math.max(store.get().maxScanStepMs, win.performance.now() - started) });
            if (result.done) cursor = undefined; else later(step);
        }; later(step);
    }
    const currentRange = (): SearchMatch | undefined => {
        const state = store.get(); if (!valid() || state.status !== "ready" || state.revision !== workspace.document(documentId).revision) return undefined;
        const selected = editor.view.getSnapshot().selection, low = Math.min(selected.anchor, selected.head), high = Math.max(selected.anchor, selected.head);
        if (!state.query) return undefined;
        const index = indexAt(low);
        if (index < count && offsetAt(index) === low && endAt(index) === high) return { from: low, to: high };
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
        const state = store.get(); if (!valid() || state.status !== "ready" || !count) return false;
        if (editor.snapshot().composing) { publish({ message: "Finish composition before navigating." }); return false; }
        const selected = editor.view.getSnapshot().selection, bound = direction === 1 ? Math.max(selected.anchor, selected.head) : Math.min(selected.anchor, selected.head);
        const low = indexAt(bound);
        const index = direction === 1 ? low % count : (low + count - 1) % count, from = offsetAt(index), to = endAt(index);
        if (!editor.view.setSelection(state.revision, { anchor: from, head: to })) return false;
        publish({ current: index, message: "" }); editor.viewport.revealOffset(from); editor.focus(); return true;
    };
    const replaceCurrent = (replacement: string): boolean => {
        scope.assertWritable(); if (typeof replacement !== "string") throw new TypeError("Expected replacement text.");
        if (editor.snapshot().composing && valid()) { publish({ message: "Finish composition before replacing." }); return false; }
        const match = currentRange(); if (!match) return next();
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
        if (editor.snapshot().composing) { publish({ message: "Finish composition before replacing." }); return; }
        stop(); const token = generation, focusToken = focusGeneration, positions = pages, total = count, edits: TextEdit[] = [], selectionSet = editor.view.getSnapshot().selectionSet; let index = 0;
        publish({ status: "replacing", message: "" });
        const step = () => {
            if (token !== generation) return;
            if (!valid() || workspace.document(documentId).revision !== state.revision || editor.view.getSnapshot().selectionSet !== selectionSet) { restart(state.query); return; }
            const stopAt = Math.min(total, index + 1024);
            for (; index < stopAt; index++) { const page = positions[Math.floor(index / 1024)]!, local = (index % 1024) * 2; edits.push({ from: page[local]!, to: page[local + 1]!, insert: replacement }); }
            if (index < total) { later(step); return; }
            const started = win.performance.now(), result = workspace.edit({ documentId, expectedRevision: state.revision, origin: "human", edits, view: editor.view, history: { kind: "replace" } });
            publish({ replaceTransactionMs: win.performance.now() - started });
            if (!result.applied) { publish({ status: "ready", message: result.reason }); return; }
            if (workspace.document(documentId).revision === state.revision) publish({ status: "ready" });
            publish({ message: `Replaced ${total} matches.` });
            if (focusGeneration === focusToken) editor.focus();
        }; later(step);
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
        if (store.get().status === "cancelled" && valid()) { const current = workspace.document(documentId); publish({ revision: current.revision, length: current.buffer.length }); }
        else restart(store.get().query);
    }), workspace.tabState.subscribe(() => { if (!valid()) { stop(); pages = []; count = 0; publish({ status: "expired", count: 0, preview: Object.freeze([]), message: "View is unavailable." }); } })];
    return Object.freeze({ state: store.observable, setQuery: (query: string) => { scope.assertWritable(); if (typeof query !== "string") throw new TypeError("Expected a search string."); if (!disposed) restart(query); },
        setOptions: (options: FindOptions) => {
            scope.assertWritable(); if (options === null || typeof options !== "object" || (options.wholeWord !== undefined && typeof options.wholeWord !== "boolean" || options.matchCase !== undefined && typeof options.matchCase !== "boolean")) throw new TypeError("Expected find options.");
            const wholeWord = options.wholeWord ?? false, matchCase = options.matchCase ?? true;
            if (!disposed && (wholeWord !== store.get().wholeWord || matchCase !== store.get().matchCase)) restart(store.get().query, wholeWord, matchCase);
        },
        next, replaceCurrent, replaceAll, cancel: () => { scope.assertWritable(); if (!disposed) { stop(); pages = []; count = 0; publish({ status: "cancelled", count: 0, current: null, preview: Object.freeze([]), message: "Search cancelled." }); } },
        destroy: () => { if (disposed) return; scope.assertWritable(); stop(); disposed = true; pages = []; count = 0; subscriptions.forEach(unsubscribe => unsubscribe()); lease.release(); publish({ status: "disposed", query: "", count: 0, scanned: 0, length: 0, current: null, preview: Object.freeze([]) }); } });
}
