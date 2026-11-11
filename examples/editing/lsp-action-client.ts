import type { DocumentId, DocumentSnapshot, Workspace } from "../../src/index.ts";
import { RpcError, decodeLspCodeActions, decodeLspResolvedCodeAction } from "../../src/protocol/index.ts";
import type { LspCall, LspCodeAction, LspDocument, LspDocumentCapture, LspSessionAccess, LspWorkspace } from "../../src/protocol/index.ts";
import { captureLspProject, updateLspProject } from "./lsp-project.ts";
import { createLspCommandRunner } from "../../src/protocol/index.ts";
import type { LspCommandScope } from "../../src/protocol/index.ts";

export type LspActionConfiguration = Readonly<{ module: string; delay: number; fault?: "malformed" | "failure" | "incomplete" | "markup" }>;
export type LspActionOptions = Readonly<{ provider: LspWorkspace;
    beforeRequest?: (session: LspSessionAccess, configuration: LspActionConfiguration) => Promise<unknown>;
    beforeResolve?: (session: LspSessionAccess, configuration: LspActionConfiguration) => Promise<unknown> }>;
export type LspActionClient = ReturnType<typeof createLspActionClient>;
export type LspActionBatch = Awaited<ReturnType<LspActionClient["run"]>>;
export type LspActionFactory = (clock: Pick<Window, "setTimeout" | "clearTimeout">) => LspActionClient;

/** Discovery/resolve and confirmed commands. Every mutation belongs to a captured host decision. */
export function createLspActionClient(workspace: Workspace, _clock: Pick<Window, "setTimeout" | "clearTimeout">, options: LspActionOptions) {
    const documents = new Map<string, LspDocument>(), listeners = new Set<() => void>(); let disposed = false, busy = false, serial = 0;
    const changed = () => { for (const listener of [...listeners]) listener(); };
    const session = options.provider.createScope();
    const runner = createLspCommandRunner(session, changed);
    return Object.freeze({ subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        run: async (snapshots: readonly DocumentSnapshot[], origin: DocumentId, from: number, to: number, configuration: LspActionConfiguration) => {
            if (disposed || busy) throw new Error("LSP code actions are unavailable."); busy = true; const token = ++serial; let call: LspCall<unknown> | undefined;
            const current = () => { if (disposed || token !== serial) throw new RpcError(-32800, "LSP code actions cancelled."); };
            const failed = () => { if (!disposed) { session.disconnect(); for (const doc of documents.values()) doc.close(); documents.clear(); } };
            try {
                updateLspProject(workspace, session, documents, snapshots.map(doc => ({ document: doc.id, revision: doc.revision, length: doc.buffer.length })), new Map(snapshots.map(doc => [doc.id, doc.buffer])));
                const document = documents.get(origin); if (!document) throw new Error("Code-action source is outside the captured project.");
                await session.connect(); await session.flush(); current(); if (options.beforeRequest) await options.beforeRequest(session, configuration); current();
                const captures = captureLspProject(session, documents), canResolve = session.featureOptions("textDocument/codeAction", document).some(options => options.resolveProvider === true); let capture: LspDocumentCapture | undefined;
                call = session.requestDocument("textDocument/codeAction", document, (index, _snapshot, captured) => {
                    capture = captured;
                    // Unknown provider freshness never becomes version-verified edit context.
                    const diagnostics = session.observeDiagnostics(document).getSnapshot(), value = diagnostics.result;
                    const known = diagnostics.isCurrent() && value?.version === captured.version && value.snapshotRevision === captured.document.revision ? value.items : [];
                    const overlapping = known.filter(item => item.from !== null && item.to !== null && (from === to ? item.from <= from && item.to >= to : item.from === item.to ? from <= item.from && item.from <= to : item.from < to && item.to > from));
                    return { range: { start: index.at(from), end: index.at(to) }, context: { triggerKind: 1, diagnostics: overlapping.map(item => ({ range: { start: index.at(item.from!), end: index.at(item.to!) }, message: item.message,
                        ...(item.severity === null ? {} : { severity: item.severity }), ...(item.source === null ? {} : { source: item.source }) })) } };
                });
                const value = await call.result; current(); const actions = decodeLspCodeActions(value, capture!, uri => captures.get(uri), canResolve);
                const isCurrent = () => !disposed && token === serial && [...captures.values()].every(capture => capture.isCurrent());
                const state = session.state.getSnapshot(), commandCurrent = () => !disposed && token === serial && session.state.getSnapshot().phase === "ready"
                    && session.state.getSnapshot().epoch === state.epoch && session.state.getSnapshot().registrationGeneration === state.registrationGeneration;
                if (!isCurrent()) throw new RpcError(-32801, "LSP code-action project capture expired.");
                return Object.freeze({ actions, isCurrent, commandCurrent, supports: (command: string) => commandCurrent() && session.commandNames().includes(command),
                    execute: async (action: LspCodeAction, scope: LspCommandScope) => {
                        if (!isCurrent() || busy || !actions.includes(action) || !action.command || action.disabled || !session.commandNames().includes(action.command.command)) throw new RpcError(-32801, "Captured action command is unavailable or changed.");
                        busy = true; try { return await runner.run(action.command.command, action.command.arguments, scope); } finally { busy = false; changed(); }
                    }, resolve: async (action: LspCodeAction, configuration: LspActionConfiguration) => {
                    if (!isCurrent() || busy || !actions.includes(action) || !action.resolve || !session.featureOptions("textDocument/codeAction", document).some(options => options.resolveProvider === true)) throw new RpcError(-32801, "Captured action cannot be resolved.");
                    busy = true; let resolution: LspCall<unknown> | undefined;
                    try { if (options.beforeResolve) await options.beforeResolve(session, configuration); current(); if (!isCurrent()) throw new RpcError(-32801, "LSP action capture expired.");
                        resolution = session.request("codeAction/resolve", action.resolve); const value = await resolution.result; current(); if (!isCurrent()) throw new RpcError(-32801, "LSP action capture expired.");
                        return decodeLspResolvedCodeAction(value, action, capture!, uri => captures.get(uri));
                    } finally { resolution?.cancel(); busy = false; changed(); }
                } });
            } catch (error) { failed(); throw error; }
            finally { call?.cancel(); busy = false; changed(); }
        },
        faultIdle: () => { if (disposed || busy || session.state.getSnapshot().phase !== "ready") return false; options.provider.disconnect(); return true; },
        snapshot: () => Object.freeze({ connected: session.state.getSnapshot().phase === "ready", busy, disposed, version: "LSP3.17", created: 0, terminated: 0, shared: true, protocol: session.snapshotOwnership() }),
        dispose: () => { if (disposed) return; disposed = true; serial++; runner.dispose(); listeners.clear(); session.dispose(); documents.clear(); } });
}
