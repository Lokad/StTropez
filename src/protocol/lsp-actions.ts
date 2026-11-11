import type { DocumentId, DocumentSnapshot } from "../core/workspace.ts";
import { RpcError } from "./json-rpc.ts";
import { decodeLspCodeActions, decodeLspResolvedCodeAction } from "./lsp-code-actions.ts";
import type { LspCall, LspDocument, LspDocumentCapture } from "./lsp-session.ts";
import type { LspCodeAction } from "./lsp-code-actions.ts";
import type { LspPrepare, LspWorkspace } from "./lsp-workspace.ts";
import { createLspCommandRunner } from "./lsp-command.ts";
import type { LspCommandScope } from "./lsp-command.ts";

/** Discovery/resolve and confirmed commands. Every mutation belongs to a captured host decision. */
export function createLspActionClient(provider: LspWorkspace) {
    const documents = new Map<string, LspDocument>(), listeners = new Set<() => void>(); let disposed = false, busy = false, serial = 0;
    const changed = () => { for (const listener of [...listeners]) { try { listener(); } catch { /* Observers cannot alter a completed provider operation. */ } } };
    const session = provider.createScope();
    const stopState = session.state.subscribe(changed);
    let runner: ReturnType<typeof createLspCommandRunner> | undefined;
    const commands = () => runner ??= createLspCommandRunner(session, changed);
    return Object.freeze({ state: provider.state, subscribe: (listener: () => void) => { if (disposed) throw new Error("LSP action client is disposed."); listeners.add(listener); return () => { listeners.delete(listener); }; },
        run: async (snapshots: readonly DocumentSnapshot[], origin: DocumentId, from: number, to: number, prepare?: LspPrepare) => {
            if (disposed || busy) throw new Error("LSP code actions are unavailable."); busy = true; const token = ++serial; let call: LspCall<unknown> | undefined;
            const current = () => { if (disposed || token !== serial) throw new RpcError(-32800, "LSP code actions cancelled."); };
            const failed = () => { if (!disposed) { session.disconnect(); for (const doc of documents.values()) doc.close(); documents.clear(); } };
            try {
                const bound = session.setDocuments(snapshots); documents.clear(); for (const [id, document] of bound) documents.set(id, document);
                const document = documents.get(origin); if (!document) throw new Error("Code-action source is outside the captured project.");
                await session.connect(); await session.flush(); current(); if (prepare) await prepare(session); current();
                const captures = session.captureProject(), canResolve = session.featureOptions("textDocument/codeAction", document).some(options => options.resolveProvider === true); let capture: LspDocumentCapture | undefined;
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
                        if (!isCurrent() || busy || !actions.includes(action) || !action.command || action.disabled || !session.commandNames().includes(action.command.command) || !provider.state.getSnapshot().commandAvailable) throw new RpcError(-32801, "Captured action command is unavailable or changed.");
                        busy = true; try { return await commands().run(action.command.command, action.command.arguments, scope); } finally { busy = false; changed(); }
                    }, resolve: async (action: LspCodeAction, prepareResolve?: LspPrepare) => {
                    if (!isCurrent() || busy || !actions.includes(action) || !action.resolve || !session.featureOptions("textDocument/codeAction", document).some(options => options.resolveProvider === true)) throw new RpcError(-32801, "Captured action cannot be resolved.");
                    busy = true; let resolution: LspCall<unknown> | undefined;
                    try { if (prepareResolve) await prepareResolve(session); current(); if (!isCurrent()) throw new RpcError(-32801, "LSP action capture expired.");
                        resolution = session.request("codeAction/resolve", action.resolve); const value = await resolution.result; current(); if (!isCurrent()) throw new RpcError(-32801, "LSP action capture expired.");
                        return decodeLspResolvedCodeAction(value, action, capture!, uri => captures.get(uri));
                    } finally { resolution?.cancel(); busy = false; changed(); }
                } });
            } catch (error) { failed(); throw error; }
            finally { call?.cancel(); busy = false; changed(); }
        },
        cancel: () => { if (!disposed) { serial++; session.disconnect(); } },
        snapshot: () => Object.freeze({ connected: session.state.getSnapshot().phase === "ready", busy, disposed, version: "LSP3.17", protocol: session.snapshotOwnership() }),
        dispose: () => { if (disposed) return; disposed = true; serial++; stopState(); runner?.dispose(); listeners.clear(); session.dispose(); documents.clear(); } });
}
