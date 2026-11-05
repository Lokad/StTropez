import { context } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export async function startServer(port) {
    await mkdir("artifacts/site", { recursive: true });
    await copyFile("examples/playground/index.html", "artifacts/site/index.html");
    const builder = await context({ entryPoints: ["examples/playground/main.ts"], outfile: "artifacts/site/app.js",
        bundle: true, format: "esm", platform: "browser", target: "es2022", sourcemap: true });
    await builder.watch();
    const server = await builder.serve({ host: "127.0.0.1", port, servedir: "artifacts/site" });
    return { url: `http://127.0.0.1:${server.port}`, close: () => builder.dispose() };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const server = await startServer(4173);
    console.log(`StTropez: ${server.url}`);
    process.on("SIGINT", async () => { await server.close(); process.exit(0); });
    process.on("SIGTERM", async () => { await server.close(); process.exit(0); });
}
