import { fixtureRequests } from "../language/fixture-requests.ts";
import { onSourceFocus } from "../../../examples/shared/source-focus.ts";
import { isMountedEditor, openChangedFile, type ChangedFile, type LanguageHost } from "../../../examples/shared/language-host.ts";
import type { DocumentId, DocumentSnapshot, ResourceLease } from "../../../src/index.ts";
import { captureViewRequest } from "../../../src/browser/index.ts";
import type { CapturedViewRequest, CodeActionController, LanguageCommands, TextEditor } from "../../../src/browser/index.ts";
import { ProviderLane } from "../provider-lane.ts";
import { validateProjectCommand } from "../language/project-commands.ts";
import type { ProjectCommand, ProjectCommandKind } from "../language/project-commands.ts";
import { HostCell } from "../../../examples/shared/observable.ts";
import type { LspApplyEdit, LspCommandScope, LspRequestContext, LspWorkspace } from "../../../src/protocol/index.ts";
import type { LspProjectClient, LspProjectFactory } from "../language/lsp-project-client.ts";
import { readLspEditNotes } from "../../../src/protocol/lsp-workspace-edit.ts";
import { editPaging, readEditPage, type EditPage } from "./edit-review.ts";
import type { PanelPaging } from "../../../examples/shared/panel-actions.ts";
type Session = { token: number; id: string; editor: TextEditor };
type Participant = Readonly<{ document: DocumentSnapshot; authority: string }>;
type Job = { origin: Session; documents: Map<string, Participant>;
    leases: ResourceLease[]; stops: (() => void)[]; timer: number; invalid: boolean; capture: CapturedViewRequest;
    providerCurrent?: () => boolean };
type Review = { key: number; request: LspApplyEdit; canApply: () => boolean; decide: (approved: boolean) => void;
    page: EditPage; readPage: (index: number) => EditPage };
export type ProjectReview = EditPage & Readonly<{ key: number; apply: () => void; decline: () => void; paging: PanelPaging | null; label: string; canApply: boolean }>;
export type ProjectSnapshot = Readonly<{ available: boolean; connected: boolean; disconnected: boolean; reconnectRequired: boolean; registered: boolean; pending: boolean;
    status: "idle" | "pending" | "ready" | "rejected" | "failed" | "cancelled"; message: string; view: string | null; changes: readonly ChangedFile[]; review: ProjectReview | null }>;
/** Local protocol owner. Server edits use the workspace's existing atomic shared-history transaction. */
export class HostProjectTools {
    private readonly host: LanguageHost;
    private changes: ProjectSnapshot["changes"] = [];
    private readonly sessions = new Map<number, Session>();
    private active: Session | undefined;
    private job: Job | undefined;
    private readonly lane = new ProviderLane<LspProjectClient>(client => this.connectionChanged(client));
    private readonly createClient: LspProjectFactory | undefined;
    private readonly provider: LspWorkspace | undefined;
    private action: { editor: TextEditor; controller: Pick<CodeActionController, "cancel"> } | undefined;
    private readonly commands = new Map<TextEditor, LanguageCommands>();
    private review: Review | undefined;
    private registered = false;
    private disconnected = false;
    private disposed = false;
    readonly fixture = fixtureRequests<NonNullable<ProjectCommand["fault"]>>("project");
    private readonly metrics = { requested: 0, serverRequests: 0, applied: 0, rejected: 0, cancelled: 0, failed: 0 };
    private readonly cell = new HostCell<ProjectSnapshot>({ available: false, connected: false, disconnected: false, reconnectRequired: false, registered: false, pending: false, status: "idle", message: "Focus a candidate source to use workspace provider commands.", view: null, changes: [], review: null });
    readonly state = this.cell.observable;
    constructor(host: LanguageHost, createClient?: LspProjectFactory, provider?: LspWorkspace) {
        this.host = host; this.createClient = createClient; this.provider = provider;
    }
    private available(s: Session): boolean {
        return !this.disposed && this.sessions.get(s.token) === s && isMountedEditor(this.host.workspace, s.editor);
    }
    private authority(id: DocumentId): string { const m = this.host.workspace.resource(id).metadata.getSnapshot(); return JSON.stringify([m.state, m.capabilities.edit]); }
    private publish(patch: Partial<ProjectSnapshot> = {}): void {
        const preview = this.review ? this.describeReview(this.review) : null;
        this.cell.set({ ...this.cell.get(), ...patch, available: !!this.active && this.available(this.active), connected: this.lane.value?.snapshot().connected ?? false,
            disconnected: this.disconnected, reconnectRequired: this.provider?.getSnapshot().commandRequiresReconnect ?? false, registered: this.registered, pending: !!this.job || !!this.action, view: this.active?.id ?? null, changes: this.changes, review: preview });
    }
    private drop(): void { this.registered = false; this.lane.drop(); }
    private connectionChanged(client: LspProjectClient): void {
        const state = client.snapshot(), job = this.job; this.registered = state.registered;
        if (this.action) {
            if (!state.connected && !state.busy) queueMicrotask(() => { if (this.lane.value === client) { this.drop(); this.publish(); } });
            this.publish(); return;
        }
        if (!state.connected && !state.busy || job && !client.isCurrent()) {
            if (!state.connected) this.disconnected = true;
            if (job) job.invalid = true;
            queueMicrotask(() => { if (this.lane.value !== client) return; this.cancel(); this.drop(); this.publish({ status: "failed", message: "Provider connection or capability changed; reconnect and request fresh work." }); });
        }
        this.publish(); return;
    }
    private current(job: Job): boolean {
        if (this.job !== job || job.invalid) return false;
        try {
            if (!job.capture.isCurrent() || job.providerCurrent && !job.providerCurrent()) return false;
            for (const { document, authority } of job.documents.values()) {
                if (this.host.workspace.observeDocument(document.id).getSnapshot()?.revision !== document.revision
                    || this.authority(document.id) !== authority || !this.host.canCapture(document.id)) return false;
            }
        } catch { return false; }
        return true;
    }
    private capture(origin: Session): CapturedViewRequest | undefined {
        return captureViewRequest(origin.editor,
            { available: () => this.available(origin) && this.host.canCapture(origin.editor.view.documentId) });
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
        job.leases.push(this.host.workspace.acquire(document.id));
        job.stops.push(this.host.workspace.onDocumentChange(id, (_change, followUp) => {
            this.changed(job, followUp);
        }));
        job.stops.push(this.host.workspace.resource(id).metadata.subscribe(() => {
            const current = this.host.workspace.observeDocument(id).getSnapshot();
            if (this.authority(id) !== participant.authority || !current?.change && current?.revision !== participant.document.revision) this.changed(job);
        }));
    }
    private captureJob(origin: Session, documents: readonly DocumentSnapshot[]): Job | undefined {
        const capture = this.capture(origin);
        if (!capture) return;
        const job: Job = { origin, capture, documents: new Map(),
            leases: [], stops: [], timer: 0, invalid: false };
        this.job = job;
        try {
            this.watchCapture(job, capture);
            for (const document of documents) this.retainDocument(job, document);
            return job;
        } catch (error) { this.release(job); throw error; }
    }
    private commandScope(job: Job): LspCommandScope {
        return { snapshots: () => Array.from(job.documents.values(), participant => participant.document),
            isCurrent: () => this.current(job), review: async () => ({ applied: false }) };
    }
    private release(job: Job): void {
        this.review?.decide(false);
        if (this.job === job) this.job = undefined;
        job.invalid = true;
        job.origin.editor.element.ownerDocument.defaultView!.clearTimeout(job.timer);
        for (const stop of job.stops.splice(0)) stop();
        job.capture.cancel();
        for (const lease of job.leases.splice(0)) lease.release();
    }
    readonly cancel = (): void => {
        if (this.action) {
            this.review?.decide(false);
            this.action.controller.cancel();
            return;
        }
        const job = this.job; if (!job) return; this.drop(); this.release(job); this.metrics.cancelled++;
        this.publish({ status: "cancelled", message: "Provider work cancelled; source is unchanged." });
    };
    readonly disconnect = (): void => { this.cancel(); this.drop(); this.disconnected = true; this.publish({ status: "idle", message: "Workspace provider disconnected; local editing remains available." }); };
    readonly reconnect = (): void => { this.cancel(); this.drop(); this.disconnected = false; this.host.reconnect?.(); this.publish({ status: "idle", message: "Register again with current working snapshots." }); };
    attach(id: string, editor: TextEditor): () => void {
        const session = { token: this.host.workspace.allocateIdentity(), id, editor }, events = new AbortController(); this.sessions.set(session.token, session);
        onSourceFocus(editor, events.signal, () => { this.active = session; this.publish(); });
        editor.onEditIntent(() => { if (this.job?.documents.has(editor.view.documentId)) this.cancel(); }, events.signal);
        let detached = false;
        return () => { if (detached) return; detached = true; if (this.job?.origin === session || this.action?.editor === editor) this.cancel(); events.abort(); this.sessions.delete(session.token);
            if (this.active === session) this.active = undefined; if (!this.sessions.size) this.drop(); this.publish(); };
    }
    private prompt(request: LspApplyEdit, context: LspRequestContext, canApply: () => boolean): Promise<boolean> {
        this.metrics.serverRequests++;
        if (this.review || !context.isCurrent()) return Promise.resolve(false);
        return new Promise(resolve => {
            const title = (id: string) => this.host.workspace.document(id as DocumentId).title;
            const read = (first: number, end: number) => readLspEditNotes(request.edit, title, first, end);
            const readPage = (index: number) => readEditPage(read, index);
            const review: Review = { key: this.host.workspace.allocateIdentity(), request, canApply, readPage,
                page: readPage(0), decide: approved => {
                    if (this.review !== review) return;
                    this.review = undefined;
                    clearTimeout(timer);
                    stop();
                    if (!approved) this.metrics.rejected++;
                    resolve(approved);
                    this.publish({ message: approved ? "Approved provider edits." : "Provider edits declined." });
                } };
            this.review = review;
            const timer = setTimeout(() => review.decide(false), 90000);
            const stop = context.onCancel(() => review.decide(false));
            this.publish({ message: "Review the captured provider edits." });
        });
    }
    private describeReview(review: Review): ProjectReview {
        const { key, page, request } = review;
        return Object.freeze({ ...page, key, label: request.label ?? "Provider workspace edit", canApply: review.canApply(),
            apply: () => review.decide(true),
            decline: () => review.decide(false), paging: editPaging(key, page.page, page.count, next => {
                if (this.review === review && review.page === page) { review.page = review.readPage(next); this.publish(); }
            }) });
    }
    canRunAction(editor: TextEditor): boolean {
        return !this.disposed && !this.job && !this.action && this.provider?.getSnapshot().commandAvailable === true
            && [...this.sessions.values()].some(session => session.editor === editor && this.available(session));
    }
    readonly reviewActionEdit = (request: LspApplyEdit, context: LspRequestContext, writable = true) =>
        !request.edit.documents.some(part => part.edits.length) || this.prompt(request, context, () => writable && context.isCurrent() && request.edit.isCurrent());
    observeActions(editor: TextEditor, controller: CodeActionController, commands?: LanguageCommands) {
        const action = { editor, controller };
        if (commands) this.commands.set(editor, commands);
        const stopChanges = commands?.subscribe(() => {
            const changes = commands.getSnapshot();
            if (this.action?.controller !== commands || !changes.length) return;
            this.metrics.applied++;
            this.changes = changes;
            this.publish();
        });
        const stop = controller.subscribe(() => {
            const state = controller.getSnapshot();
            if (state.status === "executing") this.action = action;
            else if (this.action === action) {
                this.action = undefined;
                this.review?.decide(false);
                this.changes = state.changes;
            } else return;
            this.publish({ message: state.message });
        });
        return () => {
            stop();
            stopChanges?.();
            if (this.commands.get(editor) === commands) this.commands.delete(editor);
        };
    }
    readonly register = (): void => this.start("register");
    readonly unregister = (): void => this.start("unregister");
    readonly requestEdits = (): void => this.start("review");
    readonly requestStatus = (): void => this.start("status");
    openChanged(document: DocumentId): void {
        if (this.disposed || this.job || !this.changes.some(c => c.document === document)) return;
        this.publish({ message: openChangedFile(this.host, document, this.sessions.values()) });
    }
    private async runReview(editor: TextEditor, commands: LanguageCommands, name: string, input: ProjectCommand) {
        const action = { editor, controller: commands };
        this.action = action;
        this.metrics.requested++;
        this.publish({ status: "pending", message: "Waiting for provider edits." });
        const policy = { delay: input.delay, ...(input.fault && { fault: input.fault }) };
        const result = await commands.run(name, [{ reviewPolicy: policy }]);
        if (this.action !== action) return;
        this.action = undefined;
        this.review?.decide(false);
        if (result.status === "done") {
            this.publish({ status: "ready", message: "Captured provider edit decision acknowledged." });
        } else if (result.status === "refused") {
            this.publish({ status: "rejected", message: result.reason === "not-writable"
                ? "An edit target is read-only or locked." : result.reason });
        } else {
            this.metrics.failed++;
            this.drop();
            const message = commands.getSnapshot().length ? "Provider work ended after application. The edit remains available to undo."
                : result.status === "failed" && result.error instanceof Error ? result.error.message : "The captured command expired.";
            this.publish({ status: "failed", message });
        }
    }
    private start(kind: ProjectCommandKind): void {
        const origin = this.active;
        if (!this.createClient || this.disconnected || this.job || this.action || !origin || !this.available(origin)) { this.publish({ message: "Focus an available source and reconnect or finish pending work first." }); return; }
        if (kind === "register" ? this.registered : kind !== "status" && !this.registered) { this.publish({ message: "Register the review command before using it; unregister before registering again." }); return; }
        const docs = this.host.workspace.getSnapshot().documents.filter(d => d.key.variant === "working");
        if (docs.some(d => !this.host.canCapture(d.id))) { this.publish({ message: "Finish pending input, navigation, table conversion or composition first." }); return; }
        const policy = this.fixture.take();
        let input: ProjectCommand;
        try { input = validateProjectCommand({ kind, documents: docs.map(d => ({ document: d.id, revision: d.revision, length: d.buffer.length })), ...policy }); }
        catch (error) { this.publish({ status: "failed", message: error instanceof Error ? error.message : "Invalid provider capture." }); return; }
        if (kind === "review") {
            const commands = this.commands.get(origin.editor);
            const client = this.lane.value;
            if (commands && client) void this.runReview(origin.editor, commands, client.reviewCommand, input);
            else this.publish({ message: "The source has no provider command attachment." });
            return;
        }
        const win = origin.editor.element.ownerDocument.defaultView!;
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
                this.publish({ status: result.applied ? "ready" : "rejected", message: result.reason });
            }).catch(error => {
                if (this.job !== job) return; this.metrics.failed++; this.drop(); this.release(job);
                this.publish({ status: "failed", message: error instanceof Error ? error.message : "Workspace provider failed; source is unchanged." });
            });
        } catch (error) { this.drop(); this.release(job); this.publish({ status: "failed", message: error instanceof Error ? error.message : "Workspace provider is unavailable." }); }
    }
    faultIdle(): boolean { return this.lane.value?.faultIdle() ?? false; }
    debug() { return { ...this.metrics, state: this.cell.get(), pending: !!this.job || !!this.action, registered: this.registered, transport: this.lane.value?.snapshot() ?? null, sessions: this.sessions.size, subscriptions: this.cell.count(), disposed: this.disposed }; }
    dispose(): void { if (this.disposed) return; this.cancel(); this.registered = false; this.lane.dispose(); this.disposed = true; this.active = undefined; this.changes = []; this.publish(); }
}
