import { JsonRpcConnection } from "../../src/protocol/index.ts";
import type { RpcTransport } from "../../src/protocol/index.ts";
import { BrowserLanguageService } from "./browser-language-service.ts";

const scope = globalThis as unknown as Pick<Worker, "postMessage" | "addEventListener">;
let started = false, listener: Parameters<RpcTransport["subscribe"]>[0] | undefined;
let provider: BrowserLanguageService | undefined, rpc: JsonRpcConnection | undefined;
function fail(error: unknown): void {
    scope.postMessage({ error: error instanceof Error ? error.message : "Browser TypeScript failed." });
    rpc?.dispose(); provider?.dispose();
}
scope.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (typeof event.data === "string") { listener?.message(event.data); return; }
    const data = event.data as { start?: boolean; names?: string[] } | null;
    if (started || !data?.start || !Array.isArray(data.names)) return; started = true;
    void (async () => {
        const response = await fetch(new URL("typescript-libs.json", import.meta.url));
        if (!response.ok) throw new Error("TypeScript library assets could not load.");
        provider = new BrowserLanguageService(await response.json() as Record<string, string>, data.names!);
        const transport: RpcTransport = { send: message => scope.postMessage(message),
            subscribe: receiver => { listener = receiver; return () => { listener = undefined; }; }, dispose: () => provider?.dispose() };
        rpc = new JsonRpcConnection(transport, { schedule: (ms, callback) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
            maxMessageUnits: 16 * 1024 * 1024, maxPending: 128, onError: fail });
        for (const method of ["initialize", "shutdown", "sttropez/diagnostics", "textDocument/completion", "completionItem/resolve", "textDocument/hover",
            "textDocument/signatureHelp", "textDocument/definition", "textDocument/references", "textDocument/prepareRename", "textDocument/rename", "textDocument/codeAction", "textDocument/foldingRange", "textDocument/documentHighlight"]) {
            rpc.onRequest(method, params => provider!.request(method, params));
        }
        for (const method of ["initialized", "exit", "textDocument/didOpen", "textDocument/didChange", "textDocument/didClose"]) rpc.onNotification(method, params => provider!.notify(method, params));
        scope.postMessage({ ready: true });
    })().catch(fail);
});
