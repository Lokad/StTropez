import type { DocumentId, TextBuffer, Workspace } from "../../src/index.ts";
import { LspSession, RpcError, decodeLspLocations } from "../../src/protocol/index.ts";
import type { LspCall, LspDocument, LspSessionOptions } from "../../src/protocol/index.ts";
import type { NavigationInput } from "../probes/navigation.ts";
import { validateNavigationInput } from "../probes/navigation.ts";
import type { NavigationMetrics } from "./navigation-client.ts";
import type { NavigationService, NavigationOrigin } from "./navigation-service.ts";

export type LspNavigationOptions = Readonly<{ connect: LspSessionOptions["connect"]; uri: (document: DocumentId) => string;
    beforeRequest?: (session: LspSession, input: NavigationInput) => Promise<unknown> }>;

/** One host-owned project connection. Only captured working resources can resolve a location URI. */
export function createLspNavigationClient(workspace: Workspace, clock: Pick<Window, "setTimeout" | "clearTimeout">, counts: NavigationMetrics,
    changed: () => void, options: LspNavigationOptions): NavigationService {
    const documents = new Map<string, LspDocument>(); let busy = false, disposed = false, sequence = 0;
    const session = new LspSession({ schedule: (ms, callback) => { const timer = clock.setTimeout(callback, ms); return () => clock.clearTimeout(timer); },
        features: ["textDocument/definition", "textDocument/references"], connect: async context => {
            const transport = await options.connect(context); counts.created++; let released = false;
            return { send: message => { counts.posted++; transport.send(message); }, subscribe: listener => transport.subscribe({ message: message => { counts.received++; listener.message(message); }, close: listener.close }),
                dispose: () => { if (released) return; released = true; counts.terminated++; transport.dispose(); } };
        } });
    const stopState = session.state.subscribe(changed);
    const run = async (capture: NavigationInput, buffers: ReadonlyMap<string, TextBuffer>, progress: (work: number) => void, fault?: unknown, origin?: NavigationOrigin) => {
        if (disposed || busy) throw new Error("LSP navigation request is unavailable.");
        if (fault !== undefined) throw new Error("Worker-v1 synchronization faults do not apply to the LSP transport.");
        const input = validateNavigationInput(capture); if (!origin || !input.documents.some(doc => doc.document === origin.document)) throw new Error("LSP navigation requires its captured origin.");
        busy = true; const serial = ++sequence; let call: LspCall<unknown> | undefined;
        const current = () => { if (disposed || serial !== sequence) throw new RpcError(-32800, "LSP navigation cancelled."); };
        try {
            const ids = new Set(input.documents.map(doc => doc.document)), uris = new Set<string>();
            const snapshots = input.documents.map(doc => {
                const buffer = buffers.get(doc.document), resource = workspace.resourceForDocument(doc.document as DocumentId);
                if (!buffer || buffer.length !== doc.length || workspace.document(doc.document as DocumentId).key.variant !== "working") throw new Error("LSP navigation buffer is outside its captured scope.");
                const uri = options.uri(doc.document as DocumentId); if (uris.has(uri)) throw new Error("LSP host URI mapping must be unique."); uris.add(uri);
                return { uri, languageId: "fixture", resourceId: resource.id, documentId: doc.document, revision: doc.revision, buffer };
            });
            for (const [id, document] of documents) if (!ids.has(id) || !snapshots.some(snapshot => snapshot.documentId === id && snapshot.resourceId === document.getSnapshot().resourceId && snapshot.uri === document.getSnapshot().uri)) { document.close(); documents.delete(id); }
            // Shrink before growing, so a valid final project does not fail a transient total-size bound.
            snapshots.sort((a, b) => (a.buffer.length - (documents.get(a.documentId)?.getSnapshot().buffer.length ?? 0)) - (b.buffer.length - (documents.get(b.documentId)?.getSnapshot().buffer.length ?? 0)));
            for (const snapshot of snapshots) {
                const document = documents.get(snapshot.documentId);
                if (!document) documents.set(snapshot.documentId, session.bindDocument(snapshot));
                else if (document.getSnapshot().revision !== snapshot.revision) document.update(document.getSnapshot().revision, snapshot.revision, snapshot.buffer);
                else if (document.getSnapshot().buffer !== snapshot.buffer) throw new Error("A navigation revision cannot name different buffers.");
            }
            await session.connect(); await session.flush(); current();
            if (options.beforeRequest) await options.beforeRequest(session, input); current();
            const captures = new Map([...documents.values()].map(document => { const captured = session.synchronized(document); if (!captured) throw new Error("LSP project synchronization is incomplete."); return [captured.document.uri, captured] as const; }));
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
