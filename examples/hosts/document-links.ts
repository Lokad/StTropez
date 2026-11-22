import type { DocumentId, DocumentSnapshot, ResourceLease, SelectionSet, TabId, TabTarget, TextBuffer, Workspace } from "../../src/index.ts";
import { captureViewRequest } from "../../src/browser/index.ts";
import type { CapturedViewRequest, TextEditor } from "../../src/browser/index.ts";
import { linkLimits, validateLinksInput } from "../../fixtures/language/links.ts";
import type { LinksInput, LinksResult, ModuleLink } from "../../fixtures/language/links.ts";
import { validDomainModule } from "../../fixtures/language/domain.ts";
import { HostCell } from "../shared/observable.ts";
type Session = { token: number; id: string; target: TabTarget; editor: TextEditor };
type Source = { document: DocumentSnapshot; authority: string };
export type HostModuleLink = ModuleLink & Readonly<{ resolvable?: boolean }>;
export type LinkBackend = Readonly<{ links: (input: LinksInput, buffer: TextBuffer, progress: (work: number) => void) => Promise<Omit<LinksResult, "links"> & Readonly<{ links: readonly HostModuleLink[] }>>;
    resolve?: (link: HostModuleLink) => Promise<HostModuleLink>; isCurrent?: () => boolean; faultIdle?: () => boolean;
    snapshot: () => Readonly<{ connected: boolean; busy: boolean; transport?: string }>; dispose: () => void }>;
export type LinkBackendFactory = (clock: Window, changed: () => void) => LinkBackend;
type Job = { origin: Session; input: LinksInput; generation: number; capture: CapturedViewRequest; sources: Map<string, Source>; targets: Map<string, Session>;
    leases: ResourceLease[]; stops: (() => void)[]; timer: number; invalid: boolean; ready: boolean; opened: boolean; links: readonly HostModuleLink[];
    resolving?: number | undefined; resolveCapture?: CapturedViewRequest };
export type LinkNote = HostModuleLink & Readonly<{ ordinal: number; line: number; column: number; title: string; targetTitle: string | null }>;
export type DocumentLinksSnapshot = Readonly<{ available: boolean; connected: boolean; disconnected: boolean; pending: boolean; token: number | null; requestView: string | null;
    status: "idle" | "pending" | "ready" | "resolving" | "failed" | "expired"; message: string; work: number; total: number; count: number; page: number; links: readonly LinkNote[]; canReturn: boolean }>;
/** Host-owned aliases and explicit reveal. No provider target is executed as a URL. */
export class HostDocumentLinks {
    private readonly workspace: Workspace;
    private readonly canCapture: (id: DocumentId) => boolean;
    private readonly present: (id: DocumentId) => TextEditor | undefined;
    private readonly aliases = new Map<string, DocumentId>();
    private generation = 0;
    private companion: DocumentId | undefined;
    private readonly sessions = new Map<number, Session>();
    private active: Session | undefined;
    private job: Job | undefined;
    private client: LinkBackend | undefined;
    private readonly factory: LinkBackendFactory;
    private list: HTMLElement | undefined;
    private listEvents: AbortController | undefined;
    private sequence = 0;
    private disposed = false;
    private disconnected = false;
    private presenting = false;
    private delay = 0;
    private fault: LinksInput["fault"];
    private readonly metrics = { requested: 0, opened: 0, returned: 0, cancelled: 0, expired: 0, failed: 0 };
    private readonly cell = new HostCell<DocumentLinksSnapshot>({ available: false, connected: false, disconnected: false, pending: false, token: null, requestView: null, status: "idle", message: "Focus a candidate source to discover module links.", work: 0, total: 0, count: 0, page: 0, links: [], canReturn: false });
    readonly state = this.cell.observable;
    private readonly reconnectProvider: (() => void) | undefined;
    constructor(workspace: Workspace, canCapture: (id: DocumentId) => boolean, present: (id: DocumentId) => TextEditor | undefined, factory: LinkBackendFactory, reconnectProvider?: () => void) { this.reconnectProvider = reconnectProvider; this.workspace = workspace; this.canCapture = canCapture; this.present = present; this.factory = factory; }
    private available(s: Session): boolean {
        const tab = this.workspace.tabs.resolve(s.target);
        return !this.disposed && this.sessions.get(s.token) === s && s.editor.element.isConnected && !s.editor.activity().disposed && this.workspace.ownsDocumentView(s.editor.view)
            && tab?.surface.kind === "text" && tab.surface.documentId === s.editor.view.documentId && !!this.workspace.observeDocument(s.editor.view.documentId).getSnapshot();
    }
    private authority(id: DocumentId): string { const m = this.workspace.resourceForDocument(id).metadata.getSnapshot(); return JSON.stringify([m.state, m.capabilities.edit, m.editLock]); }
    private capture(origin: Session): CapturedViewRequest | undefined { return captureViewRequest(this.workspace, origin.target, origin.editor.view,
        { available: () => this.available(origin) && this.canCapture(origin.editor.view.documentId) }); }
    private current(job: Job): boolean {
        if (this.job !== job || job.invalid || this.disposed || job.generation !== this.generation || !(this.client?.isCurrent?.() ?? true)) return false;
        try {
            for (const { document: doc, authority } of job.sources.values()) if (this.workspace.observeDocument(doc.id).getSnapshot()?.revision !== doc.revision || this.authority(doc.id) !== authority || !this.canCapture(doc.id)) return false;
            if (job.resolving !== undefined && !job.resolveCapture?.isCurrent()) return false;
            return job.ready || job.capture.isCurrent();
        } catch { return false; }
    }
    private changed(job: Job): void {
        if (!this.presenting && this.job === job && !this.current(job)) {
            job.invalid = true; queueMicrotask(() => { if (this.job === job) { this.release(); this.metrics.expired++; this.publish({ status: "expired", message: "Captured source, target, route, input or view changed; discover fresh links." }); } });
        }
    }
    private publish(patch: Partial<DocumentLinksSnapshot> = {}): void {
        const job = this.job, state = { ...this.cell.get(), ...patch }, links = job?.ready ? job.links.slice(state.page * linkLimits.page, (state.page + 1) * linkLimits.page).map((link, i) => {
            const doc = job.sources.get(job.input.document)!.document, line = doc.buffer.lineAt(link.from);
            return { ...link, ordinal: state.page * linkLimits.page + i, line: line + 1, column: link.from - doc.buffer.offsetAt(line) + 1, title: doc.title.slice(0, 128), targetTitle: link.target ? job.sources.get(link.target.document)!.document.title.slice(0, 128) : null };
        }) : [];
        this.cell.set({ ...state, available: !!this.active && this.available(this.active), connected: this.client?.snapshot().connected ?? false, disconnected: this.disconnected,
            pending: !!job && (!job.ready || job.resolving !== undefined), token: job?.input.id ?? null, requestView: job?.origin.id ?? null, count: job?.links.length ?? 0, links, canReturn: !!job?.opened });
    }
    private drop(): void { const client = this.client; this.client = undefined; client?.dispose(); }
    private release(): void {
        const job = this.job; this.job = undefined; if (!job) return; job.invalid = true;
        job.origin.editor.element.ownerDocument.defaultView!.clearTimeout(job.timer); job.stops.splice(0).forEach(stop => stop()); job.capture.cancel(); job.resolveCapture?.cancel(); job.leases.splice(0).forEach(lease => lease.release()); if (!job.ready || job.resolving !== undefined) this.drop();
    }
    readonly cancel = (): void => { if (this.job) this.metrics.cancelled++; this.release(); this.publish({ status: "idle", message: "Module links dismissed.", work: 0, total: 0, page: 0 }); };
    readonly disconnect = (): void => { this.cancel(); this.drop(); this.disconnected = true; this.publish({ message: "Link provider disconnected; local editing remains available." }); };
    readonly reconnect = (): void => { this.cancel(); this.drop(); this.disconnected = false; this.reconnectProvider?.(); this.publish({ message: "Discover fresh links with current resources." }); };
    readonly bindList = (list: HTMLElement | null): void => {
        this.listEvents?.abort(); this.listEvents = undefined; this.list = list ?? undefined; if (!list || this.disposed) return;
        const events = new AbortController(); this.listEvents = events;
        list.addEventListener("keydown", event => { if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return; const origin = this.job?.origin; event.preventDefault(); event.stopPropagation(); this.cancel(); if (origin && this.available(origin)) origin.editor.focus(); }, { signal: events.signal });
    };
    attach(id: string, tab: TabId, editor: TextEditor): () => void {
        const s = { token: this.workspace.allocateIdentity(), id, target: this.workspace.tabs.capture(tab), editor }, events = new AbortController(); this.sessions.set(s.token, s);
        editor.input.addEventListener("focus", () => { if (this.active !== s && this.job?.resolving !== undefined) this.cancel(); this.active = s; this.publish(); }, { signal: events.signal });
        editor.input.addEventListener("keydown", event => {
            if (event.defaultPrevented || event.isComposing || editor.activity().composing || event.key !== "F4" || event.ctrlKey || event.metaKey || event.altKey) return;
            if (event.shiftKey && !this.job?.opened) return; event.preventDefault(); event.stopImmediatePropagation(); this.active = s; if (event.shiftKey) this.returnToOrigin(); else this.start(true);
        }, { capture: true, signal: events.signal });
        for (const event of ["beforeinput", "compositionstart", "paste", "cut"] as const) editor.input.addEventListener(event, () => { if (!this.presenting && this.job?.sources.has(editor.view.documentId)) this.cancel(); }, { signal: events.signal });
        let detached = false; return () => { if (detached) return; detached = true; if (!this.presenting && this.job) this.cancel(); events.abort(); this.sessions.delete(s.token); if (this.active === s) this.active = undefined; if (!this.sessions.size && !this.presenting) this.drop(); this.publish(); };
    }
    readonly discover = (): void => this.start(false);
    private start(keyboard: boolean): void {
        const origin = this.active;
        if (this.disconnected || !origin || !this.available(origin)) { this.publish({ message: "Focus an available source and reconnect first." }); return; }
        if (!this.canCapture(origin.editor.view.documentId)) { this.publish({ message: "Finish pending input, navigation, table conversion or composition first." }); return; }
        this.cancel(); const doc = this.workspace.document(origin.editor.view.documentId), selected = origin.editor.view.getSnapshot(), documents = new Map<string, DocumentSnapshot>([[doc.id, doc]]);
        let input: LinksInput;
        try {
            if (doc.key.variant !== "working") throw new Error("Links require a captured working source.");
            const aliases = [...this.aliases].map(([module, id]) => { const target = this.workspace.document(id); if (!this.canCapture(id) || target.key.variant !== "working") throw new Error("Finish pending target input before discovering links."); documents.set(id, target);
                return { module, resource: target.resourceId, document: id, revision: target.revision, length: target.buffer.length }; });
            input = validateLinksInput({ id: ++this.sequence, resource: doc.resourceId, document: doc.id, revision: doc.revision, length: doc.buffer.length, aliases, delay: this.delay, ...(this.fault ? { fault: this.fault } : {}) });
        } catch (error) { this.fault = undefined; this.publish({ status: "failed", message: error instanceof Error ? error.message : "Invalid link capture." }); return; }
        this.fault = undefined; const targets = new Map<string, Session>(); for (const s of this.sessions.values()) if (this.available(s) && !targets.has(s.editor.view.documentId)) targets.set(s.editor.view.documentId, s); targets.set(doc.id, origin);
        const capture = this.capture(origin);
        if (!capture) { this.publish({ message: "The source changed before capture; discover fresh links." }); return; }
        const job: Job = { origin, input, generation: this.generation, capture,
            sources: new Map([...documents].map(([id, d]) => [id, { document: d, authority: this.authority(d.id) }])), targets, leases: [], stops: [], timer: 0, invalid: false, ready: false, opened: false, links: [] };
        this.job = job; this.metrics.requested++; const win = origin.editor.element.ownerDocument.defaultView!;
        const changed = () => this.changed(job);
        try {
            for (const d of documents.values()) if (d.id !== doc.id) { job.leases.push(this.workspace.acquire(d.resourceId)); job.stops.push(this.workspace.observeDocument(d.id).subscribe(changed), this.workspace.resourceForDocument(d.id).metadata.subscribe(changed)); }
            capture.signal.addEventListener("abort", changed, { once: true });
            job.timer = win.setTimeout(() => { if (this.job === job && !job.ready) { this.release(); this.metrics.failed++; this.publish({ status: "failed", message: "Link provider timed out; source is unchanged." }); } }, 30000);
            this.publish({ status: "pending", message: `Discovering exact module-import links from ${origin.id}.`, work: 0, total: doc.buffer.length, page: 0 });
            const connectionChanged = () => { if (this.client && (!this.client.snapshot().connected && !this.client.snapshot().busy || this.job?.ready && !this.current(this.job))) { this.drop(); this.release(); this.publish({ status: "failed", message: "Link connection or capture changed; discover fresh links." }); } else this.publish(); };
            this.client ??= this.factory(win, connectionChanged);
            void this.client.links(input, doc.buffer, work => { if (this.current(job)) this.publish({ work }); }).then(result => {
                if (!this.current(job)) { changed(); return; }
                // Ready links retain resource ownership but allow view movement between explicit opens.
                job.leases.push(this.workspace.acquire(doc.resourceId));
                job.stops.push(this.workspace.observeDocument(doc.id).subscribe(changed), this.workspace.resourceForDocument(doc.id).metadata.subscribe(changed));
                job.ready = true; job.links = result.links; win.clearTimeout(job.timer); capture.cancel();
                const at = result.links.findIndex(l => l.from <= selected.selection.head && selected.selection.head <= l.to), page = at < 0 ? 0 : Math.floor(at / linkLimits.page);
                this.publish({ status: "ready", message: `${result.links.length} module links; ${result.links.filter(l => !l.target).length} unresolved. Open a captured target explicitly.`, work: input.length, page });
                if (keyboard && this.job === job && this.current(job) && this.list?.isConnected && win.document.activeElement === origin.editor.input) this.list.focus();
            }).catch(error => { if (this.job !== job) return; this.release(); this.drop(); this.metrics.failed++; this.publish({ status: "failed", message: error instanceof Error ? error.message : "Link provider failed; source is unchanged." }); });
        } catch (error) { this.release(); this.drop(); this.metrics.failed++; this.publish({ status: "failed", message: error instanceof Error ? error.message : "Link provider is unavailable." }); }
    }
    private place(job: Job, document: DocumentId, selections: SelectionSet | null): boolean {
        if (!job.ready || job.resolving !== undefined || !this.current(job) || !this.canCapture(document)) { this.publish({ message: "Finish pending input or discover fresh links." }); return false; }
        this.presenting = true;
        try {
            const captured = job.targets.get(document), editor = captured && this.available(captured) ? captured.editor : this.present(document);
            if (!editor || this.job !== job || !this.current(job) || editor.view.documentId !== document) { this.publish({ message: "The captured link destination cannot be presented in an available pane." }); return false; }
            const revision = job.sources.get(document)!.document.revision, applied = selections ? editor.view.setSelections(revision, selections.ranges, selections.primary) : editor.view.setSelection(revision, { anchor: 0, head: 0 });
            if (!applied) return false; job.opened = true; editor.viewport.revealOffset(editor.view.getSnapshot().selection.head); editor.focus(); this.publish(); return true;
        } finally { this.presenting = false; }
    }
    open(token: number | null, ordinal: number): void { const job = this.job; if (!job || token !== job.input.id || !Number.isSafeInteger(ordinal) || job.resolving !== undefined || !this.current(job)) return; const link = job.links[ordinal]; if (!link) return;
        if (!link.target && link.resolvable && this.client?.resolve) {
            const capture = this.capture(job.origin);
            if (!capture) { this.publish({ message: "The source changed before capture; discover fresh links." }); return; }
            job.resolving = ordinal; job.resolveCapture = capture;
            capture.signal.addEventListener("abort", () => this.changed(job), { once: true });
            const owner = job.origin.editor.element.ownerDocument, focused = owner.activeElement;
            // Disabling or replacing a result button can focus the body. A later click on a heading does too.
            let follow = true;
            owner.addEventListener("pointerdown", () => { follow = false; }, { capture: true, once: true, signal: capture.signal });
            this.publish({ status: "resolving", message: "Resolving the captured provider link." });
            void this.client.resolve(link).then(resolved => {
                if (!this.current(job) || job.links[ordinal] !== link) return; job.links = Object.freeze(job.links.map((value, index) => index === ordinal ? resolved : value)); job.resolving = undefined; delete job.resolveCapture; capture.cancel();
                this.publish({ status: "ready", message: resolved.target ? "Resolved a host-authorized destination." : "Provider link target is outside the host's captured resources." });
                if (follow && resolved.target && (owner.activeElement === focused || owner.activeElement === owner.body && (!focused?.isConnected || !!this.list?.contains(focused)))) this.open(token, ordinal);
            }).catch(error => { if (this.job !== job) return; this.release(); this.drop(); this.metrics.failed++; this.publish({ status: "failed", message: error instanceof Error ? error.message : "Link resolution failed; source is unchanged." }); }); return;
        }
        if (!link.target) return;
        if (this.place(job, link.target.document as DocumentId, null)) { this.metrics.opened++; this.publish({ message: `Opened captured module ${link.module}.` }); } }
    readonly returnToOrigin = (): void => { const job = this.job; if (job?.opened && this.place(job, job.input.document as DocumentId, job.capture.selectionSet)) { this.metrics.returned++; this.publish({ message: "Returned to the captured source and complete selection set." }); } };
    readonly nextPage = (): void => { const s = this.cell.get(); if ((s.page + 1) * linkLimits.page < s.count) this.publish({ page: s.page + 1 }); };
    readonly previousPage = (): void => { const s = this.cell.get(); if (s.page) this.publish({ page: s.page - 1 }); };
    setAlias(module: string, document: DocumentId | null): void {
        if (!validDomainModule(module) || document && this.workspace.document(document).key.variant !== "working") throw new Error("Choose a bounded module alias and working resource.");
        if (document === (this.aliases.get(module) ?? null)) return; if (document && !this.aliases.has(module) && this.aliases.size === linkLimits.aliases) throw new Error("Module alias limit reached.");
        this.cancel(); this.generation++; if (document) this.aliases.set(module, document); else this.aliases.delete(module); this.publish({ message: "Host module routes changed; discover fresh links." });
    }
    readonly addCompanion = (): void => { if (this.disposed) return; this.companion ??= this.workspace.createTextResource({ scope: "host-fixture", resource: "module-companion", variant: "working" }, "Module companion", { value: "export const value = 1;\r\n" }).documentId;
        this.setAlias("sample-utils", this.companion); this.publish({ message: "Module companion registered for sample-utils. Discover links in an exact import line." }); };
    setDelay(value: number): void { if (!Number.isFinite(value) || value < 0 || value > 1000) throw new RangeError("Invalid links delay."); this.delay = value; }
    faultNext(value: NonNullable<LinksInput["fault"]>): void { this.fault = value; }
    faultIdle(): boolean { return this.client?.faultIdle?.() ?? false; }
    debug() { const job = this.job; return { ...this.metrics, state: this.cell.get(), capture: job ? { input: job.input, view: job.origin.id, selections: job.capture.selectionSet } : null, companion: this.companion ?? null, aliases: [...this.aliases].map(([module, document]) => ({ module, document })), generation: this.generation, transport: this.client?.snapshot() ?? null, sessions: this.sessions.size, subscriptions: this.cell.count(), disposed: this.disposed }; }
    dispose(): void { if (this.disposed) return; this.cancel(); this.drop(); this.bindList(null); this.aliases.clear(); this.disposed = true; this.active = undefined; this.publish(); }
}
