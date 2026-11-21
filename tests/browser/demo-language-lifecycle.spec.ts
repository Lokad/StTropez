import { build } from "esbuild";
import { basename } from "node:path";
import { test, expect } from "./fixtures.ts";

test("language mounting releases partial owners, preserves failures and rejects late attachment", async ({ page }, info) => {
    const built = await build({ entryPoints: { project: "examples/demo/project.ts", language: "examples/demo/language-view.ts",
        browser: "src/browser/index.ts", provider: "examples/demo/provider.ts" }, outdir: "artifacts/demo-language-lifecycle",
        bundle: true, splitting: true, format: "esm", platform: "browser", target: "es2022", write: false });
    const modules = new Map(built.outputFiles.map(file => [basename(file.path), file.text]));
    await page.route("**/demo-language-lifecycle/**", route => {
        const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
        return modules.has(name) ? route.fulfill({ contentType: "text/javascript", body: modules.get(name)! }) : route.abort();
    });
    // Keep the real loopback document's network address space for its WebSocket.
    await page.route("**/workspace-fixture.js", route => route.fulfill({ contentType: "text/javascript", body: "" }));
    await page.goto("/workspace/");
    await page.setContent('<base href="/"><link rel="stylesheet" href="/app.css"><div id="mount" style="width:600px;height:240px"></div>');
    const results = await page.evaluate(async () => {
        const path = "/demo-language-lifecycle/";
        const { DemoProject } = await import(path + "project.js") as typeof import("../../examples/demo/project.ts");
        const { selectDemoProvider } = await import(path + "provider.js") as typeof import("../../examples/demo/provider.ts");
        const { mountDemoLanguage } = await import(path + "language.js") as typeof import("../../examples/demo/language-view.ts");
        const { mountTextEditor } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const project = await DemoProject.open("pricing", () => true, selectDemoProvider("server"));
        const provider = await project.language.connect();
        if (project.language.state.getSnapshot().checking) await new Promise<void>(resolve => {
            const stop = project.language.state.subscribe(() => { if (!project.language.state.getSnapshot().checking) { stop(); resolve(); } });
        });
        const file = project.files[0]!, editor = mountTextEditor(document.querySelector<HTMLDivElement>("#mount")!, project.workspace, file.tab, { view: file.view });
        const frames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const ownership = () => {
            const { resources, documents, tabs, views, leases, subscriptions } = project.workspace.diagnostics();
            return { resources, documents, tabs, views, leases, subscriptions };
        };
        const panels = ".demo-completion, .demo-snippet, .demo-language-popups, .demo-symbols, .demo-rename, .demo-actions";
        const results = [];
        try {
            await frames();
            for (const point of ["sync", "nested", "cleanup", "late"] as const) {
                const before = ownership(), failure = new Error("Mount failed"), cleanupFailure = new Error("Cleanup failed"), errors: unknown[] = [];
                const append = Element.prototype.append, remove = Element.prototype.remove;
                let view: ReturnType<typeof mountDemoLanguage> | undefined, injected = false, cleaned = false;
                let release: ((provider: Awaited<ReturnType<typeof project.language.connect>>) => void) | undefined;
                // This view is still connecting; only the project used by the other cases is ready.
                const delayed = Object.create(project.language, { connectedProvider: { value: undefined } }) as typeof project.language;
                if (point === "late") delayed.connect = () => new Promise(resolve => { release = resolve; });
                Element.prototype.append = function (...nodes) {
                    append.apply(this, nodes);
                    const marker = point === "sync" ? "demo-snippet" : "demo-actions";
                    if (point !== "late" && !injected && this === document.body && nodes.some(node => node instanceof Element && node.classList.contains(marker))) {
                        injected = true; throw failure;
                    }
                };
                Element.prototype.remove = function () {
                    remove.call(this);
                    if (point === "cleanup" && !cleaned && this.classList.contains("demo-language-popups")) { cleaned = true; throw cleanupFailure; }
                };
                try {
                    try { view = mountDemoLanguage(project.workspace, () => project.files, file, editor, point === "late" ? delayed : project.language, () => {}, error => errors.push(error)); }
                    catch (error) { errors.push(error); }
                    if (point === "late") { view!.dispose(); view!.dispose(); release!(provider); }
                    await frames();
                    const reported = errors[0];
                    results.push({ point, before, after: ownership(), panels: document.querySelectorAll(panels).length, errors: errors.length,
                        original: point === "late" ? errors.length === 0 : point === "cleanup" ? reported instanceof AggregateError
                            && reported.errors[0] === failure && reported.errors[1] === cleanupFailure : reported === failure });
                } finally {
                    Element.prototype.append = append; Element.prototype.remove = remove;
                    view?.dispose(); view?.dispose();
                }
            }
            const view = mountDemoLanguage(project.workspace, () => project.files, file, editor, project.language, () => {}, error => { throw error; });
            await frames();
            results.push({ point: "retry", panels: document.querySelectorAll(panels).length }); view.dispose();
        } finally { editor.dispose(); project.dispose(); await project.language.dispose(); }
        return results;
    });
    await info.attach("language-ownership", { body: JSON.stringify(results, null, 2), contentType: "application/json" });
    for (const result of results) {
        if (result.point === "retry") { expect(result.panels).toBe(6); continue; }
        expect(result.after, result.point).toEqual(result.before);
        expect(result.panels, result.point).toBe(0); expect(result.original, result.point).toBe(true);
        expect(result.errors, result.point).toBe(result.point === "late" ? 0 : 1);
    }
});
