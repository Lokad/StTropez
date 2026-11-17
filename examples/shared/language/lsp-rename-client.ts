import { createLspRenameClient as createClient } from "../../../src/protocol/index.ts";
import type { LspScopeAccess, LspWorkspace } from "../../../src/protocol/index.ts";
import type { DocumentId, DocumentSnapshot } from "../../../src/index.ts";
export type LspRenameConfiguration = Readonly<{ delay: number; fault?: "malformed" | "failure" }>;
export type LspRenameOptions = Readonly<{ provider: LspWorkspace;
    beforeRequest?: (session: LspScopeAccess, configuration: LspRenameConfiguration) => Promise<unknown> }>;
export type LspRenameClient = ReturnType<typeof createLspRenameClient>;
export type LspRenameFactory = () => LspRenameClient;

/** Fixture configuration around the exported protocol client. */
export function createLspRenameClient(options: LspRenameOptions) {
    const client = createClient(options.provider);
    return Object.freeze({ ...client,
        run: (snapshots: readonly DocumentSnapshot[], origin: DocumentId, offset: number, newName: string, configuration: LspRenameConfiguration) =>
            client.run(snapshots, origin, offset, newName, options.beforeRequest ? session => options.beforeRequest!(session, configuration) : undefined),
        faultIdle: () => { if (client.snapshot().disposed || client.snapshot().busy || !client.snapshot().connected) return false; options.provider.disconnect(); return true; },
        snapshot: () => Object.freeze({ ...client.snapshot(), transport: "lsp3.17" }) });
}
