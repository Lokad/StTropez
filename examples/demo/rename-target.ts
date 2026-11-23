import type { CapturedViewRequest } from "../../src/browser/index.ts";
import { lspRangeOffsets, type LspWorkspace } from "../../src/protocol/index.ts";

/** Ask TypeScript which name it would rename at the captured caret. */
export async function prepareRenameTarget(provider: LspWorkspace, source: CapturedViewRequest, offset: number, maxNameLength: number): Promise<string | null> {
    const scope = provider.createScope();
    source.signal.addEventListener("abort", scope.dispose, { once: true });
    try {
        const document = scope.setDocuments([source.document]).get(source.document.id)!;
        const response = await scope.requestDocument("textDocument/prepareRename", document, index => ({ position: index.at(offset) })).result;
        if (response === null) return null;
        const captured = scope.synchronized(document);
        if (!captured || !source.isCurrent() || captured.document.buffer !== source.document.buffer) return null;
        if (typeof response !== "object" || Array.isArray(response)) throw new Error("Invalid rename range.");
        const { from, to } = lspRangeOffsets(captured.index, "range" in response ? response.range : response);
        // TypeScript can redirect a keyword to a neighboring declaration.
        if (from === to || offset < from || offset > to) return null;
        if ("placeholder" in response) {
            if (typeof response.placeholder !== "string") throw new Error("Invalid rename placeholder.");
            return response.placeholder.length <= maxNameLength ? response.placeholder : "";
        }
        return to - from <= maxNameLength ? source.document.buffer.slice(from, to) : "";
    } finally {
        source.signal.removeEventListener("abort", scope.dispose); scope.dispose();
    }
}
