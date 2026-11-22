import { createLspClient, lspFeatureHandle, type LspPositionRequest } from "./lsp-client.ts";
import { decodeLspHover } from "./lsp-features.ts";
import type { LspWorkspace } from "./lsp-workspace.ts";

export function createLspHoverClient(provider: LspWorkspace) {
    const client = createLspClient(provider, "textDocument/hover");
    return Object.freeze({ ...lspFeatureHandle(client),
        run: (request: LspPositionRequest) => {
            const { document, offset } = request;
            return client.request(request, "textDocument/hover", capture => ({ position: capture.index.at(offset) }), value => value.decode(() => {
                const decoded = decodeLspHover(value.response, value.capture);
                return decoded && Object.freeze({ revision: document.revision, ...decoded, isCurrent: value.isCurrent });
            }));
        } });
}
