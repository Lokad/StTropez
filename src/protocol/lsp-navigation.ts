import type { DocumentId, DocumentSnapshot } from "../core/workspace.ts";
import { createLspClient, lspFeatureHandle } from "./lsp-client.ts";
import { decodeLspLocations, lspLocationUris } from "./lsp-features.ts";
import type { LspPrepare, LspWorkspace } from "./lsp-workspace.ts";

/** Captured read-only queries; the host chooses how to present each validated target. */
export function createLspNavigationClient(provider: LspWorkspace) {
    const client = createLspClient(provider);
    return Object.freeze({ ...lspFeatureHandle(client, ["textDocument/definition", "textDocument/references"]),
        run: async (snapshots: readonly DocumentSnapshot[], origin: DocumentId, offset: number, kind: "definition" | "references", includeDeclaration = true, prepare?: LspPrepare) => {
            if (kind !== "definition" && kind !== "references" || typeof includeDeclaration !== "boolean") throw new TypeError("Invalid LSP navigation query.");
            const value = await client.request(snapshots, origin, kind === "definition" ? "textDocument/definition" : "textDocument/references", capture => ({
                position: capture.index.at(offset), ...(kind === "references" ? { context: { includeDeclaration } } : {}) }), prepare).result;
            const uris = value.decode(() => lspLocationUris(value.response, kind)); await value.resolveTargets(uris, "navigation");
            const locations = value.decode(() => decodeLspLocations(value.response, kind, value.capture, value.targetForUri));
            return Object.freeze({ locations, isCurrent: value.isCurrent });
        },
        snapshot: () => Object.freeze({ ...client.snapshot(), ...client.inspection(), busy: client.isBusy(), version: "LSP3.17", epoch: provider.state.getSnapshot().epoch }) });
}
