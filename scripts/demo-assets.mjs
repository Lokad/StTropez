import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** @satisfies {import("esbuild").BuildOptions} */
export const demoBundle = {
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    entryPoints: {
        app: "examples/demo/browser-main.ts",
        "demo-syntax-worker": "examples/demo/syntax-worker.ts",
        "demo-language-worker": "examples/demo/language-worker.ts"
    }
};

export const demoFontFiles = ["FiraCode-Regular.woff2", "FiraCode-LICENSE.txt"];

/** @param {string} name */
export function demoFontSource(name) {
    return new URL(`../examples/demo/fonts/${name}`, import.meta.url);
}

/** Same pinned standard-library catalogue for development and the static worker. */
export async function demoLibraries() {
    const root = "node_modules/typescript-demo/lib";
    /** @type {Record<string, string>} */
    const libraries = {};
    for (const name of (await readdir(root)).filter((name) => /^lib[\w.-]*\.d\.ts$/.test(name)).sort()) {
        libraries[name] = await readFile(join(root, name), "utf8");
    }
    return JSON.stringify(libraries);
}
