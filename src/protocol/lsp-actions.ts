import { staleRequest } from "./wire.ts";
import { createLspClient, lspFeatureHandle, type LspFeatureClient, type LspProjectClientDiagnostics, type LspProjectRequest } from "./lsp-client.ts";
import { decodeLspCodeActions, decodeLspResolvedCodeAction, lspCodeActionUris } from "./lsp-code-actions.ts";
import type { LspCodeAction, LspCodeActions } from "./lsp-code-actions.ts";
import type { LspCommand } from "./lsp-command-value.ts";
import type { LspPrepare, LspWorkspace } from "./lsp-workspace.ts";
import { createLspCommandRunner, type LspCommandRunner } from "./lsp-command.ts";
import type { LspCommandReceipt, LspCommandPolicy, LspCommandRoute, LspCommandScope } from "./lsp-command.ts";

export type LspActionRequest = LspProjectRequest & Readonly<{ from: number; to: number }>;
export type LspActionOptions = Readonly<{ commandPolicy?: LspCommandPolicy }>;

export type LspActionResult = Readonly<{
    actions: LspCodeActions; isCurrent: () => boolean; commandCurrent: () => boolean; supports: (command: LspCommand) => boolean;
    execute: (action: LspCodeAction, scope: LspCommandScope) => Promise<LspCommandReceipt>;
    resolve: (action: LspCodeAction, prepare?: LspPrepare) => Promise<LspCodeAction>;
}>;
export type LspActionClient = LspFeatureClient<"textDocument/codeAction", LspActionRequest, LspActionResult, LspProjectClientDiagnostics>;

/** Reads share capture policy; confirmed commands retain their distinct mutation policy. */
export function createLspActionClient(provider: LspWorkspace, options: LspActionOptions = {}): LspActionClient {
    const client = createLspClient(provider, "textDocument/codeAction"), session = client.scope;
    let executing = false, runner: LspCommandRunner | undefined;
    const commands = () => runner ??= createLspCommandRunner(session, client.notify);
    const busy = () => executing || client.isBusy();
    return Object.freeze({ ...lspFeatureHandle(client, { isBusy: busy,
        cancel: () => { runner?.cancel(); client.cancel(); }, dispose: () => { runner?.dispose(); client.dispose(); } }),
        run: (request: LspActionRequest) => {
            const { document, from, to } = request;
            if (executing) return Object.freeze({ result: Promise.reject(new Error("A confirmed action command is still running.")), cancel: () => {} });
            return client.request(request, "textDocument/codeAction", capture => {
                const index = capture.index;
                const target = session.attachDocument(document.id);
                const diagnostics = session.observeDiagnostics(target).getSnapshot(), batch = diagnostics.result;
                // Unknown provider freshness never authorizes version-verified edit context.
                const known = diagnostics.isCurrent() && batch?.version === capture.version && batch.snapshotRevision === capture.document.revision ? batch.items : [];
                const overlapping = known.filter(item => item.from !== null && item.to !== null && (from === to ? item.from <= from && item.to >= to
                    : item.from === item.to ? from <= item.from && item.from <= to : item.from < to && item.to > from));
                return { range: { start: index.at(from), end: index.at(to) }, context: { triggerKind: 1, diagnostics: overlapping.map(item => {
                    const { placement: _placement, from: _from, to: _to, severity, source, ...wire } = item;
                    return { ...wire, ...(severity === null ? {} : { severity }), ...(source === null ? {} : { source }) };
                }) } };
            }, async value => {
                const canResolve = session.featureOptions("textDocument/codeAction", value.target).some(options => options.resolveProvider === true);
                const uris = value.decode(() => lspCodeActionUris(value.response)); await value.resolveTargets(uris, "edit");
                const actions = value.decode(() => decodeLspCodeActions(value.response, value.capture, value.targetForUri, canResolve));
                const commandCurrent = value.isGenerationCurrent;
                const routes = new Map<LspCommand, LspCommandRoute>();
                for (const action of actions) if (action.command && !action.disabled) {
                    const route = options.commandPolicy ? options.commandPolicy(action.command)
                        : session.commandNames().includes(action.command.command) ? { kind: "server" as const, isCurrent: () => session.commandNames().includes(action.command!.command) } : null;
                    if (route) routes.set(action.command, Object.freeze({ ...route }));
                }
                return Object.freeze({ actions, isCurrent: value.isCurrent, commandCurrent,
                    supports: (command: LspCommand) => commandCurrent() && routes.has(command) && (routes.get(command)!.isCurrent?.() ?? true),
                    execute: async (action: LspCodeAction, scope: LspCommandScope) => {
                        const route = action.command && routes.get(action.command);
                        if (!value.isCurrent() || busy() || !actions.includes(action) || !action.command || action.disabled
                            || !route || !(route.isCurrent?.() ?? true) || !provider.getSnapshot().commandAvailable) throw staleRequest("Captured action command is unavailable or changed.");
                        executing = true;
                        try { return await commands().runAuthorized(action.command, scope, route); }
                        finally { executing = false; client.notify(); }
                    },
                    resolve: async (action: LspCodeAction, prepareResolve?: LspPrepare) => {
                        if (!value.isCurrent() || busy() || !actions.includes(action) || !action.resolve) throw staleRequest("Captured action cannot be resolved.");
                        const response = await value.follow("textDocument/codeAction", "codeAction/resolve", action.resolve, prepareResolve);
                        const uris = value.decode(() => lspCodeActionUris([response])); await value.resolveTargets(uris, "edit");
                        return value.decode(() => decodeLspResolvedCodeAction(response, action, value.capture, value.targetForUri));
                    } });
            });
        },
        snapshot: () => Object.freeze({ ...client.snapshot(), busy: busy(), version: "LSP3.17" }) });
}
