import { JsonRpcConnection, RpcError } from "../../src/protocol/index.ts";
import type { RpcRequestContext, RpcScheduler, RpcTransport } from "../../src/protocol/index.ts";
import type { BrowserLanguageService } from "./browser-language-service.ts";

/** Example-worker owner for the existing public JSON-RPC protocol and compiler service. */
export function createDemoLanguageSession(provider: Pick<BrowserLanguageService, "request" | "notify" | "dispose">,
    schedule: RpcScheduler, send: (message: string) => void, failed: (error: Error) => void) {
    let receiver: Parameters<RpcTransport["subscribe"]>[0] | undefined, closed = false;
    const jobs = new Set<{ run(): void; cancel(error: Error): void }>();
    let stopTask: (() => void) | undefined;
    const fail = (error: Error) => { if (closed) return; closed = true; rpc.dispose(error); failed(error); };
    const cancelled = () => new RpcError(-32800, "Request cancelled.");
    const queue = () => {
        if (closed || stopTask || !jobs.size) return;
        stopTask = schedule(0, () => {
            stopTask = undefined;
            // One synchronous service action per task lets later cancellation messages run.
            jobs.values().next().value?.run(); queue();
        });
    };
    const enqueue = <T>(action: () => T, context?: RpcRequestContext): Promise<T> => {
        if (closed || context?.cancelled) return Promise.reject(cancelled());
        if (jobs.size >= 256) {
            const error = new Error("Browser language queue is full. Retry the language service."); fail(error); return Promise.reject(error);
        }
        return new Promise((resolve, reject) => {
            let done = false, stopCancel = () => {};
            const finish = (result: { value: T } | { error: unknown }) => {
                if (done) return; done = true; jobs.delete(job); stopCancel();
                if (!jobs.size) { stopTask?.(); stopTask = undefined; }
                if ("error" in result) reject(result.error); else resolve(result.value);
            };
            const job = { run: () => {
                if (closed || context?.cancelled) { finish({ error: cancelled() }); return; }
                try { finish({ value: action() }); } catch (error) { finish({ error }); }
            }, cancel: (error: Error) => finish({ error }) };
            jobs.add(job); stopCancel = context?.onCancel(() => job.cancel(cancelled())) ?? stopCancel;
            if (done) stopCancel();
            try { queue(); } catch (error) { fail(error instanceof Error ? error : new Error("Language scheduling failed.")); }
        });
    };
    const transport: RpcTransport = { send, subscribe: next => { receiver = next; return () => { receiver = undefined; }; }, dispose: () => {
        stopTask?.(); stopTask = undefined;
        for (const job of [...jobs]) job.cancel(cancelled()); provider.dispose();
    } };
    const rpc = new JsonRpcConnection(transport, { schedule, maxMessageUnits: 16 * 1024 * 1024, maxPending: 128, onError: fail, onClose: fail });
    for (const method of ["initialize", "shutdown", "sttropez/readDocument", "sttropez/diagnostics", "textDocument/completion", "completionItem/resolve", "textDocument/hover",
        "textDocument/signatureHelp", "textDocument/definition", "textDocument/references", "textDocument/prepareRename", "textDocument/rename", "textDocument/codeAction", "textDocument/foldingRange", "textDocument/documentHighlight"]) {
        rpc.onRequest(method, (params, context) => enqueue(() => provider.request(method, params), context));
    }
    // RPC request handlers enter on a microtask. Match that turn for notifications so
    // document changes cannot overtake earlier requests, including in mixed batches.
    for (const method of ["initialized", "exit", "textDocument/didOpen", "textDocument/didChange", "textDocument/didClose"]) {
        rpc.onNotification(method, params => Promise.resolve().then(() => enqueue(() => {
            provider.notify(method, params); if (method === "exit") { closed = true; rpc.dispose(); }
        })));
    }
    return Object.freeze({ message: (text: string) => receiver?.message(text), dispose: () => { closed = true; rpc.dispose(); } });
}
