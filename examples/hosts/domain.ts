import { createFoldRegions, createSelectionSet, FoldIndex } from "../../src/index.ts";
import type { DocumentId, DocumentView, FoldRange, FoldingSnapshot, ResourceLease, TabId, TabTarget, Workspace } from "../../src/index.ts";
import { captureViewRequest } from "../../src/browser/index.ts";
import type { CapturedViewRequest, DecorationLayer, TextEditor } from "../../src/browser/index.ts";
import { FixtureDomainProvider, validateDomainResult } from "../../fixtures/language/domain.ts";
import type { DomainAnnotation, DomainInput, DomainProvider } from "../../fixtures/language/domain.ts";
import { HostCell } from "../shared/observable.ts";

type OwnedFold = { id: string; from: number; to: number };
type ViewData = { revision: number; owned: Map<string, OwnedFold>; annotations: readonly DomainAnnotation[] };
type Session = { token: string; id: string; editor: TextEditor; target: TabTarget; layer: DecorationLayer; data: ViewData };
type Job = { session: Session; input: DomainInput; folds: FoldingSnapshot; capture: CapturedViewRequest | undefined; authority: string; lease: ResourceLease | undefined; abort: AbortController; timeout: number; invalid: boolean };
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
    private serial = 0;
    private foldSerial = 0;
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
        const tab = this.workspace.tabs.resolve(session.target), editor = session.editor;
        return !this.disposed && this.sessions.get(session.token) === session && editor.element.isConnected && !editor.activity().disposed
            && tab?.surface.kind === "text" && tab.surface.documentId === editor.view.documentId && this.workspace.ownsDocumentView(editor.view)
            && this.workspace.resourceForDocument(editor.view.documentId).getSnapshot().state === "ready";
    }
    private authority(session: Session): string {
        const state = this.workspace.resourceForDocument(session.editor.view.documentId).getSnapshot();
        return JSON.stringify([state.state, state.metadata.capabilities.edit.includes("human"), state.metadata.editLock]);
    }
    private editable(session: Session): boolean {
        const state = this.workspace.resourceForDocument(session.editor.view.documentId).getSnapshot();
        return state.state === "ready" && state.metadata.capabilities.edit.includes("human") && state.metadata.editLock === null;
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
    attach(id: string, tab: TabId, editor: TextEditor): () => void {
        const token = `domain-session-${this.workspace.allocateIdentity()}`, revision = this.workspace.document(editor.view.documentId).revision;
        const data = this.data.get(editor.view) ?? { revision, owned: new Map<string, OwnedFold>(), annotations: noAnnotations };
        const layer = editor.decorations.add({ name: "domain annotations", order: 30 });
        this.data.set(editor.view, data); const session = { token, id, editor, layer, data, target: this.workspace.tabs.capture(tab) }, listeners = new AbortController(); this.sessions.set(token, session);
        const changed = () => { this.sync(session); if (this.job?.session === session && !this.current(this.job)) this.invalidate(this.job); };
        const stops = [this.workspace.observeDocument(editor.view.documentId).subscribe(changed), editor.view.folding.subscribe(changed), this.workspace.tabs.subscribe(changed), this.workspace.resourceForDocument(editor.view.documentId).metadata.subscribe(changed)];
        editor.input.addEventListener("focus", () => { this.active = session; this.sync(session); }, { signal: listeners.signal });
        for (const event of ["compositionstart", "beforeinput", "paste", "cut"] as const) editor.input.addEventListener(event, () => {
            if (this.job?.session.editor.view.documentId === editor.view.documentId) this.cancel();
        }, { signal: listeners.signal });
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
        if (session.editor.activity().composing || !this.canCapture(session.editor.view.documentId)) { this.publish({ message: "Finish pending typing or composition before a domain command." }); return false; }
        return true;
    }
    private current(job: Job): boolean {
        if (job.invalid || this.job !== job) return false;
        try {
            if (job.capture) return job.capture.isCurrent();
            // Analysis replaces fold metadata, so it needs the exact fold generation but allows selection movement.
            return this.available(job.session) && !job.session.editor.activity().composing && this.canCapture(job.session.editor.view.documentId)
                && this.workspace.document(job.session.editor.view.documentId).revision === job.input.revision
                && job.session.editor.view.folding.getSnapshot().generation === job.folds.generation && this.authority(job.session) === job.authority;
        } catch { return false; }
    }
    private invalidate(job: Job): void {
        job.invalid = true;
        // Core notifications cannot release resource leases. Latch now, clean up afterward.
        queueMicrotask(() => { if (this.job === job) this.cancel(); });
    }
    private release(job: Job): void {
        if (this.job === job) this.job = undefined;
        job.invalid = true; job.session.editor.element.ownerDocument.defaultView!.clearTimeout(job.timeout); job.abort.abort(); job.capture?.cancel(); job.lease?.release();
    }
    readonly cancel = (): void => {
        const job = this.job; if (!job) return; this.release(job); this.metrics.cancelled++;
        this.publish({ status: "cancelled", message: "Captured domain command cancelled; source and results are unchanged." });
    };
    readonly discover = (): void => this.start("analyze");
    readonly insertImport = (): void => this.start("import");
    private start(kind: DomainInput["kind"]): void {
        const session = this.active; if (!this.guard(session)) return;
        if (kind === "import" && !this.editable(session)) { this.publish({ message: "Import insertion requires an editable source." }); return; }
        this.cancel(); this.sync(session);
        const document = this.workspace.document(session.editor.view.documentId), resource = this.workspace.resourceForDocument(document.id), win = session.editor.element.ownerDocument.defaultView!;
        const capture = kind === "import" ? captureViewRequest(this.workspace, session.target, session.editor.view, { editOrigin: "human",
            available: () => this.available(session) && !session.editor.activity().composing && this.canCapture(document.id) }) : undefined;
        if (kind === "import" && !capture) { this.publish({ message: "The source changed before capture; request a fresh import." }); return; }
        const job: Job = { session, input: { id: ++this.serial, revision: document.revision, buffer: document.buffer, kind, module: "catalogue" }, folds: session.editor.view.folding.getSnapshot(),
            capture, authority: this.authority(session), lease: capture ? undefined : this.workspace.acquire(resource.id), abort: new AbortController(), timeout: 0, invalid: false };
        this.job = job; this.metrics.requested++;
        const changed = () => { if (this.job === job && !this.current(job)) this.invalidate(job); };
        // Mounted presentation listeners already observe analysis resource/fold/tab changes.
        capture?.signal.addEventListener("abort", changed, { once: true });
        job.timeout = win.setTimeout(() => { if (this.job === job) { this.release(job); this.publish({ status: "failed", message: "Domain command timed out; source is unchanged." }); } }, 30000);
        this.publish({ status: "running", message: kind === "analyze" ? `Discovering domain regions in ${session.id}.` : `Preparing a captured import for ${session.id}.`, work: 0, total: document.buffer.length });
        const progress = (units: number) => { if (this.current(job) && Number.isSafeInteger(units) && units >= this.cell.get().work && units <= document.buffer.length) this.publish({ work: units }); };
        void Promise.resolve().then(() => this.provider.run(job.input, job.abort.signal, progress)).then(value => {
            if (!this.current(job)) { this.metrics.stale++; if (this.job === job) this.cancel(); return; }
            const result = validateDomainResult(value, job.input);
            createFoldRegions(document.buffer, result.folds);
            if (kind === "import") {
                if (!job.capture?.commit(() => {
                    const applied = this.workspace.edit({ documentId: document.id, expectedRevision: job.input.revision, origin: "human",
                        source: "import", view: session.editor.view, edits: result.edits, history: { kind: "refactor" } });
                    if (!applied.applied) throw new Error(`Import rejected: ${applied.reason}.`); return true;
                })) throw new Error("Captured import context changed before application.");
                this.metrics.applied++; this.release(job);
                for (const attached of this.sessions.values()) if (attached.editor.view.documentId === document.id) this.sync(attached);
                session.editor.viewport.revealOffset(session.editor.view.getSnapshot().selection.head);
                this.publish({ status: "applied", message: result.edits.length ? `Inserted the captured import in ${session.id}.` : "The requested import is already present; source and history are unchanged." });
            } else {
                const owned = new Set([...session.data.owned.values()].map(value => value.id)), existing = job.folds.regions.filter(r => !owned.has(r.id)), ids = new Set(job.folds.regions.map(r => r.id));
                const next = new Map<string, OwnedFold>(), ranges: FoldRange[] = [...existing];
                for (const fold of result.folds) {
                    let id = session.data.owned.get(fold.id)?.id; if (!id) { do { id = `host-domain-${++this.foldSerial}`; } while (ids.has(id)); ids.add(id); }
                    next.set(fold.id, { id, from: fold.from, to: fold.to }); ranges.push({ ...fold, id });
                }
                const normalized = createFoldRegions(document.buffer, ranges, job.folds.regions);
                if (!session.editor.view.folding.setRanges(job.folds, normalized)) throw new Error("Domain fold capture expired.");
                if (!this.available(session)) return;
                session.data.owned = next; session.data.annotations = result.annotations; this.showAnnotations(session);
                this.metrics.applied++; this.release(job); this.publish({ status: "ready", message: `Discovered ${result.folds.length} domain regions in ${session.id}.` });
            }
        }).catch(error => {
            if (this.job !== job) return; this.metrics.invalid++; this.release(job);
            this.publish({ status: "failed", message: error instanceof Error && error.message.length <= 256 ? error.message : "Invalid domain result; source and prior results are unchanged." });
        }).finally(() => { if (this.job === job) this.release(job); });
    }
    readonly collapse = (): void => {
        const session = this.active; if (!this.guard(session)) return; this.cancel(); this.sync(session);
        const document = this.workspace.document(session.editor.view.documentId), current = session.editor.view.folding.getSnapshot(), owned = new Set([...session.data.owned.values()].map(r => r.id));
        const ranges = current.regions.map(r => owned.has(r.id) ? { ...r, collapsed: true } : r), index = new FoldIndex(document.buffer.lineCount, ranges), selected = session.editor.view.getSnapshot().selectionSet;
        const selections = createSelectionSet(document.buffer.length, selected.ranges.map(range => {
            const a = index.hiddenBy(document.buffer.lineAt(range.anchor)), h = index.hiddenBy(document.buffer.lineAt(range.head));
            return a || h ? { anchor: a ? document.buffer.offsetAt(a.lineFrom) : range.anchor, head: h ? document.buffer.offsetAt(h.lineFrom) : range.head } : range;
        }), selected.primary);
        session.editor.view.setSelections(document.revision, selections.ranges, selections.primary);
        if (session.editor.view.folding.setRanges(current, ranges)) this.publish({ message: "Discovered domain regions collapsed; manual fold state is preserved." });
        session.editor.focus();
    };
    reveal(token: string, revision: number, id: string): void {
        const session = this.sessions.get(token); if (!this.guard(session) || session.data.revision !== revision || this.workspace.document(session.editor.view.documentId).revision !== revision) return;
        const annotation = session.data.annotations.find(item => item.id === id); if (!annotation) return;
        if (!session.editor.view.setSelection(revision, { anchor: annotation.from, head: annotation.to })) return;
        session.editor.viewport.revealOffset(annotation.from); session.editor.focus();
    }
    debug() { return { ...this.metrics, subscriptions: this.cell.count(), pending: this.job !== undefined, provider: { ...this.fixture.metrics }, active: this.active?.id ?? null,
        sessions: [...this.sessions.values()].map(s => ({ id: s.id, token: s.token, revision: s.data.revision, annotations: s.data.annotations.length, folds: s.data.owned.size })) }; }
    dispose(): void { if (this.disposed) return; this.cancel(); this.disposed = true; this.active = undefined; this.data = new WeakMap(); this.publish(); }
}
