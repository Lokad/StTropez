import type { DocumentId, DocumentSnapshot } from "../core/workspace.ts";
import { createLspClient, lspFeatureHandle } from "./lsp-client.ts";
import { decodeLspWorkspaceEdit, lspWorkspaceEditUris } from "./lsp-features.ts";
import type { LspPrepare, LspWorkspace } from "./lsp-workspace.ts";

/** A rename response is a fixed provider edit batch for one captured new name. */
export function createLspRenameClient(provider: LspWorkspace) {
    const client = createLspClient(provider);
    return Object.freeze({ ...lspFeatureHandle(client, ["textDocument/rename"]),
        run: async (snapshots: readonly DocumentSnapshot[], origin: DocumentId, offset: number, newName: string, prepare?: LspPrepare) => {
            const value = await client.request(snapshots, origin, "textDocument/rename", capture => ({ position: capture.index.at(offset), newName }), prepare).result;
            const response = value.response === null ? {} : value.response;
            const uris = value.decode(() => lspWorkspaceEditUris(response)); await value.resolveTargets(uris, "edit");
            const plan = value.decode(() => decodeLspWorkspaceEdit(response, value.targetForUri));
            return Object.freeze({ ...plan, isCurrent: value.isCurrent });
        },
        snapshot: () => Object.freeze({ ...client.snapshot(), busy: client.isBusy(), version: "LSP3.17" }) });
}
