import type { LspDocument, LspRequestContext, LspSession } from "./lsp-session.ts";
import type { LspReadRequest, LspWorkspaceScope } from "./lsp-workspace.ts";
import { cancelledRequest } from "./wire.ts";

type Subscribe = (listener: () => void) => () => void;
type Report = (error: unknown) => void;
type Handler = Parameters<LspSession["onRequest"]>[1];

/** The host observes the wire request and the lifetime of its local owner through one context. */
export function requestContext(parent: LspRequestContext, isCurrent: () => boolean, listen: Subscribe,
    report: Report): LspRequestContext {
    return Object.freeze({
        id: parent.id, epoch: parent.epoch, isCurrent,
        get cancelled() { return parent.cancelled || !isCurrent(); },
        onCancel(listener) {
            let active = true;
            const notify = () => {
                if (!active) return;
                active = false;
                void Promise.resolve().then(listener).catch(report);
            };
            const stop = listen(notify);
            if (!isCurrent()) notify();
            return () => {
                active = false;
                stop();
            };
        },
    } satisfies LspRequestContext);
}

export function scopeRequestHandler(handler: Handler, scope: { generation: number; interruptions: Set<() => void> },
    current: (generation: number) => boolean, report: Report): Handler {
    return (value, parent) => new Promise((resolve, reject) => {
        const generation = scope.generation;
        const isCurrent = () => current(generation) && parent.isCurrent();
        const listeners = new Set<() => void>();
        let done = false;
        let stopRemote = () => {};
        function finish(complete: () => void) {
            if (done) return;
            done = true;
            scope.interruptions.delete(invalidate);
            stopRemote();
            listeners.clear();
            complete();
        }
        function invalidate() {
            if (isCurrent()) return;
            for (const notify of listeners) notify();
            finish(() => reject(cancelledRequest()));
        }
        const captured = requestContext(parent, isCurrent, notify => {
            if (isCurrent()) listeners.add(notify);
            return () => listeners.delete(notify);
        }, report);
        scope.interruptions.add(invalidate);
        stopRemote = parent.onCancel(invalidate);
        if (done) stopRemote();
        else invalidate();
        void Promise.resolve().then(() => {
            if (!isCurrent()) throw cancelledRequest();
            return handler(value, captured);
        }).then(result => finish(() => {
            if (isCurrent()) resolve(result);
            else reject(cancelledRequest());
        }), error => finish(() => reject(error)));
    });
}

/** A feature or follow-up cancels only its own wire calls. Closing the scope interrupts every read. */
export function readRequest(source: LspWorkspaceScope, interruptions: Set<() => void>, interrupted: () => void,
    documents: () => Iterable<LspDocument>): LspReadRequest {
    const calls = new Set<() => void>();
    let active = true;
    const check = () => { if (!active) throw cancelledRequest(); };
    function dispose() {
        active = false;
        interruptions.delete(interrupt);
        for (const cancel of calls) cancel();
        calls.clear();
    }
    function interrupt() {
        if (!active) return;
        dispose();
        interrupted();
    }
    function own<T extends { cancel: () => void; result: Promise<unknown> }>(call: T): T {
        if (!active) call.cancel();
        else calls.add(call.cancel);
        const finish = () => calls.delete(call.cancel);
        void call.result.then(finish, finish);
        return call;
    }
    interruptions.add(interrupt);
    return Object.freeze({
        commandNames: source.commandNames,
        request(method, params, timeoutMs) {
            check();
            documents();
            return own(source.request(method, params, timeoutMs));
        },
        requestDocument(method, document, params) {
            check();
            return own(source.requestDocument(method, document, params));
        },
        async flush() {
            check();
            await source.flush(Array.from(documents()));
            check();
        },
        dispose,
    } satisfies LspReadRequest);
}

