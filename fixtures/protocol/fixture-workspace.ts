import { BrowserLspWorkspace, type BrowserLspWorkspaceOptions } from "../../src/browser/lsp-workspace.ts";
import type { JsonValue, LspDocumentFeature, LspScopeAccess, LspWorkspaceScope } from "../../src/protocol/index.ts";
import type { Workspace } from "../../src/index.ts";

const commandKey = (command: string) => `workspace/executeCommand:${command}`;

/** Development-peer policy travels with its request, never in connection-wide configuration. */
export class FixtureLspWorkspace extends BrowserLspWorkspace {
    private readonly preparations = new WeakMap<LspScopeAccess, (method: string, policy: JsonValue, replacePending: boolean) => void>();
    private readonly sendCommand: <T>(command: string, policy: JsonValue | undefined, send: () => T) => T;

    constructor(workspace: Workspace, options: BrowserLspWorkspaceOptions) {
        let commandPolicy: { command: string; policy: JsonValue } | undefined;
        super(workspace, { ...options, connect: async signal => {
            const transport = await options.connect(signal);
            return { subscribe: listener => transport.subscribe(listener), dispose: () => transport.dispose(), send: message => {
                if (commandPolicy) {
                    const value = JSON.parse(message);
                    if (value.method === "workspace/executeCommand" && value.params?.command === commandPolicy.command) {
                        transport.send(JSON.stringify({ ...value, params: { ...value.params, _fixture: commandPolicy.policy } })); return;
                    }
                }
                transport.send(message);
            } };
        } });
        this.sendCommand = (command, policy, send) => {
            // requestCommand authorizes and sends synchronously. Preserve its arguments exactly;
            // decorate only this fixture's wire envelope during that captured invocation.
            const previous = commandPolicy; commandPolicy = policy === undefined ? undefined : { command, policy };
            try { return send(); } finally { commandPolicy = previous; }
        };
    }

    /** Call synchronously inside the feature's preparation hook, before any optional await. */
    prepareRequest(scope: LspScopeAccess, method: LspDocumentFeature | "codeAction/resolve", policy: Readonly<Record<string, JsonValue>>,
        options: Readonly<{ replacePending?: boolean }> = {}): Promise<void> {
        return this.prepare(scope, method, policy, options.replacePending === true);
    }
    prepareCommand(scope: LspScopeAccess, command: string, policy: Readonly<Record<string, JsonValue>>): Promise<void> {
        return this.prepare(scope, commandKey(command), policy, false);
    }
    private async prepare(scope: LspScopeAccess, method: string, policy: Readonly<Record<string, JsonValue>>, replacePending: boolean): Promise<void> {
        const prepare = this.preparations.get(scope);
        if (!prepare) throw new Error("Request policy requires a live scope from this fixture workspace.");
        prepare(method, structuredClone(policy), replacePending);
    }

    override createScope(): LspWorkspaceScope {
        const scope = super.createScope();
        let pending: { method: string; policy: JsonValue } | undefined;
        const take = (method: string) => { if (pending?.method !== method) return undefined; const policy = pending.policy; pending = undefined; return policy; };
        const wrapped: LspWorkspaceScope = Object.freeze({ ...scope,
            requestDocument: (method, document, params) => {
                // Take the policy before synchronization can yield to another request.
                const policy = take(method);
                return scope.requestDocument(method, document, (index, snapshot, capture) => ({ ...params(index, snapshot, capture),
                    ...(policy === undefined ? {} : { _fixture: policy }) }));
            },
            request: (method, params) => {
                const policy = take(method);
                if (policy === undefined) return scope.request(method, params);
                if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("Fixture policy requires named request parameters.");
                return scope.request(method, { ...params, _fixture: policy });
            },
            requestCommand: (command, args, timeout, authorization) => this.sendCommand(command, take(commandKey(command)),
                () => scope.requestCommand(command, args, timeout, authorization)),
            cancel: () => { pending = undefined; scope.cancel(); },
            release: () => { pending = undefined; this.preparations.delete(wrapped); scope.dispose(); },
        });
        this.preparations.set(wrapped, (method, policy, replacePending) => {
            // Only the latest-intent owner may replace an abandoned policy for the same method.
            if (pending && (!replacePending || pending.method !== method)) throw new Error("A fixture request already owns this scope's pending policy.");
            pending = { method, policy };
        });
        return wrapped;
    }
}
