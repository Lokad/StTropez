import type { TextBuffer } from "../../src/index.ts";
import { navigationLimits, validateNavigationResult } from "../probes/navigation.ts";
import type { NavigationInput, NavigationResult } from "../probes/navigation.ts";
import { projectProtocolVersion } from "../probes/project.ts";
import { ProjectChangeCursor } from "./project-change.ts";
export type NavigationMetrics = { created: number; posted: number; received: number; transferred: number; maxChunk: number; completed: number; failed: number; terminated: number;
    opened: number; changed: number; closed: number; reused: number; snapshotUnits: number; deltaUnits: number; planningTurns: number; rejected: number };
export type SyncFault = "version" | "epoch" | "sequence" | "revision";
type Reply = Readonly<Record<string, unknown>>;
type Cached = { revision: number; buffer: TextBuffer };
let connectionSerial = 0;
/** Acknowledged snapshots/changes synchronize a persistent local worker before each query. */
export function createNavigationClient(clock: Pick<Window, "setTimeout" | "clearTimeout">, counts: NavigationMetrics,
    createWorker = () => new Worker("/provider-worker.js", { type: "module" }), changed: () => void = () => {}) {
    let worker: Worker | undefined, disposed = false, connected = false, epoch = 0, sequence = 0, busy = false;
    let pending: { sequence: number; resolve: (reply: Reply) => void; reject: (error: Error) => void; timer: number } | undefined;
    const cache = new Map<string, Cached>(), listeners = new AbortController();
    let pause: { timer: number; reject: (error: Error) => void } | undefined;
    const close = () => { connected = false; listeners.abort(); if (worker) { worker.terminate(); counts.terminated++; worker = undefined; } cache.clear(); changed(); };
    const fail = (error: Error) => { const active = pending; pending = undefined; if (active) { clock.clearTimeout(active.timer); active.reject(error); }
        if (pause) { clock.clearTimeout(pause.timer); pause.reject(error); pause = undefined; } close(); };
    const exchange = (operation: string, fields: Reply = {}, fault?: SyncFault): Promise<Reply> => new Promise((resolve, reject) => {
        if (disposed || !worker || pending) { reject(new Error("Navigation request is unavailable.")); return; }
        const sent = ++sequence; pending = { sequence: sent, resolve, reject, timer: clock.setTimeout(() => fail(new Error("Navigation provider timed out.")), 5000) };
        try { counts.posted++; worker.postMessage(JSON.stringify({ ...fields, operation, version: fault === "version" ? 99 : projectProtocolVersion,
            epoch: fault === "epoch" ? epoch + 1 : epoch, sequence: fault === "sequence" ? sent + 1 : sent })); }
        catch { fail(new Error("Navigation worker is unavailable.")); }
    });
    const connect = async () => {
        if (connected) return;
        if (disposed || listeners.signal.aborted) throw new Error("Navigation connection is closed.");
        worker = createWorker(); counts.created++; epoch = ++connectionSerial;
        worker.addEventListener("error", event => { event.preventDefault(); fail(new Error("Navigation provider failed; editing remains available.")); }, { signal: listeners.signal });
        worker.addEventListener("messageerror", () => fail(new Error("Navigation response could not be decoded.")), { signal: listeners.signal });
        worker.addEventListener("message", (event: MessageEvent<unknown>) => {
            counts.received++; let value: unknown;
            try { if (typeof event.data !== "string" || event.data.length > navigationLimits.responseUnits) throw new Error(); value = JSON.parse(event.data); }
            catch { fail(new Error("Malformed navigation response.")); return; }
            if (!value || typeof value !== "object" || !("version" in value) || value.version !== projectProtocolVersion || !("epoch" in value) || value.epoch !== epoch
                || !("sequence" in value) || value.sequence !== pending?.sequence || !("operation" in value) || typeof value.operation !== "string" || !pending) { counts.rejected++; fail(new Error("Invalid versioned navigation acknowledgement.")); return; }
            if (value.operation === "project-error") { counts.rejected++; fail(new Error("Navigation provider rejected the captured protocol state.")); return; }
            const active = pending; pending = undefined; clock.clearTimeout(active.timer); active.resolve(value as Reply);
        }, { signal: listeners.signal });
        const reply = await exchange("project-hello"); if (reply.operation !== "project-ack" || reply.action !== "hello") throw new Error("Invalid provider initialization."); connected = true; changed();
    };
    const ack = (reply: Reply, action: string, document: string, revision: number, length: number, received: number) => {
        if (reply.operation !== "project-ack" || reply.action !== action || reply.document !== document || reply.revision !== revision || reply.length !== length || reply.received !== received) throw new Error("Invalid captured document acknowledgement.");
    };
    const yieldPlanning = () => new Promise<void>((resolve, reject) => { pause = { reject, timer: clock.setTimeout(() => { pause = undefined; resolve(); }, 0) }; });
    const run = async (input: NavigationInput, buffers: ReadonlyMap<string, TextBuffer>, progress: (units: number) => void, fault?: SyncFault): Promise<NavigationResult> => {
        if (busy || disposed) throw new Error("Navigation lane is unavailable."); busy = true;
        try {
            await connect(); const requested = new Set(input.documents.map(doc => doc.document));
            for (const [document, old] of cache) if (!requested.has(document)) { ack(await exchange("project-close", { document, revision: old.revision }), "close", document, old.revision, 0, 0); cache.delete(document); counts.closed++; }
            for (const doc of input.documents) {
                const buffer = buffers.get(doc.document), old = cache.get(doc.document); if (!buffer || buffer.length !== doc.length) throw new Error("Missing captured source.");
                if (old?.revision === doc.revision) { if (old.buffer !== buffer) throw new Error("A provider revision cannot change its buffer."); counts.reused++; continue; }
                let from = 0, to = old?.buffer.length ?? 0, insertFrom = 0, insertTo = buffer.length;
                if (old) {
                    if (doc.revision <= old.revision) throw new Error("Provider document versions must increase.");
                    const cursor = new ProjectChangeCursor(old.buffer, buffer);
                    try { for (;;) { const step = cursor.next(); counts.planningTurns++; if (step.done) { ({ from, to, insertFrom, insertTo } = step.result!); break; } await yieldPlanning(); } } finally { cursor.dispose(); }
                }
                const units = insertTo - insertFrom;
                ack(await exchange(old ? "project-change" : "project-open", { document: doc.document, revision: doc.revision, length: doc.length,
                    ...(old ? { previousRevision: fault === "revision" ? old.revision - 1 : old.revision, from, to, units } : {}) }, fault === "revision" ? undefined : fault), old ? "change" : "open", doc.document, doc.revision, doc.length, 0);
                if (fault && fault !== "revision") fault = undefined;
                for (let received = 0; received < units;) {
                    const text = buffer.slice(insertFrom + received, Math.min(insertTo, insertFrom + received + navigationLimits.chunkUnits));
                    const reply = await exchange("project-chunk", { document: doc.document, revision: doc.revision, from: received, text });
                    received += text.length; counts.transferred += text.length; counts.maxChunk = Math.max(counts.maxChunk, text.length); if (old) counts.deltaUnits += text.length; else counts.snapshotUnits += text.length;
                    ack(reply, "chunk", doc.document, doc.revision, doc.length, received);
                }
                ack(await exchange("project-commit", { document: doc.document, revision: doc.revision }), "commit", doc.document, doc.revision, doc.length, units);
                cache.set(doc.document, { revision: doc.revision, buffer }); if (old) counts.changed++; else counts.opened++; changed();
            }
            let queryInput = input;
            if (fault === "revision") { queryInput = { ...input, documents: input.documents.map((doc, i) => i ? doc : { ...doc, revision: doc.revision + 1 }) }; fault = undefined; }
            let reply = await exchange("project-query", { input: queryInput }, fault), work = 0;
            const total = input.documents.reduce((sum, doc) => sum + doc.length, 0);
            for (;;) {
                if (reply.request !== input.id) throw new Error("Invalid captured query identity.");
                if (reply.operation === "project-query-result") { const result = validateNavigationResult(reply.result, input, buffers); if (work !== total) throw new Error("Incomplete provider scan."); counts.completed++; return result; }
                if (reply.operation !== "project-query-progress" || typeof reply.work !== "number" || !Number.isSafeInteger(reply.work) || reply.work < work || reply.work > total) throw new Error("Invalid query progress.");
                work = reply.work; progress(work); reply = await exchange("project-query-next", { request: input.id });
            }
        } catch (error) { if (!disposed) counts.failed++; fail(error instanceof Error ? error : new Error("Navigation request failed.")); throw error; } finally { busy = false; }
    };
    return Object.freeze({ run, snapshot: () => Object.freeze({ connected, busy, disposed, version: projectProtocolVersion, epoch, sequence,
        documents: Object.freeze([...cache].map(([document, doc]) => Object.freeze({ document, revision: doc.revision, length: doc.buffer.length }))) }),
        dispose: () => { if (disposed) return; disposed = true; fail(new Error("Navigation request cancelled.")); } });
}
