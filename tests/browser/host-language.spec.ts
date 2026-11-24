import { ready, test, expect, expectPanelKeyReserved } from "./fixtures.ts";
import type { Page } from "@playwright/test";
const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const text = (page: Page) => page.evaluate(() => window.hostFixture.range(0, window.hostFixture.snapshot().source.length));
const primary = (page: Page) => page.getByRole("textbox", { name: "Primary source", exact: true });
const secondary = (page: Page) => page.getByRole("textbox", { name: "Secondary source", exact: true });

test.describe(`plain integrated find host`, () => {
    test.beforeEach(async ({ page }) => {

        await page.goto(`/hosts/plain/?editor=candidate`); await expect(primary(page)).toBeVisible(); await ready(page);
    });

    test("whole-word find replaces only indexed words through comparison, save and remount", async ({ page }) => {
        const original = "cat scatter cat_ cat2 cat\r\ncafé cafe\u0301 cat\u200d \u{10400}cat cat!";
        // Seed exact model CRLF; native textarea fill normalization differs across engines.
        await page.evaluate(text => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]); }, original);
        await ready(page); await primary(page).press("Control+f");
        const query = page.getByRole("textbox", { name: "Find source", exact: true }), replacement = page.getByRole("textbox", { name: "Replacement", exact: true });
        const wholeWord = page.getByRole("checkbox", { name: "Whole word", exact: true }), status = page.getByLabel("Find status", { exact: true });
        await query.fill("cat"); await expect(status).toContainText(`${original.split("cat").length - 1} matches · ready`);
        await wholeWord.check(); await expect(status).toContainText("3 matches · ready"); await replacement.fill("dog");
        await expectPanelKeyReserved(replacement, "Enter");
        await replacement.dispatchEvent("keydown", { key: "Enter", repeat: true });
        expect(await text(page)).toBe(original);
        await query.focus(); await expectPanelKeyReserved(query, "Escape");
        const selection = () => page.evaluate(() => window.hostFixture.snapshot().bindings.views.find(view => view.id === "primary")!.selection);
        const prior = await selection(); await query.dispatchEvent("keydown", { key: "Enter", repeat: true });
        expect(await selection()).toEqual(prior); await query.press("Enter"); await expect(query).toBeFocused();
        await expect.poll(selection).not.toEqual(prior);
        const next = await selection(); await query.press("Shift+Enter"); await expect.poll(selection).not.toEqual(next);
        const middle = original.indexOf("cat\r"), embedded = original.indexOf("scatter") + 1, before = await snapshot(page);
        await page.evaluate(from => { const f = window.hostFixture; f.selectSource("primary", f.snapshot().source.revision, { anchor: from, head: from + 3 }); }, embedded); await ready(page);
        await replacement.press("Enter");
        await expect.poll(selection).toMatchObject({ anchor: middle, head: middle + 3 });
        expect(await text(page)).toBe(original);
        await replacement.press("Enter"); await expect(status).toHaveText("Replaced 1 match.");
        const changed = original.slice(0, middle) + "dog" + original.slice(middle + 3);
        expect(await text(page)).toBe(changed); expect((await snapshot(page)).history.undoDepth).toBe(before.history.undoDepth + 1);
        await secondary(page).press("Control+z"); expect(await text(page)).toBe(original);
        await secondary(page).press("Control+Shift+z"); expect(await text(page)).toBe(changed);
        await page.getByRole("button", { name: "Open source review", exact: true }).click(); await ready(page);
        const working = page.getByRole("textbox", { name: "Comparison working source", exact: true });
        await working.press("Control+f"); await expect(wholeWord).toBeChecked(); await expect(status).toContainText("2 matches · ready");
        const reference = (await snapshot(page)).bindings.comparison!.baseline!.version;
        await replacement.fill("$&"); const planned = await snapshot(page);
        await page.getByRole("button", { name: "Replace all", exact: true }).click(); await ready(page);
        const last = changed.lastIndexOf("cat!"), tailChanged = changed.slice(0, last) + "$&" + changed.slice(last + 3), expected = "$&" + tailChanged.slice(3);
        await expect.poll(() => text(page)).toBe(expected);
        expect((await snapshot(page)).history.undoDepth).toBe(planned.history.undoDepth + 1);
        expect((await snapshot(page)).source.exports).toBe(0);
        await working.press("Control+z"); expect(await text(page)).toBe(changed);
        await working.press("Control+Shift+z"); expect(await text(page)).toBe(expected);
        await working.press("Control+s"); await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
        await working.press("Control+End"); await working.pressSequentially(" later");
        await page.getByRole("button", { name: "Finish save", exact: true }).click(); await expect.poll(async () => (await snapshot(page)).pendingCommands).toBe(0);
        expect(await text(page)).toBe(expected + " later"); await working.press("Control+z"); expect(await text(page)).toBe(expected);
        expect((await snapshot(page)).source.dirty).toBe(false);
        await page.evaluate(() => window.hostFixture.unmount()); await page.evaluate(() => window.hostFixture.mount()); await ready(page);
        await working.press("Control+f"); await expect(wholeWord).toBeChecked(); await expect(status).toContainText("0 matches · ready");
        expect((await snapshot(page)).bindings.comparison!.baseline!.version).toBe(reference);
        expect(await page.evaluate(() => window.hostFixture.referenceRange(0, 5))).toBe("start"); expect(await text(page)).toBe(expected);
        await page.evaluate(() => window.hostFixture.dispose()); const stopped = await snapshot(page);
        expect(stopped.diagnostics).toMatchObject({ views: 0, subscriptions: 0, leases: 0 }); expect(stopped.hostSubscriptions).toBe(0);
    });

});
