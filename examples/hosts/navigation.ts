import { onSourceFocus } from "./source-focus.ts";
import { createReviewKey } from "./panel-actions.ts";
import { createWorkingSource } from "./working-source.ts";
import type { DocumentId, TabId, TabTarget, Workspace } from "../../src/index.ts";
import { createNavigationController, createNavigationHistory } from "../../src/browser/index.ts";
import type { NavigationChoice, NavigationController, NavigationDestination, NavigationHistory, NavigationOrigin, NavigationPage, TextEditor } from "../../src/browser/index.ts";
import type { LspNavigationRequest, LspPrepare, LspWorkspace } from "../../src/protocol/index.ts";
import { navigationSymbol, validateNavigationDocuments } from "../../fixtures/language/navigation.ts";
import type { NavigationFault, NavigationLocation } from "../../fixtures/language/navigation.ts";
import { HostCell } from "../shared/observable.ts";

type Kind = LspNavigationRequest["kind"];
export type NavigationHostOptions = Readonly<{ provider: LspWorkspace; prepare: (kind: Kind, delay: number, fault?: NavigationFault) => LspPrepare }>;
type Session = { id: string; target: TabTarget; editor: TextEditor; controller: NavigationController };
type Job = { kind: Kind; origin: Session; returnPoint: NavigationOrigin; sources: Set<DocumentId>; targets: Map<string, Session>;
    timer: number; page: NavigationPage | undefined; followDefinition: boolean };
export type NavigationNote = NavigationLocation & Readonly<{ ordinal: number; title: string; line: number; column: number; open: () => void }>;
type Paging = Readonly<{ key: number; previous: (() => void) | null; next: (() => void) | null }>;
export type NavigationSnapshot = Readonly<{ available: boolean; connected: boolean; disconnected: boolean; syncedDocuments: number; view: string | null; requestView: string | null; status: "idle" | "pending" | "ready" | "empty" | "failed" | "expired" | "disconnected";
    message: string; work: number; total: number; includeDeclaration: boolean; locations: readonly NavigationNote[]; count: number; truncated: boolean; paging: Paging | null; canReturn: boolean }>;

/** Host-owned project navigation; results carry identities, never a future focus target. */
export class HostNavigationTools {
    private readonly workspace: Workspace;
    private readonly history: NavigationHistory;
    private readonly queryKey;
    private readonly canCapture: (id: DocumentId) => boolean;
    private readonly present: (id: DocumentId) => TextEditor | undefined;
    private readonly sessions = new Set<Session>();
    private active: Session | undefined;
    private job: Job | undefined;
    private presenting = false;
    private disposed = false;
    private companion: DocumentId | undefined;
    private delay = 0;
    private fault: NavigationFault | undefined;
    private readonly options: NavigationHostOptions;
    private disconnected = false;
    private readonly cell = new HostCell<NavigationSnapshot>({ available: false, connected: false, disconnected: false, syncedDocuments: 0, view: null, requestView: null, status: "idle", message: "Focus a candidate source to navigate symbols.", work: 0, total: 0, includeDeclaration: true, locations: [], count: 0, truncated: false, paging: null, canReturn: false });
    readonly state = this.cell.observable;
    private readonly metrics = { requested: 0, applied: 0, cancelled: 0, expired: 0, failed: 0 };
    private readonly queries = { completed: 0, failed: 0 };
    private readonly reconnectProvider: (() => void) | undefined;
    constructor(workspace: Workspace, canCapture: (id: DocumentId) => boolean, present: (id: DocumentId) => TextEditor | undefined,
        options: NavigationHostOptions, reconnectProvider?: () => void) { this.reconnectProvider = reconnectProvider;
        this.workspace = workspace; this.history = createNavigationHistory(workspace); this.queryKey = createReviewKey(workspace); this.canCapture = canCapture; this.present = present; this.options = options;
    }
    private available(session: Session): boolean {
        const tab = this.workspace.tabs.resolve(session.target), editor = session.editor;
        return !this.disposed && this.sessions.has(session) && editor.element.isConnected && !editor.activity().disposed && this.workspace.ownsDocumentView(editor.view)
            && tab?.surface.kind === "text" && tab.surface.documentId === editor.view.documentId && this.workspace.observeDocument(editor.view.documentId).getSnapshot() !== undefined;
    }
    private showPage(job: Job, page: NavigationPage | undefined, patch: Partial<NavigationSnapshot> = {}): readonly NavigationNote[] {
        const titles = new Map(this.workspace.getSnapshot().documents.map(doc => [doc.id, doc.title]));
        const locations = page?.locations.map(choice => {
            const { document } = choice, { line, column } = document.buffer.positionAt(choice.from);
            const id = document.documentId as DocumentId, title = (titles.get(id) ?? document.uri).slice(0, 128);
            job.sources.add(id);
            return { document: id, revision: document.revision, from: choice.from, to: choice.to, declaration: job.kind === "definition",
                ordinal: choice.index, title, line: line + 1, column: column + 1, open: () => this.open(job, choice, title) };
        }) ?? [];
        const turn = (move: (() => NavigationPage) | null) => move && (() => {
            if (this.job?.page === page) this.showPage(job, move());
        });
        const paging = page ? { key: this.queryKey(job)!, previous: turn(page.previousPage), next: turn(page.nextPage) } : null;
        job.page = page; this.publish({ ...patch, locations, paging });
        return locations;
    }
    private publish(patch: Partial<NavigationSnapshot> = {}): void {
        const job = this.job, page = job?.page;
        const transport = job?.origin.controller.getDiagnostics();
        this.cell.set({ ...this.cell.get(), ...patch, available: !!this.active && this.available(this.active), connected: !!transport?.connected, disconnected: this.disconnected, syncedDocuments: transport?.documents.length ?? 0, view: this.active?.id ?? null, requestView: job?.origin.id ?? null,
            count: page?.count ?? 0, canReturn: this.history.getSnapshot() > 0 });
    }
    private clear(status: NavigationSnapshot["status"], message: string): void {
        const job = this.job; this.job = undefined;
        if (job) { job.origin.editor.element.ownerDocument.defaultView!.clearTimeout(job.timer); job.origin.controller.cancel(); }
        this.publish({ status, message, work: 0, total: 0, truncated: false, locations: [], paging: null });
    }
    readonly cancel = (): void => { if (this.job) this.metrics.cancelled++; this.clear("idle", "Symbol navigation dismissed."); };
    readonly disconnect = (): void => { this.cancel(); this.disconnected = true; this.publish({ status: "disconnected", message: "Navigation provider disconnected; local editing remains available." }); };
    readonly reconnect = (): void => { this.cancel(); this.disconnected = false; this.reconnectProvider?.(); this.publish({ status: "idle", message: "Request fresh navigation with current resources." }); };
    attach(id: string, tab: TabId, editor: TextEditor): () => void {
        const controller = createNavigationController(editor, this.options.provider, { documents: () => this.workspace.getSnapshot().documents.filter(doc => doc.language !== null),
            canCapture: () => !this.disconnected && !this.disposed && this.canCapture(editor.view.documentId),
            prepareRequest: kind => { const fault = this.fault; this.fault = undefined; return this.options.prepare(kind, this.delay, fault); },
            onDefinition: offset => { this.active = session; editor.focus(); this.start("definition", true, offset); } });
        const session: Session = { id, target: this.workspace.tabs.capture(tab), editor, controller }, listeners = new AbortController();
        this.sessions.add(session);
        const stop = controller.subscribe(() => {
            const job = this.job;
            if (job?.origin === session && controller.getSnapshot().status === "expired") {
                queueMicrotask(() => { if (this.job === job) { this.metrics.expired++; this.clear("expired", "Captured navigation changed; request fresh results."); } });
            }
            this.publish();
        });
        onSourceFocus(editor, listeners.signal, () => { this.active = session; this.publish(); });
        const leaveSource = () => { if (this.job?.origin === session) this.job.followDefinition = false; };
        editor.element.addEventListener("focusout", leaveSource, { signal: listeners.signal });
        editor.element.ownerDocument.defaultView!.addEventListener("blur", leaveSource, { signal: listeners.signal });
        editor.onEditIntent(() => {
            if (!this.presenting && this.job?.sources.has(editor.view.documentId)) this.cancel();
        }, listeners.signal);
        const detach = () => {
            if (!this.sessions.delete(session)) return;
            if (!this.presenting && this.job?.targets.get(editor.view.documentId) === session) this.cancel();
            listeners.abort(); stop(); controller.dispose();
            if (this.active === session) this.active = undefined;
            this.publish();
        };
        try {
            for (const [kind, label, key] of [["definition", "Find definition", "F12"], ["references", "Find references", "Shift+F12"]] as const) {
                const command = editor.commands.register({ id: "navigation." + kind, label, enabled: () => this.available(session),
                    run: from => { this.active = session; this.start(kind, from !== "panel"); } }, { keys: [key] });
                listeners.signal.addEventListener("abort", command.dispose, { once: true });
            }
            const cancel = editor.commands.register({ id: "navigation.dismiss", label: "Cancel symbol navigation",
                enabled: () => this.job?.origin === session, run: this.cancel }, { keys: ["Escape"], priority: 5 });
            listeners.signal.addEventListener("abort", cancel.dispose, { once: true });
            return detach;
        } catch (error) { detach(); throw error; }
    }
    private requestFromPanel(kind: Kind): void {
        if (!this.active?.editor.commands.run("navigation." + kind, "panel"))
            this.publish({ message: "Focus an available source and finish typing before requesting navigation." });
    }
    readonly findDefinition = (): void => this.requestFromPanel("definition");
    readonly findReferences = (): void => this.requestFromPanel("references");
    private start(kind: Kind, keyboard: boolean, pointed?: number): void {
        if (this.disconnected) { this.publish({ status: "disconnected", message: "Reconnect the navigation provider before requesting results." }); return; }
        const origin = this.active;
        if (!origin || !this.available(origin)) { this.publish({ message: "Focus an available candidate source." }); return; }
        if (!this.canCapture(origin.editor.view.documentId)) { this.publish({ message: "Finish pending input, navigation or composition first." }); return; }
        this.cancel(); const offset = pointed ?? origin.editor.view.getSnapshot().selection.head, document = this.workspace.document(origin.editor.view.documentId), symbol = navigationSymbol(document.buffer, offset) ?? "position";
        const documents = this.workspace.getSnapshot().documents.filter(doc => doc.language !== null), sources = new Set(documents.map(doc => doc.id));
        if (!sources.has(document.id)) { this.publish({ status: "failed", message: "This source is outside the host navigation scope." }); return; }
        let total: number;
        try {
            const project = validateNavigationDocuments(documents.map(doc => ({ document: doc.id, revision: doc.revision, length: doc.buffer.length })));
            total = project.reduce((sum, doc) => sum + doc.length, 0);
        }
        catch (error) { this.fault = undefined; this.publish({ status: "failed", message: error instanceof Error ? error.message : "Unsupported navigation capture." }); return; }
        const targets = new Map<string, Session>(); for (const s of this.sessions) if (this.available(s) && !targets.has(s.editor.view.documentId)) targets.set(s.editor.view.documentId, s); targets.set(document.id, origin);
        const returnPoint = this.history.capture(origin.editor); if (!returnPoint) return;
        const job: Job = { kind, origin, returnPoint, sources, targets, timer: 0, page: undefined,
            followDefinition: keyboard && kind === "definition" && origin.editor.getSnapshot().focused };
        this.job = job; this.metrics.requested++; const win = origin.editor.element.ownerDocument.defaultView!;
        try {
            // The panel deadline also bounds host preparation and loading a target after the RPC reply.
            job.timer = win.setTimeout(() => { if (this.job === job) { this.metrics.failed++; this.clear("failed", "Navigation timed out; source is unchanged."); } }, 30000);
            const { includeDeclaration } = this.cell.get();
            this.publish({ status: "pending", message: `Finding ${kind === "definition" ? "definitions" : "references"} of ${symbol} from ${origin.id}.`, work: 0, total, truncated: false });
            void origin.controller.request(kind, offset, includeDeclaration).then(result => {
                this.queries.completed++;
                if (this.job !== job || origin.controller.getSnapshot().result !== result) return;
                win.clearTimeout(job.timer); this.metrics.applied++;
                const rows = this.showPage(job, result.pageFor(), { status: result.count ? "ready" : "empty", message: `${result.count} ${kind === "definition" ? "definition" : "reference"} locations for ${symbol}.`, work: total });
                if (job.followDefinition && result.count === 1 && origin.editor.getSnapshot().focused) rows[0]!.open();
            }).catch(error => { if (this.job !== job) return; this.queries.failed++; this.metrics.failed++; this.clear("failed", error instanceof Error ? error.message : "Navigation failed; source is unchanged."); });
        } catch (error) { this.metrics.failed++; this.clear("failed", error instanceof Error ? error.message : "Navigation is unavailable."); }
    }
    private place(job: Job, at: NavigationDestination): boolean {
        const document = at.document.documentId as DocumentId;
        const { result } = job.origin.controller.getSnapshot();
        if (!result || this.job !== job || !this.canCapture(document)) { this.publish({ message: "Finish pending input or request fresh navigation results." }); return false; }
        this.presenting = true;
        try {
            const captured = job.targets.get(document), editor = captured && this.available(captured) ? captured.editor : this.present(document);
            if (!editor || this.job !== job || job.origin.controller.getSnapshot().result !== result || editor.view.documentId !== document) { this.publish({ message: "The captured destination cannot be presented in an available candidate pane." }); return false; }
            return !!editor.reveal(at, { expectedRevision: at.document.revision, select: true, focus: true });
        } finally { this.presenting = false; }
    }
    private open(job: Job, choice: NavigationChoice, title: string): void {
        choice.open(at => {
            if (job.returnPoint.visit(() => this.place(job, at))) this.publish({ message: `Opened a captured ${job.kind} location in ${title}.` });
        });
    }
    readonly returnToOrigin = (): void => {
        if (this.active && !this.canCapture(this.active.editor.view.documentId)) return;
        const result = this.history.back(view => {
            if (!this.canCapture(view.documentId)) return "busy";
            for (const session of this.sessions) if (session.editor.view === view && this.available(session)) return session.editor;
            return undefined;
        }, { focus: true });
        this.publish({ message: result === "restored" ? "Returned to the captured origin and complete selection set."
            : result === "busy" ? "Finish pending input before returning." : "No navigation origin is still open." });
    };
    setIncludeDeclaration(value: boolean): void { if (value === this.cell.get().includeDeclaration) return; this.cancel(); this.publish({ includeDeclaration: value }); }
    readonly addCompanion = (): void => {
        if (this.disposed) return; this.cancel();
        this.companion ??= createWorkingSource(this.workspace, "navigation-companion", "Navigation companion", { value: "const catalogue = 1;\r\ncatalogue;\r\n" }).documentId;
        this.publish({ message: "Navigation companion added. Find catalogue from a source view to open its captured definition." });
    };
    setDelay(value: number): void { if (!Number.isFinite(value) || value < 0 || value > 1000) throw new RangeError("Invalid navigation delay."); this.delay = value; }
    faultNext(value: NavigationFault): void { this.fault = value; }
    releaseCompanion(): boolean {
        if (!this.companion) return false; this.cancel();
        try { this.workspace.releaseDocument(this.companion); this.companion = undefined; this.publish(); return true; } catch { return false; }
    }
    debug() { return { ...this.metrics, queries: { ...this.queries }, sessions: [...this.sessions].map(s => ({ id: s.id, documentId: s.editor.view.documentId })), subscriptions: this.cell.count(),
        pending: this.cell.get().status === "pending", results: this.cell.get().count, scope: this.job?.sources.size ?? 0, companion: this.companion ?? null, transport: this.job?.origin.controller.getDiagnostics() ?? null, disposed: this.disposed }; }
    dispose(): void { if (this.disposed) return; this.cancel(); this.history.dispose(); this.disposed = true; this.active = undefined; this.publish(); }
}
