import type { DocumentId, DocumentSnapshot, ResourceLease, SelectionSet, TabId, TabTarget, Workspace } from "../../src/index.ts";
import { captureViewRequest } from "../../src/browser/index.ts";
import type { CapturedViewRequest, EditingCandidate } from "../../src/browser/index.ts";
import { createNavigationClient } from "../shared/language/navigation-client.ts";
import type { NavigationMetrics, SyncFault, NavigationService, NavigationServiceFactory } from "../shared/language/navigation-service.ts";
import { navigationLimits, navigationSymbol, validateNavigationInput } from "../../fixtures/language/navigation.ts";
import type { NavigationInput, NavigationLocation } from "../../fixtures/language/navigation.ts";
import { HostCell } from "../shared/observable.ts";

type Session = { token: number; id: string; target: TabTarget; editor: EditingCandidate };
type Source = { document: DocumentSnapshot; authority: string };
type Job = { id: number; origin: Session; capture: CapturedViewRequest; input: NavigationInput; sources: Map<string, Source>; targets: Map<string, Session>;
    leases: ResourceLease[]; stops: (() => void)[]; timer: number; invalid: boolean; ready: boolean; navigated: boolean; locations: readonly NavigationLocation[]; serviceCurrent?: () => boolean };
export type NavigationNote = NavigationLocation & Readonly<{ ordinal: number; title: string; line: number; column: number }>;
export type NavigationSnapshot = Readonly<{ available: boolean; connected: boolean; disconnected: boolean; syncedDocuments: number; view: string | null; requestView: string | null; token: number | null; status: "idle" | "pending" | "ready" | "empty" | "failed" | "expired" | "disconnected";
    message: string; work: number; total: number; includeDeclaration: boolean; locations: readonly NavigationNote[]; count: number; truncated: boolean; page: number; canReturn: boolean }>;
let sessionSerial = 0;

/** Host-owned project navigation; results carry identities, never a future focus target. */
export class HostNavigationTools {
    private readonly workspace: Workspace;
    private readonly canCapture: (id: DocumentId) => boolean;
    private readonly present: (id: DocumentId) => EditingCandidate | undefined;
    private readonly sessions = new Map<number, Session>();
    private active: Session | undefined;
    private job: Job | undefined;
    private sequence = 0;
    private presenting = false;
    private disposed = false;
    private companion: DocumentId | undefined;
    private delay = 0;
    private fault: NavigationInput["fault"];
    private syncFault: SyncFault | undefined;
    private client: NavigationService | undefined;
    private readonly createService: NavigationServiceFactory;
    private disconnected = false;
    private readonly cell = new HostCell<NavigationSnapshot>({ available: false, connected: false, disconnected: false, syncedDocuments: 0, view: null, requestView: null, token: null, status: "idle", message: "Focus a candidate source to navigate symbols.", work: 0, total: 0, includeDeclaration: true, locations: [], count: 0, truncated: false, page: 0, canReturn: false });
    readonly state = this.cell.observable;
    private readonly metrics = { requested: 0, applied: 0, cancelled: 0, expired: 0, failed: 0 };
    private readonly worker: NavigationMetrics = { created: 0, posted: 0, received: 0, transferred: 0, maxChunk: 0, completed: 0, failed: 0, terminated: 0,
        opened: 0, changed: 0, closed: 0, reused: 0, snapshotUnits: 0, deltaUnits: 0, planningTurns: 0, rejected: 0 };
    private readonly reconnectProvider: (() => void) | undefined;
    constructor(workspace: Workspace, canCapture: (id: DocumentId) => boolean, present: (id: DocumentId) => EditingCandidate | undefined,
        createService: NavigationServiceFactory = { positionQueries: false, create: (clock, counts, changed) => createNavigationClient(clock, counts, undefined, changed) }, reconnectProvider?: () => void) { this.reconnectProvider = reconnectProvider;
        this.workspace = workspace; this.canCapture = canCapture; this.present = present; this.createService = createService;
    }
    private available(session: Session): boolean {
        const tab = this.workspace.resolveTab(session.target), editor = session.editor;
        return !this.disposed && this.sessions.get(session.token) === session && editor.element.isConnected && !editor.activity().disposed && this.workspace.ownsDocumentView(editor.view)
            && tab?.surface.kind === "text" && tab.surface.documentId === editor.view.documentId && this.workspace.observeDocument(editor.view.documentId).getSnapshot() !== undefined;
    }
    private authority(id: DocumentId): string {
        const m = this.workspace.resourceForDocument(id).metadata.getSnapshot(); return JSON.stringify([m.state, m.capabilities.edit, m.editLock]);
    }
    private publish(patch: Partial<NavigationSnapshot> = {}): void {
        const job = this.job, state = { ...this.cell.get(), ...patch }, locations = job?.ready ? job.locations.slice(state.page * navigationLimits.page, (state.page + 1) * navigationLimits.page).map((at, index) => {
            const doc = job.sources.get(at.document)!.document, line = doc.buffer.lineAt(at.from);
            return { ...at, ordinal: state.page * navigationLimits.page + index, title: doc.title.slice(0, 128), line: line + 1, column: at.from - doc.buffer.offsetAt(line) + 1 };
        }) : [];
        const transport = this.client?.snapshot();
        this.cell.set({ ...state, available: !!this.active && this.available(this.active), connected: !!transport?.connected, disconnected: this.disconnected, syncedDocuments: transport?.documents.length ?? 0, view: this.active?.id ?? null, requestView: job?.origin.id ?? null, token: job?.id ?? null,
            locations, count: job?.locations.length ?? 0, canReturn: !!job?.navigated });
    }
    private current(job: Job): boolean {
        if (this.job !== job || job.invalid || this.disposed || job.serviceCurrent && !job.serviceCurrent()) return false;
        try {
            for (const source of job.sources.values()) {
                if (this.workspace.observeDocument(source.document.id).getSnapshot()?.revision !== source.document.revision || this.authority(source.document.id) !== source.authority) return false;
            }
            return job.ready || job.capture.isCurrent();
        } catch { return false; }
    }
    private invalidate(job: Job): void {
        job.invalid = true;
        // Core notifications cannot release leases. Latch immediately, release afterward.
        queueMicrotask(() => { if (this.job === job) { this.metrics.expired++; this.clear("expired", "Captured navigation changed; request fresh results."); } });
    }
    private releasePending(job: Job): void {
        job.origin.editor.element.ownerDocument.defaultView!.clearTimeout(job.timer);
        job.capture.cancel();
        job.leases.splice(0).forEach(lease => lease.release());
    }
    private dropClient(): void { const previous = this.client; this.client = undefined; previous?.dispose(); }
    private clear(status: NavigationSnapshot["status"], message: string): void {
        const job = this.job; this.job = undefined;
        if (job) { job.invalid = true; job.stops.splice(0).forEach(stop => stop()); this.releasePending(job); if (!job.ready) this.dropClient(); }
        this.publish({ status, message, work: 0, total: 0, page: 0, truncated: false });
    }
    readonly cancel = (): void => { if (this.job) this.metrics.cancelled++; this.clear("idle", "Symbol navigation dismissed."); };
    readonly disconnect = (): void => { this.cancel(); this.dropClient(); this.disconnected = true; this.publish({ status: "disconnected", message: "Navigation provider disconnected; local editing remains available." }); };
    readonly reconnect = (): void => { this.cancel(); this.dropClient(); this.disconnected = false; this.reconnectProvider?.(); this.publish({ status: "idle", message: "Request fresh navigation with current resources." }); };
    attach(id: string, tab: TabId, editor: EditingCandidate): () => void {
        const session: Session = { token: ++sessionSerial, id, target: this.workspace.captureTab(tab), editor }, listeners = new AbortController(); this.sessions.set(session.token, session);
        editor.input.addEventListener("focus", () => { this.active = session; this.publish(); }, { signal: listeners.signal });
        editor.input.addEventListener("keydown", event => {
            if (event.defaultPrevented || event.isComposing || editor.activity().composing) return;
            if (event.key === "F12" && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); event.stopImmediatePropagation(); this.active = session; this.start(event.shiftKey ? "references" : "definition", true); }
            else if (event.key === "Escape" && this.job) { event.preventDefault(); event.stopImmediatePropagation(); this.cancel(); }
        }, { capture: true, signal: listeners.signal });
        for (const name of ["compositionstart", "beforeinput", "paste", "cut"] as const) editor.input.addEventListener(name, () => {
            if (!this.presenting && this.job?.sources.has(editor.view.documentId)) this.cancel();
        }, { signal: listeners.signal });
        let detached = false;
        return () => { if (detached) return; detached = true; if (!this.presenting && this.job) this.cancel(); listeners.abort(); this.sessions.delete(session.token);
            if (this.active === session) this.active = undefined; if (!this.sessions.size) this.dropClient(); this.publish(); };
    }
    readonly findDefinition = (): void => this.start("definition", false);
    readonly findReferences = (): void => this.start("references", false);
    private start(kind: NavigationInput["kind"], keyboard: boolean): void {
        if (this.disconnected) { this.publish({ status: "disconnected", message: "Reconnect the navigation provider before requesting results." }); return; }
        const origin = this.active;
        if (!origin || !this.available(origin)) { this.publish({ message: "Focus an available candidate source." }); return; }
        if (!this.canCapture(origin.editor.view.documentId)) { this.publish({ message: "Finish pending input, navigation or composition first." }); return; }
        this.cancel(); const selected = origin.editor.view.getSnapshot(), document = this.workspace.document(origin.editor.view.documentId), symbol = navigationSymbol(document.buffer, selected.selection.head) ?? (this.createService.positionQueries ? "position" : undefined);
        if (!symbol) { this.publish({ status: "empty", message: "No bounded symbol at this position." }); return; }
        const documents = this.workspace.getSnapshot().documents.filter(doc => doc.key.variant === "working"), sources = new Map(documents.map(doc => [doc.id as string, { document: doc, authority: this.authority(doc.id) }]));
        if (!sources.has(document.id)) { this.publish({ status: "failed", message: "This source is outside the host navigation scope." }); return; }
        let input: NavigationInput;
        try { input = validateNavigationInput({ operation: "navigation-start", id: ++this.sequence, kind, symbol, includeDeclaration: this.cell.get().includeDeclaration, delay: this.delay,
            documents: documents.map(doc => ({ document: doc.id, revision: doc.revision, length: doc.buffer.length })), ...(this.fault ? { fault: this.fault } : {}) }); }
        catch (error) { this.fault = undefined; this.publish({ status: "failed", message: error instanceof Error ? error.message : "Unsupported navigation capture." }); return; }
        this.fault = undefined;
        const targets = new Map<string, Session>(); for (const s of this.sessions.values()) if (this.available(s) && !targets.has(s.editor.view.documentId)) targets.set(s.editor.view.documentId, s); targets.set(document.id, origin);
        const capture = captureViewRequest(this.workspace, origin.target, origin.editor.view,
            { available: () => this.available(origin) && this.canCapture(document.id) });
        if (!capture) { this.publish({ message: "The source changed before capture; request fresh navigation." }); return; }
        const job: Job = { id: input.id, origin, capture, input, sources, targets,
            leases: [], stops: [], timer: 0, invalid: false, ready: false, navigated: false, locations: [] };
        this.job = job; this.metrics.requested++; const win = origin.editor.element.ownerDocument.defaultView!;
        try {
            const changed = () => { if (!this.presenting && this.job === job && !this.current(job)) this.invalidate(job); };
            for (const { document: doc } of sources.values()) if (doc.id !== document.id) {
                job.leases.push(this.workspace.acquire(doc.resourceId));
                job.stops.push(this.workspace.observeDocument(doc.id).subscribe(changed), this.workspace.resourceForDocument(doc.id).metadata.subscribe(changed));
            }
            capture.signal.addEventListener("abort", changed, { once: true });
            job.timer = win.setTimeout(() => { if (this.job === job && !job.ready) { this.metrics.failed++; this.clear("failed", "Navigation timed out; source is unchanged."); } }, 30000);
            const total = input.documents.reduce((sum, doc) => sum + doc.length, 0);
            this.publish({ status: "pending", message: `Finding ${kind === "definition" ? "definitions" : "references"} of ${symbol} from ${origin.id}.`, work: 0, total, page: 0, truncated: false });
            this.client ??= this.createService.create(win, this.worker, () => { const job = this.job; if (job?.ready && !this.current(job)) this.invalidate(job); this.publish(); });
            const syncFault = this.syncFault; this.syncFault = undefined;
            void this.client.run(input, new Map([...sources].map(([id, source]) => [id, source.document.buffer])), work => { if (this.current(job)) this.publish({ work }); }, syncFault,
                { document: document.id, offset: selected.selection.head }).then(result => {
                if (result.isCurrent) job.serviceCurrent = result.isCurrent;
                if (!this.current(job)) { if (this.job === job) this.invalidate(job); return; }
                // Published results depend on source resources/provider ownership, not later view
                // movement. Install source guards before ending the pending view capture.
                job.stops.push(this.workspace.observeDocument(document.id).subscribe(changed), this.workspace.resourceForDocument(document.id).metadata.subscribe(changed));
                job.ready = true; job.locations = result.locations; this.releasePending(job); this.metrics.applied++;
                this.publish({ status: result.locations.length ? "ready" : "empty", message: `${result.locations.length}${result.truncated ? "+" : ""} ${kind === "definition" ? "definition" : "reference"} locations for ${symbol} across ${sources.size} captured resources.`, truncated: result.truncated, work: total });
                if (keyboard && kind === "definition" && result.locations.length === 1 && origin.editor.element.ownerDocument.activeElement === origin.editor.input) this.open(job.id, 0);
            }).catch(error => { if (this.job !== job) return; this.metrics.failed++; this.clear("failed", error instanceof Error ? error.message : "Navigation failed; source is unchanged."); });
        } catch (error) { this.metrics.failed++; this.clear("failed", error instanceof Error ? error.message : "Navigation is unavailable."); }
    }
    private place(job: Job, document: DocumentId, selections: SelectionSet | NavigationLocation): boolean {
        if (!job.ready || !this.current(job) || !this.canCapture(document)) { this.publish({ message: "Finish pending input or request fresh navigation results." }); return false; }
        this.presenting = true;
        try {
            const captured = job.targets.get(document), editor = captured && this.available(captured) ? captured.editor : this.present(document);
            if (!editor || this.job !== job || !this.current(job) || editor.view.documentId !== document) { this.publish({ message: "The captured destination cannot be presented in an available candidate pane." }); return false; }
            const revision = job.sources.get(document)!.document.revision;
            const applied = "ranges" in selections ? editor.view.setSelections(revision, selections.ranges, selections.primary) : editor.view.setSelection(revision, { anchor: selections.from, head: selections.to });
            if (!applied) return false; job.navigated = true; editor.viewport.revealOffset(editor.view.getSnapshot().selection.head); editor.focus(); this.publish(); return true;
        } finally { this.presenting = false; }
    }
    open(token: number, ordinal: number): void {
        const job = this.job; if (!job || job.id !== token || !Number.isSafeInteger(ordinal)) return; const at = job.locations[ordinal]; if (!at) return;
        if (this.place(job, at.document as DocumentId, at)) this.publish({ message: `Opened a captured ${job.input.kind} location in ${job.sources.get(at.document)!.document.title.slice(0, 128)}.` });
    }
    readonly returnToOrigin = (): void => { const job = this.job; if (job?.navigated && this.place(job, job.capture.document.id, job.capture.selectionSet)) this.publish({ message: "Returned to the captured origin and complete selection set." }); };
    readonly nextPage = (): void => { const state = this.cell.get(); if ((state.page + 1) * navigationLimits.page < state.count) this.publish({ page: state.page + 1 }); };
    readonly previousPage = (): void => { const state = this.cell.get(); if (state.page > 0) this.publish({ page: state.page - 1 }); };
    setIncludeDeclaration(value: boolean): void { if (value === this.cell.get().includeDeclaration) return; this.cancel(); this.publish({ includeDeclaration: value }); }
    readonly addCompanion = (): void => {
        if (this.disposed) return; this.cancel();
        this.companion ??= this.workspace.createTextResource({ scope: "host-fixture", resource: "navigation-companion", variant: "working" }, "Navigation companion", { value: "const catalogue = 1;\r\ncatalogue;\r\n" }).documentId;
        this.publish({ message: "Navigation companion added. Find catalogue from a source view to open its captured definition." });
    };
    setDelay(value: number): void { if (!Number.isFinite(value) || value < 0 || value > 1000) throw new RangeError("Invalid navigation delay."); this.delay = value; }
    faultNext(value: NonNullable<NavigationInput["fault"]>): void { this.fault = value; }
    faultSyncNext(value: SyncFault): void { this.syncFault = value; }
    releaseCompanion(): boolean {
        if (!this.companion) return false; this.cancel();
        try { this.workspace.releaseDocument(this.companion); this.companion = undefined; this.publish(); return true; } catch { return false; }
    }
    debug() { return { ...this.metrics, worker: { ...this.worker }, sessions: [...this.sessions.values()].map(s => ({ id: s.id, documentId: s.editor.view.documentId, token: s.token })), subscriptions: this.cell.count(),
        pending: !!this.job && !this.job.ready, results: this.job?.locations.length ?? 0, scope: this.job?.sources.size ?? 0, companion: this.companion ?? null, transport: this.client?.snapshot() ?? null, disposed: this.disposed }; }
    dispose(): void { if (this.disposed) return; this.cancel(); this.dropClient(); this.disposed = true; this.active = undefined; this.publish(); }
}
