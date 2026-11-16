import { LspWorkspace } from "../../src/protocol/index.ts";
import type { JsonValue, LspDocumentFeature, LspSessionAccess, LspWorkspaceScope } from "../../src/protocol/index.ts";

/** Development-peer policy travels with its request, never in connection-wide configuration. */
export class FixtureLspWorkspace extends LspWorkspace {
    private readonly preparations = new WeakMap<LspSessionAccess, (method: LspDocumentFeature, policy: JsonValue) => void>();

    /** Call synchronously inside the feature's preparation hook, before any optional await. */
    async prepareRequest(scope: LspSessionAccess, method: LspDocumentFeature, policy: Readonly<Record<string, JsonValue>>): Promise<void> {
        const prepare = this.preparations.get(scope);
        if (!prepare) throw new Error("Request policy requires a live scope from this fixture workspace.");
        prepare(method, structuredClone(policy));
    }

    override createScope(): LspWorkspaceScope {
        const scope = super.createScope();
        let pending: { method: LspDocumentFeature; policy: JsonValue } | undefined;
        const wrapped: LspWorkspaceScope = Object.freeze({ ...scope,
            requestDocument: (method, document, params) => {
                // Take the policy before synchronization can yield to another request.
                const policy = pending?.method === method ? pending.policy : undefined;
                if (policy !== undefined) pending = undefined;
                return scope.requestDocument(method, document, (index, snapshot, capture) => ({ ...params(index, snapshot, capture),
                    ...(policy === undefined ? {} : { _fixture: policy }) }));
            },
            disconnect: () => { pending = undefined; scope.disconnect(); },
            dispose: () => { pending = undefined; this.preparations.delete(wrapped); scope.dispose(); },
        });
        this.preparations.set(wrapped, (method, policy) => {
            if (pending) throw new Error("A fixture request already owns this scope's pending policy.");
            pending = { method, policy };
        });
        return wrapped;
    }
}
