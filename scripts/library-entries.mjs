import assert from "node:assert/strict";
import metadata from "../package.json" with { type: "json" };

// package.json owns public paths. The assets-only package has the same exports,
// relative to its asset root rather than the repository's dist directory.
/** @param {string} target */
function assetTarget(target) {
    assert.ok(target.startsWith("./dist/"), `Public entry must target dist: ${target}`);
    return `./${target.slice("./dist/".length)}`;
}
export const assetPackageExports = Object.fromEntries(
    Object.entries(metadata.exports).map(([subpath, target]) => [
        subpath,
        typeof target === "string"
            ? assetTarget(target)
            : Object.fromEntries(Object.entries(target).map(([condition, path]) => [condition, assetTarget(path)]))
    ])
);

/** @param {string} subpath */
const specifier = (subpath) => (subpath === "." ? metadata.name : metadata.name + subpath.slice(1));
// Compiled module/worker paths mirror src; the stylesheet is the one flattened source path.
export const libraryModules = Object.entries(assetPackageExports).flatMap(([subpath, target]) => {
    if (typeof target === "string") return [];
    const module = target.import,
        types = target.types;
    assert.ok(
        typeof module === "string" && module.endsWith(".js") && typeof types === "string" && types.endsWith(".d.ts"),
        `Expected module and declarations: ${subpath}`
    );
    const output = module.slice(2);
    return [
        {
            name: subpath === "." ? "core" : subpath.slice(2),
            specifier: specifier(subpath),
            source: `src/${output.slice(0, -3)}.ts`,
            output,
            types: types.slice(2)
        }
    ];
});
const css = assetPackageExports["./editor.css"],
    worker = assetPackageExports["./regex-worker.js"];
assert.ok(typeof css === "string", "Expected a direct stylesheet entry.");
assert.ok(typeof worker === "string", "Expected a direct worker entry.");
export const libraryCss = {
    specifier: specifier("./editor.css"),
    source: "src/browser/editor.css",
    output: css.slice(2)
};
const workerOutput = worker.slice(2);
export const regexWorker = { source: `src/${workerOutput.slice(0, -3)}.ts`, output: workerOutput };
const core = libraryModules.find((entry) => entry.name === "core");
assert.ok(core, "Expected a core module entry.");
export const assetManifestEntries = {
    ...Object.fromEntries(libraryModules.map((entry) => [entry.name, entry.output])),
    types: core.types,
    css: libraryCss.output,
    regexWorker: regexWorker.output
};
