import { Store } from "../core/observable.ts";
import { FoldIndex, createFoldRegions } from "../core/folding.ts";
import { reconcileFoldRanges } from "../core/fold-discovery.ts";
import type { DiscoveredFold } from "../core/fold-discovery.ts";
import type { DocumentSnapshot, TabId, Workspace } from "../core/workspace.ts";
import type { EditingCandidate } from "./editing-candidate.ts";

export type FoldDiscoveryBatch = Readonly<{ ranges: readonly DiscoveredFold[]; isCurrent?: () => boolean }>;
export type FoldDiscoveryResult = readonly DiscoveredFold[] | Generator<void, readonly DiscoveredFold[]> | FoldDiscoveryBatch;
export type FoldDiscovery = (document: DocumentSnapshot, signal: AbortSignal) => FoldDiscoveryResult | Promise<FoldDiscoveryResult>;
export type FoldCommand = "collapse" | "expand" | "collapse-all" | "expand-all";
export type FoldingStatus = Readonly<{ status: "pending" | "ready" | "failed" | "disposed"; revision: number; regions: number; collapsed: number;
    groups: readonly string[]; message: string }>;

/** One discovery policy for one retained view. Providers own syntax; the editor owns fold projection. */
export function createFoldingController(workspace: Workspace, tabId: TabId, editor: EditingCandidate, discover: FoldDiscovery,
    options: Readonly<{ delayMs?: number }> = {}) {
    const target = workspace.captureTab(tabId), view = editor.view, win = editor.element.ownerDocument.defaultView!;
    const tab = workspace.resolveTab(target);
    if (tab?.surface.kind !== "text" || tab.surface.documentId !== view.documentId || !workspace.ownsDocumentView(view)) throw new Error("Invalid fold discovery view.");
    const delay = options.delayMs ?? 100;
    if (!Number.isFinite(delay) || delay < 0) throw new RangeError("Invalid fold discovery delay.");
    const notifications = workspace.createNotificationScope();
    const cell = new Store<FoldingStatus>(Object.freeze({ status: "pending", revision: workspace.document(view.documentId).revision,
        regions: 0, collapsed: 0, groups: Object.freeze([]), message: "Discovering folds…" }), notifications);
    const listeners = new AbortController(); let disposed = false, generation = 0, timer: number | undefined;
    let job: { generation: number; document: DocumentSnapshot; abort: AbortController; pumping?: boolean; iterator?: Generator<void, readonly DiscoveredFold[]> } | undefined;
    const available = () => !disposed && !editor.snapshot().disposed && workspace.ownsDocumentView(view) && !!workspace.resolveTab(target);
    const busy = () => { const state = editor.snapshot(); return state.composing || state.pendingInput || state.pendingCommand; };
    const publish = (status: FoldingStatus["status"], message = "") => {
        const folds = view.folding.getSnapshot(), groups = Object.freeze([...new Set(folds.regions.flatMap(range => range.group ? [range.group] : []))].sort());
        const changed = new Set<Store<unknown>>(); cell.set(Object.freeze({ status, revision: folds.revision, regions: folds.regions.length,
            collapsed: folds.index.collapsedCount, groups, message }), changed); notifications.deliver([...changed]);
    };
    const cancel = () => {
        generation++; if (timer !== undefined) win.clearTimeout(timer); timer = undefined;
        const previous = job; job = undefined; previous?.abort.abort();
        if (previous && !previous.pumping) previous.iterator?.return(Object.freeze([]));
    };
    const later = (work: () => void, ms: number) => { timer = win.setTimeout(() => { timer = undefined; work(); }, ms); };
    const current = (capture: NonNullable<typeof job>) => available() && job === capture && capture.generation === generation
        && workspace.document(view.documentId).buffer === capture.document.buffer && workspace.document(view.documentId).revision === capture.document.revision;
    const fail = (capture: NonNullable<typeof job>, error: unknown) => {
        if (!current(capture)) return; cancel(); publish("failed", error instanceof Error ? error.message : "Fold discovery failed.");
    };
    const accept = (capture: NonNullable<typeof job>, ranges: readonly DiscoveredFold[], authority?: () => boolean) => {
        if (!current(capture)) return;
        if (authority && !authority()) { fail(capture, new Error("Fold provider capture expired.")); return; }
        if (busy()) { later(() => accept(capture, ranges, authority), 16); return; }
        try {
            const before = view.folding.getSnapshot(), planned = reconcileFoldRanges(capture.document.buffer, ranges, before.regions);
            if (!view.folding.setRanges(before, planned)) throw new Error("Fold discovery target changed.");
            job = undefined; publish("ready");
        } catch (error) { fail(capture, error); }
    };
    const pump = (capture: NonNullable<typeof job>) => {
        if (!current(capture)) return;
        try {
            const start = win.performance.now(); let result, count = 0;
            do {
                capture.pumping = true;
                try { result = capture.iterator!.next(); } finally { capture.pumping = false; }
            } while (!result.done && current(capture) && ++count < 8 && win.performance.now() - start < 4);
            if (!current(capture)) { capture.iterator!.return(Object.freeze([])); return; }
            if (result.done) { delete capture.iterator; accept(capture, result.value); }
            else later(() => pump(capture), 0);
        } catch (error) { fail(capture, error); }
    };
    const start = () => {
        if (!available()) { cancel(); return; }
        if (busy()) { later(start, 16); return; }
        const capture = { generation, document: workspace.document(view.documentId), abort: new AbortController() }; job = capture;
        void Promise.resolve().then(() => current(capture) ? discover(capture.document, capture.abort.signal) : []).then(result => {
            if (!current(capture)) { if ("next" in result) result.return([]); return; }
            if (Array.isArray(result)) accept(capture, result);
            else if ("ranges" in result) accept(capture, result.ranges, result.isCurrent);
            else { job!.iterator = result as Generator<void, readonly DiscoveredFold[]>; pump(job!); }
        }).catch(error => fail(capture, error));
    };
    const refresh = () => { if (!available()) return; cancel(); publish("pending", "Discovering folds…"); later(start, delay); };
    let observed = workspace.document(view.documentId).buffer;
    const stopDocument = workspace.observeDocument(view.documentId).subscribe(() => {
        const next = workspace.observeDocument(view.documentId).getSnapshot();
        if (!next) { cancel(); return; }
        if (next.buffer !== observed) { observed = next.buffer; refresh(); }
    });
    const stopTab = workspace.tabState.subscribe(() => { if (!available()) cancel(); });
    const stopFolds = view.folding.subscribe(() => { if (!disposed) publish(cell.get().status, cell.get().message); });
    const runCommand = (command: FoldCommand, group?: string): boolean => {
        notifications.assertWritable();
        if (!available() || busy()) return false;
        const document = workspace.document(view.documentId), before = view.folding.getSnapshot(), state = view.getSnapshot();
        const line = document.buffer.lineAt(state.selection.head), collapse = command === "collapse" || command === "collapse-all";
        let candidates = before.regions.filter(range => group === undefined || range.group === group);
        if (command === "collapse" || command === "expand") {
            candidates = candidates.filter(range => range.lineFrom <= line && line < range.lineTo && range.collapsed !== collapse);
            const chosen = collapse ? candidates.at(-1) : candidates[0]; candidates = chosen ? [chosen] : [];
        }
        if (!candidates.length) return false;
        const ids = new Set(candidates.map(range => range.id));
        const ranges = createFoldRegions(document.buffer, before.regions.map(range => ids.has(range.id) ? { ...range, collapsed: collapse } : range), before.regions);
        if (collapse) {
            const index = new FoldIndex(document.buffer.lineCount, ranges);
            const selections = state.selectionSet.ranges.map(range => {
                const anchor = index.hiddenBy(document.buffer.lineAt(range.anchor)), head = index.hiddenBy(document.buffer.lineAt(range.head));
                return { ...range, anchor: anchor ? document.buffer.offsetAt(anchor.lineFrom) : range.anchor, head: head ? document.buffer.offsetAt(head.lineFrom) : range.head };
            });
            if (!view.setSelections(document.revision, selections, state.selectionSet.primary)) return false;
        }
        const latest = view.folding.getSnapshot();
        if (!available() || latest.revision !== document.revision || latest.regions !== before.regions) return false;
        const applied = view.folding.setRanges(latest, ranges);
        if (applied) { editor.viewport.revealOffset(view.getSnapshot().selection.head); editor.focus(); }
        return applied;
    };
    editor.element.addEventListener("keydown", event => {
        if (event.defaultPrevented || event.isComposing || !(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey) return;
        const command = event.code === "BracketLeft" ? "collapse" : event.code === "BracketRight" ? "expand" : undefined;
        if (command && runCommand(command)) event.preventDefault();
    }, { signal: listeners.signal });
    refresh();
    return Object.freeze({ state: cell.observable, refresh: () => { notifications.assertWritable(); refresh(); }, runCommand, dispose: () => {
        if (disposed) return; notifications.assertWritable(); disposed = true; cancel(); listeners.abort(); stopDocument(); stopTab(); stopFolds(); publish("disposed");
    } });
}
export type FoldingController = ReturnType<typeof createFoldingController>;
