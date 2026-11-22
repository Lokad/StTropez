import { openWebSocketTransport } from "../../src/browser/index.ts";
import type { DemoProvider, DemoProviderBootstrap } from "./provider-contract.ts";

/** Local development host, selected explicitly by the demo page. */
export async function openDemoProvider(sample: string, signal: AbortSignal, names: readonly string[], backing: Readonly<Record<string, string>> = {}): Promise<DemoProvider> {
    const response = await fetch(new URL(`demo-provider?sample=${encodeURIComponent(sample)}`, document.baseURI), { method: "POST", signal,
        ...(Object.keys(backing).length ? { body: JSON.stringify(backing), headers: { "Content-Type": "application/json" } } : {}) });
    if (!response.ok) throw new Error("The TypeScript service could not start.");
    const config = await response.json() as DemoProviderBootstrap;
    if (typeof config?.endpoint !== "string" || !/^\/demo-provider\/[a-f0-9-]+$/.test(config.endpoint) || typeof config.rootUri !== "string"
        || !config.documents || !names.every(name => typeof config.documents[name]?.uri === "string")) throw new Error("Invalid language workspace.");
    const endpoint = new URL(config.endpoint, location.href); endpoint.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return Object.freeze({ ...config,
        connect: (signal: AbortSignal) => openWebSocketTransport(endpoint.href, { signal, maxMessageUnits: 16 * 1024 * 1024, maxBufferedBytes: 64 * 1024 * 1024 }),
        close: async () => { try { await fetch(config.endpoint, { method: "DELETE", keepalive: true }); } catch { /* Server idle cleanup owns abandoned projects. */ } },
    });
}
