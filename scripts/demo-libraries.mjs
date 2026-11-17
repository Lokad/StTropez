import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Same pinned standard-library catalogue for development and the static worker. */
export async function demoLibraries() {
    const root = "node_modules/typescript-demo/lib";
    /** @type {Record<string, string>} */
    const libraries = {};
    for (const name of (await readdir(root)).filter(name => /^lib[\w.-]*\.d\.ts$/.test(name)).sort()) {
        libraries[name] = await readFile(join(root, name), "utf8");
    }
    return JSON.stringify(libraries);
}
