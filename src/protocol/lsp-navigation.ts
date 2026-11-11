import type { DocumentId, DocumentSnapshot } from "../core/workspace.ts";
import { RpcError } from "./json-rpc.ts";
import { decodeLspLocations } from "./lsp-features.ts";
import type { LspCall, LspDocument } from "./lsp-session.ts";
import type { LspPrepare, LspWorkspace } from "./lsp-workspace.ts";

/** Captured read-only project queries; the host chooses how to present/open each validated target. */
export function createLspNavigationClient(provider: LspWorkspace) {
    const session = provider.createScope(), documents = new Map<string, LspDocument>(); let busy = false, disposed = false, sequence = 0;
    return Object.freeze({ state: provider.state,
        run: async (snapshots: readonly DocumentSnapshot[], origin: DocumentId, offset: number, kind: "definition" | "references", includeDeclaration = true, prepare?: LspPrepare) => {
            if (disposed || busy) throw new Error("LSP navigation request is unavailable.");
            if (kind !== "definition" && kind !== "references" || typeof includeDeclaration !== "boolean") throw new TypeError("Invalid LSP navigation query.");
            busy = true; const serial = ++sequence; let call: LspCall<unknown> | undefined;
            const current = () => { if (disposed || serial !== sequence) throw new RpcError(-32800, "LSP navigation cancelled."); };
            try {
                const bound = session.setDocuments(snapshots); documents.clear(); for (const [id, document] of bound) documents.set(id, document);
                await session.connect(); await session.flush(); current(); if (prepare) await prepare(session); current();
                const captures = session.captureProject(), originDocument = documents.get(origin); if (!originDocument) throw new Error("LSP navigation origin is outside the captured project.");
                let source = session.synchronized(originDocument)!;
                call = session.requestDocument(kind === "definition" ? "textDocument/definition" : "textDocument/references", originDocument, (index, _snapshot, captured) => {
                    source = captured; return { position: index.at(offset), ...(kind === "references" ? { context: { includeDeclaration } } : {}) };
                });
                const value = await call.result; current(); const locations = decodeLspLocations(value, kind, source, uri => captures.get(uri));
                const isCurrent = () => !disposed && serial === sequence && [...captures.values()].every(capture => capture.isCurrent());
                if (!isCurrent()) throw new RpcError(-32801, "Captured LSP project changed."); return Object.freeze({ locations, isCurrent });
            } catch (error) { if (!disposed) { session.disconnect(); for (const document of documents.values()) document.close(); documents.clear(); } throw error; }
            finally { call?.cancel(); busy = false; }
        },
        cancel: () => { if (!disposed) { sequence++; session.disconnect(); } },
        snapshot: () => Object.freeze({ connected: session.state.getSnapshot().phase === "ready", busy, disposed, version: "LSP3.17", epoch: session.state.getSnapshot().epoch, sequence,
            documents: Object.freeze([...documents.values()].flatMap(document => { const capture = session.synchronized(document); return capture ? [Object.freeze({ document: capture.document.documentId, revision: capture.document.revision, length: capture.document.buffer.length })] : []; })), protocol: session.snapshotOwnership() }),
        dispose: () => { if (disposed) return; disposed = true; sequence++; session.dispose(); documents.clear(); } });
}
