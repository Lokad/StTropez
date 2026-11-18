import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { attachProtocolFixture } from "../../fixtures/protocol/fixture-server.ts";
import { createPackageRequestHandler, listenPackageServer, closePackageServer, closePackageResources } from "../../scripts/package-host.mjs";

test("package request failures return bounded responses, preserve causes and leave the listener usable", async t => {
    const failures: unknown[] = [], synchronous = new Error("route failed"), partial = new Error("partial payload failed"), completed = new Error("completed handler failed");
    const missing = new URL(`missing-package-asset-${randomUUID()}.js`, import.meta.url);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), late = new Error("handler failed after HTTP closed");
    const requests = createPackageRequestHandler((request, response) => {
        if (request.url === "/sync") {
            response.setHeader("Content-Length", "100"); response.setHeader("Content-Encoding", "gzip");
            throw synchronous;
        }
        if (request.url === "/missing") return readFile(missing).then(bytes => { response.end(bytes); });
        if (request.url === "/partial") {
            response.writeHead(200, { "Content-Length": "100" }); response.write("partial");
            return Promise.reject(partial);
        }
        if (request.url === "/completed") { response.end("complete"); return Promise.reject(completed); }
        if (request.url === "/late") { response.end("accepted"); return gate.then(() => { throw late; }); }
        response.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" }); response.end("healthy");
    }, failures);
    const server = createServer(requests.listener);
    t.after(async () => { release(); await closePackageServer(server); await requests.settled(); });
    await listenPackageServer(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const request = (path: string) => fetch(base + path, { signal: AbortSignal.timeout(5000) });
    for (const path of ["/sync", "/missing"]) {
        const response = await request(path);
        assert.equal(response.status, 500); assert.equal(response.headers.get("content-length"), "0");
        assert.equal(response.headers.get("content-encoding"), null); assert.equal(await response.text(), "");
    }
    await assert.rejects(async () => { const response = await request("/partial"); await response.text(); });
    assert.equal(await (await request("/completed")).text(), "complete");
    const healthy = await request("/healthy");
    assert.equal(healthy.status, 200); assert.equal(healthy.headers.get("content-type"), "text/javascript");
    assert.equal(healthy.headers.get("cache-control"), "no-store"); assert.equal(await healthy.text(), "healthy");
    assert.equal(failures.length, 4); assert.equal(failures[0], synchronous);
    assert.ok(failures[1] instanceof Error && "code" in failures[1] && failures[1].code === "ENOENT");
    assert.equal(failures[2], partial); assert.equal(failures[3], completed);
    assert.equal(await (await request("/late")).text(), "accepted");
    let entered!: () => void, finished = false;
    const draining = new Promise<void>(resolve => { entered = resolve; });
    const closing = closePackageResources([() => closePackageServer(server), () => { entered(); return requests.settled(); }], failures);
    const rejected = assert.rejects(closing, error => {
        finished = true;
        assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [...failures]);
        assert.equal(error.errors.at(-1), late); return true;
    });
    await draining; assert.equal(server.listening, false); assert.equal(finished, false); assert.equal(failures.length, 4);
    release(); await rejected; assert.equal(failures.length, 5);
    assert.equal(server.listening, false);
});

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
    const primary = new Error("workload"), late = new Error("request failed during close"), failures = [primary];
    const closing = closePackageResources([
        async () => { order.push("page-start"); await gate; order.push("page-end"); throw first; },
        () => { order.push("browser"); },
        () => { order.push("provider"); throw second; },
        () => { order.push("server"); },
    ], failures);
    assert.deepEqual(order, ["page-start"]);
    failures.push(late);
    release();
    await assert.rejects(closing, error => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [primary, late, first, second]);
        return true;
    });
    assert.deepEqual(order, ["page-start", "page-end", "browser", "provider", "server"]);
});
