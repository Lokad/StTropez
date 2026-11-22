import { ProtocolDecodeError, staleRequest } from "./wire.ts";
import { createLspClient, lspFeatureHandle, type LspFeatureClient, type LspDocumentRequest } from "./lsp-client.ts";
import type { LspDocumentCapture } from "./lsp-session.ts";
import type { LspWorkspace } from "./lsp-workspace.ts";
import type { DiscoveredFold } from "../core/fold-discovery.ts";

/** Complete-line LSP folding; malformed shapes fail the batch, invalid line ranges are ignored. */
export function decodeLspFoldingRanges(value: unknown, capture: LspDocumentCapture): readonly DiscoveredFold[] {
    if (!capture.isCurrent()) throw staleRequest("LSP folding capture expired.");
    if (value === null) return Object.freeze([]);
    if (!Array.isArray(value)) throw new ProtocolDecodeError("Expected LSP folding ranges.");
    const buffer = capture.document.buffer, index = capture.index, result: DiscoveredFold[] = [];
    const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    for (const item of value) {
        if (!item || typeof item !== "object" || !integer(item.startLine) || !integer(item.endLine)
            || item.kind !== undefined && typeof item.kind !== "string") throw new ProtocolDecodeError("Malformed LSP folding range.");
        if (item.startLine >= item.endLine || item.endLine >= index.lineCount) continue;
        const from = index.offsetAt({ line: item.startLine, character: 0 }), to = index.offsetAt({ line: item.endLine + 1, character: 0 });
        // Bare CR is an LSP line break, but only LF divides rendered editor rows.
        if (from >= to || buffer.lineAt(to - 1) <= buffer.lineAt(from)) continue;
        result.push(Object.freeze({ from, to, ...(item.kind ? { group: item.kind } : {}) }));
    }
    return Object.freeze(result);
}

export type LspFoldingClient = LspFeatureClient<"textDocument/foldingRange", LspDocumentRequest,
    Readonly<{ revision: number; ranges: readonly DiscoveredFold[]; isCurrent: () => boolean }>>;

export function createLspFoldingClient(provider: LspWorkspace): LspFoldingClient {
    const client = createLspClient(provider, "textDocument/foldingRange");
    return Object.freeze({ ...lspFeatureHandle(client),
        run: (request: LspDocumentRequest) => {
            const { document } = request;
            return client.request(request, "textDocument/foldingRange", () => ({}), value => value.decode(() =>
                Object.freeze({ revision: document.revision, ranges: decodeLspFoldingRanges(value.response, value.capture), isCurrent: value.isCurrent })));
        } });
}
