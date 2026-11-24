import { rpcCodes, cancelledRequest, staleRequest, closedConnection, RpcError } from "./wire.ts";
import type { Observable } from "../core/observable.ts";
import type { DocumentSnapshot } from "../core/workspace.ts";
import type { JsonValue } from "./wire.ts";
import type { LspCall, LspConnectContext, LspDocument, LspDocumentCapture, LspDocumentFeature, LspDocumentSnapshot } from "./lsp-session.ts";
import { sameDocument, type LspPrepare, type LspWorkspace, type LspWorkspaceScope, type LspWorkspaceSnapshot } from "./lsp-workspace.ts";
import { createLspTargets } from "./lsp-targets.ts";
import type { LspTargetContext } from "./lsp-targets.ts";

export type LspDocumentRequest = Readonly<{ document: DocumentSnapshot; prepare?: LspPrepare | undefined }>;
export type LspPositionRequest = LspDocumentRequest & Readonly<{ offset: number }>;
export type LspProjectRequest = LspDocumentRequest & Readonly<{ project?: readonly DocumentSnapshot[] }>;

export type LspClientDiagnostics = Readonly<{ connected: boolean; disposed: boolean;
    protocol: ReturnType<LspWorkspaceScope["snapshotOwnership"]> }>;
export type LspProjectClientDiagnostics = LspClientDiagnostics & Readonly<{ busy: boolean; version: "LSP3.17" }>;

type FeatureOptions = readonly Readonly<Record<string, JsonValue>>[];
type FeatureControls<Method extends LspDocumentFeature, Diagnostics extends LspClientDiagnostics = LspClientDiagnostics> =
    Observable<LspWorkspaceSnapshot> & Readonly<{
        snapshot: () => Diagnostics; isBusy: () => boolean; cancel: () => void; dispose: () => void;
        options: (document: DocumentSnapshot, method?: Method) => FeatureOptions;
    }>;
export type LspFeatureClient<Method extends LspDocumentFeature, Request, Result, Diagnostics extends LspClientDiagnostics = LspClientDiagnostics> =
    FeatureControls<Method, Diagnostics> & Readonly<{ run: (request: Request) => LspCall<Result> }>;

type Request = { generation: number; pending: number; cancelled: boolean; reject: (error: unknown) => void;
    cancellation: Promise<never>; cleanups: Set<() => void>; identities: ReadonlyMap<LspDocument, LspDocumentSnapshot> };
const cancelled = () => cancelledRequest("LSP feature request cancelled.");
const stale = () => staleRequest("Captured LSP documents changed.");

/** One feature scope, one latest intent. Decoding and mutation policy remain with the caller. */
export function createLspClient<Method extends LspDocumentFeature>(provider: LspWorkspace, ...methods: [Method, ...Method[]]) {
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
    const stop = scope.subscribe(notify);
    const release = () => {
        for (const document of documents.values()) document.dispose();
        documents = new Map();
    };
    const invalidate = (releaseDocuments: boolean, reason: unknown = cancelled()) => {
        const previous = latest;
        latest = undefined;
        generation++;
        if (previous) {
            previous.cancelled = true;
            previous.reject(reason);
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
    const wait = async <T>(request: Request, work: () => Promise<T>, interrupted?: () => boolean) => {
        guard(request);
        request.pending++;
        queueNotify();
        try { return await Promise.race([work(), request.cancellation]); }
        catch (error) {
            if (current(request) && !interrupted?.()) invalidate(true, error);
            throw error;
        }
        finally { request.pending--; if (current(request)) notify(); }
    };
    type Params = (capture: LspDocumentCapture) => Record<string, JsonValue>;
    async function receive(op: Request, { document, project, prepare }: LspProjectRequest, method: LspDocumentFeature,
        params: Params, wireMethod?: "completionItem/resolve" | "codeAction/resolve") {
        if (project && !sameDocument(project.find(snapshot => snapshot.id === document.id), document)) throw stale();
        documents = scope.setDocuments(project ?? [document]);
        op.identities = new Map([...documents.values()].map(document => [document, document.getSnapshot()]));
        const target = documents.get(document.id);
        if (!target) throw new Error("LSP source is outside the captured project.");
        const connection = scope.getSnapshot();
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
            captures = scope.captureProject(method); capture = value;
            return params(value);
        };
        const call = wireMethod ? (() => {
            if (!scope.canRequest(method, target)) throw new RpcError(rpcCodes.methodNotFound, "LSP feature unavailable.");
            const value = scope.synchronized(target, method); if (!value) throw stale();
            const body = captureParams(value); validate(op);
            return scope.request(wireMethod, body);
        })() : scope.requestDocument(method, target, (_index, _document, value) => captureParams(value));
        const response = await call.result;
        validate(op);
        const isGenerationCurrent = () => current(op) && scope.getSnapshot().phase === "ready"
            && scope.getSnapshot().epoch === capture!.epoch && scope.getSnapshot().registrationVersion(method) === capture!.registrationGeneration;
        const targets = createLspTargets(captures!, scope.resolveTarget, { source: capture!.document, isCurrent: isGenerationCurrent, reportError: scope.reportError,
            onCancel: listener => { op.cleanups.add(listener); return () => { op.cleanups.delete(listener); }; } });
        const isCurrent = targets.isCurrent;
        if (!isCurrent()) throw stale();
        return Object.freeze({ response, capture: capture!, captures: captures!, target, isCurrent, isGenerationCurrent, targetForUri: targets.get,
            resolveTargets: (uris: readonly string[], purpose: LspTargetContext["purpose"]) => wait(op, async () => {
                const stop = scope.subscribe(() => { if (!isCurrent()) void Promise.resolve().then(() => {
                    if (current(op) && !isCurrent()) { invalidate(true); notify(); }
                }); });
                try { await targets.resolve(uris, purpose); validate(op); if (!isCurrent()) throw stale(); }
                finally { stop(); }
            }),
            decode: <T>(read: () => T): T => {
                try { validate(op); if (!isCurrent()) throw stale(); return read(); }
                catch (error) {
                    if (current(op)) { invalidate(true, error); notify(); }
                    throw error;
                }
            },
            follow: (feature: LspDocumentFeature, wireMethod: string, values: JsonValue, prepareFollow?: LspPrepare, onCancel?: LspConnectContext["onCancel"]) => {
                let interrupted = false, next: LspCall<JsonValue> | undefined, unsubscribe: (() => void) | undefined;
                const check = () => {
                    if (interrupted) throw cancelled();
                    validate(op);
                    if (!isCurrent()) throw stale();
                };
                const send = async () => {
                    check();
                    if (prepareFollow) { await prepareFollow(scope); check(); }
                    if (!scope.canRequest(feature, target)) throw new RpcError(rpcCodes.methodNotFound, "LSP feature unavailable.");
                    const body = { ...values as Record<string, JsonValue> };
                    delete body.textDocument;
                    next = feature === wireMethod ? scope.requestDocument(feature, target, () => { check(); return body; }) : scope.request(wireMethod, values);
                    const result = await next.result;
                    check();
                    return result;
                };
                return wait(op, () => {
                    if (!onCancel) return send();
                    return new Promise<JsonValue>((resolve, reject) => {
                        unsubscribe = onCancel(() => { interrupted = true; reject(cancelled()); next?.cancel(); });
                        if (!interrupted) void send().then(resolve, reject);
                    });
                }, () => interrupted).finally(() => unsubscribe?.());
            } });
    }
    function request<T>(input: LspProjectRequest, method: LspDocumentFeature, params: Params,
        read: (response: Awaited<ReturnType<typeof receive>>) => T | Promise<T>, wireMethod?: "completionItem/resolve" | "codeAction/resolve"): LspCall<T> {
        if (disposed) throw new Error("LSP feature client is disposed.");
        invalidate(false);
        let reject!: (error: unknown) => void;
        const cancellation = new Promise<never>((_resolve, no) => { reject = no; });
        const op: Request = { generation, identities: new Map(), pending: 1, cancelled: false, cancellation, reject, cleanups: new Set() };
        latest = op;
        let finished = false;
        const work = receive(op, input, method, params, wireMethod).then(value => { guard(op); return read(value); });
        const result = Promise.race([work, cancellation]).catch(error => {
            if (current(op)) invalidate(true);
            throw error;
        }).finally(() => {
            finished = true; op.pending--;
            if (latest === op || !latest) notify();
        });
        queueNotify();
        // Completed calls may be released by a view without invalidating their published result.
        return Object.freeze({ result, cancel: () => {
            if (finished || op.cancelled) return;
            if (latest === op) invalidate(false);
            else { op.cancelled = true; op.reject(cancelled()); }
        } });
    }
    return Object.freeze({ methods, scope, request, notify, getSnapshot: scope.getSnapshot,
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
        snapshot: () => Object.freeze({ connected: scope.getSnapshot().phase === "ready", disposed, protocol: scope.snapshotOwnership() }),
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
            scope.dispose();
            listeners.clear();
        } });
}

/** Common public controls over the existing request owner; feature state stays with its client. */
export function lspFeatureHandle<Method extends LspDocumentFeature>(client: Omit<FeatureControls<Method>, "options"> & Readonly<{
    methods: readonly [Method, ...Method[]]; options: (document: DocumentSnapshot, method: Method) => FeatureOptions;
}>, controls: Partial<Pick<FeatureControls<Method>, "isBusy" | "cancel" | "dispose">> = {}): FeatureControls<Method> {
    return Object.freeze({ getSnapshot: client.getSnapshot, subscribe: client.subscribe, snapshot: client.snapshot,
        isBusy: controls.isBusy ?? client.isBusy, cancel: controls.cancel ?? client.cancel, dispose: controls.dispose ?? client.dispose,
        options: (document: DocumentSnapshot, method: Method = client.methods[0]) => {
            if (!client.methods.includes(method)) throw new TypeError("Method is outside this LSP feature client.");
            return client.options(document, method);
        } });
}
