import { test, expect } from "./fixtures.ts";
import { build } from "esbuild";
import { basename } from "node:path";

test("independent comparison modules share workspace identity and release retained baselines after their owners", async ({ page }) => {
    // Two evaluations of the browser entry share one core module, like separately loaded views.
    const built = await build({ entryPoints: { core: "src/index.ts", comparison: "src/browser/comparison.ts" }, outdir: "artifacts/comparison-ownership",
        bundle: true, splitting: true, format: "esm", platform: "browser", target: "es2022", write: false });
    const modules = new Map(built.outputFiles.map(file => [basename(file.path), file.text]));
    await page.route("**/comparison-ownership/**", route => {
        const body = modules.get(new URL(route.request().url()).pathname.split("/").at(-1)!);
        return body === undefined ? route.abort() : route.fulfill({ contentType: "text/javascript", body });
    });
     await page.goto("/comparison/");
    const result = await page.evaluate(async () => {
        const path = "/comparison-ownership/";
        const { Workspace, TextBuffer } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const first = await import(path + "comparison.js?one") as typeof import("../../src/browser/comparison.ts");
        const second = await import(path + "comparison.js?two") as typeof first;
        const workspace = new Workspace(), source = workspace.createTextResource({ scope: "test", resource: "source", variant: "working" }, "Working", { value: "working" });
        const tab = workspace.open({ kind: "text", documentId: source.documentId }, "working"), view = workspace.createDocumentView(source.documentId);
        const host = document.createElement("section"); document.body.append(host);
        const baseline = { buffer: TextBuffer.from("baseline"), version: "one" };
        const one = first.mountTextComparison(host, workspace, tab, baseline, { view, workBudget: 256 });
        const two = second.mountTextComparison(host, workspace, tab, baseline, { view });
        const oldEditor = one.referenceEditor()!, old = workspace.resourceForDocument(oldEditor.view.documentId), oldLease = workspace.acquire(old.id);
        const distinct = old.id !== workspace.resourceForDocument(two.referenceEditor()!.view.documentId).id;
        const changed = new Promise<void>(resolve => {
            const stop = one.reference.subscribe(() => { if (one.reference.getSnapshot()?.version === "two") { stop(); resolve(); } });
        });
        one.controller.beginRefresh().complete({ buffer: TextBuffer.from("new baseline"), version: "two" }); await changed;
        const afterRefresh = { old: old.getSnapshot().state, text: workspace.document(old.documentId).text, oldEditorDisposed: oldEditor.snapshot().disposed };
        const current = workspace.resourceForDocument(one.referenceEditor()!.view.documentId), currentLease = workspace.acquire(current.id);
        one.destroy(); one.destroy(); two.destroy();
        const afterDestroy = { children: host.childElementCount, controllers: [one.controller.getSnapshot().status, two.controller.getSnapshot().status],
            leases: workspace.diagnostics().leases, views: workspace.diagnostics().views, subscriptions: workspace.diagnostics().subscriptions,
            retained: [old.getSnapshot().state, current.getSnapshot().state] };
        oldLease.release(); currentLease.release(); await Promise.resolve();
        const afterRelease = { resources: workspace.diagnostics().resources, retained: [old.getSnapshot().state, current.getSnapshot().state] };
        view.dispose(); workspace.close(tab); workspace.releaseResource(source.id); host.remove();
        return { distinct, afterRefresh, afterDestroy, afterRelease, leases: workspace.diagnostics().leases };
    });
    expect(result).toEqual({ distinct: true, afterRefresh: { old: "ready", text: "baseline", oldEditorDisposed: true },
        afterDestroy: { children: 0, controllers: ["disposed", "disposed"], leases: 3, views: 1, subscriptions: 0, retained: ["ready", "ready"] },
        afterRelease: { resources: 1, retained: ["released", "released"] }, leases: 0 });
});
