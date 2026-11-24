import { documentHighlightMethod } from "./lsp-methods.ts";
import { ProtocolDecodeError, staleRequest } from "./wire.ts";
import { createLspClient, lspFeatureHandle, type LspFeatureClient, type LspPositionRequest } from "./lsp-client.ts";
import { lspRangeOffsets } from "./lsp-features.ts";
import type { LspDocumentCapture } from "./lsp-session.ts";
import type { LspWorkspace } from "./lsp-workspace.ts";

export type LspDocumentHighlight = Readonly<{ from: number; to: number; kind: "text" | "read" | "write" }>;
export type LspDocumentHighlights = Readonly<{ items: readonly LspDocumentHighlight[];
    intersect: (from: number, to: number) => readonly LspDocumentHighlight[] }>;
const empty: readonly LspDocumentHighlight[] = Object.freeze([]);

/** Complete response validation and an immutable interval index, including overlapping ranges. */
export function decodeLspDocumentHighlights(value: unknown, capture: LspDocumentCapture): LspDocumentHighlights {
    if (!capture.isCurrent()) throw staleRequest("LSP highlight capture expired.");
    if (value !== null && !Array.isArray(value)) throw new ProtocolDecodeError("Expected LSP document highlights.");
    const items = Object.freeze((value ?? []).map((item: unknown): LspDocumentHighlight => {
        if (!item || typeof item !== "object" || Array.isArray(item) || !("range" in item)) throw new ProtocolDecodeError("Malformed LSP document highlight.");
        const kind = "kind" in item ? item.kind : 1;
        if (kind !== 1 && kind !== 2 && kind !== 3) throw new ProtocolDecodeError("Invalid LSP highlight kind.");
        return Object.freeze({ ...lspRangeOffsets(capture.index, item.range), kind: kind === 2 ? "read" : kind === 3 ? "write" : "text" });
    }).sort((a: LspDocumentHighlight, b: LspDocumentHighlight) => a.from - b.from || a.to - b.to));
    // A subtree's maximum end lets clipped rows skip all nonintersecting occurrences, even
    // when one large enclosing range overlaps many small ranges. No array of source lines.
    let size = 1; while (size < items.length) size *= 2;
    const end = new Float64Array(size * 2);
    for (let i = 0; i < items.length; i++) end[size + i] = items[i]!.to;
    for (let node = size - 1; node > 0; node--) end[node] = Math.max(end[node * 2]!, end[node * 2 + 1]!);
    return Object.freeze({ items, intersect: (from: number, to: number): readonly LspDocumentHighlight[] => {
        if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || from > to || to > capture.document.buffer.length) throw new RangeError("Invalid highlight query.");
        if (from === to || !items.length) return empty;
        const result: LspDocumentHighlight[] = [];
        const visit = (node: number, first: number, last: number): void => {
            if (first >= items.length || end[node]! <= from || items[first]!.from >= to) return;
            if (last - first === 1) { if (items[first]!.from < items[first]!.to) result.push(items[first]!); return; }
            const middle = (first + last) / 2; visit(node * 2, first, middle); visit(node * 2 + 1, middle, last);
        };
        visit(1, 0, size); return result.length ? Object.freeze(result) : empty;
    } });
}

export type LspHighlightClient = LspFeatureClient<"textDocument/documentHighlight", LspPositionRequest,
    LspDocumentHighlights & Readonly<{ revision: number; isCurrent: () => boolean }>>;

export function createLspHighlightClient(provider: LspWorkspace): LspHighlightClient {
    const client = createLspClient(provider, documentHighlightMethod);
    return Object.freeze({ ...lspFeatureHandle(client),
        run: (request: LspPositionRequest) => {
            const { document, offset } = request;
            return client.request(request, documentHighlightMethod, capture => ({ position: capture.index.at(offset) }), value => value.decode(() => Object.freeze({
                revision: document.revision, ...decodeLspDocumentHighlights(value.response, value.capture), isCurrent: value.isCurrent })));
        } });
}
