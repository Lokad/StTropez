export type JsonValue = null | boolean | number | string | readonly JsonValue[] | Readonly<{ [key: string]: JsonValue }>;
export type RpcId = string | number | null;
export type RpcTransport = Readonly<{
    send: (message: string) => void;
    subscribe: (listener: Readonly<{ message: (message: string) => void; close: (reason: Error) => void }>) => () => void;
    dispose: () => void;
}>;
/** Hosts supply scheduling; this module imports no platform, networking or storage APIs. */
export type RpcScheduler = (delayMs: number, callback: () => void) => () => void;
export type RpcOptions = Readonly<{ schedule: RpcScheduler; timeoutMs?: number; maxPending?: number; maxMessageUnits?: number;
    onError?: (error: Error) => void; onClose?: (error: Error) => void }>;
export type RpcCall<T> = Readonly<{ id: number; result: Promise<T>; cancel: () => void }>;
export type RpcRequestContext = Readonly<{ id: RpcId; cancelled: boolean; onCancel: (listener: () => void) => () => void }>;
type RequestHandler = (params: unknown, context: RpcRequestContext) => unknown | Promise<unknown>;
type NotificationHandler = (params: unknown) => void | Promise<void>;
type Message = Record<string, unknown>;
type Pending = { resolve: (value: JsonValue) => void; reject: (error: Error) => void; stop: () => void };
type Incoming = { context: RpcRequestContext; cancel: () => void };

export class RpcError extends Error {
    readonly code: number;
    readonly data: JsonValue | undefined;
    constructor(code: number, message: string, data?: JsonValue) {
        super(message); this.name = "RpcError"; this.code = code; this.data = data;
    }
}
const object = (value: unknown): value is Message => value !== null && typeof value === "object" && !Array.isArray(value);
const has = (value: Message, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const idValue = (value: unknown): value is RpcId => value === null || typeof value === "string" || typeof value === "number" && Number.isSafeInteger(value);
function json(value: unknown, depth = 0, budget = { left: 100000 }): value is JsonValue {
    if (depth > 64 || --budget.left < 0) return false;
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) if (!json(value[i], depth + 1, budget)) return false; return true; }
    if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    const keys = Object.keys(value); if (keys.length > budget.left) return false;
    return keys.every(key => { const d = Object.getOwnPropertyDescriptor(value, key)!; return "value" in d && json(d.value, depth + 1, budget); });
}
function immutable(value: JsonValue): JsonValue {
    if (value && typeof value === "object") { Object.values(value).forEach(immutable); Object.freeze(value); } return value;
}
/** Internal shared validation/capture for host-supplied session options. */
export function jsonSnapshot(value: unknown): JsonValue {
    if (!json(value)) throw new TypeError("Expected bounded JSON values.");
    return immutable(JSON.parse(JSON.stringify(value)) as JsonValue);
}
/** Structural comparison for captured JSON; property order has no protocol meaning. */
export function jsonEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((value, index) => jsonEqual(value, b[index]));
    return object(a) && object(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]));
}
function methodName(method: string): void {
    if (!method || method.startsWith("rpc.")) throw new TypeError("Invalid application RPC method.");
}
const failure = (id: RpcId, code: number, message: string, data?: JsonValue) => ({ jsonrpc: "2.0", id,
    error: { code, message, ...(data === undefined ? {} : { data }) } });

/** Bidirectional JSON-RPC 2.0 over an ordered, message-delimited host transport. */
export class JsonRpcConnection {
    private readonly transport: RpcTransport;
    private readonly options: RpcOptions;
    private readonly timeoutMs: number;
    private readonly maxPending: number;
    private readonly maxMessageUnits: number;
    private readonly pending = new Map<number, Pending>();
    private readonly incoming = new Map<RpcId, Incoming>();
    private readonly requests = new Map<string, RequestHandler>();
    private readonly notifications = new Map<string, Set<NotificationHandler>>();
    private stopListening: () => void = () => {};
    private serial = 0;
    private disposed = false;

    constructor(transport: RpcTransport, options: RpcOptions) {
        this.transport = transport; this.options = options;
        this.timeoutMs = options.timeoutMs ?? 15000; this.maxPending = options.maxPending ?? 64; this.maxMessageUnits = options.maxMessageUnits ?? 4 * 1024 * 1024;
        if (![this.timeoutMs, this.maxPending, this.maxMessageUnits].every(v => Number.isSafeInteger(v) && v > 0)) throw new RangeError("Invalid RPC limits.");
        this.stopListening = transport.subscribe({ message: message => this.receive(message), close: reason => this.dispose(reason) });
        if (this.disposed) this.stopListening();
    }
    private report(error: Error): void { try { this.options.onError?.(error); } catch { /* Host diagnostics cannot interrupt protocol cleanup. */ } }
    private release(stop: () => void): void { try { stop(); } catch (error) { this.report(error instanceof Error ? error : new Error("RPC cleanup failed.")); } }
    private encode(value: unknown): string {
        if (!json(value)) throw new TypeError("RPC messages must contain bounded JSON values.");
        const encoded = JSON.stringify(value); if (encoded.length > this.maxMessageUnits) throw new RangeError("RPC message exceeds the configured limit."); return encoded;
    }
    private emit(value: unknown): boolean {
        if (this.disposed) return false;
        try { return this.send(this.encode(value)); }
        catch (error) { this.dispose(error instanceof Error ? error : new Error("RPC encoding failed.")); return false; }
    }
    private send(text: string): boolean {
        if (this.disposed) return false;
        try { this.transport.send(text); return true; }
        catch (error) { this.dispose(error instanceof Error ? error : new Error("RPC transport failed.")); return false; }
    }
    request<T = JsonValue>(method: string, params?: unknown, timeoutMs = this.timeoutMs): RpcCall<T> {
        methodName(method);
        if (this.disposed) throw new RpcError(-32097, "RPC connection is closed.");
        if (this.pending.size >= this.maxPending) throw new RpcError(-32000, "Too many pending RPC requests.");
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new RangeError("Invalid RPC deadline.");
        const id = ++this.serial, message = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
        if (params !== undefined && !object(params) && !Array.isArray(params)) throw new TypeError("RPC parameters must be structured.");
        const encoded = this.encode(message);
        let resolve!: (value: JsonValue) => void, reject!: (error: Error) => void;
        const result = new Promise<JsonValue>((yes, no) => { resolve = yes; reject = no; });
        const entry: Pending = { resolve, reject, stop: () => {} }; this.pending.set(id, entry);
        const cancel = (error: RpcError) => {
            if (this.pending.get(id) !== entry) return; this.pending.delete(id); this.release(entry.stop); reject(error);
            this.emit({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } });
        };
        try { entry.stop = this.options.schedule(timeoutMs, () => cancel(new RpcError(-32098, "RPC request timed out."))); }
        catch (error) { this.pending.delete(id); reject(error instanceof Error ? error : new Error("RPC scheduling failed.")); }
        if (this.pending.get(id) === entry) this.send(encoded); else this.release(entry.stop);
        return Object.freeze({ id, result: result as Promise<T>, cancel: () => cancel(new RpcError(-32800, "Request cancelled.")) });
    }
    notify(method: string, params?: unknown): void {
        methodName(method); if (this.disposed) throw new RpcError(-32097, "RPC connection is closed.");
        if (params !== undefined && !object(params) && !Array.isArray(params)) throw new TypeError("RPC parameters must be structured.");
        const message = { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) };
        if (!this.send(this.encode(message))) throw new RpcError(-32097, "RPC transport is closed.");
    }
    onRequest(method: string, handler: RequestHandler): () => void {
        methodName(method); if (this.disposed || this.requests.has(method)) throw new Error("RPC request handler is unavailable.");
        this.requests.set(method, handler); return () => { if (this.requests.get(method) === handler) this.requests.delete(method); };
    }
    onNotification(method: string, handler: NotificationHandler): () => void {
        methodName(method); if (this.disposed) throw new Error("RPC connection is closed.");
        let handlers = this.notifications.get(method); if (!handlers) { handlers = new Set(); this.notifications.set(method, handlers); }
        handlers.add(handler); return () => { handlers.delete(handler); if (!handlers.size) this.notifications.delete(method); };
    }
    private receive(text: string): void {
        if (this.disposed) return;
        if (typeof text !== "string" || text.length > this.maxMessageUnits) { this.dispose(new RpcError(-32600, "RPC message exceeds the configured limit.")); return; }
        let value: unknown;
        try { value = JSON.parse(text); } catch { this.emit(failure(null, -32700, "Parse error")); return; }
        if (!json(value)) { this.emit(failure(null, -32600, "Invalid Request")); return; }
        immutable(value);
        if (Array.isArray(value)) {
            if (!value.length || value.length > 128) { this.emit(failure(null, -32600, "Invalid Request")); return; }
            void Promise.all(value.map(message => this.dispatch(message))).then(replies => {
                const responses = replies.filter(reply => reply !== undefined); if (responses.length) this.emit(responses);
            }).catch(error => this.dispose(error instanceof Error ? error : new Error("RPC batch failed.")));
        } else void Promise.resolve(this.dispatch(value)).then(reply => { if (reply !== undefined) this.emit(reply); })
            .catch(error => this.dispose(error instanceof Error ? error : new Error("RPC dispatch failed.")));
    }
    private dispatch(value: unknown): unknown | Promise<unknown> {
        if (this.disposed) return;
        if (!object(value) || value.jsonrpc !== "2.0") return failure(null, -32600, "Invalid Request");
        if (!has(value, "method")) {
            if (!has(value, "id") || !idValue(value.id) || has(value, "result") === has(value, "error") || has(value, "params")) {
                this.dispose(new RpcError(-32600, "Invalid RPC response.")); return;
            }
            if (has(value, "error") && (!object(value.error) || !Number.isSafeInteger(value.error.code) || typeof value.error.message !== "string")) {
                this.dispose(new RpcError(-32600, "Invalid RPC error response.")); return;
            }
            const entry = typeof value.id === "number" ? this.pending.get(value.id) : undefined;
            if (!entry) return; // Late cancelled/expired responses cannot complete another request.
            this.pending.delete(value.id as number); this.release(entry.stop);
            if (has(value, "error")) { const error = value.error as Message; entry.reject(new RpcError(error.code as number, error.message as string, error.data as JsonValue | undefined)); }
            else entry.resolve(value.result as JsonValue);
            return;
        }
        if (typeof value.method !== "string" || !value.method || has(value, "result") || has(value, "error") || has(value, "id") && !idValue(value.id)) return failure(null, -32600, "Invalid Request");
        const id = has(value, "id") ? value.id as RpcId : undefined;
        if (has(value, "params") && !object(value.params) && !Array.isArray(value.params)) return id === undefined ? undefined : failure(id, -32602, "Invalid params");
        if (id === undefined) {
            if (value.method === "$/cancelRequest" && object(value.params) && idValue(value.params.id)) this.incoming.get(value.params.id)?.cancel();
            for (const handler of [...this.notifications.get(value.method) ?? []]) {
                if (this.disposed) break;
                try { void Promise.resolve(handler(value.params)).catch(error => this.report(error instanceof Error ? error : new Error("RPC notification failed."))); }
                catch (error) { this.report(error instanceof Error ? error : new Error("RPC notification failed.")); }
            }
            return;
        }
        const handler = this.requests.get(value.method); if (!handler) return failure(id, -32601, "Method not found");
        if (this.incoming.has(id)) { this.dispose(new RpcError(-32600, "Duplicate in-flight RPC identifier.")); return; }
        if (this.incoming.size >= this.maxPending) return failure(id, -32000, "Too many incoming RPC requests.");
        let cancelled = false; const listeners = new Set<() => void>();
        const context = Object.freeze({ id, get cancelled() { return cancelled; }, onCancel: (listener: () => void) => {
            if (cancelled) listener(); else listeners.add(listener); return () => { listeners.delete(listener); };
        } });
        const entry: Incoming = { context, cancel: () => { if (cancelled) return; cancelled = true;
            for (const listener of [...listeners]) { try { listener(); } catch (error) { this.report(error instanceof Error ? error : new Error("RPC cancellation failed.")); } } listeners.clear(); } };
        this.incoming.set(id, entry);
        return Promise.resolve().then(() => {
            if (this.disposed || context.cancelled) throw new RpcError(-32800, "Request cancelled."); return handler(value.params, context);
        }).then(result => {
            if (context.cancelled) throw new RpcError(-32800, "Request cancelled.");
            const reply = { jsonrpc: "2.0", id, result: result === undefined ? null : result }; this.encode(reply); return reply;
        }).catch(error => context.cancelled ? failure(id, -32800, "Request cancelled.")
            : error instanceof RpcError ? failure(id, error.code, error.message, error.data) : failure(id, -32603, "Internal error"))
            .finally(() => { if (this.incoming.get(id) === entry) this.incoming.delete(id); listeners.clear(); });
    }
    snapshot() { return Object.freeze({ disposed: this.disposed, pendingRequests: this.pending.size, incomingRequests: this.incoming.size,
        requestHandlers: this.requests.size, notificationHandlers: [...this.notifications.values()].reduce((n, handlers) => n + handlers.size, 0) }); }
    dispose(reason: Error = new RpcError(-32097, "RPC connection is closed.")): void {
        if (this.disposed) return; this.disposed = true; this.release(this.stopListening);
        for (const entry of this.pending.values()) { this.release(entry.stop); entry.reject(reason); } this.pending.clear();
        for (const entry of this.incoming.values()) entry.cancel(); this.incoming.clear(); this.requests.clear(); this.notifications.clear();
        try { this.transport.dispose(); } catch (error) { this.report(error instanceof Error ? error : new Error("RPC transport disposal failed.")); }
        try { this.options.onClose?.(reason); } catch (error) { this.report(error instanceof Error ? error : new Error("RPC close listener failed.")); }
    }
}
