import { Store } from "../core/observable.ts";
import { createFoldRegions } from "../core/folding.ts";
import { reconcileFoldRanges } from "../core/fold-discovery.ts";
import type { DiscoveredFold } from "../core/fold-discovery.ts";
import type { DocumentSnapshot, TabId, Workspace } from "../core/workspace.ts";
import type { TextEditor } from "./text-editor.ts";
import type { FoldRegion } from "../core/folding.ts";
import { commandBudget, createCooperativeRunner } from "./cooperative-runner.ts";
import type { KernelCursor, KernelStatus } from "../core/kernel-cursor.ts";

export type FoldDiscoveryBatch = Readonly<{ ranges: readonly DiscoveredFold[]; isCurrent?: () => boolean }>;
export type FoldDiscoveryCursor = KernelCursor<Readonly<{ status: KernelStatus; result: readonly DiscoveredFold[] | null; failure: string | null }>>;
export type FoldDiscoveryResult = readonly DiscoveredFold[] | FoldDiscoveryCursor | FoldDiscoveryBatch;
export type FoldDiscovery = (document: DocumentSnapshot, signal: AbortSignal) => FoldDiscoveryResult | Promise<FoldDiscoveryResult>;
export type FoldCommand = "collapse" | "expand" | "collapse-all" | "expand-all";
export type FoldingStatus = Readonly<{ status: "pending" | "ready" | "failed" | "disposed"; revision: number; regions: number; collapsed: number;
    groups: readonly string[]; message: string }>;

/** One discovery policy for one retained view. Providers own syntax; the editor owns fold projection. */
export function createFoldingController(workspace: Workspace, tabId: TabId, editor: TextEditor, discover: FoldDiscovery,
    options: Readonly<{ delayMs?: number }> = {}) {
    const target = workspace.captureTab(tabId), view = editor.view, win = editor.element.ownerDocument.defaultView!;
    const tab = workspace.resolveTab(target);
    if (tab?.surface.kind !== "text" || tab.surface.documentId !== view.documentId || !workspace.ownsDocumentView(view)) throw new Error("Invalid fold discovery view.");
    const delay = options.delayMs ?? 100;
    if (!Number.isFinite(delay) || delay < 0) throw new RangeError("Invalid fold discovery delay.");
    const notifications = workspace.createNotificationScope();
    const cell = new Store<FoldingStatus>(Object.freeze({ status: "pending", revision: workspace.document(view.documentId).revision,
        regions: 0, collapsed: 0, groups: Object.freeze([]), message: "Discovering folds…" }), notifications);
    const listeners = new AbortController(), runner = createCooperativeRunner(win); let disposed = false, generation = 0;
    let job: { generation: number; document: DocumentSnapshot; abort: AbortController; pumping?: boolean; cursor?: FoldDiscoveryCursor } | undefined;
    const available = () => !disposed && !editor.activity().disposed && workspace.ownsDocumentView(view) && !!workspace.resolveTab(target);
    const busy = () => { const state = editor.activity(); return state.composing || state.pendingInput || state.pendingCommand; };
    let groupRegions: readonly FoldRegion[] | undefined, groups: readonly string[] = Object.freeze([]);
    const publish = (status: FoldingStatus["status"], message = "") => {
        const folds = view.folding.getSnapshot();
        if (folds.regions !== groupRegions) {
            groupRegions = folds.regions; groups = Object.freeze([...new Set(groupRegions.flatMap(range => range.group ? [range.group] : []))].sort());
        }
        notifications.publish(cell, Object.freeze({ status, revision: folds.revision, regions: folds.regions.length,
            collapsed: folds.index.collapsedCount, groups, message }));
    };
    const release = (capture: NonNullable<typeof job>) => { const cursor = capture.cursor; delete capture.cursor; cursor?.dispose(); };
    const cancel = () => {
        generation++; runner.cancel();
        const previous = job; job = undefined; previous?.abort.abort();
        if (previous && !previous.pumping) release(previous);
    };
    const later = (work: () => void, ms: number) => { runner.schedule(work, ms); };
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
            const result = runner.slice(() => {
                capture.pumping = true;
                try { return capture.cursor!.next(commandBudget.cursorUnits); } finally { capture.pumping = false; }
            }, result => result.status === "running" && current(capture), commandBudget.foldCalls);
            if (!current(capture)) { release(capture); return; }
            if (result.status === "running") later(() => pump(capture), 0);
            else if (result.status === "ready" && result.result !== null) { release(capture); accept(capture, result.result); }
            else fail(capture, new Error(result.failure ?? "Fold discovery ended without a result."));
        } catch (error) { if (!current(capture)) release(capture); else fail(capture, error); }
    };
    const start = () => {
        if (!available()) { cancel(); return; }
        if (busy()) { later(start, 16); return; }
        const capture = { generation, document: workspace.document(view.documentId), abort: new AbortController() }; job = capture;
        void Promise.resolve().then(() => current(capture) ? discover(capture.document, capture.abort.signal) : []).then(result => {
            if (!current(capture)) { if ("next" in result) result.dispose(); return; }
            if (Array.isArray(result)) accept(capture, result);
            else if ("ranges" in result) accept(capture, result.ranges, result.isCurrent);
            else { job!.cursor = result as FoldDiscoveryCursor; pump(job!); }
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
    const commandFilter = (command: FoldCommand, group?: string) => {
        const collapse = command === "collapse" || command === "collapse-all";
        const atCaret = command === "collapse" || command === "expand";
        const line = atCaret ? workspace.document(view.documentId).buffer.lineAt(view.getSnapshot().selection.head) : 0;
        return (range: FoldRegion) => range.collapsed !== collapse && (group === undefined || range.group === group)
            && (!atCaret || range.lineFrom <= line && line < range.lineTo);
    };
    const canRunCommand = (command: FoldCommand, group?: string) =>
        available() && !busy() && view.folding.getSnapshot().regions.some(commandFilter(command, group));
    const runCommand = (command: FoldCommand, group?: string): boolean => {
        notifications.assertWritable();
        if (!available() || busy()) return false;
        const document = workspace.document(view.documentId), before = view.folding.getSnapshot(), state = view.getSnapshot();
        const line = document.buffer.lineAt(state.selection.head), collapse = command === "collapse" || command === "collapse-all";
        let candidates = before.regions.filter(commandFilter(command, group));
        if (command === "collapse" || command === "expand") {
            const chosen = collapse ? candidates.at(-1) : candidates[0]; candidates = chosen ? [chosen] : [];
        }
        if (!candidates.length) return false;
        const ids = new Set(candidates.map(range => range.id));
        const ranges = createFoldRegions(document.buffer, before.regions.map(range => ids.has(range.id) ? { ...range, collapsed: collapse } : range), before.regions);
        const latest = view.folding.getSnapshot();
        if (!available() || latest.revision !== document.revision || latest.regions !== before.regions) return false;
        const applied = view.folding.setRanges(latest, ranges);
        if (applied) {
            // Collapse changes projection, not the logical selection. Reveal the visible header
            // edge instead of the hidden head, since revealOffset would otherwise reopen it.
            const hidden = view.folding.getSnapshot().index.hiddenBy(line);
            editor.viewport.revealOffset(hidden ? document.buffer.offsetAt(hidden.lineFrom + 1) - 1 : state.selection.head);
            editor.focus();
        }
        return applied;
    };
    // Handle folds before ordinary navigation reveals a hidden logical caret.
    editor.element.addEventListener("keydown", event => {
        if (event.defaultPrevented || event.isComposing || !(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey) return;
        const command = event.code === "BracketLeft" ? "collapse" : event.code === "BracketRight" ? "expand" : undefined;
        if (command && runCommand(command)) event.preventDefault();
    }, { capture: true, signal: listeners.signal });
    refresh();
    return Object.freeze({ ...cell.observable, refresh: () => { notifications.assertWritable(); refresh(); }, canRunCommand, runCommand, dispose: () => {
        if (disposed) return; notifications.assertWritable(); disposed = true; cancel(); listeners.abort(); stopDocument(); stopTab(); stopFolds(); publish("disposed");
    } });
}
export type FoldingController = ReturnType<typeof createFoldingController>;
