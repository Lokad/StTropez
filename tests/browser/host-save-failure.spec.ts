import { ready, test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";

const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const text = (page: Page) => page.evaluate(() => { const f = window.hostFixture; return f.range(0, f.snapshot().source.length); });
const selections = (state: Awaited<ReturnType<typeof snapshot>>) => ({
    source: state.bindings.views.map(v => ({ id: v.id, selection: v.selection })), comparison: state.bindings.comparison?.selection,
});
async function waitForSavedViews(page: Page): Promise<void> {
    await ready(page);
    await page.waitForFunction(() => {
        const { activeViews, comparison } = window.hostFixture.snapshot().bindings;
        return activeViews === 2 && comparison !== null && [...document.querySelectorAll(".st-comparison h3")]
            .some(heading => heading.textContent === `Baseline · ${comparison.baseline?.version}`);
    });
}

test.describe(`plain save failure pilot`, () => {
    test.beforeEach(async ({ page }) => {
        await page.goto(`/hosts/plain/`);
        await expect(page.getByRole("textbox", { name: "Primary source", exact: true })).toBeVisible();
    });
    test(`typing, shared history and review survive a failed save, remounted retry`, async ({ page }) => {
        const button = (name: string) => page.getByRole("button", { name, exact: true });
        const primary = page.getByRole("textbox", { name: "Primary source", exact: true });
        const working = page.getByRole("textbox", { name: "Comparison working source", exact: true });
        const original = "proposal é 😀\r\nrow two";
        await page.evaluate(value => { window.hostFixture.previewProposal(value); window.hostFixture.applyProposal(); }, original); await waitForSavedViews(page);
        await working.press("Control+Home"); await working.press("Shift+ArrowRight"); await working.press("Shift+ArrowRight");
        await primary.press("Control+End"); await primary.pressSequentially(" corrected");
        const corrected = original + " corrected";
        expect(await page.evaluate(() => { const f = window.hostFixture; return f.selectSource("secondary", f.snapshot().source.revision, { anchor: 4, head: 1 }); })).toBe(true);
        await button("Save source").click(); await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
        await primary.press("Control+End"); await primary.pressSequentially(" later"); await waitForSavedViews(page);
        await primary.evaluate(node => { node.dataset.failureRetained = "yes"; });
        const later = corrected + " later", before = await snapshot(page);
        expect(await text(page)).toBe(later);
        await page.evaluate(() => window.hostFixture.failSave());
        await expect.poll(async () => (await snapshot(page)).source.saveStatus).toBe("failed");
        await expect.poll(async () => (await snapshot(page)).pendingCommands).toBe(0);
        const messages = page.getByRole("status", { name: "Host messages", exact: true });
        await expect(messages).toContainText("Source save failed.");
        await expect(primary).toBeFocused(); await expect(primary).toHaveAttribute("data-failure-retained", "yes");
        const failed = await snapshot(page);
        expect(await text(page)).toBe(later); expect(failed.source.revision).toBe(before.source.revision);
        expect(selections(failed)).toEqual(selections(before)); expect(failed.history).toEqual(before.history);
        expect(failed.server).toEqual(before.server);
        expect(failed.bindings.comparison!.baseline).toEqual(before.bindings.comparison!.baseline);
        expect(failed.comparisonReference).toEqual(before.comparisonReference);
        expect(failed.pendingSaves).toEqual([]);
        expect(failed.source).toMatchObject({ serverVersion: "v0", dirty: true });
        expect(failed.activity).toMatchObject({ writes: 0, errors: 1 });
        await button("Save source").click();
        await expect.poll(async () => (await snapshot(page)).pendingSaves).toEqual([
            { revision: failed.source.revision, length: later.length, expectedServerVersion: "v0" },
        ]);
        await expect(messages).not.toContainText("Source save failed.");
        await primary.press("Control+End"); await primary.pressSequentially(" newest"); await waitForSavedViews(page);
        const newest = later + " newest", retained = selections(await snapshot(page));
        await page.evaluate(() => window.hostFixture.unmount()); await page.evaluate(() => window.hostFixture.mount()); await waitForSavedViews(page);
        expect(selections(await snapshot(page))).toEqual(retained); await primary.focus();
        await page.evaluate(() => window.hostFixture.finishSave());
        await expect.poll(async () => (await snapshot(page)).source.serverVersion).toBe("v1");
        await expect(messages).not.toContainText("Source save failed.");
        await expect.poll(async () => (await snapshot(page)).pendingCommands).toBe(0);
        await expect(primary).toBeFocused(); expect(await text(page)).toBe(newest);
        const saved = await snapshot(page); expect(saved.source.dirty).toBe(true);
        expect(saved.activity).toMatchObject({ writes: 1, lastSavedRevision: failed.source.revision });
        await primary.press("Control+z"); await waitForSavedViews(page); expect(await text(page)).toBe(later); expect((await snapshot(page)).source.dirty).toBe(false);
        await primary.press("Control+Shift+z"); await waitForSavedViews(page); expect(await text(page)).toBe(newest); expect((await snapshot(page)).source.dirty).toBe(true);
        await button("Capture reference refresh").click(); await button("Finish reference refresh").click(); await waitForSavedViews(page);
        await expect(page.getByRole("heading", { name: "Baseline · reference:saved-v1", exact: true })).toBeVisible();
        expect(await page.evaluate(length => window.hostFixture.referenceRange(0, length), later.length)).toBe(later);
        expect((await snapshot(page)).bindings.comparison!.baseline!.length).toBe(later.length);
        const final = await snapshot(page); expect(final.activity.writes).toBe(1);
        expect(await text(page)).toBe(newest);
        expect(final.activity.background).toBeGreaterThan(before.activity.background);
        expect(final.bindings.comparison!.workingViewport.rows).toBeLessThan(100);
        expect(final.bindings.comparison!.workingViewport.readUnits).toBeLessThan(20000);
        expect(final.bindings.comparison!.referenceViewport!.rows).toBeLessThan(100);
        expect(final.bindings.comparison!.referenceViewport!.readUnits).toBeLessThan(20000);
        await page.evaluate(() => window.hostFixture.dispose());
    });
    test("queued captures retain corrections through failure, tab replacement and disposal of a late rejection", async ({ page }) => {
        const button = (name: string) => page.getByRole("button", { name, exact: true });
        const primary = page.getByRole("textbox", { name: "Primary source", exact: true });
        await button("Open source review").click(); await waitForSavedViews(page);
        await primary.press("Control+End"); await primary.pressSequentially(" first");
        await button("Save source").click(); await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
        await primary.press("Control+End"); await primary.pressSequentially(" second");
        const second = await snapshot(page); await button("Save source").click();
        await primary.press("Control+End"); await primary.pressSequentially(" retained"); await waitForSavedViews(page);
        const retained = await snapshot(page); await button("Fail save").click();
        await expect.poll(async () => (await snapshot(page)).pendingSaves).toEqual([
            { revision: second.source.revision, length: second.source.length, expectedServerVersion: "v0" },
        ]);
        expect(await text(page)).toBe("start first second retained"); expect((await snapshot(page)).history).toEqual(retained.history);
        await button("Move primary view").click(); await button("Replace primary panel").click();
        await page.evaluate(() => window.hostFixture.failSave()); await expect.poll(async () => (await snapshot(page)).pendingCommands).toBe(0);
        expect((await snapshot(page)).source).toMatchObject({ serverVersion: "v0", dirty: true, saveStatus: "failed" });
        await button("Reopen primary source").click(); await expect(primary).toBeVisible();
        expect(await text(page)).toBe("start first second retained");
        await button("Save source").click(); await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
        await button("Save source").click();
        await page.evaluate(() => { window.hostFixture.failSave(); return window.hostFixture.dispose(); });
        const stopped = await snapshot(page); expect(stopped.pendingCommands).toBe(0); expect(stopped.pendingSaves).toEqual([]);
        expect(stopped.activity.writes).toBe(0); expect(await text(page)).toBe("start first second retained");
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await page.evaluate(() => { window.hostFixture.failSave(); window.hostFixture.finishSave(); });
        expect(await snapshot(page)).toEqual(stopped);
    });
});
