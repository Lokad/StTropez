import { context } from "esbuild";
import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { attachProtocolFixture } from "../fixtures/protocol/fixture-server.ts";
import { attachDemoProvider } from "../examples/demo/provider-server.ts";
import { demoLibraries } from "./demo-libraries.mjs";
import { demoFontFiles, stageDemoFonts } from "./demo-fonts.mjs";
import { closePackageResources, closePackageServer, listenPackageServer } from "./package-host.mjs";

/**
 * @param {number} port
 * @param {{watch?: boolean}} [options]
 */
export async function startServer(port, { watch = true } = {}) {
    await mkdir("artifacts/site", { recursive: true });
    await writeFile("artifacts/site/index.html", (await readFile("examples/demo/index.html", "utf8"))
        .replace('data-demo-provider="browser"', 'data-demo-provider="server"'));
    await mkdir("artifacts/site/workspace", { recursive: true });
    await copyFile("tests/fixtures/workspace/index.html", "artifacts/site/workspace/index.html");
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
        ["/", "/workspace/", "/viewport/", "/editing/", "/comparison/", "/protocol/", "/fonts/", "/hosts/plain/", "/hosts/react/"].flatMap(path => [path, path + "index.html"])
            .map(async path => /** @type {[string, Buffer]} */ ([path, await readFile(resolve(site, "." + (path.endsWith("/") ? path + "index.html" : path)))]))));
    pages.set("/typescript-libs.json", Buffer.from(await demoLibraries()));
    await stageDemoFonts(site);
    for (const name of demoFontFiles) pages.set("/" + name, await readFile(resolve(site, name)));
    /** @type {Map<string, Uint8Array>} */
    let modules = new Map();
    let failed = false;
    /** @type {() => void} */
    let firstBuild;
    /** @type {Promise<void>} */
    const initial = new Promise(resolve => { firstBuild = resolve; });
    // Requests consume completed builds. In particular, starting a worker must not trigger
    // compilation of every host before that worker can answer its first message.
    const builder = await context({ absWorkingDir: process.cwd(), write: false, plugins: [{ name: "completed-dev-build", setup(build) {
        build.onEnd(result => {
            failed = result.errors.length > 0;
            // A successful build with write:false returns its files in memory.
            if (!failed) modules = new Map((/** @type {import("esbuild").OutputFile[]} */ (result.outputFiles))
                .map(file => ["/" + relative(site, file.path).replaceAll("\\", "/"), file.contents]));
            firstBuild();
        });
    } }], entryPoints: { app: "examples/demo/main.ts", "workspace-fixture": "tests/fixtures/workspace/main.ts", "demo-syntax-worker": "examples/demo/syntax-worker.ts", "demo-language-worker": "examples/demo/language-worker.ts", fonts: "tests/fixtures/fonts/main.ts", comparison: "examples/comparison/main.ts", editing: "examples/editing/main.ts", viewport: "examples/viewport/main.ts",
        "regex-worker": "src/browser/regex-worker.ts", "protocol-fixture": "examples/protocol/main.ts", "host-plain": "fixtures/hosts/plain-main.ts", "host-react": "fixtures/hosts/react-main.ts" }, outdir: "artifacts/site",
        bundle: true, format: "esm", platform: "browser", target: "es2022", sourcemap: true });
    const server = createServer((request, response) => { void handle(request, response).catch(() => { if (!response.headersSent) response.writeHead(500); response.end("Development service failed."); }); });
    const demoProvider = attachDemoProvider(server);
    /**
     * @param {import("node:http").IncomingMessage} request
     * @param {import("node:http").ServerResponse} response
     */
    async function handle(request, response) {
        if (await demoProvider.handle(request, response)) return;
        if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405, { Allow: "GET, HEAD" }).end(); return; }
        let path;
        // IncomingMessage.url is populated for server requests.
        try { path = decodeURIComponent(new URL(/** @type {string} */ (request.url), "http://localhost").pathname); }
        catch { response.writeHead(400).end(); return; }
        if (failed) { response.writeHead(503).end("Development build failed."); return; }
        const bytes = pages.get(path) ?? modules.get(path);
        if (!bytes) { response.writeHead(404).end(); return; }
        response.writeHead(200, { "Content-Type": path.endsWith(".woff2") ? "font/woff2" : path.endsWith(".txt") ? "text/plain" : /\.js$/.test(path) ? "text/javascript" : /\.css$/.test(path) ? "text/css" : /\.(map|json)$/.test(path) ? "application/json" : "text/html",
            "Content-Length": bytes.length, "Cache-Control": "no-store" });
        response.end(request.method === "HEAD" ? undefined : bytes);
    }
    const releaseProtocolFixture = attachProtocolFixture(server, { allowOtherUpgrades: true });
    server.on("upgrade", (request, socket) => {
        const path = new URL(/** @type {string} */ (request.url), "http://localhost").pathname;
        if (path !== "/lsp-fixture" && !/^\/demo-provider\/[a-f0-9-]+$/.test(path)) socket.destroy();
    });
    /** @param {readonly unknown[]} [failures] */
    const release = (failures = []) => closePackageResources([
        releaseProtocolFixture, () => demoProvider.close(), () => builder.dispose(), () => closePackageServer(server),
    ], failures);
    try {
        if (watch) { await builder.watch(); await initial; }
        else { await builder.rebuild(); await builder.dispose(); }
        if (failed) throw new Error("Initial development build failed.");
        await listenPackageServer(server, port);
    } catch (error) { await release([error]); }
    /** @type {Promise<void> | undefined} */
    let closing;
    // The numeric-port TCP listener is bound before its address is captured.
    const address = /** @type {import("node:net").AddressInfo} */ (server.address());
    return { url: `http://127.0.0.1:${address.port}`, buildMode: watch ? "development-bundle-watch" : "development-bundle-no-watch", close: () => closing ??= release() };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const server = await startServer(Number(process.env.STTROPEZ_PORT ?? 4173));
    console.log(`StTropez: ${server.url}`);
    process.on("SIGINT", async () => { await server.close(); process.exit(0); });
    process.on("SIGTERM", async () => { await server.close(); process.exit(0); });
}
