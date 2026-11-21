import type { TextEdit } from "./changes.ts";
import { compactDocumentEdit, textDifference } from "./changes.ts";
import { TextBuffer } from "./text-buffer.ts";
import type { PositionMapping } from "./positions.ts";
import { TextHistory, validateHistoryGroup } from "./history.ts";
import type { EditKind, HistoryChange, HistoryOptions, HistorySnapshot, Selection } from "./history.ts";
import { createSelectionSet, mapSelectionSet, sameSelectionSet } from "./selections.ts";
import type { SelectionSet } from "./selections.ts";
import { NotificationScope, Store } from "./observable.ts";
import type { Observable } from "./observable.ts";
import { collapseFoldRegion, createFoldRegions, foldingSnapshot, mapFoldRegions, revealFoldRange, revealSelectionFolds } from "./folding.ts";
import type { DocumentFolding, FoldingSnapshot, FoldVersion } from "./folding.ts";
import { equalValue, snapshotValue } from "./values.ts";
import type { Immutable, SnapshotValue } from "./values.ts";

export type ResourceId = string & { readonly resourceId: unique symbol };
export type DocumentId = string & { readonly documentId: unique symbol };
export type TabId = string & { readonly tabId: unique symbol };
export type ViewId = string & { readonly viewId: unique symbol };
export type PaneId = string;
export type ResourceKey = Readonly<{ scope: string; resource: string; variant: string }>;
export type EditOrigin = "human" | "agent" | "host";
export type Capabilities = Readonly<{ edit: readonly EditOrigin[]; save: boolean; run: boolean }>;
export type ResourceVisibility = "workspace" | "internal";
export type ResourceOptions = Readonly<{ visibility?: ResourceVisibility }>;
export type ResourceMetadata = Readonly<{
    id: ResourceId; key: ResourceKey; title: string; kind: "text" | "panel";
    visibility: ResourceVisibility;
    state: "loading" | "ready" | "failed" | "released";
    dirty: boolean; serverVersion: string | null; capabilities: Capabilities;
    saveStatus: "idle" | "saving" | "failed" | "conflict"; failure: string | null;
    editLock: Readonly<{ owner: string; origin: EditOrigin }> | null;
}>;
export type ResourceSnapshot<T> = Readonly<{ revision: number; metadata: ResourceMetadata }> & Readonly<
    { state: "ready"; value: () => Immutable<T> } | { state: "loading" | "failed" | "released" }
>;
export type ResourceHandle<T extends SnapshotValue> = Observable<ResourceSnapshot<T>> & Readonly<{
    id: ResourceId; metadata: Observable<ResourceMetadata>;
}>;
export type TextResourceHandle = ResourceHandle<string> & Readonly<{ documentId: DocumentId }>;
export type LoadedResource<T> = Readonly<{ value: T; serverVersion?: string | null }>;
export type LoadedTextBuffer = Readonly<{ buffer: TextBuffer; serverVersion?: string | null }>;
export type DocumentSnapshot = Readonly<{
    id: DocumentId; resourceId: ResourceId; key: ResourceKey; title: string; buffer: TextBuffer; text: () => string; revision: number;
    change: DocumentChange | null;
}>;
export type DocumentChange = Readonly<{ previousRevision: number; transactionId: number; origin: EditOrigin;
    kind: EditKind | "undo" | "redo"; mapping: PositionMapping }>;
export type DocumentViewSnapshot = Readonly<{ documentId: DocumentId; revision: number; selection: Selection; selectionSet: SelectionSet }>;
export type DocumentView = Observable<DocumentViewSnapshot> & Readonly<{ id: ViewId; documentId: DocumentId;
    folding: DocumentFolding;
    setSelection: (expectedRevision: number, selection: Selection) => boolean;
    setSelections: (expectedRevision: number, selections: readonly Selection[], primary?: number) => boolean; dispose: () => void }>;
export type Surface = Readonly<
    { kind: "text"; documentId: DocumentId }
    | { kind: "panel"; resourceId: ResourceId; panelType: string }
>;
export type TabSnapshot = Readonly<{ id: TabId; paneId: PaneId; generation: number; surface: Surface; visibility: ResourceVisibility }>;
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
    revision: number; value: Immutable<T>; expectedServerVersion: string | null }>;
/** Host-confirmed remote version for saving the explicitly reviewed local revision. No baseline adoption. */
export type SaveReview = Readonly<{ target: ResourceTarget; expectedRevision: number; expectedServerVersion: string }>;
export type SaveReceipt<T> = Readonly<{ submission: SaveSubmission<T>; savedValue: Immutable<T>; serverVersion: string;
    canonicalApplied: boolean }>;
export type SaveTicket<T, S extends SaveSubmission<T> = SaveSubmission<T>, R extends SaveReceipt<T> = SaveReceipt<T>> = Readonly<{ target: ResourceTarget; revision: number; value: Immutable<T>;
    start: () => S; accept: (response: Readonly<{ serverVersion: string; canonical?: T }>, options?: Readonly<{ applyCanonical?: boolean }>) => R;
    conflict: () => void; fail: () => void; finish: () => void }>;
export type EditRequest = Readonly<{
    documentId: DocumentId; expectedRevision: number; edits: readonly TextEdit[]; origin: EditOrigin; lease?: EditLease;
    history?: Readonly<{ kind: EditKind; group?: string; reset?: boolean }>; view?: DocumentView; selection?: Selection; selectionSet?: SelectionSet;
}>;
export type ChangeResult = Readonly<{ applied: true; revision: number } | { applied: false;
    reason: "missing-resource" | "missing-document" | "stale-revision" | "not-ready" | "read-only" | "edit-locked" | "history-empty" | "history-blocked" }>;
export type EditResult = ChangeResult;
export type BatchEditResult = Readonly<{ applied: true; revisions: readonly Readonly<{ documentId: DocumentId; revision: number }>[] }
    | { applied: false; reason: Extract<ChangeResult, { applied: false }>["reason"] }>;
export type HistoryRequest = Readonly<{ documentId: DocumentId; expectedRevision: number; origin?: EditOrigin; lease?: EditLease }>;
export type WorkspaceOptions = Readonly<{ onListenerError?: (error: unknown) => void; history?: HistoryOptions }>;

type ViewRecord = { handle: DocumentView; state: Store<DocumentViewSnapshot>; folds: Store<FoldingSnapshot>; lease: ResourceLease };
type PreparedView = Readonly<{ view: ViewRecord; state: DocumentViewSnapshot; folds: FoldingSnapshot }>;
type PreparedText = Readonly<{ record: ResourceRecord; buffer: TextBuffer; mapping: PositionMapping;
    state: ResourceSnapshot<SnapshotValue>; views: readonly PreparedView[] }>;
function historySelections(text: PreparedText): HistoryChange["selections"] {
    return Object.freeze(text.views.map(({ view, state }) => Object.freeze({ viewId: view.handle.id,
        before: view.state.get().selectionSet, after: state.selectionSet })));
}
type ResourceRecord = {
    handle: ResourceHandle<SnapshotValue>; documentId: DocumentId | null;
    state: Store<ResourceSnapshot<SnapshotValue>>; metadata: Store<ResourceMetadata>;
    document: Store<DocumentSnapshot | undefined>; saved: SnapshotValue | undefined;
    buffer: TextBuffer | null; savedBuffer: TextBuffer | null; change: DocumentChange | null; history: Store<HistorySnapshot>;
    views: Map<ViewId, ViewRecord>;
    leases: Set<symbol>; operations: Map<string | symbol, Operation>; nextOperation: number;
    saveReservations: number; reloadReservations: number; saving: symbol | null; editLease: EditLease | null;
};
const defaultCapabilities: Capabilities = Object.freeze({ edit: Object.freeze(["human", "agent", "host"] as const), save: true, run: true });
function capabilities(value: Capabilities): Capabilities {
    return Object.freeze({ edit: Object.freeze([...new Set(value.edit)]), save: value.save, run: value.run });
}
function sameMetadata(a: ResourceMetadata, b: ResourceMetadata): boolean {
    return (Object.keys(a) as (keyof ResourceMetadata)[]).every(key => a[key] === b[key]);
}
/** Tuple encoding preserves exact string components, including delimiters and empty values. */
function resourceKeyIdentity(key: ResourceKey): string { return JSON.stringify([key.scope, key.resource, key.variant]); }
function readySnapshot(metadata: ResourceMetadata, revision: number, value: SnapshotValue | TextBuffer): ResourceSnapshot<SnapshotValue> {
    if (!(value instanceof TextBuffer)) return Object.freeze({ state: "ready", revision, metadata, value: () => value });
    // History retains buffers, not these closures or their optional whole-text exports.
    let exported: string | undefined;
    return Object.freeze({ state: "ready", revision, metadata, value: () => { exported ??= value.text(); return exported; } });
}
/** Metadata changes retain the captured value reader and its optional cached export. */
function withMetadata(state: ResourceSnapshot<SnapshotValue>, metadata: ResourceMetadata): ResourceSnapshot<SnapshotValue> {
    if (state.metadata === metadata) return Object.freeze(state);
    return Object.freeze({ ...state, metadata });
}
function viewSnapshot(documentId: DocumentId, revision: number, selectionSet: SelectionSet): DocumentViewSnapshot {
    return Object.freeze({ documentId, revision, selection: selectionSet.ranges[selectionSet.primary]!, selectionSet });
}

/** Framework-free resource ownership and versioned transactions. All I/O is supplied by a host. */
export class Workspace {
    private readonly lifetime = Symbol("workspace");
    private nextId = 0;
    private nextAttachmentId = 0;
    private nextTransaction = 0;
    private readonly history: TextHistory;
    private readonly scope: NotificationScope;
    private readonly records = new Map<ResourceId, ResourceRecord>();
    private readonly resourceKeys = new Set<string>();
    private readonly handles = new WeakMap<object, ResourceRecord>();
    private readonly deferredReleases = new Map<ResourceId, boolean>();
    private readonly queuedReleases = new Set<ResourceId>();
    private readonly documents = new Map<DocumentId, ResourceRecord>();
    private readonly tabs: Store<readonly TabSnapshot[]>;
    private readonly tabIndex = new Map<TabId, TabSnapshot>();
    private inventoryTabs: readonly TabSnapshot[] = Object.freeze([]);
    private readonly state: Store<number>;
    private snapshot: WorkspaceSnapshot | undefined;
    readonly getSnapshot: () => WorkspaceSnapshot;
    readonly subscribe: (listener: () => void) => () => void;
    readonly tabState: Observable<readonly TabSnapshot[]>;

    constructor(options: WorkspaceOptions = {}) {
        this.history = new TextHistory(options.history);
        this.scope = new NotificationScope(options.onListenerError ?? (() => {}));
        this.tabs = new Store<readonly TabSnapshot[]>(Object.freeze([]), this.scope);
        this.state = new Store(0, this.scope);
        // Internal tabs still notify captured owners when their lifetime changes.
        this.tabState = Object.freeze({ getSnapshot: () => this.inventoryTabs, subscribe: this.tabs.observable.subscribe });
        this.getSnapshot = () => {
            if (!this.snapshot) {
                const resources: ResourceMetadata[] = [], documents: DocumentSnapshot[] = [];
                for (const record of this.records.values()) {
                    const metadata = record.metadata.get(); if (metadata.visibility === "internal") continue;
                    resources.push(metadata); const document = record.document.get(); if (document) documents.push(document);
                }
                this.snapshot = Object.freeze({ revision: this.state.get(),
                    resources: Object.freeze(resources), documents: Object.freeze(documents), tabs: this.inventoryTabs });
            }
            return this.snapshot;
        };
        this.subscribe = this.state.observable.subscribe;
    }

    /** Controller notifications share this workspace's write guard, with their own listeners/error policy. */
    createNotificationScope(onListenerError?: (error: unknown) => void): NotificationScope {
        return new NotificationScope(onListenerError, this.scope);
    }

    /** Allocate an opaque numeric identity shared by attachments to this workspace. */
    allocateIdentity(): number { return ++this.nextAttachmentId; }

    /** Allocate a resource key in this workspace, including across independently loaded views. */
    createResourceKey(scope: string, resource: string): ResourceKey {
        this.scope.assertWritable();
        let variant: string;
        do { variant = String(++this.nextId); } while (this.resourceKeys.has(resourceKeyIdentity({ scope, resource, variant })));
        return Object.freeze({ scope, resource, variant });
    }

    createResource<T extends SnapshotValue>(key: ResourceKey, title: string, loaded?: LoadedResource<T>, permissions = defaultCapabilities, options: ResourceOptions = {}): ResourceHandle<T> {
        return this.create(key, title, "panel", loaded, permissions, options) as ResourceHandle<T>;
    }
    createTextResource(key: ResourceKey, title: string, loaded?: LoadedResource<string>, permissions = defaultCapabilities, options: ResourceOptions = {}): TextResourceHandle {
        return this.create(key, title, "text", loaded, permissions, options) as TextResourceHandle;
    }
    /** Retain an immutable buffer directly, without exporting or reparsing its text. */
    createTextResourceFromBuffer(key: ResourceKey, title: string, loaded: LoadedTextBuffer, permissions = defaultCapabilities, options: ResourceOptions = {}): TextResourceHandle {
        return this.create(key, title, "text", loaded, permissions, options) as TextResourceHandle;
    }
    createDocument(key: ResourceKey, title: string, text: string): DocumentId {
        return this.createTextResource(key, title, { value: text }).documentId;
    }
    private create(key: ResourceKey, title: string, kind: "text" | "panel", loaded: LoadedResource<SnapshotValue> | LoadedTextBuffer | undefined, permissions: Capabilities, options: ResourceOptions): ResourceHandle<SnapshotValue> {
        this.scope.assertWritable();
        const visibility = options.visibility === undefined ? "workspace" : options.visibility;
        key = Object.freeze({ ...key });
        const identity = resourceKeyIdentity(key);
        if (this.resourceKeys.has(identity)) throw new Error("Resource already exists in this workspace.");
        if (loaded && "buffer" in loaded && kind !== "text") throw new TypeError("Only text resources accept a TextBuffer.");
        const value = loaded === undefined || "buffer" in loaded ? undefined : snapshotValue(loaded.value);
        if (kind === "text" && value !== undefined && typeof value !== "string") throw new TypeError("Text resource requires a string.");
        const buffer = loaded && "buffer" in loaded ? loaded.buffer : kind === "text" && typeof value === "string" ? TextBuffer.from(value) : null;
        const id = `resource-${++this.nextId}` as ResourceId;
        const documentId = kind === "text" ? `document-${++this.nextId}` as DocumentId : null;
        const metadata = Object.freeze({ id, key, title, kind, visibility,
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
            saveReservations: 0, reloadReservations: 0, saving: null, editLease: null };
        this.records.set(id, record); this.resourceKeys.add(identity); this.handles.set(handle, record);
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
    createDocumentView(id: DocumentId, initial: Selection | SelectionSet = { anchor: 0, head: 0 }): DocumentView {
        // View registration, like subscribing, may occur during host view attachment in a delivery.
        const document = this.document(id), record = this.documents.get(id)!;
        const selections = "ranges" in initial ? createSelectionSet(document.buffer.length, initial.ranges, initial.primary) : createSelectionSet(document.buffer.length, [initial]);
        const state = new Store<DocumentViewSnapshot>(viewSnapshot(id, document.revision, selections), this.scope);
        const folds = new Store<FoldingSnapshot>(foldingSnapshot(document.buffer, document.revision, 0, Object.freeze([])), this.scope);
        const viewId = `view-${++this.nextId}` as ViewId, retention = Symbol("view"); record.leases.add(retention);
        const lease = Object.freeze({ resourceId: record.handle.id, active: () => record.leases.has(retention), release: () => { record.leases.delete(retention); this.scheduleRelease(record.handle.id); } });
        const foldTarget = (expected: FoldVersion) => record.views.has(viewId) && record.state.get().state === "ready" && expected !== null && typeof expected === "object"
            && record.state.get().revision === expected.revision && folds.get().generation === expected.generation;
        const setFoldRegions = (regions: FoldingSnapshot["regions"]): boolean => {
            const previous = folds.get(); if (regions === previous.regions) return true;
            this.scope.assertWritable();
            const next = foldingSnapshot(record.buffer!, previous.revision, previous.generation + 1, regions, previous);
            if (!previous.index.sameProjection(next.index)) this.history.seal(id);
            this.scope.publish(folds, next); return true;
        };
        const folding: DocumentFolding = Object.freeze({ ...folds.observable,
            setRanges: (expected, ranges) => foldTarget(expected) && setFoldRegions(createFoldRegions(record.buffer!, ranges, folds.get().regions)),
            setCollapsed: (expected, id, collapsed) => {
                if (!foldTarget(expected)) return false;
                const previous = folds.get().regions, region = previous.find(r => r.id === id); if (!region) return false; if (region.collapsed === collapsed) return true;
                return setFoldRegions(collapseFoldRegion(previous, id, collapsed));
            },
            reveal: (expected, from, to) => foldTarget(expected) && setFoldRegions(revealFoldRange(record.buffer!, folds.get().regions, from, to, folds.get().index)),
            revealSelection: expected => foldTarget(expected) && setFoldRegions(revealSelectionFolds(record.buffer!, folds.get().regions, state.get().selectionSet, folds.get().index)) });
        const setSelections = (expectedRevision: number, ranges: readonly Selection[], primary = 0): boolean => {
            if (!record.views.has(viewId) || record.state.get().state !== "ready" || record.state.get().revision !== expectedRevision) return false;
            const next = createSelectionSet(record.buffer!.length, ranges, primary), previous = state.get();
            const priorFolds = folds.get(), revealed = revealSelectionFolds(record.buffer!, priorFolds.regions, next, priorFolds.index);
            if (sameSelectionSet(next, previous.selectionSet) && revealed === priorFolds.regions) return true;
            this.scope.assertWritable(); this.history.seal(id);
            const changed = new Set<Store<unknown>>();
            if (revealed !== priorFolds.regions) folds.set(foldingSnapshot(record.buffer!, expectedRevision, priorFolds.generation + 1, revealed, priorFolds), changed);
            if (!sameSelectionSet(next, previous.selectionSet)) state.set(viewSnapshot(id, previous.revision, next), changed);
            this.scope.deliver([...changed]); return true;
        };
        const handle: DocumentView = Object.freeze({ ...state.observable, id: viewId, documentId: id, folding,
            setSelection: (expectedRevision: number, value: Selection) => setSelections(expectedRevision, [value]), setSelections,
            dispose: () => { record.views.delete(viewId); lease.release(); } });
        record.views.set(viewId, { handle, state, folds, lease }); return handle;
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
        const ids = new Set<DocumentId>(), first = requests[0]!;
        const { kind = "replace", group, reset = false } = first.history ?? {};
        validateHistoryGroup(group);
        if (typeof reset !== "boolean") throw new TypeError("History reset must be a boolean.");
        if (reset && group !== undefined) throw new Error("A history reset cannot join an undo group.");
        const prepared = [];
        for (const request of requests) {
            if (ids.has(request.documentId)) throw new Error("A document may appear only once in a transaction."); ids.add(request.documentId);
            const policy = request.history;
            if (request.origin !== first.origin || (policy?.kind ?? "replace") !== kind || policy?.group !== group
                || (policy?.reset ?? false) !== reset) throw new Error("A text transaction has one origin and history policy.");
            const record = this.documents.get(request.documentId);
            if (!record || record.state.get().state === "released") return { applied: false, reason: "missing-document" };
            const refusal = this.validateEdit(record, request.expectedRevision, request.origin, request.lease); if (refusal) return refusal;
            const view = request.view === undefined ? undefined : record.views.get(request.view.id);
            if ((request.view && view?.handle !== request.view) || ((request.selection || request.selectionSet) && !view)) throw new Error("Selection target must be a live view of this document.");
            if (request.selection && request.selectionSet) throw new Error("Choose a single selection or a selection set.");
            const before = record.buffer!, result = before.apply(compactDocumentEdit(before, request.edits));
            const afterSelections = request.selectionSet ? createSelectionSet(result.buffer.length, request.selectionSet.ranges, request.selectionSet.primary)
                : request.selection ? createSelectionSet(result.buffer.length, [request.selection]) : view ? mapSelectionSet(result.mapping, view.state.get().selectionSet) : undefined;
            const text = result.buffer !== before ? this.prepareText(record, result.buffer, result.mapping,
                target => target === view ? afterSelections : undefined) : undefined;
            const selection = !text && view && afterSelections
                ? this.prepareView(view, request.documentId, record.state.get().revision, before, afterSelections, view.folds.get().regions) : undefined;
            prepared.push({ request, record, before, after: result.buffer, mapping: result.mapping, units: result.changedUnits, view, text, selection });
        }
        const actual = prepared.filter(change => change.before !== change.after);
        if (reset) {
            // Equal text also invalidates commands from before the host's restore.
            for (const id of ids) this.history.forget(id);
        } else if (actual.length) {
            const changes: HistoryChange[] = actual.map(change => Object.freeze({ documentId: change.request.documentId, before: change.before, after: change.after,
                mapping: change.mapping, units: change.units,
                initiatingView: change.view?.handle.id ?? null, selections: historySelections(change.text!) }));
            this.history.record(changes, first.origin, kind, requests.length === 1 ? group : undefined);
        }
        const changed = new Set<Store<unknown>>(), transactionId = actual.length ? ++this.nextTransaction : 0;
        for (const change of prepared) {
            if (change.text) this.commitText(change.text, first.origin, kind, transactionId, changed);
            if (change.selection) {
                const { view, state, folds } = change.selection;
                if (state !== view.state.get() || folds !== view.folds.get()) this.history.seal(change.request.documentId);
                this.commitView(change.selection, changed);
            }
        }
        this.syncHistory(changed); if (changed.size) { if (actual.length) this.publish(changed); else this.scope.deliver([...changed]); }
        return Object.freeze({ applied: true, revisions: Object.freeze(prepared.map(change => Object.freeze({ documentId: change.request.documentId, revision: change.record.state.get().revision }))) });
    }
    /** End grouping without creating an undo entry or changing the document revision. */
    sealHistory(id: DocumentId): void { this.scope.assertWritable(); this.document(id); this.history.seal(id); }
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
        const prepared = entry.changes.map(change => {
            const participant = this.documents.get(change.documentId as DocumentId)!, forward = change.mapping;
            const selections = new Map(change.selections.map(view => [view.viewId, direction === "undo" ? view.before : view.after]));
            return this.prepareText(participant, direction === "undo" ? change.before : change.after, direction === "undo" ? forward.invert() : forward,
                view => selections.get(view.handle.id));
        });
        this.history.move(entry, direction);
        const changed = new Set<Store<unknown>>(), transactionId = ++this.nextTransaction, revisions = [];
        for (const text of prepared) {
            this.commitText(text, origin, direction, transactionId, changed);
            revisions.push(Object.freeze({ documentId: text.record.documentId!, revision: text.state.revision }));
        }
        this.syncHistory(changed); this.publish(changed); return Object.freeze({ applied: true, revisions: Object.freeze(revisions) });
    }
    /** Prepare every projection before history, resource or view mutation, including linked documents. */
    private prepareText(record: ResourceRecord, buffer: TextBuffer, mapping: PositionMapping,
        selectionFor?: (view: ViewRecord) => SelectionSet | undefined): PreparedText {
        const current = record.state.get(), revision = current.revision + 1, before = record.buffer!;
        const state = readySnapshot({ ...current.metadata, dirty: record.savedBuffer === null || !buffer.equals(record.savedBuffer) }, revision, buffer), views = [];
        for (const view of record.views.values()) {
            const selections = selectionFor?.(view) ?? mapSelectionSet(mapping, view.state.get().selectionSet);
            const priorFolds = view.folds.get(), mapped = mapFoldRegions(buffer, mapping, priorFolds.regions, before);
            views.push(this.prepareView(view, record.documentId!, revision, buffer, selections, mapped));
        }
        return { record, buffer, mapping, state, views };
    }
    private prepareView(view: ViewRecord, documentId: DocumentId, revision: number, buffer: TextBuffer,
        selections: SelectionSet, mapped: FoldingSnapshot["regions"]): PreparedView {
        const priorFolds = view.folds.get(), priorState = view.state.get();
        const regions = revealSelectionFolds(buffer, mapped, selections,
            mapped === priorFolds.regions && buffer.lineCount === priorFolds.index.lineCount ? priorFolds.index : undefined);
        return { view, folds: revision === priorFolds.revision && regions === priorFolds.regions ? priorFolds
            : foldingSnapshot(buffer, revision, priorFolds.generation + 1, regions, priorFolds),
            state: revision === priorState.revision && sameSelectionSet(priorState.selectionSet, selections) ? priorState : viewSnapshot(documentId, revision, selections) };
    }
    private commitView(prepared: PreparedView, changed: Set<Store<unknown>>): void {
        prepared.view.folds.set(prepared.folds, changed); prepared.view.state.set(prepared.state, changed);
    }
    private commitText(prepared: PreparedText, origin: EditOrigin, kind: DocumentChange["kind"], transactionId: number, changed: Set<Store<unknown>>): void {
        const { record, buffer, mapping, state, views } = prepared;
        record.change = Object.freeze({ previousRevision: record.state.get().revision, mapping, transactionId, origin, kind });
        record.buffer = buffer; this.setRecord(record, state, changed);
        for (const view of views) this.commitView(view, changed);
    }
    private syncHistory(changed: Set<Store<unknown>>): void {
        for (const id of this.history.takeChangedDocuments()) {
            const record = this.documents.get(id as DocumentId); if (!record) continue;
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
        if (equalValue(current.value(), value)) return { applied: true, revision: current.revision };
        this.commitRecord(record, readySnapshot({ ...current.metadata, dirty: record.saved === undefined || !equalValue(record.saved, value) }, current.revision + 1, value));
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
        const record = this.requireResource(id), state = record.state.get();
        if (state.state !== "ready" || !state.metadata.capabilities.edit.includes(origin) || record.editLease) throw new Error("Resource cannot grant this edit lease.");
        const retention = this.acquire(record.handle.id);
        const lease: EditLease = Object.freeze({ ...retention, origin, release: () => {
            this.scope.assertWritable();
            if (record.editLease !== lease) return;
            record.editLease = null; retention.release();
            const current = record.state.get();
            this.commitRecord(record, withMetadata(current, { ...current.metadata, editLock: null }));
        } });
        record.editLease = lease;
        this.commitRecord(record, withMetadata(state, { ...state.metadata, editLock: Object.freeze({ owner, origin }) }));
        return lease;
    }

    /** Retain ownership; preventReload also protects captured work from replacement by a load. */
    acquire(id: ResourceId, options: Readonly<{ preventReload?: boolean }> = {}): ResourceLease {
        this.scope.assertWritable();
        const record = this.requireResource(id), lease = Symbol("resource-lease");
        const preventReload = options.preventReload ?? false;
        record.leases.add(lease); if (preventReload) record.reloadReservations++;
        return Object.freeze({ resourceId: id, active: () => record.leases.has(lease), release: () => {
            this.scope.assertWritable();
            if (record.leases.delete(lease) && preventReload) record.reloadReservations--;
            this.scheduleRelease(id);
        } });
    }
    ownership(id: ResourceId): Readonly<{ leases: number; tabs: number; saves: number }> {
        const record = this.requireResource(id);
        return Object.freeze({ leases: record.leases.size, saves: record.saveReservations, tabs: this.tabs.get().filter(tab => this.surfaceResource(tab.surface) === id).length });
    }
    beginOperation(id: ResourceId, lane: string | symbol, presentation?: TabTarget): Operation {
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
        if (record.metadata.get().dirty || record.saveReservations || record.editLease || record.reloadReservations) throw new Error("Cannot refresh local, locked or pending work.");
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
                for (const view of record.views.values()) {
                    view.folds.set(foldingSnapshot(record.buffer!, revision, view.folds.get().generation + 1, Object.freeze([])), changed);
                    view.state.set(viewSnapshot(record.documentId!, revision, createSelectionSet(record.buffer!.length, [{ anchor: 0, head: 0 }])), changed);
                }
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
            if (!Number.isSafeInteger(review.expectedRevision) || review.expectedRevision < 0) throw new TypeError("Reviewed save requires a revision and server version.");
            if (!review.target || this.resolveResource(review.target) !== handle) throw new Error("Reviewed save belongs to another resource or workspace.");
            if (initial.revision !== review.expectedRevision || record.saveReservations !== 0) throw new Error("Reviewed save has changed or another save is pending.");
        }
        const lease = this.acquire(handle.id), target = this.captureResource(handle.id), marker = Symbol("save");
        if (record.documentId !== null) this.history.seal(record.documentId);
        const value = initial.value() as Immutable<T>, revision = initial.revision, id = `save-${++this.nextId}`;
        const capturedBuffer = record.buffer;
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
                expectedServerVersion: reviewedVersion ?? current.metadata.serverVersion });
            status("saving"); return submission;
        }, accept: (response: Readonly<{ serverVersion: string; canonical?: T }>, options: Readonly<{ applyCanonical?: boolean }> = {}) => {
            const submitted = requireStarted();
            const savedValue = response.canonical === undefined ? value : snapshotValue(response.canonical);
            if (record.documentId !== null && typeof savedValue !== "string") throw new TypeError("Canonical text must be a string.");
            const current = record.state.get();
            if (current.state !== "ready") throw new Error("Saved resource is no longer ready.");
            const savedBuffer = capturedBuffer ? response.canonical === undefined || savedValue === value ? capturedBuffer : TextBuffer.from(savedValue as string) : null;
            const canonicalApplied = current.revision === revision && current.metadata.capabilities.edit.includes("host")
                && record.editLease === null && options.applyCanonical !== false
                && (savedBuffer ? !record.buffer!.equals(savedBuffer) : !equalValue(current.value(), savedValue));
            const canonical = savedBuffer && canonicalApplied ? record.buffer!.apply([textDifference(current.value() as string, savedValue as string)!]) : undefined;
            const text = canonical ? this.prepareText(record, canonical.buffer, canonical.mapping) : undefined;
            if (canonical && text) this.history.record([Object.freeze({ documentId: record.documentId!, before: record.buffer!, after: canonical.buffer,
                mapping: canonical.mapping, units: canonical.changedUnits, initiatingView: null, selections: historySelections(text) })], "host", "canonical");
            record.saved = savedBuffer ? undefined : savedValue; record.savedBuffer = savedBuffer; settled = true;
            const receipt = Object.freeze({ submission: submitted, savedValue, serverVersion: response.serverVersion, canonicalApplied });
            const changed = new Set<Store<unknown>>();
            if (savedBuffer) {
                if (text) this.commitText(text, "host", "canonical", ++this.nextTransaction, changed);
                const next = record.state.get();
                this.setRecord(record, withMetadata(next, { ...next.metadata, serverVersion: response.serverVersion,
                    dirty: !record.buffer!.equals(savedBuffer), saveStatus: record.saveReservations > 1 ? "saving" : "idle" }), changed);
            } else {
                const nextValue = canonicalApplied ? savedValue : current.value();
                this.setRecord(record, readySnapshot({ ...current.metadata, serverVersion: response.serverVersion, dirty: !equalValue(nextValue, savedValue),
                    saveStatus: record.saveReservations > 1 ? "saving" : "idle" }, current.revision + (canonicalApplied ? 1 : 0), nextValue), changed);
            }
            if (record.documentId !== null) this.history.seal(record.documentId); this.syncHistory(changed);
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
        this.scope.assertWritable(); const visibility = this.requireResource(this.surfaceResource(surface)).metadata.get().visibility;
        const id = `tab-${++this.nextId}` as TabId;
        this.publishTabs([...this.tabs.get(), Object.freeze({ id, paneId, generation: 0, surface: Object.freeze({ ...surface }), visibility })]);
        return id;
    }
    move(id: TabId, paneId: PaneId): void {
        this.scope.assertWritable();
        const current = this.requireTab(id);
        if (current.paneId === paneId) return;
        this.publishTabs(this.tabs.get().map(tab => tab.id === id ? Object.freeze({ ...tab, paneId }) : tab));
    }
    replace(id: TabId, surface: Surface): void {
        this.scope.assertWritable(); const previous = this.surfaceResource(this.requireTab(id).surface);
        const visibility = this.requireResource(this.surfaceResource(surface)).metadata.get().visibility;
        this.publishTabs(this.tabs.get().map(tab => tab.id === id ? Object.freeze({ ...tab, generation: tab.generation + 1, surface: Object.freeze({ ...surface }), visibility }) : tab));
        this.scheduleRelease(previous);
    }
    /** Immediate host decision. Use captureClose/completeClose for an asynchronous dirty prompt. */
    close(id: TabId): void {
        this.scope.assertWritable(); const previous = this.surfaceResource(this.requireTab(id).surface);
        this.publishTabs(this.tabs.get().filter(tab => tab.id !== id));
        this.scheduleRelease(previous);
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
    /** Release now, or after the last tab/lease leaves. Unsaved changes cancel a non-discarding release. */
    releaseResourceWhenUnowned(id: ResourceId, discard = false): void {
        this.scope.assertWritable(); const record = this.requireResource(id), owners = this.ownership(id);
        if (record.metadata.get().dirty && !discard) throw new Error("Explicit discard is required to release unsaved work.");
        if (!owners.tabs && !owners.leases) { this.releaseResource(id, discard); return; }
        this.deferredReleases.set(id, discard);
    }
    private scheduleRelease(id: ResourceId): void {
        if (!this.deferredReleases.has(id) || this.queuedReleases.has(id)) return;
        this.queuedReleases.add(id);
        // View disposal can occur during notification. Release after the complete delivery,
        // and recheck ownership in case a host attached another view before this microtask.
        void Promise.resolve().then(() => {
            this.queuedReleases.delete(id);
            const discard = this.deferredReleases.get(id), record = this.records.get(id);
            if (discard === undefined || !record) return;
            if (record.metadata.get().dirty && !discard) { this.deferredReleases.delete(id); return; }
            const owners = this.ownership(id); if (!owners.tabs && !owners.leases) this.releaseResource(id, discard);
        });
    }
    releaseResource(id: ResourceId, discard = false): void {
        this.scope.assertWritable();
        const record = this.requireResource(id), owners = this.ownership(id), state = record.state.get();
        if (owners.tabs || owners.leases) throw new Error("Resource still has tabs or operation leases.");
        if (state.metadata.dirty && !discard) throw new Error("Explicit discard is required to release unsaved work.");
        record.saved = undefined; record.buffer = null; record.savedBuffer = null; record.change = null;
        if (record.documentId !== null) this.history.forget(record.documentId);
        this.records.delete(id); this.resourceKeys.delete(resourceKeyIdentity(state.metadata.key)); this.deferredReleases.delete(id);
        const changed = new Set<Store<unknown>>();
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
        const tab = target.workspace === this.lifetime ? this.tabIndex.get(target.id) : undefined;
        return tab?.generation === target.generation ? tab : undefined;
    }
    private requireTab(id: TabId): TabSnapshot {
        const tab = this.tabIndex.get(id);
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
            title: state.metadata.title, buffer, text: state.value as () => string, revision: state.revision, change: record.change }), changed);
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
        const visible: TabSnapshot[] = []; let sameVisible = true;
        this.tabIndex.clear();
        for (const tab of tabs) {
            this.tabIndex.set(tab.id, tab);
            if (tab.visibility === "workspace") { if (tab !== this.inventoryTabs[visible.length]) sameVisible = false; visible.push(tab); }
        }
        const all = Object.freeze(tabs);
        if (!sameVisible || visible.length !== this.inventoryTabs.length) this.inventoryTabs = visible.length === all.length ? all : Object.freeze(visible);
        const changed = new Set<Store<unknown>>(); this.tabs.set(all, changed); this.publish(changed);
    }
    private publish(changed: Set<Store<unknown>>): void {
        // Scoped consumers need no coarse inventory. A requested snapshot is captured in full,
        // so held older snapshots stay immutable even after later publications or resource release.
        this.snapshot = undefined;
        this.state.set(this.state.get() + 1, changed);
        this.scope.deliver([...changed]);
    }
}
