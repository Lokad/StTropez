import { openDemoProvider as openServerProvider } from "./server-provider.ts";
import { openDemoProvider as openBrowserProvider } from "../../../examples/demo/worker-provider.ts";
import { startPlayground } from "../../../examples/demo/main.ts";
import type { DemoProviderFactory } from "../../../examples/demo/provider-contract.ts";

function selectProvider(mode: string): DemoProviderFactory {
    if (mode === "server") return openServerProvider;
    if (mode === "browser") return openBrowserProvider;
    return async () => { throw new Error(`Unknown demo provider: ${mode}`); };
}

await startPlayground(selectProvider(new URL(location.href).searchParams.get("provider") ?? "server"));
