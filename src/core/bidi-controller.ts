import { BidiCursor } from "./bidi-cursor.ts";
import type { BidiIndex, BidiStep } from "./bidi-cursor.ts";
import type { BidiDirection } from "./bidi.ts";
import { NotificationScope, Store } from "./observable.ts";
import { validateWorkBudget } from "./kernel-cursor.ts";
import type { Observable } from "./observable.ts";
import type { DocumentId, TabId, Workspace } from "./workspace.ts";

export type BidiProgress = Readonly<Pick<BidiStep, "phase" | "scannedUnits" | "readUnits" | "workUnits">>;
export type BidiIndexRequest = Readonly<{ expectedRevision: number; from: number; to: number }>;
export type BidiIndexSnapshot = Readonly<{ status: "idle" | "running" | "ready" | "cancelled" | "stale" | "expired" | "failed" | "disposed";
    documentId: DocumentId; revision: number | null; generation: number; range: Readonly<{ from: number; to: number }> | null;
    progress: BidiProgress | null; index: BidiIndex | null; failure: string | null }>;
export type BidiIndexController = Observable<BidiIndexSnapshot> & Readonly<{
    request: (request: BidiIndexRequest) => number | null; advance: (workBudget?: number) => BidiIndexSnapshot;
    isCurrent: (generation: number) => boolean; cancel: () => void; dispose: () => void;
}>;

/** Explicit range requests retain their resource, revision and tab generation. The host owns scheduling. */
export function createBidiIndexController(workspace: Workspace, tabId: TabId,
    options: Readonly<{ direction?: BidiDirection; onListenerError?: (error: unknown) => void }> = {}): BidiIndexController {
    const target = workspace.captureTab(tabId), tab = workspace.resolveTab(target);
    if (!tab || tab.surface.kind !== "text") throw new Error("Bidi indexing requires a text tab.");
    const documentId = tab.surface.documentId, document = workspace.observeDocument(documentId), resource = workspace.resourceForDocument(documentId);
    if (!document.getSnapshot()) throw new Error("Bidi indexing requires a ready document.");
    const direction = options.direction ?? "ltr";
    if (direction !== "ltr" && direction !== "rtl" && direction !== "auto") throw new TypeError("Invalid bidi direction.");
    const retention = workspace.acquire(resource.id), scope = new NotificationScope(options.onListenerError ?? (() => {}));
    const store = new Store<BidiIndexSnapshot>(Object.freeze({ status: "idle", documentId, revision: null, generation: 0, range: null, progress: null, index: null, failure: null }), scope);
    let cursor: BidiCursor | undefined, disposed = false;
    const live = () => !disposed && retention.active() && workspace.resolveTab(target) !== undefined && resource.getSnapshot().state === "ready" && document.getSnapshot() !== undefined;
    const publish = (patch: Partial<BidiIndexSnapshot>) => { const changed = new Set<Store<unknown>>(); store.set(Object.freeze({ ...store.get(), ...patch }), changed); scope.deliver([...changed]); };
    const stop = () => { cursor?.dispose(); cursor = undefined; };
    const reconcile = () => {
        if (disposed || store.get().status === "expired") return;
        const previous = store.get();
        if (!live()) { stop(); publish({ status: "expired", generation: previous.generation + 1, revision: null, range: null, progress: null, index: null, failure: null }); }
        else if (previous.revision !== null && document.getSnapshot()!.revision !== previous.revision && previous.status !== "stale") {
            stop(); publish({ status: "stale", generation: previous.generation + 1, progress: null, index: null, failure: null });
        }
    };
    const subscriptions = [document.subscribe(reconcile), workspace.tabState.subscribe(reconcile), resource.subscribe(reconcile)];
    return Object.freeze({ ...store.observable,
        request: ({ expectedRevision, from, to }: BidiIndexRequest) => {
            scope.assertWritable(); if (!live() || store.get().status === "expired") throw new Error("Bidi indexing is unavailable.");
            const captured = document.getSnapshot()!; if (captured.revision !== expectedRevision) return null;
            const next = new BidiCursor(captured.buffer, { from, to, direction }); stop(); cursor = next;
            const generation = store.get().generation + 1;
            publish({ status: "running", generation, revision: captured.revision, range: Object.freeze({ from, to }), progress: null, index: null, failure: null }); return generation;
        },
        advance: (workBudget = 4096) => {
            scope.assertWritable(); validateWorkBudget(workBudget, "Bidi"); reconcile();
            if (cursor) {
                try {
                    const step = cursor.next(workBudget), generation = store.get().generation;
                    // A cursor is synchronous; revision and tab validity are checked again before publication.
                    reconcile(); if (store.get().generation !== generation || !cursor) return store.get();
                    if (step.status === "ready") stop();
                    const progress = Object.freeze({ phase: step.phase, scannedUnits: step.scannedUnits, readUnits: step.readUnits, workUnits: step.workUnits });
                    publish({ status: step.status === "ready" ? "ready" : "running", progress, index: step.result });
                } catch (error) { stop(); publish({ status: "failed", index: null, failure: error instanceof Error ? error.message : "Bidi indexing failed." }); }
            } return store.get();
        },
        isCurrent: (generation: number) => live() && store.get().status === "ready" && store.get().generation === generation && store.get().revision === document.getSnapshot()!.revision,
        cancel: () => { scope.assertWritable(); if (disposed || store.get().status === "expired") return; stop(); publish({ status: "cancelled", generation: store.get().generation + 1, index: null, progress: null, failure: null }); },
        dispose: () => { scope.assertWritable(); if (disposed) return; disposed = true; stop(); subscriptions.forEach(unsubscribe => unsubscribe()); retention.release();
            publish({ status: "disposed", generation: store.get().generation + 1, revision: null, range: null, progress: null, index: null, failure: null }); }
    });
}
