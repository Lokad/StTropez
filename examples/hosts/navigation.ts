import { fixtureRequests, type FixturePolicy } from "../shared/language/fixture-requests.ts";
import { captureDestinationPanes, isMountedEditor, presentDocument, type NavigationHost } from "./language-host.ts";
import { onSourceFocus } from "./source-focus.ts";
import { attachPanelSession } from "../shared/editor-attachment.ts";
import { createReviewKey, type PanelPaging } from "./panel-actions.ts";
import { createWorkingSource } from "./working-source.ts";
import type { DocumentId, TabId, TabTarget } from "../../src/index.ts";
import { createNavigationController, createNavigationHistory } from "../../src/browser/index.ts";
import type { NavigationChoice, NavigationController, NavigationDestination, NavigationHistory, NavigationOrigin, NavigationPage, NavigationResult, TextEditor } from "../../src/browser/index.ts";
import type { LspNavigationRequest, LspPrepare, LspWorkspace } from "../../src/protocol/index.ts";
import { navigationSymbol, validateNavigationDocuments } from "../../fixtures/language/navigation.ts";
import type { NavigationFault } from "../../fixtures/language/navigation.ts";
import { HostCell } from "../shared/observable.ts";

type Kind = LspNavigationRequest["kind"];
export type NavigationHostOptions = Readonly<{ provider: LspWorkspace; prepare: (kind: Kind, policy: FixturePolicy<NavigationFault>) => LspPrepare }>;
type Session = { id: string; target: TabTarget; editor: TextEditor; controller: NavigationController };
type Job = { kind: Kind; symbol: string; origin: Session; returnPoint: NavigationOrigin; sources: Set<DocumentId>; targets: Map<DocumentId, Session>;
    timer: number; page: NavigationPage | undefined; followDefinition?: () => boolean };
export type NavigationNote = Readonly<{ ordinal: number; title: string; line: number; column: number; declaration: boolean; open: () => void }>;
export type NavigationSnapshot = Readonly<{ available: boolean; connected: boolean; disconnected: boolean; canCancel: boolean; status: "idle" | "pending" | "ready" | "empty" | "failed" | "expired" | "disconnected";
    message: string; includeDeclaration: boolean; locations: readonly NavigationNote[]; paging: PanelPaging | null; canReturn: boolean }>;

/** Host-owned project navigation; results carry identities, never a future focus target. */
export class HostNavigationTools {
    private readonly history: NavigationHistory;
    private readonly queryKey;
    private readonly sessions = new Map<Session, () => void>();
    private active: Session | undefined;
    private job: Job | undefined;
    private presenting = false;
    private disposed = false;
    private companion: DocumentId | undefined;
    readonly fixture = fixtureRequests<NavigationFault>("navigation");
    private disconnected = false;
    private readonly cell = new HostCell<NavigationSnapshot>({ available: false, connected: false, disconnected: false, canCancel: false, status: "idle", message: "Focus a candidate source to navigate symbols.", includeDeclaration: true, locations: [], paging: null, canReturn: false });
    readonly state = this.cell.observable;
    private readonly metrics = { requested: 0, applied: 0, cancelled: 0, expired: 0, failed: 0 };
    private readonly queries = { completed: 0, failed: 0 };
    private readonly host: NavigationHost;
    private readonly options: NavigationHostOptions;
    constructor(host: NavigationHost, options: NavigationHostOptions) {
        this.host = host; this.options = options;
        this.history = createNavigationHistory(host.workspace);
        this.queryKey = createReviewKey(host.workspace);
    }
    private available(session: Session): boolean {
        return !this.disposed && this.sessions.has(session) && isMountedEditor(this.host.workspace, session.editor, session.target);
    }
    private showPage(job: Job, page: NavigationPage | undefined, patch: Partial<NavigationSnapshot> = {}): readonly NavigationNote[] {
        const titles = new Map(this.host.workspace.getSnapshot().documents.map(doc => [doc.id, doc.title]));
        const locations = page?.locations.map(choice => {
            const { document } = choice, { line, column } = document.buffer.positionAt(choice.from);
            const id = document.documentId as DocumentId, title = (titles.get(id) ?? document.uri).slice(0, 128);
            job.sources.add(id);
            return { ordinal: choice.index, title, line: line + 1, column: column + 1, declaration: job.kind === "definition", open: () => this.open(job, choice, title) };
        }) ?? [];
        const turn = (move: (() => NavigationPage) | null) => move && (() => {
            if (this.job?.page === page) this.showPage(job, move());
        });
        const paging = page ? { key: this.queryKey(job)!, first: page.first, previous: turn(page.previousPage), next: turn(page.nextPage) } : null;
        job.page = page; this.publish({ ...patch, locations, paging });
        return locations;
    }
    private ready(job: Job, result: NavigationResult): void {
        const { editor } = job.origin;
        editor.element.ownerDocument.defaultView!.clearTimeout(job.timer);
        this.queries.completed++; this.metrics.applied++;
        const label = job.kind === "definition" ? "definition" : "reference";
        const locations = this.showPage(job, result.pageFor(), { status: result.count ? "ready" : "empty",
            message: `${result.count} ${label} locations for ${job.symbol}.` });
        if (job.followDefinition && result.count === 1) {
            // Presenting a pane can write to the workspace. Finish controller notification first.
            queueMicrotask(() => { if (job.followDefinition?.() && editor.getSnapshot().focused) locations[0]!.open(); });
        }
    }
    private publish(patch: Partial<NavigationSnapshot> = {}): void {
        this.cell.set({ ...this.cell.get(), ...patch, available: !!this.active && this.available(this.active),
            connected: !!this.job && this.options.provider.getSnapshot().phase === "ready", disconnected: this.disconnected,
            canCancel: !!this.job, canReturn: this.history.getSnapshot() > 0 });
    }
    private clear(status: NavigationSnapshot["status"], message: string, successor?: Session): void {
        const job = this.job; this.job = undefined;
        if (job) {
            if (status === "idle") this.metrics.cancelled++;
            job.origin.editor.element.ownerDocument.defaultView!.clearTimeout(job.timer);
            if (job.origin !== successor) job.origin.controller.cancel();
        }
        this.publish({ status, message, locations: [], paging: null });
    }
    readonly cancel = (): void => this.clear("idle", "Symbol navigation dismissed.");
    readonly disconnect = (): void => { this.cancel(); this.disconnected = true; this.publish({ status: "disconnected", message: "Navigation provider disconnected; local editing remains available." }); };
    readonly reconnect = (): void => { this.cancel(); this.disconnected = false; this.host.reconnect?.(); this.publish({ status: "idle", message: "Request fresh navigation with current resources." }); };
    attach(id: string, tab: TabId, editor: TextEditor): () => void {
        if (this.disposed) throw new Error("Navigation panel is disposed.");
        const target = this.host.workspace.tabs.capture(tab);
        const controller = createNavigationController(editor, this.options.provider, { documents: () => this.host.workspace.getSnapshot().documents.filter(doc => doc.language !== null),
            canCapture: () => !this.disconnected && !this.disposed && this.host.canCapture(editor.view.documentId),
            prepareRequest: kind => this.options.prepare(kind, this.fixture.take()),
            onDefinition: offset => { this.active = session; editor.focus(); this.start("definition", true, offset); } });
        const session: Session = { id, target, editor, controller };
        return attachPanelSession(this.sessions, session, (signal, register) => {
            const stop = controller.subscribe(() => {
                const job = this.job, state = controller.getSnapshot();
                if (job?.origin === session) {
                    if (state.result) { this.ready(job, state.result); return; }
                    if (state.status === "expired") queueMicrotask(() => { if (this.job === job) { this.metrics.expired++; this.clear("expired", "Captured navigation changed; request fresh results."); } });
                }
                this.publish();
            });
            signal.addEventListener("abort", stop, { once: true });
            onSourceFocus(editor, signal, () => { this.active = session; this.publish(); });
            const leaveSource = () => { if (this.job?.origin === session) delete this.job.followDefinition; };
            editor.element.addEventListener("focusout", leaveSource, { signal });
            editor.element.ownerDocument.defaultView!.addEventListener("blur", leaveSource, { signal });
            editor.onEditIntent(() => {
                if (!this.presenting && this.job?.sources.has(editor.view.documentId)) this.cancel();
            }, signal);
            for (const [kind, label, key] of [["definition", "Find definition", "F12"], ["references", "Find references", "Shift+F12"]] as const) {
                register({ id: "navigation." + kind, label, enabled: () => this.available(session),
                    run: from => { this.active = session; this.start(kind, from !== "panel"); } }, { keys: [key] });
            }
            register({ id: "navigation.dismiss", label: "Cancel symbol navigation",
                enabled: () => this.job?.origin === session, run: this.cancel }, { keys: ["Escape"], priority: 5 });
        }, () => {
            if (this.active === session) this.active = undefined;
            if (!this.presenting && this.job?.targets.get(editor.view.documentId) === session) this.cancel();
            this.publish();
        });
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
        if (!this.host.canCapture(origin.editor.view.documentId)) { this.publish({ message: "Finish pending input, navigation or composition first." }); return; }
        const offset = pointed ?? origin.editor.view.getSnapshot().selection.head, document = this.host.workspace.document(origin.editor.view.documentId), symbol = navigationSymbol(document.buffer, offset) ?? "position";
        const documents = this.host.workspace.getSnapshot().documents.filter(doc => doc.language !== null), sources = new Set(documents.map(doc => doc.id));
        if (!sources.has(document.id)) { this.clear("failed", "This source is outside the host navigation scope."); return; }
        try {
            validateNavigationDocuments(documents.map(doc => ({ document: doc.id, revision: doc.revision, length: doc.buffer.length })));
        }
        catch (error) { this.fixture.take(); this.clear("failed", error instanceof Error ? error.message : "Unsupported navigation capture."); return; }
        const targets = captureDestinationPanes(origin, this.sessions.keys(), sources);
        const returnPoint = this.history.capture(origin.editor); if (!returnPoint) { this.cancel(); return; }
        this.clear("idle", "Symbol navigation dismissed.", origin);
        const mayFocus = this.host.claimNavigationFocus();
        const job: Job = { kind, symbol, origin, returnPoint, sources, targets, timer: 0, page: undefined };
        if (keyboard && kind === "definition" && origin.editor.getSnapshot().focused) job.followDefinition = mayFocus;
        this.job = job; this.metrics.requested++; const win = origin.editor.element.ownerDocument.defaultView!;
        try {
            // The panel deadline also bounds host preparation and loading a target after the RPC reply.
            job.timer = win.setTimeout(() => { if (this.job === job) { this.metrics.failed++; this.clear("failed", "Navigation timed out; source is unchanged."); } }, 30000);
            const { includeDeclaration } = this.cell.get();
            this.publish({ status: "pending", message: `Finding ${kind === "definition" ? "definitions" : "references"} of ${symbol} from ${origin.id}.` });
            void origin.controller.request(kind, offset, includeDeclaration).catch(error => {
                if (this.job !== job) return;
                this.queries.failed++; this.metrics.failed++; this.clear("failed", error instanceof Error ? error.message : "Navigation failed; source is unchanged.");
            });
        } catch (error) { this.metrics.failed++; this.clear("failed", error instanceof Error ? error.message : "Navigation is unavailable."); }
    }
    private place(job: Job, at: NavigationDestination): boolean {
        const document = at.document.documentId as DocumentId;
        const { result } = job.origin.controller.getSnapshot();
        if (!result || this.job !== job || !this.host.canCapture(document)) { this.publish({ message: "Finish pending input or request fresh navigation results." }); return false; }
        const source = this.host.workspace.observeDocument(job.origin.editor.view.documentId), before = source.getSnapshot();
        this.presenting = true;
        try {
            const captured = job.targets.get(document);
            const editor = presentDocument(this.host, document, captured && this.available(captured) ? [captured] : []);
            if (this.job !== job) return false;
            // The synchronous presenter can replace the requesting tab to show this very destination.
            const replacedOrigin = !this.sessions.has(job.origin) && editor?.tab?.id === job.origin.target.id
                && editor.tab.generation === job.origin.target.generation + 1 && source.getSnapshot() === before;
            if (!editor || (!replacedOrigin && job.origin.controller.getSnapshot().result !== result) || !this.host.canCapture(document)) {
                this.publish({ message: "The captured destination cannot be presented in an available candidate pane." }); return false;
            }
            return !!editor.reveal(at, { expectedRevision: at.document.revision, select: true, focus: true });
        } finally {
            this.presenting = false;
            if (this.job === job && !this.sessions.has(job.origin)) this.clear("idle", "The requesting pane was replaced.");
        }
    }
    private open(job: Job, choice: NavigationChoice, title: string): void {
        try {
            choice.open(at => {
                if (job.returnPoint.visit(() => this.place(job, at))) this.publish({ message: `Opened a captured ${job.kind} location in ${title}.` });
            });
        } catch (error) {
            if (this.job === job) {
                this.metrics.failed++;
                this.publish({ message: error instanceof Error ? error.message : "The host could not open the destination." });
            }
        }
    }
    readonly returnToOrigin = (): void => {
        if (this.active && !this.host.canCapture(this.active.editor.view.documentId)) return;
        const result = this.history.back(view => {
            if (!this.host.canCapture(view.documentId)) return "busy";
            for (const session of this.sessions.keys()) if (session.editor.view === view && this.available(session)) return session.editor;
            return undefined;
        }, { focus: true });
        this.publish({ message: result === "restored" ? "Returned to the captured origin and complete selection set."
            : result === "busy" ? "Finish pending input before returning." : "No navigation origin is still open." });
    };
    setIncludeDeclaration(value: boolean): void { if (value === this.cell.get().includeDeclaration) return; this.cancel(); this.publish({ includeDeclaration: value }); }
    readonly addCompanion = (): void => {
        if (this.disposed) return; this.cancel();
        this.companion ??= createWorkingSource(this.host.workspace, "navigation-companion", "Navigation companion", { value: "const catalogue = 1;\r\ncatalogue;\r\n" }).documentId;
        this.publish({ message: "Navigation companion added. Find catalogue from a source view to open its captured definition." });
    };
    releaseCompanion(): boolean {
        if (!this.companion) return false; this.cancel();
        try { this.host.workspace.releaseDocument(this.companion); this.companion = undefined; this.publish(); return true; } catch { return false; }
    }
    debug() { return { ...this.metrics, queries: { ...this.queries }, sessions: [...this.sessions.keys()].map(s => ({ id: s.id, documentId: s.editor.view.documentId })), subscriptions: this.cell.count(),
        pending: this.cell.get().status === "pending", results: this.job?.page?.count ?? 0, scope: this.job?.sources.size ?? 0, companion: this.companion ?? null, transport: this.job?.origin.controller.getDiagnostics() ?? null, disposed: this.disposed }; }
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true; this.history.dispose(); this.cancel();
        for (const detach of this.sessions.values()) detach();
    }
}
