import { context } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

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
    await mkdir("artifacts/site/shaping", { recursive: true });
    await copyFile("examples/shaping/index.html", "artifacts/site/shaping/index.html");
    for (const mode of ["plain", "react"]) {
        await mkdir(`artifacts/site/hosts/${mode}`, { recursive: true });
        await copyFile(`examples/hosts/${mode}.html`, `artifacts/site/hosts/${mode}/index.html`);
    }
    const builder = await context({ entryPoints: { app: "examples/playground/main.ts", shaping: "examples/shaping/main.ts", comparison: "examples/comparison/main.ts", editing: "examples/editing/main.ts", viewport: "examples/viewport/main.ts", probe: "examples/probes/main.ts", "provider-worker": "examples/probes/provider-worker.ts",
        "host-plain": "examples/hosts/plain-main.ts", "host-react": "examples/hosts/react-main.tsx" }, outdir: "artifacts/site",
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
