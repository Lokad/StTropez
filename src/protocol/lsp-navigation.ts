import type { DocumentId, DocumentSnapshot } from "../core/workspace.ts";
import { createLspClient, lspFeatureHandle } from "./lsp-client.ts";
import { decodeLspLocations, definitionOriginRange, lspLocationUris } from "./lsp-features.ts";
import type { LspPrepare, LspWorkspace } from "./lsp-workspace.ts";

/** Captured read-only queries; the host chooses how to present each validated target. */
export function createLspNavigationClient(provider: LspWorkspace) {
    const client = createLspClient(provider);
    const lookup = async (snapshots: readonly DocumentSnapshot[], origin: DocumentId, offset: number, kind: "definition" | "references", includeDeclaration: boolean, prepare?: LspPrepare) => {
        const value = await client.request(snapshots, origin, kind === "definition" ? "textDocument/definition" : "textDocument/references", capture => ({
            position: capture.index.at(offset), ...(kind === "references" ? { context: { includeDeclaration } } : {}) }), prepare).result;
        const uris = value.decode(() => lspLocationUris(value.response, kind));
        const load = async () => {
            await value.resolveTargets(uris, "navigation");
            const locations = value.decode(() => decodeLspLocations(value.response, kind, value.capture, value.targetForUri));
            return Object.freeze({ locations, isCurrent: value.isCurrent });
        };
        let loading: ReturnType<typeof load> | undefined;
        return { value, uris, resolve: async () => {
            const result = await (loading ??= load()); return value.decode(() => result);
        } };
    };
    return Object.freeze({ ...lspFeatureHandle(client, ["textDocument/definition", "textDocument/references"]),
        prepareDefinition: async (snapshots: readonly DocumentSnapshot[], origin: DocumentId, offset: number, prepare?: LspPrepare) => {
            const { value, uris, resolve } = await lookup(snapshots, origin, offset, "definition", true, prepare);
            return Object.freeze({ hasTargets: uris.length > 0, originRange: value.decode(() => definitionOriginRange(value.response, value.capture, offset)),
                isCurrent: value.isCurrent, resolve });
        },
        run: async (snapshots: readonly DocumentSnapshot[], origin: DocumentId, offset: number, kind: "definition" | "references", includeDeclaration = true, prepare?: LspPrepare) => {
            return (await lookup(snapshots, origin, offset, kind, includeDeclaration, prepare)).resolve();
        },
        snapshot: () => Object.freeze({ ...client.snapshot(), ...client.inspection(), busy: client.isBusy(), version: "LSP3.17", epoch: provider.getSnapshot().epoch }) });
}
