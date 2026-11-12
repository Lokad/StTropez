import type { DocumentId, DocumentSnapshot } from "../core/workspace.ts";
import { createLspClient } from "./lsp-client.ts";
import { decodeLspLocations } from "./lsp-features.ts";
import type { LspPrepare, LspWorkspace } from "./lsp-workspace.ts";

/** Captured read-only queries; the host chooses how to present each validated target. */
export function createLspNavigationClient(provider: LspWorkspace) {
    const client = createLspClient(provider);
    return Object.freeze({ state: client.state, subscribe: client.subscribe, cancel: client.cancel, dispose: client.dispose,
        run: async (snapshots: readonly DocumentSnapshot[], origin: DocumentId, offset: number, kind: "definition" | "references", includeDeclaration = true, prepare?: LspPrepare) => {
            if (kind !== "definition" && kind !== "references" || typeof includeDeclaration !== "boolean") throw new TypeError("Invalid LSP navigation query.");
            const value = await client.request(snapshots, origin, kind === "definition" ? "textDocument/definition" : "textDocument/references", capture => ({
                position: capture.index.at(offset), ...(kind === "references" ? { context: { includeDeclaration } } : {}) }), prepare).result;
            const locations = value.decode(() => decodeLspLocations(value.response, kind, value.capture, uri => value.captures.get(uri)));
            return Object.freeze({ locations, isCurrent: value.isCurrent });
        },
        snapshot: () => Object.freeze({ ...client.snapshot(), ...client.inspection(), busy: client.isBusy(), version: "LSP3.17", epoch: provider.state.getSnapshot().epoch }) });
}
