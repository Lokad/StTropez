import { isNonNegativeInteger } from "../core/bounds.ts";
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | Readonly<{ [key: string]: JsonValue }>;

export class RpcError extends Error {
    readonly code: number;
    readonly data: JsonValue | undefined;
    constructor(code: number, message: string, data?: JsonValue) {
        super(message); this.name = "RpcError"; this.code = code; this.data = data;
    }
}

/** Malformed or unsupported provider data; distinct from host validation and callbacks. */
export class ProtocolDecodeError extends Error {
    constructor(message: string) { super(message); this.name = "ProtocolDecodeError"; }
}

export const rpcCodes = Object.freeze({ parseError: -32700, invalidRequest: -32600, methodNotFound: -32601,
    invalidParams: -32602, internalError: -32603, serverNotInitialized: -32002, pendingLimit: -32000,
    timeout: -32098, closed: -32097, requestCancelled: -32800, contentModified: -32801 });
export const cancelledRequest = (message = "Request cancelled.") => new RpcError(rpcCodes.requestCancelled, message);
export const staleRequest = (message = "The captured request expired.") => new RpcError(rpcCodes.contentModified, message);
export function isStaleRequest(error: unknown): boolean {
    return error instanceof RpcError && (error.code === rpcCodes.contentModified || error.code === rpcCodes.requestCancelled);
}
export const closedConnection = (message = "RPC connection is closed.") => new RpcError(rpcCodes.closed, message);
export const wireLimits = Object.freeze({ timeoutMs: 15000, pendingRequests: 64, messageUnits: 4 * 1024 * 1024,
    jsonDepth: 64, snapshotNodes: 100000, batchMessages: 128, scopes: 128, registrations: 128,
    commandsPerRegistration: 128, synchronizationWaits: 128, handlers: 128, commandArgumentUnits: 8192,
    documentationPartUnits: 8192, hoverParts: 64, languageNameUnits: 128, signatureContextUnits: 131072, signatureParameters: 64,
    linkDataUnits: 8192, colorPresentations: 64, previewLabelUnits: 128, previewContextUnits: 128,
    documentIdentityUnits: 4096 });
export const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export const isLspUint = (value: unknown): value is number => isNonNegativeInteger(value) && value <= 0x7fffffff;
export const isLspInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= -0x80000000 && value <= 0x7fffffff;
export const isLspIdentityPart = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= wireLimits.documentIdentityUnits;
export const isLspUri = (value: unknown): value is string => isLspIdentityPart(value) && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value);

const snapshots = new WeakMap<object, boolean>();
/** Internal ownership proof for immutable syntax caches; it grants no snapshot-size exemption. */
export const isCapturedJson = (value: unknown): value is object => !!value && typeof value === "object" && snapshots.has(value);
function visitJson(root: unknown, remaining: number, parsed: boolean): boolean {
    let signedZeros = 0;
    function visit(value: unknown, depth: number): boolean {
        if (depth > wireLimits.jsonDepth || --remaining < 0) return false;
        if (typeof value === "number") {
            if (Object.is(value, -0)) signedZeros++;
            return Number.isFinite(value);
        }
        if (value === null || typeof value !== "object") {
            return value === null || typeof value === "string" || typeof value === "boolean";
        }
        const array = Array.isArray(value);
        if (!parsed && !array && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
        const keys = array ? undefined : Object.keys(value);
        const length = array ? value.length : keys!.length;
        if (length > remaining) return false;
        const beforeChildren = remaining;
        const beforeZeros = signedZeros;
        for (let i = 0; i < length; i++) {
            const key = keys ? keys[i]! : i;
            const child: unknown = parsed ? (value as Record<string, unknown>)[key]
                : Object.getOwnPropertyDescriptor(value, key)?.value;
            if (!visit(child, depth + 1)) return false;
        }
        if (parsed) {
            Object.freeze(value);
            // A detached JSON snapshot normalizes -0 and has its own subtree size limit.
            const nodes = 1 + beforeChildren - remaining;
            snapshots.set(value, signedZeros === beforeZeros && nodes <= wireLimits.snapshotNodes);
        }
        return true;
    }
    return visit(root, 0);
}
export function isJson(value: unknown, maxNodes: number = wireLimits.snapshotNodes): value is JsonValue {
    return visitJson(value, maxNodes, false);
}
/** The caller owns the fresh JSON.parse result, including any partially visited rejected value. */
export function freezeParsedJson(value: unknown, maxNodes: number = wireLimits.snapshotNodes): value is JsonValue {
    return visitJson(value, maxNodes, true);
}
/** Internal shared validation/capture for host-supplied session options. */
export function jsonSnapshot(value: unknown): JsonValue { return captureJson(value, false); }
/** Inbound opaque data uses the same bounded snapshot validation as host values. */
export function decodeJson(value: unknown): JsonValue { return captureJson(value, true); }
function captureJson(value: unknown, decoding: boolean): JsonValue {
    if (value && typeof value === "object" && snapshots.get(value) === true) return value as JsonValue;
    if (isJson(value)) {
        const copy: unknown = JSON.parse(JSON.stringify(value));
        if (freezeParsedJson(copy)) return copy;
    }
    throw decoding ? new ProtocolDecodeError("Expected bounded JSON values.") : new TypeError("Expected bounded JSON values.");
}
/** Structural comparison for captured JSON; property order has no protocol meaning. */
export function jsonEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((value, index) => jsonEqual(value, b[index]));
    return isRecord(a) && isRecord(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]));
}
