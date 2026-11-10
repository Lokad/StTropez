import { openWebSocketTransport } from "../../src/browser/index.ts";
import { createLspProviderController } from "../editing/lsp-provider-controller.ts";
import type { ProviderFactory } from "../editing/provider-controller.ts";
import { createHoverController } from "../editing/hover-controller.ts";
import { createLspHoverClient } from "../editing/lsp-hover-client.ts";
import { createLspNavigationClient } from "../editing/lsp-navigation-client.ts";
import type { HoverControllerFactory } from "../hosts/hover.ts";
import type { NavigationServiceFactory } from "../editing/navigation-service.ts";
import type { DocumentId, Workspace } from "../../src/index.ts";
import type { LspSessionOptions } from "../../src/protocol/index.ts";

/** Explicit development-host choice. Generic session/feature code has no fixture endpoint policy. */
export function hostLspFactories(owner: Workspace): Readonly<{ provider: ProviderFactory; hover: HoverControllerFactory; navigation: NavigationServiceFactory }> | undefined {
    if (new URLSearchParams(location.search).get("language") !== "lsp") return undefined;
    const url = new URL("/lsp-fixture", location.href); url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const connect: LspSessionOptions["connect"] = context => { const abort = new AbortController(), stop = context.onCancel(() => abort.abort()); return openWebSocketTransport(url.href, { signal: abort.signal }).finally(stop); };
    const uri = (workspace: Workspace, id: DocumentId) => `host+fixture:workspace/${encodeURIComponent(workspace.resourceForDocument(id).id)}/${encodeURIComponent(id)}`;
    return Object.freeze({
        provider: (workspace, tab, editor, options) => createLspProviderController(workspace, tab, editor, { ...options, uri: uri(workspace, editor.view.documentId), connect,
            beforeRequest: (session, configuration) => session.request("fixture/completionConfig", configuration).result }),
        hover: (workspace, tab, editor, canCapture) => createHoverController(workspace, tab, editor, { canCapture,
            backend: createLspHoverClient(editor.element.ownerDocument.defaultView!, { connect, uri: document => uri(workspace, document.id),
                beforeRequest: (session, configuration) => session.request("fixture/hoverConfig", configuration).result }) }),
        navigation: { positionQueries: true, create: (clock, counts, changed) => createLspNavigationClient(owner, clock, counts, changed, { connect, uri: document => uri(owner, document),
            beforeRequest: (session, input) => session.request("fixture/navigationConfig", { delay: input.delay, ...(input.fault ? { fault: input.fault } : {}) }).result }) },
    });
}
