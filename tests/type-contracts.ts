import type { DocumentSnapshot, DocumentView } from "../src/index.ts";
import type { JsonValue, LspDocument, LspWorkspaceScope } from "../src/protocol/index.ts";
import type { JsonRpcConnection, LspSession } from "../src/kernels/index.ts";

import type { GraphemeProgress } from "../src/index.ts";
import type { GraphemeIndex } from "../src/kernels/index.ts";

export function graphemeReadContract(index: GraphemeIndex, progress: GraphemeProgress): void {
    // @ts-expect-error Published boundaries are immutable.
    index.boundaries().push(0);
    // @ts-expect-error Cluster coordinates are immutable.
    index.clusterAt(0).from = 1;
    // @ts-expect-error Source identity is captured.
    index.source.kind = "buffer";
    // @ts-expect-error Ready-only progress is immutable.
    progress.result = null;
}

export function documentReadContract(document: DocumentSnapshot, view: DocumentView): void {
    // @ts-expect-error Buffer snapshots expose no mutable text or position properties.
    document.buffer.length = 0;
    // @ts-expect-error Selection writes require the versioned view command.
    view.getSnapshot().selection.head = 0;
    // @ts-expect-error A published map's coordinate dimensions are immutable.
    if (document.change) document.change.mapping.oldLength = 0;
}

/** Raw responses establish JSON validity, not a method-specific schema. */
export function protocolResponseContract(rpc: JsonRpcConnection, session: LspSession, scope: LspWorkspaceScope, document: LspDocument): void {
    const raw: Promise<JsonValue>[] = [rpc.request("custom/value").result];
    // @ts-expect-error A raw RPC response cannot acquire a caller-selected schema.
    rpc.request<{ title: string }>("custom/value");
    for (const owner of [session, scope]) {
        raw.push(owner.request("custom/value").result, owner.requestCommand("custom/command").result,
            owner.requestDocument("textDocument/hover", document, () => ({})).result);
        // @ts-expect-error Session and scope custom responses are JSON until decoded.
        const title: Promise<{ title: string }> = owner.request("custom/value").result;
        // @ts-expect-error Document requests cannot assert an unchecked result type.
        owner.requestDocument<{ title: string }>("textDocument/hover", document, () => ({}));
        // @ts-expect-error Command authorization does not validate its result schema.
        owner.requestCommand<{ title: string }>("custom/command");
        // @ts-expect-error Custom requests do not accept unchecked type arguments.
        owner.request<{ title: string }>("custom/value");
        void title;
    }
    void raw;
}

/** Scope lifetime cannot be confused with shared connection lifetime. */
export function protocolScopeContract(scope: LspWorkspaceScope): void {
    void scope.ensureConnected(); scope.cancel(); scope.dispose();
    // @ts-expect-error Shared connection lifecycle belongs to the provider owner.
    scope.connect();
    // @ts-expect-error Cancelling scoped work cannot disconnect the provider.
    scope.disconnect();
    // @ts-expect-error The scope has a single teardown method.
    scope.release();
    // @ts-expect-error Only the provider owner can shut down the shared session.
    scope.shutdown();
}
