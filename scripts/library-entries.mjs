import assert from "node:assert/strict";
import metadata from "../package.json" with { type: "json" };

// package.json owns public paths. The assets-only package has the same exports,
// relative to its asset root rather than the repository's dist directory.
function assetTarget(target) {
    assert.ok(target.startsWith("./dist/"), `Public entry must target dist: ${target}`);
    return `./${target.slice("./dist/".length)}`;
}
export const assetPackageExports = Object.fromEntries(Object.entries(metadata.exports).map(([subpath, target]) =>
    [subpath, typeof target === "string" ? assetTarget(target)
        : Object.fromEntries(Object.entries(target).map(([condition, path]) => [condition, assetTarget(path)]))]));

const specifier = subpath => subpath === "." ? metadata.name : metadata.name + subpath.slice(1);
// Compiled module/worker paths mirror src; the stylesheet is the one flattened source path.
export const libraryModules = Object.entries(assetPackageExports).filter(([, target]) => typeof target !== "string")
    .map(([subpath, target]) => {
        assert.ok(target.import.endsWith(".js") && target.types.endsWith(".d.ts"), `Expected module and declarations: ${subpath}`);
        const output = target.import.slice(2);
        return { name: subpath === "." ? "core" : subpath.slice(2), specifier: specifier(subpath),
            source: `src/${output.slice(0, -3)}.ts`, output, types: target.types.slice(2) };
    });
export const libraryCss = { specifier: specifier("./editor.css"), source: "src/browser/editor.css",
    output: assetPackageExports["./editor.css"].slice(2) };
const workerOutput = assetPackageExports["./regex-worker.js"].slice(2);
export const regexWorker = { source: `src/${workerOutput.slice(0, -3)}.ts`, output: workerOutput };
export const assetManifestEntries = { ...Object.fromEntries(libraryModules.map(entry => [entry.name, entry.output])),
    types: libraryModules.find(entry => entry.name === "core").types, css: libraryCss.output, regexWorker: regexWorker.output };
