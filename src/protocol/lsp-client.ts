import { rpcCodes, cancelledRequest, staleRequest, closedConnection, RpcError } from "./wire.ts";
import type { DocumentId, DocumentSnapshot } from "../core/workspace.ts";
import type { JsonValue } from "./wire.ts";
import type { LspDocument, LspDocumentCapture, LspDocumentFeature, LspDocumentSnapshot } from "./lsp-session.ts";
import type { LspPrepare, LspWorkspace } from "./lsp-workspace.ts";
import { createLspTargets } from "./lsp-targets.ts";
import type { LspTargetContext } from "./lsp-targets.ts";

type Request = { generation: number; pending: number; cancelled: boolean; reject: (error: Error) => void;
    cancellation: Promise<never>; cleanups: Set<() => void>; identities: ReadonlyMap<LspDocument, LspDocumentSnapshot> };
const cancelled = () => cancelledRequest("LSP feature request cancelled.");
const stale = () => staleRequest("Captured LSP documents changed.");

/** One feature scope, one latest intent. Decoding and mutation policy remain with the caller. */
export function createLspClient(provider: LspWorkspace) {
    const scope = provider.createScope(), listeners = new Set<() => void>();
    let disposed = false, generation = 0, latest: Request | undefined, notificationQueued = false;
    let documents: ReadonlyMap<string, LspDocument> = new Map();
    const notify = () => {
        notificationQueued = false;
        for (const listener of [...listeners]) {
            try { listener(); } catch { /* An observer cannot change the completed operation. */ }
        }
    };
    // Publish only after the call and its rejection handlers exist. A listener may cancel
    // or replace the intent; an already-delivered state change absorbs the queued update.
    const queueNotify = () => {
        if (disposed || notificationQueued) return;
        notificationQueued = true;
        void Promise.resolve().then(() => { if (!disposed && notificationQueued) notify(); });
    };
    const stop = scope.state.subscribe(notify);
    const release = () => {
        for (const document of documents.values()) document.close();
        documents = new Map();
    };
    const invalidate = (releaseDocuments: boolean) => {
        const previous = latest;
        latest = undefined;
        generation++;
        if (previous) {
            previous.cancelled = true;
            previous.reject(cancelled());
            for (const cleanup of [...previous.cleanups]) cleanup(); previous.cleanups.clear();
        }
        scope.cancel();
        if (releaseDocuments) release();
    };
    const current = (request: Request) => !disposed && latest === request && !request.cancelled && request.generation === generation;
    const guard = (request: Request) => { if (!current(request)) throw cancelled(); };
    const validate = (request: Request) => {
        guard(request);
        // Validation must not rebind a captured project or miss unflushed Workspace edits.
        for (const [document, snapshot] of request.identities) if (!scope.isDocumentCurrent(document, snapshot)) throw stale();
    };
    const wait = async <T>(request: Request, work: () => Promise<T>) => {
        guard(request);
        request.pending++;
        queueNotify();
        try { return await Promise.race([work(), request.cancellation]); }
        catch (error) {
            if (current(request)) invalidate(true);
            throw error;
        }
        finally { request.pending--; if (current(request)) notify(); }
    };
    const request = (snapshots: readonly DocumentSnapshot[], origin: DocumentId, method: LspDocumentFeature,
        params: (capture: LspDocumentCapture) => Record<string, JsonValue>, prepare?: LspPrepare, wireMethod?: "completionItem/resolve") => {
        if (disposed) throw new Error("LSP feature client is disposed.");
        invalidate(false);
        let reject!: (error: Error) => void;
        const cancellation = new Promise<never>((_resolve, no) => { reject = no; });
        const op: Request = { generation, identities: new Map(), pending: 1, cancelled: false, cancellation, reject, cleanups: new Set() };
        latest = op;
        const work = (async () => {
            documents = scope.setDocuments(snapshots);
            op.identities = new Map([...documents.values()].map(document => [document, document.getSnapshot()]));
            const target = documents.get(origin);
            if (!target) throw new Error("LSP source is outside the captured project.");
            const connection = scope.state.getSnapshot();
            if (connection.phase === "disconnected" && connection.epoch !== 0) throw closedConnection("LSP connection requires an explicit host connect or reconnect.");
            await scope.ensureConnected();
            validate(op);
            await scope.flush([...documents.values()]);
            validate(op);
            if (prepare) await prepare(scope);
            validate(op);
            let capture: LspDocumentCapture | undefined, captures: ReadonlyMap<string, LspDocumentCapture> | undefined;
            const captureParams = (value: LspDocumentCapture) => {
                validate(op);
                captures = scope.captureProject(); capture = value;
                return params(value);
            };
            const call = wireMethod ? (() => {
                if (!scope.canRequest(method, target)) throw new RpcError(rpcCodes.methodNotFound, "LSP feature unavailable.");
                const value = scope.synchronized(target); if (!value) throw stale();
                const body = captureParams(value); validate(op);
                return scope.request(wireMethod, body);
            })() : scope.requestDocument(method, target, (_index, _document, value) => captureParams(value));
            const response = await call.result;
            validate(op);
            const isGenerationCurrent = () => current(op) && scope.state.getSnapshot().phase === "ready"
                && scope.state.getSnapshot().epoch === capture!.epoch && scope.state.getSnapshot().registrationGeneration === capture!.registrationGeneration;
            const targets = createLspTargets(captures!, scope.resolveTarget, { source: capture!.document, isCurrent: isGenerationCurrent, reportError: scope.reportError,
                onCancel: listener => { op.cleanups.add(listener); return () => { op.cleanups.delete(listener); }; } });
            const isCurrent = targets.isCurrent;
            if (!isCurrent()) throw stale();
            return Object.freeze({ response, capture: capture!, captures: captures!, target, isCurrent, isGenerationCurrent, targetForUri: targets.get,
                resolveTargets: (uris: readonly string[], purpose: LspTargetContext["purpose"]) => wait(op, async () => {
                    const stop = scope.state.subscribe(() => { if (!isCurrent()) void Promise.resolve().then(() => {
                        if (current(op) && !isCurrent()) { invalidate(true); notify(); }
                    }); });
                    try { await targets.resolve(uris, purpose); validate(op); if (!isCurrent()) throw stale(); }
                    finally { stop(); }
                }),
                decode: <T>(read: () => T): T => {
                    try { validate(op); if (!isCurrent()) throw stale(); return read(); }
                    catch (error) {
                        if (current(op)) { invalidate(true); notify(); }
                        throw error;
                    }
                },
                follow: (feature: LspDocumentFeature, wireMethod: string, values: JsonValue, prepareFollow?: LspPrepare) => wait(op, async () => {
                    if (!isCurrent()) throw stale();
                    if (prepareFollow) await prepareFollow(scope);
                    validate(op);
                    if (!isCurrent()) throw stale();
                    if (!scope.canRequest(feature, target)) throw new RpcError(rpcCodes.methodNotFound, "LSP feature unavailable.");
                    const body = { ...values as Record<string, JsonValue> };
                    delete body.textDocument;
                    const next = feature === wireMethod ? scope.requestDocument(feature, target, () => { validate(op); return body; }) : scope.request(wireMethod, values);
                    const result = await next.result;
                    validate(op);
                    if (!isCurrent()) throw stale();
                    return result;
                }) });
        })();
        const result = Promise.race([work, cancellation]).catch(error => {
            if (current(op)) invalidate(true);
            throw error;
        }).finally(() => {
            op.pending--;
            if (latest === op || !latest) notify();
        });
        queueNotify();
        // Completed calls may be released by a view without invalidating their published result.
        return Object.freeze({ result, cancel: () => {
            if (op.pending < 1 || op.cancelled) return;
            if (latest === op) invalidate(false);
            else { op.cancelled = true; op.reject(cancelled()); }
        } });
    };
    return Object.freeze({ scope, request, notify, state: provider.state,
        subscribe: (listener: () => void) => {
            if (disposed) throw new Error("LSP feature client is disposed.");
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        options: (document: DocumentSnapshot, method: LspDocumentFeature) => {
            if (disposed) throw new Error("LSP feature client is disposed.");
            return provider.queryFeatureOptions(method, document);
        },
        isBusy: () => (latest?.pending ?? 0) > 0,
        snapshot: () => Object.freeze({ connected: scope.state.getSnapshot().phase === "ready", disposed, protocol: scope.snapshotOwnership() }),
        inspection: () => Object.freeze({ sequence: generation, documents: Object.freeze([...documents.values()].flatMap(document => {
                const capture = scope.synchronized(document);
                return capture ? [Object.freeze({ document: capture.document.documentId, revision: capture.document.revision, length: capture.document.buffer.length })] : [];
            })) }),
        cancel: () => { if (!disposed) { invalidate(false); notify(); } },
        dispose: () => {
            if (disposed) return;
            disposed = true;
            invalidate(true);
            stop();
            scope.release();
            listeners.clear();
        } });
}

/** Common public controls over the existing request owner; feature state stays with its client. */
export function lspFeatureHandle<Method extends LspDocumentFeature>(client: ReturnType<typeof createLspClient>,
    methods: readonly [Method, ...Method[]], controls: Partial<Pick<ReturnType<typeof createLspClient>, "isBusy" | "cancel" | "dispose">> = {}) {
    return Object.freeze({ state: client.state, subscribe: client.subscribe, snapshot: client.snapshot,
        isBusy: controls.isBusy ?? client.isBusy, cancel: controls.cancel ?? client.cancel, dispose: controls.dispose ?? client.dispose,
        options: (document: DocumentSnapshot, method: Method = methods[0]) => {
            if (!methods.includes(method)) throw new TypeError("Method is outside this LSP feature client.");
            return client.options(document, method);
        } });
}
