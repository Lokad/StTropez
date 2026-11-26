import { fixtureModules } from "../helpers/fixture-modules.ts";
import { test, expect } from "./fixtures.ts";

const serveModules = fixtureModules({
    project: "examples/demo/project.ts",
    language: "examples/demo/language-view.ts",
    commands: "examples/demo/language-commands.ts",
    cleanup: "examples/shared/cleanup-scope.ts",
    core: "src/index.ts",
    browser: "src/browser/index.ts",
    provider: "tests/fixtures/demo/server-provider.ts",
});

test.beforeEach(async ({ page }) => {
    await serveModules(page, "/demo-language-lifecycle/");
    // Keep the real loopback document's network address space for its WebSocket.
    await page.route("**/protocol-fixture.js", route => route.fulfill({ contentType: "text/javascript", body: "" }));
    await page.goto("/protocol/");
    await page.setContent('<base href="/"><link rel="stylesheet" href="/app.css"><div id="mount" style="width:600px;height:240px"></div>');
});

test("a host focus change during language startup cannot dispatch from the old pane", async ({ page }) => {
    const calls = await page.evaluate(async () => {
        const path = "/demo-language-lifecycle/";
        const { Workspace } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextEditor } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const { mountLanguageCommands } = await import(path + "commands.js") as typeof import("../../examples/demo/language-commands.ts");
        const { CleanupScope } = await import(path + "cleanup.js") as typeof import("../../examples/shared/cleanup-scope.ts");
        const ws = new Workspace(), file = ws.createTextResource({ scope: "demo", resource: "file", variant: "working" }, "Source", { value: "code" });
        const editor = mountTextEditor(document.querySelector<HTMLElement>("#mount")!, ws, file.documentId);
        const field = document.createElement("button"); document.body.append(field);
        const focused: boolean[] = [];
        try {
            // Sweep both sides of readiness validation and the following promise continuation.
            for (const delay of [0, 1, 2, 3]) {
                const scope = new CleanupScope(), output = document.createElement("output");
                try {
                    const commands = mountLanguageCommands(scope, editor, output, () => { focused.push(editor.getSnapshot().focused); }, error => { throw error; });
                    editor.focus(); editor.commands.run("demo.language.complete");
                    if (!output.textContent) throw new Error("The command did not wait for startup.");
                    commands.ready();
                    let remaining = delay;
                    const leave = () => { if (remaining-- > 0) queueMicrotask(leave); else field.focus(); };
                    leave(); await new Promise<void>(done => setTimeout(done, 0));
                    if (!output.hidden) throw new Error("The old pane retained command feedback.");
                } finally { scope.dispose(); }
            }
        } finally { editor.dispose(); field.remove(); }
        return focused;
    });
    expect(calls).toContain(true); expect(calls).not.toContain(false);
});

test("language mounting releases partial owners, preserves failures and rejects late attachment", async ({ page }, info) => {
    const results = await page.evaluate(async () => {
        const path = "/demo-language-lifecycle/";
        const { DemoProject } = await import(path + "project.js") as typeof import("../../examples/demo/project.ts");
        const { openDemoProvider } = await import(path + "provider.js") as typeof import("../fixtures/demo/server-provider.ts");
        const { mountDemoLanguage } = await import(path + "language.js") as typeof import("../../examples/demo/language-view.ts");
        const { mountTextEditor } = await import(path + "browser.js") as typeof import("../../src/browser/index.ts");
        const project = await DemoProject.open("pricing", () => true, openDemoProvider);
        const prepared = await project.language.prepare();
        if (prepared.getSnapshot().phase !== "disconnected" || project.language.state.getSnapshot().status !== "starting")
            throw new Error("Preparing language controls must keep the initial connection pending.");
        const provider = await project.language.connect();
        if (project.language.state.getSnapshot().checking) await new Promise<void>(resolve => {
            const stop = project.language.state.subscribe(() => { if (!project.language.state.getSnapshot().checking) { stop(); resolve(); } });
        });
        const file = project.files[0]!, editor = mountTextEditor(document.querySelector<HTMLDivElement>("#mount")!, project.workspace, file.resource.documentId, { view: file.view });
        const frames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const ownership = () => {
            const { resources, documents, tabs, views, leases, subscriptions } = project.workspace.diagnostics();
            return { resources, documents, tabs, views, leases, subscriptions };
        };
        const panels = [".st-completion", ".st-signature", ".demo-snippet", ".st-hover", ".st-locations", ".st-rename", ".st-code-actions"];
        const panelCounts = () => panels.map(selector => ({ selector, count: document.querySelectorAll(selector).length }));
        const results = [], feedback = document.createElement("output");
        try {
            await frames();
            for (const point of ["sync", "nested", "cleanup", "late"] as const) {
                const before = ownership(), failure = new Error("Mount failed"), cleanupFailure = new Error("Cleanup failed"), errors: unknown[] = [];
                const append = Element.prototype.append, remove = Element.prototype.remove;
                let view: ReturnType<typeof mountDemoLanguage> | undefined, injected = false, cleaned = false;
                let release: ((provider: Awaited<ReturnType<typeof project.language.connect>>) => void) | undefined;
                // This view is still connecting; only the project used by the other cases is ready.
                const delayed = Object.create(project.language, { preparedProvider: { value: undefined } }) as typeof project.language;
                if (point === "late") delayed.prepare = () => new Promise(resolve => { release = resolve; });
                Element.prototype.append = function (...nodes) {
                    append.apply(this, nodes);
                    const marker = point === "sync" ? "demo-snippet" : "st-code-actions";
                    if (point !== "late" && !injected && nodes.some(node => node instanceof Element && node.classList.contains(marker))) {
                        injected = true; throw failure;
                    }
                };
                Element.prototype.remove = function () {
                    remove.call(this);
                    if (point === "cleanup" && !cleaned && this.classList.contains("demo-snippet")) { cleaned = true; throw cleanupFailure; }
                };
                try {
                    try { view = mountDemoLanguage(project, file, editor, point === "late" ? delayed : project.language, () => {}, error => errors.push(error), feedback, document.body); }
                    catch (error) { errors.push(error); }
                    if (point === "late") { view!.dispose(); view!.dispose(); release!(provider); }
                    await frames();
                    const reported = errors[0];
                    results.push({ point, before, after: ownership(), panels: panelCounts(), errors: errors.length,
                        original: point === "late" ? errors.length === 0 : point === "cleanup" ? reported instanceof AggregateError
                            && reported.errors[0] === failure && reported.errors[1] === cleanupFailure : reported === failure });
                } finally {
                    Element.prototype.append = append; Element.prototype.remove = remove;
                    view?.dispose(); view?.dispose();
                }
            }
            const view = mountDemoLanguage(project, file, editor, project.language, () => {}, error => { throw error; }, feedback, document.body);
            await frames();
            results.push({ point: "retry", panels: panelCounts() }); view.dispose();
        } finally { editor.dispose(); project.dispose(); await project.language.dispose(); }
        return results;
    });
    await info.attach("language-ownership", { body: JSON.stringify(results, null, 2), contentType: "application/json" });
    for (const result of results) {
        for (const { selector, count } of result.panels) {
            expect(count, result.point + " " + selector).toBe(result.point === "retry" ? 1 : 0);
        }
        if (result.point === "retry") continue;
        expect(result.after, result.point).toEqual(result.before);
        expect(result.original, result.point).toBe(true);
        expect(result.errors, result.point).toBe(result.point === "late" ? 0 : 1);
    }
});
