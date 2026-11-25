import { context } from "esbuild";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { attachProtocolFixture } from "../tests/fixtures/protocol/fixture-server.ts";
import { demoBundle, demoFontFiles, demoFontSource, demoLibraries } from "./demo-assets.mjs";
import { libraryCss, regexWorker } from "./library-entries.mjs";
import { closePackageResources, closePackageServer, listenPackageServer, sendAsset } from "./package-host.mjs";

/**
 * @param {number} port
 * @param {{watch?: boolean; serverProvider?: boolean}} [options]
 */
export async function startServer(port, { watch = true, serverProvider = false } = {}) {
    const attachDemoProvider = serverProvider ? (await import("../tests/fixtures/demo/provider-server.ts")).attachDemoProvider : undefined;
    const routes = {
        "/": "examples/demo/index.html",
        "/reference/": "examples/reference/index.html",
        "/viewport/": "tests/fixtures/viewport/index.html",
        "/editing/": "tests/fixtures/editing/index.html",
        "/comparison/": "tests/fixtures/comparison/index.html",
        "/protocol/": "tests/fixtures/protocol/index.html",
        "/hosts/plain/": "tests/fixtures/hosts/plain.html",
        "/hosts/react/": "tests/fixtures/hosts/react.html",
    };
    /** @type {Map<string, Buffer>} */
    const pages = new Map();
    for (const [path, file] of Object.entries(routes)) {
        const bytes = await readFile(file);
        pages.set(path, bytes);
        pages.set(path + "index.html", bytes);
    }
    const site = resolve("artifacts/site");
    pages.set("/typescript-libs.json", Buffer.from(await demoLibraries()));
    pages.set("/presentation-fixture/", Buffer.from("<!doctype html>"));
    for (const name of demoFontFiles) pages.set("/" + name, await readFile(demoFontSource(name)));
    /** @type {Map<string, Uint8Array>} */
    let modules = new Map();
    let failed = false;
    /** @type {() => void} */
    let firstBuild;
    /** @type {Promise<void>} */
    const initial = new Promise(resolve => { firstBuild = resolve; });
    // Requests consume completed builds. In particular, starting a worker must not trigger
    // compilation of every host before that worker can answer its first message.
    const builder = await context({
        ...demoBundle,
        entryPoints: {
            ...demoBundle.entryPoints,
            app: serverProvider ? "tests/fixtures/demo/main.ts" : demoBundle.entryPoints.app,
            comparison: "tests/fixtures/comparison/main.ts",
            editing: "tests/fixtures/editing/main.ts",
            viewport: "tests/fixtures/viewport/main.ts",
            "regex-worker": regexWorker.source,
            "protocol-fixture": "tests/fixtures/protocol/main.ts",
            "host-plain": "tests/fixtures/hosts/plain-entry.ts",
            "host-react": "tests/fixtures/hosts/react-entry.ts",
            "reference/app": "examples/reference/main.ts",
            "reference/style": "examples/reference/style.css",
        },
        outdir: site,
        write: false,
        sourcemap: true,
        alias: { [libraryCss.specifier]: resolve(libraryCss.source) },
        plugins: [{
            name: "completed-dev-build",
            setup(build) {
                build.onEnd(result => {
                    failed = result.errors.length > 0;
                    if (!failed) {
                        // A successful in-memory build supplies all output files.
                        const files = /** @type {import("esbuild").OutputFile[]} */ (result.outputFiles);
                        modules = new Map(files.map(file =>
                            ["/" + relative(site, file.path).replaceAll("\\", "/"), file.contents]));
                    }
                    firstBuild();
                });
            },
        }],
    });
    const server = createServer((request, response) => { void handle(request, response).catch(() => { if (!response.headersSent) response.writeHead(500); response.end("Development service failed."); }); });
    const demoProvider = attachDemoProvider?.(server);
    /**
     * @param {import("node:http").IncomingMessage} request
     * @param {import("node:http").ServerResponse} response
     */
    async function handle(request, response) {
        if (demoProvider && await demoProvider.handle(request, response)) return;
        if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405, { Allow: "GET, HEAD" }).end(); return; }
        let path;
        // IncomingMessage.url is populated for server requests.
        try { path = decodeURIComponent(new URL(/** @type {string} */ (request.url), "http://localhost").pathname); }
        catch { response.writeHead(400).end(); return; }
        if (failed) { response.writeHead(503).end("Development build failed."); return; }
        const bytes = pages.get(path) ?? modules.get(path === "/reference/regex-worker.js" ? "/regex-worker.js" : path);
        if (!bytes) { response.writeHead(404).end(); return; }
        response.setHeader("Cache-Control", "no-store");
        sendAsset(request, response, path, bytes);
    }
    const releaseProtocolFixture = attachProtocolFixture(server, { allowOtherUpgrades: true });
    server.on("upgrade", (request, socket) => {
        const path = new URL(/** @type {string} */ (request.url), "http://localhost").pathname;
        if (path !== "/lsp-fixture" && !(demoProvider && /^\/demo-provider\/[a-f0-9-]+$/.test(path))) socket.destroy();
    });
    /** @param {readonly unknown[]} [failures] */
    const release = (failures = []) => closePackageResources([
        releaseProtocolFixture, () => demoProvider?.close(), () => builder.dispose(), () => closePackageServer(server),
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
    const server = await startServer(Number(process.env.STTROPEZ_PORT ?? 4173), { serverProvider: process.argv.includes("--server-provider") });
    console.log(`StTropez: ${server.url}`);
    process.on("SIGINT", async () => { await server.close(); process.exit(0); });
    process.on("SIGTERM", async () => { await server.close(); process.exit(0); });
}
