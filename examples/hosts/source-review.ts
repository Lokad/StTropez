import { TextBuffer } from "../../src/index.ts";
import type { ComparisonBaseline, Observable, Operation, SaveReview, SaveSubmission, TabTarget, TextResourceHandle, Workspace } from "../../src/index.ts";
import type { SavePort, HostSaveQueue } from "../shared/save-queue.ts";
import { HostCell } from "../shared/observable.ts";
import { ReviewVariants } from "./variants.ts";

export type SaveConflict = Readonly<{ id: number; submittedRevision: number; expectedVersion: string | null; observedVersion: string;
    review: "unloaded" | "loading" | "ready" | "expired"; reviewVersion: string | null; message: string }>;
export type SaveConflictPresentation = Readonly<{ conflict: SaveConflict | null; canSaveReviewed: boolean; disposed: boolean }>;
type Reference = Readonly<{ generation: number; baseline: ComparisonBaseline }>;
type ReviewPorts = Readonly<{ inputReady: () => boolean; presentation: () => TabTarget; present: () => void;
    server: () => Readonly<{ buffer: TextBuffer; version: string }>; save: SavePort<string>["save"];
    track: (task: Promise<unknown>) => void; saved: (revision: number) => void; reportError: (error: unknown) => void }>;

/** One source-save/reference owner, including the ordering shared by conflict and version reads. */
export class HostSourceReview {
    private readonly workspace: Workspace;
    private readonly saves: HostSaveQueue;
    private readonly source: TextResourceHandle;
    private readonly ports: ReviewPorts;
    private savedReference: ComparisonBaseline;
    private readonly referenceCell: HostCell<Reference>;
    readonly comparisonReference;
    private readonly conflictCell = new HostCell<SaveConflict | null>(null);
    readonly saveConflict = this.conflictCell.observable;
    readonly saveConflictPresentation: Observable<SaveConflictPresentation>;
    private cachedPresentation: SaveConflictPresentation | undefined;
    private conflictSerial = 0;
    private conflictReference: ComparisonBaseline | undefined;
    private conflictPresentation: TabTarget | undefined;
    private referenceRequest = 0;
    private readonly conflictReads: { operation: Operation; presentation: TabTarget; conflictId: number; buffer: TextBuffer; version: string;
        reference: Reference; currentRequest: () => boolean }[] = [];
    readonly variants: ReviewVariants;
    private disposed = false;
    constructor(workspace: Workspace, saves: HostSaveQueue, source: TextResourceHandle, ports: ReviewPorts) {
        this.workspace = workspace; this.saves = saves; this.source = source; this.ports = ports;
        this.savedReference = Object.freeze({ buffer: workspace.document(source.documentId).buffer, version: "reference:saved-v0" });
        this.referenceCell = new HostCell<Reference>({ generation: 0, baseline: this.savedReference }); this.comparisonReference = this.referenceCell.observable;
        this.saveConflictPresentation = Object.freeze({ getSnapshot: () => this.presentationSnapshot(), subscribe: (listener: () => void) => {
            const stops: (() => void)[] = [];
            try { for (const store of [this.saveConflict, this.comparisonReference, this.source.metadata, this.workspace.tabs]) stops.push(store.subscribe(listener)); }
            catch (error) { stops.reverse().forEach(stop => stop()); throw error; }
            return () => { stops.forEach(stop => stop()); };
        } });
        this.variants = new ReviewVariants(workspace, source, {
            presentation: ports.presentation, reference: this.comparisonReference,
            saved: () => this.savedReference, server: () => { const server = ports.server(); return { buffer: server.buffer, version: `reference:server-${server.version}` }; },
            present: ports.present, beginReferenceRequest: () => this.beginReferenceRequest(), publish: baseline => this.publish(baseline),
        });
    }
    private publish(baseline: ComparisonBaseline): void { this.referenceCell.set({ generation: this.referenceCell.get().generation + 1, baseline }); }
    savedComparisonReference(): ComparisonBaseline { return this.savedReference; }
    dismiss(): void { this.referenceRequest++; }
    private beginReferenceRequest(): () => boolean {
        // Version and conflict retrieval share the latest request, even if its load is cancelled.
        const generation = ++this.referenceRequest, conflict = this.conflictCell.get();
        if (conflict?.review === "ready") {
            this.conflictReference = undefined; this.conflictPresentation = undefined;
            this.conflictCell.set({ ...conflict, review: "expired", message: "The review choice changed. Review the remote source again before saving." });
        }
        return () => generation === this.referenceRequest;
    }
    retainComparisonReference(baseline: ComparisonBaseline): void {
        if (!this.disposed) { this.referenceCell.set({ ...this.referenceCell.get(), baseline }); this.variants.referenceChanged(); }
    }
    showComparison(baseline: ComparisonBaseline): void {
        this.beginReferenceRequest(); this.publish(baseline); this.variants.referenceChanged(); this.ports.present();
    }
    readonly save = (): void => {
        if (this.disposed) return;
        const conflict = this.conflictCell.get();
        if (conflict) { this.conflictCell.set({ ...conflict, message: "Review the remote source before retrying this save." }); return; }
        this.saveSource();
    };
    private saveSource(review?: SaveReview): void {
        if (!this.ports.inputReady()) return;
        const conflictId = this.conflictCell.get()?.id;
        let captured: SaveSubmission<string> | undefined;
        this.ports.track(this.saves.save(this.workspace.captureSave(this.source, review), { save: submission => { captured = submission; return this.ports.save(submission); } })
            .then(result => {
                if (!this.disposed && result.kind === "saved") {
                    this.variants.remember(this.savedReference);
                    this.savedReference = Object.freeze({ buffer: TextBuffer.from(result.receipt.savedValue), version: `reference:saved-${result.receipt.serverVersion}` });
                    this.variants.refreshCatalog();
                    if (this.conflictCell.get()?.id === conflictId) {
                        this.conflictCell.set(null); this.conflictReference = undefined; this.conflictPresentation = undefined;
                    }
                    this.ports.saved(result.receipt.submission.revision);
                } else if (!this.disposed && result.kind === "conflict" && captured) {
                    for (const read of this.conflictReads) read.operation.cancel();
                    this.conflictReference = undefined; this.conflictPresentation = undefined;
                    this.conflictCell.set({ id: ++this.conflictSerial, submittedRevision: captured.revision, expectedVersion: captured.expectedServerVersion,
                        observedVersion: result.serverVersion, review: "unloaded", reviewVersion: null, message: "Local edits are retained. Review the remote source before retrying." });
                }
            }).catch(this.ports.reportError));
    }
    readonly reviewSaveConflict = (expected: SaveConflict | null = this.conflictCell.get()): void => {
        if (this.disposed || expected !== this.conflictCell.get()) return;
        const conflict = this.conflictCell.get(); if (!conflict) return;
        const presentation = this.ports.presentation(), operation = this.workspace.operations.begin(this.source.id, "save-conflict-review", presentation);
        this.conflictReads.push({ operation, presentation, conflictId: conflict.id, ...this.ports.server(),
            reference: this.referenceCell.get(), currentRequest: this.beginReferenceRequest() });
        this.conflictReference = undefined; this.conflictPresentation = undefined;
        this.conflictCell.set({ ...conflict, review: "loading", reviewVersion: null, message: "Reading a captured remote snapshot; local typing can continue." });
    };
    readonly finishConflictReview = (expected: SaveConflict | null = this.conflictCell.get()): boolean => {
        if (this.disposed || expected !== this.conflictCell.get()) return false;
        const read = this.conflictReads.shift(); if (!read) return false;
        try {
            const conflict = this.conflictCell.get();
            if (this.disposed || !conflict || conflict.id !== read.conflictId) return false;
            if (!read.currentRequest() || this.referenceCell.get() !== read.reference || !read.operation.presentationCurrent()) {
                if (read.operation.isCurrent()) this.conflictCell.set({ ...conflict, review: "expired", message: "The captured source tab or review choice changed. Review the remote source again." });
                return false;
            }
            const baseline = Object.freeze({ buffer: read.buffer, version: `reference:conflict-${read.version}` });
            this.conflictReference = baseline; this.conflictPresentation = read.presentation;
            this.publish(baseline); this.variants.referenceChanged();
            this.conflictCell.set({ ...conflict, review: "ready", reviewVersion: read.version, message: "Compare and edit the working source, then save the reviewed source." });
            this.ports.present(); return true;
        } catch (error) { this.ports.reportError(error); return false; } finally { read.operation.finish(); }
    };
    private presentationSnapshot(): SaveConflictPresentation {
        const conflict = this.conflictCell.get(), reference = this.referenceCell.get().baseline, metadata = this.source.metadata.getSnapshot();
        const canSaveReviewed = !this.disposed && conflict?.review === "ready" && conflict.reviewVersion !== null && this.conflictReference?.buffer === reference.buffer
            && this.conflictReference.version === reference.version && this.conflictPresentation !== undefined
            && this.workspace.tabs.resolve(this.conflictPresentation) !== undefined && metadata.state === "ready" && metadata.capabilities.save
            && metadata.editLock === null && metadata.saveStatus !== "saving";
        const cached = this.cachedPresentation;
        if (cached && cached.conflict === conflict && cached.canSaveReviewed === canSaveReviewed && cached.disposed === this.disposed) return cached;
        return this.cachedPresentation = Object.freeze({ conflict, canSaveReviewed, disposed: this.disposed });
    }
    canSaveReviewedSource(): boolean { return this.saveConflictPresentation.getSnapshot().canSaveReviewed; }
    readonly saveReviewedSource = (expected: SaveConflict | null = this.conflictCell.get()): void => {
        if (this.disposed || expected !== this.conflictCell.get()) return;
        const conflict = this.conflictCell.get(); if (!conflict) return;
        if (!this.canSaveReviewedSource()) {
            this.conflictCell.set({ ...conflict, review: "expired", message: "The remote review is no longer current. Review again before saving." }); return;
        }
        this.saveSource({ target: this.workspace.captureResource(this.source.id), expectedRevision: this.workspace.document(this.source.documentId).revision, expectedServerVersion: conflict.reviewVersion! });
    };
    subscriptions(): number { return this.referenceCell.count() + this.conflictCell.count(); }
    debug() {
        const reference = this.referenceCell.get();
        return { saveConflict: this.conflictCell.get(), pendingConflictReads: this.conflictReads.length, variants: this.variants.state.getSnapshot(),
            comparisonReference: { generation: reference.generation, version: reference.baseline.version, length: reference.baseline.buffer.length } };
    }
    dispose(): void {
        if (this.disposed) return; this.disposed = true; this.variants.dispose();
        this.conflictReads.splice(0).forEach(read => { read.operation.cancel(); read.operation.finish(); });
        // Derived availability changes on disposal even when the conflict payload stays the same.
        this.conflictCell.set(this.conflictCell.get());
    }
}
