import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { attachProtocolFixture } from "../fixtures/protocol/fixture-server.ts";
import { listenPackageServer, closePackageServer, closePackageResources } from "../scripts/package-host.mjs";

test("package teardown closes the real fixture and HTTP listener despite browser rejection and preserves failures", async t => {
    const server = createServer(), stop = attachProtocolFixture(server);
    let stopped = false;
    const stopFixture = () => { if (!stopped) { stopped = true; stop(); } };
    t.after(async () => { stopFixture(); await closePackageServer(server); });
    await listenPackageServer(server);
    const port = (server.address() as AddressInfo).port;
    const primary = new Error("workload failed"), browser = new Error("browser close failed"), order: string[] = [];
    await assert.rejects(closePackageResources([
        async () => { order.push("browser"); throw browser; },
        () => { order.push("fixture"); stopFixture(); },
        async () => { order.push("server"); await closePackageServer(server); },
    ], [primary]), error => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [primary, browser]);
        return true;
    });
    assert.deepEqual(order, ["browser", "fixture", "server"]);
    assert.equal(stopped, true);
    assert.equal(server.listening, false);
    assert.equal(server.listenerCount("upgrade"), 0);
    const rebound = createServer();
    t.after(() => closePackageServer(rebound));
    await listenPackageServer(rebound, port);
    await assert.rejects(closePackageResources([], [primary]), error => error === primary);
});

test("package listener startup rejects promptly and releases only the failed listener's fixture", async t => {
    const occupied = createServer(), failed = createServer();
    const listeningBaseline = failed.listenerCount("listening"), stopFixture = attachProtocolFixture(failed);
    t.after(async () => { await closePackageServer(failed); await closePackageServer(occupied); });
    await listenPackageServer(occupied);
    const failures: unknown[] = [];
    try { await listenPackageServer(failed, (occupied.address() as AddressInfo).port); }
    catch (error) { failures.push(error); }
    await assert.rejects(closePackageResources([stopFixture, () => closePackageServer(failed)], failures), { code: "EADDRINUSE" });
    assert.equal(occupied.listening, true);
    assert.equal(failed.listening, false);
    assert.equal(failed.listenerCount("upgrade"), 0);
    assert.equal(failed.listenerCount("error"), 0);
    assert.equal(failed.listenerCount("listening"), listeningBaseline);
    await closePackageServer(failed);
});

test("package cleanup waits for each owner and attempts later owners after multiple close failures", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), order: string[] = [], first = new Error("page"), second = new Error("provider");
    const closing = closePackageResources([
        async () => { order.push("page-start"); await gate; order.push("page-end"); throw first; },
        () => { order.push("browser"); },
        () => { order.push("provider"); throw second; },
        () => { order.push("server"); },
    ]);
    assert.deepEqual(order, ["page-start"]);
    release();
    await assert.rejects(closing, error => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [first, second]);
        return true;
    });
    assert.deepEqual(order, ["page-start", "page-end", "browser", "provider", "server"]);
});
