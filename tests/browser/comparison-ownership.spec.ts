import { test, expect } from "./fixtures.ts";
import { build } from "esbuild";
import { basename } from "node:path";

test.beforeEach(async ({ page }) => {
    // Two evaluations of the browser entry share one core module, like separately loaded views.
    const built = await build({ entryPoints: { core: "src/index.ts", comparison: "src/browser/comparison.ts" }, outdir: "artifacts/comparison-ownership",
        bundle: true, splitting: true, format: "esm", platform: "browser", target: "es2022", write: false });
    const modules = new Map(built.outputFiles.map(file => [basename(file.path), file.text]));
    await page.route("**/comparison-ownership/**", route => {
        const body = modules.get(new URL(route.request().url()).pathname.split("/").at(-1)!);
        return body === undefined ? route.abort() : route.fulfill({ contentType: "text/javascript", body });
    });
    await page.goto("/comparison/");
});

test("independent comparison modules share workspace identity and release retained baselines after their owners", async ({ page }) => {
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

type Presentation = {
    capture: () => { status: string; revision: number; hunks: number; paints: readonly { revision: number; text: string; color: string }[]; staleRevert: boolean; currentRevert: boolean };
    release: () => void; dispose: () => void;
};
declare global { interface Window { comparisonPresentation: Presentation } }

test("review highlights survive every typing paint while exact comparison work is held", async ({ page }) => {
    await page.evaluate(async () => {
        const path = "/comparison-ownership/";
        const { Workspace, TextBuffer, TextDiff } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextComparison } = await import(path + "comparison.js") as typeof import("../../src/browser/comparison.ts");
        const workspace = new Workspace(), source = workspace.createTextResource({ scope: "test", resource: "paint", variant: "working" }, "Working", { value: "old\n" + "unchanged\n".repeat(4000) });
        const tab = workspace.open({ kind: "text", documentId: source.documentId }, "working"), host = document.createElement("section");
        host.id = "held-comparison"; document.body.append(host);
        const mounted = mountTextComparison(host, workspace, tab, { buffer: TextBuffer.from("new\n" + "unchanged\n".repeat(4000)), version: "one" });
        await new Promise<void>(resolve => { const stop = mounted.controller.subscribe(() => { if (mounted.controller.getSnapshot().status === "ready") { stop(); resolve(); } }); });
        const exact = mounted.controller.getSnapshot(); mounted.selectHunk(exact.generation, 0);
        mounted.working.view.setSelection(0, { anchor: 1, head: 1 }); mounted.working.focus();
        const next = TextDiff.prototype.next;
        TextDiff.prototype.next = function() { return Object.freeze({ status: "running", work: 0, readUnits: 0, lineComparisons: 0, lineEdits: 0, hunks: Object.freeze([]) }); };
        const paints: { revision: number; text: string; color: string }[] = [];
        mounted.working.viewport.element.addEventListener("sttropez-render", () => {
            const revision = workspace.document(source.documentId).revision; if (!revision) return;
            const marked = mounted.working.viewport.element.querySelector(".st-comparison-added");
            paints.push({ revision, text: marked?.textContent ?? "", color: marked ? getComputedStyle(marked).backgroundColor : "" });
        });
        window.comparisonPresentation = {
            capture: () => { const s = mounted.controller.getSnapshot(); return { status: s.status, revision: s.working!.revision, hunks: s.hunks.length, paints,
                staleRevert: mounted.controller.revert(exact.generation, 0), currentRevert: mounted.controller.revert(s.generation, 0) }; },
            release: () => { TextDiff.prototype.next = next; },
            dispose: () => { TextDiff.prototype.next = next; mounted.destroy(); workspace.close(tab); workspace.releaseResource(source.id, true); host.remove(); },
        };
    });
    try {
        await page.keyboard.type("Z");
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const held = await page.evaluate(() => window.comparisonPresentation.capture());
        expect(held).toMatchObject({ status: "running", revision: 1, hunks: 1, staleRevert: false, currentRevert: false });
        expect(held.paints.length).toBeGreaterThan(0);
        for (const paint of held.paints) { expect(paint.text).toBe("oZld"); expect(paint.color).toBe("rgb(36, 98, 70)"); }
        await expect(page.locator("#held-comparison").getByRole("button", { name: "Use baseline", exact: true })).toBeDisabled();
        await expect(page.locator("#held-comparison").getByRole("button", { name: "Next change", exact: true })).toBeDisabled();
        await page.evaluate(() => window.comparisonPresentation.release());
        await expect(page.locator("#held-comparison .st-comparison")).toHaveAttribute("data-status", "ready");
        await expect(page.locator("#held-comparison .st-comparison-added")).toHaveText("oZld");
    } finally { await page.evaluate(() => window.comparisonPresentation.dispose()); }
});
