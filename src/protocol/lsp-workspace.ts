import { wireLimits, ProtocolDecodeError, rpcCodes, cancelledRequest, staleRequest, closedConnection, RpcError } from "./wire.ts";
import type { DocumentId, DocumentSnapshot, ResourceLease, Workspace } from "../core/workspace.ts";
import { NotificationScope, Store } from "../core/observable.ts";
import { anchoredRange } from "../core/positions.ts";
import type { Observable } from "../core/observable.ts";
import { LspSession } from "./lsp-session.ts";
import type { LspDocument, LspDocumentCapture, LspDocumentSnapshot, LspRequestContext, LspSessionOptions, LspSessionSnapshot } from "./lsp-session.ts";
import type { RpcCall } from "./json-rpc.ts";
import type { JsonValue } from "./wire.ts";
import { decodeLspDiagnostics } from "./lsp-features.ts";
import type { LspDiagnostics } from "./lsp-features.ts";
import type { LspTargetResolver } from "./lsp-targets.ts";

export type LspSessionAccess = Pick<LspSession, "state" | "connect" | "disconnect" | "dispose" | "flush" | "bindDocument" | "synchronized" | "requestDocument" | "canRequest" | "featureOptions" | "commandNames" | "requestCommand" | "request" | "notify" | "onRequest" | "onNotification" | "snapshotOwnership">;
/** Optional host custom-message preparation, inside the feature's captured request lifetime. */
export type LspPrepare = (session: LspSessionAccess) => Promise<unknown>;
export type LspWorkspaceScope = Omit<LspSessionAccess, "state"> & Readonly<{
    state: Observable<LspWorkspaceSnapshot>;
    attachDocument: (id: DocumentId) => LspDocument;
    setDocuments: (documents: readonly DocumentSnapshot[]) => ReadonlyMap<string, LspDocument>;
    /** Read-only handle/snapshot validation, including Workspace edits not yet synchronized. */
    isDocumentCurrent: (document: LspDocument, snapshot: LspDocumentSnapshot) => boolean;
    captureProject: () => ReadonlyMap<string, LspDocumentCapture>;
    observeDiagnostics: (document: LspDocument) => Observable<LspDiagnosticState>;
    reserveCommand: () => Readonly<{ isCurrent: () => boolean; release: () => void }>;
    resolveTarget: LspTargetResolver;
    /** Route deferred host callback failures through the provider's existing onError policy. */
    reportError: (error: unknown) => void;
}>;
export type LspDiagnosticState = Readonly<{ status: "empty" | "current" | "pending" | "expired"; result: LspDiagnostics | null;
    received: number; stale: number; invalid: number;
    /** Provider result still belongs to the synchronized source; always false for mapped pending results. */
    isCurrent: () => boolean;
    /** Display/navigation offsets still belong to the local source, including mapped pending results. */
    isPlacementCurrent: () => boolean }>;
export type LspWorkspaceSnapshot = LspSessionSnapshot & Readonly<{ commandAvailable: boolean; commandRequiresReconnect: boolean }>;
export type LspWorkspaceOptions = LspSessionOptions & Readonly<{
    /** URI/language policy at participation. Replace bindings explicitly when provider configuration changes. */
    documentInfo: (document: DocumentSnapshot) => Readonly<{ uri: string; languageId: string }> | undefined;
    /** Load an opaque URI on demand, returning a retained immutable target; never open a view here. */
    resolveTarget?: LspTargetResolver;
    maxScopes?: number;
}>;

type Handler = Parameters<LspSession["onRequest"]>[1];
type DocumentEntry = { id: DocumentId; binding: LspDocument; lease: ResourceLease; active: boolean; queued: boolean; stop: () => void; users: Set<() => void>; diagnostics: Store<LspDiagnosticState> };
type Scope = { active: boolean; generation: number; close: () => void; applyEdit: Handler | undefined; incoming: Set<() => void> };
type CommandIntent = { scope: Scope; epoch: number; generation: number; registrationGeneration: number; sent: boolean; cancelled: boolean; listeners: Set<() => void> };
const stale = () => staleRequest("Captured provider participation changed.");
const cancelled = () => cancelledRequest("Provider feature scope was cancelled.");

/** One explicitly owned provider connection and synchronization stream per workspace/configuration.
 * Feature scopes own requests and document participation; they never own the shared transport.
 */
export class LspWorkspace {
    private readonly workspace: Workspace;
    private readonly options: LspWorkspaceOptions;
    private readonly session: LspSession;
    private readonly documents = new Map<DocumentId, DocumentEntry>();
    private readonly uris = new Map<string, DocumentEntry>();
    private readonly scopes = new Set<Scope>();
    private readonly notifications: NotificationScope;
    private readonly store: Store<LspWorkspaceSnapshot>;
    private readonly observers = new Set<() => void>();
    private readonly stopState: () => void;
    private readonly stopApply: (() => void) | undefined;
    private readonly stopDiagnostics: (() => void) | undefined;
    private notificationQueued = false;
    private changed = new Set<Store<unknown>>();
    private disposed = false;
    private created = 0;
    private terminated = 0;
    private unknownDiagnosticUris = 0;
    private command: CommandIntent | undefined;
    private quarantinedEpoch: number | undefined;
    readonly state: Observable<LspWorkspaceSnapshot>;

    constructor(workspace: Workspace, options: LspWorkspaceOptions) {
        this.workspace = workspace; this.options = options;
        if (!Number.isSafeInteger(options.maxScopes ?? wireLimits.scopes) || (options.maxScopes ?? wireLimits.scopes) < 1) throw new RangeError("Invalid provider scope limit.");
        this.notifications = workspace.createNotificationScope(error => this.report(error));
        this.session = new LspSession({ ...options, connect: async context => {
            const transport = await options.connect(context); this.created++; let released = false;
            return { send: text => transport.send(text), subscribe: listener => transport.subscribe(listener), dispose: () => {
                if (released) return; released = true; this.terminated++; transport.dispose();
            } };
        } });
        this.store = new Store(this.snapshotState(), this.notifications);
        this.state = Object.freeze({ getSnapshot: this.store.observable.getSnapshot, subscribe: listener => {
            this.writable(); const stop = this.store.observable.subscribe(listener);
            const release = () => { stop(); this.observers.delete(release); }; this.observers.add(release); return release;
        } });
        this.stopState = this.session.state.subscribe(() => {
            const next = this.session.state.getSnapshot();
            if (next.phase !== "ready" || next.epoch !== this.store.get().epoch) for (const entry of this.documents.values()) this.expireDiagnostics(entry);
            if (this.command && (this.command.epoch !== next.epoch || this.command.registrationGeneration !== next.registrationGeneration)) this.endCommand(this.command, this.command.sent && this.command.epoch === next.epoch);
            if (this.quarantinedEpoch !== next.epoch) this.quarantinedEpoch = undefined;
            this.store.set(this.snapshotState(), this.changed);
            // Bind/close operations finish their ownership changes before observers can react.
            this.queueDelivery();
        });
        this.stopDiagnostics = options.diagnostics ? this.session.onNotification("textDocument/publishDiagnostics", value => {
            const uri = value && typeof value === "object" && "uri" in value ? value.uri : undefined;
            const entry = typeof uri === "string" ? this.uris.get(uri) : undefined;
            if (!entry) { this.unknownDiagnosticUris++; return; }
            const previous = entry.diagnostics.get(), sent = this.session.synchronized(entry.binding);
            const isCurrent = () => { const now = this.session.synchronized(entry.binding); return this.live(entry) && !!sent && !!now && now.epoch === sent.epoch && now.version === sent.version && now.document === sent.document; };
            try {
                if (!sent || !isCurrent()) throw stale();
                const result = decodeLspDiagnostics(value, Object.freeze({ ...sent, isCurrent }));
                entry.diagnostics.set(Object.freeze({ ...previous, status: "current", result, received: previous.received + 1, isCurrent, isPlacementCurrent: isCurrent }), this.changed);
            } catch (error) {
                if (!(error instanceof ProtocolDecodeError) && !(error instanceof RpcError && error.code === rpcCodes.contentModified)) throw error;
                const key = error instanceof RpcError && error.code === rpcCodes.contentModified ? "stale" : "invalid";
                entry.diagnostics.set(Object.freeze({ ...previous, [key]: previous[key] + 1 }), this.changed);
            }
            this.queueDelivery();
        }) : undefined;
        this.stopApply = options.applyEdit ? this.session.onRequest("workspace/applyEdit", (value, context) => {
            const owner = this.command;
            if (!owner || !owner.sent || !this.commandCurrent(owner) || owner.epoch !== context.epoch || !owner.scope.applyEdit) return { applied: false, failureReason: "No available captured command review intent." };
            const isCurrent = () => context.isCurrent() && this.commandCurrent(owner);
            const captured: LspRequestContext = Object.freeze({ id: context.id, epoch: context.epoch, get cancelled() { return context.cancelled || !isCurrent(); }, isCurrent,
                onCancel: listener => { let done = false; const notify = () => { if (!done) { done = true; void Promise.resolve().then(listener).catch(error => this.report(error)); } }; const stop = context.onCancel(notify);
                    owner.listeners.add(notify); if (!isCurrent()) notify(); return () => { done = true; stop(); owner.listeners.delete(notify); }; } });
            return owner.scope.applyEdit(value, captured);
        }) : undefined;
    }
    private report(error: unknown): void { try { this.options.onError?.(error instanceof Error ? error : new Error(String(error))); } catch { /* Reporting cannot prevent cleanup. */ } }
    private commandCurrent(intent: CommandIntent): boolean { const state = this.session.state.getSnapshot(); return this.command === intent && !intent.cancelled && intent.scope.active && intent.scope.generation === intent.generation && state.phase === "ready" && state.epoch === intent.epoch && state.registrationGeneration === intent.registrationGeneration; }
    private endCommand(intent: CommandIntent, quarantine: boolean, cancelled = true): void {
        if (quarantine) this.quarantinedEpoch = intent.epoch; if (cancelled) intent.cancelled = true;
        if (this.command === intent) this.command = undefined;
        for (const listener of [...intent.listeners]) listener(); intent.listeners.clear();
        this.store.set(this.snapshotState(), this.changed); this.queueDelivery();
    }
    private snapshotState(): LspWorkspaceSnapshot { const state = this.session.state.getSnapshot(), commandRequiresReconnect = this.quarantinedEpoch === state.epoch;
        return Object.freeze({ ...state, commandAvailable: state.phase === "ready" && !this.command && !commandRequiresReconnect, commandRequiresReconnect }); }
    private writable(): void { this.notifications.assertWritable(); if (this.disposed) throw closedConnection("Provider owner is disposed."); }
    private deliver(): void { this.notificationQueued = false; const changed = this.changed; this.changed = new Set(); if (changed.size) this.notifications.deliver([...changed]); }
    private queueDelivery(): void { if (!this.notificationQueued) { this.notificationQueued = true; void Promise.resolve().then(() => this.deliver()).catch(error => this.report(error)); } }
    private expireDiagnostics(entry: DocumentEntry): void {
        const before = entry.diagnostics.get(); if (before.result === null) return;
        entry.diagnostics.set(Object.freeze({ ...before, status: "expired", result: null, isCurrent: () => false, isPlacementCurrent: () => false }), this.changed); this.queueDelivery();
    }
    private mapDiagnostics(entry: DocumentEntry): void {
        const before = entry.diagnostics.get(), result = before.result;
        if (!result) return;
        const next = this.workspace.observeDocument(entry.id).getSnapshot(), session = this.session.state.getSnapshot();
        if (!next || next.resourceId !== entry.binding.getSnapshot().resourceId || session.phase !== "ready") { this.expireDiagnostics(entry); return; }
        if (next.revision === result.snapshotRevision) return;
        if (next.change?.previousRevision !== result.snapshotRevision) { this.expireDiagnostics(entry); return; }
        const mapping = next.change.mapping;
        const items = result.items.flatMap(item => {
            if (item.placement !== "placed") return [item];
            const range = mapping.mapRange(anchoredRange(mapping.oldLength, item.from!, item.to!, { onDelete: "invalidate" }));
            return range ? [Object.freeze({ ...item, from: range.from, to: range.to })] : [];
        });
        const isPlacementCurrent = () => {
            if (!entry.active) return false;
            const now = this.workspace.observeDocument(entry.id).getSnapshot(), provider = this.session.state.getSnapshot();
            return provider.phase === "ready" && provider.epoch === session.epoch
                && now?.resourceId === next.resourceId && now.revision === next.revision && now.buffer === next.buffer;
        };
        // Preserve provider version, original wire ranges and metadata as provenance, not fresh edit authority.
        entry.diagnostics.set(Object.freeze({ ...before, status: "pending", result: Object.freeze({ ...result, snapshotRevision: next.revision, items: Object.freeze(items) }),
            isCurrent: () => false, isPlacementCurrent }), this.changed); this.queueDelivery();
    }
    private document(id: DocumentId): DocumentEntry {
        this.writable(); const current = this.workspace.document(id), info = this.options.documentInfo(current);
        if (!info) throw new Error("Document is outside this provider configuration.");
        const old = this.documents.get(id);
        if (old && old.binding.getSnapshot().resourceId === current.resourceId && old.binding.getSnapshot().uri === info.uri && old.binding.getSnapshot().languageId === info.languageId) { this.synchronize(old); if (!old.active) throw stale(); return old; }
        if (old) this.closeDocument(old);
        if (this.uris.has(info.uri)) throw new Error("Provider URI is already owned by another document.");
        const lease = this.workspace.acquire(current.resourceId); let binding: LspDocument;
        try { binding = this.session.bindDocument({ ...info, resourceId: current.resourceId, documentId: id, revision: current.revision, buffer: current.buffer }); }
        catch (error) { lease.release(); throw error; }
        const entry: DocumentEntry = { id, binding, lease, active: true, queued: false, stop: () => {}, users: new Set(),
            diagnostics: new Store<LspDiagnosticState>(Object.freeze({ status: "empty", result: null, received: 0, stale: 0, invalid: 0, isCurrent: () => false, isPlacementCurrent: () => false }), this.notifications) };
        this.documents.set(id, entry); this.uris.set(info.uri, entry);
        entry.stop = this.workspace.observeDocument(id).subscribe(() => {
            this.mapDiagnostics(entry);
            if (!entry.active || entry.queued) return; entry.queued = true;
            void Promise.resolve().then(() => { entry.queued = false; this.synchronize(entry); });
        });
        return entry;
    }
    private live(entry: DocumentEntry): boolean {
        if (!entry.active) return false;
        const current = this.workspace.observeDocument(entry.id).getSnapshot(), sent = entry.binding.getSnapshot();
        return current?.revision === sent.revision && current.buffer === sent.buffer;
    }
    private synchronize(entry: DocumentEntry): void {
        if (!entry.active) return; const next = this.workspace.observeDocument(entry.id).getSnapshot();
        if (!next) { this.closeDocument(entry); return; }
        try { const before = entry.binding.getSnapshot();
            if (before.revision !== next.revision) entry.binding.update(before.revision, next.revision, next.buffer,
                next.change?.previousRevision === before.revision ? next.change.mapping : undefined);
            else if (before.buffer !== next.buffer) throw new Error("A provider revision cannot name different buffers.");
        } catch (error) { this.closeDocument(entry); this.report(error); }
    }
    private closeDocument(entry: DocumentEntry): void {
        if (!entry.active) return; entry.active = false; this.expireDiagnostics(entry); this.documents.delete(entry.id); this.uris.delete(entry.binding.getSnapshot().uri);
        entry.stop(); entry.binding.close(); for (const close of [...entry.users]) close();
        // Workspace observers run inside commit delivery, where lease writes must be deferred.
        void Promise.resolve().then(() => { try { entry.lease.release(); } catch (error) { this.report(error); } });
    }
    connect(): Promise<void> { this.writable(); for (const entry of [...this.documents.values()]) this.synchronize(entry); return this.session.connect(); }
    flush(): Promise<void> { this.writable(); for (const entry of [...this.documents.values()]) this.synchronize(entry); return this.session.flush(); }
    disconnect(): void { this.writable(); this.session.disconnect(); }
    async reconnect(): Promise<void> { this.disconnect(); await this.connect(); }

    createScope(): LspWorkspaceScope {
        this.writable(); if (this.scopes.size >= (this.options.maxScopes ?? wireLimits.scopes)) throw new RangeError("Provider scope limit exceeded.");
        const scope: Scope = { active: true, generation: 0, close: () => {}, applyEdit: undefined, incoming: new Set() }, documents = new Map<string, LspDocument>();
        const handles = new Map<LspDocument, DocumentEntry>(), pending = new Set<{ cancel: () => void }>(), stops = new Set<() => void>();
        const documentCalls = new Map<LspDocument, Set<{ cancel: () => void }>>();
        let closedState: LspWorkspaceSnapshot | undefined;
        const writable = () => { this.writable(); if (!scope.active) throw cancelled(); };
        const current = (generation: number) => scope.active && scope.generation === generation && !this.disposed;
        const track = <T, C extends { result: Promise<T>; cancel: () => void }>(call: C): C => {
            const generation = scope.generation; let wasCancelled = false;
            const tracked = Object.freeze({ ...call, cancel: () => { wasCancelled = true; call.cancel(); }, result: call.result.then(result => {
                if (!current(generation) || wasCancelled) throw cancelled(); return result;
            }) }); pending.add(tracked); void tracked.result.then(() => pending.delete(tracked), () => pending.delete(tracked)); return tracked as C;
        };
        const unwrap = (document: LspDocument) => { const entry = handles.get(document); if (!scope.active || !entry?.active) throw stale(); return entry.binding; };
        const capture = (document: LspDocument): LspDocumentCapture | undefined => {
            const entry = handles.get(document); if (!scope.active || !entry || !this.live(entry)) return;
            const value = this.session.synchronized(unwrap(document)); if (!value) return; const generation = scope.generation;
            return Object.freeze({ ...value, isBindingCurrent: () => current(generation) && handles.has(document) && entry.active && (value.isBindingCurrent?.() ?? value.isCurrent()),
                isCurrent: () => current(generation) && handles.has(document) && this.live(entry) && value.isCurrent() });
        };
        const attach = (id: DocumentId): LspDocument => {
            writable(); const existing = documents.get(id), old = existing && handles.get(existing); if (old?.active) { this.synchronize(old); if (!old.active) throw stale(); return existing!; }
            const entry = this.document(id); let active = true;
            const close = () => { if (!active) return; active = false; for (const call of documentCalls.get(document) ?? []) call.cancel(); documentCalls.delete(document);
                handles.delete(document); documents.delete(id); entry.users.delete(close); if (entry.active && !entry.users.size) this.closeDocument(entry); };
            const document: LspDocument = Object.freeze({ getSnapshot: entry.binding.getSnapshot, close, update: (expected, revision, buffer) => {
                writable(); if (!active || !entry.active) throw stale(); const latest = this.workspace.document(id), before = entry.binding.getSnapshot();
                if (latest.revision !== revision || latest.buffer !== buffer) throw stale();
                if (before.revision === revision && before.buffer === buffer) return;
                if (before.revision !== expected) throw stale(); entry.binding.update(expected, revision, buffer,
                    latest.change?.previousRevision === expected ? latest.change.mapping : undefined);
            } });
            documents.set(id, document); handles.set(document, entry); entry.users.add(close); return document;
        };
        const listen = (stop: () => void) => { const release = () => { stops.delete(release); stop(); }; stops.add(release); return release; };
        const disconnect = () => { if (!scope.active) return; scope.generation++; if (this.command?.scope === scope) this.endCommand(this.command, this.command.sent); for (const notify of [...scope.incoming]) notify(); for (const call of [...pending]) call.cancel(); };
        scope.close = () => {
            if (!scope.active) return; disconnect(); scope.active = false; closedState = Object.freeze({ ...this.state.getSnapshot(), phase: "disposed", commandAvailable: false });
            for (const stop of [...stops]) stop(); for (const document of [...documents.values()]) document.close(); this.scopes.delete(scope); scope.applyEdit = undefined;
        };
        this.scopes.add(scope);
        const state: Observable<LspWorkspaceSnapshot> = Object.freeze({ getSnapshot: () => closedState ?? this.state.getSnapshot(), subscribe: listener => { writable(); return listen(this.state.subscribe(listener)); } });
        const reserve = (): CommandIntent => {
            writable(); const state = this.session.state.getSnapshot();
            if (state.phase !== "ready" || this.command || this.quarantinedEpoch === state.epoch) throw staleRequest("Provider command lane requires an available captured intent or fresh connection.");
            const intent: CommandIntent = { scope, epoch: state.epoch, generation: scope.generation, registrationGeneration: state.registrationGeneration, sent: false, cancelled: false, listeners: new Set() };
            this.command = intent; this.store.set(this.snapshotState(), this.changed); this.queueDelivery(); return intent;
        };
        const scopedHandler = (handler: Handler): Handler => (value, context) => new Promise((resolve, reject) => {
            const generation = scope.generation, listeners = new Set<() => void>(); let done = false, stopRemote = () => {};
            const isCurrent = () => current(generation) && context.isCurrent();
            const finish = (complete: () => void) => { if (done) return; done = true; scope.incoming.delete(invalidated); stopRemote(); listeners.clear(); complete(); };
            const invalidated = () => { if (isCurrent()) return;
                for (const listener of [...listeners]) listener(); finish(() => reject(cancelled())); };
            const captured: LspRequestContext = Object.freeze({ id: context.id, epoch: context.epoch, get cancelled() { return context.cancelled || !isCurrent(); }, isCurrent,
                onCancel: listener => { let stopped = false; const notify = () => { if (!stopped) { stopped = true; void Promise.resolve().then(listener).catch(error => this.report(error)); } };
                    if (!isCurrent()) notify(); else listeners.add(notify); return () => { stopped = true; listeners.delete(notify); }; } });
            scope.incoming.add(invalidated); stopRemote = context.onCancel(invalidated); if (done) stopRemote(); else invalidated();
            void Promise.resolve().then(() => { if (!isCurrent()) throw cancelled(); return handler(value, captured); }).then(
                result => finish(() => { if (isCurrent()) resolve(result); else reject(cancelled()); }), error => finish(() => reject(error)));
        });
        const api: LspWorkspaceScope = Object.freeze({ state, reportError: error => this.report(error),
            resolveTarget: async (uri, context) => {
                writable(); const generation = scope.generation;
                if (!context.isCurrent()) throw stale();
                const result = await this.options.resolveTarget?.(uri, context); if (!result) return undefined;
                let released = false;
                const release = () => { if (released) return; released = true;
                    try { void Promise.resolve(result.release()).catch(error => this.report(error)); } catch (error) { this.report(error); } };
                if (!current(generation) || !context.isCurrent()) { release(); throw stale(); }
                return Object.freeze({ target: result.target, release });
            },
            reserveCommand: () => { const intent = reserve(); return Object.freeze({ isCurrent: () => this.commandCurrent(intent),
                release: () => { if (this.command === intent) this.endCommand(intent, intent.sent); } }); },
            attachDocument: attach,
            isDocumentCurrent: (document, snapshot) => {
                const entry = handles.get(document);
                return scope.active && !this.disposed && !!entry?.active && entry.binding.getSnapshot() === snapshot && this.live(entry);
            },
            observeDiagnostics: document => {
                writable(); unwrap(document); const store = handles.get(document)!.diagnostics;
                return Object.freeze({ getSnapshot: store.observable.getSnapshot, subscribe: listener => {
                    writable(); const stop = store.observable.subscribe(listener); const release = () => { stop(); this.observers.delete(release); };
                    this.observers.add(release); return listen(release);
                } });
            },
            setDocuments: snapshots => {
                writable(); const ids = new Set(snapshots.map(snapshot => snapshot.id)); if (ids.size !== snapshots.length) throw new Error("Provider project repeats a document.");
                const uris = new Set<string>();
                for (const snapshot of snapshots) { const live = this.workspace.document(snapshot.id), info = this.options.documentInfo(live);
                    if (live.revision !== snapshot.revision || live.buffer !== snapshot.buffer || live.resourceId !== snapshot.resourceId) throw stale();
                    if (!info || uris.has(info.uri)) throw new Error("Provider project has unavailable or repeated URI mappings."); uris.add(info.uri);
                }
                const added: LspDocument[] = [];
                try { for (const snapshot of snapshots) { const existed = documents.has(snapshot.id); const document = attach(snapshot.id); if (!existed) added.push(document); } }
                catch (error) { for (const document of added) document.close(); throw error; }
                for (const [id, document] of [...documents]) if (!ids.has(id as DocumentId)) document.close(); return new Map(documents);
            },
            captureProject: () => { writable(); return new Map([...documents.values()].map(document => { const value = capture(document); if (!value) throw stale(); return [value.document.uri, value] as const; })); },
            bindDocument: snapshot => {
                writable(); const live = this.workspace.document(snapshot.documentId as DocumentId), info = this.options.documentInfo(live);
                if (live.resourceId !== snapshot.resourceId || live.revision !== snapshot.revision || live.buffer !== snapshot.buffer || info?.uri !== snapshot.uri || info.languageId !== snapshot.languageId) throw stale();
                return attach(live.id);
            },
            connect: async () => { writable(); const generation = scope.generation; await this.connect(); if (!current(generation)) throw cancelled(); },
            disconnect, dispose: () => { if (!scope.active) return; this.notifications.assertWritable(); scope.close(); },
            flush: async selected => { writable(); const generation = scope.generation, captured = selected && [...selected];
                if (captured) {
                    const bindings = captured.map(document => { const entry = handles.get(document); if (!entry) throw stale(); this.synchronize(entry); return unwrap(document); });
                    await this.session.flush(bindings);
                } else await this.flush();
                if (!current(generation)) throw cancelled();
                for (const document of captured ?? []) unwrap(document); },
            synchronized: capture,
            canRequest: (method, document) => scope.active && handles.get(document)?.active === true && this.session.canRequest(method, unwrap(document)),
            featureOptions: (method, document) => scope.active && handles.get(document)?.active ? this.session.featureOptions(method, unwrap(document)) : Object.freeze([]),
            commandNames: () => scope.active ? this.session.commandNames() : Object.freeze([]),
            requestDocument: <T = JsonValue>(method: Parameters<LspSession["requestDocument"]>[0], document: LspDocument, params: Parameters<LspSession["requestDocument"]>[2]) => {
                writable(); const generation = scope.generation, entry = handles.get(document); if (!entry) throw stale(); this.synchronize(entry);
                const raw = this.session.requestDocument<T>(method, unwrap(document), (index, snapshot, captured) => {
                    const value = Object.freeze({ ...captured, isBindingCurrent: () => current(generation) && handles.has(document) && entry.active && (captured.isBindingCurrent?.() ?? captured.isCurrent()),
                        isCurrent: () => current(generation) && handles.has(document) && this.live(entry) && captured.isCurrent() }); return params(index, snapshot, value);
                });
                const call = track({ ...raw, result: raw.result.then(value => { if (!handles.has(document) || !this.live(entry)) throw stale(); return value; }) });
                const calls = documentCalls.get(document) ?? new Set(); documentCalls.set(document, calls); calls.add(call);
                const settled = () => { calls.delete(call); if (!calls.size) documentCalls.delete(document); }; void call.result.then(settled, settled); return call;
            },
            request: <T = JsonValue>(method: string, params?: JsonValue): RpcCall<T> => { writable(); return track(this.session.request<T>(method, params)); },
            notify: (method, params) => { writable(); this.session.notify(method, params); },
            onRequest: (method, handler) => {
                writable(); if (method !== "workspace/applyEdit") return listen(this.session.onRequest(method, scopedHandler(handler)));
                if (!this.options.applyEdit || scope.applyEdit) throw new TypeError("Duplicate or unadvertised edit handler."); scope.applyEdit = handler;
                return listen(() => { if (scope.applyEdit === handler) scope.applyEdit = undefined; });
            },
            onNotification: (method, handler) => { writable(); return listen(this.session.onNotification(method, (value, epoch) => { if (scope.active) return handler(value, epoch); })); },
            requestCommand: <T = JsonValue>(command: string, args: readonly JsonValue[] = [], timeoutMs?: number, authorization?: Parameters<LspSession["requestCommand"]>[3]) => {
                writable(); const reserved = this.command;
                if (reserved && (reserved.scope !== scope || reserved.sent || !this.commandCurrent(reserved))) throw staleRequest("Provider command lane is unavailable.");
                const intent = reserved ?? reserve(); intent.sent = true; let waiting = true;
                try {
                    const raw = this.session.requestCommand<T>(command, args, timeoutMs, authorization), call = track({ ...raw, cancel: () => { if (waiting) this.endCommand(intent, true); raw.cancel(); } });
                    const result = call.result.then(value => { waiting = false; return value; }, error => { waiting = false; if (error instanceof RpcError && error.code === rpcCodes.timeout) this.endCommand(intent, true); throw error; })
                        .finally(() => this.endCommand(intent, false, false));
                    return Object.freeze({ ...call, result, isCurrent: () => scope.active && scope.generation === intent.generation && !intent.cancelled && raw.isCurrent() });
                } catch (error) { this.endCommand(intent, false); throw error; }
            },
            snapshotOwnership: () => this.session.snapshotOwnership(),
        });
        return api;
    }
    snapshot() {
        return Object.freeze({ disposed: this.disposed, scopes: this.scopes.size, documents: this.documents.size,
            documentParticipants: [...this.documents.values()].reduce((sum, entry) => sum + entry.users.size, 0), created: this.created, terminated: this.terminated,
            commandPending: !!this.command, commandQuarantined: this.quarantinedEpoch === this.state.getSnapshot().epoch, unknownDiagnosticUris: this.unknownDiagnosticUris, protocol: this.session.snapshotOwnership() });
    }
    dispose(): void {
        if (this.disposed) return; this.notifications.assertWritable(); this.disposed = true;
        for (const scope of [...this.scopes]) scope.close(); for (const entry of [...this.documents.values()]) this.closeDocument(entry);
        this.stopApply?.(); this.stopDiagnostics?.(); this.session.dispose(); this.stopState(); this.deliver(); for (const stop of [...this.observers]) stop();
    }
}
