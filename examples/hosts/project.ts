import type { DocumentId, DocumentSnapshot, ResourceLease, TabId, TabTarget, Workspace } from "../../src/index.ts";
import type { EditingCandidate } from "../../src/browser/index.ts";
import { createNavigationClient, navigationMetrics } from "../editing/navigation-client.ts";
import { validateProjectCommand } from "../probes/project-commands.ts";
import type { ProjectCommand, ProjectCommandKind, ProjectOutcome, ProjectServerRequest } from "../probes/project-commands.ts";
import { HostCell } from "../shared/observable.ts";
type Session = { token: number; id: string; target: TabTarget; editor: EditingCandidate };
type Job = { origin: Session; input: ProjectCommand; documents: Map<string, DocumentSnapshot>; revisions: Map<string, number>; authority: Map<string, string>;
    leases: ResourceLease[]; stops: (() => void)[]; timer: number; invalid: boolean; applied: boolean };
export type ProjectSnapshot = Readonly<{ available: boolean; connected: boolean; disconnected: boolean; registered: boolean; pending: boolean;
    status: "idle" | "pending" | "ready" | "rejected" | "failed" | "cancelled"; message: string; view: string | null; changes: readonly Readonly<{ document: DocumentId; title: string }>[] }>;
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
    private registered = false;
    private disconnected = false;
    private disposed = false;
    private publishing = false;
    private serial = 0;
    private delay = 0;
    private fault: ProjectCommand["fault"];
    private readonly worker = navigationMetrics();
    private readonly metrics = { requested: 0, serverRequests: 0, applied: 0, rejected: 0, cancelled: 0, failed: 0 };
    private readonly cell = new HostCell<ProjectSnapshot>({ available: false, connected: false, disconnected: false, registered: false, pending: false, status: "idle", message: "Focus a candidate source to use workspace provider commands.", view: null, changes: [] });
    readonly state = this.cell.observable;
    constructor(workspace: Workspace, canCapture: (id: DocumentId) => boolean, present: (id: DocumentId) => EditingCandidate | undefined) { this.workspace = workspace; this.canCapture = canCapture; this.present = present; }
    private available(s: Session): boolean {
        const tab = this.workspace.resolveTab(s.target);
        return !this.disposed && this.sessions.get(s.token) === s && s.editor.element.isConnected && !s.editor.snapshot().disposed && this.workspace.ownsDocumentView(s.editor.view)
            && tab?.surface.kind === "text" && tab.surface.documentId === s.editor.view.documentId && this.workspace.observeDocument(s.editor.view.documentId).getSnapshot() !== undefined;
    }
    private authority(id: DocumentId): string { const m = this.workspace.resourceForDocument(id).metadata.getSnapshot(); return JSON.stringify([m.state, m.capabilities.edit, m.editLock]); }
    private publish(patch: Partial<ProjectSnapshot> = {}): void {
        this.cell.set({ ...this.cell.get(), ...patch, available: !!this.active && this.available(this.active), connected: this.client?.snapshot().connected ?? false,
            disconnected: this.disconnected, registered: this.registered, pending: !!this.job, view: this.active?.id ?? null, changes: this.changes });
    }
    private drop(): void { const client = this.client; this.client = undefined; this.registered = false; client?.dispose(); }
    private connectionChanged(): void {
        const transport = this.client?.snapshot();
        if (!transport?.connected) this.registered = false;
        if (transport && !transport.connected && !transport.busy) {
            this.metrics.failed++; this.drop(); this.publish({ status: "failed", message: "Workspace provider connection failed; register again to reconnect." });
        } else this.publish();
    }
    private current(job: Job): boolean {
        if (this.job !== job || job.invalid || !this.available(job.origin)) return false;
        try { for (const [id, doc] of job.documents) if (this.workspace.observeDocument(doc.id).getSnapshot()?.revision !== job.revisions.get(id)
            || this.authority(doc.id) !== job.authority.get(id) || !this.canCapture(doc.id)) return false; } catch { return false; }
        return true;
    }
    private release(job: Job): void {
        if (this.job === job) this.job = undefined; job.invalid = true;
        job.origin.editor.element.ownerDocument.defaultView!.clearTimeout(job.timer); job.stops.splice(0).forEach(stop => stop()); job.leases.splice(0).forEach(lease => lease.release());
    }
    readonly cancel = (): void => {
        const job = this.job; if (!job) return; this.drop(); this.release(job); this.metrics.cancelled++;
        this.publish({ status: "cancelled", message: job.applied ? "Provider work cancelled after application; the edit remains available to undo." : "Provider work cancelled; source is unchanged." });
    };
    readonly disconnect = (): void => { this.cancel(); this.drop(); this.disconnected = true; this.publish({ status: "idle", message: "Workspace provider disconnected; local editing remains available." }); };
    readonly reconnect = (): void => { this.cancel(); this.drop(); this.disconnected = false; this.publish({ status: "idle", message: "Register again to reconnect with current working snapshots." }); };
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
        const job: Job = { origin, input, documents: new Map(docs.map(d => [d.id, d])), revisions: new Map(docs.map(d => [d.id, d.revision])), authority: new Map(docs.map(d => [d.id, this.authority(d.id)])), leases: [], stops: [], timer: 0, invalid: false, applied: false };
        this.job = job; this.metrics.requested++;
        try {
            const changed = () => { if (!this.publishing && this.job === job && !this.current(job)) { job.invalid = true; queueMicrotask(() => { if (this.job === job) this.cancel(); }); } };
            for (const doc of docs) { job.leases.push(this.workspace.acquire(doc.resourceId)); job.stops.push(this.workspace.observeDocument(doc.id).subscribe(changed), this.workspace.resourceForDocument(doc.id).metadata.subscribe(changed)); }
            job.stops.push(this.workspace.tabState.subscribe(changed));
            job.timer = win.setTimeout(() => { if (this.job === job) { this.cancel(); this.publish({ status: "failed", message: "Workspace provider timed out; any applied edit remains available to undo." }); } }, 30000);
            this.publish({ status: "pending", message: `Waiting for captured provider ${kind}.` });
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
    faultIdle(): boolean { return this.client?.faultIdle() ?? false; }
    debug() { return { ...this.metrics, worker: { ...this.worker }, pending: !!this.job, registered: this.registered, transport: this.client?.snapshot() ?? null, sessions: this.sessions.size, subscriptions: this.cell.count(), disposed: this.disposed }; }
    dispose(): void { if (this.disposed) return; this.cancel(); this.drop(); this.disposed = true; this.active = undefined; this.changes = []; this.publish(); }
}
