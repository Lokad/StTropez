import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Static-only qualification server: no language backend, source fallback or SPA fallback. */
export async function serveDemo(port = 0, prefix = "/StTropez/") {
    const manifest = JSON.parse(await readFile("artifacts/pages-build.json", "utf8"));
    const files = new Set(manifest.assets.map(asset => asset.path));
    const server = createServer((request, response) => { void (async () => {
        const url = new URL(request.url ?? "/", "http://localhost"), name = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) || "index.html" : "";
        if (!files.has(name) || request.method !== "GET" && request.method !== "HEAD") { response.writeHead(404).end(); return; }
        const bytes = await readFile(join("artifacts/pages", name));
        response.writeHead(200, { "Content-Type": name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".json") ? "application/json" : name.endsWith(".html") ? "text/html" : "text/plain", "Content-Length": bytes.length });
        response.end(request.method === "HEAD" ? undefined : bytes);
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); }); });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
    return { url: `http://127.0.0.1:${server.address().port}${prefix}`, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const server = await serveDemo(Number(process.env.STTROPEZ_DEMO_PORT ?? 4174)); console.log(`Static demo: ${server.url}`);
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => { await server.close(); process.exit(0); });
}
