import { createWorkingSource } from "./working-source.ts";
import { HostCell } from "../../../examples/shared/observable.ts";
import { TextBuffer, Workspace } from "../../../src/index.ts";
import { HostSaveQueue } from "../save-queue.ts";
import type { ComparisonBaseline, DocumentId, DocumentView, ResourceId, TextEdit, TextResourceHandle } from "../../../src/index.ts";
import { HostSourceReview, type SaveConflict } from "./source-review.ts";
import { HostLayout } from "./layout.ts";
import { HostLoadedSource } from "./loaded-source.ts";
import { ConfigurationSave } from "./configuration.ts";
import { HostTransfer } from "./transfers.ts";
import { RunResources } from "./run-resources.ts";
import { TransferInstruction } from "./instruction.ts";
import { HostFixtureServices, SourceSaveFailure } from "./fixture-services.ts";
import { runWithResources, type RunSettings } from "./run-command.ts";
import type { Connection, ServiceActivity, SubmittedRun } from "./fixture-services.ts";

export type { Connection } from "./fixture-services.ts";
type RecoveredInput = Readonly<{ documentId: DocumentId; expectedRevision: number; reason: string; contextFrom: number; attemptedText: string; attemptedEdit: TextEdit | null }>;
export type { SaveConflict } from "./source-review.ts";
export type { Layout } from "./layout.ts";
export type Activity = ServiceActivity & Readonly<{ pendingRuns: number; completedRuns: number; background: number;
    errors: number; lastSavedRevision: number | null; lastRun: Readonly<{ sourceRevision: number; configurationRevision: number; mode: string }> | null;
    ordering: readonly string[] }>;

/** Persistent composition root shared by plain and React hosts; no DOM and no mirrored text cell. */
export class HostController {
    private readonly canRun: (resource: ResourceId) => boolean;
    constructor(canRun: (resource: ResourceId) => boolean = () => true) { this.canRun = canRun; }
    readonly workspace = new Workspace({ onListenerError: error => this.reportError(error) });
    readonly saves = new HostSaveQueue(this.workspace, error => this.reportError(error));
    readonly source = createWorkingSource(this.workspace, "source", "Primary source", { value: "start", serverVersion: "v0" });
    readonly connection = this.workspace.createResource<Connection>({ scope: "host-fixture", resource: "connection", variant: "working" }, "Connection", { value: { path: "source.csv", format: "csv" } });
    readonly configurationSave = new ConfigurationSave(this.workspace, this.saves, this.connection, task => { void this.track(task); });
    readonly transfer = new HostTransfer(this.workspace, this.saves, task => { void this.track(task); });
    readonly runResources = new RunResources(this.workspace, this.source, this.connection, this.transfer.resource);
    readonly instruction = new TransferInstruction(this);
    private readonly presentation = new HostLayout(this.workspace, this.source, this.connection.id);
    readonly panes = this.presentation.panes;
    private readonly activityCell = new HostCell<Activity>({ writes: 0, pendingRuns: 0, completedRuns: 0, background: 0, errors: 0, lastSavedRevision: null, lastRun: null, ordering: Object.freeze([]) });
    private readonly settingsCell = new HostCell<RunSettings>({ mode: "preview" });
    readonly layout = this.presentation.state;
    readonly activity = this.activityCell.observable;
    readonly settings = this.settingsCell.observable;
    private readonly services = new HostFixtureServices(this.workspace.document(this.source.id).buffer, activity => this.updateActivity(activity));
    private readonly recoveryCell = new HostCell<Readonly<{ visible: boolean; items: readonly RecoveredInput[] }>>({ visible: false, items: [] });
    readonly recovery = this.recoveryCell.observable;
    private readonly sourceReview = new HostSourceReview(this.workspace, this.saves, this.source, {
        inputReady: () => this.sourceInputReady(), presentation: this.panes.primary, present: () => this.openReview(),
        server: () => this.services.server,
        save: submission => {
            const modal = this.layout.getSnapshot().modal;
            if (modal.kind === "error" && modal.source === "source-save") this.presentation.clearError();
            return this.services.save(submission);
        },
        track: task => { void this.track(task); }, saved: revision => this.updateActivity({ lastSavedRevision: revision }),
        reportError: error => this.reportError(error),
    });
    readonly comparisonReference = this.sourceReview.comparisonReference;
    readonly saveConflict = this.sourceReview.saveConflict;
    readonly saveConflictPresentation = this.sourceReview.saveConflictPresentation;
    readonly variants = this.sourceReview.variants;
    private proposal: Readonly<{ documentId: DocumentId; revision: number; original: ComparisonBaseline; preview: ComparisonBaseline }> | undefined;
    private readonly operations = new Set<Promise<unknown>>();
    private disposal: Promise<void> | undefined;
    private proposalTransactionMs = 0;
    private readonly loadedSlot = new HostLoadedSource(this.workspace, this.presentation, {
        canCaptureRecovery: () => this.canCaptureRecovery(), reopenPrimary: () => this.reopenPrimary(),
    });
    readonly loadedSource = this.loadedSlot.state;
    private timer: ReturnType<typeof setInterval> | undefined;
    private disposed = false;
    private reportedError: unknown;
    /** Original thrown value, including its cause/stack, for host diagnostics. Never frozen into UI state. */
    get lastError(): unknown { return this.reportedError; }
    private readonly inputCaptureGuards = new Map<() => boolean, ((id: DocumentId) => DocumentView | undefined) | undefined>();
    registerInputCaptureGuard(ready: () => boolean, view?: (id: DocumentId) => DocumentView | undefined): () => void {
        if (this.disposed) return () => {};
        this.inputCaptureGuards.set(ready, view); return () => { this.inputCaptureGuards.delete(ready); };
    }
    captureRecoveryView(id: DocumentId): DocumentView | undefined {
        for (const resolve of this.inputCaptureGuards.values()) { const view = resolve?.(id); if (view && this.workspace.ownsDocumentView(view)) return view; }
        return undefined;
    }
    registerDetachedDocumentCleanup(cleanup: (documentId: DocumentId) => void): () => void {
        return this.disposed ? () => {} : this.loadedSlot.registerDetachedCleanup(cleanup);
    }
    collectLoadedDocument(): void { if (!this.disposed) this.loadedSlot.collect(); }
    private sourceInputReady(): boolean {
        if ([...this.inputCaptureGuards.keys()].every(ready => ready())) return true;
        this.presentation.error("Wait for pending typing to finish, then try the source command again."); return false;
    }
    canCaptureRecovery(): boolean { return !this.disposed && [...this.inputCaptureGuards.keys()].every(ready => ready()); }
    hasPendingRecoveryWork(includeLoaded = true): boolean { return this.loadedSlot.hasPendingRecoveryWork(includeLoaded) || this.operations.size > 0 || this.instruction.debug().pendingCopy; }
    /** Recovery targets the host's temporary-source slot, never a surviving tab index. */
    restoreLoadedDraft(text: string, generation: number, view?: DocumentView): TextResourceHandle | undefined { return this.loadedSlot.restoreDraft(text, generation, view); }
    setSecondary(documentId: DocumentId | null): void { this.presentation.setSecondary(documentId); }
    readonly openReview = (): void => this.safe(() => { this.presentation.navigate("review"); });
    readonly closeReview = (): void => this.safe(() => { this.proposal = undefined; this.sourceReview.dismiss(); this.presentation.navigate("workspace"); });
    savedComparisonReference(): ComparisonBaseline { return this.sourceReview.savedComparisonReference(); }
    retainComparisonReference(baseline: ComparisonBaseline): void { this.sourceReview.retainComparisonReference(baseline); }

    private updateActivity(patch: Partial<Activity>): void { this.activityCell.set({ ...this.activityCell.get(), ...patch }); }
    readonly reportError = (error: unknown): void => {
        if (this.disposed) return;
        this.reportedError = error;
        this.updateActivity({ errors: this.activityCell.get().errors + 1 });
        if (error instanceof SourceSaveFailure) this.presentation.error("Source save failed. Your edits are intact. Use Save source to retry.", "source-save");
        else this.presentation.error("The host operation failed. Your document is retained.");
    };
    private track<T>(pending: Promise<T>): Promise<T> {
        this.operations.add(pending);
        void pending.then(() => this.operations.delete(pending), () => this.operations.delete(pending)); return pending;
    }
    private safe(action: () => void): void { if (this.disposed) return; try { action(); } catch (error) { this.reportError(error); } }
    captureInputConflict(documentId: DocumentId, value: unknown): void {
        if (this.disposed || !value || typeof value !== "object") return;
        const detail = value as Record<string, unknown>;
        if (detail.documentId !== documentId || !Number.isSafeInteger(detail.expectedRevision) || (detail.expectedRevision as number) < 0
            || typeof detail.reason !== "string" || typeof detail.attemptedText !== "string") return;
        let attemptedEdit: TextEdit | null = null;
        if (detail.attemptedEdit !== undefined) {
            if (!detail.attemptedEdit || typeof detail.attemptedEdit !== "object") return;
            const edit = detail.attemptedEdit as Record<string, unknown>;
            if (!Number.isSafeInteger(edit.from) || !Number.isSafeInteger(edit.to) || (edit.from as number) < 0 || (edit.to as number) < (edit.from as number) || typeof edit.insert !== "string") return;
            attemptedEdit = { from: edit.from as number, to: edit.to as number, insert: edit.insert };
        }
        const contextFrom = detail.contextFrom === undefined ? 0 : detail.contextFrom;
        if (!Number.isSafeInteger(contextFrom) || (contextFrom as number) < 0) return;
        const previous = this.recoveryCell.get(); this.recoveryCell.set({ ...previous, items: [...previous.items,
            { documentId, expectedRevision: detail.expectedRevision as number, reason: detail.reason, contextFrom: contextFrom as number, attemptedText: detail.attemptedText, attemptedEdit }] });
    }
    readonly inspectRecovery = (): void => { this.recoveryCell.set({ ...this.recoveryCell.get(), visible: true }); };
    readonly discardRecovery = (): void => { this.recoveryCell.set({ visible: false, items: [] }); };
    recoveryText(): string | null { return this.recoveryCell.get().items.at(-1)?.attemptedText ?? null; }
    readonly previewProposal = (): void => this.previewProposalText("agent proposal");
    readonly previewProposalText = (text: string): void => this.safe(() => {
        if (!this.sourceInputReady()) return;
        const doc = this.workspace.document(this.source.id);
        const preview = { buffer: TextBuffer.from(text), version: `proposal-for-r${doc.revision}` };
        this.proposal = { documentId: doc.id, revision: doc.revision, original: { buffer: doc.buffer, version: `source-r${doc.revision}` }, preview };
        this.sourceReview.showComparison(preview);
    });
    readonly applyProposal = (): void => this.safe(() => {
        const proposal = this.proposal;
        if (!proposal || !this.sourceInputReady()) return;
        if (this.comparisonReference.getSnapshot().baseline.buffer !== proposal.preview.buffer) {
            this.proposal = undefined; this.presentation.error("The comparison changed. Preview the proposal again."); return;
        }
        const start = performance.now();
        const result = this.workspace.replaceText(proposal.documentId, proposal.preview.buffer,
            { expectedRevision: proposal.revision, origin: "agent", history: "record", kind: "proposal" });
        this.proposalTransactionMs = performance.now() - start;
        this.proposal = undefined;
        if (!result.applied) throw new Error("Source changed or became unavailable. Review the proposal again.");
        this.sourceReview.showComparison(proposal.original);
    });
    readonly save = (): void => this.safe(this.sourceReview.save);
    /** Synthetic external writer; never updates the local document or its known saved version. */
    externalWrite(text: string): void {
        if (this.disposed) return;
        this.services.externalWrite(text);
        this.variants.refreshCatalog();
    }
    readonly simulateExternalWrite = (): void => { this.externalWrite("external source\r\n"); };
    readonly reviewSaveConflict = (expected: SaveConflict | null = this.saveConflict.getSnapshot()): void => this.safe(() => this.sourceReview.reviewSaveConflict(expected));
    readonly finishConflictReview = (expected: SaveConflict | null = this.saveConflict.getSnapshot()): boolean => this.sourceReview.finishConflictReview(expected);
    canSaveReviewedSource(): boolean { return this.sourceReview.canSaveReviewedSource(); }
    readonly saveReviewedSource = (expected: SaveConflict | null = this.saveConflict.getSnapshot()): void => this.safe(() => this.sourceReview.saveReviewedSource(expected));
    readonly finishSave = (): void => { this.services.finishSave(); };
    readonly failSave = (): void => { this.services.failSave(); };
    private async submitRun<R>(submit: (input: SubmittedRun) => Promise<R>): Promise<R> {
        if (![this.source.id, this.connection.id, this.transfer.resource.id].every(id => this.canRun(id))) throw new Error("Run permission denied.");
        return runWithResources(this.workspace, this.source, this.connection, this.settingsCell.get(), submit);
    }
    readonly run = async (): Promise<void> => {
        if (this.disposed || !this.sourceInputReady()) return;
        const validation = this.configurationSave.validation() ?? this.runResources.validation(); if (validation) { this.reportError(new Error(validation)); return; }
        let started = false;
        await this.track(this.submitRun(submission => {
            const id = this.runResources.start(submission);
            const pending = this.services.run(submission, status => this.runResources.finish(id, status)); started = true;
            this.updateActivity({ pendingRuns: this.activityCell.get().pendingRuns + 1, lastRun: Object.freeze({ sourceRevision: submission.source.revision,
                configurationRevision: submission.configuration.revision, mode: submission.settings.mode }) });
            return pending;
        }).then(() => { if (!this.disposed) this.updateActivity({ completedRuns: this.activityCell.get().completedRuns + 1, pendingRuns: this.activityCell.get().pendingRuns - 1 }); })
            .catch(error => { if (!this.disposed && started) this.updateActivity({ pendingRuns: this.activityCell.get().pendingRuns - 1 });
                this.reportError(error); }));
    };
    readonly finishRun = (): void => { this.services.finishRun(); };
    readonly failRun = (): void => { this.services.failRun(); };
    runCapture(index: number) { return this.services.runCapture(index); }
    readonly demonstrateOrdering = (): void => {
        if (this.disposed || !this.sourceInputReady()) return;
        const phases: string[] = [], write = this.settingsCell.enqueue({ mode: "inspect" });
        const document = this.workspace.document(this.source.id);
        const result = this.workspace.edit({ documentId: document.id, expectedRevision: document.revision, origin: "host",
            edits: [{ from: document.buffer.length, to: document.buffer.length, insert: "Q" }] });
        phases.push(`edit:${result.applied}`);
        void this.track(this.submitRun(async submission => { phases.push(`run:${submission.settings.mode}`); }).catch(error => this.reportError(error)));
        void this.track(write.then(async () => {
            if (this.disposed) return;
            phases.push(`write:${this.settingsCell.get().mode}`);
            await this.submitRun(async submission => { phases.push(`run:${submission.settings.mode}`); });
            this.updateActivity({ ordering: Object.freeze(phases) });
        }).catch(error => this.reportError(error)));
    };
    readonly setPath = (path: string): void => this.safe(() => {
        const state = this.connection.getSnapshot(); if (state.state !== "ready") return;
        const result = this.workspace.updateResource(this.connection, { expectedRevision: state.revision, origin: "human", value: { ...state.value(), path } });
        if (!result.applied) throw new Error(result.reason);
    });
    readonly move = (): void => this.safe(this.presentation.move);
    readonly toggleViews = (): void => { this.presentation.toggleViews(); };
    readonly openClosePrompt = (): void => this.safe(this.presentation.openClosePrompt);
    readonly confirmClose = (): void => this.safe(() => {
        if (!this.presentation.confirmClose()) this.reportError(new Error("Close confirmation expired."));
        this.collectLoadedDocument();
    });
    readonly replacePrimary = (): void => this.safe(() => { this.presentation.replacePrimary(); this.collectLoadedDocument(); });
    readonly reopenPrimary = (): void => this.safe(() => { this.presentation.reopenPrimary(); this.collectLoadedDocument(); });
    readonly beginDeferredLoad = (): void => this.safe(this.loadedSlot.begin);
    readonly reopenLoaded = (): void => this.safe(this.loadedSlot.reopen);
    readonly discardLoadedSource = (): void => this.safe(this.loadedSlot.discard);
    readonly finishLoad = (): void => { this.loadedSlot.finish(); };
    readonly cancelClose = (): void => { this.presentation.cancelClose(); };
    readonly clearError = (): void => { this.presentation.clearError(); };
    readonly injectFormError = (): void => { this.presentation.injectFormError(); };
    readonly recover = (): void => { this.presentation.recover(); };
    startBackground(): void {
        if (this.disposed || this.timer !== undefined) return;
        this.timer = setInterval(() => this.updateActivity({ background: this.activityCell.get().background + 1 }), 50);
    }
    debug() {
        const source = this.source.getSnapshot(), form = this.connection.getSnapshot();
        return { diagnostics: this.workspace.diagnostics(), layout: this.layout.getSnapshot(), activity: this.activity.getSnapshot(),
            source: { id: this.source.id, uri: this.workspace.document(this.source.id).language!.uri, revision: source.revision, length: source.state === "ready" ? this.workspace.document(this.source.id).buffer.length : 0,
                serverVersion: source.metadata.serverVersion, dirty: source.metadata.dirty, saveStatus: source.metadata.saveStatus },
            ...this.sourceReview.debug(),
            transfer: { id: this.transfer.resource.id, revision: this.transfer.resource.getSnapshot().revision, dirty: this.transfer.resource.metadata.getSnapshot().dirty, saveStatus: this.transfer.resource.metadata.getSnapshot().saveStatus, serverVersion: this.transfer.resource.metadata.getSnapshot().serverVersion }, transferSave: this.transfer.save.debug(), runResources: this.runResources.debug(), instruction: this.instruction.debug(),
            ...this.services.debug(),
            lastError: this.reportedError instanceof Error ? { name: this.reportedError.name, message: this.reportedError.message, stack: this.reportedError.stack } : null,
            history: this.workspace.observeHistory(this.source.id).getSnapshot(),
            configuration: { id: this.connection.id, revision: form.revision, dirty: form.metadata.dirty, serverVersion: form.metadata.serverVersion, saveStatus: form.metadata.saveStatus }, configurationSave: this.configurationSave.debug(),
            proposalTransactionMs: this.proposalTransactionMs, pendingCommands: this.operations.size,
            inputRecovery: this.recoveryCell.get().items.map(item => ({ documentId: item.documentId, expectedRevision: item.expectedRevision, reason: item.reason, contextFrom: item.contextFrom, attemptedUnits: item.attemptedText.length })),
            hostSubscriptions: this.presentation.subscriptions() + this.activityCell.count() + this.settingsCell.count() + this.loadedSlot.subscriptions() + this.recoveryCell.count() + this.sourceReview.subscriptions() + this.configurationSave.debug().subscriptions + this.transfer.save.debug().subscriptions + this.runResources.debug().subscriptions + this.instruction.debug().subscriptions, inputCaptureGuards: this.inputCaptureGuards.size, loadPending: this.loadedSlot.pending, disposed: this.disposed };
    }
    dispose(): Promise<void> {
        if (this.disposal) return this.disposal; this.disposed = true; this.proposal = undefined; this.sourceReview.dispose();
        this.configurationSave.dispose(); this.transfer.save.dispose(); this.runResources.dispose(); this.instruction.dispose();
        this.inputCaptureGuards.clear();
        if (this.timer !== undefined) clearInterval(this.timer); this.timer = undefined;
        this.services.dispose();
        this.updateActivity({ pendingRuns: 0 });
        this.presentation.dispose(); this.loadedSlot.dispose();
        this.disposal = Promise.allSettled([...this.operations]).then(() => {}); return this.disposal;
    }
}
