import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import { startServer } from "../scripts/serve.mjs";

// Compiler/watch turns run on the test filesystem, outside all editor interaction clocks.
test("development assets follow completed watched or fixed builds, reject private paths and release their port", { timeout: 90000 }, async t => {
    const previous = process.cwd(); await mkdir(join(previous, "artifacts"), { recursive: true });
    const artifacts = await realpath(join(previous, "artifacts"));
    assert.equal(dirname(artifacts), await realpath(previous));
    const fixture = await mkdtemp(join(artifacts, "dev-server-test-"));
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    let fixed: Awaited<ReturnType<typeof startServer>> | undefined;
    // Register before fixture setup so failures there have the same cleanup owner.
    t.after(async () => {
        const results = await Promise.allSettled([fixed, server].map(async owner => owner?.close()));
        const errors: unknown[] = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
        try { process.chdir(previous); } catch (error) { errors.push(error); }
        try {
            assert.equal(dirname(fixture), artifacts);
            assert.equal(await realpath(fixture), fixture);
            await rm(fixture, { recursive: true });
        } catch (error) { errors.push(error); }
        if (errors.length) throw new AggregateError(errors, "Development server fixture cleanup failed.");
    });
    const put = async (path: string, text: string) => { const file = join(fixture, path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, text); };
    for (const path of ["demo", "viewport", "editing", "comparison", "protocol"]) await put(`examples/${path}/index.html`, `<title>${path}</title>`);
    for (const host of ["plain", "react"]) await put(`examples/hosts/${host}.html`, `<title>${host}</title>`);
    for (const path of ["demo/main.ts", "demo/syntax-worker.ts", "demo/language-worker.ts", "comparison/main.ts", "editing/main.ts", "viewport/main.ts", "protocol/main.ts", "hosts/plain-main.ts", "hosts/react-main.tsx"]) await put(`examples/${path}`, "export const ready = true;");
    await put("examples/demo/index.html", '<html data-demo-provider="browser"><title>demo</title></html>');
    await put("node_modules/typescript-demo/lib/lib.es5.d.ts", "interface String {}");
    await put("node_modules/typescript-demo/lib/private.d.ts", "not a standard library");
    await put("tests/fixtures/workspace/index.html", "<title>workspace</title>");
    await put("tests/fixtures/workspace/main.ts", "export const ready = true;");
    await put("tests/fixtures/fonts/index.html", "<title>fonts</title>");
    await put("tests/fixtures/fonts/main.ts", "export const ready = true;");
    for (const mode of ["plain", "react"]) await put(`fixtures/hosts/${mode}-main.ts`, "export const ready = true;");
    await put("examples/demo/main.ts", 'import "./theme.css"; export const ready = true;');
    await put("examples/demo/theme.css", "body { color: blue; }");
    await put("src/browser/regex-worker.ts", 'globalThis.postMessage("worker-first");');
    await put("private.txt", "not a public asset");
    await put("package.json", '{"type":"module"}'); await put("tsconfig.json", '{}');
    const get = (path: string, init?: RequestInit) => fetch(server!.url + path, { ...init, signal: AbortSignal.any([t.signal, AbortSignal.timeout(5000)]) });
    const until = async (phase: string, matches: (response: Response, text: string) => boolean) => {
        t.diagnostic(phase);
        // Compiler turns share the bounded workflow budget; they are not input latency gates.
        for (;;) { t.signal.throwIfAborted(); const response = await get("/regex-worker.js"), text = await response.text(); if (matches(response, text)) return;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    };
    process.chdir(fixture); server = await startServer(0);
    assert.equal(server.buildMode, "development-bundle-watch");
    fixed = await startServer(0, { watch: false });
    assert.equal(fixed.buildMode, "development-bundle-no-watch");
    assert.equal(await (await get("/")).text(), '<html data-demo-provider="server"><title>demo</title></html>');
    assert.equal(await (await get("/workspace/")).text(), "<title>workspace</title>");
    assert.equal((await get("/workspace-fixture.js")).status, 200);
    assert.equal((await get("/demo-syntax-worker.js")).status, 200);
    assert.equal((await get("/demo-language-worker.js")).status, 200);
    const libraries = await get("/typescript-libs.json");
    assert.match(libraries.headers.get("content-type")!, /application\/json/);
    assert.deepEqual(await libraries.json(), { "lib.es5.d.ts": "interface String {}" });
    assert.equal(await (await get("/hosts/react/")).text(), "<title>react</title>");
    assert.equal(await (await get("/hosts/react/index.html")).text(), "<title>react</title>");
    assert.equal(await (await get("/protocol/")).text(), "<title>protocol</title>"); assert.equal((await get("/protocol-fixture.js")).status, 200);
    assert.equal(await (await get("/fonts/")).text(), "<title>fonts</title>"); assert.equal((await get("/fonts.js")).status, 200);
    const worker = await get("/regex-worker.js"); assert.equal(worker.status, 200); assert.match(worker.headers.get("content-type")!, /javascript/); assert.match(await worker.text(), /worker-first/);
    const head = await get("/regex-worker.js", { method: "HEAD" }); assert.equal(head.status, 200); assert.ok(Number(head.headers.get("content-length")) > 0); assert.equal(await head.text(), "");
    assert.match((await get("/app.css")).headers.get("content-type")!, /css/); assert.equal((await get("/app.js.map")).status, 200);
    for (const path of ["/probes/", "/probe.js", "/probe.css", "/private.txt", "/%2e%2e%5cprivate.txt", "/%2e%2e/private.txt", "/not-an-entry.js"]) assert.equal((await get(path)).status, 404);
    assert.equal((await get("/%zz")).status, 400); assert.equal((await get("/app.js", { method: "POST" })).status, 405);
    await put("src/browser/regex-worker.ts", 'globalThis.postMessage("worker-changed");'); await until("watch publishes changed worker", (r, text) => r.status === 200 && text.includes("worker-changed"));
    await put("src/browser/regex-worker.ts", "export const = ;"); await until("invalid build refuses stale assets", (r, text) => r.status === 503 && text === "Development build failed.");
    await put("src/browser/regex-worker.ts", 'globalThis.postMessage("worker-recovered");'); await until("corrected build recovers", (r, text) => r.status === 200 && text.includes("worker-recovered"));
    const fixedWorker = await fetch(fixed.url + "/regex-worker.js", { signal: t.signal });
    assert.equal(fixedWorker.status, 200); assert.match(await fixedWorker.text(), /worker-first/);
    await fixed.close(); await fixed.close();
    await assert.rejects(fetch(fixed.url + "/", { signal: t.signal }));
    const port = Number(new URL(server.url).port); await server.close(); await server.close();
    await assert.rejects(get("/"));
    const occupied = createServer(); await new Promise<void>(resolve => occupied.listen(port, "127.0.0.1", resolve));
    try { await assert.rejects(startServer(port), { code: "EADDRINUSE" }); } finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
    await put("src/browser/regex-worker.ts", "export const = ;");
    await assert.rejects(startServer(0, { watch: false }), /Build failed/);
});
