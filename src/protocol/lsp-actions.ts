import { codeActionMethod } from "./lsp-methods.ts";
import { staleRequest, type JsonValue } from "./wire.ts";
import { createLspClient, lspFeatureHandle, type LspDocumentOwner, type LspFeatureClient, type LspProjectRequest } from "./lsp-client.ts";
import { decodeLspCodeActions, decodeLspResolvedCodeAction, lspCodeActionUris } from "./lsp-code-actions.ts";
import type { LspCodeAction, LspCodeActions } from "./lsp-code-actions.ts";
import type { LspCommand } from "./lsp-command-value.ts";
import type { LspPrepare, LspWorkspace } from "./lsp-workspace.ts";
import { commandRunner, type LspCommandRunner } from "./lsp-command.ts";
import type { LspCommandReceipt, LspCommandPolicy, LspCommandRoute, LspCommandScope } from "./lsp-command.ts";

export type LspActionRequest = LspProjectRequest & Readonly<{ from: number; to: number }>;
export type LspActionOptions = Readonly<{ commandPolicy?: LspCommandPolicy }>;

export type LspActionResult = Readonly<{
    actions: LspCodeActions; isCurrent: () => boolean; commandCurrent: () => boolean; supports: (command: LspCommand) => boolean;
    execute: (action: LspCodeAction, scope: LspCommandScope) => Promise<LspCommandReceipt>;
    resolve: (action: LspCodeAction, prepare?: LspPrepare) => Promise<LspCodeAction>;
    cancelResolve: () => void;
}>;
export type LspActionClient = LspFeatureClient<"textDocument/codeAction", LspActionRequest, LspActionResult>;

/** Reads share capture policy; confirmed commands retain their distinct mutation policy. */
export const createLspActionClient: (provider: LspWorkspace, options?: LspActionOptions) => LspActionClient = actionClient;

export function actionClient(owner: LspWorkspace | LspDocumentOwner, options: LspActionOptions = {}): LspActionClient {
    const client = createLspClient(owner, codeActionMethod), session = client.scope;
    let executing = false, runner: LspCommandRunner | undefined;
    let resolver: ReturnType<typeof createLspClient<"textDocument/codeAction">> | undefined;
    const releaseResolve = () => { const previous = resolver; resolver = undefined; previous?.dispose(); };
    const busy = () => executing || client.isBusy() || !!resolver?.isBusy();
    return Object.freeze({ ...lspFeatureHandle(client, { isBusy: busy,
        cancel: () => { releaseResolve(); runner?.cancel(); client.cancel(); }, dispose: () => { releaseResolve(); runner?.dispose(); client.dispose(); } }),
        run: (request: LspActionRequest) => {
            const { document, from, to } = request;
            if (executing) return Object.freeze({ result: Promise.reject(new Error("A confirmed action command is still running.")), cancel: () => {} });
            releaseResolve();
            const captured = request.project ? { ...request, project: [...request.project] } : request;
            return client.request(captured, codeActionMethod, capture => {
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
                const canResolve = session.featureOptions(codeActionMethod, value.target).some(options => options.resolveProvider === true);
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
                        if (!value.isCurrent() || busy() || !actions.includes(action) || !action.command || !route)
                            throw staleRequest("Captured action command is unavailable.");
                        // The runner rechecks the route and reserves the connection before applying the initial edit.
                        executing = true;
                        try {
                            runner ??= commandRunner(session, client.notify, client.setDocuments);
                            return await runner.runAuthorized(action.command, scope, route);
                        }
                        finally { executing = false; client.notify(); }
                    },
                    cancelResolve: () => { if (value.isGenerationCurrent()) releaseResolve(); },
                    resolve: async (action: LspCodeAction, prepare?: LspPrepare) => {
                        if (!value.isCurrent() || executing || !actions.includes(action) || !action.resolve) throw staleRequest("Captured action cannot be resolved.");
                        releaseResolve();
                        // The choice owns its wire request, host target loads and leases. The list keeps its original capture.
                        const lane = resolver = createLspClient(owner, codeActionMethod);
                        lane.subscribe(client.notify);
                        try {
                            return await lane.request({ ...captured, prepare }, codeActionMethod,
                                () => value.decode(() => action.resolve as Record<string, JsonValue>), async reply => {
                                    const missing = reply.decode(() => lspCodeActionUris([reply.response])).filter(uri => !value.targetForUri(uri));
                                    await reply.resolveTargets(missing, "edit");
                                    return reply.decode(() => value.decode(() => decodeLspResolvedCodeAction(reply.response, action, value.capture,
                                        uri => value.targetForUri(uri) ?? reply.targetForUri(uri))));
                                }, "codeAction/resolve").result;
                        } catch (error) {
                            if (resolver === lane) {
                                releaseResolve();
                                if (value.isGenerationCurrent()) value.decode(() => { throw error; });
                            }
                            throw error;
                        }
                    } });
            });
        } });
}
