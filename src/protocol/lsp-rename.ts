import type { DocumentId, DocumentSnapshot } from "../core/workspace.ts";
import { RpcError } from "./json-rpc.ts";
import { decodeLspWorkspaceEdit } from "./lsp-features.ts";
import type { LspCall, LspDocument } from "./lsp-session.ts";
import type { LspPrepare, LspWorkspace } from "./lsp-workspace.ts";
/** A rename response is a fixed provider edit batch for one captured new name. */
export function createLspRenameClient(provider: LspWorkspace) {
    const documents = new Map<string, LspDocument>(), listeners = new Set<() => void>(); let disposed = false, busy = false, serial = 0;
    const changed = () => { for (const listener of [...listeners]) { try { listener(); } catch { /* Observers cannot alter a completed provider operation. */ } } };
    const session = provider.createScope();
    const stop = session.state.subscribe(changed);
    return Object.freeze({ state: provider.state, subscribe: (listener: () => void) => { if (disposed) throw new Error("LSP rename client is disposed."); listeners.add(listener); return () => { listeners.delete(listener); }; },
        run: async (snapshots: readonly DocumentSnapshot[], origin: DocumentId, offset: number, newName: string, prepare?: LspPrepare) => {
            if (disposed || busy) throw new Error("LSP rename is unavailable."); busy = true; const token = ++serial; let call: LspCall<unknown> | undefined;
            const current = () => { if (disposed || token !== serial) throw new RpcError(-32800, "LSP rename cancelled."); };
            try {
                const bound = session.setDocuments(snapshots); documents.clear(); for (const [id, document] of bound) documents.set(id, document);
                await session.connect(); await session.flush(); current(); if (prepare) await prepare(session); current();
                const captures = session.captureProject(), source = documents.get(origin); if (!source) throw new Error("LSP rename origin is outside the captured project.");
                call = session.requestDocument("textDocument/rename", source, index => ({ position: index.at(offset), newName }));
                const value = await call.result; current(); const plan = decodeLspWorkspaceEdit(value === null ? {} : value, uri => captures.get(uri));
                const isCurrent = () => !disposed && token === serial && [...captures.values()].every(capture => capture.isCurrent());
                if (!isCurrent()) throw new RpcError(-32801, "LSP rename project capture expired."); return Object.freeze({ ...plan, isCurrent });
            } catch (error) { if (!disposed) { session.disconnect(); for (const doc of documents.values()) doc.close(); documents.clear(); } throw error; }
            finally { call?.cancel(); busy = false; changed(); }
        },
        cancel: () => { if (!disposed) { serial++; session.disconnect(); } },
        snapshot: () => Object.freeze({ connected: session.state.getSnapshot().phase === "ready", busy, disposed, version: "LSP3.17", protocol: session.snapshotOwnership() }),
        dispose: () => { if (disposed) return; disposed = true; serial++; stop(); listeners.clear(); session.dispose(); documents.clear(); } });
}
