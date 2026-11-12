import { context } from "esbuild";
import { mkdir, copyFile, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { attachProtocolFixture } from "../examples/protocol/fixture-server.ts";

export async function startServer(port) {
    await mkdir("artifacts/site", { recursive: true });
    await copyFile("examples/playground/index.html", "artifacts/site/index.html");
    await mkdir("artifacts/site/probes", { recursive: true });
    await copyFile("examples/probes/index.html", "artifacts/site/probes/index.html");
    await mkdir("artifacts/site/viewport", { recursive: true });
    await copyFile("examples/viewport/index.html", "artifacts/site/viewport/index.html");
    await mkdir("artifacts/site/editing", { recursive: true });
    await copyFile("examples/editing/index.html", "artifacts/site/editing/index.html");
    await mkdir("artifacts/site/comparison", { recursive: true });
    await copyFile("examples/comparison/index.html", "artifacts/site/comparison/index.html");
    await mkdir("artifacts/site/protocol", { recursive: true });
    await copyFile("examples/protocol/index.html", "artifacts/site/protocol/index.html");
    await mkdir("artifacts/site/fonts", { recursive: true });
    await copyFile("tests/fixtures/fonts/index.html", "artifacts/site/fonts/index.html");
    for (const mode of ["plain", "react"]) {
        await mkdir(`artifacts/site/hosts/${mode}`, { recursive: true });
        await copyFile(`examples/hosts/${mode}.html`, `artifacts/site/hosts/${mode}/index.html`);
    }
    const site = resolve("artifacts/site"), pages = new Map(await Promise.all(
        ["/", "/probes/", "/viewport/", "/editing/", "/comparison/", "/protocol/", "/fonts/", "/hosts/plain/", "/hosts/react/"].flatMap(path => [path, path + "index.html"])
            .map(async path => [path, await readFile(resolve(site, "." + (path.endsWith("/") ? path + "index.html" : path)))])));
    let modules = new Map(), failed = false, firstBuild;
    const initial = new Promise(resolve => { firstBuild = resolve; });
    // Requests consume completed builds. In particular, starting a worker must not trigger
    // compilation of every host before that worker can answer its first message.
    const builder = await context({ absWorkingDir: process.cwd(), write: false, plugins: [{ name: "completed-dev-build", setup(build) {
        build.onEnd(result => {
            failed = result.errors.length > 0;
            if (!failed) modules = new Map(result.outputFiles.map(file => ["/" + relative(site, file.path).replaceAll("\\", "/"), file.contents]));
            firstBuild();
        });
    } }], entryPoints: { app: "examples/playground/main.ts", fonts: "tests/fixtures/fonts/main.ts", comparison: "examples/comparison/main.ts", editing: "examples/editing/main.ts", viewport: "examples/viewport/main.ts", probe: "examples/probes/main.ts", "provider-worker": "examples/probes/provider-worker.ts",
        "regex-worker": "src/browser/regex-worker.ts", "protocol-fixture": "examples/protocol/main.ts", "host-plain": "examples/hosts/plain-main.ts", "host-react": "examples/hosts/react-main.tsx" }, outdir: "artifacts/site",
        bundle: true, format: "esm", platform: "browser", target: "es2022", sourcemap: true });
    const server = createServer((request, response) => {
        if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405, { Allow: "GET, HEAD" }).end(); return; }
        let path;
        try { path = decodeURIComponent(new URL(request.url, "http://localhost").pathname); }
        catch { response.writeHead(400).end(); return; }
        if (failed) { response.writeHead(503).end("Development build failed."); return; }
        const bytes = pages.get(path) ?? modules.get(path);
        if (!bytes) { response.writeHead(404).end(); return; }
        response.writeHead(200, { "Content-Type": /\.js$/.test(path) ? "text/javascript" : /\.css$/.test(path) ? "text/css" : /\.map$/.test(path) ? "application/json" : "text/html",
            "Content-Length": bytes.length, "Cache-Control": "no-store" });
        response.end(request.method === "HEAD" ? undefined : bytes);
    });
    const releaseProtocolFixture = attachProtocolFixture(server);
    try {
        await builder.watch(); await initial;
        if (failed) throw new Error("Initial development build failed.");
        await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
    } catch (error) { releaseProtocolFixture(); await builder.dispose(); throw error; }
    let closing;
    return { url: `http://127.0.0.1:${server.address().port}`, close: () => closing ??= (async () => {
        releaseProtocolFixture(); await builder.dispose(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    })() };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const server = await startServer(4173);
    console.log(`StTropez: ${server.url}`);
    process.on("SIGINT", async () => { await server.close(); process.exit(0); });
    process.on("SIGTERM", async () => { await server.close(); process.exit(0); });
}
