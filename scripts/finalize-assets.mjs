import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

export async function filesUnder(root) {
    const files = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
        const path = resolve(root, entry.name);
        if (entry.isDirectory()) files.push(...await filesUnder(path));
        else if (entry.isFile()) files.push(path);
        else throw new Error(`Unexpected asset entry: ${entry.name}`);
    }
    return files.sort();
}

const root = resolve("dist");
// Source imports use .ts for direct Node replay. Consumers receive portable .js specifiers.
for (const file of await filesUnder(root)) {
    if (file.endsWith(".d.ts")) {
        const declaration = await readFile(file, "utf8");
        await writeFile(file, declaration.replace(/(from\s+["'][^"']+)\.ts(["'])/g, "$1.js$2"));
    }
}
await writeFile(resolve(root, "package.json"), JSON.stringify({ name: "sttropez", version: "0.0.0-local",
    private: true, type: "module", exports: {
        ".": { types: "./index.d.ts", import: "./index.js" },
        "./browser": { types: "./browser/index.d.ts", import: "./browser/index.js" },
        "./editor.css": "./editor.css",
    } }, null, 2) + "\n");
const assets = [];
for (const file of await filesUnder(root)) {
    const path = relative(root, file).replaceAll("\\", "/");
    if (path === "manifest.json") continue;
    if (!/\.(js|d\.ts|css|json)$/.test(path) && path !== "UNICODE-LICENSE.txt") throw new Error(`Unexpected asset: ${path}`);
    const bytes = await readFile(file);
    assets.push({ path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}
await writeFile(resolve(root, "manifest.json"), JSON.stringify({ schemaVersion: 1, version: "0.0.0-local",
    entries: { core: "index.js", browser: "browser/index.js", types: "index.d.ts", css: "editor.css" },
    assets }, null, 2) + "\n");
