import { build } from "esbuild";
import { mkdir, writeFile, copyFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

export async function buildLibrary() {
    const output = fileURLToPath(new URL("../dist", import.meta.url));
    if (output !== resolve("dist")) throw new Error("Build must run from the project root.");
    // Only this known generated directory is cleared; stale chunks must not enter packages.
    await rm(output, { recursive: true, force: true });
    const main = await build({ entryPoints: { index: "src/index.ts", "browser/index": "src/browser/index.ts" },
        outdir: "dist", bundle: true, splitting: true, format: "esm", platform: "browser", target: "es2022",
        minify: true, metafile: true, write: false });
    // A standalone worker can be served at a host-selected URL without relocating shared chunks.
    const worker = await build({ entryPoints: ["src/browser/regex-worker.ts"], outfile: "dist/browser/regex-worker.js",
        bundle: true, format: "esm", platform: "browser", target: "es2022", minify: true, metafile: true, write: false });
    if (Object.values(worker.metafile.outputs).some(output => output.imports.length)) throw new Error("Regex worker must be a standalone compiled asset.");
    const results = [main, worker], inputs = [...new Set(results.flatMap(result => Object.keys(result.metafile.inputs)))];
    // Check the resolved graph: imports from reference checkouts or packages must fail the build.
    for (const input of inputs) {
        if (!input.replaceAll("\\", "/").startsWith("src/")) throw new Error(`Unexpected runtime input: ${input}`);
    }
    let bytes = 0, gzipBytes = 0;
    for (const file of results.flatMap(result => result.outputFiles)) {
        await mkdir(new URL("../dist/browser/", import.meta.url), { recursive: true });
        await writeFile(file.path, file.contents);
        bytes += file.contents.length; gzipBytes += gzipSync(file.contents, { level: 9 }).length;
    }
    await copyFile("src/browser/editor.css", "dist/editor.css");
    await copyFile("licenses/Unicode-3.0.txt", "dist/UNICODE-LICENSE.txt");
    await mkdir("artifacts", { recursive: true });
    await writeFile("artifacts/bundle.json", JSON.stringify({ bytes, gzipBytes, inputs, workers: ["browser/regex-worker.js"] }, null, 2));
    console.log(`Runtime JavaScript: ${bytes} bytes; ${gzipBytes} bytes gzip. No external inputs.`);
}
await buildLibrary();
