import { openWebSocketTransport } from "../../src/browser/index.ts";
import { createLspProviderController } from "../editing/lsp-provider-controller.ts";
import type { ProviderFactory } from "../editing/provider-controller.ts";

/** Explicit development-host choice. Generic session/feature code has no fixture endpoint policy. */
export function hostProviderFactory(): ProviderFactory | undefined {
    if (new URLSearchParams(location.search).get("language") !== "lsp") return undefined;
    const url = new URL("/lsp-fixture", location.href); url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return (workspace, tab, editor, options) => createLspProviderController(workspace, tab, editor, { ...options,
        uri: `host+fixture:workspace/${encodeURIComponent(workspace.resourceForDocument(editor.view.documentId).id)}/${encodeURIComponent(editor.view.documentId)}`,
        connect: context => { const abort = new AbortController(), stop = context.onCancel(() => abort.abort()); return openWebSocketTransport(url.href, { signal: abort.signal }).finally(stop); },
        beforeRequest: (session, configuration) => session.request("fixture/completionConfig", configuration).result });
}
