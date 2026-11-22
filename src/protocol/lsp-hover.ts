import { createLspClient, lspFeatureHandle, type LspFeatureClient, type LspPositionRequest } from "./lsp-client.ts";
import { decodeLspHover, type LspHover } from "./lsp-features.ts";
import type { LspWorkspace } from "./lsp-workspace.ts";

export type LspHoverResult = LspHover & Readonly<{ revision: number; isCurrent: () => boolean }>;
export type LspHoverClient = LspFeatureClient<"textDocument/hover", LspPositionRequest, LspHoverResult | null>;

export function createLspHoverClient(provider: LspWorkspace): LspHoverClient {
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
