import type { TextBuffer, Workspace } from "../../src/index.ts";
import { RpcError, decodeLspLocations } from "../../src/protocol/index.ts";
import type { LspCall, LspDocument, LspSessionAccess, LspWorkspace } from "../../src/protocol/index.ts";
import { captureLspProject, updateLspProject } from "./lsp-project.ts";
import type { NavigationInput } from "../probes/navigation.ts";
import { validateNavigationInput } from "../probes/navigation.ts";
import type { NavigationMetrics } from "./navigation-client.ts";
import type { NavigationService, NavigationOrigin } from "./navigation-service.ts";

export type LspNavigationOptions = Readonly<{ provider: LspWorkspace;
    beforeRequest?: (session: LspSessionAccess, input: NavigationInput) => Promise<unknown> }>;

/** One host-owned project connection. Only captured working resources can resolve a location URI. */
export function createLspNavigationClient(workspace: Workspace, _clock: Pick<Window, "setTimeout" | "clearTimeout">, counts: NavigationMetrics,
    changed: () => void, options: LspNavigationOptions): NavigationService {
    const documents = new Map<string, LspDocument>(); let busy = false, disposed = false, sequence = 0;
    const session = options.provider.createScope();
    const stopState = session.state.subscribe(changed);
    const run = async (capture: NavigationInput, buffers: ReadonlyMap<string, TextBuffer>, progress: (work: number) => void, fault?: unknown, origin?: NavigationOrigin) => {
        if (disposed || busy) throw new Error("LSP navigation request is unavailable.");
        if (fault !== undefined) throw new Error("Worker-v1 synchronization faults do not apply to the LSP transport.");
        const input = validateNavigationInput(capture); if (!origin || !input.documents.some(doc => doc.document === origin.document)) throw new Error("LSP navigation requires its captured origin.");
        busy = true; const serial = ++sequence; let call: LspCall<unknown> | undefined;
        const current = () => { if (disposed || serial !== sequence) throw new RpcError(-32800, "LSP navigation cancelled."); };
        try {
            updateLspProject(workspace, session, documents, input.documents, buffers);
            await session.connect(); await session.flush(); current();
            if (options.beforeRequest) await options.beforeRequest(session, input); current();
            const captures = captureLspProject(session, documents);
            const originDocument = documents.get(origin.document)!; let source = session.synchronized(originDocument)!;
            call = session.requestDocument(input.kind === "definition" ? "textDocument/definition" : "textDocument/references", originDocument, (index, _snapshot, captured) => {
                source = captured; return { position: index.at(origin.offset), ...(input.kind === "references" ? { context: { includeDeclaration: input.includeDeclaration } } : {}) };
            });
            const result = await call.result; current();
            const locations = decodeLspLocations(result, input.kind, source, uri => captures.get(uri)).map(location => Object.freeze({ document: location.target.document.documentId,
                revision: location.target.document.revision, from: location.from, to: location.to, declaration: input.kind === "definition" }));
            for (const captured of captures.values()) if (!captured.isCurrent()) throw new RpcError(-32801, "Captured LSP project changed.");
            counts.completed++; progress(input.documents.reduce((sum, doc) => sum + doc.length, 0));
            return Object.freeze({ operation: "navigation-result" as const, id: input.id, locations: Object.freeze(locations), truncated: false,
                isCurrent: () => !disposed && serial === sequence && [...captures.values()].every(capture => capture.isCurrent()) });
        } catch (error) { counts.failed++; if (!disposed) { session.disconnect(); for (const doc of documents.values()) doc.close(); documents.clear(); } throw error; }
        finally { call?.cancel(); busy = false; changed(); }
    };
    return Object.freeze({ run, snapshot: () => Object.freeze({ connected: session.state.getSnapshot().phase === "ready", busy, disposed, version: "LSP3.17", epoch: session.state.getSnapshot().epoch, sequence,
        documents: Object.freeze([...documents.values()].flatMap(document => { const captured = session.synchronized(document); if (!captured) return []; const doc = captured.document; return [Object.freeze({ document: doc.documentId, revision: doc.revision, length: doc.buffer.length })]; })), protocol: session.snapshotOwnership() }),
        dispose: () => { if (disposed) return; disposed = true; sequence++; stopState(); session.dispose(); documents.clear(); } });
}
