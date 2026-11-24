import { test, expect } from "./fixtures.ts";

for (const editor of ["native", "candidate"] as const) {
    test.describe(`plain ${editor} save-conflict pilot`, () => {
        test.beforeEach(async ({ page }) => {


            await page.goto(`/hosts/plain/?editor=${editor}`);
            await expect(page.getByRole("textbox", { name: "Primary source", exact: true })).toBeVisible();
        });
        test("proposal conflict review, correction and guarded save preserve later keyboard edits", async ({ page }) => {
            const primary = page.getByRole("textbox", { name: "Primary source", exact: true }), secondary = page.getByRole("textbox", { name: "Secondary source", exact: true });
            const button = (name: string) => page.getByRole("button", { name, exact: true });
            await button("Preview proposal").click(); await button("Apply proposal").click();
            await primary.press("End"); await primary.pressSequentially(" corrected"); await button("Save source").click();
            await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().pendingSaves.length)).toBe(1);
            await page.evaluate(() => window.hostFixture.externalWrite("remote source\r\n"));
            await primary.press("End"); await primary.pressSequentially(" later"); await page.evaluate(() => window.hostFixture.finishSave());
            const panel = page.getByRole("region", { name: "Save conflict", exact: true });
            await expect(panel).toContainText("Expected server v0; observed v1");
            await button("Save reviewed source").evaluate(node => { node.dataset.retained = "reviewed-save"; });
            const failed = await page.evaluate(() => window.hostFixture.snapshot());
            expect(failed.source).toMatchObject({ serverVersion: "v0", dirty: true, saveStatus: "conflict" });
            expect(failed.activity.writes).toBe(0);
            await button("Review remote source").click(); await primary.press("End"); await primary.pressSequentially(" reading");
            await primary.evaluate(node => { node.dataset.retained = "yes"; });
            await page.evaluate(() => window.hostFixture.finishConflictReview());
            await expect(primary).toBeFocused(); await expect(primary).toHaveAttribute("data-retained", "yes");
            await expect(primary).toHaveValue("agent proposal corrected later reading");
            expect(await page.evaluate(() => window.hostFixture.referenceRange(0, 15))).toBe("remote source\r\n");
            await expect(button("Save reviewed source")).toHaveAttribute("data-retained", "reviewed-save");
            await primary.press("Control+a"); await primary.pressSequentially("merged"); await button("Save reviewed source").click();
            await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().pendingSaves[0]?.expectedServerVersion)).toBe("v1");
            await expect(button("Save reviewed source")).toBeDisabled();
            await primary.press("End"); await primary.pressSequentially(" during save"); await page.evaluate(() => window.hostFixture.finishSave());
            await expect(panel).toBeHidden();
            await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().source.serverVersion)).toBe("v2");
            await expect(primary).toHaveValue("merged during save"); await expect(secondary).toHaveValue("merged during save"); await expect(primary).toBeFocused();
            if (editor === "candidate") {
                await primary.press("Control+z"); await expect(primary).toHaveValue("merged during");
                expect((await page.evaluate(() => window.hostFixture.snapshot())).source.dirty).toBe(true);
            }
            await primary.press("Control+z"); await expect(primary).toHaveValue("merged");
            expect((await page.evaluate(() => window.hostFixture.snapshot())).source.dirty).toBe(false);
            if (editor === "candidate") { await primary.press("Control+Shift+z"); await expect(primary).toHaveValue("merged during"); }
            await primary.press("Control+Shift+z"); await expect(primary).toHaveValue("merged during save");
            expect(await page.evaluate(() => window.hostFixture.referenceRange(0, 15))).toBe("remote source\r\n");
            await page.evaluate(() => window.hostFixture.dispose());
            expect((await page.evaluate(() => window.hostFixture.snapshot())).diagnostics).toMatchObject({ views: 0, subscriptions: 0, leases: 0 });
        });

        test("remote changes and replaced tabs expire review without overwriting local or remote work", async ({ page }) => {
            const primary = page.getByRole("textbox", { name: "Primary source", exact: true }), button = (name: string) => page.getByRole("button", { name, exact: true });
            await primary.press("End"); await primary.pressSequentially(" local  "); await button("Save source").click();
            await page.evaluate(() => { window.hostFixture.externalWrite("remote one"); window.hostFixture.finishSave(); });
            await expect(page.getByRole("region", { name: "Save conflict", exact: true })).toBeVisible();
            await button("Review remote source").click(); await page.evaluate(() => { window.hostFixture.externalWrite("remote two"); window.hostFixture.finishConflictReview(); });
            expect(await page.evaluate(() => window.hostFixture.referenceRange(0, 10))).toBe("remote one");
            await button("Save reviewed source").click(); await page.evaluate(() => window.hostFixture.finishSave());
            await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().saveConflict?.observedVersion)).toBe("v2");
            await expect(primary).toHaveValue("start local  "); expect((await page.evaluate(() => window.hostFixture.snapshot())).source.serverVersion).toBe("v0");
            await button("Review remote source").click(); await button("Replace primary panel").click();
            expect(await page.evaluate(() => window.hostFixture.finishConflictReview())).toBe(false);
            await button("Reopen primary source").click(); await page.evaluate(() => window.hostFixture.saveReviewedSource());
            expect((await page.evaluate(() => window.hostFixture.snapshot())).pendingSaves).toEqual([]);
            await button("Review remote source").click(); await button("Finish remote review").click();
            await button("Save reviewed source").click(); await primary.press("End"); await primary.pressSequentially(" later");
            await page.evaluate(() => window.hostFixture.finishSave());
            await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().source.serverVersion)).toBe("v3");
            await expect(primary).toHaveValue("start local   later");
            await primary.press("Control+z"); await expect(primary).toHaveValue("start local  ");
            expect((await page.evaluate(() => window.hostFixture.snapshot())).source.dirty).toBe(true);
            await primary.press("Control+a"); await primary.pressSequentially("start local");
            expect((await page.evaluate(() => window.hostFixture.snapshot())).source.dirty).toBe(false);
            await button("Capture review acceptance").click(); await button("Finish review acceptance").click();
            await page.evaluate(() => window.hostFixture.dispose()); expect((await page.evaluate(() => window.hostFixture.snapshot())).diagnostics.leases).toBe(0);
        });

        test("remote and selected-version reads honor the latest review request and dismissal", async ({ page }) => {
            const primary = page.getByRole("textbox", { name: "Primary source", exact: true });
            const button = (name: string) => page.getByRole("button", { name, exact: true });
            await primary.press("End"); await primary.pressSequentially(" local"); await button("Save source").click();
            await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().pendingSaves.length)).toBe(1);
            await page.evaluate(() => { window.hostFixture.externalWrite("remote one"); window.hostFixture.finishSave(); });
            await expect(page.getByRole("region", { name: "Save conflict", exact: true })).toBeVisible();
            await button("Open source review").click(); await button("Keep draft version").click();
            const version = page.getByRole("combobox", { name: "Review version", exact: true });
            await button("Review remote source").click(); await version.selectOption("draft");
            const before = await page.evaluate(() => window.hostFixture.snapshot());
            await button("Finish remote review").click();
            expect((await page.evaluate(() => window.hostFixture.snapshot())).comparisonReference).toEqual(before.comparisonReference);
            await expect(button("Save reviewed source")).toBeDisabled();
            await primary.press("End"); await primary.pressSequentially(" correction"); await button("Finish version load").click();
            await expect(page.getByRole("group", { name: "Source review", exact: true })).toHaveAttribute("data-status", "ready");
            expect(await page.evaluate(() => window.hostFixture.referenceRange(0, 11))).toBe("start local");
            await expect(primary).toHaveValue("start local correction");

            await version.selectOption("saved"); await button("Review remote source").click();
            const later = await page.evaluate(() => window.hostFixture.snapshot());
            await button("Finish version load").click();
            expect((await page.evaluate(() => window.hostFixture.snapshot())).comparisonReference).toEqual(later.comparisonReference);
            await button("Finish remote review").click();
            await expect(page.getByRole("group", { name: "Source review", exact: true })).toHaveAttribute("data-status", "ready");
            expect(await page.evaluate(() => window.hostFixture.referenceRange(0, 10))).toBe("remote one");
            await expect(button("Save reviewed source")).toBeEnabled();
            const after = await page.evaluate(() => window.hostFixture.snapshot());
            expect(after.history).toEqual(later.history); expect(after.source).toEqual(later.source);
            await expect(primary).toHaveValue("start local correction");
            await version.selectOption("draft"); await expect(button("Save reviewed source")).toBeDisabled();
            await button("Cancel version load").click(); await expect(button("Save reviewed source")).toBeDisabled();
            await button("Review remote source").click(); await button("Finish remote review").click();
            await expect(button("Save reviewed source")).toBeEnabled();

            await button("Review remote source").click(); await button("Close source review").click();
            await primary.press("End"); await primary.pressSequentially(" after dismissal");
            const dismissed = await page.evaluate(() => window.hostFixture.snapshot());
            expect(await page.evaluate(() => window.hostFixture.finishConflictReview())).toBe(false);
            await expect(page.getByRole("group", { name: "Source review", exact: true })).toBeHidden();
            await expect(primary).toBeFocused(); await expect(primary).toHaveValue("start local correction after dismissal");
            const settled = await page.evaluate(() => window.hostFixture.snapshot());
            expect(settled.comparisonReference).toEqual(dismissed.comparisonReference); expect(settled.history).toEqual(dismissed.history);

            await button("Open source review").click(); await version.selectOption("draft");
            await button("Close source review").click(); await button("Open source review").click();
            await button("Finish version load").click();
            expect((await page.evaluate(() => window.hostFixture.snapshot())).comparisonReference).toEqual(dismissed.comparisonReference);
            await expect(button("Save reviewed source")).toBeDisabled();
            await button("Review remote source").click(); await button("Finish remote review").click();
            await button("Close source review").click(); await expect(button("Save reviewed source")).toBeEnabled();
            await page.evaluate(() => window.hostFixture.dispose());
            expect((await page.evaluate(() => window.hostFixture.snapshot())).diagnostics).toMatchObject({ views: 0, subscriptions: 0, leases: 0 });
        });

        if (editor === "candidate") test("conflict review retains bounded views and shared history during host traffic", async ({ page }) => {
            const original = "const sample = '😀 é';\r\n".repeat(300).trimEnd(), button = (name: string) => page.getByRole("button", { name, exact: true });
            await page.evaluate(text => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]); }, original);
            const primary = page.getByRole("textbox", { name: "Primary source", exact: true }); await button("Save source").click();
            await page.evaluate(text => { window.hostFixture.externalWrite(`remote ${text}`); window.hostFixture.finishSave(); }, original);
            await expect(page.getByRole("region", { name: "Save conflict", exact: true })).toBeVisible();
            await button("Review remote source").click(); await primary.press("Control+End"); await primary.pressSequentially(" local");
            await page.evaluate(() => { window.hostFixture.setPath("during-review.csv"); window.hostFixture.finishConflictReview(); });
            await expect(primary).toBeFocused(); await expect(page.getByRole("group", { name: "Source review", exact: true })).toHaveAttribute("data-status", "ready");
            await button("Save reviewed source").click(); await primary.press("Control+Home"); await primary.pressSequentially("fixed ");
            await page.evaluate(() => window.hostFixture.finishSave()); await expect.poll(() => page.evaluate(() => window.hostFixture.snapshot().source.serverVersion)).toBe("v2");
            await primary.press("Control+z"); expect(await page.evaluate(() => window.hostFixture.range(0, 5))).toBe("fixed");
            expect((await page.evaluate(() => window.hostFixture.snapshot())).source.dirty).toBe(true);
            await primary.press("Control+z"); expect((await page.evaluate(() => window.hostFixture.snapshot())).source.dirty).toBe(false);
            await primary.press("Control+Shift+z"); await primary.press("Control+Shift+z");
            await expect(page.getByRole("group", { name: "Source review", exact: true })).toHaveAttribute("data-status", "ready");
            const state = await page.evaluate(() => window.hostFixture.snapshot());
            expect(state.source.exports).toBe(0); expect(state.bindings.views.every(view => view.metrics!.inputUnits < 2600 && view.metrics!.viewport.rows < 100)).toBe(true);
            expect(state.bindings.comparison!.input.inputUnits).toBeLessThan(2600); expect(state.bindings.comparison!.workingViewport.rows).toBeLessThan(100);
            expect(await page.evaluate(() => window.hostFixture.range(0, 6))).toBe("fixed ");
            expect(await page.evaluate(() => window.hostFixture.referenceRange(0, 7))).toBe("remote ");
            await page.evaluate(() => window.hostFixture.dispose()); expect((await page.evaluate(() => window.hostFixture.snapshot())).diagnostics).toMatchObject({ views: 0, subscriptions: 0, leases: 0 });
        });
    });
}
