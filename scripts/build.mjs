import { build } from "esbuild";
import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

export async function buildLibrary() {
    const result = await build({ entryPoints: { index: "src/index.ts", "browser/index": "src/browser/index.ts" },
        outdir: "dist", bundle: true, splitting: true, format: "esm", platform: "browser", target: "es2022",
        minify: true, metafile: true, write: false });
    // Check the resolved graph: imports from reference checkouts or packages must fail the build.
    for (const input of Object.keys(result.metafile.inputs)) {
        if (!input.replaceAll("\\", "/").startsWith("src/")) throw new Error(`Unexpected runtime input: ${input}`);
    }
    let bytes = 0, gzipBytes = 0;
    for (const file of result.outputFiles) {
        await mkdir(new URL("../dist/browser/", import.meta.url), { recursive: true });
        await writeFile(file.path, file.contents);
        bytes += file.contents.length; gzipBytes += gzipSync(file.contents, { level: 9 }).length;
    }
    await copyFile("src/browser/editor.css", "dist/editor.css");
    await mkdir("artifacts", { recursive: true });
    await writeFile("artifacts/bundle.json", JSON.stringify({ bytes, gzipBytes, inputs: Object.keys(result.metafile.inputs) }, null, 2));
    console.log(`Runtime JavaScript: ${bytes} bytes; ${gzipBytes} bytes gzip. No external inputs.`);
}
await buildLibrary();
