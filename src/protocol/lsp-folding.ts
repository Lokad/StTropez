import { createLspClient } from "./lsp-client.ts";
import type { LspDocumentCapture } from "./lsp-session.ts";
import type { LspPrepare, LspWorkspace } from "./lsp-workspace.ts";
import type { DocumentSnapshot } from "../core/workspace.ts";
import type { DiscoveredFold } from "../core/fold-discovery.ts";

/** Complete-line LSP folding; malformed shapes fail the batch, invalid line ranges are ignored. */
export function decodeLspFoldingRanges(value: unknown, capture: LspDocumentCapture): readonly DiscoveredFold[] {
    if (!capture.isCurrent()) throw new Error("Stale folding capture.");
    if (value === null) return Object.freeze([]);
    if (!Array.isArray(value)) throw new TypeError("Expected LSP folding ranges.");
    const buffer = capture.document.buffer, result: DiscoveredFold[] = [];
    const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    for (const item of value) {
        if (!item || typeof item !== "object" || !integer(item.startLine) || !integer(item.endLine)
            || item.kind !== undefined && typeof item.kind !== "string") throw new TypeError("Malformed LSP folding range.");
        if (item.startLine >= item.endLine || item.endLine >= buffer.lineCount) continue;
        const from = buffer.offsetAt(item.startLine), to = item.endLine + 1 < buffer.lineCount ? buffer.offsetAt(item.endLine + 1) : buffer.length;
        if (from >= to || buffer.lineAt(to - 1) <= item.startLine) continue;
        result.push(Object.freeze({ from, to, ...(item.kind ? { group: item.kind } : {}) }));
    }
    return Object.freeze(result);
}

export function createLspFoldingClient(provider: LspWorkspace) {
    const client = createLspClient(provider);
    return Object.freeze({ state: client.state, subscribe: client.subscribe, snapshot: client.snapshot, cancel: client.cancel, dispose: client.dispose,
        run: (document: DocumentSnapshot, prepare?: LspPrepare) => {
            const call = client.request([document], document.id, "textDocument/foldingRange", () => ({}), prepare);
            return Object.freeze({ cancel: call.cancel, result: call.result.then(value => value.decode(() =>
                Object.freeze({ revision: document.revision, ranges: decodeLspFoldingRanges(value.response, value.capture), isCurrent: value.isCurrent }))) });
        } });
}
