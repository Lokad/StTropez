import type { Page } from "@playwright/test";
import { build, type Plugin } from "esbuild";
import { relative, resolve, sep } from "node:path";

/** Build once per suite worker. Each page imports fresh modules from its own routes. */
export function fixtureModules(entryPoints: Record<string, string>, plugins: Plugin[] = []) {
    const outdir = resolve("artifacts/fixture-modules");
    async function compile() {
        const result = await build({
            entryPoints, plugins, outdir, write: false, bundle: true,
            format: "esm", platform: "browser", target: "es2022", splitting: Object.keys(entryPoints).length > 1,
        });
        return result.outputFiles.filter(file => file.path.endsWith(".js")).map(file => ({
            name: relative(outdir, file.path).split(sep).join("/"), body: file.text,
        }));
    }
    let compiled: ReturnType<typeof compile> | undefined;
    return async (page: Page, prefix: string) => {
        const modules = await (compiled ??= compile());
        const files = new Map(modules.map(file => [prefix + file.name, file.body]));
        await page.route(url => files.has(url.pathname), route => {
            const path = new URL(route.request().url()).pathname;
            return route.fulfill({ body: files.get(path)!, contentType: "text/javascript" });
        });
    };
}

export const editorModules = fixtureModules({ core: "src/index.ts", browser: "src/browser/index.ts" });
export const viewportModules = fixtureModules({ core: "src/index.ts", viewport: "src/browser/viewport.ts" });
