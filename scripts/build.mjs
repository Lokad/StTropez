import { build } from "esbuild";
import { mkdir, writeFile, copyFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { libraryModules, libraryCss, regexWorker } from "./library-entries.mjs";

const runtimeByteBudget = 557_733;

export async function buildLibrary() {
    const output = fileURLToPath(new URL("../dist", import.meta.url));
    if (output !== resolve("dist")) throw new Error("Build must run from the project root.");
    const main = await build({ entryPoints: Object.fromEntries(libraryModules.map(entry => [entry.output.slice(0, -3), entry.source])),
        outdir: "dist", bundle: true, splitting: true, format: "esm", platform: "browser", target: "es2022",
        minify: true, metafile: true, write: false });
    // A standalone worker can be served at a host-selected URL without relocating shared chunks.
    const worker = await build({ entryPoints: [regexWorker.source], outfile: `dist/${regexWorker.output}`,
        bundle: true, format: "esm", platform: "browser", target: "es2022", minify: true, metafile: true, write: false });
    if (Object.values(worker.metafile.outputs).some(output => output.imports.length)) throw new Error("Regex worker must be a standalone compiled asset.");
    const results = [main, worker], inputs = [...new Set(results.flatMap(result => Object.keys(result.metafile.inputs)))];
    // Check the resolved graph: imports from reference checkouts or packages must fail the build.
    for (const input of inputs) {
        if (!input.replaceAll("\\", "/").startsWith("src/")) throw new Error(`Unexpected runtime input: ${input}`);
    }
    const files = results.flatMap(result => result.outputFiles);
    const bytes = files.reduce((sum, file) => sum + file.contents.length, 0);
    if (bytes > runtimeByteBudget) {
        throw new Error(`Runtime JavaScript is ${bytes} bytes, exceeding the ${runtimeByteBudget}-byte budget.`);
    }
    // Only this known generated directory is cleared; stale chunks must not enter packages.
    await rm(output, { recursive: true, force: true });
    let gzipBytes = 0;
    for (const file of files) {
        await mkdir(dirname(file.path), { recursive: true });
        await writeFile(file.path, file.contents);
        gzipBytes += gzipSync(file.contents, { level: 9 }).length;
    }
    await copyFile(libraryCss.source, `dist/${libraryCss.output}`);
    await copyFile("LICENSE.txt", "dist/LICENSE.txt");
    await copyFile("licenses/Unicode-3.0.txt", "dist/UNICODE-LICENSE.txt");
    await mkdir("artifacts", { recursive: true });
    await writeFile("artifacts/bundle.json", JSON.stringify({ bytes, gzipBytes, inputs, workers: [regexWorker.output] }, null, 2));
    console.log(`Runtime JavaScript: ${bytes} bytes; ${gzipBytes} bytes gzip. No external inputs.`);
}
await buildLibrary();
