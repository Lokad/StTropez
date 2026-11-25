import { openWebSocketTransport } from "../../../src/browser/index.ts";
import type { LspWorkspace } from "../../../src/protocol/index.ts";
import { FixtureLspWorkspace } from "./fixture-workspace.ts";
import { createLspProviderController, type LspProviderFactory } from "../language/lsp-provider-controller.ts";
import type { RenameHostOptions } from "../../../examples/shared/rename.ts";
import type { ActionHostOptions } from "../hosts/code-actions.ts";
import { createLspProjectClient } from "../language/lsp-project-client.ts";
import type { LspProjectFactory } from "../language/lsp-project-client.ts";
import type { HoverHostOptions } from "../../../examples/shared/hover.ts";
import type { NavigationHostOptions } from "../hosts/navigation.ts";
import type { Workspace } from "../../../src/index.ts";
import type { SignatureHostOptions } from "../hosts/signature.ts";
import type { LinkHostOptions } from "../hosts/document-links.ts";
import type { ColorHostOptions } from "../hosts/document-colors.ts";
import type { FixturePolicy } from "../language/fixture-requests.ts";
import type { NavigationFault } from "../language/navigation.ts";

/** Explicit development-host choice. Generic session/feature code has no fixture endpoint policy. */
export function hostLspFactories(owner: Workspace, takeRenamePolicy: () => FixturePolicy<NavigationFault>): Readonly<{ owner: LspWorkspace; provider: LspProviderFactory; hover: HoverHostOptions; navigation: NavigationHostOptions; rename: RenameHostOptions; actions: ActionHostOptions; project: LspProjectFactory; signature: SignatureHostOptions; links: LinkHostOptions; colors: ColorHostOptions }> {
    const url = new URL("/lsp-fixture", location.href); url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const connection = new FixtureLspWorkspace(owner, { connect: signal => openWebSocketTransport(url.href, { signal }),
        initializationOptions: { fixtureDynamicLanguage: new URLSearchParams(location.search).get("lspSubset") === "dynamic" },
        workspaceEdits: true, applyEdit: true });
    // These initial working resources belong to the host's open project, including unmounted targets.
    connection.createScope().setDocuments(owner.getSnapshot().documents.filter(document => document.language !== null));
    return Object.freeze({
        owner: connection,
        signature: { provider: connection, prepare: policy => session => connection.prepareRequest(session, "textDocument/signatureHelp", policy) },
        links: { provider: connection, prepare: (aliases, policy) => session =>
            connection.prepareRequest(session, "textDocument/documentLink", { aliases: [...aliases], ...policy }) },
        colors: { provider: connection, prepare: (kind, policy) => session =>
            connection.prepareRequest(session, kind === "discovery" ? "textDocument/documentColor" : "textDocument/colorPresentation", policy,
                { replacePending: kind === "presentation" }) },
        provider: (editor, options) => createLspProviderController(editor, { ...options, provider: connection,
            beforeRequest: (session, configuration) => connection.prepareRequest(session, "textDocument/completion", configuration, { replacePending: true }) }),
        hover: { beforeRequest: (session, configuration) => connection.prepareRequest(session, "textDocument/hover", configuration) },
        navigation: { provider: connection, prepare: (kind, policy) => session => connection.prepareRequest(session,
            kind === "definition" ? "textDocument/definition" : "textDocument/references", policy) },
        rename: { provider: connection, prepare: () => {
            const policy = takeRenamePolicy();
            return session => connection.prepareRequest(session, "textDocument/rename", policy);
        } },
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
                    : connection.prepareCommand(session, "fixture.status", policy);
            } }, changed),
    });
}
