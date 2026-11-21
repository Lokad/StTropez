import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { build } from "esbuild";
import { libraryModules, libraryCss } from "./library-entries.mjs";

/**
 * @param {string} root
 * @param {string} path
 */
export function within(root, path) {
    const remainder = relative(root, path);
    return remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder);
}

/** @param {string} project */
export async function consumerCompilerRoots(project) {
    const compilerRoot = await realpath(join(project, "node_modules/typescript"));
    const compilerPackage = JSON.parse(await readFile(join(compilerRoot, "package.json"), "utf8"));
    const roots = [join(compilerRoot, "lib")], platformCompiler = `@typescript/typescript-${process.platform}-${process.arch}`;
    if (compilerPackage.optionalDependencies?.[platformCompiler]) {
        const root = await realpath(join(project, "node_modules", platformCompiler));
        const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
        assert.equal(metadata.version, compilerPackage.optionalDependencies[platformCompiler]);
        assert.equal(metadata.version, compilerPackage.version); roots.push(join(root, "lib"));
    }
    return roots;
}

const publicImports = new Map([...libraryModules, libraryCss].map(entry => [entry.source, entry.specifier]));

/** Stage only host fixtures, resolving every library import through a public package entry.
 * @param {string} project
 * @param {string} consumer
 * @param {string} path
 * @param {string} [destination]
 */
export async function stageHostFixture(project, consumer, path, destination = join("host-fixtures", path)) {
    assert.ok((path.startsWith("examples/") || path.startsWith("fixtures/protocol/") || path.startsWith("fixtures/language/")) && !path.includes(".."), `Unexpected host fixture: ${path}`);
    const original = resolve(project, path), text = await readFile(original, "utf8"),
        /** @type {{original: string; restored: string}[]} */ imports = [];
    // Include type-only imports erased from the emitted graph; reject private library imports.
    const staged = text.replace(/(["'])((?:\.\.\/)+src\/[^"']+)\1/g, (_match, quote, specifier) => {
        const target = resolve(dirname(original), specifier);
        assert.ok(within(project, target), `Host import escaped project: ${specifier}`);
        const local = relative(project, target).replaceAll("\\", "/"), replacement = publicImports.get(local);
        assert.ok(replacement, `Host imported a private library module: ${local}`);
        imports.push({ original: specifier, restored: replacement });
        return quote + replacement + quote;
    });
    const output = join(consumer, destination);
    assert.ok(within(consumer, output));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, staged);
    /** @param {string} value */
    const hash = value => createHash("sha256").update(value).digest("hex");
    return { path, stagedPath: relative(consumer, output).replaceAll("\\", "/"), sourceSha256: hash(text), stagedSha256: hash(staged), publicImports: imports };
}

/** Reuse the development host; the consumer never receives checkout library sources.
 * @param {string} project
 * @param {string} consumer
 */
export async function stagePackagedReactHost(project, consumer) {
    const entryPoints = {
        "host-react": "host-fixtures/react-entry.ts",
    };
    // Seed contracts whose type-only imports disappear from the bundle graph.
    const graph = await build({ absWorkingDir: project, entryPoints: ["examples/hosts/react-main.tsx",
        "examples/shared/language/provider-contract.ts", "examples/shared/language/navigation-service.ts"],
        outdir: join(consumer, "graph"), bundle: true, platform: "browser", format: "esm", target: "es2022", packages: "external", write: false, metafile: true,
        plugins: [{ name: "host-public-imports", setup(builder) {
            builder.onResolve({ filter: /^\./ }, args => {
                const local = relative(project, resolve(args.resolveDir, args.path)).replaceAll("\\", "/");
                if (!local.startsWith("src/")) return;
                const restored = publicImports.get(local);
                assert.ok(restored, `Host imported a private library module: ${local}`);
                return { path: restored, external: true };
            });
        } }],
    });
    const sources = [];
    for (const path of Object.keys(graph.metafile.inputs).sort()) sources.push(await stageHostFixture(project, consumer, path));
    await writeFile(join(consumer, entryPoints["host-react"]), 'import { startReactHost } from "./examples/hosts/react-main.tsx";\nstartReactHost();\n');
    const shim = "host-fixtures/styles.d.ts";
    await writeFile(join(consumer, shim), 'declare module "*.css";\n');
    const reactTypes = await realpath(join(project, "node_modules/@types/react")), reactDomTypes = await realpath(join(project, "node_modules/@types/react-dom"));
    const typePackageRoots = [reactTypes, reactDomTypes, ...await consumerCompilerRoots(project), await realpath(join(project, "node_modules/csstype"))];
    const /** @type {string[]} */ hostPackageRoots = [], hostPackages = [];
    for (const name of ["react", "react-dom", "scheduler"]) {
        const root = await realpath(join(project, "node_modules", name));
        hostPackageRoots.push(root);
        hostPackages.push({ name, version: JSON.parse(await readFile(join(root, "package.json"), "utf8")).version });
    }
    return {
        entryPoints,
        compilerFiles: [...Object.values(entryPoints), shim],
        compilerOptions: { jsx: "react-jsx", allowImportingTsExtensions: true, paths: {
            react: [join(reactTypes, "index.d.ts")],
            "react/jsx-runtime": [join(reactTypes, "jsx-runtime.d.ts")],
            "react/jsx-dev-runtime": [join(reactTypes, "jsx-dev-runtime.d.ts")],
            "react-dom": [join(reactDomTypes, "index.d.ts")],
            "react-dom/client": [join(reactDomTypes, "client.d.ts")],
        } },
        html: await readFile(join(project, "examples/hosts/react.html"), "utf8"),
        nodePaths: [await realpath(join(project, "node_modules"))],
        hostPackageRoots,
        allowInput: /** @param {string} input */ input => within(consumer, input) || hostPackageRoots.some(root => within(root, input)),
        allowTypeInput: /** @param {string} input */ input => within(consumer, input) || /\.d\.[cm]?ts$/.test(input) && typePackageRoots.some(root => within(root, input)),
        hostPackages,
        sources: sources.sort((a, b) => a.path.localeCompare(b.path)),
    };
}
