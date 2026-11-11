import { createLspRenameClient as createClient } from "../../src/protocol/index.ts";
import type { LspSessionAccess, LspWorkspace } from "../../src/protocol/index.ts";
import type { DocumentId, DocumentSnapshot, Workspace } from "../../src/index.ts";
export type LspRenameConfiguration = Readonly<{ delay: number; fault?: "malformed" | "failure" }>;
export type LspRenameOptions = Readonly<{ provider: LspWorkspace;
    beforeRequest?: (session: LspSessionAccess, configuration: LspRenameConfiguration) => Promise<unknown> }>;
export type LspRenameClient = ReturnType<typeof createLspRenameClient>;
export type LspRenameFactory = (clock: Pick<Window, "setTimeout" | "clearTimeout">) => LspRenameClient;

/** Fixture configuration around the exported protocol client. */
export function createLspRenameClient(_workspace: Workspace, _clock: Pick<Window, "setTimeout" | "clearTimeout">, options: LspRenameOptions) {
    const client = createClient(options.provider);
    return Object.freeze({ ...client,
        run: (snapshots: readonly DocumentSnapshot[], origin: DocumentId, offset: number, newName: string, configuration: LspRenameConfiguration) =>
            client.run(snapshots, origin, offset, newName, options.beforeRequest ? session => options.beforeRequest!(session, configuration) : undefined),
        faultIdle: () => { if (client.snapshot().disposed || client.snapshot().busy || !client.snapshot().connected) return false; options.provider.disconnect(); return true; },
        snapshot: () => Object.freeze({ ...client.snapshot(), created: 0, terminated: 0, shared: true }) });
}
