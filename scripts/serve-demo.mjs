import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { closePackageResources, closePackageServer, createPackageRequestHandler, listenPackageServer } from "./package-host.mjs";

/** Static-only qualification server: no language backend, source fallback or SPA fallback. */
export async function serveDemo(port = 0, prefix = "/StTropez/") {
    const manifest = /** @type {{assets: readonly {path: string}[]}} */ (JSON.parse(await readFile("artifacts/pages-build.json", "utf8")));
    return serveStatic("artifacts/pages", new Set(manifest.assets.map(asset => asset.path)), port, prefix);
}

/** @param {string} directory @param {ReadonlySet<string>} files */
export async function serveStatic(directory, files, port = 0, prefix = "/") {
    /** @type {unknown[]} */
    const failures = [];
    const requests = createPackageRequestHandler(async (request, response) => {
        const url = new URL(request.url ?? "/", "http://localhost"), name = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) || "index.html" : "";
        if (!files.has(name) || request.method !== "GET" && request.method !== "HEAD") { response.writeHead(404).end(); return; }
        const bytes = await readFile(join(directory, name));
        response.writeHead(200, { "Content-Type": name.endsWith(".woff2") ? "font/woff2" : name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".json") ? "application/json" : name.endsWith(".html") ? "text/html" : "text/plain", "Content-Length": bytes.length });
        response.end(request.method === "HEAD" ? undefined : bytes);
    }, failures);
    const server = createServer(requests.listener);
    /** @type {Promise<void> | undefined} */
    let closing;
    const close = () => closing ??= closePackageResources([() => closePackageServer(server), () => requests.settled()], failures);
    try { await listenPackageServer(server, port); }
    catch (error) { failures.push(error); await close(); }
    // listenPackageServer binds a numeric TCP port before its address is captured.
    const address = /** @type {import("node:net").AddressInfo} */ (server.address());
    return { url: `http://127.0.0.1:${address.port}${prefix}`, close };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const server = await serveDemo(Number(process.env.STTROPEZ_DEMO_PORT ?? 4174)); console.log(`Static demo: ${server.url}`);
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => { await server.close(); process.exit(0); });
}
