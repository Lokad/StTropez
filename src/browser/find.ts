import { LiteralSearch } from "../index.ts";
import type { Observable, SearchMatch, TabId, TextEdit, Workspace } from "../index.ts";
import { NotificationScope, Store } from "../core/observable.ts";
import type { EditingCandidate } from "./editing-candidate.ts";
export type FindSnapshot = Readonly<{ query: string; revision: number; status: "idle" | "searching" | "ready" | "replacing" | "cancelled" | "expired" | "disposed";
    count: number; scanned: number; length: number; current: number | null; preview: readonly SearchMatch[]; message: string; maxScanStepMs: number; replaceTransactionMs: number }>;
export type FindController = Readonly<{ state: Observable<FindSnapshot>; setQuery: (query: string) => void; next: (direction?: 1 | -1) => boolean;
    replaceCurrent: (replacement: string) => boolean; replaceAll: (replacement: string) => void; cancel: () => void; destroy: () => void }>;

/** Host-rendered find UI; scanning/planning yield, while replacement uses one captured transaction. */
export function createFindController(workspace: Workspace, tabId: TabId, editor: EditingCandidate): FindController {
    const target = workspace.captureTab(tabId), tab = workspace.resolveTab(target);
    if (!tab || tab.surface.kind !== "text" || tab.surface.documentId !== editor.view.documentId || !workspace.ownsDocumentView(editor.view)) throw new Error("Find requires the captured document view.");
    const documentId = tab.surface.documentId, resource = workspace.resourceForDocument(documentId), lease = workspace.acquire(resource.id), win = editor.element.ownerDocument.defaultView!;
    const scope = new NotificationScope(() => {}), initial = workspace.document(documentId);
    const store = new Store<FindSnapshot>(Object.freeze({ query: "", revision: initial.revision, status: "idle", count: 0, scanned: 0, length: initial.buffer.length,
        current: null, preview: Object.freeze([]), message: "", maxScanStepMs: 0, replaceTransactionMs: 0 }), scope);
    let disposed = false, timer: number | undefined, cursor: LiteralSearch | undefined, generation = 0;
    let pages: number[][] = [], count = 0;
    const valid = () => !disposed && lease.active() && workspace.resolveTab(target) !== undefined && workspace.ownsDocumentView(editor.view)
        && workspace.observeDocument(documentId).getSnapshot() !== undefined && !editor.snapshot().disposed;
    const publish = (patch: Partial<FindSnapshot>) => { const changed = new Set<Store<unknown>>(); store.set(Object.freeze({ ...store.get(), ...patch }), changed); scope.deliver([...changed]); };
    const stop = () => { generation++; if (timer !== undefined) win.clearTimeout(timer); timer = undefined; cursor?.dispose(); cursor = undefined; };
    const later = (work: () => void) => { timer = win.setTimeout(() => { timer = undefined; work(); }, 0); };
    const offsetAt = (index: number) => pages[Math.floor(index / 1024)]![index % 1024]!;
    const canEdit = () => { const state = resource.getSnapshot(); return state.state === "ready" && state.metadata.capabilities.edit.includes("human") && state.metadata.editLock === null; };
    function restart(query: string): void {
        stop(); pages = []; count = 0;
        if (!valid()) { publish({ status: "expired", count: 0, current: null, preview: Object.freeze([]), message: "View is unavailable." }); return; }
        const document = workspace.document(documentId), token = generation;
        publish({ query, revision: document.revision, status: query ? "searching" : "idle", count: 0, scanned: 0, length: document.buffer.length,
            current: null, preview: Object.freeze([]), message: "", maxScanStepMs: 0 });
        if (!query) return;
        cursor = new LiteralSearch(document.buffer, query);
        const step = () => {
            if (token !== generation || !valid()) { if (token === generation) restart(query); return; }
            const started = win.performance.now(), result = cursor!.next();
            for (const match of result.matches) { if (count % 1024 === 0) pages.push([]); pages.at(-1)!.push(match.from); count++; }
            const previous = store.get().preview, preview = previous.length < 200 && result.matches.length ? Object.freeze([...previous, ...result.matches.slice(0, 200 - previous.length)]) : previous;
            publish({ count, preview, scanned: result.scanned, status: result.done ? "ready" : "searching", maxScanStepMs: Math.max(store.get().maxScanStepMs, win.performance.now() - started) });
            if (result.done) cursor = undefined; else later(step);
        }; later(step);
    }
    const currentRange = (): SearchMatch | undefined => {
        const state = store.get(); if (!valid() || state.status !== "ready" || state.revision !== workspace.document(documentId).revision) return undefined;
        const selected = editor.view.getSnapshot().selection, low = Math.min(selected.anchor, selected.head), high = Math.max(selected.anchor, selected.head);
        if (high - low !== state.query.length || !state.query || workspace.document(documentId).buffer.slice(low, high) !== state.query) return undefined;
        return { from: low, to: high };
    };
    const next = (direction: 1 | -1 = 1): boolean => {
        scope.assertWritable(); if (direction !== 1 && direction !== -1) throw new RangeError("Invalid search direction.");
        const state = store.get(); if (!valid() || state.status !== "ready" || !count) return false;
        const selected = editor.view.getSnapshot().selection, bound = direction === 1 ? Math.max(selected.anchor, selected.head) : Math.min(selected.anchor, selected.head);
        let low = 0, high = count;
        while (low < high) { const middle = (low + high) >>> 1; if (offsetAt(middle) < bound) low = middle + 1; else high = middle; }
        const index = direction === 1 ? low % count : (low + count - 1) % count, from = offsetAt(index), to = from + state.query.length;
        if (!editor.view.setSelection(state.revision, { anchor: from, head: to })) return false;
        publish({ current: index, message: "" }); editor.viewport.revealOffset(from); editor.focus(); return true;
    };
    const replaceCurrent = (replacement: string): boolean => {
        scope.assertWritable(); if (typeof replacement !== "string") throw new TypeError("Expected replacement text.");
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
        stop(); const token = generation, positions = pages, total = count, edits: TextEdit[] = [], selection = editor.view.getSnapshot().selection; let index = 0;
        publish({ status: "replacing", message: "" });
        const step = () => {
            if (token !== generation) return;
            if (!valid() || workspace.document(documentId).revision !== state.revision || editor.view.getSnapshot().selection !== selection) { restart(state.query); return; }
            const stopAt = Math.min(total, index + 1024);
            for (; index < stopAt; index++) { const from = positions[Math.floor(index / 1024)]![index % 1024]!; edits.push({ from, to: from + state.query.length, insert: replacement }); }
            if (index < total) { later(step); return; }
            const started = win.performance.now(), result = workspace.edit({ documentId, expectedRevision: state.revision, origin: "human", edits, view: editor.view, history: { kind: "replace" } });
            publish({ replaceTransactionMs: win.performance.now() - started });
            if (!result.applied) { publish({ status: "ready", message: result.reason }); return; }
            if (workspace.document(documentId).revision === state.revision) publish({ status: "ready" });
            publish({ message: `Replaced ${total} matches.` }); editor.focus();
        }; later(step);
    };
    const subscriptions = [workspace.observeDocument(documentId).subscribe(() => {
        if (store.get().status === "cancelled" && valid()) { const current = workspace.document(documentId); publish({ revision: current.revision, length: current.buffer.length }); }
        else restart(store.get().query);
    }), workspace.tabState.subscribe(() => { if (!valid()) { stop(); pages = []; count = 0; publish({ status: "expired", count: 0, preview: Object.freeze([]), message: "View is unavailable." }); } })];
    return Object.freeze({ state: store.observable, setQuery: (query: string) => { scope.assertWritable(); if (typeof query !== "string") throw new TypeError("Expected a search string."); if (!disposed) restart(query); },
        next, replaceCurrent, replaceAll, cancel: () => { scope.assertWritable(); if (!disposed) { stop(); pages = []; count = 0; publish({ status: "cancelled", count: 0, current: null, preview: Object.freeze([]), message: "Search cancelled." }); } },
        destroy: () => { if (disposed) return; scope.assertWritable(); stop(); disposed = true; pages = []; count = 0; subscriptions.forEach(unsubscribe => unsubscribe()); lease.release(); publish({ status: "disposed", query: "", count: 0, scanned: 0, length: 0, current: null, preview: Object.freeze([]) }); } });
}
