import { onSourceFocus } from "./source-focus.ts";
import type { DocumentId, DocumentSnapshot, ResourceLease, TabId, TabTarget, Workspace } from "../../src/index.ts";
import { captureViewRequest } from "../../src/browser/index.ts";
import type { CapturedViewRequest, CodeActionCommand, CodeActionExecution, TextEditor } from "../../src/browser/index.ts";
import { ProviderLane } from "../shared/provider-lane.ts";
import { validateNavigationDocuments } from "../../fixtures/language/navigation.ts";
import { validateProjectCommand } from "../../fixtures/language/project-commands.ts";
import type { ProjectCommand, ProjectCommandKind } from "../../fixtures/language/project-commands.ts";
import { HostCell } from "../shared/observable.ts";
import type { LspApplyEdit, LspApplyEditResult, LspCommandScope, LspRequestContext, LspWorkspaceEdit, LspWorkspace } from "../../src/protocol/index.ts";
import type { LspProjectClient, LspProjectFactory } from "../shared/language/lsp-project-client.ts";
import { applyLspWorkspaceEdit, previewLspWorkspaceEdit } from "../../src/protocol/index.ts";
import type { LspWorkspaceEditNote } from "../../src/protocol/index.ts";
type Session = { token: number; id: string; target: TabTarget; editor: TextEditor };
type Participant = { document: DocumentSnapshot; readonly authority: string };
type Job = { origin: Session; source: string; documents: Map<string, Participant>;
    leases: ResourceLease[]; stops: (() => void)[]; timer: number; invalid: boolean; applied: boolean; capture: CapturedViewRequest;
    review?: Review; providerCurrent?: () => boolean; externalCancel?: () => void; changes: ProjectSnapshot["changes"] };
type Review = { key: number; request: LspApplyEdit; context: LspRequestContext; finish: (result: LspApplyEditResult) => void; stop: () => void; timer: number; page: number };
export type ProjectReview = Readonly<{ key: number; apply: () => void; decline: () => void; nextPage: () => void; previousPage: () => void; label: string; count: number; page: number; notes: readonly LspWorkspaceEditNote[]; canApply: boolean }>;
export type ProjectActionEditPolicy = (request: LspApplyEdit) => "apply" | "review" | "decline";
export type ProjectSnapshot = Readonly<{ available: boolean; connected: boolean; disconnected: boolean; reconnectRequired: boolean; registered: boolean; pending: boolean;
    status: "idle" | "pending" | "ready" | "rejected" | "failed" | "cancelled"; message: string; view: string | null; changes: readonly Readonly<{ document: DocumentId; title: string }>[]; review: ProjectReview | null }>;
/** Local protocol owner. Server edits use the workspace's existing atomic shared-history transaction. */
export class HostProjectTools {
    private readonly workspace: Workspace;
    private readonly canCapture: (id: DocumentId) => boolean;
    private readonly present: (id: DocumentId) => TextEditor | undefined;
    private changes: ProjectSnapshot["changes"] = [];
    private readonly sessions = new Map<number, Session>();
    private active: Session | undefined;
    private job: Job | undefined;
    private readonly lane = new ProviderLane<LspProjectClient>(client => this.connectionChanged(client));
    private readonly createClient: LspProjectFactory | undefined;
    private readonly provider: LspWorkspace | undefined;
    private readonly actionEditPolicy: ProjectActionEditPolicy | undefined;
    private registered = false;
    private disconnected = false;
    private disposed = false;
    private delay = 0;
    private fault: ProjectCommand["fault"];
    private readonly metrics = { requested: 0, serverRequests: 0, applied: 0, rejected: 0, cancelled: 0, failed: 0 };
    private readonly cell = new HostCell<ProjectSnapshot>({ available: false, connected: false, disconnected: false, reconnectRequired: false, registered: false, pending: false, status: "idle", message: "Focus a candidate source to use workspace provider commands.", view: null, changes: [], review: null });
    readonly state = this.cell.observable;
    constructor(workspace: Workspace, canCapture: (id: DocumentId) => boolean, present: (id: DocumentId) => TextEditor | undefined, createClient?: LspProjectFactory, provider?: LspWorkspace, actionEditPolicy?: ProjectActionEditPolicy, reconnectProvider?: () => void) {
        this.reconnectProvider = reconnectProvider;
        this.workspace = workspace; this.canCapture = canCapture; this.present = present; this.createClient = createClient; this.provider = provider; this.actionEditPolicy = actionEditPolicy;
    }
    private available(s: Session): boolean {
        return !this.disposed && this.sessions.get(s.token) === s && s.editor.element.isConnected && !s.editor.activity().disposed
            && this.workspace.ownsDocumentView(s.editor.view, s.target) && !!this.workspace.observeDocument(s.editor.view.documentId).getSnapshot();
    }
    private authority(id: DocumentId): string { const m = this.workspace.resourceForDocument(id).metadata.getSnapshot(); return JSON.stringify([m.state, m.capabilities.edit, m.editLock]); }
    private publish(patch: Partial<ProjectSnapshot> = {}): void {
        const job = this.job, review = job?.review;
        const preview = job && review ? Object.freeze({ ...this.reviewActions(review.key, review.page), label: review.request.label ?? "Provider workspace edit",
            ...previewLspWorkspaceEdit(review.request.edit, id => job.documents.get(id)!.document.title, review.page),
            canApply: this.editRefusal(job, review.request.edit, review.context) === null }) : null;
        this.cell.set({ ...this.cell.get(), ...patch, available: !!this.active && this.available(this.active), connected: this.lane.value?.snapshot().connected ?? false,
            disconnected: this.disconnected, reconnectRequired: this.provider?.getSnapshot().commandRequiresReconnect ?? false, registered: this.registered, pending: !!job, view: this.active?.id ?? null, changes: this.changes, review: preview });
    }
    private editRefusal(job: Job, edit: LspWorkspaceEdit, context?: LspRequestContext): string | null {
        if (context && !context.isCurrent()) return "Captured edit request changed.";
        if (!this.current(job) || !edit.isCurrent()) return "Captured edit revision or provider changed.";
        for (const change of edit.documents) {
            if (!change.edits.length) continue;
            const { capabilities, editLock } = this.workspace.resourceForDocument(change.target.document.documentId as DocumentId).metadata.getSnapshot();
            if (editLock || !capabilities.edit.includes("human") || !capabilities.edit.includes("host")) return "An edit target is read-only or locked.";
        }
        return null;
    }
    private drop(): void { this.registered = false; this.lane.drop(); }
    private connectionChanged(client: LspProjectClient): void {
        const state = client.snapshot(), job = this.job; this.registered = state.registered;
        if (job?.externalCancel) {
            if (!state.connected && !state.busy) queueMicrotask(() => { if (this.lane.value === client) { this.drop(); this.publish(); } });
            this.publish(); return;
        }
        if (!state.connected && !state.busy || job && !client.isCurrent()) {
            if (!state.connected) this.disconnected = true;
            if (job) job.invalid = true;
            queueMicrotask(() => { if (this.lane.value !== client) return; this.cancel(); this.drop(); this.publish({ status: "failed", message: job?.applied ? "Provider connection or capability changed after application; the edit remains available to undo." : "Provider connection or capability changed; reconnect and request fresh work." }); });
        }
        this.publish(); return;
    }
    private current(job: Job): boolean {
        if (this.job !== job || job.invalid) return false;
        try {
            if (!job.capture.isCurrent() || job.providerCurrent && !job.providerCurrent()) return false;
            for (const { document, authority } of job.documents.values()) {
                if (this.workspace.observeDocument(document.id).getSnapshot()?.revision !== document.revision
                    || this.authority(document.id) !== authority || !this.canCapture(document.id)) return false;
            }
        } catch { return false; }
        return true;
    }
    private capture(origin: Session): CapturedViewRequest | undefined {
        return captureViewRequest(this.workspace, origin.target, origin.editor.view,
            { available: () => this.available(origin) && this.canCapture(origin.editor.view.documentId) });
    }
    private changed(job: Job, followUp = queueMicrotask): void {
        if (this.job === job && !this.current(job)) {
            job.invalid = true; followUp(() => { if (this.job === job) this.cancel(); });
        }
    }
    private watchCapture(job: Job, capture: CapturedViewRequest): void {
        capture.signal.addEventListener("abort", () => { if (job.capture === capture) this.changed(job); }, { once: true });
    }
    private retainDocument(job: Job, document: DocumentSnapshot): void {
        const id = document.id, participant = { document, authority: this.authority(id) };
        job.documents.set(id, participant);
        if (id === job.capture.document.id) return;
        job.leases.push(this.workspace.acquire(document.resourceId));
        job.stops.push(this.workspace.onDocumentChange(id, (change, followUp) => {
            if (change.source !== job.source) this.changed(job, followUp);
        }));
        job.stops.push(this.workspace.resourceForDocument(id).metadata.subscribe(() => {
            const current = this.workspace.observeDocument(id).getSnapshot();
            if (this.authority(id) !== participant.authority || !current?.change && current?.revision !== participant.document.revision) this.changed(job);
        }));
    }
    private captureJob(origin: Session, documents: readonly DocumentSnapshot[]): Job | undefined {
        const capture = this.capture(origin);
        if (!capture) return;
        const job: Job = { origin, source: `project:${this.workspace.allocateIdentity()}`, capture, documents: new Map(),
            leases: [], stops: [], timer: 0, invalid: false, applied: false, changes: [] };
        this.job = job;
        try {
            this.watchCapture(job, capture);
            for (const document of documents) this.retainDocument(job, document);
            return job;
        } catch (error) { this.release(job); throw error; }
    }
    private commandScope(job: Job, policy?: ProjectActionEditPolicy): LspCommandScope {
        return { snapshots: () => Array.from(job.documents.values(), participant => participant.document),
            isCurrent: () => this.current(job), review: (request, context) => this.review(job, request, context, policy) };
    }
    private renewAfterEdit(job: Job): void {
        const previous = job.capture;
        try {
            for (const participant of job.documents.values()) participant.document = this.workspace.document(participant.document.id);
            const capture = this.capture(job.origin);
            if (capture) { job.capture = capture; this.watchCapture(job, capture); } else job.invalid = true;
        } catch { job.invalid = true; }
        finally { previous.cancel(); this.changed(job); }
    }
    private release(job: Job): void {
        if (job.review) this.finishReview(job, job.review, { applied: false, failureReason: "Captured provider work ended or was cancelled." });
        if (this.job === job) this.job = undefined; job.invalid = true;
        job.origin.editor.element.ownerDocument.defaultView!.clearTimeout(job.timer); job.stops.splice(0).forEach(stop => stop()); job.capture.cancel(); job.leases.splice(0).forEach(lease => lease.release());
    }
    readonly cancel = (): void => {
        const job = this.job; if (!job) return; if (job.externalCancel) job.externalCancel(); else this.drop(); this.release(job); this.metrics.cancelled++;
        this.publish({ status: "cancelled", message: job.applied ? "Provider work cancelled after application; the edit remains available to undo." : "Provider work cancelled; source is unchanged." });
    };
    readonly disconnect = (): void => { this.cancel(); this.drop(); this.disconnected = true; this.publish({ status: "idle", message: "Workspace provider disconnected; local editing remains available." }); };
    private readonly reconnectProvider: (() => void) | undefined;
    readonly reconnect = (): void => { this.cancel(); this.drop(); this.disconnected = false; this.reconnectProvider?.(); this.publish({ status: "idle", message: "Register again with current working snapshots." }); };
    attach(id: string, tab: TabId, editor: TextEditor): () => void {
        const session = { token: this.workspace.allocateIdentity(), id, target: this.workspace.tabs.capture(tab), editor }, events = new AbortController(); this.sessions.set(session.token, session);
        onSourceFocus(editor, events.signal, () => { this.active = session; this.publish(); });
        editor.onEditIntent(() => { if (this.job?.documents.has(editor.view.documentId)) this.cancel(); }, events.signal);
        let detached = false;
        return () => { if (detached) return; detached = true; if (this.job?.origin === session) this.cancel(); events.abort(); this.sessions.delete(session.token);
            if (this.active === session) this.active = undefined; if (!this.sessions.size) this.drop(); this.publish(); };
    }
    private finishReview(job: Job, review: Review, result: LspApplyEditResult): boolean {
        if (job.review !== review) return false; delete job.review; review.stop(); job.origin.editor.element.ownerDocument.defaultView!.clearTimeout(review.timer); review.finish(Object.freeze(result)); this.publish(); return true;
    }
    private review(job: Job, request: LspApplyEdit, context: LspRequestContext, policy?: ProjectActionEditPolicy): Promise<LspApplyEditResult> {
        this.metrics.serverRequests++;
        if (!this.current(job) || !context.isCurrent() || !request.edit.isCurrent() || job.review) { this.metrics.rejected++; return Promise.resolve({ applied: false, failureReason: "Captured edit intent is unavailable or changed." }); }
        if (!request.edit.documents.some(change => change.edits.length)) return Promise.resolve({ applied: true });
        // A server request can resolve targets beyond the initial command project. Its resolver
        // retains them through this decision; the command retains them until its final receipt.
        for (const change of request.edit.documents) {
            const target = change.target.document; if (job.documents.has(target.documentId)) continue;
            const document = this.workspace.getSnapshot().documents.find(document => document.id === target.documentId);
            if (!document || document.resourceId !== target.resourceId || document.revision !== target.revision || document.buffer !== target.buffer
                || !change.target.isCurrent() || !this.canCapture(document.id)) return Promise.resolve({ applied: false, failureReason: "A resolved edit target changed." });
            this.retainDocument(job, document);
        }
        if (policy) {
            try {
                const decision = policy(request);
                if (decision === "apply") { this.applyCaptured(job, request.edit, context); return Promise.resolve({ applied: true }); }
                if (decision === "decline") return Promise.resolve({ applied: false, failureReason: "The host declined this command edit." });
            } catch (error) { return Promise.resolve({ applied: false, failureReason: error instanceof Error ? error.message : "Host edit policy failed." }); }
        }
        return new Promise(resolve => {
            const review: Review = { key: this.workspace.allocateIdentity(), request, context, finish: resolve, stop: () => {}, timer: 0, page: 0 }; job.review = review;
            review.stop = context.onCancel(() => { if (this.finishReview(job, review, { applied: false, failureReason: "Provider edit request cancelled or invalidated." })) this.publish({ message: "Provider edit request cancelled; no pending decision remains." }); });
            review.timer = job.origin.editor.element.ownerDocument.defaultView!.setTimeout(() => { if (this.finishReview(job, review, { applied: false, failureReason: "Provider edit review timed out." })) this.publish({ message: "Provider edit review timed out without application." }); }, 90000);
            this.publish({ message: "Review every captured provider edit, then apply or decline the batch." });
        });
    }
    private applyCaptured(job: Job, edit: LspWorkspaceEdit, context?: LspRequestContext): number {
        const refusal = this.editRefusal(job, edit, context);
        if (refusal) throw new Error(refusal);
        // Resolved targets check the originating view during final validation. Keep its capture
        // alive through the synchronous write, then capture the resulting revisions and selection.
        const changed = applyLspWorkspaceEdit(this.workspace, edit, { origin: "host", source: job.source, requiredOrigins: ["human"], view: job.origin.editor.view });
        if (changed.length) {
            job.applied = true; this.metrics.applied++;
            const all = new Map(job.changes.map(change => [change.document, change]));
            for (const document of changed) all.set(document.id, Object.freeze({ document: document.id, title: document.title.slice(0, 128) }));
            job.changes = this.changes = Object.freeze([...all.values()]);
            this.renewAfterEdit(job);
        }
        return changed.length;
    }
    private reviewActions(key: number, page: number) {
        return { key, apply: () => this.confirmReview(key), decline: () => this.declineReview(key),
            previousPage: () => this.moveReviewPage(key, page, -1), nextPage: () => this.moveReviewPage(key, page, 1) };
    }
    private confirmReview(key: number): void {
        const job = this.job, review = job?.review; if (!job || !review || key !== review.key) return;
        let committed = false;
        try {
            const changed = this.applyCaptured(job, review.request.edit, review.context); committed = true;
            this.finishReview(job, review, { applied: true }); this.publish({ message: changed ? "Captured provider edits applied as one undo command; waiting for acknowledgement." : "The provider edit batch made no text changes; waiting for acknowledgement." });
        } catch (error) {
            if (committed) { job.applied = true; this.finishReview(job, review, { applied: true }); this.publish({ message: "Provider edits were applied; any later failure leaves them available to undo." }); }
            else {
                const message = error instanceof Error ? error.message : "Provider edits refused.";
                this.metrics.rejected++; this.finishReview(job, review, { applied: false, failureReason: message }); this.publish({ message });
            }
        }
    }
    canRunAction(editor: TextEditor): boolean { return (!this.disposed) && !this.job && !this.provider?.getSnapshot().commandRequiresReconnect && [...this.sessions.values()].some(session => session.editor === editor && this.available(session)); }
    /** Transfer a confirmed action to the existing review owner, independent of later focus. */
    beginAction(intent: CodeActionCommand & Readonly<{ editor: TextEditor }>): CodeActionExecution | undefined {
        const origin = [...this.sessions.values()].find(session => session.editor === intent.editor && this.available(session));
        if (!origin || !this.canRunAction(intent.editor) || !intent.isCurrent()) return undefined;
        const docs = intent.documents, win = intent.editor.element.ownerDocument.defaultView!;
        validateNavigationDocuments(docs.map(doc => ({ document: doc.id, revision: doc.revision, length: doc.buffer.length })));
        const job = this.captureJob(origin, docs);
        if (!job) return undefined;
        job.externalCancel = intent.cancel; job.providerCurrent = intent.isCurrent;
        try {
            job.stops.push(intent.subscribe(() => this.changed(job)));
            job.timer = win.setTimeout(() => { if (this.job === job) this.cancel(); }, 120000);
            if (!this.current(job)) throw new Error("Captured action intent changed before handoff.");
            this.publish({ status: "pending", message: "Executing the confirmed action under the host's captured edit policy." });
        } catch (error) { this.release(job); throw error; }
        const result = Promise.resolve().then(() => intent.execute({ ...this.commandScope(job, this.actionEditPolicy),
            prepare: () => { if (!this.current(job)) throw new Error("Captured action intent changed."); if (intent.edit) this.applyCaptured(job, intent.edit); } })).then(receipt => {
            if (!this.current(job)) throw new Error("Captured command intent changed.");
            const success = receipt.decision?.applied !== false, reason = success ? typeof receipt.value === "string" ? receipt.value.slice(0, 1024) : "Confirmed action command completed." : receipt.decision!.failureReason ?? "Provider edits declined.";
            const message = !success && job.applied ? `Earlier edits remain applied and undoable. ${reason}` : reason;
            this.release(job); this.publish({ status: success ? "ready" : "rejected", message });
            return Object.freeze({ success, applied: job.applied, reason: message, changes: Object.freeze([...job.changes]) });
        }).catch(error => {
            intent.cancel(); const failure = error instanceof Error ? error.message.slice(0, 1024) : "Action command failed.";
            const reason = job.applied ? `${failure} Earlier edits remain applied and undoable.` : failure;
            if (this.job === job) { this.release(job); this.publish({ status: "failed", message: reason }); }
            return Object.freeze({ success: false, applied: job.applied, reason, changes: Object.freeze([...job.changes]) });
        });
        return Object.freeze({ cancel: () => { if (this.job === job) this.cancel(); return { applied: job.applied }; }, result });
    }
    private declineReview(key: number): void { const job = this.job, review = job?.review; if (job && review && key === review.key) { this.metrics.rejected++; this.finishReview(job, review, { applied: false, failureReason: "Provider edits declined." }); this.publish({ message: "Provider edits declined; waiting for acknowledgement." }); } }
    private moveReviewPage(key: number, page: number, direction: -1 | 1): void {
        const job = this.job, review = job?.review, next = page + direction;
        if (!job || !review || review.key !== key || review.page !== page || !this.current(job)
            || next < 0 || next * 64 >= (this.cell.get().review?.count ?? 0)) return;
        review.page = next; this.publish();
    }
    readonly register = (): void => this.start("register");
    readonly unregister = (): void => this.start("unregister");
    readonly requestEdits = (): void => this.start("review");
    readonly requestStatus = (): void => this.start("status");
    openChanged(document: DocumentId): void {
        if (this.disposed || this.job || !this.changes.some(c => c.document === document)) return;
        try {
            if (!this.workspace.observeDocument(document).getSnapshot() || !this.canCapture(document)) { this.publish({ message: "Finish pending input or reopen an available changed resource." }); return; }
            const mounted = [...this.sessions.values()].find(s => s.editor.view.documentId === document && this.available(s));
            const editor = mounted?.editor ?? this.present(document);
            if (!editor || editor.view.documentId !== document) { this.publish({ message: "The changed resource cannot be presented in an available candidate pane." }); return; }
            editor.focus(); this.publish({ message: "Opened the captured changed resource. Undo/redo applies in a participating source view." });
        } catch { this.publish({ message: "The captured changed resource is no longer available." }); }
    }
    private start(kind: ProjectCommandKind): void {
        const origin = this.active;
        if (!this.createClient || this.disconnected || this.job || !origin || !this.available(origin)) { this.publish({ message: "Focus an available source and reconnect or finish pending work first." }); return; }
        if (kind === "register" ? this.registered : kind !== "status" && !this.registered) { this.publish({ message: "Register the review command before using it; unregister before registering again." }); return; }
        const docs = this.workspace.getSnapshot().documents.filter(d => d.key.variant === "working");
        if (docs.some(d => !this.canCapture(d.id))) { this.publish({ message: "Finish pending input, navigation, table conversion or composition first." }); return; }
        let input: ProjectCommand;
        try { input = validateProjectCommand({ kind, documents: docs.map(d => ({ document: d.id, revision: d.revision, length: d.buffer.length })), delay: this.delay, ...(this.fault ? { fault: this.fault } : {}) }); }
        catch (error) { this.fault = undefined; this.publish({ status: "failed", message: error instanceof Error ? error.message : "Invalid provider capture." }); return; }
        this.fault = undefined; const win = origin.editor.element.ownerDocument.defaultView!;
        let job: Job | undefined;
        try { job = this.captureJob(origin, docs); }
        catch (error) { this.publish({ status: "failed", message: error instanceof Error ? error.message : "Invalid provider capture." }); return; }
        if (!job) { this.publish({ message: "The source changed before capture; request fresh provider work." }); return; }
        this.metrics.requested++;
        try {
            job.timer = win.setTimeout(() => { if (this.job === job) { this.cancel(); this.publish({ status: "failed", message: "Workspace provider timed out; any applied edit remains available to undo." }); } }, (120000));
            this.publish({ status: "pending", message: `Waiting for captured provider ${kind}.` });
            const client = this.lane.acquire(this.createClient);
            job.providerCurrent = client.isCurrent;
            void client.run(input, this.commandScope(job)).then(result => {
                if (this.job !== job) return; this.release(job); this.registered = result.registered;
                this.publish({ status: result.applied ? "ready" : "rejected", message: !result.applied && job.applied ? `Earlier provider edits remain applied and undoable. ${result.reason}` : result.reason });
            }).catch(error => {
                if (this.job !== job) return; this.metrics.failed++; this.drop(); this.release(job);
                this.publish({ status: "failed", message: job.applied ? "Provider acknowledgement failed after application; the edit remains available to undo." : error instanceof Error ? error.message : "Workspace provider failed; source is unchanged." });
            });
        } catch (error) { this.drop(); this.release(job); this.publish({ status: "failed", message: error instanceof Error ? error.message : "Workspace provider is unavailable." }); }
    }
    setDelay(value: number): void { if (!Number.isFinite(value) || value < 0 || value > 1000) throw new RangeError("Invalid project delay."); this.delay = value; }
    faultNext(value: NonNullable<ProjectCommand["fault"]>): void { this.fault = value; }
    faultIdle(): boolean { return this.lane.value?.faultIdle() ?? false; }
    debug() { return { ...this.metrics, state: this.cell.get(), pending: !!this.job, registered: this.registered, transport: this.lane.value?.snapshot() ?? null, sessions: this.sessions.size, subscriptions: this.cell.count(), disposed: this.disposed }; }
    dispose(): void { if (this.disposed) return; this.cancel(); this.registered = false; this.lane.dispose(); this.disposed = true; this.active = undefined; this.changes = []; this.publish(); }
}
