import { openWebSocketTransport } from "../../src/browser/index.ts";
import { LspWorkspace } from "../../src/protocol/index.ts";
import { createLspProviderController } from "../editing/lsp-provider-controller.ts";
import type { ProviderFactory } from "../editing/provider-controller.ts";
import { createHoverController } from "../editing/hover-controller.ts";
import { createLspHoverClient } from "../editing/lsp-hover-client.ts";
import { createLspNavigationClient } from "../editing/lsp-navigation-client.ts";
import { createLspRenameClient } from "../editing/lsp-rename-client.ts";
import type { LspRenameFactory } from "../editing/lsp-rename-client.ts";
import { createLspActionClient } from "../editing/lsp-action-client.ts";
import type { LspActionFactory } from "../editing/lsp-action-client.ts";
import { createLspProjectClient } from "../editing/lsp-project-client.ts";
import type { LspProjectFactory } from "../editing/lsp-project-client.ts";
import type { HoverControllerFactory } from "../hosts/hover.ts";
import type { NavigationServiceFactory } from "../editing/navigation-service.ts";
import type { DocumentId, Workspace } from "../../src/index.ts";
import type { LspSessionOptions } from "../../src/protocol/index.ts";
import { lspColorBackend, lspLinkBackend, lspSignatureBackend } from "../editing/lsp-language-clients.ts";
import type { SignatureBackendFactory } from "../hosts/signature.ts";
import type { LinkBackendFactory } from "../hosts/document-links.ts";
import type { ColorBackendFactory } from "../hosts/document-colors.ts";

/** Explicit development-host choice. Generic session/feature code has no fixture endpoint policy. */
export function hostLspFactories(owner: Workspace): Readonly<{ owner: LspWorkspace; provider: ProviderFactory; hover: HoverControllerFactory; navigation: NavigationServiceFactory; rename: LspRenameFactory; actions: LspActionFactory; project: LspProjectFactory; signature: SignatureBackendFactory; links: LinkBackendFactory; colors: ColorBackendFactory }> | undefined {
    if (new URLSearchParams(location.search).get("language") !== "lsp") return undefined;
    const url = new URL("/lsp-fixture", location.href); url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const connect: LspSessionOptions["connect"] = context => { const abort = new AbortController(), stop = context.onCancel(() => abort.abort()); return openWebSocketTransport(url.href, { signal: abort.signal }).finally(stop); };
    const uri = (workspace: Workspace, id: DocumentId) => `host+fixture:workspace/${encodeURIComponent(workspace.resourceForDocument(id).id)}/${encodeURIComponent(id)}`;
    const connection = new LspWorkspace(owner, { connect, schedule: (ms, callback) => { const timer = window.setTimeout(callback, ms); return () => window.clearTimeout(timer); },
        initializationOptions: { fixtureDynamicLanguage: new URLSearchParams(location.search).get("lspSubset") === "dynamic" },
        features: ["textDocument/completion", "textDocument/hover", "textDocument/definition", "textDocument/references", "textDocument/rename", "textDocument/codeAction", "workspace/executeCommand", "textDocument/signatureHelp", "textDocument/documentLink", "textDocument/documentColor", "textDocument/colorPresentation"], diagnostics: true, workspaceEdits: true, applyEdit: true,
        documentInfo: document => document.key.variant === "working" ? { uri: uri(owner, document.id), languageId: "fixture" } : undefined });
    // These initial working resources belong to the host's open project, including unmounted targets.
    connection.createScope().setDocuments(owner.getSnapshot().documents.filter(document => document.key.variant === "working"));
    return Object.freeze({
        owner: connection,
        signature: (_clock, changed) => lspSignatureBackend(owner, connection, changed),
        links: (_clock, changed) => lspLinkBackend(owner, connection, id => uri(owner, id), changed),
        colors: (_clock, changed) => lspColorBackend(owner, connection, changed),
        provider: (workspace, tab, editor, options) => createLspProviderController(workspace, tab, editor, { ...options, provider: connection,
            beforeRequest: (session, configuration) => session.request("fixture/completionConfig", configuration).result }),
        hover: (workspace, tab, editor, canCapture) => createHoverController(workspace, tab, editor, { canCapture,
            backend: createLspHoverClient(editor.element.ownerDocument.defaultView!, { provider: connection,
                beforeRequest: (session, configuration) => session.request("fixture/hoverConfig", configuration).result }) }),
        navigation: { positionQueries: true, create: (clock, counts, changed) => createLspNavigationClient(owner, clock, counts, changed, { provider: connection,
            beforeRequest: (session, input) => session.request("fixture/navigationConfig", { delay: input.delay, ...(input.fault ? { fault: input.fault } : {}) }).result }) },
        rename: clock => createLspRenameClient(owner, clock, { provider: connection,
            beforeRequest: (session, configuration) => session.request("fixture/renameConfig", configuration).result }),
        actions: clock => createLspActionClient(owner, clock, { provider: connection,
            beforeRequest: (session, configuration) => session.request("fixture/actionConfig", configuration).result,
            beforeResolve: (session, configuration) => session.request("fixture/actionResolveConfig", configuration).result }),
        project: clock => createLspProjectClient(owner, clock, { provider: connection, reviewCommand: "fixture.review", statusCommand: "fixture.status",
            beforeRequest: (session, input) => session.request("fixture/projectConfig", input).result }),
    });
}
