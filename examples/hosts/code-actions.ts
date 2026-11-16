import type { DocumentId, DocumentSnapshot, ResourceLease, TabId, TabTarget, Workspace } from "../../src/index.ts";
import { captureViewRequest } from "../../src/browser/index.ts";
import type { CapturedViewRequest, EditingCandidate } from "../../src/browser/index.ts";
import { navigationMetrics } from "../editing/navigation-service.ts";
import { createActionBackend } from "../editing/action-backend.ts";
import type { ActionBackend, ActionProviderBatch } from "../editing/action-backend.ts";
import { ProviderLane } from "../shared/provider-lane.ts";
import { validateActionInput } from "../../fixtures/language/actions.ts";
import type { ActionInput, ActionResult } from "../../fixtures/language/actions.ts";
import { HostCell } from "../shared/observable.ts";
import { RpcError, applyLspWorkspaceEdit, previewLspWorkspaceEdit } from "../../src/protocol/index.ts";
import type { LspCodeAction, LspWorkspace } from "../../src/protocol/index.ts";
import type { LspActionFactory } from "../editing/lsp-action-client.ts";
import type { HostProjectTools, ProjectActionHandle } from "./project.ts";
type Session = { token: number; id: string; target: TabTarget; editor: EditingCandidate };
type Job = { origin: Session; input: ActionInput; document: DocumentSnapshot; capture: CapturedViewRequest;
    sources: Map<DocumentId, Readonly<{ document: DocumentSnapshot; authority: string }>>; leases: ResourceLease[];
    stops: (() => void)[]; timer: number; invalid: boolean; ready: boolean; result: ActionResult | undefined;
    batch?: ActionProviderBatch; selected?: LspCodeAction; choice: number | null; choicePage: number; resolving: boolean; page: number };
export type ActionNote = Readonly<{ document: string; resource: string; title: string; revision: number; from: number; to: number; insert: string; context: string; before?: string; insertUnits?: number }>;
export type ActionChoice = Readonly<{ index: number; title: string; kind: string | null; preferred: boolean; disabled: string | null; needsResolve: boolean }>;
type ActionChange = Readonly<{ document: DocumentId; title: string }>;
export type ActionsSnapshot = Readonly<{ available: boolean; connected: boolean; disconnected: boolean; reconnectRequired: boolean; pending: boolean; canApply: boolean; token: number | null; module: string;
    status: "idle" | "pending" | "ready" | "expired" | "failed" | "applied" | "executed"; message: string; title: string; disabled: string | null; work: number; total: number; command: string | null;
    edits: readonly ActionNote[]; changed: ActionChange | null; changes: readonly ActionChange[]; choices: readonly ActionChoice[]; choice: number | null; choicePage: number; resolving: boolean; page: number; editCount: number }>;
let serial = 0;
/** Host-owned edit-bearing action. No provider command can execute without explicit confirmation. */
export class HostActionsTools {
    private readonly workspace: Workspace;
    private readonly canCapture: (id: DocumentId) => boolean;
    private readonly present: (id: DocumentId) => EditingCandidate | undefined;
    private readonly sessions = new Map<number, Session>();
    private active: Session | undefined;
    private job: Job | undefined;
    private readonly lane = new ProviderLane<ActionBackend>(backend => this.connectionChanged(backend));
    private readonly backendFactory: LspActionFactory | undefined;
    private readonly provider: LspWorkspace | undefined;
    private readonly reviewOwner: HostProjectTools | undefined;
    private readonly stopReviewOwner: (() => void) | undefined;
    private execution: { token: number; handle: ProjectActionHandle } | undefined;
    readonly usesLsp: boolean;
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
    private readonly cell = new HostCell<ActionsSnapshot>({ available: false, connected: false, disconnected: false, reconnectRequired: false, pending: false, canApply: false, token: null, module: "sample-utils", status: "idle", message: "Focus a candidate source to preview a module-import action.", title: "", disabled: null, work: 0, total: 0, command: null, edits: [], changed: null, changes: [], choices: [], choice: null, choicePage: 0, resolving: false, page: 0, editCount: 0 });
    readonly state = this.cell.observable;
    private readonly reconnectProvider: (() => void) | undefined;
    constructor(workspace: Workspace, canCapture: (id: DocumentId) => boolean, present: (id: DocumentId) => EditingCandidate | undefined, backendFactory?: LspActionFactory, reviewOwner?: HostProjectTools, provider?: LspWorkspace, reconnectProvider?: () => void) { this.reconnectProvider = reconnectProvider;
        this.provider = provider;
        this.workspace = workspace; this.canCapture = canCapture; this.present = present; this.backendFactory = backendFactory; this.reviewOwner = reviewOwner; this.usesLsp = backendFactory !== undefined;
        this.stopReviewOwner = this.usesLsp ? reviewOwner?.state.subscribe(() => this.publish()) : undefined;
    }
    private available(s: Session): boolean {
        const tab = this.workspace.resolveTab(s.target);
        return !this.disposed && this.sessions.get(s.token) === s && s.editor.element.isConnected && !s.editor.activity().disposed && this.workspace.ownsDocumentView(s.editor.view)
            && tab?.surface.kind === "text" && tab.surface.documentId === s.editor.view.documentId && !!this.workspace.observeDocument(s.editor.view.documentId).getSnapshot();
    }
    private authority(id: DocumentId): string { const m = this.workspace.resourceForDocument(id).metadata.getSnapshot(); return JSON.stringify([m.state, m.capabilities.edit, m.editLock]); }
    private editable(id: DocumentId): boolean { const m = this.workspace.resourceForDocument(id).metadata.getSnapshot(); return m.capabilities.edit.includes("human") && m.capabilities.edit.includes("host") && m.editLock === null; }
    private currentCapture(job: Job): boolean {
        if (this.job !== job || job.invalid || job.input.module !== this.cell.get().module) return false;
        try {
            if (!job.capture.isCurrent()) return false;
            for (const source of job.sources.values()) if (source.document.id !== job.capture.document.id
                && (!this.canCapture(source.document.id) || this.workspace.observeDocument(source.document.id).getSnapshot()?.revision !== source.document.revision || this.authority(source.document.id) !== source.authority)) return false;
        } catch { return false; }
        return true;
    }
    private current(job: Job): boolean { return this.currentCapture(job) && (!job.batch || job.batch.isCurrent()); }
    private expire(job: Job): void {
        if (this.job !== job || job.invalid) return;
        job.invalid = true;
        queueMicrotask(() => {
            if (this.job !== job) return;
            this.release();
            this.metrics.expired++;
            this.publish({ status: "expired", message: this.usesLsp && this.disconnected
                ? "Action provider disconnected; reconnect and preview fresh actions."
                : "Captured resource, selection, view, module or authority changed; preview a fresh action.",
                edits: [], title: "", choices: [], page: 0, editCount: 0 });
        });
    }
    private disabled(action: LspCodeAction): string | null { return action.disabled ?? (action.command ? !this.reviewOwner || !this.job?.batch?.supports(action.command) ? "This captured command is not permitted by the host." : null : !action.resolve && !action.edit?.documents.some(change => change.edits.length) ? "The provider returned no text changes." : null); }
    private publish(patch: Partial<ActionsSnapshot> = {}): void {
        const job = this.job; this.cell.set({ ...this.cell.get(), ...patch, choicePage: job?.choicePage ?? 0, available: !!this.active && this.available(this.active), connected: this.lane.value?.snapshot().connected ?? false,
            disconnected: this.disconnected, reconnectRequired: this.provider?.state.getSnapshot().commandRequiresReconnect ?? false, token: this.execution?.token ?? job?.input.id ?? null, pending: !!this.execution || !!job && (!job.ready || job.resolving), choice: job?.choice ?? null, resolving: job?.resolving ?? false, command: job?.selected?.command?.command ?? null,
            canApply: !this.execution && !!job?.ready && !job.resolving && this.current(job) && (job.batch ? !!job.selected && !!(job.selected.edit || job.selected.command) && !this.disabled(job.selected)
                && (!job.selected.command || !!this.reviewOwner?.canRunAction(job.origin.editor)) && (job.selected.edit?.documents ?? []).filter(change => change.edits.length).every(change => this.editable(change.target.document.documentId as DocumentId)) : !!job.result && !job.result.action.disabled && this.editable(job.document.id)) });
    }
    private changed(job: Job): void {
        if (this.publishing || this.job !== job) return;
        // Resolution owns its terminal error; local capture changes still expire immediately.
        if (this.currentCapture(job) && (job.resolving || this.current(job))) return;
        this.expire(job);
    }
    private connectionChanged(backend: ActionBackend): void {
        const state = backend.snapshot(), job = this.job;
        if (this.usesLsp) {
            if (!job) return; // A handed-off command has its own captured batch subscription.
            if (job.ready && !state.connected) this.disconnected = true;
            this.changed(job); this.publish();
        } else if (!state.connected && !state.busy) {
            this.lane.drop(); this.release(); this.publish({ status: "failed", message: "Action connection failed; request a fresh preview.", edits: [], title: "" });
        } else this.publish();
    }
    private release(): void {
        const job = this.job; this.job = undefined; if (!job) return; job.invalid = true;
        job.origin.editor.element.ownerDocument.defaultView!.clearTimeout(job.timer); job.stops.splice(0).forEach(stop => stop()); job.capture.cancel(); job.leases.splice(0).forEach(lease => lease.release()); if (!job.ready || job.resolving) this.lane.drop(); else if (!this.execution) this.lane.value?.cancel();
    }
    private retainTargets(job: Job, actions: readonly LspCodeAction[]): void {
        for (const action of actions) for (const change of action.edit?.documents ?? []) {
            const target = change.target.document; if (job.sources.has(target.documentId as DocumentId)) continue;
            const document = this.workspace.getSnapshot().documents.find(document => document.id === target.documentId);
            if (!document || document.resourceId !== target.resourceId || document.revision !== target.revision || document.buffer !== target.buffer
                || !change.target.isCurrent() || !this.canCapture(document.id)) throw new Error("A resolved action target changed.");
            job.sources.set(document.id, { document, authority: this.authority(document.id) });
            const changed = () => { if (!this.publishing && this.job === job && !this.current(job)) this.expire(job); };
            job.stops.push(this.workspace.observeDocument(document.id).subscribe(changed), this.workspace.resourceForDocument(document.id).metadata.subscribe(changed));
        }
    }
    readonly cancel = (): void => { const execution = this.execution, applied = execution?.handle.applied() ?? false; this.execution = undefined; execution?.handle.cancel(); if (this.job || execution) this.metrics.cancelled++; this.release();
        this.publish({ status: "idle", message: applied ? "Action command cancelled after application; the edits remain undoable." : "Action preview dismissed; source is unchanged by this action.", edits: [], title: "", disabled: null, work: 0, total: 0, choices: [], page: 0, editCount: 0 }); };
    readonly disconnect = (): void => { this.cancel(); this.lane.drop(); this.disconnected = true; this.publish({ message: "Action provider disconnected; local editing remains available." }); };
    readonly reconnect = (): void => { this.cancel(); this.lane.drop(); this.disconnected = false; this.reconnectProvider?.(); this.publish({ message: "Preview a fresh action with current source." }); };
    setModule(value: string): void { if (value === this.cell.get().module) return; this.cancel(); this.publish({ module: value.slice(0, 65), status: "idle", message: "Module changed; preview a fresh action.", title: "", disabled: null, edits: [], work: 0, total: 0, choices: [], page: 0, editCount: 0 }); }
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
            if (!event.defaultPrevented && !event.isComposing && !editor.activity().composing && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key === ".") {
                event.preventDefault(); event.stopImmediatePropagation(); this.active = s; this.start(true);
            }
        }, { capture: true, signal: events.signal });
        for (const event of ["beforeinput", "compositionstart", "paste", "cut"] as const) editor.input.addEventListener(event, () => { if (this.job?.sources.has(editor.view.documentId)) this.cancel(); }, { signal: events.signal });
        let detached = false; return () => { if (detached) return; detached = true; if (this.job?.origin === s) this.cancel(); events.abort(); this.sessions.delete(s.token); if (this.active === s) this.active = undefined; if (!this.sessions.size) this.lane.drop(); this.publish(); };
    }
    readonly request = (): void => this.start(false);
    /** Start a host command from its named mounted source, independent of later focus. */
    begin(id: string): void {
        const source = [...this.sessions.values()].find(session => session.id === id);
        if (!source) return; this.active = source; this.start(false);
    }
    private start(keyboard: boolean): void {
        const origin = this.active, module = this.cell.get().module;
        if (this.disconnected || !origin || !this.available(origin)) { this.publish({ message: "Focus an available source and reconnect first." }); return; }
        if (!this.canCapture(origin.editor.view.documentId)) { this.publish({ message: "Finish pending input, navigation, table conversion or composition first." }); return; }
        this.cancel(); const doc = this.workspace.document(origin.editor.view.documentId), selected = origin.editor.view.getSnapshot();
        if (doc.key.variant !== "working") { this.publish({ status: "failed", message: "Only a working source can receive an action." }); return; }
        const documents = this.usesLsp ? this.workspace.getSnapshot().documents.filter(doc => doc.key.variant === "working") : [doc];
        if (documents.some(doc => !this.canCapture(doc.id))) { this.publish({ message: "Finish pending input, navigation, table conversion or composition in the captured project first." }); return; }
        let input: ActionInput;
        try { input = validateActionInput({ operation: "action-start", id: ++this.sequence, document: doc.id, revision: doc.revision, length: doc.buffer.length, from: Math.min(selected.selection.anchor, selected.selection.head), to: Math.max(selected.selection.anchor, selected.selection.head), module, delay: this.delay, ...(this.fault ? { fault: this.fault } : {}) }); }
        catch (error) { this.fault = undefined; this.publish({ status: "failed", message: error instanceof Error ? error.message : "Invalid action capture." }); return; }
        this.fault = undefined;
        const sources = new Map(documents.map(doc => [doc.id, { document: doc, authority: this.authority(doc.id) }]));
        const capture = captureViewRequest(this.workspace, origin.target, origin.editor.view, { available: () => this.available(origin) && this.canCapture(origin.editor.view.documentId) });
        if (!capture) { this.publish({ message: "The source changed before capture; request a fresh action." }); return; }
        const win = origin.editor.element.ownerDocument.defaultView!, job: Job = { origin, input, document: capture.document, capture,
            sources, leases: [], stops: [], timer: 0, invalid: false, ready: false, result: undefined, choice: null, choicePage: 0, resolving: false, page: 0 };
        this.job = job; this.metrics.requested++;
        const changed = () => this.changed(job);
        try {
            capture.signal.addEventListener("abort", changed, { once: true });
            for (const doc of documents) if (doc.id !== capture.document.id) { job.leases.push(this.workspace.acquire(doc.resourceId)); job.stops.push(this.workspace.observeDocument(doc.id).subscribe(changed), this.workspace.resourceForDocument(doc.id).metadata.subscribe(changed)); }
            job.timer = win.setTimeout(() => { if (this.job === job && !job.ready) { this.release(); this.metrics.failed++; this.publish({ status: "failed", message: "Action provider timed out; source is unchanged.", edits: [], choices: [] }); } }, 30000);
            this.publish({ status: "pending", message: this.usesLsp ? "Requesting captured provider actions." : `Preparing an import action for ${origin.id}.`, edits: [], title: "", disabled: null, work: 0, total: doc.buffer.length });
            const backend = this.lane.acquire(notify => createActionBackend(win, this.worker, this.backendFactory, notify));
            void backend.run({ documents, document: doc, input, progress: work => { if (this.current(job)) this.publish({ work }); } }).then(value => {
                if (value.kind === "provider") job.batch = value.batch;
                if (!this.current(job)) { changed(); return; }
                if (value.kind === "provider") {
                    const batch = value.batch; this.retainTargets(job, batch.actions); job.ready = true; win.clearTimeout(job.timer);
                    const choices = Object.freeze(batch.actions.map((action, index) => Object.freeze({ index, title: action.title, kind: action.kind, preferred: action.preferred, disabled: this.disabled(action), needsResolve: action.resolve !== null })));
                    this.publish({ status: "ready", choices, message: choices.length ? "Choose a captured action and review its edits before applying." : "No provider actions for this captured range.", work: input.length });
                    if (batch.actions[0]?.edit && !this.disabled(batch.actions[0])) this.selectChoice(0);
                } else {
                    const result = value.result; job.result = result; job.ready = true; win.clearTimeout(job.timer);
                    const edits = result.action.edits.flatMap(at => at.edits.map(edit => ({ ...edit, document: at.document, resource: doc.resourceId, title: doc.title.slice(0, 128), revision: at.revision, context: doc.buffer.slice(Math.max(0, edit.from - 32), Math.min(doc.buffer.length, edit.from + 32)) })));
                    this.publish({ status: "ready", title: result.action.title, disabled: result.action.disabled, edits, editCount: edits.length, work: input.length,
                        message: result.action.disabled ?? (this.editable(doc.id) ? `Review ${edits.length} proposed edits to ${doc.title.slice(0, 128)} before confirming.` : "Review the proposed edit; this source does not permit application.") });
                }
            }).catch(error => { if (this.job !== job) return; this.release(); this.lane.drop(); this.metrics.failed++; this.publish({ status: "failed", message: error instanceof Error ? error.message : "Action failed; source is unchanged.", edits: [], title: "", choices: [], editCount: 0 }); });
            if (keyboard && this.moduleInput && this.current(job)) { if (!this.usesLsp) this.moduleInput.value = module; this.moduleInput.focus(); this.moduleInput.select(); }
        } catch (error) { this.release(); this.lane.drop(); this.metrics.failed++; this.publish({ status: "failed", message: error instanceof Error ? error.message : "Action provider unavailable.", edits: [] }); }
    }
    selectChoice(index: number): void { this.choose(index); }
    /** Explicit user activation, with host policy evaluated again after any lazy resolution. */
    activateChoice(index: number, token: number | null, apply: (action: LspCodeAction) => boolean): void {
        const job = this.job; if (!job || token !== job.input.id) return;
        this.choose(index, action => { if (this.job === job && this.current(job) && apply(action)) this.apply(token); });
    }
    private choose(index: number, activated?: (action: LspCodeAction) => void): void {
        const job = this.job, action = job?.batch?.actions[index]; if (!job?.ready || job.resolving || !action || !this.current(job)) return;
        job.choice = index; job.selected = action; job.page = 0; job.choicePage = Math.floor(index / 16);
        if (!action.resolve || this.disabled(action)) { this.showChoice(job); if (!this.disabled(action)) activated?.(action); return; }
        const win = job.origin.editor.element.ownerDocument.defaultView!, configuration = { module: job.input.module, delay: this.delay, ...(this.fault ? { fault: this.fault } : {}) }; this.fault = undefined;
        job.resolving = true; this.publish({ status: "pending", title: action.title, edits: [], editCount: 0, page: 0, disabled: null, message: "Resolving the captured action's edit preview." });
        job.timer = win.setTimeout(() => { if (this.job === job && job.resolving) { this.release(); this.metrics.failed++; this.publish({ status: "failed", message: "Action resolution timed out; source is unchanged.", edits: [], choices: [], editCount: 0 }); } }, 30000);
        void job.batch!.resolve(action, configuration).then(resolved => {
            if (this.job !== job || job.choice !== index) return;
            if (!this.current(job)) { this.expire(job); return; }
            this.retainTargets(job, [resolved]); job.selected = resolved;
            job.resolving = false;
            win.clearTimeout(job.timer);
            this.showChoice(job);
            activated?.(resolved);
        }).catch(error => {
            if (this.job !== job) return;
            if (!this.currentCapture(job) || error instanceof RpcError && (error.code === -32800 || error.code === -32801)) {
                this.expire(job); return;
            }
            this.release(); this.lane.drop(); this.metrics.failed++;
            this.publish({ status: "failed", message: error instanceof Error ? error.message : "Action resolution failed; source is unchanged.",
                edits: [], choices: [], title: "", editCount: 0 });
        });
    }
    private showChoice(job: Job): void {
        const action = job.selected; if (!action || !this.current(job)) return;
        const preview = action.edit ? previewLspWorkspaceEdit(action.edit, id => job.sources.get(id as DocumentId)!.document.title, job.page) : { count: 0, notes: [] }, disabled = this.disabled(action);
        this.publish({ status: "ready", title: action.title, disabled, edits: preview.notes, editCount: preview.count, page: job.page,
            message: disabled ?? (action.command ? `Confirm execution of ${action.command.title} (${action.command.command}) with ${action.command.arguments.length} captured arguments after ${preview.count} edits. Further edits follow the host's captured action policy.` : `Review ${preview.count} captured provider edits before confirming. Every target must permit application.`) });
    }
    nextPage(): void { const job = this.job; if (job?.selected?.edit && this.current(job) && !job.resolving && (job.page + 1) * 64 < this.cell.get().editCount) { job.page++; this.showChoice(job); } }
    previousPage(): void { const job = this.job; if (job?.selected && this.current(job) && !job.resolving && job.page > 0) { job.page--; this.showChoice(job); } }
    moveChoicePage(direction: -1 | 1): void {
        const job = this.job, state = this.cell.get(), page = state.choicePage + direction;
        if (job?.ready && !job.resolving && this.current(job) && page >= 0 && page * 16 < state.choices.length) { job.choicePage = page; this.publish(); }
    }
    apply(token: number | null): void {
        const job = this.job; if (this.execution || !job?.ready || job.resolving || token !== job.input.id || !this.current(job)
            || (job.batch ? !job.selected || !(job.selected.edit || job.selected.command) || !!this.disabled(job.selected) || (job.selected.edit?.documents ?? []).some(change => change.edits.length && !this.editable(change.target.document.documentId as DocumentId)) : !job.result || !!job.result.action.disabled || !this.editable(job.document.id))) { this.publish({ message: "Use a fresh applicable preview with edit permission." }); return; }
        if (job.selected?.command && job.batch && this.lane.value) {
            const batch = job.batch, action = job.selected, backend = this.lane.value;
            try {
                const handle = this.reviewOwner?.beginAction({ editor: job.origin.editor, sources: [...job.sources.values()], edit: action.edit,
                    isCurrent: batch.commandCurrent, subscribe: batch.subscribe, execute: scope => batch.execute(action, scope), cancel: () => { if (this.lane.value === backend) this.lane.drop(); else backend.dispose(); } });
                if (!handle) { this.publish({ message: "Finish the current workspace-provider review before executing this action." }); return; }
                const execution = { token: job.input.id, handle }; this.execution = execution; this.release();
                this.publish({ status: "pending", message: "Executing the confirmed action under the host's captured edit policy.", edits: [], choices: [], editCount: 0, title: action.title });
                void handle.result.then(receipt => { if (this.execution !== execution) return; this.execution = undefined; if (receipt.applied) this.metrics.applied++;
                    if (this.provider ? this.provider.state.getSnapshot().phase !== "ready" : this.lane.value && !this.lane.value.snapshot().connected) this.disconnected = true;
                    this.publish({ status: receipt.success ? receipt.applied ? "applied" : "executed" : "failed", message: receipt.reason,
                        title: "", changes: receipt.changes, changed: receipt.changes.find(change => change.document === job.document.id) ?? receipt.changes[0] ?? null }); });
            } catch (error) { this.publish({ message: error instanceof Error ? error.message : "Captured command cannot start." }); }
            return;
        }
        this.publishing = true;
        try {
            let documents: readonly DocumentSnapshot[] = [];
            if (!job.capture.commit(() => {
                if (job.batch) documents = applyLspWorkspaceEdit(this.workspace, job.selected!.edit!, { origin: "host", requiredOrigins: ["human"], historyKind: "refactor", view: job.origin.editor.view });
                else {
                    const requests = job.result!.action.edits.map(at => ({ documentId: job.document.id, expectedRevision: at.revision, edits: at.edits,
                        origin: "host" as const, history: { kind: "refactor" as const }, view: job.origin.editor.view }));
                    const result = this.workspace.editDocuments(requests); if (!result.applied) throw new Error(result.reason);
                    documents = requests.map(request => job.sources.get(request.documentId)!.document);
                }
                return true;
            })) throw new Error("Captured action context changed before application.");
            const changes = Object.freeze(documents.map(doc => Object.freeze({ document: doc.id, title: doc.title.slice(0, 128) })));
            this.metrics.applied++; this.release(); this.publish({ status: "applied", message: job.batch ? "Applied exact captured provider edits as one shared undo command." : "Applied the captured import action as one shared undo command.", title: "", edits: [], choices: [], editCount: 0, page: 0, changes, changed: changes.find(change => change.document === job.document.id) ?? changes[0] ?? null });
            if (this.available(job.origin)) { job.origin.editor.viewport.revealOffset(job.origin.editor.view.getSnapshot().selection.head); job.origin.editor.focus(); }
        } catch (error) { this.release(); this.publish({ status: "failed", message: error instanceof Error ? error.message : "Action rejected; source is unchanged.", edits: [], title: "", choices: [], editCount: 0 }); }
        finally { this.publishing = false; }
    }
    readonly openChanged = (): void => {
        const changed = this.cell.get().changed; if (changed) this.openChangedDocument(changed.document);
    };
    openChangedDocument(document: DocumentId): void {
        if (this.disposed || this.job || !this.cell.get().changes.some(change => change.document === document) || !this.canCapture(document)) return;
        try { const editor = [...this.sessions.values()].find(s => s.editor.view.documentId === document && this.available(s))?.editor ?? this.present(document);
            if (!editor || editor.view.documentId !== document) { this.publish({ message: "The captured changed resource cannot be presented in an available source view." }); return; } editor.focus(); }
        catch { this.publish({ message: "The changed resource is no longer available." }); }
    }
    setDelay(value: number): void { if (!Number.isFinite(value) || value < 0 || value > 1000) throw new RangeError("Invalid action delay."); this.delay = value; }
    faultNext(value: NonNullable<ActionInput["fault"]>): void { this.fault = value; }
    faultIdle(): boolean { return this.lane.value?.faultIdle() ?? false; }
    debug() { const job = this.job; return { ...this.metrics, worker: { ...this.worker }, state: this.cell.get(), capture: job ? { view: job.origin.id, input: job.input, selections: job.capture.selectionSet } : null, transport: this.lane.value?.snapshot() ?? null, sessions: this.sessions.size, subscriptions: this.cell.count(), disposed: this.disposed }; }
    dispose(): void { if (this.disposed) return; this.cancel(); this.lane.dispose(); this.bindModule(null); this.stopReviewOwner?.(); this.disposed = true; this.active = undefined; this.publish({ changed: null, changes: [] }); }
}
