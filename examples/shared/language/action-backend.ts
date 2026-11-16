import type { DocumentId, DocumentSnapshot } from "../../../src/index.ts";
import type { ActionInput, ActionResult } from "../../../fixtures/language/actions.ts";
import { CleanupScope } from "../cleanup-scope.ts";
import type { ProviderBackend } from "../provider-lane.ts";
import { createNavigationClient } from "./navigation-client.ts";
import type { NavigationMetrics } from "./navigation-service.ts";
import type { LspActionBatch, LspActionClient, LspActionFactory } from "./lsp-action-client.ts";

type ActionRequest = Readonly<{ documents: readonly DocumentSnapshot[]; document: DocumentSnapshot; input: ActionInput; progress: (work: number) => void }>;
/** A command handoff observes the same provider that owns this captured batch. */
export type ActionProviderBatch = LspActionBatch & Readonly<{ subscribe: LspActionClient["subscribe"] }>;
type ActionBackendResult = Readonly<{ kind: "provider"; batch: ActionProviderBatch }> | Readonly<{ kind: "import"; result: ActionResult }>;
export type ActionBackend = ProviderBackend<ActionRequest, ActionBackendResult,
    ReturnType<LspActionClient["snapshot"]> | ReturnType<ReturnType<typeof createNavigationClient>["snapshot"]>>;

/** Existing clients retain protocol validation, lazy resolution and command semantics. */
export function createActionBackend(clock: Pick<Window, "setTimeout" | "clearTimeout">, metrics: NavigationMetrics,
    factory: LspActionFactory | undefined, changed: () => void): ActionBackend {
    if (factory) {
        const client = factory(), scope = new CleanupScope(); scope.defer(client.dispose);
        try {
            scope.defer(client.subscribe(changed));
            return Object.freeze({
                run: async ({ documents, input }: ActionRequest) => ({ kind: "provider" as const,
                    batch: Object.freeze({ ...await client.run(documents, input.document as DocumentId, input.from, input.to, input), subscribe: client.subscribe }) }),
                cancel: client.cancel, dispose: scope.dispose, faultIdle: client.faultIdle, snapshot: client.snapshot,
            });
        } catch (error) { scope.rollback(error); }
    }
    const client = createNavigationClient(clock, metrics, undefined, changed);
    return Object.freeze({
        run: async ({ document, input, progress }: ActionRequest) => ({ kind: "import" as const, result: await client.action(input, document.buffer, progress) }),
        // Pending requests drop the worker; ready import previews retain its synchronized text.
        cancel: () => {}, dispose: client.dispose, faultIdle: client.faultIdle, snapshot: client.snapshot,
    });
}
