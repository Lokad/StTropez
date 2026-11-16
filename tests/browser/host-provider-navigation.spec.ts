import { ready, test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const input = (page: Page, name = "Primary source") => page.getByRole("textbox", { name, exact: true });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const status = (page: Page) => page.getByLabel("Symbol navigation status", { exact: true });
const results = (page: Page) => page.getByRole("list", { name: "Navigation results", exact: true }).getByRole("button");
async function waitForNavigation(page: Page): Promise<void> {
    await ready(page);
    await page.waitForFunction(() => { const s = window.hostFixture.snapshot(); return window.hostFixture.settled && (!s.bindings.navigation.pending); });
}
async function setup(page: Page, host: string, text: string): Promise<void> {
     await page.goto(`/hosts/${host}/?editor=candidate`);
    await page.evaluate(text => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]); }, text); await waitForNavigation(page); await input(page).focus();
}
async function select(page: Page, from: number, view: "primary" | "secondary" | "comparison" = "primary"): Promise<void> {
    await page.evaluate(({ from, view }) => { const f = window.hostFixture; f.selectSourceSet(view, f.snapshot().source.revision, [{ anchor: from, head: from }]); }, { from, view });
}
async function dispose(page: Page): Promise<void> {
    await page.evaluate(() => window.hostFixture.dispose()); const s = await snapshot(page);
    expect(s.diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); expect(s.hostSubscriptions).toBe(0); expect(s.bindings.navigation).toMatchObject({ sessions: [], subscriptions: 0, pending: false, results: 0 });
    expect(s.bindings.navigation.worker.created).toBe(s.bindings.navigation.worker.terminated); await expect.poll(() => page.workers().length).toBe(0);
}
for (const host of ["plain", "react"]) {
    for (const large of [false, true]) test(`${host} ${large ? "100k" : "normal"} real-worker definition reveal and references preserve exact origin selections and independent folds`, async ({ page }) => {
        test.setTimeout(120000); const text = "header\r\nconst café = 1;\r\n" + (large ? "const unchanged = 123;\r\n".repeat(100000) : "filler\r\n") + "café\r\ntail", from = text.lastIndexOf("café");
        await setup(page, host, text); await button(page, "Open source review").click(); await input(page).focus();
        await page.evaluate(to => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 0, head: to }]); }, from); await button(page, "Fold selected lines").click(); await waitForNavigation(page);
        await page.evaluate(from => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 0, head: 0 }, { anchor: from + 2, head: from + 2 }], 1); }, from); await waitForNavigation(page);
        const before = await snapshot(page), origin = before.bindings.views.find(v => v.id === "primary")!.selectionSet; await input(page).press("F12"); await waitForNavigation(page);
        let s = await snapshot(page); expect(s.bindings.views.find(v => v.id === "primary")!.selection).toMatchObject({ anchor: 14, head: 19 }); expect(s.bindings.views.find(v => v.id === "primary")!.metrics!.viewport.collapsedFolds).toBe(0);
        expect(s.bindings.navigation.worker).toMatchObject({ created: 1, completed: 1, transferred: text.length, terminated: 0, opened: 1 }); expect(s.bindings.navigation.worker.maxChunk).toBeLessThanOrEqual(16384);
        expect(s.source.revision).toBe(before.source.revision); expect(s.history).toEqual(before.history); expect(s.bindings.comparison!.baseline).toEqual(before.bindings.comparison!.baseline);
        await button(page, "Return to navigation origin").click(); await waitForNavigation(page); expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selectionSet).toEqual(origin);
        await input(page).press("Shift+F12"); await waitForNavigation(page); await expect(results(page)).toHaveCount(2);
        await page.getByRole("checkbox", { name: "Include declarations in references", exact: true }).uncheck(); await button(page, "Find references").click(); await waitForNavigation(page); await expect(results(page)).toHaveCount(1);
        await results(page).first().click(); await waitForNavigation(page); s = await snapshot(page); expect(s.bindings.views.find(v => v.id === "primary")!.selection).toMatchObject({ anchor: from, head: from + 5 }); expect(s.source.exports).toBe(0);
        await dispose(page);
    });
    test(`${host} cross-resource navigation opens an unmounted captured target, returns to comparison and keeps working Save/Run identity`, async ({ page }) => {
        const text = "catalogue\r\nend"; await setup(page, host, text); await button(page, "Add navigation companion").click(); await button(page, "Open source review").click(); await waitForNavigation(page);
        await input(page, "Secondary source").focus(); await select(page, 3, "secondary"); const secondaryOrigin = (await snapshot(page)).bindings.views.find(v => v.id === "secondary")!;
        await button(page, "Find definition").click(); await waitForNavigation(page); await results(page).first().click(); await waitForNavigation(page);
        expect((await snapshot(page)).bindings.views.find(v => v.id === "secondary")!.documentId).not.toBe(secondaryOrigin.documentId);
        await button(page, "Return to navigation origin").click(); await waitForNavigation(page); expect((await snapshot(page)).bindings.views.find(v => v.id === "secondary")).toMatchObject({ documentId: secondaryOrigin.documentId, selectionSet: secondaryOrigin.selectionSet });
        const working = input(page, "Comparison working source"); await working.focus(); await select(page, 3, "comparison"); const before = await snapshot(page), baseline = before.bindings.comparison!.baseline;
        await page.evaluate(() => window.hostFixture.setNavigationDelay(200)); await button(page, "Find definition").click(); await page.getByRole("textbox", { name: "Configuration path", exact: true }).focus(); await waitForNavigation(page);
        await expect(page.getByRole("textbox", { name: "Configuration path", exact: true })).toBeFocused(); await expect(results(page)).toHaveText(["Navigation companion:1:7 · declaration"]);
        const companion = (await snapshot(page)).bindings.navigation.companion!; expect((await snapshot(page)).bindings.views.every(v => v.documentId !== companion)).toBe(true);
        await results(page).first().click(); await waitForNavigation(page); let s = await snapshot(page); const secondary = s.bindings.views.find(v => v.id === "secondary")!;
        expect(secondary.documentId).toBe(companion); expect(secondary.selection).toMatchObject({ anchor: 6, head: 15 }); await expect(input(page, "Secondary source")).toBeFocused();
        expect(s.source.revision).toBe(before.source.revision); expect(s.history).toEqual(before.history); expect(s.bindings.comparison!.baseline).toEqual(baseline);
        await button(page, "Return to navigation origin").click(); await waitForNavigation(page); await expect(working).toBeFocused(); expect((await snapshot(page)).bindings.comparison!.selectionSet).toEqual(before.bindings.comparison!.selectionSet);
        await working.press("Control+End"); await working.pressSequentially(" human"); await waitForNavigation(page); await input(page, "Secondary source").focus(); await button(page, "Save source").click(); await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1); await page.evaluate(() => window.hostFixture.finishSave()); await waitForNavigation(page);
        await button(page, "Run captured inputs").click(); await expect.poll(async () => (await snapshot(page)).pendingRuns.length).toBe(1); expect(await page.evaluate(text => window.hostFixture.runCapture(0)!.source === text, text + " human")).toBe(true); await page.evaluate(() => window.hostFixture.finishRun());
        await page.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); }); await waitForNavigation(page); expect((await snapshot(page)).bindings.views.find(v => v.id === "secondary")!.documentId).toBe(companion);
        expect((await snapshot(page)).bindings.comparison!.baseline).toEqual(baseline); expect((await page.evaluate(id => window.hostFixture.navigationDocument(id), companion)).exports).toBe(0); await dispose(page);
    });
    test(`${host} navigation invalidation, worker faults and retry cannot publish or focus stale captures`, async ({ page }) => {
        const text = "const café = 1;\r\ncafé;"; await setup(page, host, text); await select(page, text.length - 3); await page.evaluate(() => window.hostFixture.setNavigationDelay(1000));
        for (const reason of ["selection", "permission", "lease", "composition", "fold", "revision", "remount", "replacement"] as const) {
            await input(page).focus(); await select(page, text.length - 3);
            if (reason === "fold") await page.evaluate(head => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 0, head }]); }, text.length - 3);
            const before = await snapshot(page); await button(page, "Find definition").click(); expect((await snapshot(page)).bindings.navigation.pending).toBe(true);
            if (reason === "selection") await select(page, 0);
            if (reason === "permission") await page.evaluate(() => { window.hostFixture.setSourceReadOnly(true); window.hostFixture.setSourceReadOnly(false); });
            if (reason === "lease") await page.evaluate(() => window.hostFixture.cycleSourceEditLease());
            if (reason === "composition") { await input(page, "Secondary source").evaluate(node => node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))); await input(page, "Secondary source").evaluate(node => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }))); }
            if (reason === "fold") await button(page, "Fold selected lines").click();
            if (reason === "revision") await page.evaluate(() => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: f.snapshot().source.length, to: f.snapshot().source.length, insert: " " }]); });
            if (reason === "remount") await page.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); });
            if (reason === "replacement") await page.evaluate(() => window.hostFixture.openTransferTarget("unrelated resource"));
            await waitForNavigation(page); expect((await snapshot(page)).bindings.navigation.applied).toBe(before.bindings.navigation.applied); await expect(results(page)).toHaveCount(0);
        }
        await page.evaluate(() => window.hostFixture.setNavigationDelay(0)); await input(page).focus(); await select(page, text.length - 3);
        for (const fault of ["malformed", "failure"] as const) {
            await page.evaluate(fault => window.hostFixture.faultNavigationNext(fault), fault); await button(page, "Find definition").click(); await waitForNavigation(page); await expect(results(page)).toHaveCount(0); await expect(status(page)).toContainText(/Invalid|failed/);
        }
        await button(page, "Find definition").click(); await waitForNavigation(page); await expect(results(page)).toHaveCount(1);
        expect(await results(page).first().evaluate(node => { const f = window.hostFixture; f.unmount(); f.mount(); const before = f.snapshot().bindings.views.find(v => v.id === "primary")!.selectionSet; (node as HTMLButtonElement).click(); return JSON.stringify(before) === JSON.stringify(f.snapshot().bindings.views.find(v => v.id === "primary")!.selectionSet); })).toBe(true);
        await input(page).focus(); await select(page, text.length - 3); await page.evaluate(() => window.hostFixture.setSourceReadOnly(true)); await button(page, "Find definition").click(); await waitForNavigation(page); await results(page).first().click(); await expect(input(page)).toBeFocused();
        await page.evaluate(() => { const f = window.hostFixture; f.setSourceReadOnly(false); f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: "a" + " ".repeat(1000000) + "café" }]); f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 0, head: 0 }]); }); await waitForNavigation(page);
        const guard = await input(page).evaluate(node => { const f = window.hostFixture, before = f.snapshot().bindings.navigation.requested; node.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", ctrlKey: true, bubbles: true, cancelable: true }));
            const pending = f.snapshot().bindings.views.find(v => v.id === "primary")!.metrics!.pendingCommand; node.dispatchEvent(new KeyboardEvent("keydown", { key: "F12", bubbles: true, cancelable: true })); return { pending, requested: f.snapshot().bindings.navigation.requested - before }; });
        expect(guard).toEqual({ pending: true, requested: 0 }); await waitForNavigation(page); await expect(status(page)).toContainText("Finish pending");
        await dispose(page);
    });
    test(`${host} bounded reference pages expose truncation and all pages without changing text or history`, async ({ page }) => {
        const text = "const café = 1;\r\n" + "café;\r\n".repeat(1100); await setup(page, host, text); await select(page, 8); const before = await snapshot(page);
        await button(page, "Find references").click(); await waitForNavigation(page); await expect(status(page)).toContainText("1024+"); await expect(results(page)).toHaveCount(64);
        for (let pageIndex = 0; pageIndex < 15; pageIndex++) await button(page, "Next navigation results").click(); await expect(button(page, "Next navigation results")).toBeDisabled(); await expect(results(page)).toHaveCount(64);
        await results(page).last().click(); await waitForNavigation(page); expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selection).toMatchObject({ anchor: text.indexOf("\r\n") + 2 + 1022 * 8, head: text.indexOf("\r\n") + 2 + 1022 * 8 + 5 });
        expect((await snapshot(page)).source.revision).toBe(before.source.revision); expect((await snapshot(page)).history).toEqual(before.history); expect((await snapshot(page)).source.exports).toBe(0); await dispose(page);
    });
}
