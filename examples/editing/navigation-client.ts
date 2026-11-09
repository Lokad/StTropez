import type { TextBuffer } from "../../src/index.ts";
import { navigationLimits, validateNavigationResult } from "../probes/navigation.ts";
import type { NavigationInput, NavigationResult } from "../probes/navigation.ts";

export type NavigationMetrics = { created: number; posted: number; received: number; transferred: number; maxChunk: number; completed: number; failed: number; terminated: number };
type Reply = Readonly<Record<string, unknown>>;
/** Host worker lane with backpressure. No complete export, mirror, or local fallback. */
export function createNavigationClient(clock: Pick<Window, "setTimeout" | "clearTimeout">, counts: NavigationMetrics, createWorker = () => new Worker("/provider-worker.js", { type: "module" })) {
    let worker: Worker | undefined, done = false, cancelled = false, pending: { resolve: (reply: Reply) => void; reject: (error: Error) => void; timer: number } | undefined;
    const listeners = new AbortController();
    const close = () => { done = true; listeners.abort(); if (worker) { worker.terminate(); counts.terminated++; worker = undefined; } };
    const fail = (error: Error) => { const active = pending; pending = undefined; if (active) { clock.clearTimeout(active.timer); active.reject(error); } close(); };
    const run = async (input: NavigationInput, buffers: ReadonlyMap<string, TextBuffer>, progress: (units: number) => void): Promise<NavigationResult> => {
        if (done || worker) throw new Error("Navigation lane is unavailable.");
        try {
            worker = createWorker(); counts.created++;
            worker.addEventListener("error", event => { event.preventDefault(); fail(new Error("Navigation provider failed; editing remains available.")); }, { signal: listeners.signal });
            worker.addEventListener("messageerror", () => fail(new Error("Navigation response could not be decoded.")), { signal: listeners.signal });
            worker.addEventListener("message", (event: MessageEvent<unknown>) => {
                counts.received++; let value: unknown;
                try { if (typeof event.data !== "string" || event.data.length > navigationLimits.responseUnits) throw new Error(); value = JSON.parse(event.data); }
                catch { fail(new Error("Malformed navigation response.")); return; }
                if (!value || typeof value !== "object" || !("id" in value) || value.id !== input.id || !("operation" in value) || typeof value.operation !== "string" || !pending) { fail(new Error("Invalid navigation acknowledgement.")); return; }
                if (value.operation === "navigation-error") { fail(new Error("Navigation provider rejected the capture.")); return; }
                const active = pending; pending = undefined; clock.clearTimeout(active.timer); active.resolve(value as Reply);
            }, { signal: listeners.signal });
            const exchange = (message: Readonly<Record<string, unknown>>): Promise<Reply> => new Promise((resolve, reject) => {
                if (done || pending) { reject(new Error("Navigation request cancelled.")); return; }
                pending = { resolve, reject, timer: clock.setTimeout(() => fail(new Error("Navigation provider timed out.")), 5000) };
                try { counts.posted++; worker!.postMessage(JSON.stringify(message)); } catch { fail(new Error("Navigation worker is unavailable.")); }
            });
            const ack = (reply: Reply, document: string | undefined, received: number) => {
                if (reply.operation !== "navigation-progress" || reply.document !== document || reply.received !== received) throw new Error("Invalid navigation transfer acknowledgement.");
            };
            ack(await exchange(input), undefined, 0); let work = 0;
            for (const doc of input.documents) {
                const buffer = buffers.get(doc.document); if (!buffer || buffer.length !== doc.length) throw new Error("Missing captured navigation source.");
                ack(await exchange({ operation: "navigation-document", id: input.id, document: doc.document }), doc.document, 0);
                for (let from = 0; from < buffer.length;) {
                    const text = buffer.slice(from, Math.min(buffer.length, from + navigationLimits.chunkUnits));
                    const reply = await exchange({ operation: "navigation-chunk", id: input.id, document: doc.document, from, text });
                    from += text.length; counts.transferred += text.length; counts.maxChunk = Math.max(counts.maxChunk, text.length); work += text.length; ack(reply, doc.document, from); progress(work);
                }
                ack(await exchange({ operation: "navigation-end-document", id: input.id, document: doc.document }), doc.document, buffer.length);
            }
            const result = validateNavigationResult(await exchange({ operation: "navigation-finish", id: input.id }), input, buffers); counts.completed++; close(); return result;
        } catch (error) { if (!cancelled) counts.failed++; fail(error instanceof Error ? error : new Error("Navigation request failed.")); throw error; }
    };
    return Object.freeze({ run, dispose: () => { cancelled = true; fail(new Error("Navigation request cancelled.")); } });
}
