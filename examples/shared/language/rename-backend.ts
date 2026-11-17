import type { DocumentId, DocumentSnapshot } from "../../../src/index.ts";
import type { LspWorkspaceEdit } from "../../../src/protocol/index.ts";
import type { RenameCapture } from "../../../fixtures/language/rename.ts";
import { CleanupScope } from "../cleanup-scope.ts";
import type { ProviderBackend } from "../provider-lane.ts";
import type { LspRenameClient, LspRenameFactory } from "./lsp-rename-client.ts";

type RenameRequest = Readonly<{ documents: readonly DocumentSnapshot[]; capture: RenameCapture; name: string }>;
type RenameResult = Readonly<{ edit: LspWorkspaceEdit }>;
export type RenameBackend = ProviderBackend<RenameRequest, RenameResult,
    ReturnType<LspRenameClient["snapshot"]>>;

/** Preview validation and application remain host policies. */
export function createRenameBackend(factory: LspRenameFactory, changed: () => void): RenameBackend {
    const client = factory(), scope = new CleanupScope(); scope.defer(client.dispose);
    try {
        scope.defer(client.subscribe(changed));
        return Object.freeze({
            run: async ({ documents, capture, name }: RenameRequest) => ({
                edit: await client.run(documents, capture.document as DocumentId, capture.offset, name, capture.input) }),
            cancel: client.cancel, dispose: scope.dispose, faultIdle: client.faultIdle, snapshot: client.snapshot,
        });
    } catch (error) { return scope.rollback(error); }
}
