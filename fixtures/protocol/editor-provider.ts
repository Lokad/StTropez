import { openWebSocketTransport } from "../../src/browser/index.ts";
import type { LspWorkspace } from "../../src/protocol/index.ts";
import { FixtureLspWorkspace } from "./fixture-workspace.ts";
import { createLspProviderController } from "../../examples/shared/language/lsp-provider-controller.ts";
import type { ProviderFactory } from "../../examples/shared/language/provider-contract.ts";
import type { RenameHostOptions } from "../../examples/hosts/rename.ts";
import type { ActionHostOptions } from "../../examples/hosts/code-actions.ts";
import { createLspProjectClient } from "../../examples/shared/language/lsp-project-client.ts";
import type { LspProjectFactory } from "../../examples/shared/language/lsp-project-client.ts";
import type { HoverHostOptions } from "../../examples/hosts/hover.ts";
import type { NavigationHostOptions } from "../../examples/hosts/navigation.ts";
import type { Workspace } from "../../src/index.ts";
import type { SignatureHostOptions } from "../../examples/hosts/signature.ts";
import type { LinkHostOptions } from "../../examples/hosts/document-links.ts";
import type { ColorHostOptions } from "../../examples/hosts/document-colors.ts";

/** Explicit development-host choice. Generic session/feature code has no fixture endpoint policy. */
export function hostLspFactories(owner: Workspace): Readonly<{ owner: LspWorkspace; provider: ProviderFactory; hover: HoverHostOptions; navigation: NavigationHostOptions; rename: RenameHostOptions; actions: ActionHostOptions; project: LspProjectFactory; signature: SignatureHostOptions; links: LinkHostOptions; colors: ColorHostOptions }> {
    const url = new URL("/lsp-fixture", location.href); url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const connection = new FixtureLspWorkspace(owner, { connect: signal => openWebSocketTransport(url.href, { signal }),
        initializationOptions: { fixtureDynamicLanguage: new URLSearchParams(location.search).get("lspSubset") === "dynamic" },
        workspaceEdits: true, applyEdit: true });
    // These initial working resources belong to the host's open project, including unmounted targets.
    connection.retainFeatures("workspace/executeCommand");
    connection.createScope().setDocuments(owner.getSnapshot().documents.filter(document => document.language !== null));
    return Object.freeze({
        owner: connection,
        signature: { provider: connection, prepare: (delay, fault) => session => connection.prepareRequest(session, "textDocument/signatureHelp", { delay, ...(fault ? { fault } : {}) }) },
        links: { provider: connection, prepare: (aliases, delay, fault) => session =>
            connection.prepareRequest(session, "textDocument/documentLink", { aliases: [...aliases], delay, ...(fault ? { fault } : {}) }) },
        colors: { provider: connection, prepare: (kind, delay, fault) => session =>
            connection.prepareRequest(session, kind === "discovery" ? "textDocument/documentColor" : "textDocument/colorPresentation", { delay, ...(fault ? { fault } : {}) }) },
        provider: (editor, options) => createLspProviderController(editor, { ...options, provider: connection,
            beforeRequest: (session, configuration) => connection.prepareRequest(session, "textDocument/completion", configuration, { replacePending: true }) }),
        hover: { provider: connection, beforeRequest: (session, configuration) => connection.prepareRequest(session, "textDocument/hover", configuration) },
        navigation: { provider: connection, prepare: (kind, delay, fault) => session => connection.prepareRequest(session,
            kind === "definition" ? "textDocument/definition" : "textDocument/references", { delay, ...(fault ? { fault } : {}) }) },
        rename: { provider: connection, prepare: (delay, fault) => session => connection.prepareRequest(session, "textDocument/rename", { delay, ...(fault ? { fault } : {}) }) },
        actions: { provider: connection,
            beforeRequest: async (session, configuration) => {
                await connection.prepareRequest(session, "textDocument/codeAction", configuration);
                if (!session.commandNames().includes("fixture.review")) await session.request("fixture/reviewRegistration", { registered: true }).result;
            },
            beforeResolve: (session, configuration) => connection.prepareRequest(session, "codeAction/resolve", configuration) },
        project: changed => createLspProjectClient({ provider: connection, reviewCommand: "fixture.review", statusCommand: "fixture.status",
            beforeRequest: (session, input) => {
                const policy = { delay: input.delay, ...(input.fault ? { fault: input.fault } : {}) };
                return input.kind === "register" || input.kind === "unregister"
                    ? session.request("fixture/reviewRegistration", { registered: input.kind === "register", _fixture: policy }).result
                    : connection.prepareCommand(session, input.kind === "review" ? "fixture.review" : "fixture.status", policy);
            } }, changed),
    });
}
