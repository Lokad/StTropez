import type { DocumentId, DocumentSnapshot, ResourceLease, SelectionSet, TabId, TabTarget, Workspace } from "../../src/index.ts";
import type { EditingCandidate } from "../../src/browser/index.ts";
import { createNavigationClient, navigationMetrics } from "../editing/navigation-client.ts";
import { validateProjectCommand } from "../probes/project-commands.ts";
import type { ProjectCommand, ProjectCommandKind, ProjectOutcome, ProjectServerRequest } from "../probes/project-commands.ts";
import { HostCell } from "../shared/observable.ts";
import type { LspApplyEdit, LspApplyEditResult, LspRequestContext, LspWorkspaceEdit, LspWorkspace } from "../../src/protocol/index.ts";
import type { LspProjectClient, LspProjectFactory } from "../editing/lsp-project-client.ts";
import type { LspCommandReceipt, LspCommandScope } from "../../src/protocol/index.ts";
import type { ActionNote } from "./code-actions.ts";
type Session = { token: number; id: string; target: TabTarget; editor: EditingCandidate };
type Job = { origin: Session; input: ProjectCommand; documents: Map<string, DocumentSnapshot>; revisions: Map<string, number>; authority: Map<string, string>;
    leases: ResourceLease[]; stops: (() => void)[]; timer: number; invalid: boolean; applied: boolean; selections: SelectionSet; folds: number;
    review?: Review; providerCurrent?: () => boolean; externalCancel?: () => void; changes: ProjectSnapshot["changes"] };
type Review = { token: number; request: LspApplyEdit; context: LspRequestContext; finish: (result: LspApplyEditResult) => void; stop: () => void; timer: number; page: number };
export type ProjectReview = Readonly<{ token: number; label: string; count: number; page: number; notes: readonly ActionNote[]; canApply: boolean }>;
export type ProjectActionReceipt = Readonly<{ success: boolean; applied: boolean; reason: string; changes: ProjectSnapshot["changes"] }>;
export type ProjectActionHandle = Readonly<{ cancel: () => void; applied: () => boolean; result: Promise<ProjectActionReceipt> }>;
export type ProjectActionEditPolicy = (request: LspApplyEdit) => "apply" | "review" | "decline";
export type ProjectActionIntent = Readonly<{ editor: EditingCandidate; sources: readonly Readonly<{ document: DocumentSnapshot; authority: string }>[];
    edit: LspWorkspaceEdit | null; isCurrent: () => boolean; subscribe: (listener: () => void) => () => void; cancel: () => void;
    execute: (scope: LspCommandScope) => Promise<LspCommandReceipt> }>;
export type ProjectSnapshot = Readonly<{ available: boolean; connected: boolean; disconnected: boolean; reconnectRequired: boolean; registered: boolean; pending: boolean;
    status: "idle" | "pending" | "ready" | "rejected" | "failed" | "cancelled"; message: string; view: string | null; changes: readonly Readonly<{ document: DocumentId; title: string }>[]; review: ProjectReview | null }>;
let sessionSerial = 0;
/** Local protocol owner. Server edits use the workspace's existing atomic shared-history transaction. */
export class HostProjectTools {
    private readonly workspace: Workspace;
    private readonly canCapture: (id: DocumentId) => boolean;
    private readonly present: (id: DocumentId) => EditingCandidate | undefined;
    private changes: ProjectSnapshot["changes"] = [];
    private readonly sessions = new Map<number, Session>();
    private active: Session | undefined;
    private job: Job | undefined;
    private client: ReturnType<typeof createNavigationClient> | undefined;
    private backend: LspProjectClient | undefined;
    private stopBackend: (() => void) | undefined;
    private readonly backendFactory: LspProjectFactory | undefined;
    private readonly provider: LspWorkspace | undefined;
    private readonly actionEditPolicy: ProjectActionEditPolicy | undefined;
    readonly usesLsp: boolean;
    private reviewSerial = 0;
    private registered = false;
    private disconnected = false;
    private disposed = false;
    private publishing = false;
    private serial = 0;
    private delay = 0;
    private fault: ProjectCommand["fault"];
    private readonly worker = navigationMetrics();
    private readonly metrics = { requested: 0, serverRequests: 0, applied: 0, rejected: 0, cancelled: 0, failed: 0 };
    private readonly cell = new HostCell<ProjectSnapshot>({ available: false, connected: false, disconnected: false, reconnectRequired: false, registered: false, pending: false, status: "idle", message: "Focus a candidate source to use workspace provider commands.", view: null, changes: [], review: null });
    readonly state = this.cell.observable;
    constructor(workspace: Workspace, canCapture: (id: DocumentId) => boolean, present: (id: DocumentId) => EditingCandidate | undefined, backendFactory?: LspProjectFactory, provider?: LspWorkspace, actionEditPolicy?: ProjectActionEditPolicy, reconnectProvider?: () => void) {
        this.reconnectProvider = reconnectProvider;
        this.workspace = workspace; this.canCapture = canCapture; this.present = present; this.backendFactory = backendFactory; this.provider = provider; this.usesLsp = backendFactory !== undefined || provider !== undefined; this.actionEditPolicy = actionEditPolicy;
    }
    private available(s: Session): boolean {
        const tab = this.workspace.resolveTab(s.target);
        return !this.disposed && this.sessions.get(s.token) === s && s.editor.element.isConnected && !s.editor.activity().disposed && this.workspace.ownsDocumentView(s.editor.view)
            && tab?.surface.kind === "text" && tab.surface.documentId === s.editor.view.documentId && this.workspace.observeDocument(s.editor.view.documentId).getSnapshot() !== undefined;
    }
    private authority(id: DocumentId): string { const m = this.workspace.resourceForDocument(id).metadata.getSnapshot(); return JSON.stringify([m.state, m.capabilities.edit, m.editLock]); }
    private publish(patch: Partial<ProjectSnapshot> = {}): void {
        const job = this.job, review = job?.review;
        const all = review?.request.edit.documents.flatMap(change => change.edits.map(edit => ({ doc: change.target.document, edit }))) ?? [];
        const preview = job && review ? Object.freeze({ token: review.token, label: review.request.label ?? "Provider workspace edit", count: all.length, page: review.page,
            canApply: this.current(job) && review.context.isCurrent() && review.request.edit.isCurrent() && all.every(({ doc }) => this.editable(doc.documentId as DocumentId)),
            notes: Object.freeze(all.slice(review.page * 64, (review.page + 1) * 64).map(({ doc, edit }) => Object.freeze({ document: doc.documentId, resource: doc.resourceId, title: job.documents.get(doc.documentId)!.title.slice(0, 128), revision: doc.revision, from: edit.from, to: edit.to,
                insert: edit.insert.slice(0, 256), insertUnits: edit.insert.length, context: doc.buffer.slice(Math.max(0, edit.from - 32), Math.min(edit.to, edit.from + 128)) + (edit.to - edit.from > 128 ? "…" : "") + doc.buffer.slice(edit.to, Math.min(doc.buffer.length, edit.to + 32)) }))) }) : null;
        this.cell.set({ ...this.cell.get(), ...patch, available: !!this.active && this.available(this.active), connected: this.backend?.snapshot().connected ?? this.client?.snapshot().connected ?? false,
            disconnected: this.disconnected, reconnectRequired: this.provider?.state.getSnapshot().commandRequiresReconnect ?? false, registered: this.registered, pending: !!job, view: this.active?.id ?? null, changes: this.changes, review: preview });
    }
    private editable(document: DocumentId): boolean { const m = this.workspace.resourceForDocument(document).metadata.getSnapshot(); return m.capabilities.edit.includes("human") && m.capabilities.edit.includes("host") && m.editLock === null; }
    private drop(): void { const client = this.client, backend = this.backend; this.client = undefined; this.backend = undefined; this.stopBackend?.(); this.stopBackend = undefined; this.registered = false; client?.dispose(); backend?.dispose(); }
    private connectionChanged(): void {
        if (this.backend) {
            const backend = this.backend, state = backend.snapshot(), job = this.job; this.registered = state.registered;
            if (job?.externalCancel) {
                if (!state.connected && !state.busy) queueMicrotask(() => { if (this.backend === backend) { this.drop(); this.publish(); } });
                this.publish(); return;
            }
            if (!state.connected && !state.busy || job && !backend.isCurrent()) {
                if (!state.connected) this.disconnected = true;
                if (job) job.invalid = true;
                queueMicrotask(() => { if (this.backend !== backend) return; this.cancel(); this.drop(); this.publish({ status: "failed", message: job?.applied ? "Provider connection or capability changed after application; the edit remains available to undo." : "Provider connection or capability changed; reconnect and request fresh work." }); });
            }
            this.publish(); return;
        }
        const transport = this.client?.snapshot();
        if (!transport?.connected) this.registered = false;
        if (transport && !transport.connected && !transport.busy) {
            this.metrics.failed++; this.drop(); this.publish({ status: "failed", message: "Workspace provider connection failed; register again to reconnect." });
        } else this.publish();
    }
    private current(job: Job): boolean {
        if (this.job !== job || job.invalid || !this.available(job.origin) || job.providerCurrent && !job.providerCurrent()
            || this.usesLsp && (job.origin.editor.view.getSnapshot().selectionSet !== job.selections || job.origin.editor.view.folding.getSnapshot().generation !== job.folds)) return false;
        try { for (const [id, doc] of job.documents) if (this.workspace.observeDocument(doc.id).getSnapshot()?.revision !== job.revisions.get(id)
            || this.authority(doc.id) !== job.authority.get(id) || !this.canCapture(doc.id)) return false; } catch { return false; }
        return true;
    }
    private release(job: Job): void {
        if (job.review) this.finishReview(job, job.review, { applied: false, failureReason: "Captured provider work ended or was cancelled." });
        if (this.job === job) this.job = undefined; job.invalid = true;
        job.origin.editor.element.ownerDocument.defaultView!.clearTimeout(job.timer); job.stops.splice(0).forEach(stop => stop()); job.leases.splice(0).forEach(lease => lease.release());
    }
    readonly cancel = (): void => {
        const job = this.job; if (!job) return; if (job.externalCancel) job.externalCancel(); else this.drop(); this.release(job); this.metrics.cancelled++;
        this.publish({ status: "cancelled", message: job.applied ? "Provider work cancelled after application; the edit remains available to undo." : "Provider work cancelled; source is unchanged." });
    };
    readonly disconnect = (): void => { this.cancel(); this.drop(); this.disconnected = true; this.publish({ status: "idle", message: "Workspace provider disconnected; local editing remains available." }); };
    private readonly reconnectProvider: (() => void) | undefined;
    readonly reconnect = (): void => { this.cancel(); this.drop(); this.disconnected = false; this.reconnectProvider?.(); this.publish({ status: "idle", message: "Register again with current working snapshots." }); };
    attach(id: string, tab: TabId, editor: EditingCandidate): () => void {
        const session = { token: ++sessionSerial, id, target: this.workspace.captureTab(tab), editor }, events = new AbortController(); this.sessions.set(session.token, session);
        editor.input.addEventListener("focus", () => { this.active = session; this.publish(); }, { signal: events.signal });
        for (const event of ["beforeinput", "compositionstart", "paste", "cut"] as const) editor.input.addEventListener(event, () => { if (this.job?.documents.has(editor.view.documentId)) this.cancel(); }, { signal: events.signal });
        let detached = false;
        return () => { if (detached) return; detached = true; if (this.job?.origin === session) this.cancel(); events.abort(); this.sessions.delete(session.token);
            if (this.active === session) this.active = undefined; if (!this.sessions.size) this.drop(); this.publish(); };
    }
    private accept(job: Job, request: ProjectServerRequest): ProjectOutcome {
        this.metrics.serverRequests++;
        if (!this.current(job)) { this.metrics.rejected++; return { applied: false, reason: "Captured resource, revision, authority or input changed." }; }
        if (request.method !== "edit") { this.registered = request.method === "register"; this.publish(); return { applied: true, reason: this.registered ? "Review command registered for this connection." : "Review command unregistered." }; }
        if (!this.registered) { this.metrics.rejected++; return { applied: false, reason: "The review capability is not registered." }; }
        for (const at of request.edits) {
            const doc = job.documents.get(at.document)!, m = this.workspace.resourceForDocument(doc.id).metadata.getSnapshot();
            if (!m.capabilities.edit.includes("human") || !m.capabilities.edit.includes("host") || m.editLock !== null) { this.metrics.rejected++; return { applied: false, reason: "Every target must allow human and host editing without a lock." }; }
        }
        this.publishing = true;
        try {
            if (!request.edits.length) return { applied: true, reason: "All captured resources already contain the review markers." };
            const result = this.workspace.editDocuments(request.edits.map(at => ({ documentId: job.documents.get(at.document)!.id, expectedRevision: at.revision, edits: at.edits,
                origin: "host" as const, history: { kind: "replace" as const }, ...(at.document === job.origin.editor.view.documentId ? { view: job.origin.editor.view } : {}) })));
            if (!result.applied) { this.metrics.rejected++; return { applied: false, reason: result.reason }; }
            for (const doc of job.documents.values()) job.revisions.set(doc.id, this.workspace.document(doc.id).revision);
            this.changes = request.edits.map(at => { const doc = job.documents.get(at.document)!; return { document: doc.id, title: doc.title.slice(0, 128) }; });
            job.applied = true; this.metrics.applied++; return { applied: true, reason: `Applied provider edits to ${request.edits.length} captured working resources as one undo command.` };
        } finally { this.publishing = false; }
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
            job.leases.push(this.workspace.acquire(document.resourceId)); job.documents.set(document.id, document);
            job.revisions.set(document.id, document.revision); job.authority.set(document.id, this.authority(document.id));
            const changed = () => { if (!this.publishing && this.job === job && !this.current(job)) { job.invalid = true; queueMicrotask(() => { if (this.job === job) this.cancel(); }); } };
            job.stops.push(this.workspace.observeDocument(document.id).subscribe(changed), this.workspace.resourceForDocument(document.id).metadata.subscribe(changed));
        }
        if (policy) {
            try {
                const decision = policy(request);
                if (decision === "apply") { if (!context.isCurrent()) throw new Error("Captured edit request changed."); this.applyCaptured(job, request.edit); return Promise.resolve({ applied: true }); }
                if (decision === "decline") return Promise.resolve({ applied: false, failureReason: "The host declined this command edit." });
            } catch (error) { return Promise.resolve({ applied: false, failureReason: error instanceof Error ? error.message : "Host edit policy failed." }); }
        }
        return new Promise(resolve => {
            const review: Review = { token: ++this.reviewSerial, request, context, finish: resolve, stop: () => {}, timer: 0, page: 0 }; job.review = review;
            review.stop = context.onCancel(() => { if (this.finishReview(job, review, { applied: false, failureReason: "Provider edit request cancelled or invalidated." })) this.publish({ message: "Provider edit request cancelled; no pending decision remains." }); });
            review.timer = job.origin.editor.element.ownerDocument.defaultView!.setTimeout(() => { if (this.finishReview(job, review, { applied: false, failureReason: "Provider edit review timed out." })) this.publish({ message: "Provider edit review timed out without application." }); }, 90000);
            this.publish({ message: "Review every captured provider edit, then apply or decline the batch." });
        });
    }
    private applyCaptured(job: Job, edit: LspWorkspaceEdit): number {
        if (!this.current(job) || !edit.isCurrent() || edit.documents.some(change => change.edits.length && !this.editable(change.target.document.documentId as DocumentId))) throw new Error("Captured edit revision, authority or provider changed.");
        this.publishing = true;
        try {
            const requests = edit.documents.filter(change => change.edits.length).map(change => {
                const doc = job.documents.get(change.target.document.documentId)!;
                if (doc.resourceId !== change.target.document.resourceId || doc.buffer !== change.target.document.buffer || doc.revision !== change.target.document.revision) throw new Error("Provider edit target differs from its captured working resource.");
                return { documentId: doc.id, expectedRevision: doc.revision, edits: change.edits, origin: "host" as const, history: { kind: "replace" as const }, ...(doc.id === job.origin.editor.view.documentId ? { view: job.origin.editor.view } : {}) };
            });
            const result = this.workspace.editDocuments(requests); if (!result.applied) throw new Error(result.reason);
            const changed = requests.filter(request => this.workspace.document(request.documentId).buffer !== job.documents.get(request.documentId)!.buffer);
            if (changed.length) {
                job.applied = true; this.metrics.applied++;
                const all = new Map(job.changes.map(change => [change.document, change]));
                for (const request of changed) all.set(request.documentId, Object.freeze({ document: request.documentId, title: job.documents.get(request.documentId)!.title.slice(0, 128) }));
                job.changes = this.changes = Object.freeze([...all.values()]);
            }
            for (const [id, doc] of job.documents) { const current = this.workspace.document(doc.id); job.documents.set(id, current); job.revisions.set(id, current.revision); }
            job.selections = job.origin.editor.view.getSnapshot().selectionSet; job.folds = job.origin.editor.view.folding.getSnapshot().generation;
            return changed.length;
        } finally { this.publishing = false; }
    }
    confirmReview(token: number | null): void {
        const job = this.job, review = job?.review; if (!job || !review || token !== review.token) return;
        if (!this.current(job) || !review.context.isCurrent() || !review.request.edit.isCurrent() || review.request.edit.documents.some(change => change.edits.length && !this.editable(change.target.document.documentId as DocumentId))) {
            this.metrics.rejected++; this.finishReview(job, review, { applied: false, failureReason: "Captured revision, authority, view or provider request changed." }); this.publish({ message: "Provider edits refused; source is unchanged by this decision." }); return;
        }
        let committed = false;
        try {
            const changed = this.applyCaptured(job, review.request.edit); committed = true;
            this.finishReview(job, review, { applied: true }); this.publish({ message: changed ? "Captured provider edits applied as one undo command; waiting for acknowledgement." : "The provider edit batch made no text changes; waiting for acknowledgement." });
        } catch (error) {
            if (committed) { job.applied = true; this.finishReview(job, review, { applied: true }); this.publish({ message: "Provider edits were applied; any later failure leaves them available to undo." }); }
            else { this.metrics.rejected++; this.finishReview(job, review, { applied: false, failureReason: error instanceof Error ? error.message : "Provider edits refused." }); this.publish({ message: "Provider edit batch refused without application." }); }
        }
    }
    canRunAction(editor: EditingCandidate): boolean { return this.usesLsp && !this.disposed && !this.job && !this.provider?.state.getSnapshot().commandRequiresReconnect && [...this.sessions.values()].some(session => session.editor === editor && this.available(session)); }
    /** Transfer a confirmed action to the existing review owner, independent of later focus. */
    beginAction(intent: ProjectActionIntent): ProjectActionHandle | undefined {
        const origin = [...this.sessions.values()].find(session => session.editor === intent.editor && this.available(session));
        if (!origin || !this.canRunAction(intent.editor) || !intent.isCurrent()) return undefined;
        const docs = intent.sources.map(source => source.document), win = intent.editor.element.ownerDocument.defaultView!;
        const input = validateProjectCommand({ id: ++this.serial, kind: "review", documents: docs.map(doc => ({ document: doc.id, revision: doc.revision, length: doc.buffer.length })), delay: 0 });
        const job: Job = { origin, input, documents: new Map(docs.map(doc => [doc.id, doc])), revisions: new Map(docs.map(doc => [doc.id, doc.revision])), authority: new Map(intent.sources.map(source => [source.document.id, source.authority])),
            leases: [], stops: [], timer: 0, invalid: false, applied: false, selections: intent.editor.view.getSnapshot().selectionSet, folds: intent.editor.view.folding.getSnapshot().generation,
            externalCancel: intent.cancel, providerCurrent: intent.isCurrent, changes: [] };
        this.job = job;
        const changed = () => { if (!this.publishing && this.job === job && !this.current(job)) { job.invalid = true; queueMicrotask(() => { if (this.job === job) this.cancel(); }); } };
        try {
            for (const doc of docs) { job.leases.push(this.workspace.acquire(doc.resourceId)); job.stops.push(this.workspace.observeDocument(doc.id).subscribe(changed), this.workspace.resourceForDocument(doc.id).metadata.subscribe(changed)); }
            job.stops.push(origin.editor.view.subscribe(changed), origin.editor.view.folding.subscribe(changed), this.workspace.tabState.subscribe(changed), intent.subscribe(changed));
            job.timer = win.setTimeout(() => { if (this.job === job) this.cancel(); }, 120000);
            if (!this.current(job)) throw new Error("Captured action intent changed before handoff.");
            this.publish({ status: "pending", message: "Executing the confirmed action under the host's captured edit policy." });
        } catch (error) { this.release(job); throw error; }
        const result = Promise.resolve().then(() => intent.execute({ snapshots: () => [...job.documents.values()], isCurrent: () => this.current(job),
            prepare: () => { if (!this.current(job)) throw new Error("Captured action intent changed."); if (intent.edit) this.applyCaptured(job, intent.edit); }, review: (request, context) => this.review(job, request, context, this.actionEditPolicy) })).then(receipt => {
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
        return Object.freeze({ cancel: () => { if (this.job === job) this.cancel(); }, applied: () => job.applied, result });
    }
    declineReview(token: number | null): void { const job = this.job, review = job?.review; if (job && review && token === review.token) { this.metrics.rejected++; this.finishReview(job, review, { applied: false, failureReason: "Provider edits declined." }); this.publish({ message: "Provider edits declined; waiting for acknowledgement." }); } }
    nextReviewPage(): void { const job = this.job, review = job?.review; if (job && review && this.current(job) && (review.page + 1) * 64 < (this.cell.get().review?.count ?? 0)) { review.page++; this.publish(); } }
    previousReviewPage(): void { const job = this.job, review = job?.review; if (job && review && this.current(job) && review.page > 0) { review.page--; this.publish(); } }
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
        if (this.disconnected || this.job || !origin || !this.available(origin)) { this.publish({ message: "Focus an available source and reconnect or finish pending work first." }); return; }
        if (kind === "register" ? this.registered : kind !== "status" && !this.registered) { this.publish({ message: "Register the review command before using it; unregister before registering again." }); return; }
        const docs = this.workspace.getSnapshot().documents.filter(d => d.key.variant === "working");
        if (docs.some(d => !this.canCapture(d.id))) { this.publish({ message: "Finish pending input, navigation, table conversion or composition first." }); return; }
        let input: ProjectCommand;
        try { input = validateProjectCommand({ id: ++this.serial, kind, documents: docs.map(d => ({ document: d.id, revision: d.revision, length: d.buffer.length })), delay: this.delay, ...(this.fault ? { fault: this.fault } : {}) }); }
        catch (error) { this.fault = undefined; this.publish({ status: "failed", message: error instanceof Error ? error.message : "Invalid provider capture." }); return; }
        this.fault = undefined; const win = origin.editor.element.ownerDocument.defaultView!;
        const job: Job = { origin, input, documents: new Map(docs.map(d => [d.id, d])), revisions: new Map(docs.map(d => [d.id, d.revision])), authority: new Map(docs.map(d => [d.id, this.authority(d.id)])), leases: [], stops: [], timer: 0, invalid: false, applied: false,
            selections: origin.editor.view.getSnapshot().selectionSet, folds: origin.editor.view.folding.getSnapshot().generation, changes: [] };
        this.job = job; this.metrics.requested++;
        try {
            const changed = () => { if (!this.publishing && this.job === job && !this.current(job)) { job.invalid = true; queueMicrotask(() => { if (this.job === job) this.cancel(); }); } };
            for (const doc of docs) { job.leases.push(this.workspace.acquire(doc.resourceId)); job.stops.push(this.workspace.observeDocument(doc.id).subscribe(changed), this.workspace.resourceForDocument(doc.id).metadata.subscribe(changed)); }
            job.stops.push(this.workspace.tabState.subscribe(changed));
            if (this.usesLsp) job.stops.push(origin.editor.view.subscribe(changed), origin.editor.view.folding.subscribe(changed));
            job.timer = win.setTimeout(() => { if (this.job === job) { this.cancel(); this.publish({ status: "failed", message: "Workspace provider timed out; any applied edit remains available to undo." }); } }, this.usesLsp ? 120000 : 30000);
            this.publish({ status: "pending", message: `Waiting for captured provider ${kind}.` });
            if (this.backendFactory) {
                if (!this.backend) { this.backend = this.backendFactory(); this.stopBackend = this.backend.subscribe(() => this.connectionChanged()); }
                job.providerCurrent = () => this.backend?.isCurrent() ?? false;
                void this.backend.run(input, { snapshots: () => [...job.documents.values()], isCurrent: () => this.current(job), review: (request, context) => this.review(job, request, context) }).then(result => {
                    if (this.job !== job) return; this.release(job); this.registered = result.registered;
                    this.publish({ status: result.applied ? "ready" : "rejected", message: !result.applied && job.applied ? `Earlier provider edits remain applied and undoable. ${result.reason}` : result.reason });
                }).catch(error => { if (this.job !== job) return; this.metrics.failed++; this.drop(); this.release(job); this.publish({ status: "failed", message: job.applied ? "Provider acknowledgement failed after application; the edit remains available to undo." : error instanceof Error ? error.message : "Workspace provider failed; source is unchanged." }); });
                return;
            }
            this.client ??= createNavigationClient(win, this.worker, undefined, () => this.connectionChanged());
            void this.client.command(input, new Map(docs.map(d => [d.id, d.buffer])), request => this.accept(job, request)).then(result => {
                if (this.job !== job) return; this.release(job); this.registered = result.registered;
                this.publish({ status: result.applied ? "ready" : "rejected", message: result.reason });
            }).catch(error => {
                if (this.job !== job) return; this.metrics.failed++; this.drop(); this.release(job);
                this.publish({ status: "failed", message: job.applied ? "Provider acknowledgement failed after application; the edit remains available to undo." : error instanceof Error ? error.message : "Workspace provider failed; source is unchanged." });
            });
        } catch (error) { this.drop(); this.release(job); this.publish({ status: "failed", message: error instanceof Error ? error.message : "Workspace provider is unavailable." }); }
    }
    setDelay(value: number): void { if (!Number.isFinite(value) || value < 0 || value > 1000) throw new RangeError("Invalid project delay."); this.delay = value; }
    faultNext(value: NonNullable<ProjectCommand["fault"]>): void { this.fault = value; }
    faultIdle(): boolean { return this.backend?.faultIdle() ?? this.client?.faultIdle() ?? false; }
    debug() { return { ...this.metrics, worker: { ...this.worker }, state: this.cell.get(), pending: !!this.job, registered: this.registered, transport: this.backend?.snapshot() ?? this.client?.snapshot() ?? null, sessions: this.sessions.size, subscriptions: this.cell.count(), disposed: this.disposed }; }
    dispose(): void { if (this.disposed) return; this.cancel(); this.drop(); this.disposed = true; this.active = undefined; this.changes = []; this.publish(); }
}
