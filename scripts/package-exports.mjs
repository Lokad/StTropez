import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { consumerCompilerRoots, within } from "./package-react-host.mjs";
import { moduleSpecifiers } from "./module-specifiers.mjs";

/**
 * A host-owned local package mount: no install, aliases, paths or library compilation.
 * @param {string} project
 * @param {string} consumer
 * @param {string} assetRoot
 */
export async function qualifyPackageExports(project, consumer, assetRoot) {
    await mkdir(join(consumer, "exports-probe/node_modules"), { recursive: true });
    const root = await realpath(join(consumer, "exports-probe")), installed = join(root, "node_modules/sttropez");
    await cp(assetRoot, installed, { recursive: true, force: false, errorOnExist: true });
    /** @type {{ assets: { path: string }[]; entries: Record<"core" | "browser" | "protocol" | "kernels" | "css" | "regexWorker", string> }} */
    const manifest = JSON.parse(await readFile(join(installed, "manifest.json"), "utf8"));
    for (const asset of manifest.assets.filter(asset => asset.path.endsWith(".d.ts"))) {
        const source = await readFile(join(installed, asset.path), "utf8");
        assert.ok(!moduleSpecifiers(asset.path, source).some(item => /^\.\.?\//.test(item.value) && /\.(?:[cm]?ts|tsx)$/.test(item.value)),
            `Source extension in shipped declaration: ${asset.path}`);
    }
    await writeFile(join(root, "package.json"), '{"type":"module"}\n');
    await writeFile(join(root, "main.ts"), `import * as core from "sttropez";
import * as browser from "sttropez/browser";
import * as protocol from "sttropez/protocol";
import * as kernels from "sttropez/kernels";
export { core, browser, protocol, kernels };

type RequiresTrue<T extends true> = T;
type HoverDocument = Parameters<ReturnType<typeof protocol.createLspHoverClient>["options"]>[0];
type Mapping = NonNullable<HoverDocument["change"]>["mapping"];
// The inferred declaration used to allow arbitrary properties on the inverse mapping.
type Inverse = ReturnType<Mapping["invert"]>;
type TypedInverse = RequiresTrue<string extends keyof Inverse ? false : true>;
type ColorMethods = NonNullable<Parameters<protocol.LspColorClient["options"]>[1]>;
type HasColorPresentation = RequiresTrue<"textDocument/colorPresentation" extends ColorMethods ? true : false>;
`);
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext",
        strict: true, skipLibCheck: false, noEmit: true, types: [] }, files: ["main.ts"] }));
    const compilerOutput = execFileSync(process.execPath, [join(project, "node_modules/typescript/bin/tsc"), "-p", join(root, "tsconfig.json"), "--listFiles", "--pretty", "false"],
        { cwd: root, encoding: "utf8", stdio: "pipe" });
    const compilerRoots = await consumerCompilerRoots(project), typeInputs = [];
    for (const path of compilerOutput.split(/\r?\n/).filter(Boolean)) {
        const input = await realpath(resolve(root, path));
        assert.ok(within(root, input) || compilerRoots.some(directory => within(directory, input)), `Declaration escaped the exports consumer: ${input}`);
        typeInputs.push(input);
    }
    for (const entry of ["index.d.ts", "browser/index.d.ts", "protocol/index.d.ts", "kernels/index.d.ts"]) assert.ok(typeInputs.includes(await realpath(join(installed, entry))), `Missing exports declaration: ${entry}`);
    const bundle = await build({ absWorkingDir: root, entryPoints: ["main.ts"], bundle: true, write: false, format: "esm", platform: "browser", metafile: true });
    const bundleInputs = Object.keys(bundle.metafile.inputs);
    for (const path of bundleInputs) assert.ok(within(root, await realpath(resolve(root, path))), `Runtime escaped the exports consumer: ${path}`);
    for (const entry of ["index.js", "browser/index.js", "protocol/index.js", "kernels/index.js"]) assert.ok(bundleInputs.includes(`node_modules/sttropez/${entry}`), `Missing exports runtime: ${entry}`);
    await writeFile(join(root, "resolve.mjs"), `import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import * as core from "sttropez";
import * as protocol from "sttropez/protocol";
import * as kernels from "sttropez/kernels";
assert.deepEqual(kernels.decodeLspColor({ red: 0, green: 1, blue: 0, alpha: 1 }), { red: 0, green: 1, blue: 0, alpha: 1 });
assert.ok(Object.keys(protocol).every(name => !name.startsWith("decodeLsp")));
assert.equal("JsonRpcConnection" in protocol, false);
assert.equal("LspSession" in protocol, false);
assert.equal("TextDiff" in core, false);
assert.equal(typeof kernels.TextDiff, "function");
const names = ["sttropez", "sttropez/browser", "sttropez/protocol", "sttropez/kernels", "sttropez/editor.css", "sttropez/regex-worker.js"];
assert.equal(core.TextBuffer.from("export probe").slice(0, 6), "export");
assert.throws(() => import.meta.resolve("sttropez/core/text-buffer.js"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
console.log(JSON.stringify(Object.fromEntries(names.map(name => [name, fileURLToPath(import.meta.resolve(name))]))));\n`);
    const entries = JSON.parse(execFileSync(process.execPath, [join(root, "resolve.mjs")], { cwd: root, encoding: "utf8", stdio: "pipe" }));
    const expected = { sttropez: manifest.entries.core, "sttropez/browser": manifest.entries.browser, "sttropez/protocol": manifest.entries.protocol, "sttropez/kernels": manifest.entries.kernels,
        "sttropez/editor.css": manifest.entries.css, "sttropez/regex-worker.js": manifest.entries.regexWorker };
    assert.deepEqual(Object.keys(entries), Object.keys(expected));
    for (const [name, path] of Object.entries(entries)) {
        assert.equal(await realpath(path), await realpath(join(installed, expected[/** @type {keyof typeof expected} */ (name)])), `Wrong exported asset: ${name}`);
        assert.ok(within(installed, await realpath(path))); assert.ok((await readFile(path)).length);
    }
    const metadata = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
    assert.equal(metadata.license, "MIT"); assert.equal(metadata.dependencies, undefined);
    return { root, entries, typeInputs, bundleInputs, strictDeclarations: true, sourceImports: false, privateImportsRejected: true, aliases: false, paths: false, installation: false };
}
