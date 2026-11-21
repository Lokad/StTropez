import { TextBuffer } from "./text-buffer.ts";
import { TextDiff } from "./diff.ts";
import type { DiffHunk, DiffProgress } from "./diff.ts";
import { Store } from "./observable.ts";
import { validateWorkBudget } from "./kernel-cursor.ts";
import { mapComparisonHunks } from "./comparison-presentation.ts";
import type { Observable } from "./observable.ts";
import { captureTextSurface, ownsTextSurface } from "./workspace.ts";
import type { DocumentId, DocumentSnapshot, DocumentView, ResourceLease, TabId, TabTarget, Workspace } from "./workspace.ts";
import type { SelectionSet } from "./selections.ts";

export type ComparisonBaseline = Readonly<{ buffer: TextBuffer; version: string }>;
export type ComparisonSnapshot = Readonly<{
    status: "running" | "ready" | "failed" | "expired" | "disposed";
    generation: number; baseline: (ComparisonBaseline & Readonly<{ epoch: number }>) | null;
    working: DocumentSnapshot | null;
    /** Exact when ready; while running, mapped prior hunks are presentation only. */
    hunks: readonly DiffHunk[]; progress: DiffProgress | null; failure: string | null;
}>;
export type ComparisonCapture = Readonly<{
    baselineEpoch: number; baselineVersion: string; working: DocumentSnapshot; serverVersion: string | null;
}>;
export type ComparisonTicket = Readonly<{
    kind: "refresh" | "accept"; capture: ComparisonCapture; isCurrent: () => boolean;
    complete: (baseline: ComparisonBaseline) => boolean; cancel: () => void; finish: () => void;
}>;
export type ComparisonReversion = Readonly<{
    kind: "revert"; capture: ComparisonCapture & Readonly<{ generation: number; tab?: TabTarget; selectionSet: SelectionSet }>;
    isCurrent: () => boolean; complete: () => boolean; cancel: () => void; finish: () => void;
}>;
/** Exact hunk from one comparison run. Its action expires when either side changes. */
export type ComparisonHunk = DiffHunk & Readonly<{ revert: () => boolean }>;
export type ComparisonController = Observable<ComparisonSnapshot> & Readonly<{
    view: DocumentView; advance: (workBudget?: number) => ComparisonSnapshot;
    hunkAt: (index: number) => ComparisonHunk | undefined;
    beginRefresh: () => ComparisonTicket; beginAcceptance: () => ComparisonTicket; beginReversion: () => ComparisonReversion;
    dispose: () => void;
}>;
const empty: readonly DiffHunk[] = Object.freeze([]);
function baseline(value: ComparisonBaseline, epoch: number): ComparisonBaseline & Readonly<{ epoch: number }> {
    return Object.freeze({ buffer: value.buffer, version: value.version, epoch });
}

/** A reference version is independent of the working resource's saved/server version. No I/O or implicit save. */
export function createComparisonController(workspace: Workspace, identity: DocumentId | TabId, initial: ComparisonBaseline | DocumentId,
    options: Readonly<{ view?: DocumentView; onListenerError?: (error: unknown) => void }> = {}): ComparisonController {
    return compareText(workspace, identity, initial, options);
}

/** The browser can project an external reference into a retained document in the same publication. */
export function compareText(workspace: Workspace, identity: DocumentId | TabId, initial: ComparisonBaseline | DocumentId,
    options: Readonly<{ view?: DocumentView; onListenerError?: (error: unknown) => void }>,
    projectReference?: (next: ComparisonBaseline) => boolean): ComparisonController {
    const { documentId, resource, tab: target } = captureTextSurface(workspace, identity);
    const document = workspace.document(documentId);
    const referenceDocument = typeof initial === "string" ? workspace.observeDocument(initial) : undefined;
    const fromDocument = (value: DocumentSnapshot, epoch: number) => baseline({ buffer: value.buffer, version: String(value.revision) }, epoch);
    const initialBaseline = typeof initial === "string" ? fromDocument(workspace.document(initial), 0) : baseline(initial, 0);
    if (options.view && (options.view.documentId !== documentId || !workspace.ownsDocumentView(options.view))) throw new Error("View belongs to another document or workspace.");
    const retention = workspace.acquire(resource.id);
    let view: DocumentView;
    try { view = options.view ?? workspace.createDocumentView(documentId); } catch (error) { retention.release(); throw error; }
    const referenceLease = referenceDocument && workspace.acquire(referenceDocument.getSnapshot()!.resourceId);
    const scope = workspace.createNotificationScope(options.onListenerError);
    const state = new Store<ComparisonSnapshot>(Object.freeze({ status: "running", generation: 0, baseline: initialBaseline,
        working: document, hunks: empty, progress: null, failure: null }), scope);
    let job: TextDiff | undefined = new TextDiff(initialBaseline.buffer, document.buffer), disposed = false;
    let refreshGeneration = 0, acceptanceGeneration = 0, reversionGeneration = 0;
    let reversionPolicy = resource.metadata.getSnapshot(), reversionPolicyGeneration = 0;
    const pending = new Set<() => void>();
    const publish = (next: ComparisonSnapshot) => { scope.publish(state, Object.freeze(next)); };
    const live = () => !disposed && state.get().baseline !== null && ownsTextSurface(workspace, view, target)
        && resource.getSnapshot().state === "ready" && (!referenceDocument || !!referenceDocument.getSnapshot());
    const canAccept = () => live() && resource.metadata.getSnapshot().capabilities.edit.includes("human") && resource.metadata.getSnapshot().editLock === null;
    function expire(): void {
        job?.dispose(); job = undefined;
        publish({ status: "expired", generation: state.get().generation + 1, baseline: null, working: null, hunks: empty, progress: null, failure: null });
    }
    function restart(reference: ComparisonBaseline & Readonly<{ epoch: number }>, working: DocumentSnapshot): void {
        const previous = state.get(), change = working.change;
        const hunks = previous.baseline === reference && previous.working && change?.previousRevision === previous.working.revision
            ? mapComparisonHunks(reference.buffer, previous.working.buffer, working.buffer, change.mapping, previous.hunks) : empty;
        job?.dispose(); job = new TextDiff(reference.buffer, working.buffer);
        publish({ status: "running", generation: previous.generation + 1, baseline: reference, working, hunks, progress: null, failure: null });
    }
    const update = () => {
        if (disposed || state.get().status === "expired") return;
        const metadata = resource.metadata.getSnapshot();
        if (metadata.capabilities !== reversionPolicy.capabilities || metadata.editLock !== reversionPolicy.editLock || metadata.serverVersion !== reversionPolicy.serverVersion) reversionPolicyGeneration++;
        reversionPolicy = metadata;
        if (!live()) expire();
        else {
            const current = workspace.document(documentId), previous = state.get(), base = previous.baseline!, followed = referenceDocument?.getSnapshot();
            if (followed && base.version !== String(followed.revision)) restart(fromDocument(followed, base.epoch + 1), current);
            else if (previous.working?.revision !== current.revision) restart(base, current);
        }
    };
    const stopDocument = workspace.observeDocument(documentId).subscribe(update), stopMetadata = resource.metadata.subscribe(update);
    const stopTab = target && workspace.tabs.subscribe(update), stopReference = referenceDocument?.subscribe(update);
    function begin(kind: "refresh" | "accept"): ComparisonTicket {
        scope.assertWritable();
        if (referenceDocument) throw new Error("A followed reference changes through its workspace document.");
        if (!(kind === "accept" ? canAccept() : live())) throw new Error("Comparison command is unavailable.");
        const previous = state.get(), reference = previous.baseline!, working = workspace.document(documentId);
        const capture: ComparisonCapture = Object.freeze({ baselineEpoch: reference.epoch, baselineVersion: reference.version,
            working, serverVersion: resource.metadata.getSnapshot().serverVersion });
        const generation = kind === "refresh" ? ++refreshGeneration : ++acceptanceGeneration;
        const lease: ResourceLease = workspace.acquire(resource.id); let finished = false;
        const finish = () => { scope.assertWritable(); if (finished) return; lease.release(); finished = true; pending.delete(finish); };
        pending.add(finish);
        const isCurrent = () => !finished && live() && state.get().baseline!.epoch === capture.baselineEpoch
            && generation === (kind === "refresh" ? refreshGeneration : acceptanceGeneration);
        return Object.freeze({ kind, capture, isCurrent, complete: (value: ComparisonBaseline) => {
            scope.assertWritable();
            try {
                if (!isCurrent() || (kind === "accept" && !canAccept())) return false;
                // Acceptance always advances to the captured revision, even if more human edits arrived.
                const next = baseline(kind === "accept" ? { buffer: capture.working.buffer, version: value.version } : value, capture.baselineEpoch + 1);
                if (kind === "accept" && value.buffer !== capture.working.buffer) throw new Error("Acceptance must use its captured working buffer.");
                if (!projectReference) { restart(next, workspace.document(documentId)); return true; }
                return scope.batch(() => {
                    if (!projectReference(next)) return false;
                    restart(next, workspace.document(documentId)); return true;
                });
            } finally { finish(); }
        }, cancel: finish, finish });
    }
    function beginReversion(): ComparisonReversion {
        scope.assertWritable(); const current = state.get();
        if (!canAccept() || current.status !== "ready" || !current.baseline || !current.working) throw new Error("Comparison reversion is unavailable.");
        const capture = Object.freeze({ baselineEpoch: current.baseline.epoch, baselineVersion: current.baseline.version,
            working: current.working, serverVersion: resource.metadata.getSnapshot().serverVersion,
            generation: current.generation, ...(target ? { tab: target } : {}), selectionSet: view.getSnapshot().selectionSet });
        const refresh = refreshGeneration, acceptance = acceptanceGeneration,
            policy = reversionPolicyGeneration, generation = ++reversionGeneration;
        const lease = workspace.acquire(resource.id); let finished = false;
        const finish = () => { scope.assertWritable(); if (finished) return; finished = true; pending.delete(finish); lease.release(); };
        pending.add(finish);
        const isCurrent = () => !finished && canAccept() && policy === reversionPolicyGeneration && generation === reversionGeneration && refresh === refreshGeneration && acceptance === acceptanceGeneration
            && state.get().generation === capture.generation && workspace.document(documentId).revision === capture.working.revision
            && view.getSnapshot().selectionSet === capture.selectionSet && resource.metadata.getSnapshot().serverVersion === capture.serverVersion;
        return Object.freeze({ kind: "revert", capture, isCurrent, complete: () => {
            scope.assertWritable();
            try {
                if (!isCurrent()) return false;
                if (!current.hunks.length) return true;
                // Reuse finished comparison hunks: one original-coordinate transaction, no
                // new diff, full-document export or history mechanism. Other views map normally.
                const edits = current.hunks.map(hunk => ({ from: hunk.working.from, to: hunk.working.to,
                    insert: current.baseline!.buffer.slice(hunk.baseline.from, hunk.baseline.to) }));
                return workspace.edit({ documentId, expectedRevision: capture.working.revision, origin: "human", view,
                    history: { kind: "replace" }, edits }).applied;
            } finally { finish(); }
        }, cancel: finish, finish });
    }
    return Object.freeze({ ...state.observable, view, advance: (workBudget = 32768) => {
        scope.assertWritable();
        validateWorkBudget(workBudget, "Comparison");
        if (job && !live()) expire();
        if (job && live()) {
            try {
                const progress = job.next(workBudget), previous = state.get();
                if (progress.status === "ready") { job.dispose(); job = undefined; }
                publish({ ...previous, status: progress.status === "ready" ? "ready" : "running", progress, hunks: progress.status === "ready" ? progress.hunks : previous.hunks });
            } catch (error) {
                job?.dispose(); job = undefined;
                publish({ ...state.get(), status: "failed", failure: error instanceof Error ? error.message : "Comparison failed.", hunks: empty });
            }
        }
        return state.get();
    }, hunkAt: (index: number) => {
        const { status, generation, hunks } = state.get(), hunk = hunks[index];
        if (status !== "ready" || !Number.isSafeInteger(index) || !hunk) return;
        return Object.freeze({ ...hunk, revert: () => {
            scope.assertWritable(); const current = state.get();
            if (!canAccept() || generation !== current.generation || current.status !== "ready" || !current.working || !current.baseline) return false;
            const insert = current.baseline.buffer.slice(hunk.baseline.from, hunk.baseline.to);
            return workspace.edit({ documentId, expectedRevision: current.working.revision, origin: "human", view,
                history: { kind: "replace" }, edits: [{ from: hunk.working.from, to: hunk.working.to, insert }],
                selection: { anchor: hunk.working.from, head: hunk.working.from + insert.length } }).applied;
        } });
    }, beginRefresh: () => begin("refresh"), beginAcceptance: () => begin("accept"), beginReversion, dispose: () => {
        scope.assertWritable(); if (disposed) return;
        retention.release();
        for (const finish of [...pending]) finish();
        disposed = true; stopDocument(); stopMetadata(); stopTab?.(); stopReference?.(); referenceLease?.release(); job?.dispose(); job = undefined;
        if (!options.view) view.dispose();
        publish({ status: "disposed", generation: state.get().generation + 1, baseline: null, working: null, hunks: empty, progress: null, failure: null });
    } });
}
