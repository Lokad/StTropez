import { emptyList } from "../core/empty-list.ts";
import { invalidRange, isPositiveInteger } from "../core/bounds.ts";
import { applyEditMethod, didChangeMethod, executeCommandMethod } from "./lsp-methods.ts";
import { wireLimits, isLspUri, isLspIdentityPart, ProtocolDecodeError, rpcCodes, cancelledRequest, staleRequest, closedConnection, RpcError } from "./wire.ts";
import type { DocumentId, DocumentLanguage, DocumentSnapshot, ResourceLease, Workspace } from "../core/workspace.ts";
import { NotificationScope, Store } from "../core/observable.ts";
import { anchoredRange, positionChanges } from "../core/positions.ts";
import type { Observable } from "../core/observable.ts";
import { TextBuffer } from "../core/text-buffer.ts";
import { cooperateDuringScan, LspLineIndex } from "./lsp-positions.ts";
import { defaultDocumentUnits, LspSession, updateBinding } from "./lsp-session.ts";
import type { LspDocument, LspDocumentCapture, LspDocumentFeature, LspFeature, LspDocumentSnapshot, LspSessionOptions, LspSessionSnapshot } from "./lsp-session.ts";
import { readRequest, requestContext, scopeRequestHandler } from "./lsp-scope-requests.ts";
import type { RpcCall } from "./json-rpc.ts";
import type { JsonValue } from "./wire.ts";
import { decodeLspDiagnostics } from "./lsp-features.ts";
import type { LspDiagnostics } from "./lsp-features.ts";
import type { LspResolvedTarget, LspTargetResolver, LspTargetContext, ResolveRetainedTarget } from "./lsp-targets.ts";

/** Preparation can synchronize the capture and send custom requests on its behalf. */
export type LspScopeAccess = Pick<LspSession, "request" | "commandNames"> & Readonly<{ flush: () => Promise<void> }>;
export type LspReadRequest = LspScopeAccess & Pick<LspSession, "requestDocument"> & Readonly<{ dispose: () => void }>;
export const beginReadRequest = Symbol("LSP read request");
export const bindProject = Symbol("bind captured documents");
type ScopeAccess = Pick<LspSession, "flush" | "bindDocument" | "synchronized" | "requestDocument" | "canRequest" | "featureOptions" | "commandNames" | "requestCommand" | "request" | "notify" | "onRequest" | "onNotification" | "snapshotOwnership"> & Readonly<{
    /** Start or join the owner's shared connection; cancellation expires only this scope's wait. */
    ensureConnected: () => Promise<void>;
    /** Cancel this scope's intents, retaining its bindings, handlers and shared connection. */
    cancel: () => void;
    /** Cancel intents and release this scope's handlers and document participation. */
    dispose: () => void;
}>;
/** Optional host custom-message preparation, inside the feature's captured request lifetime. */
export type LspPrepare = (scope: LspScopeAccess) => Promise<unknown>;
/** Own document bindings, requests and subscriptions that share a workspace connection. */
export type LspWorkspaceScope = ScopeAccess & Observable<LspWorkspaceSnapshot> & Readonly<{
    [beginReadRequest]: (interrupted: () => void, documents: () => Iterable<LspDocument>) => LspReadRequest;
    [bindProject]: (documents: readonly DocumentSnapshot[]) => ReadonlyMap<string, LspDocument>;
    attachDocument: (id: DocumentId) => LspDocument;
    setDocuments: (documents: readonly DocumentSnapshot[]) => ReadonlyMap<string, LspDocument>;
    /** Read-only handle/snapshot validation, including Workspace edits not yet synchronized. */
    isDocumentCurrent: (document: LspDocument, snapshot: LspDocumentSnapshot) => boolean;
    captureProject: (method?: LspFeature, documents?: Iterable<LspDocument>) => ReadonlyMap<string, LspDocumentCapture>;
    /** Binding/connection authority independent of this scope's request generation; no new retention. */
    captureBinding: (document: LspDocument, method?: LspFeature) => LspBindingCapture | undefined;
    observeDiagnostics: (document: LspDocument) => Observable<LspDiagnosticState>;
    reserveCommand: (applyEdit?: Handler) => Readonly<{
        requestCommand: LspSession["requestCommand"]; isCurrent: () => boolean; release: () => void;
    }>;
    resolveTarget: ResolveRetainedTarget;
    /** Route deferred host callback failures through the provider's existing onError policy. */
    reportError: (error: unknown) => void;
}>;
export type LspBindingCapture = Readonly<{ document: LspDocumentSnapshot;
    /** Current local snapshot, including edits awaiting synchronization; undefined after binding authority expires. */
    getSnapshot: () => DocumentSnapshot | undefined }>;
export type LspDiagnosticState = Readonly<{ status: "empty" | "current" | "pending" | "expired"; result: LspDiagnostics | null;
    /** Original provider report for a problems list while display ranges are mapped across local edits. */
    lastReport: LspDiagnostics | null;
    /** Provider result still belongs to the synchronized source; always false for mapped pending results. */
    isCurrent: () => boolean;
    /** Display/navigation offsets still belong to the local source, including mapped pending results. */
    isPlacementCurrent: () => boolean }>;
export type LspWorkspaceSnapshot = LspSessionSnapshot & Readonly<{ commandAvailable: boolean; commandRequiresReconnect: boolean }>;
const emptyDiagnostics: LspDiagnosticState = Object.freeze({
    status: "empty", result: null, lastReport: null, isCurrent: () => false, isPlacementCurrent: () => false
});
const expiredDiagnostics: LspDiagnosticState = Object.freeze({ ...emptyDiagnostics, status: "expired" });
/** Configure the shared session, diagnostic delivery and host resolution of unopened targets. */
export type LspWorkspaceOptions = LspSessionOptions & Readonly<{
    /** Authorize an opaque URI and return a project document or read-only contents. */
    resolveTarget?: LspTargetResolver;
    maxScopes?: number;
}>;

type Handler = Parameters<LspSession["onRequest"]>[1];
type DocumentEntry = { id: DocumentId; language: DocumentLanguage; binding: LspDocument; lease: ResourceLease; active: boolean; queued: boolean; stop: () => void; users: Set<() => void>; diagnostics: Store<LspDiagnosticState> };
type Scope = { active: boolean; generation: number; close: () => void; interruptions: Set<() => void> };
type CommandReply = { epoch: number; id?: number; received: boolean };
type CommandIntent = { scope: Scope; epoch: number; generation: number; registrationGeneration: number; reply?: CommandReply;
    cancelled: boolean; listeners: Set<() => void>; applyEdit: Handler | undefined };
export function sameDocument(live: DocumentSnapshot | undefined, snapshot: DocumentSnapshot): boolean {
    return live?.key === snapshot.key && live.id === snapshot.id && live.revision === snapshot.revision && live.buffer === snapshot.buffer && live.language === snapshot.language;
}

/** One explicitly owned provider connection and synchronization stream per workspace/configuration.
 * Feature scopes own requests and document participation; they never own the shared transport.
 */
export class LspWorkspace {
    readonly #workspace: Workspace;
    readonly #options: LspWorkspaceOptions;
    readonly #session: LspSession;
    readonly #documents = new Map<DocumentId, DocumentEntry>();
    readonly #uris = new Map<string, DocumentEntry>();
    readonly #scopes = new Set<Scope>();
    readonly #notifications: NotificationScope;
    readonly #store: Store<LspWorkspaceSnapshot>;
    readonly #observers = new Set<() => void>();
    readonly #stopState: () => void;
    readonly #stopApply: (() => void) | undefined;
    readonly #stopDiagnostics: (() => void) | undefined;
    #notificationQueued = false;
    #changed = new Set<Store<unknown>>();
    #disposed = false;
    #command: CommandIntent | undefined;
    #abandoned: CommandReply | undefined;
    readonly getSnapshot: Observable<LspWorkspaceSnapshot>["getSnapshot"];
    readonly subscribe: Observable<LspWorkspaceSnapshot>["subscribe"];

    constructor(workspace: Workspace, options: LspWorkspaceOptions) {
        this.#workspace = workspace; this.#options = options;
        if (!isPositiveInteger(options.maxScopes ?? wireLimits.scopes)) invalidRange("provider scope limit");
        this.#notifications = workspace.createNotificationScope(error => this.#report(error));
        this.#session = new LspSession(options, (epoch, id) => {
            const reply = this.#abandoned ?? this.#command?.reply;
            if (!reply || reply.epoch !== epoch) return false;
            const acknowledge = () => {
                if (reply.id !== id) return false;
                reply.received = true;
                if (this.#abandoned === reply) {
                    this.#abandoned = undefined;
                    this.#publishCommand();
                }
                return true;
            };
            if (reply.id !== undefined) return acknowledge();
            // A synchronous transport may reply inside send, before requestCommand returns its ID.
            void Promise.resolve().then(acknowledge);
            return false;
        });
        this.#store = new Store(this.#snapshotState(), this.#notifications);
        this.getSnapshot = this.#store.observable.getSnapshot;
        this.subscribe = listener => {
            this.#writable(); const stop = this.#store.observable.subscribe(listener);
            const release = () => { stop(); this.#observers.delete(release); }; this.#observers.add(release); return release;
        };
        this.#stopState = this.#session.subscribe(() => {
            const next = this.#session.getSnapshot();
            if (next.phase !== "ready" || next.epoch !== this.#store.get().epoch) for (const entry of this.#documents.values()) this.#expireDiagnostics(entry);
            if (this.#command && (this.#command.epoch !== next.epoch || this.#command.registrationGeneration !== next.registrationVersion(executeCommandMethod))) this.#endCommand(this.#command, this.#command.epoch === next.epoch);
            if (this.#abandoned?.epoch !== next.epoch) this.#abandoned = undefined;
            this.#store.set(this.#snapshotState(), this.#changed);
            // Bind/close operations finish their ownership changes before observers can react.
            this.#queueDelivery();
        });
        this.#stopDiagnostics = options.diagnostics !== false ? this.#session.onNotification("textDocument/publishDiagnostics", value => {
            const uri = value && typeof value === "object" && "uri" in value ? value.uri : undefined;
            const entry = typeof uri === "string" ? this.#uris.get(uri) : undefined;
            if (!entry) return;
            const sent = this.#session.synchronized(entry.binding);
            if (!sent) return;
            const isCurrent = () => {
                const now = this.#session.synchronized(entry.binding);
                return this.#live(entry) && now?.epoch === sent.epoch && now.version === sent.version;
            };
            let result: LspDiagnostics;
            try {
                result = decodeLspDiagnostics(value, Object.freeze({ ...sent, isCurrent }));
            } catch (error) {
                if (!(error instanceof ProtocolDecodeError) && !(error instanceof RpcError && error.code === rpcCodes.contentModified)) throw error;
                return;
            }
            entry.diagnostics.set(Object.freeze({ status: "current", result, lastReport: result, isCurrent, isPlacementCurrent: isCurrent }), this.#changed);
            this.#queueDelivery();
        }) : undefined;
        this.#stopApply = options.applyEdit ? this.#session.onRequest(applyEditMethod, (value, context) => {
            const owner = this.#command;
            if (!owner?.reply || owner.reply.received || !owner.applyEdit || !this.#commandCurrent(owner) || owner.epoch !== context.epoch) return { applied: false, failureReason: "No available captured command review intent." };
            const isCurrent = () => context.isCurrent() && !owner.reply?.received && this.#commandCurrent(owner);
            const captured = requestContext(context, isCurrent, notify => {
                const stop = context.onCancel(notify);
                owner.listeners.add(notify);
                return () => {
                    stop();
                    owner.listeners.delete(notify);
                };
            }, error => this.#report(error));
            return owner.applyEdit(value, captured);
        }) : undefined;
    }
    #report(error: unknown): void { try { this.#options.onError?.(error instanceof Error ? error : new Error(String(error))); } catch { /* Reporting cannot prevent cleanup. */ } }
    #commandCurrent(intent: CommandIntent): boolean { const state = this.#session.getSnapshot(); return this.#command === intent && !intent.cancelled && intent.scope.active && intent.scope.generation === intent.generation && state.phase === "ready" && state.epoch === intent.epoch && state.registrationVersion(executeCommandMethod) === intent.registrationGeneration; }
    #endCommand(intent: CommandIntent, quarantine: boolean, cancelled = true): void {
        if (quarantine && intent.reply && !intent.reply.received && this.#session.getSnapshot().epoch === intent.epoch)
            this.#abandoned = intent.reply;
        if (cancelled) intent.cancelled = true;
        if (this.#command === intent) this.#command = undefined;
        for (const listener of [...intent.listeners]) listener(); intent.listeners.clear();
        this.#publishCommand();
    }
    #publishCommand(): void {
        this.#store.set(this.#snapshotState(), this.#changed);
        this.#queueDelivery();
    }
    #snapshotState(): LspWorkspaceSnapshot { const state = this.#session.getSnapshot(), commandRequiresReconnect = this.#abandoned?.epoch === state.epoch;
        return Object.freeze({ ...state, commandAvailable: state.phase === "ready" && !this.#command && !commandRequiresReconnect, commandRequiresReconnect }); }
    #writable(): void { this.#notifications.assertWritable(); if (this.#disposed) throw closedConnection("Provider owner is disposed."); }
    #deliver(): void { this.#notificationQueued = false; const changed = this.#changed; this.#changed = new Set(); if (changed.size) this.#notifications.deliver([...changed]); }
    #queueDelivery(): void { if (!this.#notificationQueued) { this.#notificationQueued = true; void Promise.resolve().then(() => this.#deliver()).catch(error => this.#report(error)); } }
    #expireDiagnostics(entry: DocumentEntry): void {
        const before = entry.diagnostics.get(); if (before.result === null) return;
        entry.diagnostics.set(expiredDiagnostics, this.#changed);
        this.#queueDelivery();
    }
    #mapDiagnostics(entry: DocumentEntry): void {
        const before = entry.diagnostics.get(), result = before.result;
        if (!result) return;
        const next = this.#workspace.observeDocument(entry.id).getSnapshot(), session = this.#session.getSnapshot();
        if (!next || next.language !== entry.language || session.phase !== "ready") { this.#expireDiagnostics(entry); return; }
        if (next.revision === result.snapshotRevision) return;
        if (next.change?.previousRevision !== result.snapshotRevision) { this.#expireDiagnostics(entry); return; }
        const mapping = next.change.mapping;
        const items = result.items.flatMap(item => {
            if (item.placement !== "placed") return [item];
            const range = mapping.mapRange(anchoredRange(mapping.oldLength, item.from!, item.to!, { onDelete: "invalidate" }));
            return range ? [Object.freeze({ ...item, from: range.from, to: range.to })] : [];
        });
        const isPlacementCurrent = () => {
            if (!entry.active) return false;
            const now = this.#workspace.observeDocument(entry.id).getSnapshot(), provider = this.#session.getSnapshot();
            return provider.phase === "ready" && provider.epoch === session.epoch
                && now?.language === entry.language && now.revision === next.revision && now.buffer === next.buffer;
        };
        // Preserve provider version, original wire ranges and metadata as provenance, not fresh edit authority.
        entry.diagnostics.set(Object.freeze({ status: "pending", lastReport: before.lastReport, result: Object.freeze({ ...result, snapshotRevision: next.revision, items: Object.freeze(items) }),
            isCurrent: () => false, isPlacementCurrent }), this.#changed); this.#queueDelivery();
    }
    /** Read the current host mapping/capabilities without acquiring document participation. */
    queryFeatureOptions(method: LspDocumentFeature, document: DocumentSnapshot): readonly Readonly<Record<string, JsonValue>>[] {
        if (this.#disposed) return emptyList;
        const current = this.#workspace.observeDocument(document.id).getSnapshot();
        if (!sameDocument(current, document)) throw staleRequest();
        const info = document.language;
        return info ? this.#session.queryFeatureOptions(method, info) : emptyList;
    }
    #document(id: DocumentId): DocumentEntry {
        this.#writable(); const current = this.#workspace.document(id), info = current.language;
        if (!info) throw new Error("Document is outside this provider configuration.");
        const old = this.#documents.get(id);
        if (old?.language === info) { this.#synchronize(old); if (!old.active) throw staleRequest(); return old; }
        if (old) this.#closeDocument(old);
        const owner = this.#uris.get(info.uri);
        if (owner) {
            if (this.#bindingCurrent(owner)) throw new Error("Provider URI is already owned by another document.");
            this.#closeDocument(owner);
        }
        const lease = this.#workspace.acquire(current.id); let binding: LspDocument;
        try { binding = this.#session.bindDocument({ ...info, documentId: id, revision: current.revision, buffer: current.buffer }); }
        catch (error) { lease.release(); throw error; }
        const entry: DocumentEntry = { id, language: info, binding, lease, active: true, queued: false, stop: () => {}, users: new Set(),
            diagnostics: new Store<LspDiagnosticState>(emptyDiagnostics, this.#notifications) };
        this.#documents.set(id, entry); this.#uris.set(info.uri, entry);
        entry.stop = this.#workspace.observeDocument(id).subscribe(() => {
            this.#mapDiagnostics(entry);
            if (!entry.active || entry.queued) return; entry.queued = true;
            void Promise.resolve().then(() => { entry.queued = false; this.#synchronize(entry); });
        });
        return entry;
    }
    #bindingCurrent(entry: DocumentEntry | undefined): boolean {
        return !!entry?.active && this.#workspace.observeDocument(entry.id).getSnapshot()?.language === entry.language;
    }
    #live(entry: DocumentEntry): boolean {
        if (!entry.active) return false;
        const current = this.#workspace.observeDocument(entry.id).getSnapshot(), sent = entry.binding.getSnapshot();
        return current?.language === entry.language && current.revision === sent.revision && current.buffer === sent.buffer;
    }
    #synchronize(entry: DocumentEntry): void {
        if (!entry.active) return;
        const next = this.#workspace.observeDocument(entry.id).getSnapshot();
        if (next?.language !== entry.language) return this.#closeDocument(entry);
        try {
            this.#updateBinding(entry.binding, entry.binding.getSnapshot().revision, next);
        } catch (error) {
            this.#closeDocument(entry);
            this.#report(error);
        }
    }
    #updateBinding(binding: LspDocument, previous: number, next: DocumentSnapshot): void {
        const current = binding.getSnapshot();
        if (current.revision === next.revision && current.buffer === next.buffer) return;
        const change = next.change;
        this.#session[updateBinding](binding, previous, next.revision, next.buffer, before =>
            change?.previousRevision === previous
                ? { before, ranges: positionChanges(change.mapping), get edits() { return change.edits; } } : undefined);
    }
    #closeDocument(entry: DocumentEntry): void {
        if (!entry.active) return; entry.active = false; this.#expireDiagnostics(entry); this.#documents.delete(entry.id); this.#uris.delete(entry.binding.getSnapshot().uri);
        entry.stop(); entry.binding.dispose(); for (const close of [...entry.users]) close();
        // Workspace observers run inside commit delivery, where lease writes must be deferred.
        void Promise.resolve().then(() => { try { entry.lease.release(); } catch (error) { this.#report(error); } });
    }
    commandNames(): readonly string[] {
        return this.#session.commandNames();
    }
    connect(): Promise<void> { this.#writable(); for (const entry of [...this.#documents.values()]) this.#synchronize(entry); return this.#session.connect(); }
    flush(): Promise<void> { this.#writable(); for (const entry of [...this.#documents.values()]) this.#synchronize(entry); return this.#session.flush(); }
    disconnect(): void { this.#writable(); this.#session.disconnect(); }
    async reconnect(): Promise<void> { this.disconnect(); await this.connect(); }
    shutdown(): Promise<void> { this.#writable(); for (const entry of [...this.#documents.values()]) this.#synchronize(entry); return this.#session.shutdown(); }

    async #loadTarget(uri: string, context: LspTargetContext, scopeCurrent: () => boolean): Promise<LspResolvedTarget | undefined> {
        const session = this.#session.getSnapshot();
        const connected = () => {
            const now = this.#session.getSnapshot();
            return scopeCurrent() && now.phase === "ready" && now.epoch === session.epoch && now.registrationVersion(didChangeMethod) === session.registrationVersion(didChangeMethod);
        };
        if (!isLspUri(uri)) throw new TypeError("Invalid target URI.");
        if (!connected() || !context.isCurrent()) throw staleRequest();
        const source = await this.#options.resolveTarget?.(uri, context);
        if (!source) return;
        let lease: ResourceLease | undefined, released = false;
        const release = () => {
            if (released) return; released = true;
            try { lease?.release(); } finally {
                try { void Promise.resolve(source.release?.()).catch(error => this.#report(error)); } catch (error) { this.#report(error); }
            }
        };
        try {
            if (!connected() || !context.isCurrent()) throw staleRequest();
            const limit = this.#options.maxDocumentUnits ?? defaultDocumentUnits;
            let doc: DocumentSnapshot;
            if ("document" in source) {
                doc = source.document;
                if (doc.language?.uri !== uri) throw new TypeError("Resolved document does not match the requested URI.");
                if (!isLspIdentityPart(doc.language.languageId)) throw new TypeError("Invalid target language ID.");
                if (this.#workspace.document(doc.id) !== doc) throw staleRequest();
                if (doc.buffer.length > limit) throw new RangeError("LSP target size limit exceeded.");
                lease = this.#workspace.acquire(doc.id);
            } else {
                if (context.purpose === "edit") throw new TypeError("An editable target requires a project document.");
                if (!isLspIdentityPart(source.languageId) || !(typeof source.text === "string" || source.text instanceof TextBuffer)) throw new TypeError("Invalid read-only target.");
                if (source.text.length > limit) throw new RangeError("LSP target size limit exceeded.");
                const buffer = typeof source.text === "string" ? TextBuffer.from(source.text) : source.text;
                const resource = this.#workspace.createTextResource(this.#workspace.createResourceKey("lsp", uri), uri, {
                    value: buffer,
                    capabilities: { edit: [], save: false },
                    visibility: "internal",
                    language: { uri, languageId: source.languageId },
                });
                lease = this.#workspace.acquire(resource.id);
                this.#workspace.releaseResourceWhenUnowned(resource.id);
                doc = this.#workspace.document(resource.id);
            }
            const documents = this.#workspace.observeDocument(doc.id), metadata = this.#workspace.resource(doc.id).metadata, access = metadata.getSnapshot();
            const entry = this.#uris.get(uri);
            if (entry && entry.id !== doc.id && this.#bindingCurrent(entry)) throw staleRequest();
            const capture = entry && this.#live(entry) ? this.#session.synchronized(entry.binding, didChangeMethod) : undefined;
            const isCurrent = () => {
                const now = metadata.getSnapshot(), owner = this.#uris.get(uri);
                return !released && connected() && documents.getSnapshot() === doc && now.capabilities === access.capabilities
                    && (!owner || owner.id === doc.id) && (!capture || capture.isCurrent());
            };
            let interrupt: (() => void) | undefined;
            const stop = context.onCancel(() => interrupt?.());
            try {
                const check = () => {
                    if (!isCurrent() || !context.isCurrent()) throw staleRequest();
                };
                const pause = () => new Promise<void>((resolve, reject) => {
                    const cancel = this.#options.schedule(0, () => { interrupt = undefined; resolve(); });
                    interrupt = () => { cancel(); reject(staleRequest()); };
                });
                const index = capture?.index ?? await LspLineIndex.create(doc.buffer, cooperateDuringScan(check, pause, this.#options.now));
                check();
                const document = Object.freeze({ ...doc.language!, documentId: doc.id, revision: doc.revision, buffer: doc.buffer });
                return Object.freeze({ target: Object.freeze({ document, index, version: capture?.version ?? null, isCurrent }), release });
            } finally { stop(); }
        } catch (error) { release(); throw error; }
    }

    createScope(): LspWorkspaceScope {
        this.#writable(); if (this.#scopes.size >= (this.#options.maxScopes ?? wireLimits.scopes)) throw new RangeError("Provider scope limit exceeded.");
        const scope: Scope = { active: true, generation: 0, close: () => {}, interruptions: new Set() }, documents = new Map<string, LspDocument>();
        const handles = new Map<LspDocument, DocumentEntry>(), pending = new Set<{ cancel: () => void }>(), stops = new Set<() => void>();
        const documentCalls = new Map<LspDocument, Set<{ cancel: () => void }>>();
        let closedState: LspWorkspaceSnapshot | undefined;
        const writable = () => { this.#writable(); if (!scope.active) throw cancelledRequest(); };
        const current = (generation: number) => scope.active && scope.generation === generation && !this.#disposed;
        const track = <T, C extends { result: Promise<T>; cancel: () => void }>(call: C): C => {
            const generation = scope.generation; let wasCancelled = false;
            const tracked = Object.freeze({ ...call, cancel: () => { wasCancelled = true; call.cancel(); }, result: call.result.then(result => {
                if (!current(generation) || wasCancelled) throw cancelledRequest(); return result;
            }) }); pending.add(tracked); void tracked.result.then(() => pending.delete(tracked), () => pending.delete(tracked)); return tracked as C;
        };
        const unwrap = (document: LspDocument) => { const entry = handles.get(document); if (!scope.active || !entry?.active) throw staleRequest(); return entry.binding; };
        const scopedCapture = (document: LspDocument, entry: DocumentEntry, value: LspDocumentCapture, generation: number): LspDocumentCapture =>
            Object.freeze({ ...value,
                isBindingCurrent: () => current(generation) && handles.has(document) && this.#bindingCurrent(entry) && (value.isBindingCurrent?.() ?? value.isCurrent()),
                isCurrent: () => current(generation) && handles.has(document) && this.#live(entry) && value.isCurrent() });
        const capture = (document: LspDocument, method?: Parameters<LspSession["synchronized"]>[1]): LspDocumentCapture | undefined => {
            const entry = handles.get(document); if (!scope.active || !entry || !this.#live(entry)) return;
            const value = this.#session.synchronized(unwrap(document), method);
            return value && scopedCapture(document, entry, value, scope.generation);
        };
        const attach = (id: DocumentId): LspDocument => {
            writable(); const entry = this.#document(id), existing = documents.get(id);
            if (existing && handles.get(existing) === entry) return existing;
            let active = true;
            const close = () => { if (!active) return; active = false; for (const call of documentCalls.get(document) ?? []) call.cancel(); documentCalls.delete(document);
                handles.delete(document); documents.delete(id); entry.users.delete(close); if (entry.active && !entry.users.size) this.#closeDocument(entry); };
            const document: LspDocument = Object.freeze({ getSnapshot: entry.binding.getSnapshot, dispose: close, update: (expected, revision, buffer) => {
                writable();
                if (!active || !entry.active) throw staleRequest();
                const latest = this.#workspace.document(id);
                if (latest.language !== entry.language || latest.revision !== revision || latest.buffer !== buffer) throw staleRequest();
                this.#updateBinding(entry.binding, expected, latest);
            } });
            documents.set(id, document); handles.set(document, entry); entry.users.add(close); return document;
        };
        const listen = (stop: () => void) => { const release = () => { stops.delete(release); stop(); }; stops.add(release); return release; };
        const cancel = () => { if (!scope.active) return; scope.generation++; if (this.#command?.scope === scope) this.#endCommand(this.#command, true); for (const notify of [...scope.interruptions]) notify(); for (const call of [...pending]) call.cancel(); };
        scope.close = () => {
            if (!scope.active) return; cancel(); scope.active = false; closedState = Object.freeze({ ...this.getSnapshot(), phase: "disposed", commandAvailable: false });
            for (const stop of [...stops]) stop(); for (const document of [...documents.values()]) document.dispose(); this.#scopes.delete(scope);
        };
        this.#scopes.add(scope);
        const state: Observable<LspWorkspaceSnapshot> = Object.freeze({ getSnapshot: () => closedState ?? this.getSnapshot(), subscribe: listener => { writable(); return listen(this.subscribe(listener)); } });
        const reserve = (applyEdit?: Handler): CommandIntent => {
            writable(); const state = this.#session.getSnapshot();
            if (state.phase !== "ready" || this.#command || this.#abandoned?.epoch === state.epoch) throw staleRequest("Provider command lane requires an available captured intent or fresh connection.");
            const intent: CommandIntent = { scope, epoch: state.epoch, generation: scope.generation, registrationGeneration: state.registrationVersion(executeCommandMethod), cancelled: false, listeners: new Set(), applyEdit };
            this.#command = intent; this.#publishCommand(); return intent;
        };
        const sendCommand = (intent: CommandIntent, ...args: Parameters<LspSession["requestCommand"]>) => {
            if (intent.reply || !this.#commandCurrent(intent)) throw staleRequest();
            const reply: CommandReply = { epoch: intent.epoch, received: false };
            intent.reply = reply;
            let waiting = true;
            try {
                const raw = this.#session.requestCommand(...args);
                reply.id = raw.id;
                const call = track({ ...raw, cancel: () => { if (waiting) this.#endCommand(intent, true); raw.cancel(); } });
                const result = call.result.catch(error => {
                    if (error instanceof RpcError && error.code === rpcCodes.timeout) this.#endCommand(intent, true);
                    throw error;
                }).finally(() => { waiting = false; this.#endCommand(intent, false, false); });
                return Object.freeze({ ...call, result, isCurrent: () => current(intent.generation) && !intent.cancelled && raw.isCurrent() });
            } catch (error) {
                this.#endCommand(intent, false);
                throw error;
            }
        };
        const api: LspWorkspaceScope = Object.freeze({ ...state, reportError: error => this.#report(error),
            [beginReadRequest]: (interrupted, documents) => {
                writable();
                return readRequest(api, scope.interruptions, interrupted, documents);
            },
            resolveTarget: (uri, context) => {
                writable(); const generation = scope.generation;
                return this.#loadTarget(uri, context, () => current(generation));
            },
            reserveCommand: applyEdit => { const intent = reserve(applyEdit); return Object.freeze({
                requestCommand: (...args: Parameters<LspSession["requestCommand"]>) => sendCommand(intent, ...args),
                isCurrent: () => this.#commandCurrent(intent),
                release: () => { if (this.#command === intent) this.#endCommand(intent, true); } }); },
            attachDocument: attach,
            isDocumentCurrent: (document, snapshot) => {
                const entry = handles.get(document);
                return scope.active && !this.#disposed && !!entry?.active && entry.binding.getSnapshot() === snapshot && this.#live(entry);
            },
            observeDiagnostics: document => {
                writable(); unwrap(document); const store = handles.get(document)!.diagnostics;
                return Object.freeze({ getSnapshot: store.observable.getSnapshot, subscribe: listener => {
                    writable(); const stop = store.observable.subscribe(listener); const release = () => { stop(); this.#observers.delete(release); };
                    this.#observers.add(release); return listen(release);
                } });
            },
            [bindProject]: snapshots => {
                writable(); const ids = new Set(snapshots.map(snapshot => snapshot.id)); if (ids.size !== snapshots.length) throw new Error("Provider project repeats a document.");
                const uris = new Set<string>();
                for (const snapshot of snapshots) { const live = this.#workspace.document(snapshot.id), info = live.language;
                    if (!sameDocument(live, snapshot)) throw staleRequest();
                    if (!info || uris.has(info.uri)) throw new Error("Provider project has unavailable or repeated URI mappings."); uris.add(info.uri);
                }
                const added: LspDocument[] = [];
                const selected = new Map<string, LspDocument>();
                try { for (const snapshot of snapshots) {
                    const previous = documents.get(snapshot.id);
                    const document = attach(snapshot.id);
                    selected.set(snapshot.id, document);
                    if (previous !== document) added.push(document);
                } }
                catch (error) { for (const document of added) document.dispose(); throw error; }
                return selected;
            },
            setDocuments: snapshots => {
                const selected = api[bindProject](snapshots);
                for (const [id, document] of documents) if (!selected.has(id)) document.dispose();
                return selected;
            },
            captureProject: (method, selected = documents.values()) => {
                writable();
                return new Map(Array.from(selected, document => {
                    const value = capture(document, method);
                    if (!value) throw staleRequest();
                    return [value.document.uri, value] as const;
                }));
            },
            captureBinding: (document, method) => {
                const entry = handles.get(document); if (!scope.active || !entry?.active || !this.#live(entry)) return;
                const value = this.#session.synchronized(entry.binding, method); if (!value) return;
                return Object.freeze({ document: value.document, getSnapshot: () => {
                    if (!scope.active || this.#disposed || handles.get(document) !== entry || !entry.active || !value.isBindingCurrent?.()) return;
                    const current = this.#workspace.observeDocument(entry.id).getSnapshot();
                    return current?.language === entry.language ? current : undefined;
                } });
            },
            bindDocument: snapshot => {
                writable(); const live = this.#workspace.document(snapshot.documentId as DocumentId), info = live.language;
                if (live.revision !== snapshot.revision || live.buffer !== snapshot.buffer || info?.uri !== snapshot.uri || info.languageId !== snapshot.languageId) throw staleRequest();
                return attach(live.id);
            },
            ensureConnected: async () => { writable(); const generation = scope.generation; await this.connect(); if (!current(generation)) throw cancelledRequest(); },
            cancel, dispose: () => { if (!scope.active) return; this.#notifications.assertWritable(); scope.close(); },
            flush: async selected => { writable(); const generation = scope.generation, captured = selected && [...selected];
                if (captured) {
                    const bindings = captured.map(document => { const entry = handles.get(document); if (!entry) throw staleRequest(); this.#synchronize(entry); return unwrap(document); });
                    await this.#session.flush(bindings);
                } else await this.flush();
                if (!current(generation)) throw cancelledRequest();
                for (const document of captured ?? []) unwrap(document); },
            synchronized: capture,
            canRequest: (method, document) => scope.active && this.#bindingCurrent(handles.get(document)) && this.#session.canRequest(method, unwrap(document)),
            featureOptions: (method, document) => scope.active && this.#bindingCurrent(handles.get(document)) ? this.#session.featureOptions(method, unwrap(document)) : emptyList,
            commandNames: () => scope.active ? this.commandNames() : emptyList,
            requestDocument: (method: Parameters<LspSession["requestDocument"]>[0], document: LspDocument, params: Parameters<LspSession["requestDocument"]>[2]) => {
                writable(); const generation = scope.generation, entry = handles.get(document); if (!entry) throw staleRequest(); this.#synchronize(entry);
                const raw = this.#session.requestDocument(method, unwrap(document), (index, snapshot, captured) =>
                    params(index, snapshot, scopedCapture(document, entry, captured, generation)));
                const call = track({ ...raw, result: raw.result.then(value => { if (!handles.has(document) || !this.#live(entry)) throw staleRequest(); return value; }) });
                const calls = documentCalls.get(document) ?? new Set(); documentCalls.set(document, calls); calls.add(call);
                const settled = () => { calls.delete(call); if (!calls.size) documentCalls.delete(document); }; void call.result.then(settled, settled); return call;
            },
            request: (method: string, params?: JsonValue): RpcCall<JsonValue> => { writable(); return track(this.#session.request(method, params)); },
            notify: (method, params) => { writable(); this.#session.notify(method, params); },
            onRequest: (method, handler) => {
                writable();
                if (method === applyEditMethod) throw new TypeError("Reserve the command to handle workspace edits.");
                const receive = scopeRequestHandler(handler, scope, current, error => this.#report(error));
                return listen(this.#session.onRequest(method, receive));
            },
            onNotification: (method, handler) => { writable(); return listen(this.#session.onNotification(method, (value, epoch) => { if (scope.active) return handler(value, epoch); })); },
            requestCommand: (...args: Parameters<LspSession["requestCommand"]>) => sendCommand(reserve(), ...args),
            snapshotOwnership: () => this.#session.snapshotOwnership(),
        });
        return api;
    }
    snapshot() {
        return Object.freeze({ disposed: this.#disposed, scopes: this.#scopes.size, documents: this.#documents.size,
            documentParticipants: [...this.#documents.values()].reduce((sum, entry) => sum + entry.users.size, 0),
            commandPending: !!this.#command, commandQuarantined: this.getSnapshot().commandRequiresReconnect, protocol: this.#session.snapshotOwnership() });
    }
    dispose(): void {
        if (this.#disposed) return; this.#notifications.assertWritable(); this.#disposed = true;
        for (const scope of [...this.#scopes]) scope.close(); for (const entry of [...this.#documents.values()]) this.#closeDocument(entry);
        this.#stopApply?.(); this.#stopDiagnostics?.(); this.#session.dispose(); this.#stopState(); this.#deliver(); for (const stop of [...this.#observers]) stop();
    }
}
