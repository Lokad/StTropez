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
        let hiddenThroughout = true;
        const stopInventory = workspace.subscribe(() => {
            const state = workspace.getSnapshot();
            hiddenThroughout &&= state.resources.length === 1 && state.resources[0]!.id === source.id
                && state.documents.length === 1 && state.documents[0]!.id === source.documentId
                && state.tabs.length === 1 && state.tabs[0]!.id === tab && workspace.tabState.getSnapshot() === state.tabs;
        });
        const one = first.mountTextComparison(host, workspace, tab, baseline, { view, workBudget: 256 });
        const two = second.mountTextComparison(host, workspace, tab, baseline, { view, controls: false });
        const oldEditor = one.referenceEditor()!, old = workspace.resourceForDocument(oldEditor.view.documentId), oldLease = workspace.acquire(old.id);
        const distinct = old.id !== workspace.resourceForDocument(two.referenceEditor()!.view.documentId).id;
        const internal = old.metadata.getSnapshot().visibility === "internal"
            && workspace.resolveTab(one.reference.getSnapshot()!.target)?.visibility === "internal";
        const changed = new Promise<void>(resolve => {
            const stop = one.reference.subscribe(() => { if (one.reference.getSnapshot()?.version === "two") { stop(); resolve(); } });
        });
        one.controller.beginRefresh().complete({ buffer: TextBuffer.from("new baseline"), version: "two" });
        while (one.controller.getSnapshot().status === "running") one.controller.advance();
        const retiredRejected = !one.state.getSnapshot().canNavigate && !one.selectHunk(one.controller.getSnapshot().generation, 0);
        await changed;
        const afterRefresh = { old: old.getSnapshot().state, text: workspace.document(old.documentId).text, oldEditorDisposed: oldEditor.snapshot().disposed,
            retiredRejected, currentReady: one.state.getSnapshot().canNavigate };
        const current = workspace.resourceForDocument(one.referenceEditor()!.view.documentId), currentLease = workspace.acquire(current.id);
        one.destroy(); one.destroy(); two.destroy(); stopInventory();
        const afterDestroy = { children: host.childElementCount, controllers: [one.controller.getSnapshot().status, two.controller.getSnapshot().status],
            leases: workspace.diagnostics().leases, views: workspace.diagnostics().views, subscriptions: workspace.diagnostics().subscriptions,
            retained: [old.getSnapshot().state, current.getSnapshot().state] };
        oldLease.release(); currentLease.release(); await Promise.resolve();
        const afterRelease = { resources: workspace.diagnostics().resources, retained: [old.getSnapshot().state, current.getSnapshot().state] };
        view.dispose(); workspace.close(tab); workspace.releaseResource(source.id); host.remove();
        return { distinct, internal, hiddenThroughout, afterRefresh, afterDestroy, afterRelease, leases: workspace.diagnostics().leases };
    });
    expect(result).toEqual({ distinct: true, internal: true, hiddenThroughout: true, afterRefresh: { old: "ready", text: "baseline", oldEditorDisposed: true, retiredRejected: true, currentReady: true },
        afterDestroy: { children: 0, controllers: ["disposed", "disposed"], leases: 3, views: 1, subscriptions: 0, retained: ["ready", "ready"] },
        afterRelease: { resources: 1, retained: ["released", "released"] }, leases: 0 });
});

type Presentation = {
    capture: () => { status: string; revision: number; hunks: number; paints: readonly { revision: number; text: string; color: string }[]; staleRevert: boolean; currentRevert: boolean };
    release: () => void; dispose: () => void;
};

test("browser comparison work yields with large requested budgets and cancels its next turn", async ({ page }) => {
    const results = await page.evaluate(async () => {
        const path = "/comparison-ownership/";
        const { Workspace, TextBuffer, TextDiff } = await import(path + "core.js") as typeof import("../../src/index.ts");
        const { mountTextComparison } = await import(path + "comparison.js") as typeof import("../../src/browser/comparison.ts");
        const timeout = window.setTimeout, clear = window.clearTimeout, next = TextDiff.prototype.next;
        const clock = Object.getOwnPropertyDescriptor(performance, "now"), tasks = new Map<number, () => void>();
        let serial = 0, now = 0, calls = 0, work = 0;
        window.setTimeout = ((callback: TimerHandler) => {
            if (typeof callback !== "function") throw new Error("Expected a scheduled function.");
            const id = ++serial; tasks.set(id, () => callback()); return id;
        }) as typeof window.setTimeout;
        window.clearTimeout = id => { if (typeof id === "number") tasks.delete(id); };
        Object.defineProperty(performance, "now", { configurable: true, value: () => now });
        // A controlled cost per work unit exposes whether a large advance can prevent
        // the browser owner from checking its clock. No machine-speed timing assertion.
        TextDiff.prototype.next = function(budget = 32768) {
            now += budget / 1024; calls++; work += budget;
            return Object.freeze({ status: "running", work, readUnits: 0, lineComparisons: 0, lineEdits: 0, hunks: Object.freeze([]) });
        };
        const results: { requested: number | null; calls: number; elapsed: number; work: number; pending: number; cancelled: boolean }[] = [];
        try {
            for (const requested of [undefined, 256, Number.MAX_SAFE_INTEGER]) {
                const workspace = new Workspace(), source = workspace.createTextResource({ scope: "test", resource: "budget", variant: "working" }, "Working", { value: "working" });
                const tab = workspace.open({ kind: "text", documentId: source.documentId }, "working"), host = document.createElement("section"); document.body.append(host);
                const baseline = { buffer: TextBuffer.from("baseline"), version: "one" }, before = workspace.diagnostics();
                // Clamping must not make invalid public input acceptable or leak a mount.
                for (const invalid of [255, 256.5, Infinity, NaN]) {
                    let rejected = false; try { mountTextComparison(host, workspace, tab, baseline, { workBudget: invalid }); } catch (error) { rejected = error instanceof RangeError; }
                    if (!rejected || host.childElementCount || workspace.diagnostics().leases !== before.leases) throw new Error("Invalid mount budget was accepted or leaked ownership.");
                }
                const mounted = mountTextComparison(host, workspace, tab, baseline, requested === undefined ? {} : { workBudget: requested });
                try {
                    now = calls = work = 0;
                    const queued = tasks.entries().next().value; if (!queued) throw new Error("Missing comparison work.");
                    tasks.delete(queued[0]); queued[1]();
                    const pending = tasks.size, measured = mounted.snapshot(), prior = calls; mounted.destroy();
                    for (const run of tasks.values()) run();
                    results.push({ requested: requested ?? null, calls, elapsed: measured.maxStepMs, work, pending,
                        cancelled: tasks.size === 0 && calls === prior && workspace.diagnostics().leases === 0 && workspace.diagnostics().subscriptions === 0 });
                } finally { mounted.destroy(); workspace.close(tab); workspace.releaseResource(source.id, true); host.remove(); }
            }
        } finally {
            window.setTimeout = timeout; window.clearTimeout = clear; TextDiff.prototype.next = next;
            if (clock) Object.defineProperty(performance, "now", clock); else Reflect.deleteProperty(performance, "now");
        }
        return results;
    });
    expect(results).toEqual([
        { requested: null, calls: 1, elapsed: 4, work: 4096, pending: 1, cancelled: true },
        { requested: 256, calls: 16, elapsed: 4, work: 4096, pending: 1, cancelled: true },
        { requested: Number.MAX_SAFE_INTEGER, calls: 1, elapsed: 4, work: 4096, pending: 1, cancelled: true },
    ]);
});
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
        mounted.working.viewport.onRender(() => {
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
