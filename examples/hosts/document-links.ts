import { createPanelKeyBinding } from "./panel-keys.ts";
import { onSourceFocus } from "./source-focus.ts";
import { createWorkingSource } from "./working-source.ts";
import type { DocumentId, DocumentSnapshot, SelectionSet, TabId, Workspace } from "../../src/index.ts";
import { createDocumentLinkController } from "../../src/browser/index.ts";
import type { DocumentLinkChoice, DocumentLinkController, DocumentLinkSnapshot, TextEditor } from "../../src/browser/index.ts";
import type { LspPrepare, LspWorkspace } from "../../src/protocol/index.ts";
import { linkLimits } from "../../fixtures/language/links.ts";
import type { LinksInput, ModuleLink } from "../../fixtures/language/links.ts";
import { validDomainModule } from "../../fixtures/language/domain.ts";
import { HostCell } from "../shared/observable.ts";

type Alias = Readonly<{ module: string; uri: string }>;
export type LinkHostOptions = Readonly<{ provider: LspWorkspace;
    prepare: (aliases: readonly Alias[], delay: number, fault?: LinksInput["fault"]) => LspPrepare }>;
type Session = { id: string; editor: TextEditor; controller: DocumentLinkController };
type Route = { origin: Session; source: DocumentSnapshot; selections: SelectionSet; documents: Map<string, DocumentSnapshot>;
    targets: Map<DocumentId, Session>; destination?: TextEditor; releaseHistory?: () => void };
export type LinkNote = ModuleLink & Readonly<{ line: number; column: number; title: string; targetTitle: string | null; resolvable: boolean; open: () => void }>;
export type DocumentLinksSnapshot = Readonly<{ available: boolean; connected: boolean; disconnected: boolean; pending: boolean; requestView: string | null;
    status: DocumentLinkSnapshot["status"] | "away"; message: string; count: number; page: number; links: readonly LinkNote[]; canReturn: boolean }>;
const initial: DocumentLinksSnapshot = { available: false, connected: false, disconnected: false, pending: false, requestView: null,
    status: "idle", message: "Focus a source to discover module links.", count: 0, page: 0, links: [], canReturn: false };

/** The sample owns module aliases, pane selection and the route back from an explicitly opened destination. */
export class HostDocumentLinks {
    private readonly aliases = new Map<string, DocumentId>();
    private readonly sessions = new Set<Session>();
    private active: Session | undefined;
    private route: Route | undefined;
    private companion: DocumentId | undefined;
    private readonly linkList = createPanelKeyBinding<HTMLElement>(() => this.listEditor());
    private disposed = false;
    private disconnected = false;
    private presenting = false;
    private delay = 0;
    private fault: LinksInput["fault"];
    private readonly metrics = { requested: 0, opened: 0, returned: 0 };
    private readonly cell = new HostCell(initial);
    readonly state = this.cell.observable;
    private readonly workspace: Workspace;
    private readonly canCapture: (id: DocumentId) => boolean;
    private readonly present: (id: DocumentId) => TextEditor | undefined;
    private readonly options: LinkHostOptions;
    private readonly reconnectProvider: (() => void) | undefined;
    constructor(workspace: Workspace, canCapture: (id: DocumentId) => boolean, present: (id: DocumentId) => TextEditor | undefined,
        options: LinkHostOptions, reconnectProvider?: () => void) {
        this.workspace = workspace; this.canCapture = canCapture; this.present = present;
        this.options = options; this.reconnectProvider = reconnectProvider;
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
    readonly reconnect = () => { this.disconnected = false; this.cancel(); this.reconnectProvider?.(); };
    private listEditor() {
        const route = this.route;
        return route && (this.sessions.has(route.origin) ? route.origin.editor : route.destination);
    }
    readonly bindList = this.linkList.bind;
    attach(id: string, _tab: TabId, editor: TextEditor) {
        const controller = createDocumentLinkController(editor, this.options.provider, {
            documents: () => [...(this.route?.documents.values() ?? [])], canCapture: this.canCapture,
            prepareRequest: () => {
                const aliases = [...this.aliases].map(([module, id]) => ({ module, uri: this.workspace.document(id).language!.uri }));
                const fault = this.fault; this.fault = undefined; return this.options.prepare(aliases, this.delay, fault);
            },
        });
        const session = { id, editor, controller }, events = new AbortController();
        this.sessions.add(session);
        const stop = controller.subscribe(() => { if (this.route?.origin === session) this.render(this.route); });
        const detach = () => {
            if (!this.sessions.delete(session)) return;
            if (this.active === session) this.active = undefined;
            stop(); events.abort();
            if (!this.presenting && this.route) this.cancel();
            controller.dispose(); this.publish();
        };
        try {
            for (const [id, label, key, run, enabled] of [
                ["links.discover", "Discover module links", "F4", () => { this.active = session; this.start(true); }, () => !this.disconnected],
                ["links.return", "Return to link origin", "Shift+F4", this.returnToOrigin, () => !!this.route?.destination],
            ] as const) {
                const command = editor.commands.register({ id, label, run, enabled }, { keys: [key] });
                events.signal.addEventListener("abort", command.dispose, { once: true });
            }
            const dismiss = editor.commands.register({ id: "links.dismiss", label: "Dismiss module links",
                enabled: () => this.listEditor() === editor && !!this.linkList.element?.matches(":focus-within"),
                run: () => {
                    const origin = this.route?.origin;
                    this.cancel();
                    if (origin && this.sessions.has(origin)) origin.editor.focus();
                } }, { keys: ["Escape"], shared: true, priority: 7 });
            events.signal.addEventListener("abort", dismiss.dispose, { once: true });
        } catch (error) { detach(); throw error; }
        onSourceFocus(editor, events.signal, () => {
            if (this.active !== session && this.cell.get().status === "resolving" && !this.presenting) this.cancel();
            this.active = session; this.publish();
        });
        editor.onEditIntent(() => {
            const uri = this.workspace.document(editor.view.documentId).language?.uri;
            if (!this.presenting && uri && this.route?.documents.has(uri)) this.cancel();
        }, events.signal);
        return detach;
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
        this.publish({ status, pending: false, links, page, count: state.links.length, message: `${state.links.length} module links.` });
    }
    readonly discover = () => this.start(false);
    private start(keyboard: boolean, returning = false) {
        const origin = this.active;
        if (!origin || this.disconnected || !this.canCapture(origin.editor.view.documentId)) return;
        const source = this.workspace.document(origin.editor.view.documentId);
        if (!source.language) return;
        const documents = new Map([[source.language.uri, source]]);
        for (const id of this.aliases.values()) {
            if (!this.canCapture(id)) return;
            const target = this.workspace.document(id);
            if (!target.language) return;
            documents.set(target.language.uri, target);
        }
        const targets = new Map<DocumentId, Session>();
        for (const s of this.sessions) if (!targets.has(s.editor.view.documentId)) targets.set(s.editor.view.documentId, s);
        targets.set(source.id, origin);
        this.release();
        const route: Route = { origin, source, documents, targets, selections: origin.editor.view.getSnapshot().selectionSet };
        this.route = route; this.metrics.requested++;
        if (!returning) this.publish({ ...initial });
        void origin.controller.request().then(() => {
            const state = origin.controller.getSnapshot();
            if (this.route !== route || state.status !== "ready") return;
            const head = route.selections.ranges[route.selections.primary]!.head;
            const index = state.links.findIndex(link => link.from <= head && head <= link.to);
            if (index >= 0) this.render(route, Math.floor(index / linkLimits.page));
            if (keyboard && origin.editor.getSnapshot().focused) this.linkList.element?.focus();
        });
    }
    private place(route: Route, doc: DocumentSnapshot, selections?: SelectionSet) {
        const live = this.workspace.observeDocument(doc.id).getSnapshot();
        if (this.route !== route || !this.canCapture(doc.id) || live?.revision !== doc.revision || live.buffer !== doc.buffer) return;
        const captured = route.targets.get(doc.id);
        this.presenting = true;
        try {
            const editor = captured && this.sessions.has(captured) ? captured.editor : this.present(doc.id);
            if (!editor || this.route !== route || editor.view.documentId !== doc.id) return;
            const placed = selections ? editor.view.setSelections(doc.revision, selections.ranges, selections.primary)
                : editor.view.setSelection(doc.revision, { anchor: 0, head: 0 });
            if (!placed) return;
            editor.viewport.revealOffset(editor.view.getSnapshot().selection.head); editor.focus(); return editor;
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
        const { source } = route, lease = this.workspace.acquire(source.resourceId), handle = this.workspace.observeDocument(source.id);
        const metadata = this.workspace.resourceForDocument(source.id).metadata;
        const invalidate = () => { delete route.destination; queueMicrotask(() => { if (this.route === route) this.cancel(); }); };
        const stop = handle.subscribe(invalidate), stopMetadata = metadata.subscribe(invalidate);
        return () => { stop(); stopMetadata(); lease.release(); };
    }
    readonly returnToOrigin = () => {
        const route = this.route;
        if (!route?.destination || !this.place(route, route.source, route.selections)) return;
        this.metrics.returned++;
        if (!this.sessions.has(route.origin)) this.start(false, true);
        else this.publish({ message: "Returned to the captured source and selection." });
    };
    private page(delta: number) {
        const route = this.route, state = this.cell.get(), page = state.page + delta;
        if (route && state.status === "ready" && page >= 0 && page * linkLimits.page < state.count) this.render(route, page);
    }
    readonly nextPage = () => this.page(1);
    readonly previousPage = () => this.page(-1);
    setAlias(module: string, document: DocumentId | null) {
        if (!validDomainModule(module) || document && this.workspace.document(document).key.variant !== "working") throw new Error("Choose a bounded module alias and working resource.");
        if (document === (this.aliases.get(module) ?? null)) return;
        if (document && !this.aliases.has(module) && this.aliases.size === linkLimits.aliases) throw new Error("Module alias limit reached.");
        this.cancel(); if (document) this.aliases.set(module, document); else this.aliases.delete(module);
    }
    readonly addCompanion = () => {
        if (this.disposed) return;
        this.companion ??= createWorkingSource(this.workspace, "module-companion", "Module companion", { value: "export const value = 1;\r\n" }).documentId;
        this.setAlias("sample-utils", this.companion); this.publish({ message: "Module companion registered for sample-utils." });
    };
    setDelay(value: number) { if (!Number.isFinite(value) || value < 0 || value > 1000) throw new RangeError("Invalid links delay."); this.delay = value; }
    faultNext(value: NonNullable<LinksInput["fault"]>) { this.fault = value; }
    debug() { return { ...this.metrics, state: this.cell.get(), companion: this.companion ?? null,
        sessions: this.sessions.size, subscriptions: this.cell.count(), disposed: this.disposed }; }
    dispose() { if (!this.disposed) { this.cancel(); this.linkList.dispose(); this.aliases.clear(); this.disposed = true; this.publish(); } }
}
