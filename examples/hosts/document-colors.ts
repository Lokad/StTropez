import type { DocumentId, DocumentSnapshot, ResourceLease, TabId, TabTarget, TextBuffer, Workspace } from "../../src/index.ts";
import { captureViewRequest } from "../../src/browser/index.ts";
import type { CapturedViewRequest, EditingCandidate } from "../../src/browser/index.ts";
import type { EditingPresentation } from "../editing/presentation.ts";
import { createNavigationClient } from "../editing/navigation-client.ts";
import { navigationMetrics } from "../editing/navigation-service.ts";
import { colorLimits, parseColor, rgbaColor, sameColor, validateColorsInput, validateColorPresentationInput } from "../../fixtures/language/colors.ts";
import type { ColorFault, ColorsInput, ColorsResult, ColorReference, ColorPresentationInput, ColorPresentationsResult } from "../../fixtures/language/colors.ts";
import { DomainAnnotationIndex } from "../../fixtures/language/domain.ts";
import { renameSelections } from "../../fixtures/language/rename.ts";
import { HostCell } from "../shared/observable.ts";
type HostColorPresentations = Omit<ColorPresentationsResult, "presentations"> & Readonly<{ presentations: readonly (Omit<ColorPresentationsResult["presentations"][number], "id"> & Readonly<{ id: string }>)[] }>;
export type ColorBackend = Readonly<{ colors: (input: ColorsInput, buffer: TextBuffer, progress: (work: number) => void) => Promise<ColorsResult>;
    colorPresentations: (input: ColorPresentationInput, buffer: TextBuffer) => Promise<HostColorPresentations>; isCurrent?: () => boolean; faultIdle?: () => boolean;
    snapshot: () => Readonly<{ connected: boolean; busy: boolean; transport?: string }>; dispose: () => void }>;
export type ColorBackendFactory = (clock: Window, changed: () => void) => ColorBackend;
type Session = { token: number; id: string; target: TabTarget; editor: EditingCandidate; presentation: EditingPresentation };
type Preview = { input: ColorPresentationInput; capture: CapturedViewRequest; timer: number; invalid: boolean; result: HostColorPresentations | undefined; choice: string };
type Job = { origin: Session; input: ColorsInput; document: DocumentSnapshot; capture: CapturedViewRequest; authority: string; lease: ResourceLease | undefined; stops: (() => void)[]; timer: number; invalid: boolean;
    colors: readonly ColorReference[] | undefined; index: DomainAnnotationIndex | undefined; selected: number; preview: Preview | undefined };
export type ColorNote = ColorReference & Readonly<{ ordinal: number; line: number; column: number; css: string }>;
export type ColorEditNote = Readonly<{ document: string; resource: string; title: string; revision: number; from: number; to: number; insert: string; context: string }>;
export type DocumentColorsSnapshot = Readonly<{ available: boolean; connected: boolean; disconnected: boolean; pending: boolean; token: number | null; previewToken: number | null; view: string | null;
    status: "idle" | "scan" | "colors" | "presentations" | "applied" | "expired" | "failed"; message: string; work: number; total: number; count: number; page: number; colors: readonly ColorNote[];
    selected: number; value: string; css: string | null; presentation: string; choices: readonly Readonly<{ id: string; label: string }>[]; edits: readonly ColorEditNote[]; canPreview: boolean; canApply: boolean;
    changed: Readonly<{ document: DocumentId; title: string }> | null }>;
let serial = 0;
/** Captured color literals and explicit host presentation edits; source text remains the authority. */
export class HostDocumentColors {
    private readonly workspace: Workspace;
    private readonly canCapture: (id: DocumentId) => boolean;
    private readonly present: (id: DocumentId) => EditingCandidate | undefined;
    private readonly sessions = new Map<number, Session>();
    private active: Session | undefined;
    private job: Job | undefined;
    private client: ColorBackend | undefined;
    private readonly factory: ColorBackendFactory | undefined;
    private valueInput: HTMLInputElement | undefined;
    private list: HTMLElement | undefined;
    private fieldEvents: AbortController | undefined;
    private listEvents: AbortController | undefined;
    private sequence = 0;
    private disposed = false;
    private disconnected = false;
    private publishing = false;
    private dropping = false;
    private delay = 0;
    private fault: ColorFault | undefined;
    private readonly worker = navigationMetrics();
    private readonly metrics = { requested: 0, previews: 0, applied: 0, unchanged: 0, cancelled: 0, expired: 0, failed: 0 };
    private readonly cell = new HostCell<DocumentColorsSnapshot>({ available: false, connected: false, disconnected: false, pending: false, token: null, previewToken: null, view: null, status: "idle", message: "Focus a source to discover color literals.", work: 0, total: 0, count: 0, page: 0, colors: [], selected: -1, value: "", css: null, presentation: "", choices: [], edits: [], canPreview: false, canApply: false, changed: null });
    readonly state = this.cell.observable;
    private readonly reconnectProvider: (() => void) | undefined;
    constructor(workspace: Workspace, canCapture: (id: DocumentId) => boolean, present: (id: DocumentId) => EditingCandidate | undefined, factory?: ColorBackendFactory, reconnectProvider?: () => void) { this.reconnectProvider = reconnectProvider; this.workspace = workspace; this.canCapture = canCapture; this.present = present; this.factory = factory; }
    private available(s: Session): boolean { const tab = this.workspace.resolveTab(s.target); return !this.disposed && this.sessions.get(s.token) === s && s.editor.element.isConnected && !s.editor.activity().disposed && this.workspace.ownsDocumentView(s.editor.view)
        && tab?.surface.kind === "text" && tab.surface.documentId === s.editor.view.documentId && !!this.workspace.observeDocument(s.editor.view.documentId).getSnapshot(); }
    private authority(id: DocumentId): string { const m = this.workspace.resourceForDocument(id).metadata.getSnapshot(); return JSON.stringify([m.state, m.capabilities.edit, m.editLock]); }
    private editable(id: DocumentId): boolean { const m = this.workspace.resourceForDocument(id).metadata.getSnapshot(); return m.capabilities.edit.includes("human") && m.capabilities.edit.includes("host") && m.editLock === null; }
    private capture(origin: Session): CapturedViewRequest | undefined { return captureViewRequest(this.workspace, origin.target, origin.editor.view,
        { available: () => this.available(origin) && this.canCapture(origin.editor.view.documentId) }); }
    private current(job: Job): boolean { try { return this.job === job && !job.invalid && this.available(job.origin) && this.workspace.observeDocument(job.document.id).getSnapshot()?.revision === job.document.revision && this.authority(job.document.id) === job.authority && this.canCapture(job.document.id)
        && (this.client?.isCurrent?.() ?? true) && (!!job.colors || job.capture.isCurrent()); } catch { return false; } }
    private currentPreview(job: Job, preview: Preview): boolean { try { const proposed = parseColor(this.cell.get().value); return this.current(job) && job.preview === preview && !preview.invalid && !!proposed && sameColor(proposed, preview.input.proposed)
        && preview.capture.isCurrent(); } catch { return false; } }
    private publish(patch: Partial<DocumentColorsSnapshot> = {}): void {
        const s = { ...this.cell.get(), ...patch }, job = this.job, preview = job?.preview, proposed = parseColor(s.value), choice = preview?.result?.presentations.find(p => p.id === preview.choice);
        const colors = job?.colors?.slice(s.page * colorLimits.page, (s.page + 1) * colorLimits.page).map((color, i) => { const line = job.document.buffer.lineAt(color.from); return { ...color, ordinal: s.page * colorLimits.page + i, line: line + 1, column: color.from - job.document.buffer.offsetAt(line) + 1, css: rgbaColor(color.color) }; }) ?? [];
        const edits = choice ? choice.edits.flatMap(at => at.edits.map(edit => ({ ...edit, document: at.document, resource: job!.document.resourceId, title: job!.document.title.slice(0, 128), revision: at.revision, context: job!.document.buffer.slice(Math.max(0, edit.from - 32), Math.min(job!.document.buffer.length, edit.from + 32)) }))) : [];
        this.cell.set({ ...s, available: !!this.active && this.available(this.active), connected: this.client?.snapshot().connected ?? false, disconnected: this.disconnected,
            pending: !!job && (!job.colors || !!preview && !preview.result), token: job?.input.id ?? null, previewToken: preview?.input.id ?? null, view: job?.origin.id ?? null, count: job?.colors?.length ?? 0, colors,
            selected: job?.selected ?? -1, css: proposed ? rgbaColor(proposed) : null, presentation: choice?.id ?? "", choices: preview?.result?.presentations.map(p => ({ id: p.id, label: p.label })) ?? [], edits,
            canPreview: !!job?.colors?.[job.selected] && !!proposed && this.current(job) && (!preview || !!preview.result),
            canApply: !!job && !!choice && !!preview && this.currentPreview(job, preview) && this.editable(job.document.id) });
    }
    private sync(s: Session): void { const job = this.job, colors = job?.index && job.document.id === s.editor.view.documentId && this.workspace.observeDocument(job.document.id).getSnapshot()?.revision === job.document.revision ? { revision: job.document.revision, index: job.index } : undefined;
        if (!colors && !s.presentation.colors) return; s.presentation.colors = colors; s.editor.viewport.invalidate(); }
    private syncAll(): void { for (const s of this.sessions.values()) this.sync(s); }
    private drop(): void { const client = this.client; this.client = undefined; this.dropping = true; try { client?.dispose(); } finally { this.dropping = false; } }
    private clearPreview(job: Job): void { const preview = job.preview; job.preview = undefined; if (!preview) return; preview.invalid = true; job.origin.editor.element.ownerDocument.defaultView!.clearTimeout(preview.timer);
        preview.capture.cancel();
        if (!preview.result) { this.drop(); if (this.factory && this.job === job) this.release(); } }
    private release(): void { const job = this.job; this.job = undefined; if (!job) return; job.invalid = true; this.clearPreview(job); job.origin.editor.element.ownerDocument.defaultView!.clearTimeout(job.timer); job.stops.splice(0).forEach(stop => stop()); job.capture.cancel(); job.lease?.release(); if (!job.colors) this.drop(); this.syncAll(); }
    readonly cancel = (): void => { if (this.job) this.metrics.cancelled++; this.release(); this.publish({ status: "idle", message: "Color references and presentation preview dismissed.", work: 0, total: 0, page: 0 }); };
    readonly disconnect = (): void => { this.cancel(); this.drop(); this.disconnected = true; this.publish({ message: "Color provider disconnected; local editing remains available." }); };
    readonly reconnect = (): void => { this.cancel(); this.drop(); this.disconnected = false; this.reconnectProvider?.(); this.publish({ message: "Discover fresh colors." }); };
    private connectionChanged(): void { if (this.dropping) return; if (this.job && !this.current(this.job)) { this.changed(this.job); return; }
        if (this.client && !this.client.snapshot().connected && !this.client.snapshot().busy) { const job = this.job; if (job) this.clearPreview(job); this.drop(); this.publish({ status: "failed", message: "Color connection failed; request a fresh preview or rediscover." }); } else this.publish(); }
    private changed(job: Job): void {
        if (this.publishing || this.job !== job) return;
        if (!this.current(job)) { job.invalid = true; queueMicrotask(() => { if (this.job === job) { this.release(); this.metrics.expired++; this.publish({ status: "expired", message: "Captured resource, revision, authority or view changed; rediscover colors." }); } }); }
        else if (job.preview && !this.currentPreview(job, job.preview)) { const preview = job.preview; preview.invalid = true; queueMicrotask(() => { if (this.job === job && job.preview === preview) { this.clearPreview(job); this.publish({ status: "colors", message: "Selection or folds changed; preview a fresh presentation." }); } }); }
    }
    readonly bindList = (list: HTMLElement | null): void => { this.listEvents?.abort(); this.listEvents = undefined; this.list = list ?? undefined; if (!list || this.disposed) return; const events = new AbortController(); this.listEvents = events;
        list.addEventListener("keydown", event => { if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return; event.preventDefault(); event.stopPropagation(); const origin = this.job?.origin; this.cancel(); if (origin && this.available(origin)) origin.editor.focus(); }, { signal: events.signal }); };
    readonly bindValue = (input: HTMLInputElement | null): void => { this.fieldEvents?.abort(); this.fieldEvents = undefined; this.valueInput = input ?? undefined; if (!input || this.disposed) return; const events = new AbortController(); this.fieldEvents = events;
        input.addEventListener("keydown", event => { if (event.defaultPrevented || event.isComposing) return; if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); const origin = this.job?.origin ?? this.active; this.cancel(); if (origin && this.available(origin)) origin.editor.focus(); }
            else if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) { event.preventDefault(); this.preview(); } }, { signal: events.signal }); };
    setValue(value: string): void { if (value === this.cell.get().value) return; if (this.job) this.clearPreview(this.job); this.publish({ value: value.slice(0, colorLimits.literal + 1), status: this.job?.colors ? "colors" : "idle", message: this.job ? "Proposed color changed; preview before confirming." : "Proposed color changed; discover colors before previewing." }); }
    attach(id: string, tab: TabId, editor: EditingCandidate, presentation: EditingPresentation): () => void {
        const s = { token: ++serial, id, target: this.workspace.captureTab(tab), editor, presentation }, events = new AbortController(); this.sessions.set(s.token, s); this.sync(s);
        editor.input.addEventListener("focus", () => { this.active = s; this.publish(); }, { signal: events.signal });
        editor.input.addEventListener("keydown", event => { if (event.defaultPrevented || event.isComposing || editor.activity().composing || event.key !== "F6" || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return; event.preventDefault(); event.stopImmediatePropagation(); this.active = s; this.start(true); }, { capture: true, signal: events.signal });
        for (const event of ["beforeinput", "compositionstart", "paste", "cut"] as const) editor.input.addEventListener(event, () => { if (this.job?.document.id === editor.view.documentId) this.cancel(); }, { signal: events.signal });
        let detached = false; return () => { if (detached) return; detached = true; if (this.job?.origin === s) this.cancel(); events.abort(); this.sessions.delete(s.token); presentation.colors = undefined; if (this.active === s) this.active = undefined; if (!this.sessions.size) this.drop(); this.publish(); };
    }
    readonly discover = (): void => this.start(false);
    private start(keyboard: boolean): void {
        const origin = this.active; if (this.disconnected || !origin || !this.available(origin)) { this.publish({ message: "Focus an available source and reconnect first." }); return; }
        if (!this.canCapture(origin.editor.view.documentId)) { this.publish({ message: "Finish pending input, navigation, table conversion or composition first." }); return; }
        this.cancel(); const doc = this.workspace.document(origin.editor.view.documentId), selected = origin.editor.view.getSnapshot(); let input: ColorsInput;
        try { if (doc.key.variant !== "working") throw new Error("Only a working source can publish colors."); input = validateColorsInput({ id: ++this.sequence, document: doc.id, revision: doc.revision, length: doc.buffer.length, delay: this.delay, ...(this.fault ? { fault: this.fault } : {}) }); }
        catch (error) { this.fault = undefined; this.publish({ status: "failed", message: error instanceof Error ? error.message : "Invalid color capture." }); return; }
        this.fault = undefined; const capture = this.capture(origin);
        if (!capture) { this.publish({ message: "The source changed before capture; discover fresh colors." }); return; }
        const win = origin.editor.element.ownerDocument.defaultView!, job: Job = { origin, input, document: doc, capture, authority: this.authority(doc.id), lease: undefined, stops: [], timer: 0, invalid: false, colors: undefined, index: undefined, selected: -1, preview: undefined };
        this.job = job; this.metrics.requested++;
        try {
            const changed = () => this.changed(job); capture.signal.addEventListener("abort", changed, { once: true });
            job.timer = win.setTimeout(() => { if (this.job === job && !job.colors) { this.release(); this.metrics.failed++; this.publish({ status: "failed", message: "Color discovery timed out; source is unchanged." }); } }, 30000);
            this.publish({ status: "scan", message: `Discovering bounded color literals from ${origin.id}.`, page: 0, work: 0, total: doc.buffer.length }); this.ensureClient(win);
            void this.client!.colors(input, doc.buffer, work => { if (this.current(job)) this.publish({ work }); }).then(result => {
                if (!this.current(job)) { this.changed(job); return; }
                // Ready references outlive view movement. Retain their resource before ending discovery capture.
                job.lease = this.workspace.acquire(doc.resourceId);
                job.stops.push(this.workspace.observeDocument(doc.id).subscribe(changed), this.workspace.resourceForDocument(doc.id).metadata.subscribe(changed), this.workspace.tabState.subscribe(changed));
                job.colors = result.colors; job.index = new DomainAnnotationIndex(result.colors.map((color, i) => ({ id: `color-${i}`, from: color.from, to: color.to, label: color.label }))); win.clearTimeout(job.timer); capture.cancel();
                const at = result.colors.findIndex(c => c.from <= selected.selection.head && selected.selection.head <= c.to); job.selected = result.colors.length ? Math.max(0, at) : -1; this.syncAll();
                const color = result.colors[job.selected]; this.publish({ status: "colors", message: `${result.colors.length} color literals. Inspect one, preview presentations and confirm explicitly.`, work: this.factory ? 0 : input.length, page: job.selected < 0 ? 0 : Math.floor(job.selected / colorLimits.page), value: color ? this.factory ? rgbaColor(color.color) : color.text : "" });
                if (keyboard && this.job === job && this.current(job) && this.list?.isConnected && win.document.activeElement === origin.editor.input) this.list.focus();
            }).catch(error => { if (this.job !== job) return; this.release(); this.drop(); this.metrics.failed++; this.publish({ status: "failed", message: error instanceof Error ? error.message : "Color discovery failed." }); });
        } catch (error) { this.release(); this.drop(); this.metrics.failed++; this.publish({ status: "failed", message: error instanceof Error ? error.message : "Color provider unavailable." }); }
    }
    inspect(token: number | null, ordinal: number): void { const job = this.job; if (!job?.colors || token !== job.input.id || !Number.isSafeInteger(ordinal) || !job.colors[ordinal] || !this.current(job)) return; this.clearPreview(job); if (this.job !== job) return; job.selected = ordinal; const color = job.colors[ordinal]!, value = this.factory ? rgbaColor(color.color) : color.text; this.publish({ status: "colors", value, message: "Inspecting a captured color. Edit the host value and preview before confirming." }); if (this.valueInput) { this.valueInput.value = value; this.valueInput.focus(); this.valueInput.select(); } }
    readonly preview = (): void => {
        const job = this.job, proposed = parseColor(this.cell.get().value); if (!job?.colors?.[job.selected] || !this.current(job) || !proposed) { this.publish({ message: "Discover a source color and enter a supported proposed literal first." }); return; }
        if (job.preview && !job.preview.result) { this.publish({ message: "Finish the current presentation request or change the proposed value and rediscover." }); return; }
        this.clearPreview(job); let input: ColorPresentationInput;
        try { const value = { ...job.input, id: ++this.sequence, discovery: job.input.id, reference: job.colors[job.selected]!, proposed, delay: this.delay, ...(this.fault ? { fault: this.fault } : {}) }; input = this.factory ? Object.freeze(value) : validateColorPresentationInput(value, job.document.buffer); }
        catch (error) { this.fault = undefined; this.publish({ status: "failed", message: error instanceof Error ? error.message : "Invalid presentation capture." }); return; }
        this.fault = undefined; const capture = this.capture(job.origin);
        if (!capture) { this.publish({ message: "The source changed before capture; request a fresh presentation." }); return; }
        const preview: Preview = { input, capture, timer: 0, invalid: false, result: undefined, choice: "rgba" }; job.preview = preview; this.metrics.previews++; const win = job.origin.editor.element.ownerDocument.defaultView!;
        capture.signal.addEventListener("abort", () => this.changed(job), { once: true });
        preview.timer = win.setTimeout(() => { if (this.job === job && job.preview === preview && !preview.result) { this.clearPreview(job); this.metrics.failed++; this.publish({ status: "failed", message: "Presentation timed out; validated color references remain available." }); } }, 30000);
        this.publish({ status: "presentations", message: "Waiting for captured color presentation edits." }); this.ensureClient(win);
        void this.client!.colorPresentations(input, job.document.buffer).then(result => { if (!this.currentPreview(job, preview)) { this.changed(job); return; } preview.result = result; preview.choice = result.presentations[0]?.id ?? ""; win.clearTimeout(preview.timer); this.publish({ status: "presentations", message: result.presentations.length ? "Review every proposed edit and presentation before confirming." : "No provider presentation for the captured color." }); })
            .catch(error => { if (this.job !== job || job.preview !== preview) return; this.clearPreview(job); this.drop(); this.metrics.failed++; this.publish({ status: "failed", message: error instanceof Error ? error.message : "Color presentation failed; source is unchanged." }); });
    };
    private ensureClient(win: Window): void { this.client ??= this.factory ? this.factory(win, () => this.connectionChanged()) : createNavigationClient(win, this.worker, undefined, () => this.connectionChanged()); }
    setPresentation(id: string): void { const job = this.job, preview = job?.preview; if (!job || !preview?.result || !this.currentPreview(job, preview) || !preview.result.presentations.some(p => p.id === id)) return; preview.choice = id; this.publish(); }
    apply(token: number | null, previewToken: number | null, id: string): void {
        const job = this.job, preview = job?.preview, choice = preview?.result?.presentations.find(p => p.id === id);
        if (!job || !preview || !choice || token !== job.input.id || previewToken !== preview.input.id || id !== preview.choice || !this.currentPreview(job, preview) || !this.editable(job.document.id)) { this.publish({ message: "Use a fresh applicable presentation with edit permission." }); return; }
        this.publishing = true;
        try {
            if (!preview.capture.commit(() => {
                const result = this.workspace.editDocuments(choice.edits.map(at => ({ documentId: job.document.id, expectedRevision: at.revision, edits: at.edits, origin: "host" as const, history: { kind: "refactor" as const }, view: job.origin.editor.view, selectionSet: renameSelections(job.document.buffer.length, preview.capture.selectionSet, at.edits) })));
                if (!result.applied) throw new Error(result.reason); return true;
            })) throw new Error("Captured color presentation changed before application.");
            const changed = this.workspace.document(job.document.id).revision !== job.document.revision; if (changed) this.metrics.applied++; else this.metrics.unchanged++; this.release();
            this.publish({ status: "applied", message: changed ? "Applied the captured color presentation as one shared undo command." : "Presentation already matches; text and history are unchanged.", changed: { document: job.document.id, title: job.document.title.slice(0, 128) } });
            if (this.available(job.origin)) { job.origin.editor.viewport.revealOffset(job.origin.editor.view.getSnapshot().selection.head); job.origin.editor.focus(); }
        } catch (error) { this.release(); this.publish({ status: "failed", message: error instanceof Error ? error.message : "Color edit rejected; source is unchanged." }); }
        finally { this.publishing = false; }
    }
    readonly openChanged = (document: DocumentId): void => { if (this.disposed || this.job || this.cell.get().changed?.document !== document || !this.canCapture(document)) return; try { const editor = [...this.sessions.values()].find(s => s.editor.view.documentId === document && this.available(s))?.editor ?? this.present(document); editor?.focus(); } catch { this.publish({ message: "The changed color resource is no longer available." }); } };
    readonly nextPage = (): void => { const s = this.cell.get(); if ((s.page + 1) * colorLimits.page < s.count) this.publish({ page: s.page + 1 }); };
    readonly previousPage = (): void => { const s = this.cell.get(); if (s.page) this.publish({ page: s.page - 1 }); };
    setDelay(value: number): void { if (!Number.isFinite(value) || value < 0 || value > 1000) throw new RangeError("Invalid color delay."); this.delay = value; }
    faultNext(value: ColorFault): void { this.fault = value; }
    faultIdle(): boolean { return this.client?.faultIdle?.() ?? false; }
    debug() { const job = this.job; return { ...this.metrics, worker: { ...this.worker }, state: this.cell.get(), capture: job ? { input: job.input, view: job.origin.id, selections: (job.preview?.capture ?? job.capture).selectionSet } : null, transport: this.client?.snapshot() ?? null, sessions: this.sessions.size, subscriptions: this.cell.count(), decoratedViews: [...this.sessions.values()].filter(s => !!s.presentation.colors).length, disposed: this.disposed }; }
    dispose(): void { if (this.disposed) return; this.cancel(); this.drop(); this.bindList(null); this.bindValue(null); this.disposed = true; this.active = undefined; this.publish({ changed: null }); }
}
