import { ready, test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const input = (page: Page, name = "Primary source") => page.getByRole("textbox", { name, exact: true });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const notes = (page: Page) => page.getByRole("list", { name: "Navigation results", exact: true }).getByRole("button");
async function waitForNavigation(page: Page): Promise<void> {
    await ready(page);
    await page.waitForFunction(() => { const s = window.hostFixture.snapshot(); return window.hostFixture.settled && (!s.bindings.navigation.pending); });
}
async function setup(page: Page, host: string, text: string): Promise<void> {
     await page.goto(`/hosts/${host}/?editor=candidate`);
    await page.evaluate(text => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]); }, text); await waitForNavigation(page);
}
async function select(page: Page, at: number): Promise<void> { await input(page).focus(); await page.evaluate(at => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: at, head: at }]); }, at); }
async function query(page: Page, text: string, kind = "Find definition"): Promise<void> {
    await select(page, text.indexOf("café") + 2); await button(page, kind).click(); await waitForNavigation(page);
    await expect(notes(page)).toHaveCount(kind === "Find definition" ? 1 : 2);
}
async function dispose(page: Page): Promise<void> {
    await page.evaluate(() => window.hostFixture.dispose()); const s = await snapshot(page);
    expect(s.diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); expect(s.hostSubscriptions).toBe(0); expect(s.bindings.navigation.transport).toBeNull();
    expect(s.bindings.navigation.worker.created).toBe(s.bindings.navigation.worker.terminated); await expect.poll(() => page.workers().length).toBe(0);
}
for (const host of ["plain", "react"]) {
    for (const large of [false, true]) test(`${host} ${large ? "100k" : "normal"} persistent worker uses versioned deltas through typing, shared undo/redo and canonical save`, async ({ page }) => {
        test.setTimeout(120000); const original = "const café = 1;\r\n" + (large ? "const unchanged = 123;\r\n".repeat(100000) : "") + "café;";
        await setup(page, host, original); await button(page, "Open source review").click(); await waitForNavigation(page); const baseline = (await snapshot(page)).bindings.comparison!.baseline;
        await query(page, original); let s = await snapshot(page); const epoch = s.bindings.navigation.transport!.epoch;
        expect(s.bindings.navigation.worker).toMatchObject({ created: 1, opened: 1, changed: 0, snapshotUnits: original.length, deltaUnits: 0, terminated: 0 });
        await query(page, original, "Find references"); s = await snapshot(page); expect(s.bindings.navigation.worker.transferred).toBe(original.length); expect(s.bindings.navigation.worker.reused).toBe(1);
        await select(page, 0); await input(page).pressSequentially(" "); await waitForNavigation(page); s = await snapshot(page);
        expect(s.bindings.navigation.worker.transferred).toBe(original.length); expect(s.bindings.navigation.worker.changed).toBe(0);
        const edited = " " + original; await query(page, edited); s = await snapshot(page); expect(s.bindings.navigation.worker).toMatchObject({ created: 1, opened: 1, changed: 1, deltaUnits: 1, transferred: original.length + 1 });
        expect(s.bindings.navigation.transport!.epoch).toBe(epoch); await notes(page).first().click(); await waitForNavigation(page); expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selection).toMatchObject({ anchor: 7, head: 12 });
        await input(page, "Secondary source").press("Control+z"); await waitForNavigation(page); await query(page, original); expect((await snapshot(page)).bindings.navigation.worker.deltaUnits).toBe(1);
        await input(page, "Secondary source").press("Control+Shift+z"); await waitForNavigation(page); await query(page, edited); expect((await snapshot(page)).bindings.navigation.worker.deltaUnits).toBe(2);
        // A revision can advance while returning to the exact acknowledged immutable buffer.
        await input(page, "Secondary source").press("Control+z"); await input(page, "Secondary source").press("Control+Shift+z"); await waitForNavigation(page); await query(page, edited);
        s = await snapshot(page); expect(s.bindings.navigation.worker.deltaUnits).toBe(2); expect(s.bindings.navigation.worker.changed).toBe(4); expect(s.source.exports).toBe(0);
        await input(page).press("Control+End"); await input(page).pressSequentially("  "); await waitForNavigation(page); await input(page).press("Control+s"); await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
        await page.evaluate(() => window.hostFixture.finishSave()); await waitForNavigation(page); await query(page, edited); s = await snapshot(page);
        expect(s.source.dirty).toBe(false); expect(s.bindings.navigation.worker).toMatchObject({ created: 1, opened: 1, changed: 5, deltaUnits: 2 }); expect(s.bindings.comparison!.baseline).toEqual(baseline);
        const primary = s.bindings.views.find(v => v.id === "primary")!; expect(s.bindings.navigation.transport!.documents).toEqual([{ document: primary.documentId, revision: s.source.revision, length: edited.length }]);
        await button(page, "Run captured inputs").click(); await expect.poll(async () => (await snapshot(page)).pendingRuns.length).toBe(1); expect(await page.evaluate(text => window.hostFixture.runCapture(0)!.source === text, edited)).toBe(true); await page.evaluate(() => window.hostFixture.finishRun());
        expect((await snapshot(page)).bindings.views.every(v => v.metrics!.viewport.rows < 100)).toBe(true); await dispose(page);
    });
    test(`${host} actual worker rejects protocol faults and reconnects with fresh snapshots without changing text or selections`, async ({ page }) => {
        let text = "const café = 1;\r\ncafé;"; await setup(page, host, text); await query(page, text);
        for (const fault of ["version", "epoch", "sequence", "revision"] as const) {
            text = " " + text; await page.evaluate(() => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: 0, insert: " " }]); }); await waitForNavigation(page); await select(page, text.indexOf("café") + 2);
            const before = await snapshot(page); await page.evaluate(fault => window.hostFixture.faultNavigationSyncNext(fault), fault); await button(page, "Find definition").click(); await waitForNavigation(page);
            let s = await snapshot(page); expect(s.bindings.navigation.worker.rejected).toBe(before.bindings.navigation.worker.rejected + 1); expect(s.bindings.navigation.applied).toBe(before.bindings.navigation.applied);
            expect(s.bindings.navigation.transport).toBeNull(); expect(s.bindings.views.find(v => v.id === "primary")!.selectionSet).toEqual(before.bindings.views.find(v => v.id === "primary")!.selectionSet); await expect(notes(page)).toHaveCount(0);
            await expect(button(page, "Reconnect navigation provider")).toBeEnabled(); await button(page, "Reconnect navigation provider").click();
            await query(page, text); s = await snapshot(page); expect(s.bindings.navigation.worker.created).toBe(before.bindings.navigation.worker.created + 1); expect(s.bindings.navigation.worker.snapshotUnits).toBe(before.bindings.navigation.worker.snapshotUnits + text.length);
        }
        const before = await snapshot(page); await button(page, "Disconnect navigation provider").click(); await expect(button(page, "Find definition")).toBeDisabled();
        await input(page).press("Control+End"); await input(page).pressSequentially("!"); await waitForNavigation(page); await input(page).press("F12"); expect((await snapshot(page)).bindings.navigation.worker.created).toBe(before.bindings.navigation.worker.created);
        text += "!"; await button(page, "Reconnect navigation provider").click(); await expect(button(page, "Find definition")).toBeEnabled(); await query(page, text);
        expect((await snapshot(page)).bindings.navigation.worker.created).toBe(before.bindings.navigation.worker.created + 1); expect((await snapshot(page)).source.exports).toBe(0); await dispose(page);
    });
    test(`${host} worker document close and remount preserve resource ownership and immutable comparison references`, async ({ page }) => {
        const text = "catalogue\r\nend"; await setup(page, host, text); await button(page, "Open source review").click(); await button(page, "Add navigation companion").click(); await waitForNavigation(page);
        const baseline = (await snapshot(page)).bindings.comparison!.baseline;
        await select(page, 3); await button(page, "Find references").click(); await waitForNavigation(page); await expect(notes(page)).toHaveCount(3);
        let s = await snapshot(page); expect(s.bindings.navigation.transport!.documents).toHaveLength(2); const initial = s.bindings.navigation.worker.transferred;
        expect(await page.evaluate(() => window.hostFixture.releaseNavigationCompanion())).toBe(true); await select(page, 3); await button(page, "Find references").click(); await waitForNavigation(page); await expect(notes(page)).toHaveCount(1);
        s = await snapshot(page); expect(s.bindings.navigation.worker).toMatchObject({ closed: 1, opened: 2, created: 1, transferred: initial }); expect(s.bindings.navigation.transport!.documents).toHaveLength(1);
        await button(page, "Add navigation companion").click(); await select(page, 3); await button(page, "Find definition").click(); await waitForNavigation(page); expect((await snapshot(page)).bindings.navigation.worker.opened).toBe(3);
        await page.evaluate(() => window.hostFixture.setNavigationDelay(1000)); await button(page, "Find references").click(); expect((await snapshot(page)).bindings.navigation.pending).toBe(true);
        await page.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); }); await waitForNavigation(page); expect((await snapshot(page)).bindings.navigation.transport).toBeNull();
        await page.evaluate(() => window.hostFixture.setNavigationDelay(0)); await select(page, 3); await button(page, "Find definition").click(); await waitForNavigation(page); s = await snapshot(page); expect(s.bindings.navigation.worker.created).toBe(2); expect(s.bindings.navigation.transport!.documents).toHaveLength(2);
        await notes(page).first().click(); await waitForNavigation(page); await input(page, "Secondary source").pressSequentially("X"); await waitForNavigation(page);
        expect(await page.evaluate(() => window.hostFixture.releaseNavigationCompanion())).toBe(false); expect((await snapshot(page)).bindings.comparison!.baseline).toEqual(baseline); expect((await snapshot(page)).source.exports).toBe(0); await dispose(page);
    });
}
