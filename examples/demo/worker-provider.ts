import type { LspConnectContext, RpcTransport } from "../../src/protocol/index.ts";
import type { DemoProvider } from "./provider-contract.ts";

/** Browser-only example host; no compiler or worker policy is added to the editor library. */
export async function openDemoProvider(_sample: string, signal: AbortSignal, names: readonly string[], backing: Readonly<Record<string, string>> = {}): Promise<DemoProvider> {
    if (signal.aborted) throw new Error("Language startup was cancelled.");
    const transports = new Set<() => void>(); let closed = false;
    return Object.freeze({ endpoint: "worker:typescript", rootUri: "file:///sttropez/",
        documents: Object.fromEntries(names.map(name => [name, { uri: `file:///sttropez/${name}`, path: `/sttropez/${name}` }])),
        versions: { server: "browser-demo-v1", typescript: "5.9.3", protocol: "3.17", positions: "utf-16" },
        connect: (context: LspConnectContext) => new Promise<RpcTransport>((resolve, reject) => {
            if (closed || context.cancelled) { reject(new Error("Language startup was cancelled.")); return; }
            const worker = new Worker(new URL("demo-language-worker.js", document.baseURI), { type: "module" });
            const listeners = new Set<Parameters<RpcTransport["subscribe"]>[0]>(); let disposed = false, ready = false;
            let stopCancel = () => {};
            const dispose = (reason = new Error("Browser language provider closed.")) => {
                if (disposed) return; disposed = true; clearTimeout(timer); stopCancel(); transports.delete(dispose);
                worker.terminate(); if (!ready) reject(reason);
                const previous = [...listeners]; listeners.clear(); for (const listener of previous) listener.close(reason);
            };
            const timer = setTimeout(() => dispose(new Error("Browser TypeScript startup timed out.")), 30000);
            transports.add(dispose); stopCancel = context.onCancel(() => dispose(new Error("Language startup was cancelled.")));
            worker.addEventListener("error", event => { event.preventDefault(); dispose(new Error("Browser TypeScript worker failed.")); });
            worker.addEventListener("messageerror", () => dispose(new Error("Browser TypeScript message failed.")));
            worker.addEventListener("message", (event: MessageEvent<unknown>) => {
                if (disposed) return;
                if (typeof event.data === "string") { for (const listener of [...listeners]) listener.message(event.data); return; }
                const value = event.data as { ready?: boolean; error?: string } | null;
                if (value?.error) { dispose(new Error(value.error)); return; }
                if (value?.ready && !ready) {
                    ready = true; clearTimeout(timer); stopCancel(); stopCancel = () => {};
                    resolve(Object.freeze({
                        send: (message: string) => { if (disposed) throw new Error("Browser provider is closed."); worker.postMessage(message); },
                        subscribe: (listener: Parameters<RpcTransport["subscribe"]>[0]) => { listeners.add(listener); return () => listeners.delete(listener); },
                        dispose,
                    }));
                }
            });
            worker.postMessage({ start: true, names, backing });
        }),
        close: async () => { closed = true; for (const dispose of [...transports]) dispose(); },
    });
}
