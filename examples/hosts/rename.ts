import type { DocumentId, DocumentSnapshot, ResourceLease, TabId, TabTarget, TextEdit, Workspace } from "../../src/index.ts";
import type { LspWorkspaceEdit } from "../../src/protocol/index.ts";
import { applyLspWorkspaceEdit, previewLspWorkspaceEdit } from "../../src/protocol/index.ts";
import { captureViewRequest } from "../../src/browser/index.ts";
import type { CapturedViewRequest, EditingCandidate } from "../../src/browser/index.ts";
import { navigationMetrics } from "../shared/language/navigation-service.ts";
import { createRenameBackend } from "../shared/language/rename-backend.ts";
import type { RenameBackend } from "../shared/language/rename-backend.ts";
import { ProviderLane } from "../shared/provider-lane.ts";
import { navigationLimits, navigationSymbol, validateNavigationInput } from "../../fixtures/language/navigation.ts";
import type { NavigationInput, NavigationLocation } from "../../fixtures/language/navigation.ts";
import { renameName, renameSelections, validateRenamePreview } from "../../fixtures/language/rename.ts";
import type { RenameCapture } from "../../fixtures/language/rename.ts";
import type { LspRenameFactory } from "../shared/language/lsp-rename-client.ts";
import { HostCell } from "../shared/observable.ts";

type Session = { token: number; id: string; target: TabTarget; editor: EditingCandidate };
type Job = { origin: Session; capture: RenameCapture; viewCapture: CapturedViewRequest; documents: Map<string, DocumentSnapshot>; authority: Map<string, string>;
    leases: ResourceLease[]; stops: (() => void)[]; timer: number; invalid: boolean; ready: boolean; locations: readonly NavigationLocation[]; workspaceEdit?: LspWorkspaceEdit; name?: string };
export type RenameNote = Readonly<{ ordinal: number; document: string; resource: string; title: string; revision: number; from: number; to: number; line: number; column: number; context: string; before?: string; after?: string }>;
export type RenameSnapshot = Readonly<{ available: boolean; connected: boolean; disconnected: boolean; pending: boolean; status: "idle" | "pending" | "ready" | "expired" | "failed" | "applied";
    message: string; name: string; symbol: string; token: number | null; canApply: boolean; work: number; total: number; count: number; page: number; locations: readonly RenameNote[];
    changes: readonly Readonly<{ document: DocumentId; title: string }>[] }>;
let sessionSerial = 0;
/** Captured provider or lexical previews share host authority guards and atomic workspace history. */
export class HostRenameTools {
    private readonly workspace: Workspace;
    private readonly canCapture: (id: DocumentId) => boolean;
    private readonly present: (id: DocumentId) => EditingCandidate | undefined;
    private readonly sessions = new Map<number, Session>();
    private active: Session | undefined;
    private job: Job | undefined;
    private readonly lane = new ProviderLane<RenameBackend>(backend => this.connectionChanged(backend));
    private readonly backendFactory: LspRenameFactory | undefined;
    readonly usesLsp: boolean;
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
    private readonly cell = new HostCell<RenameSnapshot>({ available: false, connected: false, disconnected: false, pending: false, status: "idle", message: "Focus a source and prepare a rename preview.", name: "", symbol: "", token: null, canApply: false, work: 0, total: 0, count: 0, page: 0, locations: [], changes: [] });
    readonly state = this.cell.observable;
    private readonly reconnectProvider: (() => void) | undefined;
    constructor(workspace: Workspace, canCapture: (id: DocumentId) => boolean, present: (id: DocumentId) => EditingCandidate | undefined, backendFactory?: LspRenameFactory, reconnectProvider?: () => void) { this.reconnectProvider = reconnectProvider;
        this.workspace = workspace; this.canCapture = canCapture; this.present = present; this.backendFactory = backendFactory; this.usesLsp = backendFactory !== undefined;
    }
    private validName(name: string): boolean { return this.usesLsp ? name.length > 0 && name.length <= 256 && !/[\u0000-\u001f\u007f]/.test(name) : renameName(name); }
    private available(s: Session): boolean {
        const tab = this.workspace.resolveTab(s.target);
        return !this.disposed && this.sessions.get(s.token) === s && s.editor.element.isConnected && !s.editor.activity().disposed && this.workspace.ownsDocumentView(s.editor.view)
            && tab?.surface.kind === "text" && tab.surface.documentId === s.editor.view.documentId && !!this.workspace.observeDocument(s.editor.view.documentId).getSnapshot();
    }
    private authority(id: DocumentId): string { const m = this.workspace.resourceForDocument(id).metadata.getSnapshot(); return JSON.stringify([m.state, m.capabilities.edit, m.editLock]); }
    private current(job: Job): boolean {
        if (this.job !== job || job.invalid || job.name !== undefined && job.name !== this.cell.get().name) return false;
        try {
            if (!job.viewCapture.isCurrent() || job.workspaceEdit && !job.workspaceEdit.isCurrent()) return false;
            for (const doc of job.documents.values()) if (doc.id !== job.viewCapture.document.id
                && (this.workspace.observeDocument(doc.id).getSnapshot()?.revision !== doc.revision || this.authority(doc.id) !== job.authority.get(doc.id) || !this.canCapture(doc.id))) return false;
        } catch { return false; }
        return true;
    }
    private editCount(job: Job): number { return job.workspaceEdit?.documents.reduce((count, change) => count + change.edits.length, 0) ?? job.locations.length; }
    private editableTargets(job: Job): boolean {
        const seen = new Set<string>();
        const editable = (id: string) => {
            if (seen.has(id)) return true; seen.add(id);
            const metadata = this.workspace.resourceForDocument(id as DocumentId).metadata.getSnapshot();
            return metadata.capabilities.edit.includes("human") && metadata.capabilities.edit.includes("host") && metadata.editLock === null;
        };
        return job.workspaceEdit ? job.workspaceEdit.documents.every(change => !change.edits.length || editable(change.target.document.documentId))
            : job.locations.every(at => editable(at.document));
    }
    private publish(patch: Partial<RenameSnapshot> = {}): void {
        const state = { ...this.cell.get(), ...patch }, job = this.job;
        const current = !!job?.ready && this.current(job), editable = current && this.editableTargets(job);
        this.cell.set({ ...state, available: !!this.active && this.available(this.active), connected: this.lane.value?.snapshot().connected ?? false, disconnected: this.disconnected,
            pending: !!job && !job.ready, token: job?.capture.input.id ?? null, count: job ? this.editCount(job) : 0,
            message: state.status === "ready" && current && !editable ? "A captured source is read-only or locked; this preview cannot be applied." : state.message,
            canApply: editable && this.validName(state.name) && (this.usesLsp ? this.editCount(job) > 0 : state.name !== job.capture.input.symbol) });
    }
    private changed(job: Job): void {
        if (!this.publishing && this.job === job && !this.current(job)) {
            job.invalid = true;
            queueMicrotask(() => { if (this.job === job) { this.metrics.expired++; this.release(); this.publish({ status: "expired", message: "Captured revision, selection, view or edit authority changed; prepare a fresh preview.", locations: [] }); } });
        }
    }
    private connectionChanged(backend: RenameBackend): void {
        const state = backend.snapshot(), job = this.job;
        if (this.usesLsp) {
            if (!job) return;
            if (job.ready && !state.connected && !state.busy) this.disconnected = true;
            this.changed(job); this.publish();
        } else if (!state.connected && !state.busy) {
            this.lane.drop(); if (job) this.release(); this.publish({ status: "failed", message: "Rename connection failed; prepare a fresh preview.", locations: [] });
        } else this.publish();
    }
    private release(): void {
        const job = this.job; this.job = undefined;
        if (!job) return; job.invalid = true; job.origin.editor.element.ownerDocument.defaultView!.clearTimeout(job.timer);
        job.stops.splice(0).forEach(stop => stop()); job.viewCapture.cancel(); job.leases.splice(0).forEach(lease => lease.release()); if (!job.ready) this.lane.drop(); else this.lane.value?.cancel();
    }
    readonly cancel = (): void => { if (this.job) this.metrics.cancelled++; this.release(); this.publish({ status: "idle", message: "Rename preview dismissed; source is unchanged.", locations: [], work: 0, total: 0, page: 0 }); };
    readonly disconnect = (): void => { this.cancel(); this.lane.drop(); this.disconnected = true; this.publish({ message: "Rename provider disconnected; local editing remains available." }); };
    readonly reconnect = (): void => { this.cancel(); this.lane.drop(); this.disconnected = false; this.reconnectProvider?.(); this.publish({ message: "Prepare a fresh rename preview." }); };
    setName(value: string): void { const name = value.slice(0, 256); if (name === this.cell.get().name) return;
        if (this.usesLsp && this.job) { this.metrics.cancelled++; this.release(); this.publish({ status: "idle", locations: [], work: 0, total: 0, page: 0, message: "Name changed; request a fresh provider preview." }); }
        this.publish({ name }); }
    /** Explicit host ref lifecycle; no component effect owns editor state. */
    readonly bindName = (input: HTMLInputElement | null): void => {
        this.nameEvents?.abort(); this.nameEvents = undefined; this.nameInput = input ?? undefined;
        if (!input || this.disposed) return;
        const events = new AbortController(); this.nameEvents = events;
        input.addEventListener("keydown", event => {
            if (event.defaultPrevented || event.isComposing) return;
            if (this.usesLsp && event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) { event.preventDefault(); this.prepare(); return; }
            const origin = this.job?.origin ?? (this.usesLsp ? this.active : undefined);
            if (event.key !== "Escape" || !origin) return;
            event.preventDefault(); event.stopPropagation(); this.cancel(); if (this.available(origin)) origin.editor.focus();
        }, { signal: events.signal });
    };
    attach(id: string, tab: TabId, editor: EditingCandidate): () => void {
        const s: Session = { token: ++sessionSerial, id, target: this.workspace.captureTab(tab), editor }, events = new AbortController(); this.sessions.set(s.token, s);
        editor.input.addEventListener("focus", () => { this.active = s; this.publish(); }, { signal: events.signal });
        editor.input.addEventListener("keydown", event => {
            if (event.defaultPrevented || event.isComposing || editor.activity().composing) return;
            if (event.key === "F2" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) { event.preventDefault(); event.stopImmediatePropagation(); this.active = s; this.start(true); }
        }, { capture: true, signal: events.signal });
        for (const event of ["beforeinput", "compositionstart", "paste", "cut"] as const) editor.input.addEventListener(event, () => { if (this.job?.documents.has(editor.view.documentId)) this.cancel(); }, { signal: events.signal });
        let detached = false;
        return () => { if (detached) return; detached = true; if (this.job?.origin === s) this.cancel(); events.abort(); this.sessions.delete(s.token); if (this.active === s) this.active = undefined; if (!this.sessions.size) this.lane.drop(); this.publish(); };
    }
    readonly prepare = (): void => this.start(false);
    /** A host command names the mounted source explicitly, including after an async mount. */
    begin(id: string): void {
        const source = [...this.sessions.values()].find(session => session.id === id);
        if (!source) return; this.active = source; this.start(true);
    }
    private start(keyboard: boolean): void {
        const origin = this.active;
        if (this.disconnected || !origin || !this.available(origin)) { this.publish({ message: "Focus an available source and reconnect first." }); return; }
        const documents = this.workspace.getSnapshot().documents.filter(d => d.key.variant === "working");
        if (documents.some(d => !this.canCapture(d.id))) { this.publish({ message: "Finish pending input, navigation, table conversion or composition first." }); return; }
        this.cancel(); const selected = origin.editor.view.getSnapshot(), doc = this.workspace.document(origin.editor.view.documentId), hint = navigationSymbol(doc.buffer, selected.selection.head), symbol = this.usesLsp ? hint ?? "position" : hint;
        if (!symbol || !this.usesLsp && !renameName(symbol) || !documents.some(d => d.id === doc.id)) { this.publish({ status: "failed", message: "No supported identifier at the captured position." }); return; }
        if (this.usesLsp && (keyboard || !this.validName(this.cell.get().name))) {
            this.publish({ name: hint ?? "", symbol, message: "Enter the new name, then prepare its provider edit preview." });
            this.nameInput?.focus(); this.nameInput?.select(); return;
        }
        let input: NavigationInput;
        try { input = validateNavigationInput({ operation: "navigation-start", id: ++this.serial, kind: "references", includeDeclaration: true, symbol: this.usesLsp ? "position" : symbol, documents: documents.map(d => ({ document: d.id, revision: d.revision, length: d.buffer.length })), delay: this.delay, ...(this.fault ? { fault: this.fault } : {}) }); }
        catch (error) { this.fault = undefined; this.publish({ status: "failed", message: error instanceof Error ? error.message : "Invalid rename capture." }); return; }
        this.fault = undefined;
        const authority = new Map(documents.filter(d => d.id !== doc.id).map(d => [d.id, this.authority(d.id)]));
        const viewCapture = captureViewRequest(this.workspace, origin.target, origin.editor.view, { available: () => this.available(origin) && this.canCapture(origin.editor.view.documentId) });
        if (!viewCapture) { this.publish({ message: "The source changed before capture; prepare a fresh rename preview." }); return; }
        const job: Job = { origin, capture: { input, document: doc.id, offset: selected.selection.head }, viewCapture,
            documents: new Map(documents.map(d => [d.id, d])), authority, leases: [], stops: [], timer: 0, invalid: false, ready: false, locations: [], ...(this.usesLsp ? { name: this.cell.get().name } : {}) };
        this.job = job; this.metrics.requested++; const win = origin.editor.element.ownerDocument.defaultView!, total = input.documents.reduce((n, d) => n + d.length, 0);
        try {
            const changed = () => this.changed(job);
            viewCapture.signal.addEventListener("abort", changed, { once: true });
            for (const d of documents) if (d.id !== viewCapture.document.id) { job.leases.push(this.workspace.acquire(d.resourceId)); job.stops.push(this.workspace.observeDocument(d.id).subscribe(changed), this.workspace.resourceForDocument(d.id).metadata.subscribe(changed)); }
            job.timer = win.setTimeout(() => { if (this.job === job && !job.ready) { this.release(); this.metrics.failed++; this.publish({ status: "failed", message: "Rename provider timed out; source is unchanged.", locations: [] }); } }, 30000);
            this.publish({ status: "pending", message: this.usesLsp ? "Requesting the provider's complete rename edit preview." : `Preparing all lexical matches of ${symbol} across ${documents.length} captured working resources.`, symbol, ...(keyboard ? { name: symbol } : {}), locations: [], page: 0, work: 0, total });
            const backend = this.lane.acquire(notify => createRenameBackend(win, this.worker, this.backendFactory, notify));
            void backend.run({ documents, capture: job.capture, name: job.name ?? this.cell.get().name,
                progress: work => { if (this.current(job)) this.publish({ work }); } }).then(result => {
                if (result.kind === "workspace") job.workspaceEdit = result.edit;
                if (!this.current(job)) { changed(); return; }
                if (result.kind === "workspace") {
                    // The provider client may have retained additional host-resolved targets.
                    // Capture those exact workspace identities before presentation or application.
                    for (const change of result.edit.documents) {
                        const target = change.target.document; if (job.documents.has(target.documentId)) continue;
                        const document = this.workspace.getSnapshot().documents.find(document => document.id === target.documentId);
                        if (!document || document.resourceId !== target.resourceId || document.revision !== target.revision || document.buffer !== target.buffer
                            || !change.target.isCurrent() || !this.canCapture(document.id)) throw new Error("A resolved rename target changed.");
                        job.documents.set(document.id, document); job.authority.set(document.id, this.authority(document.id));
                        job.stops.push(this.workspace.observeDocument(document.id).subscribe(changed), this.workspace.resourceForDocument(document.id).metadata.subscribe(changed));
                    }
                } else job.locations = validateRenamePreview(result.result, job.capture, new Map(documents.map(d => [d.id, d.buffer]))).locations;
                job.ready = true; win.clearTimeout(job.timer); this.showPage(0);
                this.publish({ status: "ready", message: result.kind === "workspace"
                    ? `Preview ${this.editCount(job)} provider edits for this new name. Review the captured targets before applying.`
                    : `Preview ${job.locations.length} lexical token replacements across captured resources. Review every target before applying; scopes and types are not resolved.`, work: total });
            }).catch(error => { if (this.job !== job) return; this.release(); this.lane.drop(); this.metrics.failed++; this.publish({ status: "failed", message: error instanceof Error ? error.message : "Rename provider failed; source is unchanged.", locations: [] }); });
            if (!this.usesLsp && keyboard && this.nameInput && this.current(job)) { this.nameInput.value = symbol; this.nameInput.focus(); this.nameInput.select(); }
        } catch (error) { this.release(); this.lane.drop(); this.metrics.failed++; this.publish({ status: "failed", message: error instanceof Error ? error.message : "Rename unavailable.", locations: [] }); }
    }
    private showPage(page: number): void {
        const job = this.job; if (!job?.ready || page < 0 || page * navigationLimits.page >= this.editCount(job)) return;
        const entries = job.workspaceEdit ? previewLspWorkspaceEdit(job.workspaceEdit, id => job.documents.get(id)!.title, page).notes.map(({ insert, insertUnits, ...note }) => ({ ...note,
            before: note.before + (note.to - note.from > 256 ? ` (${note.to - note.from} UTF-16 units)` : ""),
            after: insert + (insertUnits > insert.length ? `… (${insertUnits} UTF-16 units)` : "") }))
            : job.locations.slice(page * navigationLimits.page, (page + 1) * navigationLimits.page).map(at => {
                const doc = job.documents.get(at.document)!;
                return { ...at, resource: doc.resourceId, title: doc.title.slice(0, 128), context: doc.buffer.slice(Math.max(0, at.from - 32), Math.min(doc.buffer.length, at.to + 32)) };
            });
        const locations = entries.map((at, index) => {
            const doc = job.documents.get(at.document)!, line = doc.buffer.lineAt(at.from);
            return Object.freeze({ ...at, ordinal: page * navigationLimits.page + index, line, column: at.from - doc.buffer.offsetAt(line) });
        }); this.publish({ page, locations: Object.freeze(locations) });
    }
    readonly nextPage = (): void => this.showPage(this.cell.get().page + 1);
    readonly previousPage = (): void => this.showPage(this.cell.get().page - 1);
    apply(token: number | null): void {
        const job = this.job, name = this.cell.get().name;
        if (!job?.ready || token !== job.capture.input.id || !this.current(job) || !this.validName(name) || !this.editCount(job) || !this.usesLsp && name === job.capture.input.symbol) { this.publish({ message: "Use a fresh complete preview and a valid new name." }); return; }
        if (!this.editableTargets(job)) { this.publish(); return; }
        this.publishing = true;
        try {
            let documents: readonly DocumentSnapshot[] = [];
            if (!job.viewCapture.commit(() => {
                if (job.workspaceEdit) documents = applyLspWorkspaceEdit(this.workspace, job.workspaceEdit, { origin: "host", requiredOrigins: ["human"], view: job.origin.editor.view });
                else {
                    const edits = new Map<string, TextEdit[]>();
                    for (const at of job.locations) { let batch = edits.get(at.document); if (!batch) { batch = []; edits.set(at.document, batch); } batch.push({ from: at.from, to: at.to, insert: name }); }
                    for (const id of edits.keys()) {
                        const doc = job.documents.get(id)!, m = this.workspace.resourceForDocument(doc.id).metadata.getSnapshot();
                        if (!m.capabilities.edit.includes("human") || !m.capabilities.edit.includes("host") || m.editLock !== null) throw new Error("Every rename target must permit human and host editing without a lock.");
                    }
                    const result = this.workspace.editDocuments([...edits].map(([id, batch]) => ({ documentId: job.documents.get(id)!.id, expectedRevision: job.documents.get(id)!.revision, edits: batch,
                        origin: "host" as const, history: { kind: "replace" as const }, ...(id === job.origin.editor.view.documentId ? { view: job.origin.editor.view,
                            selectionSet: renameSelections(job.documents.get(id)!.buffer.length, job.viewCapture.selectionSet, batch) } : {}) })));
                    if (!result.applied) throw new Error(result.reason);
                    documents = [...edits.keys()].map(id => job.documents.get(id)!);
                }
                return true;
            })) throw new Error("Captured rename context changed before application.");
            const changes = documents.map(doc => ({ document: doc.id, title: doc.title.slice(0, 128) }));
            this.metrics.applied++; this.release(); this.publish({ status: "applied", message: job.workspaceEdit ? `Applied ${this.editCount(job)} captured provider edits in ${changes.length} resources as one undo command.` : `Renamed ${job.locations.length} captured tokens in ${changes.length} resources as one undo command.`, changes, locations: [] });
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
    faultIdle(): boolean { return this.lane.value?.faultIdle() ?? false; }
    debug() { const job = this.job; return { ...this.metrics, worker: { ...this.worker }, state: this.cell.get(), capture: job ? { view: job.origin.id, document: job.capture.document, revision: job.documents.get(job.capture.document)!.revision, selections: job.viewCapture.selectionSet } : null, transport: this.lane.value?.snapshot() ?? null, sessions: this.sessions.size, subscriptions: this.cell.count(), disposed: this.disposed }; }
    dispose(): void { if (this.disposed) return; this.cancel(); this.lane.dispose(); this.bindName(null); this.disposed = true; this.active = undefined; this.publish({ changes: [] }); }
}
