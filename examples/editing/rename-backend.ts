import type { DocumentId, DocumentSnapshot } from "../../src/index.ts";
import type { LspWorkspaceEdit } from "../../src/protocol/index.ts";
import type { NavigationResult } from "../../fixtures/language/navigation.ts";
import type { RenameCapture } from "../../fixtures/language/rename.ts";
import { CleanupScope } from "../shared/cleanup-scope.ts";
import type { ProviderBackend } from "../shared/provider-lane.ts";
import { createNavigationClient } from "./navigation-client.ts";
import type { NavigationMetrics } from "./navigation-client.ts";
import type { LspRenameClient, LspRenameFactory } from "./lsp-rename-client.ts";

type RenameRequest = Readonly<{ documents: readonly DocumentSnapshot[]; capture: RenameCapture; name: string; progress: (work: number) => void }>;
type RenameResult = Readonly<{ kind: "lexical"; result: NavigationResult }> | Readonly<{ kind: "workspace"; edit: LspWorkspaceEdit }>;
export type RenameBackend = ProviderBackend<RenameRequest, RenameResult,
    ReturnType<LspRenameClient["snapshot"]> | ReturnType<ReturnType<typeof createNavigationClient>["snapshot"]>>;

/** Reuse existing transports; preview validation and application remain host policies. */
export function createRenameBackend(clock: Pick<Window, "setTimeout" | "clearTimeout">, metrics: NavigationMetrics,
    factory: LspRenameFactory | undefined, changed: () => void): RenameBackend {
    if (factory) {
        const client = factory(), scope = new CleanupScope(); scope.defer(client.dispose);
        try {
            scope.defer(client.subscribe(changed));
            return Object.freeze({
                run: async ({ documents, capture, name }: RenameRequest) => ({ kind: "workspace" as const,
                    edit: await client.run(documents, capture.document as DocumentId, capture.offset, name, capture.input) }),
                cancel: client.cancel, dispose: scope.dispose, faultIdle: client.faultIdle, snapshot: client.snapshot,
            });
        } catch (error) { scope.rollback(error); }
    }
    const client = createNavigationClient(clock, metrics, undefined, changed);
    return Object.freeze({
        run: async ({ documents, capture, progress }: RenameRequest) => ({ kind: "lexical" as const,
            result: await client.run(capture.input, new Map(documents.map(document => [document.id, document.buffer])), progress) }),
        // Pending worker requests are dropped by the lane. A ready lexical preview owns
        // no provider-side targets; retaining its idle client preserves synchronized text.
        cancel: () => {}, dispose: client.dispose, faultIdle: client.faultIdle, snapshot: client.snapshot,
    });
}
