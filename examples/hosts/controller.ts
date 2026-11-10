import { HostCell } from "../shared/observable.ts";
import { TextBuffer, Workspace, WorkspaceCommands } from "../../src/index.ts";
import type { AgentRequest, CloseOperation, ComparisonBaseline, DocumentId, Operation, RunSubmission, SaveResponse, SaveReview, SaveSubmission, TabId, TabTarget, TextEdit } from "../../src/index.ts";
import { ReviewVariants } from "./variants.ts";

export type Connection = Readonly<{ path: string; format: "csv" }>;
type RunSettings = Readonly<{ mode: "preview" | "inspect" }>;
type RecoveredInput = Readonly<{ documentId: DocumentId; expectedRevision: number; reason: string; contextFrom: number; attemptedText: string; attemptedEdit: TextEdit | null }>;
export type SaveConflict = Readonly<{ id: number; submittedRevision: number; expectedVersion: string | null; observedVersion: string;
    review: "unloaded" | "loading" | "ready" | "expired"; reviewVersion: string | null; message: string }>;
export type Layout = Readonly<{ position: "left" | "right"; visible: boolean; formFault: boolean; primarySurface: "text" | "panel" | "loading" | "closed";
    navigation: Readonly<{ kind: "workspace" } | { kind: "review" }>;
    modal: Readonly<{ kind: "none" } | { kind: "error"; message: string } | { kind: "close"; tabId: TabId }> }>;
export type Activity = Readonly<{ writes: number; acknowledgements: number; ackAttempts: number; pendingRuns: number; completedRuns: number; background: number;
    errors: number; lastSavedRevision: number | null; lastRun: Readonly<{ sourceRevision: number; configurationRevision: number; mode: string }> | null;
    ordering: readonly string[] }>;

/** Persistent composition root shared by plain and React hosts; no DOM and no mirrored text cell. */
export class HostController {
    readonly workspace = new Workspace({ onListenerError: error => this.reportError(error) });
    readonly commands = new WorkspaceCommands(this.workspace, error => this.reportError(error));
    readonly source = this.workspace.createTextResource({ scope: "host-fixture", resource: "source", variant: "working" }, "Primary source", { value: "start", serverVersion: "v0" });
    readonly connection = this.workspace.createResource<Connection>({ scope: "host-fixture", resource: "connection", variant: "working" }, "Connection", { value: { path: "source.csv", format: "csv" } });
    readonly review = this.workspace.agentState(this.source.id);
    private savedReference: ComparisonBaseline = Object.freeze({ buffer: this.workspace.document(this.source.documentId).buffer, version: "reference:saved-v0" });
    private readonly referenceCell = new HostCell<Readonly<{ generation: number; baseline: ComparisonBaseline }>>({ generation: 0, baseline: this.savedReference });
    readonly comparisonReference = this.referenceCell.observable;
    private primaryTab = this.workspace.open({ kind: "text", documentId: this.source.documentId }, "left");
    private readonly secondaryTab = this.workspace.open({ kind: "text", documentId: this.source.documentId }, "right");
    readonly formTab = this.workspace.open({ kind: "panel", resourceId: this.connection.id, panelType: "configuration" }, "right");
    private readonly layoutCell = new HostCell<Layout>({ position: "left", visible: true, formFault: false, primarySurface: "text", navigation: { kind: "workspace" }, modal: { kind: "none" } });
    private readonly activityCell = new HostCell<Activity>({ writes: 0, acknowledgements: 0, ackAttempts: 0, pendingRuns: 0, completedRuns: 0, background: 0, errors: 0, lastSavedRevision: null, lastRun: null, ordering: Object.freeze([]) });
    private readonly settingsCell = new HostCell<RunSettings>({ mode: "preview" });
    readonly layout = this.layoutCell.observable;
    readonly activity = this.activityCell.observable;
    readonly settings = this.settingsCell.observable;
    private readonly recoveryCell = new HostCell<Readonly<{ visible: boolean; items: readonly RecoveredInput[] }>>({ visible: false, items: [] });
    readonly recovery = this.recoveryCell.observable;
    private readonly conflictCell = new HostCell<SaveConflict | null>(null);
    readonly saveConflict = this.conflictCell.observable;
    private conflictSerial = 0;
    private conflictReference: ComparisonBaseline | undefined;
    private conflictPresentation: TabTarget | undefined;
    private readonly conflictReads: { operation: Operation; presentation: TabTarget; conflictId: number; buffer: TextBuffer; version: string }[] = [];
    private pendingAgent: AgentRequest<Readonly<{ configurationRevision: number; path: string }>> | undefined;
    private readonly agentReplies: { request: AgentRequest<Readonly<{ configurationRevision: number; path: string }>>; resolve: (proposal: string) => void; reject: (error: unknown) => void }[] = [];
    private readonly saves: { submission: SaveSubmission<string>; resolve: (response: SaveResponse<string>) => void; reject: (error: unknown) => void }[] = [];
    private readonly runs: { submission: RunSubmission<string, Connection, RunSettings>; resolve: () => void; reject: (error: unknown) => void }[] = [];
    private readonly operations = new Set<Promise<unknown>>();
    private disposal: Promise<void> | undefined;
    private proposalTransactionMs = 0;
    private closeOperation: CloseOperation | undefined;
    private pendingLoad: (() => void) | undefined;
    private serverVersion = "v0";
    private serverSerial = 0;
    private serverBuffer = this.savedReference.buffer;
    private failNextAck = true;
    private timer: ReturnType<typeof setInterval> | undefined;
    private disposed = false;
    private readonly inputCaptureGuards = new Set<() => boolean>();
    registerInputCaptureGuard(ready: () => boolean): () => void {
        if (this.disposed) return () => {};
        this.inputCaptureGuards.add(ready); return () => { this.inputCaptureGuards.delete(ready); };
    }
    private sourceInputReady(): boolean {
        if ([...this.inputCaptureGuards].every(ready => ready())) return true;
        this.layoutCell.set({ ...this.layoutCell.get(), modal: { kind: "error", message: "Wait for pending typing to finish, then try the source command again." } }); return false;
    }
    canCaptureRecovery(): boolean { return !this.disposed && [...this.inputCaptureGuards].every(ready => ready()); }
    hasPendingRecoveryWork(): boolean { return this.operations.size > 0 || this.review.getSnapshot().request !== null || this.review.getSnapshot().acknowledgements.length > 0; }
    readonly variants = new ReviewVariants(this.workspace, this.source, {
        presentation: () => this.workspace.captureTab(this.primaryTab), reference: this.comparisonReference,
        saved: () => this.savedReference, server: () => ({ buffer: this.serverBuffer, version: `reference:server-${this.serverVersion}` }),
        present: () => this.openReview(), publish: baseline => this.referenceCell.set({ generation: this.referenceCell.get().generation + 1, baseline }),
    });
    viewTab(id: "primary" | "secondary"): TabId { return id === "primary" ? this.primaryTab : this.secondaryTab; }
    readonly openReview = (): void => this.safe(() => { this.layoutCell.set({ ...this.layoutCell.get(), navigation: { kind: "review" } }); });
    readonly closeReview = (): void => this.safe(() => { this.layoutCell.set({ ...this.layoutCell.get(), navigation: { kind: "workspace" } }); });
    savedComparisonReference(): ComparisonBaseline { return this.savedReference; }
    retainComparisonReference(baseline: ComparisonBaseline): void {
        if (!this.disposed) { this.referenceCell.set({ ...this.referenceCell.get(), baseline }); this.variants.referenceChanged(); }
    }

    private updateActivity(patch: Partial<Activity>): void { this.activityCell.set({ ...this.activityCell.get(), ...patch }); }
    readonly reportError = (_error: unknown): void => {
        if (this.disposed) return;
        this.updateActivity({ errors: this.activityCell.get().errors + 1 });
        this.layoutCell.set({ ...this.layoutCell.get(), modal: Object.freeze({ kind: "error", message: "The host operation failed. Your document is retained." }) });
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
    readonly associate = (): void => this.safe(() => { this.workspace.associateAgent(this.source.id, "synthetic-agent"); });
    readonly requestAgent = (): void => this.safe(() => {
        if (!this.sourceInputReady()) return;
        const configuration = this.connection.getSnapshot();
        if (configuration.state !== "ready") throw new Error("Configuration not ready.");
        const before = this.workspace.document(this.source.documentId);
        const baseline = Object.freeze({ buffer: before.buffer, version: `reference:before-proposal-r${before.revision}` });
        const request = this.workspace.beginAgentRequest(this.source, { configurationRevision: configuration.revision, path: configuration.value.path });
        this.pendingAgent = request;
        // Synthetic deferred service deliberately ignores cancellation; the ticket guards late delivery.
        void this.track(new Promise<string>((resolve, reject) => this.agentReplies.push({ request, resolve, reject })).then(text => {
            const start = performance.now();
            const result = request.accept({ id: request.input.id, revision: 1, edits: [{ from: 0, to: request.input.source.value.length, insert: text }] });
            this.proposalTransactionMs = performance.now() - start;
            if (result.applied) {
                this.referenceCell.set({ generation: this.referenceCell.get().generation + 1, baseline });
                this.variants.referenceChanged();
                this.openReview();
            }
        }).catch(error => { request.fail(); this.reportError(error); }).finally(() => {
            request.finish(); if (this.pendingAgent === request) this.pendingAgent = undefined;
        }));
    });
    readonly deliverProposal = (): void => { this.deliverProposalText("agent proposal"); };
    readonly deliverProposalText = (text: string): void => { this.agentReplies.shift()?.resolve(text); };
    readonly failAgent = (): void => { this.agentReplies.shift()?.reject(new Error("Synthetic agent service failure")); };
    readonly offerNewerProposal = (): void => this.safe(() => {
        const review = this.review.getSnapshot(), document = this.workspace.document(this.source.documentId);
        if (!review.association || !review.proposal) throw new Error("A proposal is required.");
        const result = this.workspace.offerAgentProposal(this.workspace.captureProposal(this.source.id),
            { id: review.proposal.target.id, revision: review.proposal.target.revision + 1,
                edits: [{ from: 0, to: document.text.length, insert: "newer agent proposal" }] });
        if (!result.applied) throw new Error(result.reason);
    });
    readonly interrupt = (): void => this.safe(() => { this.workspace.interruptAgent(this.source.id); });
    readonly detach = (): void => this.safe(() => { this.workspace.detachAgent(this.source.id); });
    readonly save = (): void => this.safe(() => {
        const conflict = this.conflictCell.get();
        if (conflict) { this.conflictCell.set({ ...conflict, message: "Review the remote source before retrying this save." }); return; }
        this.saveSource();
    });
    private saveSource(review?: SaveReview): void {
        if (!this.sourceInputReady()) return;
        const conflictId = this.conflictCell.get()?.id;
        let captured: SaveSubmission<string> | undefined;
        void this.track(this.commands.save(this.source, { save: submission => {
            captured = submission;
            return this.disposed ? Promise.resolve({ kind: "conflict", serverVersion: this.serverVersion })
                : new Promise((resolve, reject) => this.saves.push({ submission, resolve, reject }));
        } }, review)
            .then(result => {
                if (!this.disposed && result.kind === "saved") {
                    this.variants.remember(this.savedReference);
                    this.savedReference = Object.freeze({ buffer: TextBuffer.from(result.receipt.savedValue), version: `reference:saved-${result.receipt.serverVersion}` });
                    this.variants.refreshCatalog();
                    if (this.conflictCell.get()?.id === conflictId) {
                        this.conflictCell.set(null); this.conflictReference = undefined; this.conflictPresentation = undefined;
                    }
                    this.updateActivity({ lastSavedRevision: result.receipt.submission.revision });
                } else if (!this.disposed && result.kind === "conflict" && captured) {
                    for (const read of this.conflictReads) read.operation.cancel();
                    this.conflictReference = undefined; this.conflictPresentation = undefined;
                    this.conflictCell.set({ id: ++this.conflictSerial, submittedRevision: captured.revision, expectedVersion: captured.expectedServerVersion,
                        observedVersion: result.serverVersion, review: "unloaded", reviewVersion: null, message: "Local edits are retained. Review the remote source before retrying." });
                }
            }).catch(error => this.reportError(error)));
    }
    /** Synthetic external writer; never updates the local document or its known saved version. */
    externalWrite(text: string): void {
        if (this.disposed) return;
        this.serverBuffer = TextBuffer.from(text); this.serverVersion = `v${++this.serverSerial}`;
        this.variants.refreshCatalog();
    }
    readonly simulateExternalWrite = (): void => { this.externalWrite("external source\r\n"); };
    readonly reviewSaveConflict = (): void => this.safe(() => {
        const conflict = this.conflictCell.get(); if (!conflict) return;
        const presentation = this.workspace.captureTab(this.primaryTab);
        const operation = this.workspace.beginOperation(this.source.id, "save-conflict-review", presentation);
        this.conflictReads.push({ operation, presentation, conflictId: conflict.id, buffer: this.serverBuffer, version: this.serverVersion });
        this.conflictReference = undefined; this.conflictPresentation = undefined;
        this.conflictCell.set({ ...conflict, review: "loading", reviewVersion: null, message: "Reading a captured remote snapshot; local typing can continue." });
    });
    readonly finishConflictReview = (): boolean => {
        const read = this.conflictReads.shift(); if (!read) return false;
        try {
            const conflict = this.conflictCell.get();
            if (this.disposed || !conflict || conflict.id !== read.conflictId) return false;
            if (!read.operation.presentationCurrent()) {
                if (read.operation.isCurrent()) this.conflictCell.set({ ...conflict, review: "expired", message: "The captured source tab changed. Review the remote source again." });
                return false;
            }
            const baseline = Object.freeze({ buffer: read.buffer, version: `reference:conflict-${read.version}` });
            this.conflictReference = baseline; this.conflictPresentation = read.presentation;
            this.referenceCell.set({ generation: this.referenceCell.get().generation + 1, baseline });
            this.variants.referenceChanged();
            this.conflictCell.set({ ...conflict, review: "ready", reviewVersion: read.version, message: "Compare and edit the working source, then save the reviewed source." });
            this.openReview(); return true;
        } catch (error) { this.reportError(error); return false; } finally { read.operation.finish(); }
    };
    canSaveReviewedSource(): boolean {
        const conflict = this.conflictCell.get(), reference = this.referenceCell.get().baseline, metadata = this.source.metadata.getSnapshot();
        return !this.disposed && conflict?.review === "ready" && conflict.reviewVersion !== null && this.conflictReference?.buffer === reference.buffer
            && this.conflictReference.version === reference.version && this.conflictPresentation !== undefined
            && this.workspace.resolveTab(this.conflictPresentation) !== undefined && metadata.state === "ready" && metadata.capabilities.save
            && metadata.editLock === null && metadata.saveStatus !== "saving";
    }
    readonly saveReviewedSource = (): void => this.safe(() => {
        const conflict = this.conflictCell.get(); if (!conflict) return;
        if (!this.canSaveReviewedSource()) {
            this.conflictCell.set({ ...conflict, review: "expired", message: "The remote review is no longer current. Review again before saving." }); return;
        }
        this.saveSource({ target: this.workspace.captureResource(this.source.id), expectedRevision: this.workspace.document(this.source.documentId).revision, expectedServerVersion: conflict.reviewVersion! });
    });
    readonly finishSave = (): void => {
        const pending = this.saves.shift(); if (!pending) return;
        if (pending.submission.expectedServerVersion !== this.serverVersion) {
            pending.resolve({ kind: "conflict", serverVersion: this.serverVersion }); return;
        }
        const writes = this.activityCell.get().writes + 1; this.serverVersion = `v${++this.serverSerial}`; this.updateActivity({ writes });
        this.serverBuffer = TextBuffer.from(pending.submission.value.trimEnd());
        pending.resolve({ kind: "saved", serverVersion: this.serverVersion, canonical: pending.submission.value.trimEnd() });
    };
    readonly failSave = (): void => { this.saves.shift()?.reject(new Error("Synthetic save transport failure")); };
    readonly retryAcknowledgement = (): void => this.safe(() => {
        const acknowledgement = this.review.getSnapshot().acknowledgements[0];
        if (!acknowledgement) return;
        void this.track(this.commands.acknowledge(this.source.id, acknowledgement.id, { acknowledge: async () => {
            this.updateActivity({ ackAttempts: this.activityCell.get().ackAttempts + 1 });
            if (this.failNextAck) { this.failNextAck = false; throw new Error("Synthetic acknowledgement failure"); }
            this.updateActivity({ acknowledgements: this.activityCell.get().acknowledgements + 1 });
        } }).catch(error => this.reportError(error)));
    });
    readonly run = async (): Promise<void> => {
        if (this.disposed || !this.sourceInputReady()) return;
        let started = false;
        await this.track(this.commands.run(this.source, this.connection, this.settingsCell.get(), { run: submission => {
            const pending = new Promise<void>((resolve, reject) => this.runs.push({ submission, resolve, reject })); started = true;
            this.updateActivity({ pendingRuns: this.activityCell.get().pendingRuns + 1, lastRun: Object.freeze({ sourceRevision: submission.source.revision,
                configurationRevision: submission.configuration.revision, mode: submission.settings.mode }) });
            return pending;
        } }).then(() => { if (!this.disposed) this.updateActivity({ completedRuns: this.activityCell.get().completedRuns + 1, pendingRuns: this.activityCell.get().pendingRuns - 1 }); })
            .catch(error => { if (!this.disposed && started) this.updateActivity({ pendingRuns: this.activityCell.get().pendingRuns - 1 });
                if (!started) this.reportError(error); }));
    };
    readonly finishRun = (): void => { this.runs.shift()?.resolve(); };
    readonly failRun = (): void => { this.runs.shift()?.reject(new Error("Synthetic run failure")); };
    runCapture(index: number) {
        const submission = this.runs[index]?.submission;
        return submission ? { source: submission.source.value, configuration: submission.configuration.value, settings: submission.settings } : null;
    }
    readonly demonstrateOrdering = (): void => {
        if (this.disposed || !this.sourceInputReady()) return;
        const phases: string[] = [], write = this.settingsCell.enqueue({ mode: "inspect" });
        const document = this.workspace.document(this.source.documentId);
        const result = this.workspace.edit({ documentId: document.id, expectedRevision: document.revision, origin: "host",
            edits: [{ from: document.buffer.length, to: document.buffer.length, insert: "Q" }] });
        phases.push(`edit:${result.applied}`);
        void this.track(this.commands.run(this.source, this.connection, this.settingsCell.get(), { run: async submission => { phases.push(`run:${submission.settings.mode}`); } }).catch(error => this.reportError(error)));
        void this.track(write.then(async () => {
            if (this.disposed) return;
            phases.push(`write:${this.settingsCell.get().mode}`);
            await this.commands.run(this.source, this.connection, this.settingsCell.get(), { run: async submission => { phases.push(`run:${submission.settings.mode}`); } });
            this.updateActivity({ ordering: Object.freeze(phases) });
        }).catch(error => this.reportError(error)));
    };
    readonly setPath = (path: string): void => this.safe(() => {
        const state = this.connection.getSnapshot(); if (state.state !== "ready") return;
        const result = this.workspace.updateResource(this.connection, { expectedRevision: state.revision, origin: "human", value: { ...state.value, path } });
        if (!result.applied) throw new Error(result.reason);
    });
    readonly move = (): void => this.safe(() => {
        const position = this.layoutCell.get().position === "left" ? "right" : "left";
        if (this.layoutCell.get().primarySurface !== "closed") this.workspace.move(this.primaryTab, position);
        this.layoutCell.set({ ...this.layoutCell.get(), position });
    });
    readonly toggleViews = (): void => { this.layoutCell.set({ ...this.layoutCell.get(), visible: !this.layoutCell.get().visible }); };
    readonly openClosePrompt = (): void => this.safe(() => {
        this.closeOperation?.finish(); this.closeOperation = this.workspace.beginClose(this.primaryTab);
        this.layoutCell.set({ ...this.layoutCell.get(), modal: Object.freeze({ kind: "close", tabId: this.primaryTab }) });
    });
    readonly confirmClose = (): void => this.safe(() => {
        const closed = this.closeOperation?.complete("close"); this.closeOperation = undefined;
        if (closed) this.layoutCell.set({ ...this.layoutCell.get(), primarySurface: "closed", modal: Object.freeze({ kind: "none" }) });
        else this.reportError(new Error("Close confirmation expired."));
    });
    readonly replacePrimary = (): void => this.safe(() => {
        this.workspace.replace(this.primaryTab, { kind: "panel", resourceId: this.connection.id, panelType: "configuration" });
        this.layoutCell.set({ ...this.layoutCell.get(), primarySurface: "panel" });
    });
    readonly reopenPrimary = (): void => this.safe(() => {
        if (this.layoutCell.get().primarySurface === "closed") this.primaryTab = this.workspace.open({ kind: "text", documentId: this.source.documentId }, this.layoutCell.get().position);
        else this.workspace.replace(this.primaryTab, { kind: "text", documentId: this.source.documentId });
        this.layoutCell.set({ ...this.layoutCell.get(), primarySurface: "text" });
    });
    readonly beginDeferredLoad = (): void => this.safe(() => {
        if (this.pendingLoad) throw new Error("A fixture load is already pending.");
        const loaded = this.workspace.createTextResource({ scope: "host-fixture", resource: `loaded-${this.workspace.getSnapshot().revision}`, variant: "working" }, "Loaded source");
        this.workspace.replace(this.primaryTab, { kind: "text", documentId: loaded.documentId });
        const target = this.workspace.captureTab(this.primaryTab), operation = this.workspace.beginLoad(loaded);
        this.layoutCell.set({ ...this.layoutCell.get(), primarySurface: "loading" });
        this.pendingLoad = () => {
            operation.accept({ value: "loaded resource", serverVersion: "loaded-v1" });
            if (this.workspace.resolveTab(target)) this.layoutCell.set({ ...this.layoutCell.get(), primarySurface: "text" });
        };
    });
    readonly finishLoad = (): void => { const finish = this.pendingLoad; this.pendingLoad = undefined; finish?.(); };
    readonly cancelClose = (): void => { this.closeOperation?.complete("keep-open"); this.closeOperation = undefined; this.clearError(); };
    readonly clearError = (): void => { this.layoutCell.set({ ...this.layoutCell.get(), modal: Object.freeze({ kind: "none" }) }); };
    readonly injectFormError = (): void => { this.layoutCell.set({ ...this.layoutCell.get(), formFault: true }); };
    readonly recover = (): void => { this.layoutCell.set({ ...this.layoutCell.get(), formFault: false, modal: Object.freeze({ kind: "none" }) }); };
    startBackground(): void {
        if (this.disposed || this.timer !== undefined) return;
        this.timer = setInterval(() => this.updateActivity({ background: this.activityCell.get().background + 1 }), 50);
    }
    debug() {
        const source = this.source.getSnapshot(), form = this.connection.getSnapshot();
        return { diagnostics: this.workspace.diagnostics(), layout: this.layout.getSnapshot(), activity: this.activity.getSnapshot(),
            source: { id: this.source.id, revision: source.revision, length: source.state === "ready" ? this.workspace.document(this.source.documentId).buffer.length : 0,
                exports: source.state === "ready" ? this.workspace.document(this.source.documentId).buffer.readMetrics().textExports : 0,
                serverVersion: source.metadata.serverVersion, dirty: source.metadata.dirty, saveStatus: source.metadata.saveStatus },
            saveConflict: this.conflictCell.get(), pendingConflictReads: this.conflictReads.length, variants: this.variants.state.getSnapshot(),
            server: { version: this.serverVersion, length: this.serverBuffer.length },
            history: this.workspace.observeHistory(this.source.documentId).getSnapshot(),
            configuration: { id: this.connection.id, revision: form.revision }, review: this.review.getSnapshot(),
            comparisonReference: { generation: this.referenceCell.get().generation, version: this.referenceCell.get().baseline.version,
                length: this.referenceCell.get().baseline.buffer.length },
            pendingSaves: this.saves.map(save => ({ revision: save.submission.revision, length: save.submission.value.length, expectedServerVersion: save.submission.expectedServerVersion })),
            pendingRuns: this.runs.map(({ submission }) => ({ sourceId: submission.source.target.id, sourceRevision: submission.source.revision,
                sourceLength: submission.source.value.length, sourceVersion: submission.source.serverVersion, configurationId: submission.configuration.target.id,
                configurationRevision: submission.configuration.revision, configurationVersion: submission.configuration.serverVersion, mode: submission.settings.mode })),
            pendingAgentReplies: this.agentReplies.length,
            requestInput: this.pendingAgent ? { sourceRevision: this.pendingAgent.input.source.revision,
                sourceLength: this.pendingAgent.input.source.value.length, configurationRevision: this.pendingAgent.input.context.configurationRevision } : null,
            proposalTransactionMs: this.proposalTransactionMs, pendingCommands: this.operations.size,
            inputRecovery: this.recoveryCell.get().items.map(item => ({ documentId: item.documentId, expectedRevision: item.expectedRevision, reason: item.reason, contextFrom: item.contextFrom, attemptedUnits: item.attemptedText.length })),
            hostSubscriptions: this.layoutCell.count() + this.activityCell.count() + this.settingsCell.count() + this.recoveryCell.count() + this.referenceCell.count() + this.conflictCell.count(), inputCaptureGuards: this.inputCaptureGuards.size, loadPending: this.pendingLoad !== undefined, disposed: this.disposed };
    }
    dispose(): Promise<void> {
        if (this.disposal) return this.disposal; this.disposed = true; this.variants.dispose();
        this.inputCaptureGuards.clear();
        if (this.timer !== undefined) clearInterval(this.timer); this.timer = undefined;
        this.workspace.interruptAgent(this.source.id);
        this.workspace.detachAgent(this.source.id);
        this.agentReplies.splice(0).forEach(reply => { reply.request.fail(); reply.resolve(""); });
        this.saves.splice(0).forEach(save => save.resolve({ kind: "conflict", serverVersion: this.serverVersion }));
        this.conflictReads.splice(0).forEach(read => { read.operation.cancel(); read.operation.finish(); });
        this.runs.splice(0).forEach(run => run.resolve());
        this.updateActivity({ pendingRuns: 0 });
        this.closeOperation?.finish(); this.closeOperation = undefined;
        this.finishLoad();
        this.disposal = Promise.allSettled([...this.operations]).then(() => {}); return this.disposal;
    }
}
