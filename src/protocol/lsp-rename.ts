import { renameMethod } from "./lsp-methods.ts";
import { createLspClient, lspFeatureHandle, type LspDocumentOwner, type LspFeatureClient, type LspProjectRequest } from "./lsp-client.ts";
import { decodeLspWorkspaceEdit, lspWorkspaceEditUris, type LspWorkspaceEdit } from "./lsp-features.ts";
import type { LspWorkspace } from "./lsp-workspace.ts";

export type LspRenameRequest = LspProjectRequest & Readonly<{ offset: number; newName: string }>;

export type LspRenameClient = LspFeatureClient<"textDocument/rename", LspRenameRequest, LspWorkspaceEdit>;

/** A rename response is a fixed provider edit batch for one captured new name. */
export function renameClient(provider: LspWorkspace | LspDocumentOwner): LspRenameClient {
    const client = createLspClient(provider, renameMethod);
    return Object.freeze({ ...lspFeatureHandle(client),
        run: (request: LspRenameRequest) => {
            const { offset, newName } = request;
            return client.request(request, renameMethod, capture => ({ position: capture.index.at(offset), newName }), async value => {
                const response = value.response === null ? {} : value.response;
                const uris = value.decode(() => lspWorkspaceEditUris(response)); await value.resolveTargets(uris, "edit");
                const plan = value.decode(() => decodeLspWorkspaceEdit(response, value.targetForUri));
                return Object.freeze({ ...plan, isCurrent: value.isCurrent });
            });
        } });
}
