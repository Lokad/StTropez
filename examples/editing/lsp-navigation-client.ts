import type { DocumentId, TextBuffer, Workspace } from "../../src/index.ts";
import { createLspNavigationClient as createClient } from "../../src/protocol/index.ts";
import type { LspSessionAccess, LspWorkspace } from "../../src/protocol/index.ts";
import type { NavigationInput } from "../../fixtures/language/navigation.ts";
import { validateNavigationInput } from "../../fixtures/language/navigation.ts";
import type { NavigationMetrics } from "./navigation-client.ts";
import type { NavigationService, NavigationOrigin } from "./navigation-service.ts";
export type LspNavigationOptions = Readonly<{ provider: LspWorkspace;
    beforeRequest?: (session: LspSessionAccess, input: NavigationInput) => Promise<unknown> }>;

/** Development query/counter contracts around the exported protocol client. */
export function createLspNavigationClient(workspace: Workspace, counts: NavigationMetrics,
    changed: () => void, options: LspNavigationOptions): NavigationService {
    const client = createClient(options.provider), stop = client.state.subscribe(changed);
    return Object.freeze({
        run: async (capture: NavigationInput, buffers: ReadonlyMap<string, TextBuffer>, progress: (work: number) => void, fault?: unknown, origin?: NavigationOrigin) => {
            if (fault !== undefined) throw new Error("Worker-v1 synchronization faults do not apply to the LSP transport.");
            const input = validateNavigationInput(capture); if (!origin || !input.documents.some(document => document.document === origin.document)) throw new Error("LSP navigation requires its captured origin.");
            const snapshots = input.documents.map(document => { const current = workspace.document(document.document as DocumentId);
                if (current.revision !== document.revision || current.buffer !== buffers.get(document.document) || current.buffer.length !== document.length || current.key.variant !== "working") throw new Error("Document is outside the captured working project."); return current; });
            try {
                const result = await client.run(snapshots, origin.document as DocumentId, origin.offset, input.kind, input.includeDeclaration,
                    options.beforeRequest ? session => options.beforeRequest!(session, input) : undefined);
                counts.completed++; progress(input.documents.reduce((sum, document) => sum + document.length, 0));
                return Object.freeze({ operation: "navigation-result" as const, id: input.id, locations: Object.freeze(result.locations.map(location => Object.freeze({
                    document: location.target.document.documentId, revision: location.target.document.revision, from: location.from, to: location.to, declaration: input.kind === "definition" }))),
                    truncated: false, isCurrent: result.isCurrent });
            } catch (error) { counts.failed++; throw error; } finally { changed(); }
        }, snapshot: client.snapshot, dispose: () => { stop(); client.dispose(); } });
}
