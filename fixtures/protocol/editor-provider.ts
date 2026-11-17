import { openWebSocketTransport } from "../../src/browser/index.ts";
import type { LspWorkspace } from "../../src/protocol/index.ts";
import { FixtureLspWorkspace } from "./fixture-workspace.ts";
import { createLspProviderController } from "../../examples/shared/language/lsp-provider-controller.ts";
import type { ProviderFactory } from "../../examples/shared/language/provider-contract.ts";
import { createHoverController } from "../../examples/shared/language/hover-controller.ts";
import { createLspHoverClient } from "../../examples/shared/language/lsp-hover-client.ts";
import { createLspNavigationClient } from "../../examples/shared/language/lsp-navigation-client.ts";
import { createLspRenameClient } from "../../examples/shared/language/lsp-rename-client.ts";
import type { LspRenameFactory } from "../../examples/shared/language/lsp-rename-client.ts";
import { createLspActionClient } from "../../examples/shared/language/lsp-action-client.ts";
import type { LspActionFactory } from "../../examples/shared/language/lsp-action-client.ts";
import { createLspProjectClient } from "../../examples/shared/language/lsp-project-client.ts";
import type { LspProjectFactory } from "../../examples/shared/language/lsp-project-client.ts";
import type { HoverControllerFactory } from "../../examples/hosts/hover.ts";
import type { NavigationServiceFactory } from "../../examples/shared/language/navigation-service.ts";
import type { DocumentId, Workspace } from "../../src/index.ts";
import type { LspSessionOptions } from "../../src/protocol/index.ts";
import { lspColorBackend, lspLinkBackend, lspSignatureBackend } from "../../examples/shared/language/lsp-language-clients.ts";
import type { SignatureBackendFactory } from "../../examples/hosts/signature.ts";
import type { LinkBackendFactory } from "../../examples/hosts/document-links.ts";
import type { ColorBackendFactory } from "../../examples/hosts/document-colors.ts";
import { fixtureDocumentUri } from "./document-uri.ts";

/** Explicit development-host choice. Generic session/feature code has no fixture endpoint policy. */
export function hostLspFactories(owner: Workspace): Readonly<{ owner: LspWorkspace; provider: ProviderFactory; hover: HoverControllerFactory; navigation: NavigationServiceFactory; rename: LspRenameFactory; actions: LspActionFactory; project: LspProjectFactory; signature: SignatureBackendFactory; links: LinkBackendFactory; colors: ColorBackendFactory }> {
    const url = new URL("/lsp-fixture", location.href); url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const connect: LspSessionOptions["connect"] = context => { const abort = new AbortController(), stop = context.onCancel(() => abort.abort()); return openWebSocketTransport(url.href, { signal: abort.signal }).finally(stop); };
    const uri = (workspace: Workspace, id: DocumentId) => fixtureDocumentUri(workspace.resourceForDocument(id).id, id);
    const connection = new FixtureLspWorkspace(owner, { connect, schedule: (ms, callback) => { const timer = window.setTimeout(callback, ms); return () => window.clearTimeout(timer); },
        initializationOptions: { fixtureDynamicLanguage: new URLSearchParams(location.search).get("lspSubset") === "dynamic" },
        features: ["textDocument/completion", "textDocument/hover", "textDocument/definition", "textDocument/references", "textDocument/rename", "textDocument/codeAction", "workspace/executeCommand", "textDocument/signatureHelp", "textDocument/documentLink", "textDocument/documentColor", "textDocument/colorPresentation"], diagnostics: true, workspaceEdits: true, applyEdit: true,
        documentInfo: document => document.key.variant === "working" ? { uri: uri(owner, document.id), languageId: "fixture" } : undefined });
    // These initial working resources belong to the host's open project, including unmounted targets.
    connection.createScope().setDocuments(owner.getSnapshot().documents.filter(document => document.key.variant === "working"));
    return Object.freeze({
        owner: connection,
        signature: (_clock, changed) => lspSignatureBackend(owner, connection, changed,
            input => session => connection.prepareRequest(session, "textDocument/signatureHelp", { delay: input.delay, ...(input.fault ? { fault: input.fault } : {}) })),
        links: (_clock, changed) => lspLinkBackend(owner, connection, id => uri(owner, id), changed,
            input => session => connection.prepareRequest(session, "textDocument/documentLink", { delay: input.delay, ...(input.fault ? { fault: input.fault } : {}),
                aliases: input.aliases.map(alias => ({ module: alias.module, uri: uri(owner, alias.document as DocumentId) })) })),
        colors: (_clock, changed) => lspColorBackend(owner, connection, changed, {
            discovery: input => session => connection.prepareRequest(session, "textDocument/documentColor", { delay: input.delay, ...(input.fault ? { fault: input.fault } : {}) }),
            presentation: input => session => connection.prepareRequest(session, "textDocument/colorPresentation", { delay: input.delay, ...(input.fault ? { fault: input.fault } : {}) }),
        }),
        provider: (workspace, tab, editor, options) => createLspProviderController(workspace, tab, editor, { ...options, provider: connection,
            beforeRequest: (session, configuration) => connection.prepareRequest(session, "textDocument/completion", configuration, { replacePending: true }) }),
        hover: (workspace, tab, editor, canCapture) => createHoverController(workspace, tab, editor, { canCapture,
            backend: createLspHoverClient({ provider: connection,
                beforeRequest: (session, configuration) => connection.prepareRequest(session, "textDocument/hover", configuration) }) }),
        navigation: { create: (_clock, counts, changed) => createLspNavigationClient(owner, counts, changed, { provider: connection,
            beforeRequest: (session, input) => connection.prepareRequest(session, input.kind === "definition" ? "textDocument/definition" : "textDocument/references", { delay: input.delay, ...(input.fault ? { fault: input.fault } : {}) }) }) },
        rename: () => createLspRenameClient({ provider: connection,
            beforeRequest: (session, configuration) => connection.prepareRequest(session, "textDocument/rename", configuration) }),
        actions: () => createLspActionClient({ provider: connection,
            beforeRequest: async (session, configuration) => {
                await connection.prepareRequest(session, "textDocument/codeAction", configuration);
                if (!session.commandNames().includes("fixture.review")) await session.request("fixture/reviewRegistration", { registered: true }).result;
            },
            beforeResolve: (session, configuration) => connection.prepareRequest(session, "codeAction/resolve", configuration) }),
        project: () => createLspProjectClient({ provider: connection, reviewCommand: "fixture.review", statusCommand: "fixture.status",
            beforeRequest: (session, input) => {
                const policy = { delay: input.delay, ...(input.fault ? { fault: input.fault } : {}) };
                return input.kind === "register" || input.kind === "unregister"
                    ? session.request("fixture/reviewRegistration", { registered: input.kind === "register", _fixture: policy }).result
                    : connection.prepareCommand(session, input.kind === "review" ? "fixture.review" : "fixture.status", policy);
            } }),
    });
}
