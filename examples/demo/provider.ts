import { openWebSocketTransport } from "../../src/browser/index.ts";
import type { LspConnectContext, RpcTransport } from "../../src/protocol/index.ts";
import type { DemoProviderBootstrap } from "./provider-contract.ts";

export type DemoProvider = DemoProviderBootstrap & Readonly<{
    connect: (context: LspConnectContext) => Promise<RpcTransport>;
    close: () => Promise<void>;
}>;

/** Local development host. The static build substitutes its example-owned worker provider. */
export async function openDemoProvider(sample: string, signal: AbortSignal, names: readonly string[]): Promise<DemoProvider> {
    const response = await fetch(new URL(`demo-provider?sample=${encodeURIComponent(sample)}`, document.baseURI), { method: "POST", signal });
    if (!response.ok) throw new Error("The TypeScript service could not start.");
    const config = await response.json() as DemoProviderBootstrap;
    if (typeof config?.endpoint !== "string" || !/^\/demo-provider\/[a-f0-9-]+$/.test(config.endpoint) || typeof config.rootUri !== "string"
        || !config.documents || !names.every(name => typeof config.documents[name]?.uri === "string")) throw new Error("Invalid language workspace.");
    const endpoint = new URL(config.endpoint, location.href); endpoint.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return Object.freeze({ ...config,
        connect: (context: LspConnectContext) => {
            const abort = new AbortController(), stop = context.onCancel(() => abort.abort());
            return openWebSocketTransport(endpoint.href, { signal: abort.signal, maxMessageUnits: 16 * 1024 * 1024, maxBufferedBytes: 64 * 1024 * 1024 }).finally(stop);
        },
        close: async () => { try { await fetch(config.endpoint, { method: "DELETE", keepalive: true }); } catch { /* Server idle cleanup owns abandoned projects. */ } },
    });
}
