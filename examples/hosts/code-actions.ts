import type { DocumentId, DocumentSnapshot, ResourceLease, SelectionSet, TabId, TabTarget, Workspace } from "../../src/index.ts";
import type { EditingCandidate } from "../../src/browser/index.ts";
import { createNavigationClient, navigationMetrics } from "../editing/navigation-client.ts";
import { validateActionInput } from "../probes/actions.ts";
import type { ActionInput, ActionResult } from "../probes/actions.ts";
import { HostCell } from "../shared/observable.ts";
type Session = { token: number; id: string; target: TabTarget; editor: EditingCandidate };
type Job = { origin: Session; input: ActionInput; document: DocumentSnapshot; selections: SelectionSet; folds: number; authority: string; lease: ResourceLease;
    stops: (() => void)[]; timer: number; invalid: boolean; result: ActionResult | undefined };
export type ActionNote = Readonly<{ document: string; resource: string; title: string; revision: number; from: number; to: number; insert: string; context: string }>;
export type ActionsSnapshot = Readonly<{ available: boolean; connected: boolean; disconnected: boolean; pending: boolean; canApply: boolean; token: number | null; module: string;
    status: "idle" | "pending" | "ready" | "expired" | "failed" | "applied"; message: string; title: string; disabled: string | null; work: number; total: number;
    edits: readonly ActionNote[]; changed: Readonly<{ document: DocumentId; title: string }> | null }>;
let serial = 0;
/** Host-owned edit-bearing action. No provider command can execute without explicit confirmation. */
export class HostActionsTools {
    private readonly workspace: Workspace;
    private readonly canCapture: (id: DocumentId) => boolean;
    private readonly present: (id: DocumentId) => EditingCandidate | undefined;
    private readonly sessions = new Map<number, Session>();
    private active: Session | undefined;
    private job: Job | undefined;
    private client: ReturnType<typeof createNavigationClient> | undefined;
    private moduleInput: HTMLInputElement | undefined;
    private moduleEvents: AbortController | undefined;
    private sequence = 0;
    private disposed = false;
    private disconnected = false;
    private publishing = false;
    private delay = 0;
    private fault: ActionInput["fault"];
    private readonly worker = navigationMetrics();
    private readonly metrics = { requested: 0, applied: 0, cancelled: 0, expired: 0, failed: 0 };
    private readonly cell = new HostCell<ActionsSnapshot>({ available: false, connected: false, disconnected: false, pending: false, canApply: false, token: null, module: "sample-utils", status: "idle", message: "Focus a candidate source to preview a module-import action.", title: "", disabled: null, work: 0, total: 0, edits: [], changed: null });
    readonly state = this.cell.observable;
    constructor(workspace: Workspace, canCapture: (id: DocumentId) => boolean, present: (id: DocumentId) => EditingCandidate | undefined) { this.workspace = workspace; this.canCapture = canCapture; this.present = present; }
    private available(s: Session): boolean {
        const tab = this.workspace.resolveTab(s.target);
        return !this.disposed && this.sessions.get(s.token) === s && s.editor.element.isConnected && !s.editor.snapshot().disposed && this.workspace.ownsDocumentView(s.editor.view)
            && tab?.surface.kind === "text" && tab.surface.documentId === s.editor.view.documentId && !!this.workspace.observeDocument(s.editor.view.documentId).getSnapshot();
    }
    private authority(id: DocumentId): string { const m = this.workspace.resourceForDocument(id).metadata.getSnapshot(); return JSON.stringify([m.state, m.capabilities.edit, m.editLock]); }
    private editable(id: DocumentId): boolean { const m = this.workspace.resourceForDocument(id).metadata.getSnapshot(); return m.capabilities.edit.includes("human") && m.capabilities.edit.includes("host") && m.editLock === null; }
    private current(job: Job): boolean {
        return this.job === job && !job.invalid && this.available(job.origin) && job.input.module === this.cell.get().module && this.canCapture(job.document.id)
            && this.workspace.observeDocument(job.document.id).getSnapshot()?.revision === job.document.revision && this.authority(job.document.id) === job.authority
            && job.origin.editor.view.getSnapshot().selectionSet === job.selections && job.origin.editor.view.folding.getSnapshot().generation === job.folds;
    }
    private publish(patch: Partial<ActionsSnapshot> = {}): void {
        const job = this.job; this.cell.set({ ...this.cell.get(), ...patch, available: !!this.active && this.available(this.active), connected: this.client?.snapshot().connected ?? false,
            disconnected: this.disconnected, token: job?.input.id ?? null, pending: !!job && !job.result,
            canApply: !!job?.result && !job.result.action.disabled && this.current(job) && this.editable(job.document.id) });
    }
    private drop(): void { const client = this.client; this.client = undefined; client?.dispose(); }
    private release(): void {
        const job = this.job; this.job = undefined; if (!job) return; job.invalid = true;
        job.origin.editor.element.ownerDocument.defaultView!.clearTimeout(job.timer); job.stops.splice(0).forEach(stop => stop()); job.lease.release(); if (!job.result) this.drop();
    }
    readonly cancel = (): void => { if (this.job) this.metrics.cancelled++; this.release(); this.publish({ status: "idle", message: "Action preview dismissed; source is unchanged.", edits: [], title: "", disabled: null, work: 0, total: 0 }); };
    readonly disconnect = (): void => { this.cancel(); this.drop(); this.disconnected = true; this.publish({ message: "Action provider disconnected; local editing remains available." }); };
    readonly reconnect = (): void => { this.cancel(); this.drop(); this.disconnected = false; this.publish({ message: "Preview a fresh action to reconnect with current source." }); };
    setModule(value: string): void { if (value === this.cell.get().module) return; if (this.job) this.metrics.cancelled++; this.release(); this.publish({ module: value.slice(0, 65), status: "idle", message: "Module changed; preview a fresh action.", title: "", disabled: null, edits: [], work: 0, total: 0 }); }
    readonly bindModule = (input: HTMLInputElement | null): void => {
        this.moduleEvents?.abort(); this.moduleEvents = undefined; this.moduleInput = input ?? undefined; if (!input || this.disposed) return;
        const events = new AbortController(); this.moduleEvents = events;
        input.addEventListener("keydown", event => {
            if (event.defaultPrevented || event.isComposing) return;
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); const origin = this.job?.origin ?? this.active; this.cancel(); if (origin && this.available(origin)) origin.editor.focus(); }
            else if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) { event.preventDefault(); this.request(); }
        }, { signal: events.signal });
    };
    attach(id: string, tab: TabId, editor: EditingCandidate): () => void {
        const s = { token: ++serial, id, target: this.workspace.captureTab(tab), editor }, events = new AbortController(); this.sessions.set(s.token, s);
        editor.input.addEventListener("focus", () => { this.active = s; this.publish(); }, { signal: events.signal });
        editor.input.addEventListener("keydown", event => {
            if (!event.defaultPrevented && !event.isComposing && !editor.snapshot().composing && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key === ".") {
                event.preventDefault(); event.stopImmediatePropagation(); this.active = s; this.start(true);
            }
        }, { capture: true, signal: events.signal });
        for (const event of ["beforeinput", "compositionstart", "paste", "cut"] as const) editor.input.addEventListener(event, () => { if (this.job?.document.id === editor.view.documentId) this.cancel(); }, { signal: events.signal });
        let detached = false; return () => { if (detached) return; detached = true; if (this.job?.origin === s) this.cancel(); events.abort(); this.sessions.delete(s.token); if (this.active === s) this.active = undefined; if (!this.sessions.size) this.drop(); this.publish(); };
    }
    readonly request = (): void => this.start(false);
    private start(keyboard: boolean): void {
        const origin = this.active, module = this.cell.get().module;
        if (this.disconnected || !origin || !this.available(origin)) { this.publish({ message: "Focus an available source and reconnect first." }); return; }
        if (!this.canCapture(origin.editor.view.documentId)) { this.publish({ message: "Finish pending input, navigation, table conversion or composition first." }); return; }
        this.cancel(); const doc = this.workspace.document(origin.editor.view.documentId), selected = origin.editor.view.getSnapshot();
        if (doc.key.variant !== "working") { this.publish({ status: "failed", message: "Only a working source can receive an action." }); return; }
        let input: ActionInput;
        try { input = validateActionInput({ operation: "action-start", id: ++this.sequence, document: doc.id, revision: doc.revision, length: doc.buffer.length, from: Math.min(selected.selection.anchor, selected.selection.head), to: Math.max(selected.selection.anchor, selected.selection.head), module, delay: this.delay, ...(this.fault ? { fault: this.fault } : {}) }); }
        catch (error) { this.fault = undefined; this.publish({ status: "failed", message: error instanceof Error ? error.message : "Invalid action capture." }); return; }
        this.fault = undefined; const win = origin.editor.element.ownerDocument.defaultView!, job: Job = { origin, input, document: doc, selections: selected.selectionSet, folds: origin.editor.view.folding.getSnapshot().generation, authority: this.authority(doc.id), lease: this.workspace.acquire(doc.resourceId), stops: [], timer: 0, invalid: false, result: undefined };
        this.job = job; this.metrics.requested++;
        const changed = () => { if (!this.publishing && this.job === job && !this.current(job)) { job.invalid = true; queueMicrotask(() => { if (this.job === job) { this.release(); this.metrics.expired++; this.publish({ status: "expired", message: "Captured source, selection, view, module or authority changed; preview a fresh action.", edits: [], title: "" }); } }); } };
        try {
            job.stops.push(this.workspace.observeDocument(doc.id).subscribe(changed), this.workspace.resourceForDocument(doc.id).metadata.subscribe(changed), origin.editor.view.subscribe(changed), origin.editor.view.folding.subscribe(changed), this.workspace.tabState.subscribe(changed));
            job.timer = win.setTimeout(() => { if (this.job === job && !job.result) { this.release(); this.metrics.failed++; this.publish({ status: "failed", message: "Action provider timed out; source is unchanged.", edits: [] }); } }, 30000);
            this.publish({ status: "pending", message: `Preparing an import action for ${origin.id}.`, edits: [], title: "", disabled: null, work: 0, total: doc.buffer.length });
            this.client ??= createNavigationClient(win, this.worker, undefined, () => { if (this.client && !this.client.snapshot().connected && !this.client.snapshot().busy) { this.drop(); this.release(); this.publish({ status: "failed", message: "Action connection failed; request a fresh preview.", edits: [], title: "" }); } else this.publish(); });
            void this.client.action(input, doc.buffer, work => { if (this.current(job)) this.publish({ work }); }).then(result => {
                if (!this.current(job)) { changed(); return; } job.result = result; win.clearTimeout(job.timer);
                const edits = result.action.edits.flatMap(at => at.edits.map(edit => ({ ...edit, document: at.document, resource: doc.resourceId, title: doc.title.slice(0, 128), revision: at.revision, context: doc.buffer.slice(Math.max(0, edit.from - 32), Math.min(doc.buffer.length, edit.from + 32)) })));
                this.publish({ status: "ready", title: result.action.title, disabled: result.action.disabled, edits, work: input.length,
                    message: result.action.disabled ?? (this.editable(doc.id) ? `Review ${edits.length} proposed edits to ${doc.title.slice(0, 128)} before confirming.` : "Review the proposed edit; this source does not permit application.") });
            }).catch(error => { if (this.job !== job) return; this.release(); this.drop(); this.metrics.failed++; this.publish({ status: "failed", message: error instanceof Error ? error.message : "Action failed; source is unchanged.", edits: [], title: "" }); });
            if (keyboard && this.moduleInput && this.current(job)) { this.moduleInput.value = module; this.moduleInput.focus(); this.moduleInput.select(); }
        } catch (error) { this.release(); this.drop(); this.metrics.failed++; this.publish({ status: "failed", message: error instanceof Error ? error.message : "Action provider unavailable.", edits: [] }); }
    }
    apply(token: number | null): void {
        const job = this.job; if (!job?.result || token !== job.input.id || !this.current(job) || job.result.action.disabled || !this.editable(job.document.id)) { this.publish({ message: "Use a fresh applicable preview with edit permission." }); return; }
        this.publishing = true;
        try {
            const result = this.workspace.editDocuments(job.result.action.edits.map(at => ({ documentId: job.document.id, expectedRevision: at.revision, edits: at.edits, origin: "host" as const, history: { kind: "refactor" as const }, view: job.origin.editor.view })));
            if (!result.applied) throw new Error(result.reason); this.metrics.applied++; this.release(); this.publish({ status: "applied", message: "Applied the captured import action as one shared undo command.", title: "", edits: [], changed: { document: job.document.id, title: job.document.title.slice(0, 128) } });
            if (this.available(job.origin)) { job.origin.editor.viewport.revealOffset(job.origin.editor.view.getSnapshot().selection.head); job.origin.editor.focus(); }
        } catch (error) { this.release(); this.publish({ status: "failed", message: error instanceof Error ? error.message : "Action rejected; source is unchanged.", edits: [], title: "" }); }
        finally { this.publishing = false; }
    }
    readonly openChanged = (): void => {
        const changed = this.cell.get().changed; if (this.disposed || this.job || !changed || !this.canCapture(changed.document)) return;
        try { const editor = [...this.sessions.values()].find(s => s.editor.view.documentId === changed.document && this.available(s))?.editor ?? this.present(changed.document); editor?.focus(); }
        catch { this.publish({ message: "The changed resource is no longer available." }); }
    };
    setDelay(value: number): void { if (!Number.isFinite(value) || value < 0 || value > 1000) throw new RangeError("Invalid action delay."); this.delay = value; }
    faultNext(value: NonNullable<ActionInput["fault"]>): void { this.fault = value; }
    faultIdle(): boolean { return this.client?.faultIdle() ?? false; }
    debug() { const job = this.job; return { ...this.metrics, worker: { ...this.worker }, state: this.cell.get(), capture: job ? { view: job.origin.id, input: job.input, selections: job.selections } : null, transport: this.client?.snapshot() ?? null, sessions: this.sessions.size, subscriptions: this.cell.count(), disposed: this.disposed }; }
    dispose(): void { if (this.disposed) return; this.cancel(); this.drop(); this.bindModule(null); this.disposed = true; this.active = undefined; this.publish({ changed: null }); }
}
