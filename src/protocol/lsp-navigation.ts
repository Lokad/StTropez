import { definitionMethod, referencesMethod } from "./lsp-methods.ts";
import { createLspClient, lspFeatureHandle, type LspFeatureClient, type LspProjectClientDiagnostics, type LspProjectRequest } from "./lsp-client.ts";
import { decodeLspLocations, definitionOriginRange, lspLocationUris } from "./lsp-features.ts";
import type { LspCall } from "./lsp-session.ts";
import type { LspWorkspace } from "./lsp-workspace.ts";

export type LspDefinitionRequest = LspProjectRequest & Readonly<{ offset: number }>;
export type LspNavigationRequest = LspDefinitionRequest & Readonly<{ kind: "definition" | "references"; includeDeclaration?: boolean }>;
export type LspNavigationResult = Readonly<{ locations: ReturnType<typeof decodeLspLocations>; isCurrent: () => boolean }>;
export type LspDefinitionPreview = Readonly<{ hasTargets: boolean; originRange: ReturnType<typeof definitionOriginRange>;
    isCurrent: () => boolean; resolve: () => Promise<LspNavigationResult> }>;

export type LspNavigationClient = LspFeatureClient<"textDocument/definition" | "textDocument/references", LspNavigationRequest,
    LspNavigationResult, LspProjectClientDiagnostics & Readonly<{ epoch: number; sequence: number;
        documents: readonly Readonly<{ document: string; revision: number; length: number }>[] }>> & Readonly<{
    prepareDefinition: (request: LspDefinitionRequest) => LspCall<LspDefinitionPreview>;
}>;

/** Captured read-only queries; the host chooses how to present each validated target. */
export function createLspNavigationClient(provider: LspWorkspace): LspNavigationClient {
    const client = createLspClient(provider, definitionMethod, referencesMethod);
    type Reply = Parameters<Parameters<typeof client.request>[3]>[0];
    function lookup<T>(request: LspNavigationRequest,
        read: (reply: Reply, hasTargets: boolean, load: () => Promise<LspNavigationResult>) => T | Promise<T>) {
        const { offset, kind, includeDeclaration = true } = request;
        return client.request(request, kind === "definition" ? definitionMethod : referencesMethod, capture => ({
            position: capture.index.at(offset), ...(kind === "references" ? { context: { includeDeclaration } } : {}) }), reply => {
            const uris = reply.decode(() => lspLocationUris(reply.response, kind));
            return read(reply, uris.length > 0, async () => {
                await reply.resolveTargets(uris, "navigation");
                const locations = reply.decode(() => decodeLspLocations(reply.response, kind, reply.capture, reply.targetForUri));
                return Object.freeze({ locations, isCurrent: reply.isCurrent });
            });
        });
    }
    return Object.freeze({ ...lspFeatureHandle(client),
        prepareDefinition: (request: LspDefinitionRequest) => {
            const { offset } = request;
            return lookup({ ...request, kind: "definition" }, (reply, hasTargets, load): LspDefinitionPreview => {
                const originRange = reply.decode(() => definitionOriginRange(reply.response, reply.capture, offset));
                let loading: Promise<LspNavigationResult> | undefined;
                return Object.freeze({ hasTargets, originRange, isCurrent: reply.isCurrent, resolve: async () => {
                    const result = await (loading ??= load()); return reply.decode(() => result);
                } });
            });
        },
        run: (request: LspNavigationRequest) => lookup(request, (_reply, _hasTargets, load) => load()),
        snapshot: () => Object.freeze({ ...client.snapshot(), ...client.inspection(), busy: client.isBusy(), version: "LSP3.17", epoch: provider.getSnapshot().epoch }) });
}
