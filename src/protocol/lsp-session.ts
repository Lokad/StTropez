import { wireLimits, ProtocolDecodeError, isRecord, isLspIdentityPart, isLspUri, rpcCodes, cancelledRequest, staleRequest, closedConnection, RpcError, jsonEqual, jsonSnapshot } from "./wire.ts";
import type { TextBuffer } from "../core/text-buffer.ts";
import type { PositionMapping } from "../core/positions.ts";
import { NotificationScope, Store } from "../core/observable.ts";
import type { Observable } from "../core/observable.ts";
import { JsonRpcConnection } from "./json-rpc.ts";
import type { RpcCall, RpcOptions, RpcRequestContext, RpcScheduler, RpcTransport } from "./json-rpc.ts";
import type { JsonValue } from "./wire.ts";
import { LspLineIndex, lspTextChanges } from "./lsp-positions.ts";
import type { LspChangeHint, LspTextChange } from "./lsp-positions.ts";
import { compileLspSelector } from "./lsp-selector.ts";
import type { LspSelector, LspSelectorDocument, LspUriPath } from "./lsp-selector.ts";

const providers = { "textDocument/completion": "completionProvider", "textDocument/hover": "hoverProvider",
    "textDocument/definition": "definitionProvider", "textDocument/references": "referencesProvider",
    "textDocument/rename": "renameProvider", "textDocument/codeAction": "codeActionProvider", "workspace/executeCommand": "executeCommandProvider",
    "textDocument/signatureHelp": "signatureHelpProvider", "textDocument/documentLink": "documentLinkProvider", "textDocument/documentColor": "colorProvider", "textDocument/colorPresentation": "colorProvider",
    "textDocument/foldingRange": "foldingRangeProvider", "textDocument/documentHighlight": "documentHighlightProvider" } as const;
export type LspFeature = keyof typeof providers;
export type LspDocumentFeature = Exclude<LspFeature, "workspace/executeCommand">;
export type LspCommandCall<T> = RpcCall<T> & Readonly<{ isCurrent: () => boolean }>;
/** Host grant for one invocation, including opaque arguments; never inferred from a server response. */
export type LspCommandAuthorization = Readonly<{ command: string; arguments: readonly JsonValue[]; isCurrent: () => boolean }>;
export type LspDocumentSnapshot = Readonly<{ uri: string; languageId: string; resourceId: string; documentId: string; revision: number; buffer: TextBuffer }>;
export type LspDocument = Readonly<{ getSnapshot: () => LspDocumentSnapshot;
    update: (expectedRevision: number, revision: number, buffer: TextBuffer, mapping?: PositionMapping) => void; close: () => void }>;
export type LspCall<T> = Readonly<{ result: Promise<T>; cancel: () => void }>;
export type LspDocumentCapture = Readonly<{ document: LspDocumentSnapshot; index: LspLineIndex; version: number;
    epoch: number; registrationGeneration: number; isCurrent: () => boolean;
    /** Existing session size policy, also used to bound expanded snippet text. */
    maxDocumentUnits?: number;
    /** Same binding/connection/capabilities; permits local revisions and proves no range freshness. */
    isBindingCurrent?: () => boolean }>;
export type LspConnectContext = Readonly<{ epoch: number; cancelled: boolean; onCancel: (listener: () => void) => () => void }>;
export type LspRequestContext = RpcRequestContext & Readonly<{ epoch: number; isCurrent: () => boolean }>;
export type LspRegistration = Readonly<{ id: string; method: string; registerOptions: JsonValue }>;
export type LspSessionSnapshot = Readonly<{ phase: "disconnected" | "connecting" | "initializing" | "ready" | "stopping" | "disposed";
    epoch: number; capabilities: Readonly<Record<string, JsonValue>>; registrations: readonly LspRegistration[];
    registrationGeneration: number; documents: number; error: string | null }>;
export type LspSessionOptions = Readonly<{ connect: (context: LspConnectContext) => Promise<RpcTransport>; schedule: RpcScheduler;
    /** Millisecond clock for cooperative scan slices; defaults to Date.now. */
    now?: () => number;
    rootUri?: string | null; initializationOptions?: JsonValue; clientInfo?: Readonly<{ name: string; version?: string }>;
    /** Opt in when the host presents the documented Markdown subset for hover/signature help. */
    markdownDocumentation?: boolean;
    /** Declare only features whose results the consuming host validates and presents. */
    features?: readonly LspFeature[]; diagnostics?: boolean; workspaceEdits?: boolean; applyEdit?: boolean; pathForUri?: LspUriPath; maxDocuments?: number; maxDocumentUnits?: number; maxTotalUnits?: number;
    rpc?: Pick<RpcOptions, "timeoutMs" | "maxPending" | "maxMessageUnits" | "maxJsonNodes">; onError?: (error: Error) => void }>;
type SelectorEntry = { snapshot: LspSelectorDocument; selectors?: { generation: number; values: Map<LspSelector, boolean> } };
type Entry = SelectorEntry & { snapshot: LspDocumentSnapshot; handle: LspDocument; index?: LspLineIndex; change?: LspChangeHint;
    failure?: Readonly<{ snapshot: LspDocumentSnapshot; generation: number; error: Error }> };
type Remote = { entry: Entry; snapshot: LspDocumentSnapshot; index: LspLineIndex; version: number };
type SyncWaiter = { resolve: () => void; reject: (error: Error) => void; ready: (() => boolean) | undefined };
type Registration = { value: LspRegistration; selector: LspSelector };
type RequestHandler = (params: unknown, context: LspRequestContext) => unknown | Promise<unknown>;
type NotificationHandler = (params: unknown, epoch: number) => void | Promise<void>;
const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;
const empty = Object.freeze({});
function commandOptions(value: unknown): readonly string[] {
    if (!isRecord(value) || !Array.isArray(value.commands) || value.commands.length > wireLimits.commandsPerRegistration || value.commands.some(command => typeof command !== "string" || !command || command.length > 256)) throw new ProtocolDecodeError("Invalid or excessive LSP command options.");
    return value.commands as readonly string[];
}
const closed = () => closedConnection("LSP session is not ready.");
const stale = () => staleRequest("Document, capability or session capture changed.");
const cancelError = () => cancelledRequest("Request cancelled.");
const syncMethods = ["textDocument/didOpen", "textDocument/didChange", "textDocument/didClose"];
const reserved = (method: string) => ["initialize", "initialized", "shutdown", "exit", "client/registerCapability", "client/unregisterCapability"].includes(method) || method.startsWith("$/") || method.startsWith("textDocument/");
const reservedIncoming = (method: string) => ["initialize", "initialized", "shutdown", "exit", "client/registerCapability", "client/unregisterCapability", ...syncMethods].includes(method) || method.startsWith("$/");

/** Host-driven LSP 3.17 session. This module owns no sockets, timers, documents or editor UI. */
export class LspSession {
    private readonly options: LspSessionOptions;
    private readonly scope: NotificationScope;
    private readonly store: Store<LspSessionSnapshot>;
    private readonly subscriptions = new Set<() => void>();
    readonly state: Observable<LspSessionSnapshot>;
    private readonly documents = new Map<string, Entry>();
    private readonly handles = new WeakMap<LspDocument, Entry>();
    private readonly remote = new Map<string, Remote>();
    private readonly registrations = new Map<string, Registration>();
    private readonly staticSelectors = new Map<string, LspSelector>();
    private readonly requests = new Map<string, RequestHandler>();
    private readonly requestStops = new Map<string, () => void>();
    private readonly notifications = new Map<string, Set<NotificationHandler>>();
    private readonly notificationStops = new Map<string, () => void>();
    private readonly features: ReadonlySet<LspFeature>;
    private readonly initializeParams: JsonValue;
    private readonly maxDocuments: number;
    private readonly maxDocumentUnits: number;
    private readonly maxTotalUnits: number;
    private totalUnits = 0;
    private rpc: JsonRpcConnection | undefined;
    private epoch = 0;
    private generation = 0;
    private capabilities: Readonly<Record<string, JsonValue>> = empty;
    private sync = { openClose: false, change: false };
    private connectWork: Promise<void> | undefined;
    private cancelOpening: (() => void) | undefined;
    private scheduled: (() => void) | undefined;
    private pumping = false;
    private readonly dirty = new Set<string>();
    private readonly pauses = new Set<{ stop: () => void; reject: (error: Error) => void }>();
    private readonly waiters = new Set<SyncWaiter>();
    private readonly documentCalls = new Set<LspCall<unknown>>();

    constructor(options: LspSessionOptions) {
        this.options = Object.freeze({ ...options, ...(options.rpc ? { rpc: Object.freeze({ ...options.rpc }) } : {}) });
        this.features = new Set(options.features ?? []);
        if ([...this.features].some(method => !Object.hasOwn(providers, method))) throw new TypeError("Unsupported LSP feature declaration.");
        this.maxDocuments = options.maxDocuments ?? 100; this.maxDocumentUnits = options.maxDocumentUnits ?? 3 * 1024 * 1024; this.maxTotalUnits = options.maxTotalUnits ?? 16 * 1024 * 1024;
        if (![this.maxDocuments, this.maxDocumentUnits, this.maxTotalUnits].every(value => integer(value) && value > 0)) throw new RangeError("Invalid LSP document limits.");
        const textDocument: Record<string, JsonValue> = { synchronization: { dynamicRegistration: true, didSave: false, willSave: false, willSaveWaitUntil: false } };
        for (const method of this.features) if (method.startsWith("textDocument/")) textDocument[method.slice("textDocument/".length)] = { dynamicRegistration: true };
        if (this.features.has("textDocument/completion")) textDocument.completion = { dynamicRegistration: true, contextSupport: true,
            completionItem: { snippetSupport: true, insertReplaceSupport: true, documentationFormat: ["plaintext"], insertTextModeSupport: { valueSet: [1, 2] },
                commitCharactersSupport: true, preselectSupport: true, resolveSupport: { properties: ["detail", "documentation", "additionalTextEdits", "insertText", "textEdit"] } },
            insertTextMode: 2, completionList: { itemDefaults: ["editRange", "insertTextFormat", "insertTextMode", "data", "commitCharacters"] } };
        if (options.diagnostics) textDocument.publishDiagnostics = { versionSupport: true, relatedInformation: true,
            tagSupport: { valueSet: [1, 2] }, codeDescriptionSupport: true, dataSupport: true };
        const documentationFormats = options.markdownDocumentation ? ["markdown", "plaintext"] : ["plaintext"];
        if (this.features.has("textDocument/hover")) textDocument.hover = { dynamicRegistration: true, contentFormat: documentationFormats };
        if (this.features.has("textDocument/signatureHelp")) textDocument.signatureHelp = { dynamicRegistration: true, contextSupport: true,
            signatureInformation: { documentationFormat: documentationFormats, parameterInformation: { labelOffsetSupport: true }, activeParameterSupport: true } };
        if (this.features.has("textDocument/documentLink")) textDocument.documentLink = { dynamicRegistration: true, tooltipSupport: true };
        if (this.features.has("textDocument/documentHighlight")) textDocument.documentHighlight = { dynamicRegistration: true };
        if (this.features.has("textDocument/foldingRange")) textDocument.foldingRange = { dynamicRegistration: true, lineFoldingOnly: true,
            foldingRangeKind: { valueSet: ["comment", "imports", "region"] } };
        if (this.features.has("textDocument/documentColor") || this.features.has("textDocument/colorPresentation")) {
            delete textDocument.documentColor; delete textDocument.colorPresentation; textDocument.colorProvider = { dynamicRegistration: true };
        }
        if (this.features.has("textDocument/definition")) textDocument.definition = { dynamicRegistration: true, linkSupport: true };
        if (this.features.has("textDocument/codeAction")) textDocument.codeAction = { dynamicRegistration: true,
            codeActionLiteralSupport: { codeActionKind: { valueSet: ["quickfix", "refactor", "source"] } },
            disabledSupport: true, isPreferredSupport: true, dataSupport: true, resolveSupport: { properties: ["edit"] }, honorsChangeAnnotations: false };
        this.initializeParams = jsonSnapshot({ processId: null, rootUri: options.rootUri ?? null,
            ...(options.clientInfo ? { clientInfo: options.clientInfo } : {}), initializationOptions: options.initializationOptions ?? null,
            capabilities: { general: { positionEncodings: ["utf-16"], ...(options.markdownDocumentation ? { markdown: { parser: "sttropez-documentation-subset", version: "1", allowedTags: [] } } : {}) }, textDocument,
                ...(options.workspaceEdits || options.applyEdit || this.features.has("workspace/executeCommand") ? { workspace: {
                    ...(options.workspaceEdits || options.applyEdit ? { workspaceEdit: { documentChanges: true, resourceOperations: [], failureHandling: "transactional", normalizesLineEndings: false } } : {}),
                    ...(options.applyEdit ? { applyEdit: true } : {}), ...(this.features.has("workspace/executeCommand") ? { executeCommand: { dynamicRegistration: true } } : {}) } } : {}) } });
        this.scope = new NotificationScope(error => this.report(error));
        this.store = new Store(this.snapshot("disconnected", null), this.scope);
        this.state = Object.freeze({ getSnapshot: this.store.observable.getSnapshot, subscribe: listener => {
            this.scope.assertWritable(); if (this.store.get().phase === "disposed") throw closed();
            const stop = this.store.observable.subscribe(listener); const release = () => { stop(); this.subscriptions.delete(release); };
            this.subscriptions.add(release); return release;
        } });
    }
    private report(error: unknown): void { try { this.options.onError?.(error instanceof Error ? error : new Error(String(error))); } catch { /* Reporting cannot interrupt disposal. */ } }
    private release(stop: (() => void) | undefined): void { try { stop?.(); } catch (error) { this.report(error); } }
    private writable(): void { this.scope.assertWritable(); if (this.store.get().phase === "disposed") throw closed(); }
    private snapshot(phase: LspSessionSnapshot["phase"], error: string | null): LspSessionSnapshot {
        return Object.freeze({ phase, epoch: this.epoch, capabilities: this.capabilities,
            registrations: Object.freeze([...this.registrations.values()].map(item => item.value)), registrationGeneration: this.generation, documents: this.documents.size, error });
    }
    private publish(phase = this.store.get().phase, error: string | null = null): void {
        const changed = new Set<Store<unknown>>(); this.store.set(this.snapshot(phase, error), changed); this.scope.deliver([...changed]);
    }
    private current(epoch: number): boolean { return this.epoch === epoch && this.store.get().phase !== "disconnected" && this.store.get().phase !== "disposed"; }
    private ready(epoch = this.epoch): JsonRpcConnection { if (!this.current(epoch) || this.store.get().phase !== "ready" || !this.rpc) throw closed(); return this.rpc; }

    connect(): Promise<void> {
        this.writable(); if (this.store.get().phase === "ready") return Promise.resolve();
        if (this.options.applyEdit && !this.requests.has("workspace/applyEdit")) return Promise.reject(new TypeError("Advertised applyEdit requires a registered request handler before connection."));
        if (this.connectWork) return this.connectWork;
        if (this.store.get().phase !== "disconnected") return Promise.reject(closed());
        const epoch = ++this.epoch, listeners = new Set<() => void>(); let cancelled = false, rejectOpening!: (reason: Error) => void;
        const cancelledResult = new Promise<never>((_yes, no) => { rejectOpening = no; });
        this.cancelOpening = () => { if (cancelled) return; cancelled = true; rejectOpening(closed()); for (const listener of [...listeners]) this.release(listener); listeners.clear(); };
        const context: LspConnectContext = Object.freeze({ epoch, get cancelled() { return cancelled; }, onCancel: listener => {
            if (cancelled) { this.release(listener); return () => {}; } listeners.add(listener); return () => { listeners.delete(listener); };
        } });
        this.publish("connecting");
        const work = this.open(epoch, context, cancelledResult).catch(error => { if (this.current(epoch)) this.drop(error instanceof Error ? error : new Error(String(error))); throw error; });
        this.connectWork = work; const finished = () => { listeners.clear(); if (this.connectWork === work) this.connectWork = undefined; }; void work.then(finished, finished);
        return work;
    }
    private async open(epoch: number, context: LspConnectContext, cancelled: Promise<never>): Promise<void> {
        const opening = Promise.resolve().then(() => this.options.connect(context)).then(transport => {
            if (!this.current(epoch) || context.cancelled) { this.release(() => transport.dispose()); throw closed(); } return transport;
        });
        const raced = Promise.race([opening, cancelled]);
        let stopDeadline: (() => void) | undefined;
        let transport: RpcTransport;
        try { stopDeadline = this.options.schedule(this.options.rpc?.timeoutMs ?? wireLimits.timeoutMs, () => { if (this.current(epoch)) this.drop(new RpcError(rpcCodes.timeout, "LSP opening timed out.")); }); transport = await raced; }
        catch (error) { void raced.catch(() => {}); throw error; } finally { this.release(stopDeadline); }
        if (!this.current(epoch)) { this.release(() => transport.dispose()); throw closed(); }
        const rpc = new JsonRpcConnection(transport, { ...this.options.rpc, schedule: this.options.schedule, onError: error => this.report(error),
            onClose: error => { void Promise.resolve().then(() => { if (this.current(epoch)) this.drop(error); }); } });
        this.rpc = rpc; this.install(rpc, epoch); this.publish("initializing");
        const response = await rpc.request("initialize", this.initializeParams).result;
        if (!this.current(epoch)) throw closed();
        if (!isRecord(response) || !isRecord(response.capabilities)) throw new ProtocolDecodeError("Malformed LSP initialize result.");
        const capabilities = response.capabilities;
        if (capabilities.positionEncoding !== undefined && capabilities.positionEncoding !== "utf-16") throw new ProtocolDecodeError("LSP session requires UTF-16 positions.");
        const sync = capabilities.textDocumentSync;
        if (sync !== undefined && sync !== 0 && sync !== 2 && !isRecord(sync)) throw new ProtocolDecodeError("Only incremental LSP synchronization is supported.");
        if (isRecord(sync) && (sync.openClose !== undefined && typeof sync.openClose !== "boolean" || sync.change !== undefined && sync.change !== 0 && sync.change !== 2)) throw new ProtocolDecodeError("Invalid or unsupported synchronization capability.");
        for (const provider of Object.values(providers)) if (capabilities[provider] !== undefined && typeof capabilities[provider] !== "boolean" && !isRecord(capabilities[provider])) throw new ProtocolDecodeError("Malformed feature capability.");
        for (const provider of Object.values(providers)) { const value = capabilities[provider];
            if (isRecord(value) && Object.hasOwn(value, "documentSelector")) this.staticSelectors.set(provider, compileLspSelector(value.documentSelector, this.options.pathForUri)); }
        if (this.features.has("workspace/executeCommand") && capabilities.executeCommandProvider !== undefined) commandOptions(capabilities.executeCommandProvider);
        this.capabilities = capabilities as Readonly<Record<string, JsonValue>>;
        this.sync = { openClose: sync === 2 || isRecord(sync) && sync.openClose === true, change: sync === 2 || isRecord(sync) && sync.change === 2 };
        rpc.notify("initialized", {}); this.cancelOpening = undefined; this.publish("ready"); this.reconcile(); await this.flush();
    }
    private install(rpc: JsonRpcConnection, epoch: number): void {
        rpc.onRequest("window/showMessageRequest", () => null);
        rpc.onRequest("client/registerCapability", params => { this.ready(epoch); return this.register(params); });
        rpc.onRequest("client/unregisterCapability", params => { this.ready(epoch); return this.unregister(params); });
        for (const [method, handler] of this.requests) this.requestStops.set(method, this.installRequest(rpc, epoch, method, handler));
        for (const method of this.notifications.keys()) this.notificationStops.set(method, this.installNotification(rpc, epoch, method));
    }
    private installRequest(rpc: JsonRpcConnection, epoch: number, method: string, handler: RequestHandler): () => void {
        return rpc.onRequest(method, (params, context) => {
            if (!this.current(epoch) || this.requests.get(method) !== handler) throw closed();
            if (this.store.get().phase !== "ready") throw new RpcError(rpcCodes.serverNotInitialized, "Server not initialized.");
            return handler(params, Object.freeze({ ...context, get cancelled() { return context.cancelled; }, epoch, isCurrent: () => this.current(epoch) && this.store.get().phase === "ready" && !context.cancelled }));
        });
    }
    private installNotification(rpc: JsonRpcConnection, epoch: number, method: string): () => void {
        return rpc.onNotification(method, async params => {
            if (!this.current(epoch) || this.store.get().phase !== "ready" && !["window/showMessage", "window/logMessage", "telemetry/event"].includes(method)) return;
            for (const handler of [...this.notifications.get(method) ?? []]) {
                if (!this.current(epoch)) return; if (!this.notifications.get(method)?.has(handler)) continue;
                try { await handler(params, epoch); } catch (error) { this.report(error); }
            }
        });
    }
    private register(params: unknown): null {
        if (!isRecord(params) || !Array.isArray(params.registrations) || !params.registrations.length || params.registrations.length > wireLimits.registrations) throw new RpcError(rpcCodes.invalidParams, "Invalid capability registrations.");
        const next = new Map(this.registrations);
        for (const item of params.registrations) {
            if (!isRecord(item) || typeof item.id !== "string" || !item.id || typeof item.method !== "string" || next.has(item.id) ||
                !syncMethods.includes(item.method) && !this.features.has(item.method as LspFeature) && !(item.method === "textDocument/documentColor" && this.features.has("textDocument/colorPresentation")) || !isRecord(item.registerOptions)) throw new RpcError(rpcCodes.invalidParams, "Unsupported or duplicate registration.");
            if (item.method === "textDocument/didChange" && item.registerOptions.syncKind !== 2) throw new RpcError(rpcCodes.invalidParams, "Only incremental changes are supported.");
            if (item.id.length > 256 || JSON.stringify(item.registerOptions).length > 65536) throw new RpcError(rpcCodes.invalidParams, "Registration options exceed their limit.");
            let selector: LspSelector;
            try {
                if (item.method === "workspace/executeCommand") { commandOptions(item.registerOptions); if ("documentSelector" in item.registerOptions) throw new ProtocolDecodeError("Command registration cannot select documents."); selector = () => true; }
                else selector = compileLspSelector(item.registerOptions.documentSelector, this.options.pathForUri);
            } catch (error) { if (!(error instanceof ProtocolDecodeError)) throw error; throw new RpcError(rpcCodes.invalidParams, "Invalid registration selector or command options."); }
            const value = Object.freeze({ id: item.id, method: item.method, registerOptions: jsonSnapshot(item.registerOptions) }); next.set(item.id, { value, selector });
        }
        if (next.size > wireLimits.registrations || [...next.values()].reduce((units, item) => units + JSON.stringify(item.value.registerOptions).length, 0) > 1024 * 1024) throw new RpcError(rpcCodes.invalidParams, "Capability registry exceeds its limit.");
        if (this.collectCommands(next).length > 256) throw new RpcError(rpcCodes.invalidParams, "Command registry exceeds its limit.");
        this.registrations.clear(); for (const [id, item] of next) this.registrations.set(id, item);
        this.generation++; this.publish(); this.reconcile(); return null;
    }
    private unregister(params: unknown): null {
        if (!isRecord(params) || !Array.isArray(params.unregisterations) || !params.unregisterations.length || params.unregisterations.length > wireLimits.registrations) throw new RpcError(rpcCodes.invalidParams, "Invalid capability unregistrations.");
        const ids = new Set<string>();
        for (const item of params.unregisterations) {
            if (!isRecord(item) || typeof item.id !== "string" || ids.has(item.id) || this.registrations.get(item.id)?.value.method !== item.method) throw new RpcError(rpcCodes.invalidParams, "Unknown or mismatched registration."); ids.add(item.id);
        }
        for (const id of ids) this.registrations.delete(id); this.generation++; this.publish(); this.reconcile(); return null;
    }
    private matchesRegistration(registered: string, method: string): boolean { return registered === method || registered === "textDocument/documentColor" && method === "textDocument/colorPresentation"; }
    private matches(selector: LspSelector, entry: SelectorEntry): boolean {
        if (entry.selectors?.generation !== this.generation) entry.selectors = { generation: this.generation, values: new Map() };
        const cached = entry.selectors.values.get(selector); if (cached !== undefined) return cached;
        const value = selector(entry.snapshot); entry.selectors.values.set(selector, value); return value;
    }
    private registered(method: string, entry: SelectorEntry): boolean {
        for (const item of this.registrations.values()) if (this.matchesRegistration(item.value.method, method) && this.matches(item.selector, entry)) return true;
        return false;
    }
    private syncs(entry: SelectorEntry): boolean { return (this.sync.openClose || this.registered("textDocument/didOpen", entry)) && (this.sync.change || this.registered("textDocument/didChange", entry)); }
    private failed(entry: Entry): Error | undefined {
        return entry.failure?.snapshot === entry.snapshot && entry.failure.generation === this.generation ? entry.failure.error : undefined;
    }
    canRequest(method: LspDocumentFeature, document: LspDocument): boolean {
        const entry = this.entry(document);
        return !this.failed(entry) && this.supports(method, entry);
    }
    private supports(method: LspDocumentFeature, entry: SelectorEntry): boolean {
        return this.store.get().phase === "ready" && this.features.has(method) && this.syncs(entry) && (this.staticAvailable(method, entry) || this.registered(method, entry));
    }
    private staticAvailable(method: LspDocumentFeature, entry: SelectorEntry): boolean {
        const provider = providers[method], capability = this.capabilities[provider], selector = this.staticSelectors.get(provider);
        return (capability === true || isRecord(capability)) && (!selector || this.matches(selector, entry));
    }
    /** Static and matching dynamic options only; selectors and session readiness use the request policy. */
    featureOptions(method: LspDocumentFeature, document: LspDocument): readonly Readonly<Record<string, JsonValue>>[] {
        if (!this.canRequest(method, document)) return Object.freeze([]);
        return this.optionsFor(method, this.entry(document));
    }
    /** Read capabilities without binding, synchronizing or reserving a document. */
    queryFeatureOptions(method: LspDocumentFeature, document: LspSelectorDocument): readonly Readonly<Record<string, JsonValue>>[] {
        const { uri, languageId } = document;
        if (!isLspUri(uri) || !isLspIdentityPart(languageId)) throw new TypeError("Invalid LSP document identity.");
        const bound = this.documents.get(uri), same = bound?.snapshot.languageId === languageId;
        if (same && this.failed(bound)) return Object.freeze([]);
        const entry: SelectorEntry = same ? bound : { snapshot: Object.freeze({ uri, languageId }) };
        return this.supports(method, entry) ? this.optionsFor(method, entry) : Object.freeze([]);
    }
    private optionsFor(method: LspDocumentFeature, entry: SelectorEntry): readonly Readonly<Record<string, JsonValue>>[] {
        const capability = this.capabilities[providers[method]], values: Readonly<Record<string, JsonValue>>[] = [];
        if (this.staticAvailable(method, entry)) { if (isRecord(capability)) values.push(capability); else if (capability === true) values.push(empty); }
        for (const item of this.registrations.values()) if (this.matchesRegistration(item.value.method, method) && this.matches(item.selector, entry) && isRecord(item.value.registerOptions)) values.push(item.value.registerOptions);
        return Object.freeze(values);
    }
    private collectCommands(registrations: ReadonlyMap<string, Registration> = this.registrations): readonly string[] {
        const values = new Set<string>(), provider = this.capabilities.executeCommandProvider;
        if (this.features.has("workspace/executeCommand") && provider !== undefined) for (const name of commandOptions(provider)) values.add(name);
        for (const item of registrations.values()) if (item.value.method === "workspace/executeCommand") for (const name of commandOptions(item.value.registerOptions)) values.add(name);
        return Object.freeze([...values]);
    }
    commandNames(): readonly string[] { return this.store.get().phase === "ready" && this.features.has("workspace/executeCommand") ? this.collectCommands() : Object.freeze([]); }
    /** Explicit caller policy/confirmation is required; commands are never replayed across a session. */
    requestCommand<T = JsonValue>(command: string, args: readonly JsonValue[] = [], timeoutMs = this.options.rpc?.timeoutMs ?? wireLimits.timeoutMs, authorization?: LspCommandAuthorization): LspCommandCall<T> {
        this.writable();
        const argumentsValue = jsonSnapshot(args); if (!Array.isArray(argumentsValue) || JSON.stringify(argumentsValue).length > wireLimits.commandArgumentUnits) throw new RangeError("LSP command arguments exceed their limit.");
        if (authorization && (authorization.command !== command || !jsonEqual(authorization.arguments, argumentsValue))) throw new RpcError(rpcCodes.methodNotFound, "Host command authorization does not match this invocation.");
        const permitted = authorization?.isCurrent ?? (() => this.commandNames().includes(command));
        if (!this.features.has("workspace/executeCommand") || !permitted()) throw new RpcError(rpcCodes.methodNotFound, "LSP command is neither advertised nor authorized by the host.");
        const epoch = this.epoch, generation = this.generation, isCurrent = () => this.current(epoch) && this.store.get().phase === "ready" && this.generation === generation && permitted();
        const call = this.ready(epoch).request<T>("workspace/executeCommand", { command, arguments: argumentsValue }, timeoutMs);
        return Object.freeze({ id: call.id, cancel: call.cancel, isCurrent, result: call.result.then(result => { if (!isCurrent()) throw stale(); return result; }) });
    }
    private entry(handle: LspDocument): Entry { const entry = this.handles.get(handle); if (!entry || this.documents.get(entry.snapshot.uri) !== entry) throw stale(); return entry; }
    private size(length: number, previous: number): void {
        if (!integer(length) || length > this.maxDocumentUnits || this.totalUnits - previous + length > this.maxTotalUnits) throw new RangeError("LSP document size limit exceeded.");
    }
    bindDocument(snapshot: LspDocumentSnapshot): LspDocument {
        this.writable(); const { uri, languageId, resourceId, documentId, revision, buffer } = snapshot;
        if (!isLspUri(uri) || ![languageId, resourceId, documentId].every(isLspIdentityPart) || !integer(revision)) throw new TypeError("Invalid LSP document identity.");
        if (this.documents.has(uri) || this.documents.size >= this.maxDocuments) throw new Error("LSP URI is already bound or document limit exceeded."); this.size(buffer.length, 0);
        const entry: Entry = { snapshot: Object.freeze({ uri, languageId, resourceId, documentId, revision, buffer }), handle: undefined! };
        const handle: LspDocument = Object.freeze({ getSnapshot: () => entry.snapshot,
            update: (expectedRevision, nextRevision, nextBuffer, mapping) => {
                this.writable(); this.entry(handle); if (entry.snapshot.revision !== expectedRevision || !integer(nextRevision) || nextRevision <= expectedRevision) throw stale(); this.size(nextBuffer.length, entry.snapshot.buffer.length);
                if (mapping) entry.change = Object.freeze({ before: entry.snapshot.buffer, mapping }); else delete entry.change;
                this.totalUnits += nextBuffer.length - entry.snapshot.buffer.length; entry.snapshot = Object.freeze({ ...entry.snapshot, revision: nextRevision, buffer: nextBuffer }); delete entry.failure; this.kick(uri);
            }, close: () => {
                if (this.store.get().phase === "disposed") return; this.writable(); if (this.documents.get(uri) !== entry) return;
                this.documents.delete(uri); delete entry.change; delete entry.selectors; this.totalUnits -= entry.snapshot.buffer.length; this.publish(); this.kick(uri);
            } });
        entry.handle = handle; this.handles.set(handle, entry); this.documents.set(uri, entry); this.totalUnits += buffer.length; this.publish(); this.kick(uri); return handle;
    }
    /** Capability/connection changes reconcile every binding, including pending closes. */
    private reconcile(): void {
        for (const uri of this.remote.keys()) this.dirty.add(uri);
        for (const [uri, entry] of this.documents) { delete entry.selectors; this.dirty.add(uri); }
        this.kick();
    }
    private kick(uri?: string): void {
        if (this.store.get().phase !== "ready") return;
        // Offline captures reconcile on connect. A binding closed before its first send
        // has no wire cleanup; churn must not accumulate obsolete queued URI strings.
        if (uri !== undefined) { if (this.documents.has(uri) || this.remote.has(uri)) this.dirty.add(uri); else this.dirty.delete(uri); }
        if (!this.dirty.size) return;
        this.settle(undefined, true); if (this.scheduled || this.pumping) return;
        const epoch = this.epoch;
        try { this.scheduled = this.options.schedule(0, () => {
            this.scheduled = undefined; if (!this.current(epoch)) return; this.pumping = true;
            void this.pump(epoch).then(() => { if (!this.current(epoch)) return; this.pumping = false;
                if (this.dirty.size) this.kick(); else this.settle();
            }, error => { if (this.current(epoch)) this.drop(error instanceof Error ? error : new Error(String(error))); });
        }); } catch (error) { this.drop(error instanceof Error ? error : new Error(String(error))); }
    }
    private pause(epoch: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const pause = { stop: () => {}, reject }; this.pauses.add(pause);
            try { pause.stop = this.options.schedule(0, () => { this.pauses.delete(pause); if (this.current(epoch) && this.store.get().phase === "ready") resolve(); else reject(closed()); }); }
            catch (error) { this.pauses.delete(pause); reject(error); }
        });
    }
    private async pump(epoch: number): Promise<void> {
        while (this.dirty.size) {
            const uri = this.dirty.values().next().value!; this.dirty.delete(uri);
            const rpc = this.ready(epoch), generation = this.generation, entry = this.documents.get(uri), remote = this.remote.get(uri);
            try {
                if (remote && (remote.entry !== entry || !this.syncs(entry!))) {
                    rpc.notify("textDocument/didClose", { textDocument: { uri } }); this.remote.delete(uri);
                }
                if (!entry) continue;
                if (this.failed(entry)) continue;
                delete entry.failure;
                if (!this.syncs(entry)) continue; const snapshot = entry.snapshot, old = this.remote.get(uri), hint = entry.change;
                if (old?.snapshot === snapshot) continue;
                const expired = {}, retained = () => this.documents.get(uri) === entry;
                const valid = () => entry.snapshot === snapshot && retained() && this.generation === generation;
                const now = this.options.now ?? Date.now; let started = now(), checkpoints = 0;
                const cooperate = async () => {
                    this.ready(epoch); if (!retained()) throw expired;
                    if (++checkpoints < 32 && now() - started < 4) return;
                    await this.pause(epoch); if (!retained()) throw expired;
                    started = now(); checkpoints = 0;
                };
                const base = entry.index ?? old?.index;
                let plan;
                try { plan = base ? await base.change(snapshot.buffer, cooperate, hint) : { index: await LspLineIndex.create(snapshot.buffer, cooperate), changes: [] }; }
                catch (error) { if (error !== expired) throw error; this.dirty.add(uri); continue; }
                // Restart ownership cleanup too: replacing a URI during planning must close/open, never change the old resource.
                this.ready(epoch); if (!retained()) { this.dirty.add(uri); continue; }
                // A revision/capability change does not invalidate useful text indexing work.
                entry.index = plan.index; if (!valid()) { this.dirty.add(uri); continue; }
                let changes: readonly LspTextChange[];
                try { changes = old && old.index !== base ? await lspTextChanges(old.index, snapshot.buffer, cooperate, hint) : plan.changes; }
                catch (error) { if (error !== expired) throw error; this.dirty.add(uri); continue; }
                this.ready(epoch); if (!valid()) { this.dirty.add(uri); continue; }
                const version = (old?.version ?? 0) + 1; if (version > 0x7fffffff) throw new RangeError("LSP document version exhausted; reconnect required.");
                if (old) {
                    const send = () => rpc.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: changes });
                    try { send(); } catch (error) {
                        // notify validates/encodes before sending; transport failures dispose RPC.
                        // Range overhead can exceed a host limit even when one replacement fits.
                        if (changes.length < 2 || rpc.snapshot().disposed || !(error instanceof TypeError || error instanceof RangeError)) throw error;
                        try { changes = await lspTextChanges(old.index, snapshot.buffer, cooperate); }
                        catch (error) { if (error !== expired) throw error; this.dirty.add(uri); continue; }
                        this.ready(epoch); if (!valid()) { this.dirty.add(uri); continue; }
                        send();
                    }
                }
                else rpc.notify("textDocument/didOpen", { textDocument: { uri, languageId: snapshot.languageId, version, text: snapshot.buffer.slice(0, snapshot.buffer.length) } });
                this.ready(epoch); this.remote.set(uri, { entry, snapshot, index: plan.index, version });
                // A host transport can edit or close the binding synchronously during send.
                if (!valid()) this.dirty.add(uri);
                if (entry.snapshot === snapshot) delete entry.change;
            } catch (error) { this.failDocument(entry ?? remote!.entry, error, epoch); }
            finally { this.settle(undefined, true); }
        }
    }
    private failDocument(entry: Entry, cause: unknown, epoch: number): void {
        const rpc = this.ready(epoch); if (rpc.snapshot().disposed) throw cause;
        const snapshot = entry.snapshot, error = new RpcError(rpcCodes.pendingLimit, `LSP synchronization failed for ${snapshot.uri}: ${cause instanceof Error ? cause.message : String(cause)}`);
        if (this.remote.get(snapshot.uri)?.entry === entry) {
            rpc.notify("textDocument/didClose", { textDocument: { uri: snapshot.uri } }); this.remote.delete(snapshot.uri);
        }
        delete entry.change; entry.failure = { snapshot, generation: this.generation, error }; this.report(error);
    }
    private settle(error?: Error, documentsOnly = false): void {
        for (const waiter of this.waiters) {
            try {
                if (error) throw error;
                if (waiter.ready ? !waiter.ready() : documentsOnly) continue;
                waiter.resolve();
            } catch (cause) { waiter.reject(cause instanceof Error ? cause : new Error(String(cause))); }
            this.waiters.delete(waiter);
        }
    }
    private waitForSync(entries?: readonly Entry[]): LspCall<void> {
        this.ready(); const generation = this.generation, captures = entries?.map(entry => ({ entry, snapshot: entry.snapshot }));
        const ready = captures ? () => {
            let synchronized = true;
            for (const { entry, snapshot } of captures) {
                if (generation !== this.generation || this.documents.get(snapshot.uri) !== entry || entry.snapshot !== snapshot) throw stale();
                const failure = this.failed(entry); if (failure) throw failure;
                if (this.remote.get(snapshot.uri)?.snapshot !== snapshot && this.syncs(entry)) synchronized = false;
            }
            return synchronized;
        } : undefined;
        try { if (ready ? ready() : !this.dirty.size && !this.scheduled && !this.pumping) return { result: Promise.resolve(), cancel: () => {} }; }
        catch (error) { return { result: Promise.reject(error), cancel: () => {} }; }
        this.kick();
        if (this.waiters.size >= wireLimits.synchronizationWaits) throw new RpcError(rpcCodes.pendingLimit, "Too many pending synchronization waits.");
        let waiter!: SyncWaiter;
        const result = new Promise<void>((resolve, reject) => { waiter = { resolve, reject, ready }; this.waiters.add(waiter); });
        return { result, cancel: () => { if (this.waiters.delete(waiter)) waiter.reject(cancelError()); } };
    }
    /** With documents, wait only for those exact captures; otherwise drain all synchronization work. */
    flush(documents?: readonly LspDocument[]): Promise<void> { this.scope.assertWritable(); return this.waitForSync(documents?.map(document => this.entry(document))).result; }
    /** The exact sent snapshot, never a guessed provider-analysis revision. Unsynced local edits return undefined. */
    synchronized(document: LspDocument): LspDocumentCapture | undefined {
        const entry = this.handles.get(document); if (this.store.get().phase !== "ready" || !entry || this.failed(entry) || this.documents.get(entry.snapshot.uri) !== entry) return undefined;
        const remote = this.remote.get(entry.snapshot.uri); if (!remote || remote.snapshot !== entry.snapshot) return undefined;
        const epoch = this.epoch, generation = this.generation;
        return Object.freeze({ document: remote.snapshot, index: remote.index, version: remote.version, epoch, registrationGeneration: generation, maxDocumentUnits: this.maxDocumentUnits,
            isBindingCurrent: () => this.store.get().phase === "ready" && this.epoch === epoch && this.generation === generation && this.documents.get(remote.snapshot.uri) === entry,
            isCurrent: () => this.store.get().phase === "ready" && this.epoch === epoch && this.generation === generation && this.documents.get(remote.snapshot.uri) === entry
                && entry.snapshot === remote.snapshot && this.remote.get(remote.snapshot.uri) === remote });
    }
    requestDocument<T = JsonValue>(method: LspDocumentFeature, document: LspDocument, params: (index: LspLineIndex, snapshot: LspDocumentSnapshot, capture: LspDocumentCapture) => Readonly<Record<string, JsonValue>>): LspCall<T> {
        this.writable(); this.ready(); if (this.documentCalls.size >= (this.options.rpc?.maxPending ?? wireLimits.pendingRequests)) throw new RpcError(rpcCodes.pendingLimit, "Too many pending document requests.");
        const entry = this.entry(document), snapshot = entry.snapshot, epoch = this.epoch, generation = this.generation, waiting = this.waitForSync([entry]); let cancelled = false, call: RpcCall<T> | undefined;
        const guard = () => { if (cancelled) throw cancelError(); this.ready(epoch); if (this.documents.get(snapshot.uri) !== entry || entry.snapshot !== snapshot || generation !== this.generation) throw stale(); };
        const result = (async () => { await waiting.result; guard(); const failure = this.failed(entry); if (failure) throw failure;
            if (!this.canRequest(method, document)) throw new RpcError(rpcCodes.methodNotFound, "LSP feature unavailable for this document.");
            const capture = this.synchronized(document); if (capture?.document !== snapshot) throw stale();
            const value = params(capture.index, snapshot, capture); guard(); call = this.ready(epoch).request<T>(method, { ...value, textDocument: { uri: snapshot.uri } }); const response = await call.result; guard(); return response;
        })();
        const handle = Object.freeze({ result, cancel: () => { cancelled = true; waiting.cancel(); call?.cancel(); } }); this.documentCalls.add(handle);
        void result.then(() => { this.documentCalls.delete(handle); }, () => { this.documentCalls.delete(handle); }); return handle;
    }
    request<T = JsonValue>(method: string, params?: JsonValue): RpcCall<T> { this.writable(); if (reserved(method)) throw new TypeError("Use the LSP lifecycle or captured document API."); return this.ready().request<T>(method, params); }
    notify(method: string, params?: JsonValue): void { this.writable(); if (reserved(method)) throw new TypeError("Use the LSP lifecycle or captured document API."); this.ready().notify(method, params); }
    onRequest(method: string, handler: RequestHandler): () => void {
        this.writable(); if (!method || method.startsWith("rpc.") || reservedIncoming(method) || method === "window/showMessageRequest" || this.requests.has(method) || this.requests.size >= wireLimits.handlers) throw new TypeError("Reserved, duplicate or excessive LSP handler.");
        this.requests.set(method, handler); if (this.rpc) this.requestStops.set(method, this.installRequest(this.rpc, this.epoch, method, handler));
        return () => { if (this.store.get().phase === "disposed") return; this.writable(); if (this.requests.get(method) !== handler) return; this.requests.delete(method); this.release(this.requestStops.get(method)); this.requestStops.delete(method); };
    }
    onNotification(method: string, handler: NotificationHandler): () => void {
        this.writable(); if (!method || method.startsWith("rpc.") || reservedIncoming(method) || !this.notifications.has(method) && this.notifications.size >= wireLimits.handlers) throw new TypeError("Reserved or excessive LSP notification."); let handlers = this.notifications.get(method);
        if (!handlers) { handlers = new Set(); this.notifications.set(method, handlers); if (this.rpc) this.notificationStops.set(method, this.installNotification(this.rpc, this.epoch, method)); } handlers.add(handler);
        return () => { if (this.store.get().phase === "disposed") return; this.writable(); handlers.delete(handler);
            if (!handlers.size && this.notifications.get(method) === handlers) { this.notifications.delete(method); this.release(this.notificationStops.get(method)); this.notificationStops.delete(method); } };
    }
    async shutdown(): Promise<void> {
        this.writable(); const rpc = this.ready(), epoch = this.epoch; do { await this.flush(); this.ready(epoch); } while (this.dirty.size || this.scheduled || this.pumping); this.publish("stopping");
        try { const result = await rpc.request("shutdown").result; if (result !== null) throw new TypeError("Invalid LSP shutdown result."); if (this.current(epoch)) rpc.notify("exit"); }
        finally { if (this.current(epoch)) this.drop(new Error("LSP session shut down.")); }
    }
    disconnect(): void { this.writable(); this.drop(new Error("LSP session disconnected.")); }
    private drop(error: Error, dispose = false): void {
        const failure = error instanceof RpcError ? error : new RpcError(rpcCodes.closed, error.message);
        this.epoch++; this.release(this.cancelOpening); this.cancelOpening = undefined; this.connectWork = undefined;
        this.release(this.scheduled); this.scheduled = undefined; for (const pause of this.pauses) { this.release(pause.stop); pause.reject(failure); } this.pauses.clear();
        const rpc = this.rpc; this.rpc = undefined; this.release(() => rpc?.dispose(failure)); this.pumping = false; this.dirty.clear(); this.settle(failure); this.documentCalls.clear();
        this.remote.clear(); this.registrations.clear(); this.staticSelectors.clear(); this.requestStops.clear(); this.notificationStops.clear(); this.capabilities = empty; this.sync = { openClose: false, change: false }; this.generation++;
        for (const entry of this.documents.values()) { delete entry.failure; delete entry.change; delete entry.selectors; }
        if (dispose) { this.documents.clear(); this.totalUnits = 0; this.requests.clear(); this.notifications.clear(); }
        this.publish(dispose ? "disposed" : "disconnected", error.message);
        if (dispose) for (const stop of [...this.subscriptions]) this.release(stop);
    }
    dispose(): void { if (this.store.get().phase === "disposed") return; this.scope.assertWritable(); this.drop(new Error("LSP session disposed."), true); }
    snapshotOwnership(): Readonly<{ documents: number; remoteDocuments: number; registrations: number; subscriptions: number; scheduledTasks: number; pendingDocumentRequests: number; pendingRequests: number; incomingRequests: number }> {
        const rpc = this.rpc?.snapshot(); return Object.freeze({ documents: this.documents.size, remoteDocuments: this.remote.size, registrations: this.registrations.size, subscriptions: this.scope.subscriptionCount(),
            scheduledTasks: this.pauses.size + Number(!!this.scheduled), pendingDocumentRequests: this.documentCalls.size, pendingRequests: rpc?.pendingRequests ?? 0, incomingRequests: rpc?.incomingRequests ?? 0 });
    }
}
