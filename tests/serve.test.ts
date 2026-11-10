import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createServer } from "node:http";

const { startServer } = await import(new URL("../scripts/serve.mjs", import.meta.url).href) as {
    startServer(port: number): Promise<{ url: string; close(): Promise<void> }>;
};

// Includes five compiler/watch turns on the test filesystem, outside all editor interaction clocks.
test("development assets follow completed watched builds, reject private paths and release their port", { timeout: 90000 }, async t => {
    const previous = process.cwd(); await mkdir(join(previous, "artifacts"), { recursive: true });
    const fixture = await mkdtemp(join(previous, "artifacts/dev-server-test-"));
    const put = async (path: string, text: string) => { const file = join(fixture, path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, text); };
    for (const path of ["playground", "probes", "viewport", "editing", "comparison", "shaping"]) await put(`examples/${path}/index.html`, `<title>${path}</title>`);
    for (const host of ["plain", "react"]) await put(`examples/hosts/${host}.html`, `<title>${host}</title>`);
    for (const path of ["playground/main.ts", "shaping/main.ts", "comparison/main.ts", "editing/main.ts", "viewport/main.ts", "probes/main.ts", "probes/provider-worker.ts", "hosts/plain-main.ts", "hosts/react-main.tsx"]) await put(`examples/${path}`, "export const ready = true;");
    await put("examples/playground/main.ts", 'import "./theme.css"; export const ready = true;');
    await put("examples/playground/theme.css", "body { color: blue; }");
    await put("src/browser/regex-worker.ts", 'globalThis.postMessage("worker-first");');
    await put("private.txt", "not a public asset");
    await put("package.json", '{"type":"module"}'); await put("tsconfig.json", '{}');
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    const get = (path: string, init?: RequestInit) => fetch(server!.url + path, { ...init, signal: AbortSignal.any([t.signal, AbortSignal.timeout(5000)]) });
    const until = async (phase: string, matches: (response: Response, text: string) => boolean) => {
        t.diagnostic(phase);
        // Compiler turns share the bounded workflow budget; they are not input latency gates.
        for (;;) { t.signal.throwIfAborted(); const response = await get("/regex-worker.js"), text = await response.text(); if (matches(response, text)) return;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    };
    try {
        process.chdir(fixture); server = await startServer(0);
        assert.equal(await (await get("/hosts/react/")).text(), "<title>react</title>");
        assert.equal(await (await get("/hosts/react/index.html")).text(), "<title>react</title>");
        const worker = await get("/regex-worker.js"); assert.equal(worker.status, 200); assert.match(worker.headers.get("content-type")!, /javascript/); assert.match(await worker.text(), /worker-first/);
        const head = await get("/regex-worker.js", { method: "HEAD" }); assert.equal(head.status, 200); assert.ok(Number(head.headers.get("content-length")) > 0); assert.equal(await head.text(), "");
        assert.match((await get("/app.css")).headers.get("content-type")!, /css/); assert.equal((await get("/app.js.map")).status, 200);
        for (const path of ["/private.txt", "/%2e%2e%5cprivate.txt", "/%2e%2e/private.txt", "/not-an-entry.js"]) assert.equal((await get(path)).status, 404);
        assert.equal((await get("/%zz")).status, 400); assert.equal((await get("/app.js", { method: "POST" })).status, 405);
        await put("src/browser/regex-worker.ts", 'globalThis.postMessage("worker-changed");'); await until("watch publishes changed worker", (r, text) => r.status === 200 && text.includes("worker-changed"));
        await put("src/browser/regex-worker.ts", "export const = ;"); await until("invalid build refuses stale assets", (r, text) => r.status === 503 && text === "Development build failed.");
        await put("src/browser/regex-worker.ts", 'globalThis.postMessage("worker-recovered");'); await until("corrected build recovers", (r, text) => r.status === 200 && text.includes("worker-recovered"));
        const port = Number(new URL(server.url).port); await server.close(); await server.close();
        await assert.rejects(get("/"));
        const occupied = createServer(); await new Promise<void>(resolve => occupied.listen(port, "127.0.0.1", resolve));
        try { await assert.rejects(startServer(port), { code: "EADDRINUSE" }); } finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
    } finally { await server?.close(); process.chdir(previous); }
});
