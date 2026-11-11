import { createLspHoverClient as createClient } from "../../src/protocol/index.ts";
import type { LspSessionAccess, LspWorkspace } from "../../src/protocol/index.ts";
import type { HoverBackend } from "./hover-backend.ts";
import type { HoverInput } from "../probes/hover.ts";
export type LspHoverOptions = Readonly<{ provider: LspWorkspace;
    beforeRequest?: (session: LspSessionAccess, configuration: Pick<HoverInput, "delay" | "fault">) => Promise<unknown> }>;

/** Fixture configuration around the exported protocol client. */
export function createLspHoverClient(_clock: Pick<Window, "setTimeout" | "clearTimeout">, options: LspHoverOptions): HoverBackend {
    const client = createClient(options.provider);
    return Object.freeze({ ...client, disconnect: client.cancel, snapshot: () => Object.freeze({ ...client.snapshot(), created: 0, transport: "lsp3.17", shared: true }),
        run: (document, offset, configuration) => client.run(document, offset, options.beforeRequest ? session => options.beforeRequest!(session, configuration) : undefined) });
}
