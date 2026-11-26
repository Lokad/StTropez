import { builtinKeyPriority } from "./command-registry.ts";
import { emptyList } from "../core/empty-list.ts";
import { Store, type Observable } from "../core/observable.ts";
import { lineContentEnd } from "../core/newlines.ts";
import { reconcileFoldRanges } from "../core/fold-discovery.ts";
import type { DiscoveredFold } from "../core/fold-discovery.ts";
import type { DocumentSnapshot } from "../core/workspace.ts";
import type { TextEditor } from "./text-editor.ts";
import { createFoldRegions, foldSummary, matchingFoldIds, revealSelectionFolds } from "../core/folding.ts";
import { commandBudget, createCooperativeRunner } from "./cooperative-runner.ts";
import { controllerObservable } from "./controller-observable.ts";
import type { KernelCursor, KernelStatus } from "../core/kernel-cursor.ts";

export type FoldDiscoveryBatch = Readonly<{ ranges: readonly DiscoveredFold[]; isCurrent?: () => boolean }>;
export type FoldDiscoveryCursor = KernelCursor<Readonly<{ status: KernelStatus; result: readonly DiscoveredFold[] | null; failure: string | null }>>;
export type FoldDiscoveryResult = readonly DiscoveredFold[] | FoldDiscoveryCursor | FoldDiscoveryBatch;
export type FoldDiscovery = (document: DocumentSnapshot, signal: AbortSignal) => FoldDiscoveryResult | Promise<FoldDiscoveryResult>;
const foldLabels = { "fold.collapse": "Collapse block", "fold.expand": "Expand block",
    "fold.collapse-all": "Collapse group", "fold.expand-all": "Expand group" } as const;
export type FoldCommand = keyof typeof foldLabels;
export type FoldingStatus = Readonly<{ status: "pending" | "ready" | "failed" | "disposed"; revision: number; regions: number; collapsed: number;
    groups: readonly string[]; message: string }>;

export type FoldingController = Observable<FoldingStatus> & Readonly<{
    setCollapsed: (collapsed: boolean, group?: string) => boolean;
    refresh: () => void;
    dispose: () => void;
}>;

/** One discovery policy for one retained view. Providers own syntax; the editor owns fold projection. */
export function createFoldingController(editor: TextEditor, discover: FoldDiscovery,
    options: Readonly<{ delayMs?: number }> = {}): FoldingController {
    const { workspace, tab: target, view } = editor, win = editor.element.ownerDocument.defaultView!;
    if (editor.signal.aborted || !workspace.ownsDocumentView(view, target)) throw new Error("Invalid fold discovery view.");
    const delay = options.delayMs ?? 100;
    if (!Number.isFinite(delay) || delay < 0) throw new RangeError("Invalid fold discovery delay.");
    const notifications = workspace.createNotificationScope();
    const cell = new Store<FoldingStatus>(Object.freeze({ status: "pending", revision: workspace.document(view.documentId).revision,
        regions: 0, collapsed: 0, groups: emptyList, message: "Discovering folds…" }), notifications);
    const listeners = new AbortController(), runner = createCooperativeRunner(win);
    let disposed = false;
    let job: { document: DocumentSnapshot; abort: AbortController; pumping?: boolean; cursor?: FoldDiscoveryCursor } | undefined;
    const available = () => !disposed && !editor.activity().disposed && workspace.ownsDocumentView(view, target);
    const busy = () => editor.activity().input !== "idle";
    const publish = (status: FoldingStatus["status"], message = "") => {
        const folds = view.folding.getSnapshot(), summary = foldSummary(folds.index);
        notifications.publish(cell, Object.freeze({ status, revision: folds.revision, regions: summary.count,
            collapsed: folds.index.collapsedCount, groups: summary.groups, message }));
    };
    const release = (capture: NonNullable<typeof job>) => { const cursor = capture.cursor; delete capture.cursor; cursor?.dispose(); };
    const cancel = () => {
        runner.cancel();
        const previous = job; job = undefined; previous?.abort.abort();
        if (previous && !previous.pumping) release(previous);
    };
    const later = runner.schedule;
    const current = (capture: NonNullable<typeof job>) => {
        if (job !== capture || !available()) return false;
        const document = workspace.document(view.documentId);
        return document.buffer === capture.document.buffer && document.revision === capture.document.revision;
    };
    const fail = (capture: NonNullable<typeof job>, error: unknown) => {
        if (!current(capture)) return; cancel(); publish("failed", error instanceof Error ? error.message : "Fold discovery failed.");
    };
    const accept = (capture: NonNullable<typeof job>, ranges: readonly DiscoveredFold[], authority?: () => boolean) => {
        if (!current(capture)) return;
        if (authority && !authority()) { fail(capture, new Error("Fold provider capture expired.")); return; }
        if (busy()) { later(() => accept(capture, ranges, authority), 16); return; }
        try {
            const before = view.folding.getSnapshot(), buffer = capture.document.buffer;
            const matched = reconcileFoldRanges(buffer, ranges, before.regions);
            const regions = createFoldRegions(buffer, matched, before.regions);
            const planned = regions === before.regions ? regions
                : revealSelectionFolds(buffer, regions, view.getSnapshot().selectionSet, before.index);
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
        const capture = { document: workspace.document(view.documentId), abort: new AbortController() };
        job = capture;
        void Promise.resolve().then(() => current(capture) ? discover(capture.document, capture.abort.signal) : []).then(result => {
            if (!current(capture)) { if ("next" in result) result.dispose(); return; }
            if (Array.isArray(result)) accept(capture, result);
            else if ("ranges" in result) accept(capture, result.ranges, result.isCurrent);
            else { job!.cursor = result as FoldDiscoveryCursor; pump(job!); }
        }).catch(error => fail(capture, error));
    };
    const refresh = () => { if (!available()) return; cancel(); publish("pending", "Discovering folds…"); later(start, delay); };
    const commandTargets = (command: FoldCommand, group?: string) => {
        const collapsed = command === "fold.expand" || command === "fold.expand-all";
        const atCaret = command === "fold.collapse" || command === "fold.expand";
        const line = atCaret ? workspace.document(view.documentId).buffer.lineAt(view.getSnapshot().selection.head) : undefined;
        return matchingFoldIds(view.folding.getSnapshot().index, collapsed, group, line);
    };
    const runCommand = (command: FoldCommand, group: unknown, activate = true): boolean => {
        notifications.assertWritable();
        if (group !== undefined && typeof group !== "string") return false;
        const before = view.folding.getSnapshot();
        const collapse = command === "fold.collapse" || command === "fold.collapse-all";
        let candidates = [...commandTargets(command, group)];
        if (command === "fold.collapse" || command === "fold.expand") {
            const chosen = collapse ? candidates.at(-1) : candidates[0]; candidates = chosen ? [chosen] : [];
        }
        if (!candidates.length) return false;
        const applied = view.folding.setCollapsed(before, candidates, collapse, { moveHiddenCarets: activate });
        if (applied && activate) {
            // A nonempty selection can intentionally end in the hidden body.
            const buffer = workspace.document(view.documentId).buffer;
            const head = view.getSnapshot().selection.head;
            const hidden = view.folding.getSnapshot().index.hiddenBy(buffer.lineAt(head));
            editor.viewport.revealOffset(hidden ? lineContentEnd(buffer, hidden.lineFrom) : head);
            editor.focus();
        }
        return applied;
    };
    const registrations: { dispose(): void }[] = [];
    try {
        for (const id of Object.keys(foldLabels) as FoldCommand[]) {
            registrations.push(editor.commands.register({ id, label: foldLabels[id], owner: "editor", category: "Folding",
                enabled: group => available() && !busy() && (group === undefined || typeof group === "string")
                    && !commandTargets(id, group).next().done,
                run: group => runCommand(id, group) }));
        }
        editor.keymap.bind("Mod+Shift+[", "fold.collapse", { shared: true, priority: builtinKeyPriority.editor });
        editor.keymap.bind("Mod+Shift+]", "fold.expand", { shared: true, priority: builtinKeyPriority.editor });
    } catch (error) {
        for (const registration of registrations) registration.dispose();
        throw error;
    }
    let observed = workspace.document(view.documentId).revision;
    const stopDocument = workspace.observeDocument(view.documentId).subscribe(() => {
        const next = workspace.observeDocument(view.documentId).getSnapshot();
        if (!next) { cancel(); return; }
        if (next.revision !== observed) { observed = next.revision; refresh(); }
    });
    const stopTab = target && workspace.tabs.subscribe(() => { if (!available()) cancel(); });
    const stopFolds = view.folding.subscribe(() => { if (!disposed) publish(cell.get().status, cell.get().message); });
    const dispose = () => {
        if (disposed) return;
        notifications.assertWritable();
        disposed = true;
        for (const registration of registrations) registration.dispose();
        cancel();
        listeners.abort();
        stopDocument();
        stopTab?.();
        stopFolds();
        publish("disposed");
        cell.clearSnapshotListeners();
    };
    editor.signal.addEventListener("abort", dispose, { once: true, signal: listeners.signal });
    refresh();
    return Object.freeze({ ...controllerObservable(cell, "Folding", () => disposed),
        setCollapsed: (collapsed: boolean, group?: string) => available() && !busy()
            && runCommand(collapsed ? "fold.collapse-all" : "fold.expand-all", group, false),
        refresh: () => { notifications.assertWritable(); refresh(); }, dispose });
}
