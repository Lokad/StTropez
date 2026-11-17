import type { DocumentId, DocumentSnapshot } from "../../../src/index.ts";
import type { ActionInput } from "../../../fixtures/language/actions.ts";
import { CleanupScope } from "../cleanup-scope.ts";
import type { ProviderBackend } from "../provider-lane.ts";
import type { LspActionBatch, LspActionClient, LspActionFactory } from "./lsp-action-client.ts";

type ActionRequest = Readonly<{ documents: readonly DocumentSnapshot[]; input: ActionInput }>;
/** A command handoff observes the same provider that owns this captured batch. */
export type ActionProviderBatch = LspActionBatch & Readonly<{ subscribe: LspActionClient["subscribe"] }>;
type ActionBackendResult = Readonly<{ batch: ActionProviderBatch }>;
export type ActionBackend = ProviderBackend<ActionRequest, ActionBackendResult,
    ReturnType<LspActionClient["snapshot"]>>;

/** Existing clients retain protocol validation, lazy resolution and command semantics. */
export function createActionBackend(factory: LspActionFactory, changed: () => void): ActionBackend {
    const client = factory(), scope = new CleanupScope(); scope.defer(client.dispose);
    try {
        scope.defer(client.subscribe(changed));
        return Object.freeze({
            run: async ({ documents, input }: ActionRequest) => ({
                batch: Object.freeze({ ...await client.run(documents, input.document as DocumentId, input.from, input.to, input), subscribe: client.subscribe }) }),
            cancel: client.cancel, dispose: scope.dispose, faultIdle: client.faultIdle, snapshot: client.snapshot,
        });
    } catch (error) { return scope.rollback(error); }
}
