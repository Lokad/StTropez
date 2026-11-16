import { openDemoProvider as openServerProvider } from "./server-provider.ts";
import { openDemoProvider as openBrowserProvider } from "./worker-provider.ts";
import type { DemoProviderFactory } from "./provider-contract.ts";

/** Capture page policy once; retry and sample switches retain the same provider choice. */
export function selectDemoProvider(mode: string): DemoProviderFactory {
    if (mode === "browser") return openBrowserProvider;
    if (mode === "server") return openServerProvider;
    return async () => { throw new Error(`Unknown demo provider: ${mode}`); };
}
