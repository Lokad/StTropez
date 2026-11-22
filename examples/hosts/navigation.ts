import { createWorkingSource } from "./working-source.ts";
import type { DocumentId, DocumentSnapshot, SelectionSet, TabId, TabTarget, Workspace } from "../../src/index.ts";
import { createNavigationController } from "../../src/browser/index.ts";
import type { NavigationChoice, NavigationController, NavigationPage, NavigationResult, TextEditor } from "../../src/browser/index.ts";
import type { LspPrepare, LspWorkspace } from "../../src/protocol/index.ts";
import { navigationSymbol, validateNavigationInput } from "../../fixtures/language/navigation.ts";
import type { NavigationInput, NavigationLocation } from "../../fixtures/language/navigation.ts";
import { HostCell } from "../shared/observable.ts";

export type NavigationHostOptions = Readonly<{ provider: LspWorkspace; prepare: (kind: NavigationInput["kind"], delay: number, fault?: NavigationInput["fault"]) => LspPrepare }>;
type Session = { token: number; id: string; target: TabTarget; editor: TextEditor; controller: NavigationController };
type Job = { origin: Session; selections: SelectionSet; input: NavigationInput; sources: Map<string, DocumentSnapshot>; targets: Map<string, Session>;
    timer: number; result?: NavigationResult; page: NavigationPage | undefined; navigated: boolean };
export type NavigationNote = NavigationLocation & Readonly<{ ordinal: number; title: string; line: number; column: number; open: () => void }>;
export type NavigationSnapshot = Readonly<{ available: boolean; connected: boolean; disconnected: boolean; syncedDocuments: number; view: string | null; requestView: string | null; token: number | null; status: "idle" | "pending" | "ready" | "empty" | "failed" | "expired" | "disconnected";
    message: string; work: number; total: number; includeDeclaration: boolean; locations: readonly NavigationNote[]; count: number; truncated: boolean; first: number; hasNextPage: boolean; canReturn: boolean }>;

/** Host-owned project navigation; results carry identities, never a future focus target. */
export class HostNavigationTools {
    private readonly workspace: Workspace;
    private readonly canCapture: (id: DocumentId) => boolean;
    private readonly present: (id: DocumentId) => TextEditor | undefined;
    private readonly sessions = new Map<number, Session>();
    private active: Session | undefined;
    private job: Job | undefined;
    private presenting = false;
    private disposed = false;
    private companion: DocumentId | undefined;
    private delay = 0;
    private fault: NavigationInput["fault"];
    private client: NavigationController | undefined;
    private readonly options: NavigationHostOptions;
    private disconnected = false;
    private readonly cell = new HostCell<NavigationSnapshot>({ available: false, connected: false, disconnected: false, syncedDocuments: 0, view: null, requestView: null, token: null, status: "idle", message: "Focus a candidate source to navigate symbols.", work: 0, total: 0, includeDeclaration: true, locations: [], count: 0, truncated: false, first: 0, hasNextPage: false, canReturn: false });
    readonly state = this.cell.observable;
    private readonly metrics = { requested: 0, applied: 0, cancelled: 0, expired: 0, failed: 0 };
    private readonly queries = { completed: 0, failed: 0 };
    private readonly reconnectProvider: (() => void) | undefined;
    constructor(workspace: Workspace, canCapture: (id: DocumentId) => boolean, present: (id: DocumentId) => TextEditor | undefined,
        options: NavigationHostOptions, reconnectProvider?: () => void) { this.reconnectProvider = reconnectProvider;
        this.workspace = workspace; this.canCapture = canCapture; this.present = present; this.options = options;
    }
    private available(session: Session): boolean {
        const tab = this.workspace.tabs.resolve(session.target), editor = session.editor;
        return !this.disposed && this.sessions.get(session.token) === session && editor.element.isConnected && !editor.activity().disposed && this.workspace.ownsDocumentView(editor.view)
            && tab?.surface.kind === "text" && tab.surface.documentId === editor.view.documentId && this.workspace.observeDocument(editor.view.documentId).getSnapshot() !== undefined;
    }
    private publish(patch: Partial<NavigationSnapshot> = {}): void {
        const job = this.job, state = { ...this.cell.get(), ...patch }, locations: NavigationNote[] = [];
        const page = job?.page;
        if (job && page) for (const choice of page.locations) {
            const doc = job.sources.get(choice.document.documentId)!;
            const { line, column } = doc.buffer.positionAt(choice.from);
            locations.push({ document: doc.id, revision: doc.revision, from: choice.from, to: choice.to, declaration: job.input.kind === "definition",
                ordinal: choice.index, title: doc.title.slice(0, 128), line: line + 1, column: column + 1, open: () => this.open(job, choice) });
        }
        const transport = this.client?.getDiagnostics();
        this.cell.set({ ...state, available: !!this.active && this.available(this.active), connected: !!transport?.connected, disconnected: this.disconnected, syncedDocuments: transport?.documents.length ?? 0, view: this.active?.id ?? null, requestView: job?.origin.id ?? null, token: job?.input.id ?? null,
            locations, first: page?.first ?? 0, hasNextPage: !!page?.nextPage, count: page?.count ?? 0, canReturn: !!job?.navigated });
    }
    private dropClient(): void { const previous = this.client; this.client = undefined; previous?.cancel(); }
    private clear(status: NavigationSnapshot["status"], message: string): void {
        const job = this.job; this.job = undefined;
        if (job) { job.origin.editor.element.ownerDocument.defaultView!.clearTimeout(job.timer); this.dropClient(); }
        this.publish({ status, message, work: 0, total: 0, truncated: false });
    }
    readonly cancel = (): void => { if (this.job) this.metrics.cancelled++; this.clear("idle", "Symbol navigation dismissed."); };
    readonly disconnect = (): void => { this.cancel(); this.dropClient(); this.disconnected = true; this.publish({ status: "disconnected", message: "Navigation provider disconnected; local editing remains available." }); };
    readonly reconnect = (): void => { this.cancel(); this.dropClient(); this.disconnected = false; this.reconnectProvider?.(); this.publish({ status: "idle", message: "Request fresh navigation with current resources." }); };
    attach(id: string, tab: TabId, editor: TextEditor): () => void {
        const controller = createNavigationController(editor, this.options.provider, { documents: () => this.workspace.getSnapshot().documents.filter(doc => doc.language !== null),
            canCapture: () => !this.disconnected && !this.disposed && this.canCapture(editor.view.documentId),
            prepareRequest: kind => { const fault = this.fault; this.fault = undefined; return this.options.prepare(kind, this.delay, fault); },
            onDefinition: offset => { this.active = session; editor.focus(); this.start("definition", true, offset); } });
        const session: Session = { token: this.workspace.allocateIdentity(), id, target: this.workspace.tabs.capture(tab), editor, controller }, listeners = new AbortController(); this.sessions.set(session.token, session);
        const stop = controller.subscribe(() => {
            const job = this.job;
            if (job?.origin === session && controller.getSnapshot().status === "expired") {
                queueMicrotask(() => { if (this.job === job) { this.metrics.expired++; this.clear("expired", "Captured navigation changed; request fresh results."); } });
            }
            this.publish();
        });
        editor.input.addEventListener("focus", () => { this.active = session; this.publish(); }, { signal: listeners.signal });
        for (const name of ["compositionstart", "beforeinput", "paste", "cut"] as const) editor.input.addEventListener(name, () => {
            if (!this.presenting && this.job?.sources.has(editor.view.documentId)) this.cancel();
        }, { signal: listeners.signal });
        let detached = false;
        const detach = () => { if (detached) return; detached = true; if (!this.presenting && this.job) this.cancel(); listeners.abort(); stop(); controller.dispose(); this.sessions.delete(session.token);
            if (this.active === session) this.active = undefined; if (!this.sessions.size) this.dropClient(); this.publish(); };
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
    private requestFromPanel(kind: NavigationInput["kind"]): void {
        if (!this.active?.editor.commands.run("navigation." + kind, "panel"))
            this.publish({ message: "Focus an available source and finish typing before requesting navigation." });
    }
    readonly findDefinition = (): void => this.requestFromPanel("definition");
    readonly findReferences = (): void => this.requestFromPanel("references");
    private start(kind: NavigationInput["kind"], keyboard: boolean, pointed?: number): void {
        if (this.disconnected) { this.publish({ status: "disconnected", message: "Reconnect the navigation provider before requesting results." }); return; }
        const origin = this.active;
        if (!origin || !this.available(origin)) { this.publish({ message: "Focus an available candidate source." }); return; }
        if (!this.canCapture(origin.editor.view.documentId)) { this.publish({ message: "Finish pending input, navigation or composition first." }); return; }
        this.cancel(); const offset = pointed ?? origin.editor.view.getSnapshot().selection.head, document = this.workspace.document(origin.editor.view.documentId), symbol = navigationSymbol(document.buffer, offset) ?? "position";
        if (!symbol) { this.publish({ status: "empty", message: "No bounded symbol at this position." }); return; }
        const documents = this.workspace.getSnapshot().documents.filter(doc => doc.language !== null), sources = new Map(documents.map(doc => [doc.id as string, doc]));
        if (!sources.has(document.id)) { this.publish({ status: "failed", message: "This source is outside the host navigation scope." }); return; }
        let input: NavigationInput;
        try { input = validateNavigationInput({ operation: "navigation-start", id: this.workspace.allocateIdentity(), kind, symbol, includeDeclaration: this.cell.get().includeDeclaration, delay: this.delay,
            documents: documents.map(doc => ({ document: doc.id, revision: doc.revision, length: doc.buffer.length })), ...(this.fault ? { fault: this.fault } : {}) }); }
        catch (error) { this.fault = undefined; this.publish({ status: "failed", message: error instanceof Error ? error.message : "Unsupported navigation capture." }); return; }
        const targets = new Map<string, Session>(); for (const s of this.sessions.values()) if (this.available(s) && !targets.has(s.editor.view.documentId)) targets.set(s.editor.view.documentId, s); targets.set(document.id, origin);
        const job: Job = { origin, selections: origin.editor.view.getSnapshot().selectionSet, input, sources, targets, timer: 0, page: undefined, navigated: false };
        this.job = job; this.metrics.requested++; const win = origin.editor.element.ownerDocument.defaultView!;
        try {
            job.timer = win.setTimeout(() => { if (this.job === job && !job.result) { this.metrics.failed++; this.clear("failed", "Navigation timed out; source is unchanged."); } }, 30000);
            const total = input.documents.reduce((sum, doc) => sum + doc.length, 0);
            this.publish({ status: "pending", message: `Finding ${kind === "definition" ? "definitions" : "references"} of ${symbol} from ${origin.id}.`, work: 0, total, truncated: false });
            if (this.client !== origin.controller) this.dropClient();
            this.client = origin.controller;
            void this.client.request(kind, offset, input.includeDeclaration).then(result => {
                this.queries.completed++;
                if (this.job !== job || origin.controller.getSnapshot().result !== result) return;
                win.clearTimeout(job.timer); job.result = result; job.page = result.pageFor(); this.metrics.applied++;
                this.publish({ status: result.count ? "ready" : "empty", message: `${result.count} ${kind === "definition" ? "definition" : "reference"} locations for ${symbol} across ${sources.size} captured resources.`, work: total });
                if (keyboard && kind === "definition" && result.count === 1 && origin.editor.element.ownerDocument.activeElement === origin.editor.input) this.open(job, job.page!.selected);
            }).catch(error => { if (this.job !== job) return; this.queries.failed++; this.metrics.failed++; this.clear("failed", error instanceof Error ? error.message : "Navigation failed; source is unchanged."); });
        } catch (error) { this.metrics.failed++; this.clear("failed", error instanceof Error ? error.message : "Navigation is unavailable."); }
    }
    private place(job: Job, document: DocumentId, selections: SelectionSet | Readonly<{ from: number; to: number }>): boolean {
        if (!job.result || this.job !== job || job.origin.controller.getSnapshot().result !== job.result || !this.canCapture(document)) { this.publish({ message: "Finish pending input or request fresh navigation results." }); return false; }
        this.presenting = true;
        try {
            const captured = job.targets.get(document), editor = captured && this.available(captured) ? captured.editor : this.present(document);
            if (!editor || this.job !== job || job.origin.controller.getSnapshot().result !== job.result || editor.view.documentId !== document) { this.publish({ message: "The captured destination cannot be presented in an available candidate pane." }); return false; }
            const revision = job.sources.get(document)!.revision;
            if ("ranges" in selections) {
                if (!editor.view.setSelections(revision, selections.ranges, selections.primary)) return false;
                const { head } = selections.ranges[selections.primary]!;
                if (!editor.reveal({ from: head, to: head }, { expectedRevision: revision, focus: true })) return false;
            } else if (!editor.reveal(selections, { expectedRevision: revision, select: true, focus: true })) return false;
            job.navigated = true; this.publish(); return true;
        } finally { this.presenting = false; }
    }
    private open(job: Job, choice: NavigationChoice): void {
        choice.open(at => {
            const doc = job.sources.get(at.document.documentId)!;
            if (this.place(job, doc.id, at)) this.publish({ message: `Opened a captured ${job.input.kind} location in ${doc.title.slice(0, 128)}.` });
        });
    }
    readonly returnToOrigin = (): void => { const job = this.job; if (job?.navigated && this.place(job, job.origin.editor.view.documentId, job.selections)) this.publish({ message: "Returned to the captured origin and complete selection set." }); };
    private movePage(action: "previousPage" | "nextPage"): void {
        const job = this.job, page = job?.page?.[action]?.();
        if (job && page) { job.page = page; this.publish(); }
    }
    readonly nextPage = (): void => this.movePage("nextPage");
    readonly previousPage = (): void => this.movePage("previousPage");
    setIncludeDeclaration(value: boolean): void { if (value === this.cell.get().includeDeclaration) return; this.cancel(); this.publish({ includeDeclaration: value }); }
    readonly addCompanion = (): void => {
        if (this.disposed) return; this.cancel();
        this.companion ??= createWorkingSource(this.workspace, "navigation-companion", "Navigation companion", { value: "const catalogue = 1;\r\ncatalogue;\r\n" }).documentId;
        this.publish({ message: "Navigation companion added. Find catalogue from a source view to open its captured definition." });
    };
    setDelay(value: number): void { if (!Number.isFinite(value) || value < 0 || value > 1000) throw new RangeError("Invalid navigation delay."); this.delay = value; }
    faultNext(value: NonNullable<NavigationInput["fault"]>): void { this.fault = value; }
    releaseCompanion(): boolean {
        if (!this.companion) return false; this.cancel();
        try { this.workspace.releaseDocument(this.companion); this.companion = undefined; this.publish(); return true; } catch { return false; }
    }
    debug() { return { ...this.metrics, queries: { ...this.queries }, sessions: [...this.sessions.values()].map(s => ({ id: s.id, documentId: s.editor.view.documentId, token: s.token })), subscriptions: this.cell.count(),
        pending: !!this.job && !this.job.result, results: this.job?.result?.count ?? 0, scope: this.job?.sources.size ?? 0, companion: this.companion ?? null, transport: this.client?.getDiagnostics() ?? null, disposed: this.disposed }; }
    dispose(): void { if (this.disposed) return; this.cancel(); this.dropClient(); this.disposed = true; this.active = undefined; this.publish(); }
}
