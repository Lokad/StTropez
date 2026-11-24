import { fixtureRequests, type FixturePolicy } from "../shared/language/fixture-requests.ts";
import { createPanelKeyBinding, focusResult, registerResultArrows } from "./panel-keys.ts";
import { attachPanelSession } from "../shared/editor-attachment.ts";
import { createReviewKey, panelPaging, type PanelPaging } from "./panel-actions.ts";
import { captureDestinationPanes, presentDocument, unavailablePaneMessage, type HostLocation, type NavigationHost } from "./language-host.ts";
import { focusSource, onSourceFocus } from "./source-focus.ts";
import { createWorkingSource } from "./working-source.ts";
import type { DocumentId, DocumentSnapshot, TabId } from "../../src/index.ts";
import { createDocumentLinkController } from "../../src/browser/index.ts";
import type { DocumentLinkChoice, DocumentLinkController, DocumentLinkSnapshot, NavigationPointerLink, TextEditor, ViewState } from "../../src/browser/index.ts";
import type { LspPrepare, LspWorkspace } from "../../src/protocol/index.ts";
import { linkLimits } from "../../fixtures/language/links.ts";
import type { LinksInput, ModuleLink } from "../../fixtures/language/links.ts";
import { validDomainModule } from "../../fixtures/language/domain.ts";
import { HostCell } from "../shared/observable.ts";

type LinkFault = NonNullable<LinksInput["fault"]>;
const expiredMessage = "Module links expired. Press F4 in the source to refresh them.";
type Alias = Readonly<{ module: string; uri: string }>;
export type LinkHostOptions = Readonly<{ provider: LspWorkspace;
    prepare: (aliases: readonly Alias[], policy: FixturePolicy<LinkFault>) => LspPrepare }>;
type Session = { id: string; editor: TextEditor; controller: DocumentLinkController };
type Origin = { origin: Session; source: DocumentSnapshot };
type Route = Origin & { documents: Map<string, DocumentSnapshot>; targets: Map<DocumentId, Session>; returnPoint: HostLocation; focusResults?: () => boolean };
type Visit = Origin & { destination: TextEditor; viewState: ViewState; release: () => void; returnPoint?: HostLocation };
type LinkRange = Pick<DocumentLinkChoice, "from" | "to">;
export type LinkNote = Omit<ModuleLink, "target"> & Readonly<{ line: number; column: number; targetTitle: string | null; resolvable: boolean; open: () => void }>;
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
    private visit: Visit | undefined;
    private companion: DocumentId | undefined;
    private readonly linkList = createPanelKeyBinding<HTMLElement>(() => this.listEditor());
    private disposed = false;
    private disconnected = false;
    private presenting = false;
    readonly fixture = fixtureRequests<LinkFault>("links");
    private readonly metrics = { requested: 0, opened: 0, returned: 0 };
    private readonly cell = new HostCell(initial);
    readonly state = this.cell.observable;
    private readonly host: NavigationHost;
    private readonly options: LinkHostOptions;
    private readonly stopHistory: () => void;
    constructor(host: NavigationHost, options: LinkHostOptions) {
        this.host = host; this.options = options;
        this.pageKey = createReviewKey(host.workspace);
        this.stopHistory = host.history.subscribe(() => {
            const visit = this.visit;
            if (visit?.returnPoint && !visit.returnPoint.recorded()) { this.releaseVisit(); this.publish(); }
        });
    }
    private publish(patch: Partial<DocumentLinksSnapshot> = {}) {
        this.cell.set({ ...this.cell.get(), ...patch, available: !!this.active && !this.disposed && !this.active.editor.signal.aborted,
            connected: !!this.route && !this.disconnected && this.options.provider.getSnapshot().phase === "ready",
            disconnected: this.disconnected, requestView: this.route?.origin.id ?? null, canReturn: !!this.visit });
        if (patch.message) this.host.report("modules", patch.message);
    }
    private releaseResults() {
        const route = this.route; this.route = undefined;
        route?.origin.controller.cancel();
    }
    private releaseVisit() {
        const visit = this.visit; this.visit = undefined;
        visit?.release();
    }
    private release() { this.releaseResults(); this.releaseVisit(); }
    private expireResults() {
        this.releaseResults();
        this.publish({ ...initial, status: "expired", message: expiredMessage });
    }
    readonly cancel = () => { this.release(); this.publish({ ...initial, message: "Module links dismissed." }); };
    readonly disconnect = () => {
        this.disconnected = true;
        this.cancel();
        for (const s of this.sessions.keys()) s.controller.setPaint(false);
    };
    readonly reconnect = () => {
        this.disconnected = false;
        this.cancel();
        for (const s of this.sessions.keys()) s.controller.setPaint(true);
        this.host.reconnect?.();
    };
    private listEditor() {
        const route = this.route;
        return route && this.sessions.has(route.origin) ? route.origin.editor : this.visit?.destination;
    }
    readonly bindList = this.linkList.bind;
    attach(id: string, _tab: TabId, editor: TextEditor) {
        if (this.disposed) throw new Error("Link panel is disposed.");
        const controller = createDocumentLinkController(editor, this.options.provider, {
            paint: !this.disconnected,
            documents: () => [...(this.route?.documents.values() ?? [])], canCapture: this.host.canCapture,
            prepareRequest: () => {
                const aliases = [...this.aliases].map(([module, id]) => ({ module, uri: this.host.workspace.document(id).language!.uri }));
                return this.options.prepare(aliases, this.fixture.take());
            },
        });
        const session = { id, editor, controller };
        return attachPanelSession(this.sessions, session, (signal, register) => {
            const stop = controller.subscribe(() => {
                const route = this.route;
                if (route?.origin === session) this.render(route);
            });
            signal.addEventListener("abort", stop, { once: true });
            register({ id: "links.discover", label: "Discover module links", enabled: () => !this.disconnected,
                run: () => { this.active = session; this.start(true); } }, { keys: ["F4"] });
            register({ id: "links.return", label: "Return to link origin", enabled: () => !!this.visit,
                run: this.returnToOrigin }, { keys: ["Shift+F4"] });
            registerResultArrows(register, "links", 7, () => this.linkList.element, () => this.listEditor() === editor && this.linkList.focused);
            const leave = () => { if (this.route?.origin === session) delete this.route.focusResults; };
            editor.element.addEventListener("focusout", leave, { signal });
            editor.element.ownerDocument.defaultView!.addEventListener("blur", leave, { signal });
            register({ id: "links.dismiss", label: "Dismiss module links",
                enabled: () => this.listEditor() === editor && this.linkList.focused,
                run: () => {
                    const origin = this.route?.origin;
                    this.cancel();
                    if (origin && this.sessions.has(origin)) focusSource(origin.editor);
                } }, { keys: ["Escape"], shared: true, priority: 7 });
            onSourceFocus(editor, signal, () => {
                if (this.active !== session && this.cell.get().status === "resolving" && !this.presenting) this.cancel();
                this.active = session; this.publish();
            });
            editor.onEditIntent(() => {
                if (this.presenting) return;
                const id = editor.view.documentId, uri = this.host.workspace.document(id).language?.uri;
                if (this.visit?.source.id === id) this.cancel();
                else if (uri && this.route?.documents.has(uri)) this.expireResults();
            }, signal);
        }, () => {
            if (this.active === session) this.active = undefined;
            const route = this.route;
            if (!this.presenting) {
                if (this.visit?.destination === editor || this.visit?.origin === session) this.cancel();
                else if (route?.targets.get(editor.view.documentId) === session) this.expireResults();
            }
            this.publish();
        });
    }
    private render(route: Route, page = this.cell.get().page) {
        const state = route.origin.controller.getSnapshot(), status = state.status;
        if (status === "pending") { this.publish({ status, pending: true, message: "Discovering module links…" }); return; }
        if (status === "resolving") { this.publish({ status, pending: true, message: "Resolving the selected link…" }); return; }
        if (status !== "ready") {
            this.route = undefined;
            this.publish({ ...initial, status, message: state.message || (status === "expired" ? expiredMessage : "Module links dismissed.") });
            return;
        }
        const { source } = route;
        const links = state.links.slice(page * linkLimits.page, (page + 1) * linkLimits.page).map(item => {
            const doc = item.target ? route.documents.get(item.target) : undefined, { line, column } = source.buffer.positionAt(item.from);
            const module = source.buffer.slice(item.from, Math.min(item.to, item.from + 128));
            return { from: item.from, to: item.to, tooltip: item.tooltip || item.target || "Unresolved provider link",
                module, targetTitle: doc?.title.slice(0, 128) ?? null, resolvable: item.canResolve, line: line + 1, column: column + 1,
                open: () => this.open(route, item, module) };
        });
        const paging = panelPaging(this.pageKey(route)!, page, state.links.length, linkLimits.page, next => {
            const current = this.cell.get();
            if (this.route === route && current.status === "ready" && current.links === links) this.render(route, next);
        });
        this.publish({ status, pending: false, links, page, paging, count: state.links.length, message: `${state.links.length} module links.` });
    }
    readonly discover = () => this.start(false);
    private begin(origin: Session, returning = false, pointedOffset?: number) {
        if (this.disconnected || !this.sessions.has(origin) || !this.host.canCapture(origin.editor.view.documentId)) return;
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
        const returnPoint = this.host.history.capture(origin.editor, pointedOffset); if (!returnPoint) return;
        this.release();
        const route: Route = { origin, source, documents, targets, returnPoint };
        this.route = route; this.metrics.requested++;
        if (!returning) this.publish({ ...initial });
        return route;
    }
    private start(keyboard: boolean, returning = false) {
        const mayFocus = this.host.claimNavigationFocus("modules");
        const origin = this.active, route = origin && this.begin(origin, returning);
        if (!origin || !route) return;
        if (keyboard && origin.editor.getSnapshot().focused) route.focusResults = mayFocus;
        void origin.controller.request().then(result => {
            if (this.route !== route || result.status !== "done") return;
            const head = route.returnPoint.viewState.head;
            const index = result.value.findIndex(link => link.from <= head && head <= link.to);
            if (index >= 0) this.render(route, Math.floor(index / linkLimits.page));
            if (route.focusResults) origin.editor.element.ownerDocument.defaultView!.requestAnimationFrame(() => {
                if (this.route === route && route.focusResults?.() && origin.editor.getSnapshot().focused
                    && origin.controller.getSnapshot().links === result.value) focusResult(this.linkList.element, Math.max(0, index) % linkLimits.page);
            });
        });
    }
    linkAt(editor: TextEditor, offset: number): NavigationPointerLink | undefined {
        if (this.disconnected || this.disposed || !this.host.canCapture(editor.view.documentId)) return;
        const origin = [...this.sessions.keys()].find(session => session.editor === editor);
        if (!origin) return;
        const source = this.host.workspace.document(editor.view.documentId), previous = this.route;
        const current = previous?.origin === origin && origin.controller.getSnapshot().status === "ready";
        const link = origin.controller.linkAt(offset);
        if (!link) return;
        // A fresh route must supply the host's current aliases before resolving the URI.
        const selected = current ? link : { from: link.from, to: link.to };
        const module = source.buffer.slice(link.from, Math.min(link.to, link.from + 128));
        const alias = this.aliases.get(module);
        return { from: link.from, to: link.to, open: () => {
            if (!this.sessions.has(origin) || this.disconnected || this.aliases.get(module) !== alias || this.route !== previous
                || this.host.workspace.document(source.id).revision !== source.revision) return;
            editor.focus(); this.active = origin;
            const route = current ? previous : this.begin(origin, false, offset);
            if (!route) return;
            if (!current) { void this.open(route, selected, module); return; }
            const returnPoint = this.host.history.capture(editor, offset);
            if (returnPoint) void this.open(route, selected, module, returnPoint);
        } };
    }
    private place(owner: Route | Visit, doc: DocumentSnapshot, captured: Session | undefined, viewState?: ViewState) {
        const current = () => this.route === owner || this.visit === owner;
        const live = this.host.workspace.observeDocument(doc.id).getSnapshot();
        if (!current() || live?.revision !== doc.revision || live.buffer !== doc.buffer) return;
        this.presenting = true;
        try {
            const editor = this.host.canCapture(doc.id) && presentDocument(this.host, doc.id, captured && this.sessions.has(captured) ? [captured] : []);
            if (!current()) return;
            if (!editor) { this.publish({ message: unavailablePaneMessage }); return; }
            const placed = viewState ? editor.restoreView(viewState)
                : editor.reveal({ from: 0, to: 0 }, { expectedRevision: doc.revision, select: true });
            if (!placed) return;
            focusSource(editor); return editor;
        } catch (error) {
            if (current()) this.publish({ message: error instanceof Error ? error.message : "The host could not open the destination." });
        } finally { this.presenting = false; }
    }
    private async open(route: Route, selected: LinkRange | DocumentLinkChoice, module: string, returnPoint = route.returnPoint) {
        if (this.route !== route || !this.sessions.has(route.origin)) return;
        const owner = route.origin.editor.element.ownerDocument, list = this.linkList.element;
        // Resolving disables the row. Keep Escape and Tab in the results list.
        if ("open" in selected && selected.canResolve && list?.matches(":focus-within")) list.focus({ preventScroll: true });
        const focused = owner.activeElement;
        const mayFocus = this.host.claimNavigationFocus("modules");
        const events = new AbortController(); let follow = true;
        if (!("open" in selected) || selected.canResolve) {
            const leave = () => { follow = false; }, options = { capture: true, once: true, signal: events.signal };
            owner.addEventListener("pointerdown", leave, options);
            owner.addEventListener("focusin", leave, options);
            owner.defaultView?.addEventListener("blur", leave, options);
            list?.addEventListener("focusout", leave, options);
        }
        try {
            let item: DocumentLinkChoice | undefined;
            if ("open" in selected) item = selected;
            else {
                const result = await route.origin.controller.request();
                if (result.status !== "done" || this.route !== route || !follow || !mayFocus() || owner.activeElement !== focused) return;
                item = result.value.find(link => link.from === selected.from && link.to === selected.to);
                if (!item) {
                    this.publish({ message: `No destination for ${module}.` });
                    return;
                }
            }
            const result = await item.open(uri => {
                const doc = route.documents.get(uri);
                if (!doc) { this.publish({ message: "Provider link target is outside the host's captured resources." }); return; }
                if (!follow || !mayFocus() || owner.activeElement !== focused) return;
                // A host can replace the only mounted source while presenting the destination.
                const { origin, source } = route;
                const release = this.retainOrigin(source);
                let placed: TextEditor | undefined;
                try { returnPoint.visit(() => !!(placed = this.place(route, doc, route.targets.get(doc.id)))); }
                finally { if (!placed) release(); }
                if (!placed) return;
                this.releaseVisit();
                this.visit = { origin, source, viewState: returnPoint.viewState, destination: placed, release,
                    ...(this.sessions.has(origin) && returnPoint.recorded() ? { returnPoint } : {}) }; this.metrics.opened++;
                this.publish({ message: `Opened ${doc.title}.`, ...(!this.sessions.has(route.origin) ? { status: "away" as const } : {}) });
            });
            if (result.status === "refused" && result.reason === "no-target" && this.route === route && this.cell.get().status === "ready") {
                this.publish({ message: `No destination for ${module}.` });
            }
        } finally { events.abort(); }
    }
    private retainOrigin(source: DocumentSnapshot) {
        const lease = this.host.workspace.acquire(source.resourceId), handle = this.host.workspace.observeDocument(source.id);
        const metadata = this.host.workspace.resourceForDocument(source.id).metadata;
        const invalidate = () => {
            if (this.visit?.release !== release) return;
            this.visit = undefined;
            // Workspace subscribers cannot release a lease during the transaction that notified them.
            queueMicrotask(() => { release(); this.publish(); });
        };
        const stop = handle.subscribe(invalidate), stopMetadata = metadata.subscribe(invalidate);
        function release() { stop(); stopMetadata(); lease.release(); }
        return release;
    }
    readonly returnToOrigin = () => {
        const visit = this.visit;
        if (!visit) return;
        this.host.claimNavigationFocus("modules");
        if (!this.host.canCapture(visit.destination.view.documentId)) { this.publish({ message: unavailablePaneMessage }); return; }
        if (visit.returnPoint?.isNext()) {
            const result = this.host.back(this.sessions.keys());
            if (result !== "restored") { this.publish({ message: result === "busy" ? unavailablePaneMessage : "No navigation origin is still open." }); return; }
        } else {
            if (!this.place(visit, visit.source, visit.origin, visit.viewState)) return;
            this.releaseVisit();
        }
        this.metrics.returned++;
        if (this.route && !this.sessions.has(visit.origin)) this.start(false, true);
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
        this.disposed = true; this.stopHistory(); this.cancel(); this.linkList.dispose(); this.aliases.clear();
        for (const detach of this.sessions.values()) detach();
    }
}
