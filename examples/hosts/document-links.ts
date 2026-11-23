import { fixtureRequests, type FixturePolicy } from "../shared/language/fixture-requests.ts";
import { createPanelKeyBinding } from "./panel-keys.ts";
import { attachPanelSession } from "../shared/editor-attachment.ts";
import { createReviewKey, panelPaging, type PanelPaging } from "./panel-actions.ts";
import { captureDestinationPanes, presentDocument, unavailablePaneMessage, type LanguageHost } from "./language-host.ts";
import { onSourceFocus } from "./source-focus.ts";
import { createWorkingSource } from "./working-source.ts";
import type { DocumentId, DocumentSnapshot, TabId } from "../../src/index.ts";
import { createDocumentLinkController } from "../../src/browser/index.ts";
import type { DocumentLinkChoice, DocumentLinkController, DocumentLinkSnapshot, TextEditor, ViewState } from "../../src/browser/index.ts";
import type { LspPrepare, LspWorkspace } from "../../src/protocol/index.ts";
import { linkLimits } from "../../fixtures/language/links.ts";
import type { LinksInput, ModuleLink } from "../../fixtures/language/links.ts";
import { validDomainModule } from "../../fixtures/language/domain.ts";
import { HostCell } from "../shared/observable.ts";

type LinkFault = NonNullable<LinksInput["fault"]>;
type Alias = Readonly<{ module: string; uri: string }>;
export type LinkHostOptions = Readonly<{ provider: LspWorkspace;
    prepare: (aliases: readonly Alias[], policy: FixturePolicy<LinkFault>) => LspPrepare }>;
type Session = { id: string; editor: TextEditor; controller: DocumentLinkController };
type Route = { origin: Session; source: DocumentSnapshot; viewState: ViewState; documents: Map<string, DocumentSnapshot>;
    targets: Map<DocumentId, Session>; destination?: TextEditor; releaseHistory?: () => void };
export type LinkNote = ModuleLink & Readonly<{ line: number; column: number; title: string; targetTitle: string | null; resolvable: boolean; open: () => void }>;
export type DocumentLinksSnapshot = Readonly<{ available: boolean; connected: boolean; disconnected: boolean; pending: boolean; requestView: string | null;
    status: DocumentLinkSnapshot["status"] | "away"; message: string; count: number; page: number; paging: PanelPaging | null; links: readonly LinkNote[]; canReturn: boolean }>;
const initial: DocumentLinksSnapshot = { available: false, connected: false, disconnected: false, pending: false, requestView: null,
    status: "idle", message: "Focus a source to discover module links.", count: 0, page: 0, paging: null, links: [], canReturn: false };

/** The sample owns module aliases, pane selection and the route back from an explicitly opened destination. */
export class HostDocumentLinks {
    private readonly pageKey;
    private readonly aliases = new Map<string, DocumentId>();
    private readonly sessions = new Map<Session, () => void>();
    private active: Session | undefined;
    private route: Route | undefined;
    private companion: DocumentId | undefined;
    private readonly linkList = createPanelKeyBinding<HTMLElement>(() => this.listEditor());
    private disposed = false;
    private disconnected = false;
    private presenting = false;
    readonly fixture = fixtureRequests<LinkFault>("links");
    private readonly metrics = { requested: 0, opened: 0, returned: 0 };
    private readonly cell = new HostCell(initial);
    readonly state = this.cell.observable;
    private readonly host: LanguageHost;
    private readonly options: LinkHostOptions;
    constructor(host: LanguageHost, options: LinkHostOptions) {
        this.host = host; this.options = options;
        this.pageKey = createReviewKey(host.workspace);
    }
    private publish(patch: Partial<DocumentLinksSnapshot> = {}) {
        this.cell.set({ ...this.cell.get(), ...patch, available: !!this.active && !this.disposed && !this.active.editor.signal.aborted,
            connected: !!this.route && !this.disconnected && this.options.provider.getSnapshot().phase === "ready",
            disconnected: this.disconnected, requestView: this.route?.origin.id ?? null, canReturn: !!this.route?.destination });
    }
    private release() {
        const route = this.route; this.route = undefined;
        route?.releaseHistory?.(); route?.origin.controller.cancel();
    }
    readonly cancel = () => { this.release(); this.publish({ ...initial, message: "Module links dismissed." }); };
    readonly disconnect = () => { this.disconnected = true; this.cancel(); };
    readonly reconnect = () => { this.disconnected = false; this.cancel(); this.host.reconnect?.(); };
    private listEditor() {
        const route = this.route;
        return route && (this.sessions.has(route.origin) ? route.origin.editor : route.destination);
    }
    readonly bindList = this.linkList.bind;
    attach(id: string, _tab: TabId, editor: TextEditor) {
        if (this.disposed) throw new Error("Link panel is disposed.");
        const controller = createDocumentLinkController(editor, this.options.provider, {
            documents: () => [...(this.route?.documents.values() ?? [])], canCapture: this.host.canCapture,
            prepareRequest: () => {
                const aliases = [...this.aliases].map(([module, id]) => ({ module, uri: this.host.workspace.document(id).language!.uri }));
                return this.options.prepare(aliases, this.fixture.take());
            },
        });
        const session = { id, editor, controller };
        return attachPanelSession(this.sessions, session, (signal, register) => {
            const stop = controller.subscribe(() => { if (this.route?.origin === session) this.render(this.route); });
            signal.addEventListener("abort", stop, { once: true });
            register({ id: "links.discover", label: "Discover module links", enabled: () => !this.disconnected,
                run: () => { this.active = session; this.start(true); } }, { keys: ["F4"] });
            register({ id: "links.return", label: "Return to link origin", enabled: () => !!this.route?.destination,
                run: this.returnToOrigin }, { keys: ["Shift+F4"] });
            register({ id: "links.dismiss", label: "Dismiss module links",
                enabled: () => this.listEditor() === editor && this.linkList.focused,
                run: () => {
                    const origin = this.route?.origin;
                    this.cancel();
                    if (origin && this.sessions.has(origin)) origin.editor.focus();
                } }, { keys: ["Escape"], shared: true, priority: 7 });
            onSourceFocus(editor, signal, () => {
                if (this.active !== session && this.cell.get().status === "resolving" && !this.presenting) this.cancel();
                this.active = session; this.publish();
            });
            editor.onEditIntent(() => {
                const uri = this.host.workspace.document(editor.view.documentId).language?.uri;
                if (!this.presenting && uri && this.route?.documents.has(uri)) this.cancel();
            }, signal);
        }, () => {
            if (this.active === session) this.active = undefined;
            const route = this.route;
            if (!this.presenting && route && (route.targets.get(editor.view.documentId) === session || route.destination === editor)) this.cancel();
            this.publish();
        });
    }
    private render(route: Route, page = this.cell.get().page) {
        const state = route.origin.controller.getSnapshot(), status = state.status;
        if (status === "pending") { this.publish({ status, pending: true, message: "Discovering module links…" }); return; }
        if (status === "resolving") { this.publish({ status, pending: true, message: "Resolving the selected link…" }); return; }
        if (status !== "ready") {
            this.route = undefined;
            this.publish({ ...initial, status, message: state.message || (status === "expired" ? "The source or link target changed." : "Module links dismissed.") });
            return;
        }
        const { source } = route;
        const links = state.links.slice(page * linkLimits.page, (page + 1) * linkLimits.page).map(item => {
            const doc = item.target ? route.documents.get(item.target) : undefined, { line, column } = source.buffer.positionAt(item.from);
            const module = source.buffer.slice(item.from, Math.min(item.to, item.from + 128));
            return { from: item.from, to: item.to, tooltip: item.tooltip || item.target || "Unresolved provider link",
                module, title: source.title.slice(0, 128),
                target: doc ? { document: doc.id, resource: doc.resourceId, revision: doc.revision, length: doc.buffer.length } : null,
                targetTitle: doc?.title.slice(0, 128) ?? null, resolvable: item.canResolve, line: line + 1, column: column + 1,
                open: () => this.open(route, item, module) };
        });
        const paging = panelPaging(this.pageKey(route)!, page, state.links.length, linkLimits.page, next => {
            const current = this.cell.get();
            if (this.route === route && current.status === "ready" && current.links === links) this.render(route, next);
        });
        this.publish({ status, pending: false, links, page, paging, count: state.links.length, message: `${state.links.length} module links.` });
    }
    readonly discover = () => this.start(false);
    private start(keyboard: boolean, returning = false) {
        const origin = this.active;
        if (!origin || this.disconnected || !this.host.canCapture(origin.editor.view.documentId)) return;
        const source = this.host.workspace.document(origin.editor.view.documentId);
        if (!source.language) return;
        const documents = new Map([[source.language.uri, source]]);
        const aliases = new Set(this.aliases.values());
        for (const id of aliases) {
            if (!this.host.canCapture(id)) return;
            const target = this.host.workspace.document(id);
            if (!target.language) return;
            documents.set(target.language.uri, target);
        }
        const targets = captureDestinationPanes(origin, this.sessions.keys(), aliases);
        this.release();
        const route: Route = { origin, source, documents, targets, viewState: origin.editor.captureView() };
        this.route = route; this.metrics.requested++;
        if (!returning) this.publish({ ...initial });
        void origin.controller.request().then(() => {
            const state = origin.controller.getSnapshot();
            if (this.route !== route || state.status !== "ready") return;
            const head = route.viewState.head;
            const index = state.links.findIndex(link => link.from <= head && head <= link.to);
            if (index >= 0) this.render(route, Math.floor(index / linkLimits.page));
            if (keyboard && origin.editor.getSnapshot().focused) this.linkList.element?.focus();
        });
    }
    private place(route: Route, doc: DocumentSnapshot, viewState?: ViewState) {
        const live = this.host.workspace.observeDocument(doc.id).getSnapshot();
        if (this.route !== route || live?.revision !== doc.revision || live.buffer !== doc.buffer) return;
        const captured = route.targets.get(doc.id);
        this.presenting = true;
        try {
            const editor = this.host.canCapture(doc.id) && presentDocument(this.host, doc.id, captured && this.sessions.has(captured) ? [captured] : []);
            if (this.route !== route) return;
            if (!editor) { this.publish({ message: unavailablePaneMessage }); return; }
            const placed = viewState ? editor.restoreView(viewState)
                : editor.reveal({ from: 0, to: 0 }, { expectedRevision: doc.revision, select: true });
            if (!placed) return;
            editor.focus(); return editor;
        } catch (error) {
            if (this.route === route) this.publish({ message: error instanceof Error ? error.message : "The host could not open the destination." });
        } finally { this.presenting = false; }
    }
    private async open(route: Route, item: DocumentLinkChoice, module: string) {
        if (this.route !== route || !this.sessions.has(route.origin)) return;
        const owner = route.origin.editor.element.ownerDocument, list = this.linkList.element;
        // Resolving disables the row. Keep Escape and Tab in the results list.
        if (item.canResolve && list?.matches(":focus-within")) list.focus({ preventScroll: true });
        const focused = owner.activeElement;
        const events = new AbortController(); let follow = true;
        if (item.canResolve) {
            const leave = () => { follow = false; }, options = { capture: true, once: true, signal: events.signal };
            owner.addEventListener("pointerdown", leave, options);
            owner.addEventListener("focusin", leave, options);
            list?.addEventListener("focusout", leave, options);
        }
        try {
            const result = await item.open(uri => {
                const doc = route.documents.get(uri);
                if (!doc) { this.publish({ message: "Provider link target is outside the host's captured resources." }); return; }
                if (!follow || owner.activeElement !== focused) return;
                // A host can replace the only mounted source while presenting the destination.
                const release = this.retainReturn(route);
                let placed: TextEditor | undefined;
                try { placed = this.place(route, doc); }
                finally { if (!placed || this.sessions.has(route.origin)) release(); else route.releaseHistory = release; }
                if (!placed) return;
                route.destination = placed; this.metrics.opened++;
                this.publish({ message: `Opened ${doc.title}.`, ...(!this.sessions.has(route.origin) ? { status: "away" as const } : {}) });
            });
            if (result.status === "no-target" && this.route === route && this.cell.get().status === "ready") {
                this.publish({ message: `No destination for ${module}.` });
            }
        } finally { events.abort(); }
    }
    private retainReturn(route: Route) {
        const { source } = route, lease = this.host.workspace.acquire(source.resourceId), handle = this.host.workspace.observeDocument(source.id);
        const metadata = this.host.workspace.resourceForDocument(source.id).metadata;
        const invalidate = () => { delete route.destination; queueMicrotask(() => { if (this.route === route) this.cancel(); }); };
        const stop = handle.subscribe(invalidate), stopMetadata = metadata.subscribe(invalidate);
        return () => { stop(); stopMetadata(); lease.release(); };
    }
    readonly returnToOrigin = () => {
        const route = this.route;
        if (!route?.destination || !this.place(route, route.source, route.viewState)) return;
        this.metrics.returned++;
        if (!this.sessions.has(route.origin)) this.start(false, true);
        else this.publish({ message: "Returned to the captured source and selection." });
    };
    setAlias(module: string, document: DocumentId | null) {
        if (!validDomainModule(module) || document && this.host.workspace.document(document).key.variant !== "working") throw new Error("Choose a bounded module alias and working resource.");
        if (document === (this.aliases.get(module) ?? null)) return;
        if (document && !this.aliases.has(module) && this.aliases.size === linkLimits.aliases) throw new Error("Module alias limit reached.");
        this.cancel(); if (document) this.aliases.set(module, document); else this.aliases.delete(module);
    }
    readonly addCompanion = () => {
        if (this.disposed) return;
        this.companion ??= createWorkingSource(this.host.workspace, "module-companion", "Module companion", { value: "export const value = 1;\r\n" }).documentId;
        this.setAlias("sample-utils", this.companion); this.publish({ message: "Module companion registered for sample-utils." });
    };
    debug() { return { ...this.metrics, state: this.cell.get(), companion: this.companion ?? null,
        sessions: this.sessions.size, subscriptions: this.cell.count(), disposed: this.disposed }; }
    dispose() {
        if (this.disposed) return;
        this.disposed = true; this.cancel(); this.linkList.dispose(); this.aliases.clear();
        for (const detach of this.sessions.values()) detach();
    }
}
