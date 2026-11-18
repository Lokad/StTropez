import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import { serveDemo } from "../scripts/serve-demo.mjs";
import { closePackageResources, closePackageServer, listenPackageServer } from "../scripts/package-host.mjs";

test("static assets keep manifest boundaries and report failed reads after releasing their listener", async t => {
    const previous = process.cwd(); await mkdir(join(previous, "artifacts"), { recursive: true });
    const artifacts = await realpath(join(previous, "artifacts"));
    assert.equal(dirname(artifacts), await realpath(previous));
    const fixture = await mkdtemp(join(artifacts, "static-server-test-"));
    let server: Awaited<ReturnType<typeof serveDemo>> | undefined;
    t.after(() => closePackageResources([
        () => server?.close(),
        () => process.chdir(previous),
        async () => {
            assert.equal(dirname(fixture), artifacts); assert.equal(await realpath(fixture), fixture);
            await rm(fixture, { recursive: true });
        },
    ]));
    const assets = new Map([
        ["index.html", "<title>static</title>"], ["app.js", "export const ready = true;"],
        ["app.css", "body { color: blue; }"], ["data.json", "{}"], ["notice.txt", "notice"],
    ]);
    const root = join(fixture, "artifacts/pages"); await mkdir(root, { recursive: true });
    for (const [name, text] of assets) await writeFile(join(root, name), text);
    await writeFile(join(root, "private.txt"), "outside manifest");
    await writeFile(join(fixture, "artifacts/pages-build.json"), JSON.stringify({ assets: [...assets.keys(), "missing.js"].map(path => ({ path })) }));
    process.chdir(fixture); server = await serveDemo(0, "/fixture/");
    const url = server.url, get = (path: string, method = "GET") => fetch(url + path, { method, signal: AbortSignal.any([t.signal, AbortSignal.timeout(5000)]) });
    assert.equal(await (await get("")).text(), assets.get("index.html"));
    for (const [name, type] of [["app.js", "text/javascript"], ["app.css", "text/css"], ["data.json", "application/json"], ["notice.txt", "text/plain"]]) {
        const response = await get(name!); assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), type); assert.equal(await response.text(), assets.get(name!));
    }
    const head = await get("app.js", "HEAD"); assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get("content-length")), Buffer.byteLength(assets.get("app.js")!)); assert.equal(await head.text(), "");
    for (const path of ["private.txt", "nested/route", "../index.html"]) assert.equal((await get(path)).status, 404);
    assert.equal((await get("app.js", "POST")).status, 404);
    const port = Number(new URL(url).port);
    await assert.rejects(serveDemo(port, "/fixture/"), { code: "EADDRINUSE" });
    assert.equal(await (await get("app.js")).text(), assets.get("app.js"));
    const failed = await get("missing.js"); assert.equal(failed.status, 500); assert.equal(await failed.text(), "");
    const closing = server.close();
    await assert.rejects(closing, { code: "ENOENT" });
    assert.equal(server.close(), closing); server = undefined;
    const rebound = createServer();
    try { await listenPackageServer(rebound, port); } finally { await closePackageServer(rebound); }
});
