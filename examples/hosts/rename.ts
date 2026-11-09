import type { DocumentId, DocumentSnapshot, ResourceLease, SelectionSet, TabId, TabTarget, Workspace } from "../../src/index.ts";
import type { EditingCandidate } from "../../src/browser/index.ts";
import { createNavigationClient, navigationMetrics } from "../editing/navigation-client.ts";
import { navigationLimits, navigationSymbol, validateNavigationInput } from "../probes/navigation.ts";
import type { NavigationInput, NavigationLocation } from "../probes/navigation.ts";
import { renameName, renameSelections, validateRenamePreview } from "../probes/rename.ts";
import type { RenameCapture } from "../probes/rename.ts";
import { HostCell } from "../shared/observable.ts";

type Session = { token: number; id: string; target: TabTarget; editor: EditingCandidate };
type Job = { origin: Session; capture: RenameCapture; selections: SelectionSet; folds: number; documents: Map<string, DocumentSnapshot>; authority: Map<string, string>;
    leases: ResourceLease[]; stops: (() => void)[]; timer: number; invalid: boolean; ready: boolean; locations: readonly NavigationLocation[] };
export type RenameNote = Readonly<{ document: string; resource: string; title: string; revision: number; from: number; to: number; line: number; column: number; context: string }>;
export type RenameSnapshot = Readonly<{ available: boolean; connected: boolean; disconnected: boolean; pending: boolean; status: "idle" | "pending" | "ready" | "expired" | "failed" | "applied";
    message: string; name: string; symbol: string; token: number | null; canApply: boolean; work: number; total: number; count: number; page: number; locations: readonly RenameNote[];
    changes: readonly Readonly<{ document: DocumentId; title: string }>[] }>;
let sessionSerial = 0;
/** Captured lexical preview; existing worker transport and atomic workspace history own the work. */
export class HostRenameTools {
    private readonly workspace: Workspace;
    private readonly canCapture: (id: DocumentId) => boolean;
    private readonly present: (id: DocumentId) => EditingCandidate | undefined;
    private readonly sessions = new Map<number, Session>();
    private active: Session | undefined;
    private job: Job | undefined;
    private client: ReturnType<typeof createNavigationClient> | undefined;
    private disposed = false;
    private disconnected = false;
    private publishing = false;
    private nameInput: HTMLInputElement | undefined;
    private nameEvents: AbortController | undefined;
    private serial = 0;
    private delay = 0;
    private fault: NavigationInput["fault"];
    private readonly worker = navigationMetrics();
    private readonly metrics = { requested: 0, applied: 0, expired: 0, failed: 0, cancelled: 0 };
    private readonly cell = new HostCell<RenameSnapshot>({ available: false, connected: false, disconnected: false, pending: false, status: "idle", message: "Focus a source and prepare a lexical rename preview.", name: "", symbol: "", token: null, canApply: false, work: 0, total: 0, count: 0, page: 0, locations: [], changes: [] });
    readonly state = this.cell.observable;
    constructor(workspace: Workspace, canCapture: (id: DocumentId) => boolean, present: (id: DocumentId) => EditingCandidate | undefined) { this.workspace = workspace; this.canCapture = canCapture; this.present = present; }
    private available(s: Session): boolean {
        const tab = this.workspace.resolveTab(s.target);
        return !this.disposed && this.sessions.get(s.token) === s && s.editor.element.isConnected && !s.editor.snapshot().disposed && this.workspace.ownsDocumentView(s.editor.view)
            && tab?.surface.kind === "text" && tab.surface.documentId === s.editor.view.documentId && !!this.workspace.observeDocument(s.editor.view.documentId).getSnapshot();
    }
    private authority(id: DocumentId): string { const m = this.workspace.resourceForDocument(id).metadata.getSnapshot(); return JSON.stringify([m.state, m.capabilities.edit, m.editLock]); }
    private current(job: Job): boolean {
        if (this.job !== job || job.invalid || !this.available(job.origin) || job.origin.editor.view.getSnapshot().selectionSet !== job.selections
            || job.origin.editor.view.folding.getSnapshot().generation !== job.folds) return false;
        try { for (const doc of job.documents.values()) if (this.workspace.observeDocument(doc.id).getSnapshot()?.revision !== doc.revision || this.authority(doc.id) !== job.authority.get(doc.id) || !this.canCapture(doc.id)) return false; } catch { return false; }
        return true;
    }
    private publish(patch: Partial<RenameSnapshot> = {}): void {
        const state = { ...this.cell.get(), ...patch }, job = this.job;
        this.cell.set({ ...state, available: !!this.active && this.available(this.active), connected: this.client?.snapshot().connected ?? false, disconnected: this.disconnected,
            pending: !!job && !job.ready, token: job?.capture.input.id ?? null, count: job?.locations.length ?? 0,
            canApply: !!job?.ready && this.current(job) && renameName(state.name) && state.name !== job.capture.input.symbol });
    }
    private drop(): void { const client = this.client; this.client = undefined; client?.dispose(); }
    private release(): void {
        const job = this.job; this.job = undefined;
        if (!job) return; job.invalid = true; job.origin.editor.element.ownerDocument.defaultView!.clearTimeout(job.timer);
        job.stops.splice(0).forEach(stop => stop()); job.leases.splice(0).forEach(lease => lease.release()); if (!job.ready) this.drop();
    }
    readonly cancel = (): void => { if (this.job) this.metrics.cancelled++; this.release(); this.publish({ status: "idle", message: "Rename preview dismissed; source is unchanged.", locations: [], work: 0, total: 0, page: 0 }); };
    readonly disconnect = (): void => { this.cancel(); this.drop(); this.disconnected = true; this.publish({ message: "Rename provider disconnected; local editing remains available." }); };
    readonly reconnect = (): void => { this.cancel(); this.drop(); this.disconnected = false; this.publish({ message: "Prepare a fresh rename preview to reconnect." }); };
    setName(value: string): void { this.publish({ name: value.slice(0, 256) }); }
    /** Explicit host ref lifecycle; no component effect owns editor state. */
    readonly bindName = (input: HTMLInputElement | null): void => {
        this.nameEvents?.abort(); this.nameEvents = undefined; this.nameInput = input ?? undefined;
        if (!input || this.disposed) return;
        const events = new AbortController(); this.nameEvents = events;
        input.addEventListener("keydown", event => {
            if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || !this.job) return;
            event.preventDefault(); event.stopPropagation(); const origin = this.job.origin; this.cancel(); if (this.available(origin)) origin.editor.focus();
        }, { signal: events.signal });
    };
    attach(id: string, tab: TabId, editor: EditingCandidate): () => void {
        const s: Session = { token: ++sessionSerial, id, target: this.workspace.captureTab(tab), editor }, events = new AbortController(); this.sessions.set(s.token, s);
        editor.input.addEventListener("focus", () => { this.active = s; this.publish(); }, { signal: events.signal });
        editor.input.addEventListener("keydown", event => {
            if (event.defaultPrevented || event.isComposing || editor.snapshot().composing) return;
            if (event.key === "F2" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) { event.preventDefault(); event.stopImmediatePropagation(); this.active = s; this.start(true); }
        }, { capture: true, signal: events.signal });
        for (const event of ["beforeinput", "compositionstart", "paste", "cut"] as const) editor.input.addEventListener(event, () => { if (this.job?.documents.has(editor.view.documentId)) this.cancel(); }, { signal: events.signal });
        let detached = false;
        return () => { if (detached) return; detached = true; if (this.job?.origin === s) this.cancel(); events.abort(); this.sessions.delete(s.token); if (this.active === s) this.active = undefined; if (!this.sessions.size) this.drop(); this.publish(); };
    }
    readonly prepare = (): void => this.start(false);
    private start(keyboard: boolean): void {
        const origin = this.active;
        if (this.disconnected || !origin || !this.available(origin)) { this.publish({ message: "Focus an available source and reconnect first." }); return; }
        const documents = this.workspace.getSnapshot().documents.filter(d => d.key.variant === "working");
        if (documents.some(d => !this.canCapture(d.id))) { this.publish({ message: "Finish pending input, navigation, table conversion or composition first." }); return; }
        this.cancel(); const selected = origin.editor.view.getSnapshot(), doc = this.workspace.document(origin.editor.view.documentId), symbol = navigationSymbol(doc.buffer, selected.selection.head);
        if (!symbol || !renameName(symbol) || !documents.some(d => d.id === doc.id)) { this.publish({ status: "failed", message: "No supported identifier at the captured position." }); return; }
        let input: NavigationInput;
        try { input = validateNavigationInput({ operation: "navigation-start", id: ++this.serial, kind: "references", includeDeclaration: true, symbol, documents: documents.map(d => ({ document: d.id, revision: d.revision, length: d.buffer.length })), delay: this.delay, ...(this.fault ? { fault: this.fault } : {}) }); }
        catch (error) { this.fault = undefined; this.publish({ status: "failed", message: error instanceof Error ? error.message : "Invalid rename capture." }); return; }
        this.fault = undefined;
        const job: Job = { origin, capture: { input, document: doc.id, offset: selected.selection.head }, selections: selected.selectionSet, folds: origin.editor.view.folding.getSnapshot().generation,
            documents: new Map(documents.map(d => [d.id, d])), authority: new Map(documents.map(d => [d.id, this.authority(d.id)])), leases: [], stops: [], timer: 0, invalid: false, ready: false, locations: [] };
        this.job = job; this.metrics.requested++; const win = origin.editor.element.ownerDocument.defaultView!, total = input.documents.reduce((n, d) => n + d.length, 0);
        try {
            const changed = () => { if (!this.publishing && this.job === job && !this.current(job)) { job.invalid = true; queueMicrotask(() => { if (this.job === job) { this.metrics.expired++; this.release(); this.publish({ status: "expired", message: "Captured revision, selection, view or edit authority changed; prepare a fresh preview.", locations: [] }); } }); } };
            for (const d of documents) { job.leases.push(this.workspace.acquire(d.resourceId)); job.stops.push(this.workspace.observeDocument(d.id).subscribe(changed), this.workspace.resourceForDocument(d.id).metadata.subscribe(changed)); }
            job.stops.push(origin.editor.view.subscribe(changed), origin.editor.view.folding.subscribe(changed), this.workspace.tabState.subscribe(changed));
            job.timer = win.setTimeout(() => { if (this.job === job && !job.ready) { this.release(); this.metrics.failed++; this.publish({ status: "failed", message: "Rename provider timed out; source is unchanged.", locations: [] }); } }, 30000);
            this.publish({ status: "pending", message: `Preparing all lexical matches of ${symbol} across ${documents.length} captured working resources.`, symbol, ...(keyboard ? { name: symbol } : {}), locations: [], page: 0, work: 0, total });
            this.client ??= createNavigationClient(win, this.worker, undefined, () => {
                if (this.client && !this.client.snapshot().connected && !this.client.snapshot().busy) { this.drop(); if (this.job) this.release(); this.publish({ status: "failed", message: "Rename connection failed; prepare a fresh preview.", locations: [] }); } else this.publish();
            });
            const buffers = new Map(documents.map(d => [d.id, d.buffer]));
            void this.client.run(input, buffers, work => { if (this.current(job)) this.publish({ work }); }).then(value => {
                if (!this.current(job)) { changed(); return; }
                const result = validateRenamePreview(value, job.capture, buffers); job.locations = result.locations; job.ready = true; win.clearTimeout(job.timer);
                this.showPage(0); this.publish({ status: "ready", message: `Preview ${result.locations.length} lexical token replacements across captured resources. Review every target before applying; scopes and types are not resolved.`, work: total });
            }).catch(error => { if (this.job !== job) return; this.release(); this.drop(); this.metrics.failed++; this.publish({ status: "failed", message: error instanceof Error ? error.message : "Rename provider failed; source is unchanged.", locations: [] }); });
            if (keyboard && this.nameInput && this.current(job)) { this.nameInput.value = symbol; this.nameInput.focus(); this.nameInput.select(); }
        } catch (error) { this.release(); this.drop(); this.metrics.failed++; this.publish({ status: "failed", message: error instanceof Error ? error.message : "Rename unavailable.", locations: [] }); }
    }
    private showPage(page: number): void {
        const job = this.job; if (!job?.ready || page < 0 || page * navigationLimits.page >= job.locations.length) return;
        const locations = job.locations.slice(page * navigationLimits.page, (page + 1) * navigationLimits.page).map(at => {
            const doc = job.documents.get(at.document)!, line = doc.buffer.lineAt(at.from);
            return Object.freeze({ ...at, resource: doc.resourceId, title: doc.title.slice(0, 128), line, column: at.from - doc.buffer.offsetAt(line),
                context: doc.buffer.slice(Math.max(0, at.from - 32), Math.min(doc.buffer.length, at.to + 32)) });
        }); this.publish({ page, locations: Object.freeze(locations) });
    }
    readonly nextPage = (): void => this.showPage(this.cell.get().page + 1);
    readonly previousPage = (): void => this.showPage(this.cell.get().page - 1);
    apply(token: number | null): void {
        const job = this.job, name = this.cell.get().name;
        if (!job?.ready || token !== job.capture.input.id || !this.current(job) || !renameName(name) || name === job.capture.input.symbol) { this.publish({ message: "Use a fresh complete preview and a different valid identifier." }); return; }
        try {
            const edits = new Map<string, { from: number; to: number; insert: string }[]>();
            for (const at of job.locations) {
                const doc = job.documents.get(at.document)!, m = this.workspace.resourceForDocument(doc.id).metadata.getSnapshot();
                if (!m.capabilities.edit.includes("human") || !m.capabilities.edit.includes("host") || m.editLock !== null) throw new Error("Every rename target must permit human and host editing without a lock.");
                let batch = edits.get(at.document); if (!batch) { batch = []; edits.set(at.document, batch); } batch.push({ from: at.from, to: at.to, insert: name });
            }
            this.publishing = true;
            const result = this.workspace.editDocuments([...edits].map(([id, batch]) => ({ documentId: job.documents.get(id)!.id, expectedRevision: job.documents.get(id)!.revision, edits: batch,
                origin: "host" as const, history: { kind: "replace" as const }, ...(id === job.origin.editor.view.documentId ? { view: job.origin.editor.view,
                    selectionSet: renameSelections(job.documents.get(id)!.buffer.length, job.selections, batch) } : {}) })));
            if (!result.applied) throw new Error(result.reason);
            const changes = [...edits.keys()].map(id => ({ document: job.documents.get(id)!.id, title: job.documents.get(id)!.title.slice(0, 128) }));
            this.metrics.applied++; this.release(); this.publish({ status: "applied", message: `Renamed ${job.locations.length} captured tokens in ${changes.length} resources as one undo command.`, changes, locations: [] });
        } catch (error) { this.release(); this.publish({ status: "failed", message: error instanceof Error ? error.message : "Rename rejected; source is unchanged.", locations: [] }); }
        finally { this.publishing = false; }
    }
    openChanged(document: DocumentId): void {
        if (this.job || this.disposed || !this.cell.get().changes.some(c => c.document === document) || !this.canCapture(document)) return;
        try { const editor = [...this.sessions.values()].find(s => s.editor.view.documentId === document && this.available(s))?.editor ?? this.present(document); editor?.focus(); }
        catch { this.publish({ message: "The captured changed resource is no longer available." }); }
    }
    setDelay(value: number): void { if (!Number.isFinite(value) || value < 0 || value > 1000) throw new RangeError("Invalid rename delay."); this.delay = value; }
    faultNext(value: NonNullable<NavigationInput["fault"]>): void { this.fault = value; }
    faultIdle(): boolean { return this.client?.faultIdle() ?? false; }
    debug() { const job = this.job; return { ...this.metrics, worker: { ...this.worker }, state: this.cell.get(), capture: job ? { view: job.origin.id, document: job.capture.document, revision: job.documents.get(job.capture.document)!.revision, selections: job.selections } : null, transport: this.client?.snapshot() ?? null, sessions: this.sessions.size, subscriptions: this.cell.count(), disposed: this.disposed }; }
    dispose(): void { if (this.disposed) return; this.cancel(); this.drop(); this.bindName(null); this.disposed = true; this.active = undefined; this.publish({ changes: [] }); }
}
