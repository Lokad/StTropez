import type { DocumentId, DocumentSnapshot, Workspace } from "../../src/index.ts";
import { LspSession, RpcError, decodeLspWorkspaceEdit } from "../../src/protocol/index.ts";
import type { LspCall, LspDocument, LspSessionOptions } from "../../src/protocol/index.ts";
import { captureLspProject, updateLspProject } from "./lsp-project.ts";

export type LspRenameConfiguration = Readonly<{ delay: number; fault?: "malformed" | "failure" }>;
export type LspRenameOptions = Readonly<{ connect: LspSessionOptions["connect"]; uri: (id: DocumentId) => string;
    beforeRequest?: (session: LspSession, configuration: LspRenameConfiguration) => Promise<unknown> }>;
export type LspRenameClient = ReturnType<typeof createLspRenameClient>;
export type LspRenameFactory = (clock: Pick<Window, "setTimeout" | "clearTimeout">) => LspRenameClient;

/** A rename response is a fixed provider edit batch for one captured new name. */
export function createLspRenameClient(workspace: Workspace, clock: Pick<Window, "setTimeout" | "clearTimeout">, options: LspRenameOptions) {
    const documents = new Map<string, LspDocument>(), listeners = new Set<() => void>(); let disposed = false, busy = false, serial = 0, created = 0, terminated = 0;
    const changed = () => { for (const listener of [...listeners]) listener(); };
    const session = new LspSession({ features: ["textDocument/rename"], workspaceEdits: true,
        schedule: (ms, callback) => { const timer = clock.setTimeout(callback, ms); return () => clock.clearTimeout(timer); }, connect: async context => {
            const transport = await options.connect(context); created++; let released = false;
            return { send: transport.send, subscribe: transport.subscribe, dispose: () => { if (released) return; released = true; terminated++; transport.dispose(); } };
        } });
    const stop = session.state.subscribe(changed);
    return Object.freeze({ subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        run: async (snapshots: readonly DocumentSnapshot[], origin: DocumentId, offset: number, newName: string, configuration: LspRenameConfiguration) => {
            if (disposed || busy) throw new Error("LSP rename is unavailable."); busy = true; const token = ++serial; let call: LspCall<unknown> | undefined;
            const current = () => { if (disposed || token !== serial) throw new RpcError(-32800, "LSP rename cancelled."); };
            try {
                updateLspProject(workspace, session, documents, snapshots.map(doc => ({ document: doc.id, revision: doc.revision, length: doc.buffer.length })), new Map(snapshots.map(doc => [doc.id, doc.buffer])), options.uri);
                await session.connect(); await session.flush(); current(); if (options.beforeRequest) await options.beforeRequest(session, configuration); current();
                const captures = captureLspProject(session, documents), source = documents.get(origin); if (!source) throw new Error("LSP rename origin is outside the captured project.");
                call = session.requestDocument("textDocument/rename", source, index => ({ position: index.at(offset), newName }));
                const value = await call.result; current(); const plan = decodeLspWorkspaceEdit(value === null ? {} : value, uri => captures.get(uri));
                const isCurrent = () => !disposed && token === serial && [...captures.values()].every(capture => capture.isCurrent());
                if (!isCurrent()) throw new RpcError(-32801, "LSP rename project capture expired."); return Object.freeze({ ...plan, isCurrent });
            } catch (error) { if (!disposed) { session.disconnect(); for (const doc of documents.values()) doc.close(); documents.clear(); } throw error; }
            finally { call?.cancel(); busy = false; changed(); }
        },
        faultIdle: () => { if (disposed || busy || session.state.getSnapshot().phase !== "ready") return false; session.disconnect(); return true; },
        snapshot: () => Object.freeze({ connected: session.state.getSnapshot().phase === "ready", busy, disposed, version: "LSP3.17", created, terminated, protocol: session.snapshotOwnership() }),
        dispose: () => { if (disposed) return; disposed = true; serial++; stop(); listeners.clear(); session.dispose(); documents.clear(); } });
}
