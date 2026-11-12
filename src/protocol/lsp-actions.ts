import type { DocumentId, DocumentSnapshot } from "../core/workspace.ts";
import { RpcError } from "./json-rpc.ts";
import { createLspClient } from "./lsp-client.ts";
import { decodeLspCodeActions, decodeLspResolvedCodeAction } from "./lsp-code-actions.ts";
import type { LspCodeAction } from "./lsp-code-actions.ts";
import type { LspPrepare, LspWorkspace } from "./lsp-workspace.ts";
import { createLspCommandRunner } from "./lsp-command.ts";
import type { LspCommandScope } from "./lsp-command.ts";

/** Reads share capture policy; confirmed commands retain their distinct mutation policy. */
export function createLspActionClient(provider: LspWorkspace) {
    const client = createLspClient(provider), session = client.scope;
    let executing = false, runner: ReturnType<typeof createLspCommandRunner> | undefined;
    const commands = () => runner ??= createLspCommandRunner(session, client.notify);
    const busy = () => executing || client.isBusy();
    return Object.freeze({ state: client.state, subscribe: client.subscribe, cancel: client.cancel,
        run: async (snapshots: readonly DocumentSnapshot[], origin: DocumentId, from: number, to: number, prepare?: LspPrepare) => {
            if (executing) throw new Error("A confirmed action command is still running.");
            const value = await client.request(snapshots, origin, "textDocument/codeAction", capture => {
                const index = capture.index;
                const document = session.attachDocument(origin);
                const diagnostics = session.observeDiagnostics(document).getSnapshot(), batch = diagnostics.result;
                // Unknown provider freshness never authorizes version-verified edit context.
                const known = diagnostics.isCurrent() && batch?.version === capture.version && batch.snapshotRevision === capture.document.revision ? batch.items : [];
                const overlapping = known.filter(item => item.from !== null && item.to !== null && (from === to ? item.from <= from && item.to >= to
                    : item.from === item.to ? from <= item.from && item.from <= to : item.from < to && item.to > from));
                return { range: { start: index.at(from), end: index.at(to) }, context: { triggerKind: 1, diagnostics: overlapping.map(item => ({
                    range: { start: index.at(item.from!), end: index.at(item.to!) }, message: item.message,
                    ...(item.severity === null ? {} : { severity: item.severity }), ...(item.source === null ? {} : { source: item.source }) })) } };
            }, prepare).result;
            const canResolve = session.featureOptions("textDocument/codeAction", value.target).some(options => options.resolveProvider === true);
            const actions = value.decode(() => decodeLspCodeActions(value.response, value.capture, uri => value.captures.get(uri), canResolve));
            const commandCurrent = value.isGenerationCurrent;
            return Object.freeze({ actions, isCurrent: value.isCurrent, commandCurrent,
                supports: (command: string) => commandCurrent() && session.commandNames().includes(command),
                execute: async (action: LspCodeAction, scope: LspCommandScope) => {
                    if (!value.isCurrent() || busy() || !actions.includes(action) || !action.command || action.disabled
                        || !session.commandNames().includes(action.command.command) || !provider.state.getSnapshot().commandAvailable) throw new RpcError(-32801, "Captured action command is unavailable or changed.");
                    executing = true;
                    try { return await commands().run(action.command.command, action.command.arguments, scope); }
                    finally { executing = false; client.notify(); }
                },
                resolve: async (action: LspCodeAction, prepareResolve?: LspPrepare) => {
                    if (!value.isCurrent() || busy() || !actions.includes(action) || !action.resolve) throw new RpcError(-32801, "Captured action cannot be resolved.");
                    const response = await value.follow("textDocument/codeAction", "codeAction/resolve", action.resolve, prepareResolve);
                    return value.decode(() => decodeLspResolvedCodeAction(response, action, value.capture, uri => value.captures.get(uri)));
                } });
        },
        snapshot: () => Object.freeze({ ...client.snapshot(), busy: busy(), version: "LSP3.17" }),
        dispose: () => { runner?.dispose(); client.dispose(); } });
}
