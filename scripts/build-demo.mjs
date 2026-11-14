import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { build } from "esbuild";
import { within } from "./package-react-host.mjs";

const project = resolve("."), dist = resolve("dist"), site = resolve("artifacts/pages");
const manifest = JSON.parse(await readFile(join(dist, "manifest.json"), "utf8"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
for (const asset of manifest.assets) assert.equal(hash(await readFile(join(dist, asset.path))), asset.sha256, `Build the library first: ${asset.path}`);
const entries = new Map([["src/index.ts", "index.js"], ["src/browser/index.ts", "browser/index.js"],
    ["src/protocol/index.ts", "protocol/index.js"], ["src/browser/editor.css", "editor.css"]]);
assert.equal(site, join(project, "artifacts", "pages")); assert.ok(within(project, site));
await rm(site, { recursive: true, force: true }); await mkdir(site, { recursive: true });
const result = await build({ absWorkingDir: project,
    entryPoints: { app: "examples/demo/main.ts", "demo-syntax-worker": "examples/demo/syntax-worker.ts", "demo-language-worker": "examples/demo/language-worker.ts" },
    outdir: site, bundle: true, splitting: true, platform: "browser", format: "esm", target: "es2022", minify: true, metafile: true, legalComments: "linked",
    plugins: [{ name: "compiled-public-library", setup(builder) {
        builder.onResolve({ filter: /^\./ }, args => {
            const path = resolve(args.resolveDir, args.path), local = relative(project, path).replaceAll("\\", "/");
            if (local === "examples/demo/provider.ts") return { path: resolve("examples/demo/worker-provider.ts") };
            if (!local.startsWith("src/")) return;
            const entry = entries.get(local); assert.ok(entry, `The demo imported a private library source: ${local}`);
            return { path: join(dist, entry) };
        });
    } }],
});
const hostPackages = ["typescript-demo", "vscode-languageserver-protocol", "vscode-jsonrpc", "vscode-languageserver-types"];
const compilerMetadata = JSON.parse(await readFile("node_modules/typescript-demo/package.json", "utf8"));
const disabled = new Set(Object.entries(compilerMetadata.browser).filter(([, value]) => value === false).map(([name]) => `(disabled):${name}`));
for (const input of Object.keys(result.metafile.inputs)) {
    if (disabled.has(input)) { assert.equal(result.metafile.inputs[input].bytes, 0); continue; }
    const path = resolve(input);
    assert.ok(within(resolve("examples"), path) || within(dist, path) && /\.(js|css)$/.test(path)
        || hostPackages.some(name => within(resolve("node_modules", name), path)), `Unexpected static demo input: ${input}`);
}
assert.ok(Object.keys(result.metafile.inputs).some(input => within(dist, resolve(input))));
assert.ok(!Object.keys(result.metafile.inputs).some(input => input.replaceAll("\\", "/").endsWith("/provider.ts")), "Static demo included the server connection.");
await copyFile("examples/demo/index.html", join(site, "index.html"));
await copyFile(join(dist, manifest.entries.regexWorker), join(site, "regex-worker.js"));
await copyFile(join(dist, "UNICODE-LICENSE.txt"), join(site, "UNICODE-LICENSE.txt"));
await copyFile(join(dist, "LICENSE.txt"), join(site, "LICENSE.txt"));
const libraries = {};
for (const name of (await readdir("node_modules/typescript-demo/lib")).filter(name => /^lib[\w.-]*\.d\.ts$/.test(name)).sort()) {
    libraries[name] = await readFile(join("node_modules/typescript-demo/lib", name), "utf8");
}
await writeFile(join(site, "typescript-libs.json"), JSON.stringify(libraries));
for (const [name, file] of [["typescript-demo", "LICENSE.txt"], ["typescript-demo", "ThirdPartyNoticeText.txt"],
    ["vscode-languageserver-protocol", "License.txt"], ["vscode-jsonrpc", "License.txt"], ["vscode-languageserver-types", "License.txt"]]) {
    await copyFile(join("node_modules", name, file), join(site, `${name}-${file}`));
}
await writeFile(join(site, ".nojekyll"), "");
// Every deployed file is explicit; stale files from an older build cannot enter the upload.
const outputs = Object.keys(result.metafile.outputs).map(path => relative(site, resolve(path)).replaceAll("\\", "/"));
const files = [...outputs, "index.html", "regex-worker.js", "LICENSE.txt", "UNICODE-LICENSE.txt", "typescript-libs.json", ".nojekyll",
    "typescript-demo-LICENSE.txt", "typescript-demo-ThirdPartyNoticeText.txt", "vscode-languageserver-protocol-License.txt", "vscode-jsonrpc-License.txt", "vscode-languageserver-types-License.txt"];
await writeFile("artifacts/pages-build.json", JSON.stringify({ schemaVersion: 1, libraryManifestSha256: hash(await readFile("dist/manifest.json")),
    librarySourceCompilation: false, compilerVersion: compilerMetadata.version, inputs: Object.keys(result.metafile.inputs),
    assets: await Promise.all(files.sort().map(async path => { assert.ok(within(site, resolve(site, path))); const bytes = await readFile(join(site, path)); return { path, bytes: bytes.length, sha256: hash(bytes) }; })),
}, null, 2) + "\n");
console.log(`Built browser-only demo: ${files.length} static files, compiled public library assets only.`);
