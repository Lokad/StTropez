import type { TextEdit } from "./changes.ts";
import { textDifference } from "./changes.ts";
import { TextBuffer } from "./text-buffer.ts";
import { composePositionMaps } from "./positions.ts";
import type { PositionMapping } from "./positions.ts";
import { TextHistory, validateHistory } from "./history.ts";
import type { EditKind, HistoryChange, HistoryOptions, HistorySnapshot, Selection } from "./history.ts";
import { NotificationScope, Store } from "./observable.ts";
import type { Observable } from "./observable.ts";
import { equalValue, snapshotValue } from "./values.ts";
import type { Immutable, SnapshotValue } from "./values.ts";
import { emptyAgentState, sameProposal } from "./agent.ts";
import type { AcknowledgementState, AcknowledgementSubmission, AcknowledgementTicket, AgentAssociation, AgentRequest,
    AgentSnapshot, ProposalGuard, ProposalTarget, ProposedEdits } from "./agent.ts";

export type ResourceId = string & { readonly resourceId: unique symbol };
export type DocumentId = string & { readonly documentId: unique symbol };
export type TabId = string & { readonly tabId: unique symbol };
export type ViewId = string & { readonly viewId: unique symbol };
export type PaneId = string;
export type ResourceKey = Readonly<{ scope: string; resource: string; variant: string }>;
export type EditOrigin = "human" | "agent" | "host";
export type Capabilities = Readonly<{ edit: readonly EditOrigin[]; save: boolean; run: boolean }>;
export type ResourceMetadata = Readonly<{
    id: ResourceId; key: ResourceKey; title: string; kind: "text" | "panel";
    state: "loading" | "ready" | "failed" | "released";
    dirty: boolean; serverVersion: string | null; capabilities: Capabilities;
    saveStatus: "idle" | "saving" | "failed" | "conflict"; failure: string | null;
    editLock: Readonly<{ owner: string; origin: EditOrigin }> | null;
}>;
export type ResourceSnapshot<T> = Readonly<{ revision: number; metadata: ResourceMetadata }> & Readonly<
    { state: "ready"; value: Immutable<T> } | { state: "loading" | "failed" | "released" }
>;
export type ResourceHandle<T extends SnapshotValue> = Observable<ResourceSnapshot<T>> & Readonly<{
    id: ResourceId; metadata: Observable<ResourceMetadata>;
}>;
export type TextResourceHandle = ResourceHandle<string> & Readonly<{ documentId: DocumentId }>;
export type LoadedResource<T> = Readonly<{ value: T; serverVersion?: string | null }>;
export type LoadedTextBuffer = Readonly<{ buffer: TextBuffer; serverVersion?: string | null }>;
export type DocumentSnapshot = Readonly<{
    id: DocumentId; resourceId: ResourceId; key: ResourceKey; title: string; buffer: TextBuffer; text: string; revision: number;
    change: DocumentChange | null;
}>;
export type DocumentChange = Readonly<{ previousRevision: number; transactionId: number; origin: EditOrigin;
    kind: EditKind | "undo" | "redo"; mapping: PositionMapping }>;
export type DocumentViewSnapshot = Readonly<{ documentId: DocumentId; revision: number; selection: Selection }>;
export type DocumentView = Observable<DocumentViewSnapshot> & Readonly<{ id: ViewId; documentId: DocumentId;
    setSelection: (expectedRevision: number, selection: Selection) => boolean; dispose: () => void }>;
export type Surface = Readonly<
    { kind: "text"; documentId: DocumentId }
    | { kind: "panel"; resourceId: ResourceId; panelType: string }
>;
export type TabSnapshot = Readonly<{ id: TabId; paneId: PaneId; generation: number; surface: Surface }>;
export type WorkspaceSnapshot = Readonly<{
    revision: number; resources: readonly ResourceMetadata[];
    documents: readonly DocumentSnapshot[]; tabs: readonly TabSnapshot[];
}>;
export type TabTarget = Readonly<{ workspace: symbol; id: TabId; generation: number }>;
export type ResourceTarget = Readonly<{ workspace: symbol; id: ResourceId }>;
export type ResourceLease = Readonly<{ resourceId: ResourceId; active: () => boolean; release: () => void }>;
export type EditLease = ResourceLease & Readonly<{ origin: EditOrigin }>;
export type Operation = Readonly<{
    target: ResourceTarget; revision: number; generation: number;
    isCurrent: () => boolean; isCancelled: () => boolean; presentationCurrent: () => boolean;
    cancel: () => void; finish: () => void;
}>;
export type LoadOperation<T> = Operation & Readonly<{
    accept: (loaded: LoadedResource<T>) => boolean; fail: (message: string) => boolean;
}>;
export type CloseIntent = Readonly<{ tab: TabTarget; resource: ResourceTarget; revision: number; dirty: boolean }>;
export type CloseOperation = Operation & Readonly<{ intent: CloseIntent; complete: (decision: "keep-open" | "close") => boolean }>;
export type SaveSubmission<T> = Readonly<{ id: string; target: ResourceTarget; key: ResourceKey;
    revision: number; value: Immutable<T>; expectedServerVersion: string | null; proposal: ProposalTarget | null }>;
/** Host-confirmed remote version for saving the explicitly reviewed local revision. No baseline adoption. */
export type SaveReview = Readonly<{ target: ResourceTarget; expectedRevision: number; expectedServerVersion: string }>;
export type SaveReceipt<T> = Readonly<{ submission: SaveSubmission<T>; savedValue: Immutable<T>; serverVersion: string;
    canonicalApplied: boolean; acknowledgementId: string | null }>;
export type SaveTicket<T> = Readonly<{ target: ResourceTarget; revision: number; value: Immutable<T>;
    start: () => SaveSubmission<T>; accept: (response: Readonly<{ serverVersion: string; canonical?: T }>) => SaveReceipt<T>;
    conflict: () => void; fail: () => void; finish: () => void }>;
export type EditRequest = Readonly<{
    documentId: DocumentId; expectedRevision: number; edits: readonly TextEdit[]; origin: EditOrigin; lease?: EditLease;
    history?: Readonly<{ kind: EditKind; group?: string }>; view?: DocumentView; selection?: Selection;
}>;
export type ChangeResult = Readonly<{ applied: true; revision: number } | { applied: false;
    reason: "missing-resource" | "missing-document" | "stale-revision" | "not-ready" | "read-only" | "edit-locked" | "stale-proposal" | "stale-association" | "history-empty" | "history-blocked" }>;
export type EditResult = ChangeResult;
export type BatchEditResult = Readonly<{ applied: true; revisions: readonly Readonly<{ documentId: DocumentId; revision: number }>[] }
    | { applied: false; reason: Extract<ChangeResult, { applied: false }>["reason"] }>;
export type HistoryRequest = Readonly<{ documentId: DocumentId; expectedRevision: number; origin?: EditOrigin; lease?: EditLease }>;
export type WorkspaceOptions = Readonly<{ onListenerError?: (error: unknown) => void; history?: HistoryOptions }>;

type ResourceRecord = {
    handle: ResourceHandle<SnapshotValue>; documentId: DocumentId | null;
    state: Store<ResourceSnapshot<SnapshotValue>>; metadata: Store<ResourceMetadata>;
    document: Store<DocumentSnapshot | undefined>; saved: SnapshotValue | undefined;
    buffer: TextBuffer | null; savedBuffer: TextBuffer | null; change: DocumentChange | null; history: Store<HistorySnapshot>;
    views: Map<ViewId, { handle: DocumentView; state: Store<DocumentViewSnapshot>; lease: ResourceLease }>;
    leases: Set<symbol>; operations: Map<string | symbol, Operation>; nextOperation: number;
    saveReservations: number; saving: symbol | null;
    editLease: EditLease | null; agent: Store<AgentSnapshot>; proposalLease: ResourceLease | null;
    agentRequest: Readonly<{ operation: Operation; lease: EditLease }> | null;
    acknowledgements: Map<string, { submission: AcknowledgementSubmission; state: AcknowledgementState; lease: ResourceLease }>;
};
const defaultCapabilities: Capabilities = Object.freeze({ edit: Object.freeze(["human", "agent", "host"] as const), save: true, run: true });
function capabilities(value: Capabilities): Capabilities {
    if (value.edit.some(origin => !["human", "agent", "host"].includes(origin))) throw new TypeError("Unknown edit origin.");
    return Object.freeze({ edit: Object.freeze([...new Set(value.edit)]), save: value.save, run: value.run });
}
function sameMetadata(a: ResourceMetadata, b: ResourceMetadata): boolean {
    return (Object.keys(a) as (keyof ResourceMetadata)[]).every(key => a[key] === b[key]);
}
function readySnapshot(metadata: ResourceMetadata, revision: number, value: SnapshotValue | TextBuffer): ResourceSnapshot<SnapshotValue> {
    if (!(value instanceof TextBuffer)) return Object.freeze({ state: "ready", revision, metadata, value });
    // History retains buffers, not these closures or their optional whole-text exports.
    let exported: string | undefined;
    return Object.freeze({ state: "ready", revision, metadata, get value() { exported ??= value.text(); return exported; } });
}
/** Preserve a lazy value descriptor through metadata-only commits. Object spread would export text. */
function withMetadata(state: ResourceSnapshot<SnapshotValue>, metadata: ResourceMetadata): ResourceSnapshot<SnapshotValue> {
    return Object.freeze(Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(state), metadata: { value: metadata, enumerable: true } })) as ResourceSnapshot<SnapshotValue>;
}
function selection(length: number, value: Selection): Selection {
    if (![value.anchor, value.head].every(offset => Number.isSafeInteger(offset) && offset >= 0 && offset <= length)) throw new RangeError("Selection is outside the document.");
    const anchorAffinity = value.anchorAffinity ?? (value.anchor <= value.head ? "after" : "before");
    const headAffinity = value.headAffinity ?? (value.anchor === value.head ? anchorAffinity : value.anchor < value.head ? "before" : "after");
    if (![anchorAffinity, headAffinity].every(side => side === "before" || side === "after")) throw new TypeError("Unknown selection affinity.");
    return Object.freeze({ anchor: value.anchor, head: value.head, anchorAffinity, headAffinity });
}
function mapSelection(mapping: PositionMapping, value: Selection): Selection {
    return selection(mapping.newLength, { ...value, anchor: mapping.map(value.anchor, value.anchorAffinity).offset, head: mapping.map(value.head, value.headAffinity).offset });
}
function sameSelection(a: Selection, b: Selection): boolean {
    return a.anchor === b.anchor && a.head === b.head && a.anchorAffinity === b.anchorAffinity && a.headAffinity === b.headAffinity;
}

/** Framework-free resource ownership and versioned transactions. All I/O is supplied by a host. */
export class Workspace {
    private readonly lifetime = Symbol("workspace");
    private readonly agentLane = Symbol("agent-request");
    private readonly acknowledgementLane = Symbol("acknowledgement");
    private nextId = 0;
    private nextTransaction = 0;
    private readonly history: TextHistory;
    private readonly scope: NotificationScope;
    private readonly records = new Map<ResourceId, ResourceRecord>();
    private readonly handles = new WeakMap<object, ResourceRecord>();
    private readonly documents = new Map<DocumentId, ResourceRecord>();
    private readonly tabs: Store<readonly TabSnapshot[]>;
    private readonly state: Store<WorkspaceSnapshot>;
    readonly getSnapshot: () => WorkspaceSnapshot;
    readonly subscribe: (listener: () => void) => () => void;
    readonly tabState: Observable<readonly TabSnapshot[]>;

    constructor(options: WorkspaceOptions = {}) {
        this.history = new TextHistory(options.history);
        this.scope = new NotificationScope(options.onListenerError ?? (() => {}));
        this.tabs = new Store<readonly TabSnapshot[]>(Object.freeze([]), this.scope);
        this.state = new Store<WorkspaceSnapshot>(Object.freeze({ revision: 0, resources: Object.freeze([]),
            documents: Object.freeze([]), tabs: this.tabs.get() }), this.scope);
        this.tabState = this.tabs.observable;
        this.getSnapshot = this.state.observable.getSnapshot;
        this.subscribe = this.state.observable.subscribe;
    }

    createResource<T extends SnapshotValue>(key: ResourceKey, title: string, loaded?: LoadedResource<T>, permissions = defaultCapabilities): ResourceHandle<T> {
        return this.create(key, title, "panel", loaded, permissions) as ResourceHandle<T>;
    }
    createTextResource(key: ResourceKey, title: string, loaded?: LoadedResource<string>, permissions = defaultCapabilities): TextResourceHandle {
        return this.create(key, title, "text", loaded, permissions) as TextResourceHandle;
    }
    /** Retain an immutable buffer directly, without exporting or reparsing its text. */
    createTextResourceFromBuffer(key: ResourceKey, title: string, loaded: LoadedTextBuffer, permissions = defaultCapabilities): TextResourceHandle {
        if (!(loaded.buffer instanceof TextBuffer)) throw new TypeError("Text resource requires a TextBuffer.");
        return this.create(key, title, "text", loaded, permissions) as TextResourceHandle;
    }
    createDocument(key: ResourceKey, title: string, text: string): DocumentId {
        return this.createTextResource(key, title, { value: text }).documentId;
    }
    private create(key: ResourceKey, title: string, kind: "text" | "panel", loaded: LoadedResource<SnapshotValue> | LoadedTextBuffer | undefined, permissions: Capabilities): ResourceHandle<SnapshotValue> {
        this.scope.assertWritable();
        for (const record of this.records.values()) {
            const existing = record.metadata.get().key;
            if (existing.scope === key.scope && existing.resource === key.resource && existing.variant === key.variant) throw new Error("Resource already exists in this workspace.");
        }
        if (loaded && "buffer" in loaded && kind !== "text") throw new TypeError("Only text resources accept a TextBuffer.");
        const value = loaded === undefined || "buffer" in loaded ? undefined : snapshotValue(loaded.value);
        if (kind === "text" && value !== undefined && typeof value !== "string") throw new TypeError("Text resource requires a string.");
        const buffer = loaded && "buffer" in loaded ? loaded.buffer : kind === "text" && typeof value === "string" ? TextBuffer.from(value) : null;
        const id = `resource-${++this.nextId}` as ResourceId;
        const documentId = kind === "text" ? `document-${++this.nextId}` as DocumentId : null;
        const metadata = Object.freeze({ id, key: Object.freeze({ ...key }), title, kind,
            state: loaded === undefined ? "loading" as const : "ready" as const, dirty: false,
            serverVersion: loaded?.serverVersion ?? null, capabilities: capabilities(permissions), saveStatus: "idle" as const, failure: null, editLock: null });
        const state = new Store<ResourceSnapshot<SnapshotValue>>(loaded === undefined
            ? Object.freeze({ metadata, state: "loading", revision: 0 }) : readySnapshot(metadata, 0, buffer ?? value!), this.scope);
        const meta = new Store(metadata, this.scope);
        const handle = Object.freeze({ ...state.observable, id, metadata: meta.observable, ...(documentId === null ? {} : { documentId }) });
        const record: ResourceRecord = { handle, documentId, state, metadata: meta,
            document: new Store<DocumentSnapshot | undefined>(undefined, this.scope), saved: buffer ? undefined : value,
            buffer, savedBuffer: buffer, change: null, history: new Store<HistorySnapshot>(this.history.snapshot(documentId ?? ""), this.scope), views: new Map(),
            leases: new Set(), operations: new Map(), nextOperation: 0,
            saveReservations: 0, saving: null, editLease: null, agent: new Store(emptyAgentState, this.scope), proposalLease: null,
            agentRequest: null, acknowledgements: new Map() };
        this.records.set(id, record); this.handles.set(handle, record);
        if (documentId !== null) this.documents.set(documentId, record);
        const changed = new Set<Store<unknown>>();
        this.projectDocument(record, changed); this.publish(changed);
        return handle;
    }

    resource(id: ResourceId): ResourceHandle<SnapshotValue> { return this.requireResource(id).handle; }
    diagnostics(): Readonly<{ resources: number; documents: number; tabs: number; views: number; leases: number; subscriptions: number;
        history: Readonly<{ groups: number; changes: number; changedUnits: number }> }> {
        return Object.freeze({ resources: this.records.size, documents: this.documents.size, tabs: this.tabs.get().length,
            views: [...this.documents.values()].reduce((total, record) => total + record.views.size, 0), history: this.history.diagnostics(),
            leases: [...this.records.values()].reduce((total, record) => total + record.leases.size, 0), subscriptions: this.scope.subscriptionCount() });
    }
    resourceForDocument(id: DocumentId): TextResourceHandle {
        const record = this.documents.get(id);
        if (!record || record.state.get().state === "released") throw new Error("Unknown document.");
        return record.handle as TextResourceHandle;
    }
    document(id: DocumentId): DocumentSnapshot {
        const document = this.documents.get(id)?.document.get();
        if (!document) throw new Error("Document is not ready or has been released.");
        return document;
    }
    observeDocument(id: DocumentId): Observable<DocumentSnapshot | undefined> {
        const record = this.documents.get(id);
        if (!record) throw new Error("Unknown document.");
        return record.document.observable;
    }
    observeHistory(id: DocumentId): Observable<HistorySnapshot> { return this.requireResource(this.resourceForDocument(id).id).history.observable; }
    ownsDocumentView(view: DocumentView): boolean { return this.documents.get(view.documentId)?.views.get(view.id)?.handle === view; }
    createDocumentView(id: DocumentId, initial: Selection = { anchor: 0, head: 0 }): DocumentView {
        // View registration, like subscribing, may occur during host view attachment in a delivery.
        const document = this.document(id), record = this.documents.get(id)!;
        const state = new Store<DocumentViewSnapshot>(Object.freeze({ documentId: id, revision: document.revision,
            selection: selection(document.buffer.length, initial) }), this.scope);
        const viewId = `view-${++this.nextId}` as ViewId, retention = Symbol("view"); record.leases.add(retention);
        const lease = Object.freeze({ resourceId: record.handle.id, active: () => record.leases.has(retention), release: () => { record.leases.delete(retention); } });
        const handle: DocumentView = Object.freeze({ ...state.observable, id: viewId, documentId: id,
            setSelection: (expectedRevision: number, value: Selection) => {
                if (!record.views.has(viewId) || record.state.get().state !== "ready" || record.state.get().revision !== expectedRevision) return false;
                const next = selection(record.buffer!.length, value), previous = state.get();
                if (sameSelection(next, previous.selection)) return true;
                this.scope.assertWritable();
                this.history.seal(id);
                const changed = new Set<Store<unknown>>(); state.set(Object.freeze({ ...previous, selection: next }), changed); this.scope.deliver([...changed]); return true;
            }, dispose: () => { record.views.delete(viewId); lease.release(); } });
        record.views.set(viewId, { handle, state, lease }); return handle;
    }
    captureResource(id: ResourceId): ResourceTarget {
        this.requireResource(id); return Object.freeze({ workspace: this.lifetime, id });
    }
    resolveResource(target: ResourceTarget): ResourceHandle<SnapshotValue> | undefined {
        return target.workspace === this.lifetime ? this.records.get(target.id)?.handle : undefined;
    }

    updateResource<T extends SnapshotValue>(handle: ResourceHandle<T>, request: Readonly<{ expectedRevision: number; value: T; origin: EditOrigin; lease?: EditLease }>): ChangeResult {
        this.scope.assertWritable();
        const record = this.handles.get(handle);
        if (!record || record.state.get().state === "released") return { applied: false, reason: "missing-resource" };
        if (record.documentId !== null) throw new Error("Text resources require range transactions.");
        const refusal = this.validateEdit(record, request.expectedRevision, request.origin, request.lease);
        if (refusal) return refusal;
        return this.changeValue(record, snapshotValue(request.value));
    }
    edit(request: EditRequest): EditResult {
        const result = this.editDocuments([request]);
        return result.applied ? { applied: true, revision: result.revisions[0]!.revision } : result;
    }
    /** Validate every document, permission, view and range before changing any observable. */
    editDocuments(requests: readonly EditRequest[]): BatchEditResult {
        this.scope.assertWritable();
        if (!requests.length) throw new RangeError("A text transaction needs at least one document.");
        const ids = new Set<DocumentId>(), first = requests[0]!, kind = first.history?.kind ?? "replace", group = first.history?.group;
        validateHistory(kind, group);
        const prepared = [];
        for (const request of requests) {
            if (ids.has(request.documentId)) throw new Error("A document may appear only once in a transaction."); ids.add(request.documentId);
            if (request.origin !== first.origin || (request.history?.kind ?? "replace") !== kind || request.history?.group !== group) throw new Error("A text transaction has one origin and history policy.");
            const record = this.documents.get(request.documentId);
            if (!record || record.state.get().state === "released") return { applied: false, reason: "missing-document" };
            const refusal = this.validateEdit(record, request.expectedRevision, request.origin, request.lease); if (refusal) return refusal;
            const view = request.view === undefined ? undefined : record.views.get(request.view.id);
            if ((request.view && view?.handle !== request.view) || (request.selection && !view)) throw new Error("Selection target must be a live view of this document.");
            const before = record.buffer!, result = before.apply(request.edits);
            const afterSelection = request.selection ? selection(result.buffer.length, request.selection) : undefined;
            prepared.push({ request, record, before, after: result.buffer, mapping: result.mapping, units: result.changedUnits, view, afterSelection });
        }
        const actual = prepared.filter(change => change.before !== change.after);
        const changes: HistoryChange[] = actual.map(change => Object.freeze({ documentId: change.request.documentId, before: change.before, after: change.after,
            mappings: Object.freeze([change.mapping]), units: change.units,
            selection: change.view ? Object.freeze({ viewId: change.view.handle.id, before: change.view.state.get().selection,
                after: change.afterSelection ?? mapSelection(change.mapping, change.view.state.get().selection) }) : null }));
        if (changes.length) this.history.record(changes, first.origin, kind, requests.length === 1 ? group : undefined);
        const changed = new Set<Store<unknown>>(), transactionId = actual.length ? ++this.nextTransaction : 0;
        for (const change of prepared) {
            if (change.before !== change.after) this.commitText(change.record, change.after, change.mapping, first.origin, kind, transactionId, changed);
            if (change.view && change.afterSelection && !sameSelection(change.view.state.get().selection, change.afterSelection)) {
                if (!actual.length) this.history.seal(change.request.documentId);
                change.view.state.set(Object.freeze({ documentId: change.request.documentId,
                    revision: change.record.state.get().revision, selection: change.afterSelection }), changed);
            }
        }
        this.syncHistory(changed); if (changed.size) { if (actual.length) this.publish(changed); else this.scope.deliver([...changed]); }
        return Object.freeze({ applied: true, revisions: Object.freeze(prepared.map(change => Object.freeze({ documentId: change.request.documentId, revision: change.record.state.get().revision }))) });
    }
    undo(request: HistoryRequest): BatchEditResult { return this.moveHistory(request, "undo"); }
    redo(request: HistoryRequest): BatchEditResult { return this.moveHistory(request, "redo"); }
    private moveHistory(request: HistoryRequest, direction: "undo" | "redo"): BatchEditResult {
        this.scope.assertWritable();
        const record = this.documents.get(request.documentId), origin = request.origin ?? "human";
        if (!record) return { applied: false, reason: "missing-document" };
        const refusal = this.validateEdit(record, request.expectedRevision, origin, request.lease); if (refusal) return refusal;
        const entry = this.history.peek(request.documentId, direction);
        if (!entry) return { applied: false, reason: "history-empty" };
        if (!this.history.available(entry, direction)) return { applied: false, reason: "history-blocked" };
        for (const change of entry.changes) {
            const participant = this.documents.get(change.documentId as DocumentId);
            if (!participant || participant.buffer !== (direction === "undo" ? change.after : change.before)) return { applied: false, reason: "history-blocked" };
            const denied = this.validateEdit(participant, participant.state.get().revision, origin, participant === record ? request.lease : undefined); if (denied) return denied;
        }
        this.history.move(entry, direction);
        const changed = new Set<Store<unknown>>(), transactionId = ++this.nextTransaction, revisions = [];
        for (const change of entry.changes) {
            const participant = this.documents.get(change.documentId as DocumentId)!, forward = composePositionMaps(...change.mappings);
            this.commitText(participant, direction === "undo" ? change.before : change.after, direction === "undo" ? forward.invert() : forward,
                origin, direction, transactionId, changed);
            const view = change.selection ? participant.views.get(change.selection.viewId as ViewId) : undefined;
            if (view && change.selection) view.state.set(Object.freeze({ documentId: participant.documentId!, revision: participant.state.get().revision,
                selection: direction === "undo" ? change.selection.before : change.selection.after }), changed);
            revisions.push(Object.freeze({ documentId: participant.documentId!, revision: participant.state.get().revision }));
        }
        this.syncHistory(changed); this.publish(changed); return Object.freeze({ applied: true, revisions: Object.freeze(revisions) });
    }
    private commitText(record: ResourceRecord, buffer: TextBuffer, mapping: PositionMapping, origin: EditOrigin, kind: DocumentChange["kind"], transactionId: number, changed: Set<Store<unknown>>): void {
        const current = record.state.get(), revision = current.revision + 1;
        record.buffer = buffer;
        record.change = Object.freeze({ previousRevision: current.revision, mapping, transactionId, origin, kind });
        this.setRecord(record, readySnapshot({ ...current.metadata, dirty: record.savedBuffer === null || !buffer.equals(record.savedBuffer) }, revision, buffer), changed);
        for (const view of record.views.values()) view.state.set(Object.freeze({ documentId: record.documentId!, revision,
            selection: mapSelection(mapping, view.state.get().selection) }), changed);
    }
    private syncHistory(changed: Set<Store<unknown>>): void {
        for (const [id, record] of this.documents) {
            const previous = record.history.get(), next = this.history.snapshot(id);
            if (previous.undoDepth !== next.undoDepth || previous.redoDepth !== next.redoDepth) record.history.set(next, changed);
        }
    }
    private validateEdit(record: ResourceRecord, revision: number, origin: EditOrigin, lease?: EditLease): Extract<ChangeResult, { applied: false }> | undefined {
        const state = record.state.get();
        if (state.state !== "ready") return { applied: false, reason: "not-ready" };
        if (!state.metadata.capabilities.edit.includes(origin)) return { applied: false, reason: "read-only" };
        if (record.editLease !== null && (record.editLease !== lease || lease.origin !== origin)) return { applied: false, reason: "edit-locked" };
        if (state.revision !== revision) return { applied: false, reason: "stale-revision" };
        return undefined;
    }
    private changeValue(record: ResourceRecord, value: SnapshotValue): ChangeResult {
        const current = record.state.get();
        if (current.state !== "ready") return { applied: false, reason: "not-ready" };
        if (equalValue(current.value, value)) return { applied: true, revision: current.revision };
        this.commitRecord(record, { ...current, revision: current.revision + 1, value,
            metadata: { ...current.metadata, dirty: record.saved === undefined || !equalValue(record.saved, value) } });
        return { applied: true, revision: current.revision + 1 };
    }
    setCapabilities(id: ResourceId, permissions: Capabilities): void {
        this.scope.assertWritable();
        const record = this.requireResource(id), state = record.state.get();
        const next = capabilities(permissions), current = state.metadata.capabilities;
        if (next.save === current.save && next.run === current.run && next.edit.length === current.edit.length
            && next.edit.every(origin => current.edit.includes(origin))) return;
        this.commitRecord(record, withMetadata(state, { ...state.metadata, capabilities: next }));
    }

    acquireEditLease(id: ResourceId, owner: string, origin: EditOrigin): EditLease {
        this.scope.assertWritable();
        const changed = new Set<Store<unknown>>();
        const lease = this.createEditLease(this.requireResource(id), owner, origin, changed);
        this.publish(changed); return lease;
    }
    private createEditLease(record: ResourceRecord, owner: string, origin: EditOrigin, changed: Set<Store<unknown>>): EditLease {
        const state = record.state.get();
        if (state.state !== "ready" || !state.metadata.capabilities.edit.includes(origin) || record.editLease) throw new Error("Resource cannot grant this edit lease.");
        const retention = this.acquire(record.handle.id);
        const lease: EditLease = Object.freeze({ ...retention, origin, release: () => {
            this.scope.assertWritable(); const changes = new Set<Store<unknown>>();
            if (this.clearEditLease(record, lease, changes)) this.publish(changes);
        } });
        record.editLease = lease;
        // Keep the retention release separate from the externally visible edit-lease release.
        this.editRetentions.set(lease, retention);
        this.setRecord(record, withMetadata(state, { ...state.metadata, editLock: Object.freeze({ owner, origin }) }), changed);
        return lease;
    }
    private readonly editRetentions = new WeakMap<EditLease, ResourceLease>();
    private clearEditLease(record: ResourceRecord, lease: EditLease, changed: Set<Store<unknown>>): boolean {
        if (record.editLease !== lease) return false;
        record.editLease = null; this.editRetentions.get(lease)?.release();
        const state = record.state.get();
        this.setRecord(record, withMetadata(state, { ...state.metadata, editLock: null }), changed);
        return true;
    }

    agentState(id: ResourceId): Observable<AgentSnapshot> {
        const record = this.requireResource(id);
        if (record.documentId === null) throw new Error("Agent review requires a text resource.");
        return record.agent.observable;
    }
    associateAgent(id: ResourceId, associationId: string): AgentAssociation {
        this.scope.assertWritable();
        const record = this.requireResource(id), state = record.agent.get();
        if (record.documentId === null || record.state.get().state !== "ready" || typeof associationId !== "string" || !associationId) throw new Error("Expected a ready text resource and association ID.");
        if (state.association !== null) {
            if (state.association.id === associationId) return state.association;
            throw new Error("Explicitly detach the existing association before taking over.");
        }
        const association = Object.freeze({ id: associationId, generation: ++record.nextOperation });
        const changed = new Set<Store<unknown>>();
        record.agent.set(Object.freeze({ ...state, association, lastResult: "none" }), changed);
        this.publish(changed); return association;
    }
    interruptAgent(id: ResourceId): void {
        this.scope.assertWritable(); const record = this.requireResource(id), changed = new Set<Store<unknown>>();
        if (this.interruptRequest(record, changed)) this.publish(changed);
    }
    detachAgent(id: ResourceId): void {
        this.scope.assertWritable(); const record = this.requireResource(id), changed = new Set<Store<unknown>>();
        this.interruptRequest(record, changed);
        record.proposalLease?.release(); record.proposalLease = null;
        record.agent.set(Object.freeze({ ...record.agent.get(), association: null, proposal: null,
            proposalGeneration: record.agent.get().proposalGeneration + 1 }), changed);
        this.publish(changed);
    }
    private interruptRequest(record: ResourceRecord, changed: Set<Store<unknown>>): boolean {
        const request = record.agentRequest;
        if (request === null) return false;
        request.operation.cancel(); this.clearEditLease(record, request.lease, changed); record.agentRequest = null;
        record.agent.set(Object.freeze({ ...record.agent.get(), request: null, lastResult: "interrupted" }), changed);
        return true;
    }
    beginAgentRequest<T extends SnapshotValue>(source: TextResourceHandle, context: T): AgentRequest<T> {
        this.scope.assertWritable();
        const record = this.handles.get(source), state = record?.state.get(), review = record?.agent.get();
        if (!record || record.documentId === null || state?.state !== "ready" || !review?.association
            || review.request || review.proposal || record.acknowledgements.size || record.saveReservations) throw new Error("Agent request requires an associated resource with settled saves, proposals and acknowledgements.");
        const copiedContext = snapshotValue(context), changed = new Set<Store<unknown>>();
        // Validate before acquiring either lease; a rejected start publishes nothing.
        if (record.editLease || !state.metadata.capabilities.edit.includes("agent")) throw new Error("Agent editing is unavailable.");
        const operation = this.operation(source.id, this.agentLane);
        const lease = this.createEditLease(record, review.association.id, "agent", changed);
        const id = `request-${++this.nextId}`;
        const input = Object.freeze({ id, association: review.association, context: copiedContext,
            source: Object.freeze({ target: operation.target, key: state.metadata.key, revision: state.revision,
                value: state.value as string, serverVersion: state.metadata.serverVersion }) });
        record.agentRequest = { operation, lease };
        record.agent.set(Object.freeze({ ...review, request: Object.freeze({ id, documentRevision: state.revision }), lastResult: "none" }), changed);
        this.publish(changed);
        const settle = (result: AgentSnapshot["lastResult"]) => {
            this.scope.assertWritable();
            if (record.agentRequest?.operation === operation) {
                const changes = new Set<Store<unknown>>();
                record.agentRequest = null; this.clearEditLease(record, lease, changes);
                record.agent.set(Object.freeze({ ...record.agent.get(), request: null, lastResult: result }), changes);
                this.publish(changes);
            }
            operation.finish();
        };
        return Object.freeze({ ...operation, input, accept: (proposal: ProposedEdits) => {
            try {
                this.scope.assertWritable();
                if (!operation.isCurrent() || record.agentRequest?.operation !== operation) {
                    settle("stale"); return { applied: false, reason: "stale-association" } as const;
                }
                const changes = new Set<Store<unknown>>();
                const result = this.applyProposal(record, input.association, state.revision, review.proposalGeneration, proposal, changes, lease);
                record.agentRequest = null; this.clearEditLease(record, lease, changes);
                record.agent.set(Object.freeze({ ...record.agent.get(), request: null, lastResult: result.applied ? "proposed" : "stale" }), changes);
                this.publish(changes); return result;
            } catch (error) { settle("failed"); throw error; }
            finally { operation.finish(); }
        }, fail: () => settle("failed"), finish: () => settle("interrupted"),
        cancel: () => {
            this.scope.assertWritable();
            if (record.agentRequest?.operation === operation) this.interruptAgent(source.id);
            else operation.cancel();
        } });
    }
    /** Explicit versioned incoming review update; a request callback must use its captured request ticket. */
    captureProposal(id: ResourceId): ProposalGuard {
        const record = this.requireResource(id), state = record.state.get(), review = record.agent.get();
        if (record.documentId === null || state.state !== "ready" || !review.association) throw new Error("A ready associated text resource is required.");
        return Object.freeze({ target: this.captureResource(id), association: review.association, documentRevision: state.revision, generation: review.proposalGeneration });
    }
    offerAgentProposal(guard: ProposalGuard, proposal: ProposedEdits): ChangeResult {
        this.scope.assertWritable();
        if (!this.resolveResource(guard.target)) return { applied: false, reason: "missing-resource" };
        const record = this.requireResource(guard.target.id), changed = new Set<Store<unknown>>();
        const result = this.applyProposal(record, guard.association, guard.documentRevision, guard.generation, proposal, changed);
        if (result.applied) this.publish(changed); return result;
    }
    private applyProposal(record: ResourceRecord, association: AgentAssociation, revision: number, generation: number, proposal: ProposedEdits,
        changed: Set<Store<unknown>>, lease?: EditLease): ChangeResult {
        const review = record.agent.get(), current = record.state.get();
        if (record.documentId === null || !review.association || review.association.id !== association.id
            || review.association.generation !== association.generation) return { applied: false, reason: "stale-association" };
        if (review.proposalGeneration !== generation) return { applied: false, reason: "stale-proposal" };
        if (typeof proposal.id !== "string" || !proposal.id || !Number.isSafeInteger(proposal.revision) || proposal.revision < 1) throw new RangeError("Proposal identity and positive revision are required.");
        if (review.proposal?.target.id === proposal.id && proposal.revision <= review.proposal.target.revision) return { applied: false, reason: "stale-proposal" };
        const refusal = this.validateEdit(record, revision, "agent", lease);
        if (refusal) return refusal;
        if (current.state !== "ready") return { applied: false, reason: "not-ready" };
        const before = record.buffer!, result = before.apply(proposal.edits);
        if (result.buffer !== before) {
            this.history.record([Object.freeze({ documentId: record.documentId, before, after: result.buffer, mappings: Object.freeze([result.mapping]),
                units: result.changedUnits, selection: null })], "agent", "proposal");
            this.commitText(record, result.buffer, result.mapping, "agent", "proposal", ++this.nextTransaction, changed); this.syncHistory(changed);
        } else this.history.seal(record.documentId);
        const nextRevision = record.state.get().revision;
        record.proposalLease ??= this.acquire(record.handle.id);
        const target = Object.freeze({ association: review.association, id: proposal.id, revision: proposal.revision, generation: generation + 1 });
        record.agent.set(Object.freeze({ ...review, proposal: Object.freeze({ target, baseDocumentRevision: revision, documentRevision: nextRevision }),
            proposalGeneration: generation + 1, lastResult: "proposed" }), changed);
        return { applied: true, revision: nextRevision };
    }
    beginAcknowledgement(id: ResourceId, acknowledgementId: string): AcknowledgementTicket {
        this.scope.assertWritable(); const record = this.requireResource(id), entry = record.acknowledgements.get(acknowledgementId);
        if (!entry || [...record.acknowledgements.keys()][0] !== acknowledgementId || entry.state.status === "sending") throw new Error("Acknowledge the earliest pending receipt once at a time.");
        const operation = this.operation(id, this.acknowledgementLane), changed = new Set<Store<unknown>>();
        entry.state = Object.freeze({ ...entry.state, status: "sending" }); this.syncAcknowledgements(record, changed); this.publish(changed);
        let settled = false;
        const fail = () => {
            this.scope.assertWritable();
            if (!settled && operation.isCurrent()) {
                settled = true; const changes = new Set<Store<unknown>>();
                entry.state = Object.freeze({ ...entry.state, status: "failed" }); this.syncAcknowledgements(record, changes); this.publish(changes);
            }
        };
        return Object.freeze({ submission: entry.submission, accept: () => {
            this.scope.assertWritable();
            if (settled || !operation.isCurrent() || record.acknowledgements.get(acknowledgementId) !== entry) return Object.freeze({ accepted: false, retired: false });
            settled = true; const changes = new Set<Store<unknown>>(), review = record.agent.get();
            const retired = review.proposal !== null && sameProposal(review.proposal.target, entry.submission.proposal);
            record.acknowledgements.delete(acknowledgementId); entry.lease.release();
            if (retired) {
                record.proposalLease?.release(); record.proposalLease = null;
                record.agent.set(Object.freeze({ ...review, proposal: null, proposalGeneration: review.proposalGeneration + 1 }), changes);
            }
            this.syncAcknowledgements(record, changes); this.publish(changes);
            return Object.freeze({ accepted: true, retired });
        }, fail, finish: () => { fail(); operation.finish(); } });
    }
    private syncAcknowledgements(record: ResourceRecord, changed: Set<Store<unknown>>): void {
        record.agent.set(Object.freeze({ ...record.agent.get(), acknowledgements: Object.freeze([...record.acknowledgements.values()].map(entry => entry.state)) }), changed);
    }

    acquire(id: ResourceId): ResourceLease {
        this.scope.assertWritable();
        const record = this.requireResource(id), lease = Symbol("resource-lease");
        record.leases.add(lease);
        return Object.freeze({ resourceId: id, active: () => record.leases.has(lease), release: () => {
            this.scope.assertWritable(); record.leases.delete(lease);
        } });
    }
    ownership(id: ResourceId): Readonly<{ leases: number; tabs: number }> {
        const record = this.requireResource(id);
        return Object.freeze({ leases: record.leases.size, tabs: this.tabs.get().filter(tab => this.surfaceResource(tab.surface) === id).length });
    }
    beginOperation(id: ResourceId, lane: string, presentation?: TabTarget): Operation {
        return this.operation(id, lane, presentation);
    }
    private operation(id: ResourceId, lane: string | symbol, presentation?: TabTarget): Operation {
        this.scope.assertWritable();
        if (presentation !== undefined) {
            const tab = this.resolveTab(presentation);
            if (!tab || this.surfaceResource(tab.surface) !== id) throw new Error("Operation presentation does not own this resource.");
        }
        const record = this.requireResource(id), lease = this.acquire(id);
        record.operations.get(lane)?.cancel();
        let cancelled = false, finished = false;
        const target = this.captureResource(id);
        const operation: Operation = Object.freeze({ target, revision: record.state.get().revision, generation: ++record.nextOperation,
            isCurrent: () => !cancelled && !finished && record.operations.get(lane) === operation && this.records.get(id) === record,
            isCancelled: () => cancelled,
            presentationCurrent: () => operation.isCurrent() && (presentation === undefined || this.resolveTab(presentation) !== undefined),
            cancel: () => { this.scope.assertWritable(); cancelled = true; },
            finish: () => {
                this.scope.assertWritable();
                if (finished) return;
                finished = true; lease.release();
                if (record.operations.get(lane) === operation) record.operations.delete(lane);
            } });
        record.operations.set(lane, operation);
        return operation;
    }
    beginLoad<T extends SnapshotValue>(handle: ResourceHandle<T>): LoadOperation<T> {
        this.scope.assertWritable();
        const record = this.handles.get(handle);
        if (!record || record.state.get().state === "released") throw new Error("Unknown resource.");
        if (record.metadata.get().dirty || record.saveReservations || record.editLease || record.agent.get().proposal || record.acknowledgements.size) throw new Error("Cannot refresh local, locked or pending work.");
        const operation = this.beginOperation(handle.id, "load");
        const state = record.state.get();
        this.commitRecord(record, { state: "loading", revision: state.revision, metadata: { ...state.metadata, state: "loading", failure: null } });
        return Object.freeze({ ...operation, accept: (loaded: LoadedResource<T>) => {
            try {
                this.scope.assertWritable();
                if (!operation.isCurrent()) return false;
                const value = snapshotValue(loaded.value);
                if (record.documentId !== null && typeof value !== "string") throw new TypeError("Text resource requires a string.");
                const current = record.state.get();
                record.saved = record.documentId === null ? value : undefined;
                if (record.documentId !== null) {
                    record.buffer = TextBuffer.from(value as string); record.savedBuffer = record.buffer; record.change = null; this.history.forget(record.documentId);
                }
                const changed = new Set<Store<unknown>>(), revision = current.revision + 1;
                this.setRecord(record, readySnapshot({ ...current.metadata, state: "ready", dirty: false, serverVersion: loaded.serverVersion ?? null, failure: null, saveStatus: "idle" },
                    revision, record.buffer ?? value), changed);
                for (const view of record.views.values()) view.state.set(Object.freeze({ documentId: record.documentId!, revision,
                    selection: selection(record.buffer!.length, { anchor: 0, head: 0 }) }), changed);
                this.syncHistory(changed); this.publish(changed);
                return true;
            } finally { operation.finish(); }
        }, fail: (message: string) => {
            try {
                this.scope.assertWritable();
                if (!operation.isCurrent()) return false;
                const current = record.state.get();
                this.commitRecord(record, { state: "failed", revision: current.revision,
                    metadata: { ...current.metadata, state: "failed", failure: message } });
                return true;
            } finally { operation.finish(); }
        } });
    }

    /** Captures content now, retains ownership while queued, and enforces one writer per resource. */
    captureSave<T extends SnapshotValue>(handle: ResourceHandle<T>, review?: SaveReview): SaveTicket<T> {
        this.scope.assertWritable();
        const record = this.handles.get(handle), initial = record?.state.get();
        if (!record || initial?.state !== "ready" || !initial.metadata.capabilities.save || record.editLease) throw new Error("Resource is not ready or cannot be saved.");
        const reviewedVersion = review?.expectedServerVersion;
        if (review !== undefined) {
            if (!review || !Number.isSafeInteger(review.expectedRevision) || review.expectedRevision < 0 || typeof reviewedVersion !== "string") throw new TypeError("Reviewed save requires a revision and server version.");
            if (!review.target || this.resolveResource(review.target) !== handle) throw new Error("Reviewed save belongs to another resource or workspace.");
            if (initial.revision !== review.expectedRevision || record.saveReservations !== 0) throw new Error("Reviewed save has changed or another save is pending.");
        }
        const lease = this.acquire(handle.id), target = this.captureResource(handle.id), marker = Symbol("save");
        if (record.documentId !== null) this.history.seal(record.documentId);
        const value = initial.value as Immutable<T>, revision = initial.revision, id = `save-${++this.nextId}`;
        const capturedBuffer = record.buffer;
        const proposal = record.agent.get().proposal?.target ?? null;
        let finished = false, settled = false, submission: SaveSubmission<T> | undefined;
        record.saveReservations++;
        const requireStarted = () => {
            this.scope.assertWritable();
            if (finished || settled || record.saving !== marker || !submission) throw new Error("Save ticket is not active.");
            return submission;
        };
        const status = (saveStatus: ResourceMetadata["saveStatus"]) => {
            const current = record.state.get();
            this.commitRecord(record, withMetadata(current, { ...current.metadata, saveStatus }));
        };
        return Object.freeze({ target, revision, value, start: () => {
            this.scope.assertWritable();
            const current = record.state.get();
            if (finished || submission || record.saving !== null) throw new Error("Serialize resource saves before starting another write.");
            if (current.state !== "ready" || !current.metadata.capabilities.save || record.editLease) throw new Error("Save capability or edit lease has changed.");
            if (reviewedVersion !== undefined && current.metadata.serverVersion !== initial.metadata.serverVersion) throw new Error("Saved baseline changed after review capture.");
            record.saving = marker;
            submission = Object.freeze({ id, target, key: initial.metadata.key, revision, value,
                expectedServerVersion: reviewedVersion ?? current.metadata.serverVersion, proposal });
            status("saving"); return submission;
        }, accept: (response: Readonly<{ serverVersion: string; canonical?: T }>) => {
            const submitted = requireStarted();
            if (typeof response.serverVersion !== "string") throw new TypeError("Save receipt requires a server version.");
            const savedValue = response.canonical === undefined ? value : snapshotValue(response.canonical);
            if (record.documentId !== null && typeof savedValue !== "string") throw new TypeError("Canonical text must be a string.");
            const current = record.state.get();
            if (current.state !== "ready") throw new Error("Saved resource is no longer ready.");
            const savedBuffer = capturedBuffer ? response.canonical === undefined || savedValue === value ? capturedBuffer : TextBuffer.from(savedValue as string) : null;
            const canonicalApplied = current.revision === revision && current.metadata.capabilities.edit.includes("host")
                && record.editLease === null && (proposal === null ? record.agent.get().proposal === null
                    : record.agent.get().proposal !== null && sameProposal(proposal, record.agent.get().proposal!.target))
                && (savedBuffer ? !record.buffer!.equals(savedBuffer) : !equalValue(current.value, savedValue));
            record.saved = savedBuffer ? undefined : savedValue; record.savedBuffer = savedBuffer; settled = true;
            const acknowledgementId = proposal === null ? null : `ack-${id}`;
            const receipt = Object.freeze({ submission: submitted, savedValue, serverVersion: response.serverVersion, canonicalApplied, acknowledgementId });
            const changed = new Set<Store<unknown>>();
            if (savedBuffer) {
                if (canonicalApplied) {
                    const before = record.buffer!, edit = textDifference(current.value as string, savedValue as string)!;
                    const result = before.apply([edit]);
                    this.history.record([Object.freeze({ documentId: record.documentId!, before, after: result.buffer, mappings: Object.freeze([result.mapping]),
                        units: result.changedUnits, selection: null })], "host", "canonical");
                    this.commitText(record, result.buffer, result.mapping, "host", "canonical", ++this.nextTransaction, changed);
                }
                const next = record.state.get();
                this.setRecord(record, withMetadata(next, { ...next.metadata, serverVersion: response.serverVersion,
                    dirty: !record.buffer!.equals(savedBuffer), saveStatus: record.saveReservations > 1 ? "saving" : "idle" }), changed);
            } else {
                const nextValue = canonicalApplied ? savedValue : current.value;
                this.setRecord(record, readySnapshot({ ...current.metadata, serverVersion: response.serverVersion, dirty: !equalValue(nextValue, savedValue),
                    saveStatus: record.saveReservations > 1 ? "saving" : "idle" }, current.revision + (canonicalApplied ? 1 : 0), nextValue), changed);
            }
            if (record.documentId !== null) this.history.seal(record.documentId); this.syncHistory(changed);
            if (acknowledgementId !== null && proposal !== null) {
                const ack = Object.freeze({ id: acknowledgementId, target, proposal, receipt: receipt as SaveReceipt<string> });
                record.acknowledgements.set(acknowledgementId, { submission: ack, lease: this.acquire(handle.id),
                    state: Object.freeze({ id: acknowledgementId, proposal, submittedRevision: revision, serverVersion: response.serverVersion, status: "pending" }) });
                this.syncAcknowledgements(record, changed);
            }
            this.publish(changed); return receipt;
        }, conflict: () => { requireStarted(); settled = true; status("conflict"); },
        fail: () => { this.scope.assertWritable(); if (!finished && !settled) { settled = true; status("failed"); } },
        finish: () => {
            this.scope.assertWritable();
            if (finished) return;
            finished = true; record.saveReservations--; if (record.saving === marker) record.saving = null;
            lease.release();
            if (!record.saveReservations && record.metadata.get().saveStatus === "saving") status("idle");
        } });
    }

    open(surface: Surface, paneId: PaneId): TabId {
        this.scope.assertWritable(); this.surfaceResource(surface);
        const id = `tab-${++this.nextId}` as TabId;
        this.publishTabs([...this.tabs.get(), Object.freeze({ id, paneId, generation: 0, surface: Object.freeze({ ...surface }) })]);
        return id;
    }
    move(id: TabId, paneId: PaneId): void {
        this.scope.assertWritable();
        const current = this.requireTab(id);
        if (current.paneId === paneId) return;
        this.publishTabs(this.tabs.get().map(tab => tab.id === id ? Object.freeze({ ...tab, paneId }) : tab));
    }
    replace(id: TabId, surface: Surface): void {
        this.scope.assertWritable(); this.requireTab(id); this.surfaceResource(surface);
        this.publishTabs(this.tabs.get().map(tab => tab.id === id ? Object.freeze({ ...tab, generation: tab.generation + 1, surface: Object.freeze({ ...surface }) }) : tab));
    }
    /** Immediate host decision. Use captureClose/completeClose for an asynchronous dirty prompt. */
    close(id: TabId): void {
        this.scope.assertWritable(); this.requireTab(id);
        this.publishTabs(this.tabs.get().filter(tab => tab.id !== id));
    }
    captureClose(id: TabId): CloseIntent {
        const tab = this.requireTab(id), resource = this.requireResource(this.surfaceResource(tab.surface));
        return Object.freeze({ tab: this.captureTab(id), resource: this.captureResource(resource.handle.id),
            revision: resource.state.get().revision, dirty: resource.metadata.get().dirty });
    }
    completeClose(intent: CloseIntent, decision: "keep-open" | "close"): boolean {
        this.scope.assertWritable();
        if (decision === "keep-open" || !this.resolveTab(intent.tab)) return false;
        const resource = this.resolveResource(intent.resource);
        if (!resource || resource.getSnapshot().revision !== intent.revision) return false;
        this.close(intent.tab.id); return true;
    }
    beginClose(id: TabId): CloseOperation {
        const intent = this.captureClose(id), operation = this.beginOperation(intent.resource.id, `close:${id}`, intent.tab);
        return Object.freeze({ ...operation, intent, complete: (decision: "keep-open" | "close") => {
            try { return operation.isCurrent() && this.completeClose(intent, decision); }
            finally { operation.finish(); }
        } });
    }
    releaseResource(id: ResourceId, discard = false): void {
        this.scope.assertWritable();
        const record = this.requireResource(id), owners = this.ownership(id), state = record.state.get();
        if (owners.tabs || owners.leases) throw new Error("Resource still has tabs or operation leases.");
        if (state.metadata.dirty && !discard) throw new Error("Explicit discard is required to release unsaved work.");
        record.saved = undefined; record.buffer = null; record.savedBuffer = null; record.change = null;
        if (record.documentId !== null) this.history.forget(record.documentId);
        this.records.delete(id);
        const changed = new Set<Store<unknown>>();
        record.agent.set(emptyAgentState, changed);
        this.setRecord(record, { state: "released", revision: state.revision,
            metadata: { ...state.metadata, state: "released", dirty: false, failure: null } }, changed);
        if (record.documentId !== null) this.documents.delete(record.documentId);
        record.history.set(Object.freeze({ undoDepth: 0, redoDepth: 0 }), changed); this.syncHistory(changed);
        this.publish(changed);
    }
    releaseDocument(id: DocumentId, discard = false): void { this.releaseResource(this.resourceForDocument(id).id, discard); }
    captureTab(id: TabId): TabTarget {
        const tab = this.requireTab(id); return Object.freeze({ workspace: this.lifetime, id, generation: tab.generation });
    }
    resolveTab(target: TabTarget): TabSnapshot | undefined {
        return target.workspace === this.lifetime ? this.tabs.get().find(tab => tab.id === target.id && tab.generation === target.generation) : undefined;
    }
    private requireTab(id: TabId): TabSnapshot {
        const tab = this.tabs.get().find(tab => tab.id === id);
        if (!tab) throw new Error("Unknown tab."); return tab;
    }
    private requireResource(id: ResourceId): ResourceRecord {
        const record = this.records.get(id);
        if (!record) throw new Error("Unknown resource."); return record;
    }
    private surfaceResource(surface: Surface): ResourceId {
        return surface.kind === "text" ? this.resourceForDocument(surface.documentId).id : this.requireResource(surface.resourceId).handle.id;
    }
    private projectDocument(record: ResourceRecord, changed: Set<Store<unknown>>): void {
        const state = record.state.get(), previous = record.document.get();
        if (record.documentId === null || state.state !== "ready") { record.document.set(undefined, changed); return; }
        if (previous?.revision === state.revision) return;
        const buffer = record.buffer!;
        record.document.set(Object.freeze({ id: record.documentId, resourceId: record.handle.id, key: state.metadata.key,
            title: state.metadata.title, buffer, get text() { return state.value as string; }, revision: state.revision, change: record.change }), changed);
    }
    private setRecord(record: ResourceRecord, next: ResourceSnapshot<SnapshotValue>, changed: Set<Store<unknown>>): void {
        const previous = record.metadata.get();
        const metadata = sameMetadata(previous, next.metadata) ? previous : Object.freeze(next.metadata);
        record.metadata.set(metadata, changed);
        record.state.set(withMetadata(next, metadata), changed);
        this.projectDocument(record, changed);
    }
    private commitRecord(record: ResourceRecord, next: ResourceSnapshot<SnapshotValue>): void {
        const changed = new Set<Store<unknown>>(); this.setRecord(record, next, changed); this.publish(changed);
    }
    private publishTabs(tabs: readonly TabSnapshot[]): void {
        const changed = new Set<Store<unknown>>(); this.tabs.set(Object.freeze(tabs), changed); this.publish(changed);
    }
    private publish(changed: Set<Store<unknown>>): void {
        const records = [...this.records.values()];
        this.state.set(Object.freeze({ revision: this.state.get().revision + 1,
            resources: Object.freeze(records.map(record => record.metadata.get())),
            documents: Object.freeze(records.flatMap(record => record.document.get() ? [record.document.get()!] : [])), tabs: this.tabs.get() }), changed);
        this.scope.deliver([...changed]);
    }
}
