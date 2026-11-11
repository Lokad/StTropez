import { createLspActionClient as createClient } from "../../src/protocol/index.ts";
import type { LspSessionAccess, LspWorkspace } from "../../src/protocol/index.ts";
import type { DocumentId, DocumentSnapshot, Workspace } from "../../src/index.ts";
export type LspActionConfiguration = Readonly<{ module: string; delay: number; fault?: "malformed" | "failure" | "incomplete" | "markup" }>;
export type LspActionOptions = Readonly<{ provider: LspWorkspace;
    beforeRequest?: (session: LspSessionAccess, configuration: LspActionConfiguration) => Promise<unknown>;
    beforeResolve?: (session: LspSessionAccess, configuration: LspActionConfiguration) => Promise<unknown> }>;
export type LspActionClient = ReturnType<typeof createLspActionClient>;
export type LspActionBatch = Awaited<ReturnType<LspActionClient["run"]>>;
export type LspActionFactory = (clock: Pick<Window, "setTimeout" | "clearTimeout">) => LspActionClient;

/** Fixture configuration around the exported protocol client. */
export function createLspActionClient(_workspace: Workspace, _clock: Pick<Window, "setTimeout" | "clearTimeout">, options: LspActionOptions) {
    const client = createClient(options.provider);
    return Object.freeze({ ...client,
        run: async (snapshots: readonly DocumentSnapshot[], origin: DocumentId, from: number, to: number, configuration: LspActionConfiguration) => {
            const batch = await client.run(snapshots, origin, from, to, options.beforeRequest ? session => options.beforeRequest!(session, configuration) : undefined);
            return Object.freeze({ ...batch, resolve: (action: Parameters<typeof batch.resolve>[0], configuration: LspActionConfiguration) =>
                batch.resolve(action, options.beforeResolve ? session => options.beforeResolve!(session, configuration) : undefined) });
        },
        faultIdle: () => { if (client.snapshot().disposed || client.snapshot().busy || !client.snapshot().connected) return false; options.provider.disconnect(); return true; },
        snapshot: () => Object.freeze({ ...client.snapshot(), transport: "lsp3.17" }) });
}
