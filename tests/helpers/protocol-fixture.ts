import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { attachProtocolFixture } from "../../fixtures/protocol/fixture-server.ts";
import { closePackageResources, closePackageServer, listenPackageServer } from "../../scripts/package-host.mjs";

type Cleanup = () => unknown | Promise<unknown>;
export type ProtocolFixture = Readonly<{
    url: string; server: Server; defer: (cleanup: Cleanup) => void;
}>;

/** Own the real protocol server and unwind acquired test owners before detaching it. */
export async function withProtocolFixture(run: (fixture: ProtocolFixture) => Promise<void>): Promise<void> {
    const server = createServer(), cleanup: Cleanup[] = [], failures: unknown[] = [];
    let detach: Cleanup = () => {};
    try {
        detach = attachProtocolFixture(server);
        await listenPackageServer(server);
        const address = server.address(); assert.ok(address && typeof address === "object");
        await run({ url: `ws://127.0.0.1:${address.port}/lsp-fixture`, server,
            defer: action => { cleanup.unshift(action); } });
    } catch (error) { failures.push(error); }
    await closePackageResources([...cleanup, detach, () => closePackageServer(server)], failures);
}
