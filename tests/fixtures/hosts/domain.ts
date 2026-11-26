import { onSourceFocus } from "../../../examples/shared/source-focus.ts";
import { captureEditorCommand } from "../../../examples/shared/editor-attachment.ts";
import { createFoldRegions } from "../../../src/index.ts";
import type { DocumentId, DocumentView, FoldRange, FoldingSnapshot, ResourceLease, Workspace } from "../../../src/index.ts";
import type { DecorationLayer, TextEditor } from "../../../src/browser/index.ts";
import { FixtureDomainProvider, validateDomainResult } from "../language/domain.ts";
import type { DomainAnnotation, DomainInput, DomainProvider } from "../language/domain.ts";
import { HostCell } from "../../../examples/shared/observable.ts";

type OwnedFold = { id: string; from: number; to: number };
type ViewData = { revision: number; owned: Map<string, OwnedFold>; annotations: readonly DomainAnnotation[] };
type Session = { token: string; id: string; editor: TextEditor; layer: DecorationLayer; data: ViewData };
type Analysis = { folds: FoldingSnapshot; authority: string; lease: ResourceLease };
type Job = { session: Session; input: DomainInput; analysis?: Analysis; abort: AbortController; timeout: number; invalid: boolean };
export type DomainSnapshot = Readonly<{ available: boolean; editable: boolean; view: string | null; token: string | null; revision: number | null;
    status: "idle" | "running" | "ready" | "applied" | "cancelled" | "failed"; message: string; work: number; total: number; pendingView: string | null;
    annotations: readonly DomainAnnotation[]; annotationCount: number; foldCount: number }>;
const noAnnotations: readonly DomainAnnotation[] = Object.freeze([]);

/** Host service and presentation, independent of the runtime's domain/language policy. */
export class HostDomainTools {
    private readonly sessions = new Map<string, Session>();
    private data = new WeakMap<DocumentView, ViewData>();
    private active: Session | undefined;
    private job: Job | undefined;
    private disposed = false;
    private readonly cell = new HostCell<DomainSnapshot>({ available: false, editable: false, view: null, token: null, revision: null, status: "idle", message: "Focus a candidate source view to use domain commands.", work: 0, total: 0, pendingView: null, annotations: noAnnotations, annotationCount: 0, foldCount: 0 });
    readonly state = this.cell.observable;
    readonly fixture = new FixtureDomainProvider();
    private readonly provider: DomainProvider;
    private readonly metrics = { requested: 0, applied: 0, invalid: 0, stale: 0, cancelled: 0 };
    private readonly workspace: Workspace;
    private readonly canCapture: (id: DocumentId) => boolean;
    constructor(workspace: Workspace, canCapture: (id: DocumentId) => boolean = () => true,
        provider?: DomainProvider) { this.workspace = workspace; this.canCapture = canCapture; this.provider = provider ?? this.fixture; }
    private available(session: Session): boolean {
        const { editor } = session;
        return !this.disposed && this.sessions.get(session.token) === session && editor.element.isConnected && !editor.activity().disposed
            && this.workspace.ownsDocumentView(editor.view)
            && this.workspace.resource(editor.view.documentId).getSnapshot().state === "ready";
    }
    private authority(session: Session): string {
        const state = this.workspace.resource(session.editor.view.documentId).getSnapshot();
        return JSON.stringify([state.state, state.metadata.capabilities.edit.includes("human")]);
    }
    private editable(session: Session): boolean {
        const state = session.editor.getSnapshot();
        return !state.disabled && state.readOnlyReason === null;
    }
    private publish(patch: Partial<DomainSnapshot> = {}): void {
        const session = this.active, valid = session && this.available(session), data = valid ? session.data : undefined;
        this.cell.set({ ...this.cell.get(), available: !!valid, editable: !!valid && this.editable(session), view: valid ? session.id : null, token: valid ? session.token : null,
            revision: data?.revision ?? null, annotations: data?.annotations.slice(0, 64) ?? noAnnotations, annotationCount: data?.annotations.length ?? 0,
            foldCount: data?.owned.size ?? 0, pendingView: this.job?.session.id ?? null, ...patch });
    }
    private sync(session: Session): void {
        if (!this.available(session)) { if (this.job?.session === session) this.invalidate(this.job); return; }
        const revision = this.workspace.document(session.editor.view.documentId).revision, folds = session.editor.view.folding.getSnapshot();
        const changed = session.data.revision !== revision, byId = new Map(folds.regions.map(r => [r.id, r]));
        for (const [key, owned] of session.data.owned) {
            const current = byId.get(owned.id);
            if (!current || !changed && (current.from !== owned.from || current.to !== owned.to)) session.data.owned.delete(key);
            else { owned.from = current.from; owned.to = current.to; }
        }
        if (changed) { session.data.revision = revision; session.data.annotations = noAnnotations; session.layer.clear(); }
        if (this.active === session) this.publish();
    }
    attach(id: string, editor: TextEditor): () => void {
        const token = `domain-session-${this.workspace.allocateIdentity()}`, revision = this.workspace.document(editor.view.documentId).revision;
        const data = this.data.get(editor.view) ?? { revision, owned: new Map<string, OwnedFold>(), annotations: noAnnotations };
        const layer = editor.decorations.add({ order: 30 });
        this.data.set(editor.view, data); const session = { token, id, editor, layer, data }, listeners = new AbortController(); this.sessions.set(token, session);
        const changed = () => { this.sync(session); if (this.job?.session === session && !this.current(this.job)) this.invalidate(this.job); };
        const stops = [this.workspace.observeDocument(editor.view.documentId).subscribe(changed), editor.view.folding.subscribe(changed), this.workspace.resource(editor.view.documentId).metadata.subscribe(changed)];
        onSourceFocus(editor, listeners.signal, () => { this.active = session; this.sync(session); });
        editor.onEditIntent(() => {
            if (this.job?.session.editor.view.documentId === editor.view.documentId) this.cancel();
        }, listeners.signal);
        this.sync(session); this.showAnnotations(session); let detached = false;
        return () => { if (detached) return; detached = true; if (this.job?.session === session) this.cancel(); listeners.abort(); stops.forEach(stop => stop()); this.sessions.delete(token);
            layer.dispose(); if (this.active === session) { this.active = undefined; this.publish(); } };
    }
    private showAnnotations(session: Session): void {
        session.layer.set(session.data.revision, session.data.annotations.map(note => ({
            from: note.from, to: note.to, className: "st-domain-note", afterLine: note.label
        })));
    }
    private guard(session: Session | undefined): session is Session {
        if (!session || !this.available(session)) { this.publish({ message: "Focus an available candidate source view." }); return false; }
        if (session.editor.activity().input === "composing" || !this.canCapture(session.editor.view.documentId)) { this.publish({ message: "Finish pending typing or composition before a domain command." }); return false; }
        return true;
    }
    private current(job: Job): boolean {
        if (job.invalid || this.job !== job) return false;
        try {
            // Analysis replaces fold metadata, so it needs the exact fold generation but allows selection movement.
            return this.available(job.session) && job.session.editor.activity().input !== "composing" && this.canCapture(job.session.editor.view.documentId)
                && (!job.analysis || this.workspace.document(job.session.editor.view.documentId).revision === job.input.revision
                    && job.session.editor.view.folding.getSnapshot().generation === job.analysis.folds.generation && this.authority(job.session) === job.analysis.authority);
        } catch { return false; }
    }
    private invalidate(job: Job): void {
        job.invalid = true;
        // Core notifications cannot release resource leases. Latch now, clean up afterward.
        queueMicrotask(() => { if (this.job === job) this.cancel(); });
    }
    private release(job: Job): void {
        if (this.job === job) this.job = undefined;
        job.invalid = true; job.session.editor.element.ownerDocument.defaultView!.clearTimeout(job.timeout); job.abort.abort(); job.analysis?.lease.release();
    }
    readonly cancel = (): void => {
        const job = this.job; if (!job) return; this.release(job); this.metrics.cancelled++;
        this.publish({ status: "cancelled", message: "Captured domain command cancelled; source and results are unchanged." });
    };
    readonly discover = (): void => { void this.start("analyze"); };
    readonly insertImport = (): void => { void this.start("import"); };
    private async start(kind: DomainInput["kind"]): Promise<void> {
        const session = this.active; if (!this.guard(session)) return;
        if (kind === "import" && !this.editable(session)) { this.publish({ message: "Import insertion requires an editable source." }); return; }
        this.cancel(); this.sync(session);
        const document = this.workspace.document(session.editor.view.documentId), win = session.editor.element.ownerDocument.defaultView!;
        const analysis = kind === "analyze" ? { folds: session.editor.view.folding.getSnapshot(), authority: this.authority(session),
            lease: this.workspace.acquire(document.id) } : undefined;
        const input: DomainInput = { id: this.workspace.allocateIdentity(), revision: document.revision, buffer: document.buffer, kind, module: "catalogue" };
        const job: Job = { session, input, ...(analysis ? { analysis } : {}), abort: new AbortController(), timeout: 0, invalid: false };
        this.job = job; this.metrics.requested++;
        job.timeout = win.setTimeout(() => { if (this.job === job) { this.release(job); this.publish({ status: "failed", message: "Domain command timed out; source is unchanged." }); } }, 30000);
        const run = (signal: AbortSignal) => {
            this.publish({ status: "running", message: analysis ? `Discovering domain regions in ${session.id}.` : `Preparing a captured import for ${session.id}.`, work: 0, total: document.buffer.length });
            signal.throwIfAborted();
            return this.provider.run(input, signal, units => {
                if (!signal.aborted && this.current(job) && Number.isSafeInteger(units) && units >= this.cell.get().work && units <= document.buffer.length) this.publish({ work: units });
            });
        };
        const read = (value: unknown) => {
            const result = validateDomainResult(value, input);
            createFoldRegions(document.buffer, result.folds);
            return result;
        };
        try {
            if (!analysis) {
                const source = captureEditorCommand(session.editor, "human");
                if (!source) { this.cancel(); return; }
                const expire = () => {
                    if (this.job === job) { this.metrics.stale++; this.cancel(); }
                };
                job.abort.signal.addEventListener("abort", source.cancel, { once: true, signal: source.signal });
                source.signal.addEventListener("abort", expire, { once: true });
                const value = await run(source.signal);
                if (this.job !== job) return;
                if (!this.current(job) || !source.isCurrent()) { expire(); return; }
                const { edits } = read(value);
                source.signal.removeEventListener("abort", expire);
                const applied = source.commit(() => this.workspace.edit({ documentId: source.document.id,
                    expectedRevision: source.document.revision, view: source.view, origin: "human",
                    edits, source: "import", history: { kind: "refactor" } }).applied);
                if (!applied) { expire(); return; }
                this.metrics.applied++; this.release(job);
                for (const attached of this.sessions.values()) if (attached.editor.view.documentId === document.id) this.sync(attached);
                session.editor.viewport.revealOffset(session.editor.view.getSnapshot().selection.head);
                this.publish({ status: "applied", message: edits.length ? `Inserted the captured import in ${session.id}.` : "The requested import is already present; source and history are unchanged." });
            } else {
                const value = await run(job.abort.signal);
                if (!this.current(job)) { this.metrics.stale++; if (this.job === job) this.cancel(); return; }
                const result = read(value);
                const owned = new Set([...session.data.owned.values()].map(value => value.id)), existing = analysis.folds.regions.filter(r => !owned.has(r.id)), ids = new Set(analysis.folds.regions.map(r => r.id));
                const next = new Map<string, OwnedFold>(), ranges: FoldRange[] = [...existing];
                for (const fold of result.folds) {
                    let id = session.data.owned.get(fold.id)?.id;
                    if (!id) {
                        do { id = `host-domain-${this.workspace.allocateIdentity()}`; } while (ids.has(id));
                    }
                    next.set(fold.id, { id, from: fold.from, to: fold.to }); ranges.push({ ...fold, id });
                }
                const normalized = createFoldRegions(document.buffer, ranges, analysis.folds.regions);
                if (!session.editor.view.folding.setRanges(analysis.folds, normalized)) throw new Error("Domain fold capture expired.");
                if (!this.available(session)) return;
                session.data.owned = next; session.data.annotations = result.annotations; this.showAnnotations(session);
                this.metrics.applied++; this.release(job); this.publish({ status: "ready", message: `Discovered ${result.folds.length} domain regions in ${session.id}.` });
            }
        } catch (error) {
            if (this.job !== job) return; this.metrics.invalid++; this.release(job);
            this.publish({ status: "failed", message: error instanceof Error && error.message.length <= 256 ? error.message : "Invalid domain result; source and prior results are unchanged." });
        } finally { if (this.job === job) this.release(job); }
    }
    readonly collapse = (): void => {
        const session = this.active; if (!this.guard(session)) return; this.cancel(); this.sync(session);
        const folds = session.editor.view.folding, ids = Array.from(session.data.owned.values(), region => region.id);
        if (!ids.length || folds.setCollapsed(folds.getSnapshot(), ids, true, { moveHiddenCarets: true })) {
            this.publish({ message: "Discovered domain regions collapsed; manual fold state is preserved." });
        }
        session.editor.focus();
    };
    reveal(token: string, revision: number, id: string): void {
        const session = this.sessions.get(token); if (!this.guard(session) || session.data.revision !== revision || this.workspace.document(session.editor.view.documentId).revision !== revision) return;
        const annotation = session.data.annotations.find(item => item.id === id); if (!annotation) return;
        session.editor.reveal(annotation, { expectedRevision: revision, select: true, focus: true });
    }
    debug() { return { ...this.metrics, subscriptions: this.cell.count(), pending: this.job !== undefined, provider: { ...this.fixture.metrics }, active: this.active?.id ?? null,
        sessions: [...this.sessions.values()].map(s => ({ id: s.id, token: s.token, revision: s.data.revision, annotations: s.data.annotations.length, folds: s.data.owned.size })) }; }
    dispose(): void { if (this.disposed) return; this.cancel(); this.disposed = true; this.active = undefined; this.data = new WeakMap(); this.publish(); }
}
