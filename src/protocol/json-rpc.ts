import { invalidRange, isPositiveInteger } from "../core/bounds.ts";
import { wireLimits, rpcCodes, cancelledRequest, closedConnection, RpcError, isRecord, isJson, freezeParsedJson } from "./wire.ts";
import type { JsonValue } from "./wire.ts";
export type RpcId = string | number | null;
export type RpcTransport = Readonly<{
    send: (message: string) => void;
    subscribe: (listener: Readonly<{ message: (message: string) => void; close: (reason: Error) => void }>) => () => void;
    dispose: () => void;
}>;
/** Hosts supply scheduling; this module imports no platform, networking or storage APIs. */
export type RpcScheduler = (delayMs: number, callback: () => void) => () => void;
export type RpcOptions = Readonly<{ schedule: RpcScheduler; timeoutMs?: number; maxPending?: number; maxMessageUnits?: number;
    /** Maximum JSON values per transport message, including a batch; defaults to maxMessageUnits. */
    maxJsonNodes?: number;
    /** Whether local cancellation/deadline expiry may notify the peer; local rejection always occurs. */
    notifyCancellation?: () => boolean;
    onError?: (error: Error) => void; onClose?: (error: Error) => void }>;
export type RpcCall<T> = Readonly<{ id: number; result: Promise<T>; cancel: () => void }>;
export type RpcRequestContext = Readonly<{ id: RpcId; cancelled: boolean; onCancel: (listener: () => void) => () => void }>;
type RequestHandler = (params: unknown, context: RpcRequestContext) => unknown | Promise<unknown>;
type NotificationHandler = (params: unknown) => void | Promise<void>;
type Message = Record<string, unknown>;
type Pending = { resolve: (value: JsonValue) => void; reject: (error: Error) => void; stop: () => void };
type ConnectionOptions = RpcOptions & { onReply?: (id: number) => boolean | undefined };
type Incoming = { context: RpcRequestContext; cancel: () => void };

const has = (value: Message, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const idValue = (value: unknown): value is RpcId => value === null || typeof value === "string" || typeof value === "number" && Number.isSafeInteger(value);
function methodName(method: string): void {
    if (!method || method.startsWith("rpc.")) throw new TypeError("Invalid application RPC method.");
}
const failure = (id: RpcId, code: number, message: string, data?: JsonValue) => ({ jsonrpc: "2.0", id,
    error: { code, message, ...(data === undefined ? {} : { data }) } });

/** Bidirectional JSON-RPC 2.0 over an ordered, message-delimited host transport. */
export class JsonRpcConnection {
    readonly #transport: RpcTransport;
    readonly #options: ConnectionOptions;
    readonly #timeoutMs: number;
    readonly #maxPending: number;
    readonly #maxMessageUnits: number;
    readonly #maxJsonNodes: number;
    readonly #pending = new Map<number, Pending>();
    readonly #incoming = new Map<RpcId, Incoming>();
    readonly #requests = new Map<string, RequestHandler>();
    readonly #notifications = new Map<string, Set<NotificationHandler>>();
    #stopListening: () => void = () => {};
    #serial = 0;
    #disposed = false;

    constructor(transport: RpcTransport, options: ConnectionOptions) {
        this.#transport = transport; this.#options = options;
        this.#timeoutMs = options.timeoutMs ?? wireLimits.timeoutMs; this.#maxPending = options.maxPending ?? wireLimits.pendingRequests; this.#maxMessageUnits = options.maxMessageUnits ?? wireLimits.messageUnits;
        this.#maxJsonNodes = options.maxJsonNodes ?? this.#maxMessageUnits;
        try {
            if (![this.#timeoutMs, this.#maxPending, this.#maxMessageUnits, this.#maxJsonNodes].every(isPositiveInteger)) invalidRange("RPC limits");
            this.#stopListening = transport.subscribe({ message: message => this.#receive(message), close: reason => this.dispose(reason) });
        } catch (error) {
            this.dispose(error instanceof Error ? error : closedConnection());
            throw error;
        }
        if (this.#disposed) this.#release(this.#stopListening);
    }
    #report(error: Error): void { try { this.#options.onError?.(error); } catch { /* Host diagnostics cannot interrupt protocol cleanup. */ } }
    #release(stop: () => void): void { try { stop(); } catch (error) { this.#report(error instanceof Error ? error : new Error("RPC cleanup failed.")); } }
    #encode(value: unknown): string {
        if (!isJson(value, this.#maxJsonNodes)) throw new TypeError("RPC messages must contain bounded JSON values.");
        const encoded = JSON.stringify(value); if (encoded.length > this.#maxMessageUnits) throw new RangeError("RPC message exceeds the configured limit."); return encoded;
    }
    #emit(value: unknown): boolean {
        if (this.#disposed) return false;
        try { return this.#send(this.#encode(value)); }
        catch (error) { this.dispose(error instanceof Error ? error : new Error("RPC encoding failed.")); return false; }
    }
    #send(text: string): boolean {
        if (this.#disposed) return false;
        try { this.#transport.send(text); return true; }
        catch (error) { this.dispose(error instanceof Error ? error : new Error("RPC transport failed.")); return false; }
    }
    request(method: string, params?: unknown, timeoutMs = this.#timeoutMs): RpcCall<JsonValue> {
        methodName(method);
        if (this.#disposed) throw closedConnection();
        if (this.#pending.size >= this.#maxPending) throw new RpcError(rpcCodes.pendingLimit, "Too many pending RPC requests.");
        if (!isPositiveInteger(timeoutMs)) invalidRange("RPC deadline");
        const id = ++this.#serial, message = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
        if (params !== undefined && !isRecord(params) && !Array.isArray(params)) throw new TypeError("RPC parameters must be structured.");
        const encoded = this.#encode(message);
        let resolve!: (value: JsonValue) => void, reject!: (error: Error) => void;
        const result = new Promise<JsonValue>((yes, no) => { resolve = yes; reject = no; });
        const entry: Pending = { resolve, reject, stop: () => {} }; this.#pending.set(id, entry);
        const cancel = (error: RpcError) => {
            if (this.#pending.get(id) !== entry) return; this.#pending.delete(id); this.#release(entry.stop); reject(error);
            let notify = true;
            try { notify = this.#options.notifyCancellation?.() ?? true; }
            catch (error) { notify = false; this.#report(error instanceof Error ? error : new Error("RPC cancellation policy failed.")); }
            if (notify) this.#emit({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } });
        };
        try { entry.stop = this.#options.schedule(timeoutMs, () => cancel(new RpcError(rpcCodes.timeout, "RPC request timed out."))); }
        catch (error) { this.#pending.delete(id); reject(error instanceof Error ? error : new Error("RPC scheduling failed.")); }
        if (this.#pending.get(id) === entry) this.#send(encoded); else this.#release(entry.stop);
        return Object.freeze({ id, result, cancel: () => cancel(cancelledRequest()) });
    }
    notify(method: string, params?: unknown): void {
        methodName(method); if (this.#disposed) throw closedConnection();
        if (params !== undefined && !isRecord(params) && !Array.isArray(params)) throw new TypeError("RPC parameters must be structured.");
        const message = { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) };
        if (!this.#send(this.#encode(message))) throw closedConnection("RPC transport is closed.");
    }
    onRequest(method: string, handler: RequestHandler): () => void {
        methodName(method); if (this.#disposed || this.#requests.has(method)) throw new Error("RPC request handler is unavailable.");
        this.#requests.set(method, handler); return () => { if (this.#requests.get(method) === handler) this.#requests.delete(method); };
    }
    onNotification(method: string, handler: NotificationHandler): () => void {
        methodName(method); if (this.#disposed) throw new Error("RPC connection is closed.");
        let handlers = this.#notifications.get(method); if (!handlers) { handlers = new Set(); this.#notifications.set(method, handlers); }
        handlers.add(handler); return () => { handlers.delete(handler); if (!handlers.size) this.#notifications.delete(method); };
    }
    #rejectJson(value: unknown): unknown {
        const error = new RpcError(rpcCodes.invalidRequest, "RPC JSON structure exceeds the configured node limit or nesting limit.");
        // The parsed envelope can identify a response even though its payload is unusable.
        // Never answer a response with another error response or leave its call waiting.
        if (isRecord(value) && !has(value, "method") && (has(value, "result") || has(value, "error"))) {
            const entry = typeof value.id === "number" ? this.#pending.get(value.id) : undefined;
            if (entry) { this.#pending.delete(value.id as number); this.#release(entry.stop); entry.reject(error); }
            else this.#report(error);
            return;
        }
        if (isRecord(value) && typeof value.method === "string" && !has(value, "id")) { this.#report(error); return; }
        return failure(isRecord(value) && idValue(value.id) ? value.id : null, rpcCodes.invalidRequest, error.message);
    }
    #receive(text: string): void {
        if (this.#disposed) return;
        if (typeof text !== "string" || text.length > this.#maxMessageUnits) { this.dispose(new RpcError(rpcCodes.invalidRequest, "RPC message exceeds the configured limit.")); return; }
        let value: unknown;
        try { value = JSON.parse(text); } catch { this.#emit(failure(null, rpcCodes.parseError, "Parse error")); return; }
        if (Array.isArray(value) && value.length > wireLimits.batchMessages) { this.dispose(new RpcError(rpcCodes.invalidRequest, "RPC batch exceeds the configured limit.")); return; }
        if (!freezeParsedJson(value, this.#maxJsonNodes)) {
            if (Array.isArray(value)) { const replies = value.map(message => this.#rejectJson(message)).filter(reply => reply !== undefined); if (replies.length) this.#emit(replies); }
            else { const reply = this.#rejectJson(value); if (reply !== undefined) this.#emit(reply); }
            return;
        }
        if (Array.isArray(value)) {
            if (!value.length) { this.#emit(failure(null, rpcCodes.invalidRequest, "Invalid Request")); return; }
            void Promise.all(value.map(message => this.#dispatch(message))).then(replies => {
                const responses = replies.filter(reply => reply !== undefined); if (responses.length) this.#emit(responses);
            }).catch(error => this.dispose(error instanceof Error ? error : new Error("RPC batch failed.")));
        } else void Promise.resolve(this.#dispatch(value)).then(reply => { if (reply !== undefined) this.#emit(reply); })
            .catch(error => this.dispose(error instanceof Error ? error : new Error("RPC dispatch failed.")));
    }
    #dispatch(value: unknown): unknown | Promise<unknown> {
        if (this.#disposed) return;
        if (!isRecord(value) || value.jsonrpc !== "2.0") return failure(null, rpcCodes.invalidRequest, "Invalid Request");
        if (!has(value, "method")) {
            if (!has(value, "id") || !idValue(value.id) || has(value, "result") === has(value, "error") || has(value, "params")) {
                this.dispose(new RpcError(rpcCodes.invalidRequest, "Invalid RPC response.")); return;
            }
            if (has(value, "error") && (!isRecord(value.error) || !Number.isSafeInteger(value.error.code) || typeof value.error.message !== "string")) {
                this.dispose(new RpcError(rpcCodes.invalidRequest, "Invalid RPC error response.")); return;
            }
            const entry = typeof value.id === "number" ? this.#pending.get(value.id) : undefined;
            const error = has(value, "error") ? value.error as Message : undefined;
            const expected = typeof value.id === "number" && this.#options.onReply?.(value.id);
            const rejected = error && new RpcError(error.code as number, error.message as string, error.data as JsonValue | undefined);
            if (!entry) { if (rejected && !expected) this.#report(rejected); return; }
            this.#pending.delete(value.id as number); this.#release(entry.stop);
            if (rejected) entry.reject(rejected);
            else entry.resolve(value.result as JsonValue);
            return;
        }
        if (typeof value.method !== "string" || !value.method || has(value, "result") || has(value, "error") || has(value, "id") && !idValue(value.id)) return failure(null, rpcCodes.invalidRequest, "Invalid Request");
        const id = has(value, "id") ? value.id as RpcId : undefined;
        if (has(value, "params") && !isRecord(value.params) && !Array.isArray(value.params)) return id === undefined ? undefined : failure(id, rpcCodes.invalidParams, "Invalid params");
        if (id === undefined) {
            if (value.method === "$/cancelRequest" && isRecord(value.params) && idValue(value.params.id)) this.#incoming.get(value.params.id)?.cancel();
            for (const handler of [...this.#notifications.get(value.method) ?? []]) {
                if (this.#disposed) break;
                try { void Promise.resolve(handler(value.params)).catch(error => this.#report(error instanceof Error ? error : new Error("RPC notification failed."))); }
                catch (error) { this.#report(error instanceof Error ? error : new Error("RPC notification failed.")); }
            }
            return;
        }
        const handler = this.#requests.get(value.method); if (!handler) return failure(id, rpcCodes.methodNotFound, "Method not found");
        if (this.#incoming.has(id)) { this.dispose(new RpcError(rpcCodes.invalidRequest, "Duplicate in-flight RPC identifier.")); return; }
        if (this.#incoming.size >= this.#maxPending) return failure(id, rpcCodes.pendingLimit, "Too many incoming RPC requests.");
        let cancelled = false; const listeners = new Set<() => void>();
        const context = Object.freeze({ id, get cancelled() { return cancelled; }, onCancel: (listener: () => void) => {
            if (cancelled) listener(); else listeners.add(listener); return () => { listeners.delete(listener); };
        } });
        const entry: Incoming = { context, cancel: () => { if (cancelled) return; cancelled = true;
            for (const listener of [...listeners]) { try { listener(); } catch (error) { this.#report(error instanceof Error ? error : new Error("RPC cancellation failed.")); } } listeners.clear(); } };
        this.#incoming.set(id, entry);
        return Promise.resolve().then(() => {
            if (this.#disposed || context.cancelled) throw cancelledRequest(); return handler(value.params, context);
        }).then(result => {
            if (context.cancelled) throw cancelledRequest();
            const reply = { jsonrpc: "2.0", id, result: result === undefined ? null : result }; this.#encode(reply); return reply;
        }).catch(error => context.cancelled ? failure(id, rpcCodes.requestCancelled, "Request cancelled.")
            : error instanceof RpcError ? failure(id, error.code, error.message, error.data) : failure(id, rpcCodes.internalError, "Internal error"))
            .finally(() => { if (this.#incoming.get(id) === entry) this.#incoming.delete(id); listeners.clear(); });
    }
    snapshot() { return Object.freeze({ disposed: this.#disposed, pendingRequests: this.#pending.size, incomingRequests: this.#incoming.size,
        requestHandlers: this.#requests.size, notificationHandlers: [...this.#notifications.values()].reduce((n, handlers) => n + handlers.size, 0) }); }
    dispose(reason: Error = closedConnection()): void {
        if (this.#disposed) return; this.#disposed = true; this.#release(this.#stopListening);
        for (const entry of this.#pending.values()) { this.#release(entry.stop); entry.reject(reason); } this.#pending.clear();
        for (const entry of this.#incoming.values()) entry.cancel(); this.#incoming.clear(); this.#requests.clear(); this.#notifications.clear();
        try { this.#transport.dispose(); } catch (error) { this.#report(error instanceof Error ? error : new Error("RPC transport disposal failed.")); }
        try { this.#options.onClose?.(reason); } catch (error) { this.#report(error instanceof Error ? error : new Error("RPC close listener failed.")); }
    }
}
