import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const text = (page: Page) => page.evaluate(() => window.hostFixture.range(0, window.hostFixture.snapshot().source.length));
const primary = (page: Page) => page.getByRole("textbox", { name: "Primary source", exact: true });
const secondary = (page: Page) => page.getByRole("textbox", { name: "Secondary source", exact: true });
async function ready(page: Page) {
    await expect.poll(async () => { const s = await snapshot(page); return s.bindings.views.every(v => !v.metrics?.pendingCaret && !v.metrics?.viewport.pending)
        && (!s.bindings.comparison || s.bindings.comparison.status === "ready" && !s.bindings.comparison.workingViewport.pending && !s.bindings.comparison.referenceViewport?.pending); }).toBe(true);
}
async function offer(page: Page) { await expect(page.getByRole("option", { name: "sample", exact: true })).toBeVisible(); }
async function completionCaret(page: Page) {
    await primary(page).press("Control+Home"); for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowRight");
}
for (const mode of ["plain", "react"] as const) test.describe(`${mode} integrated language host`, () => {
    test.beforeEach(async ({ page }) => {
        page.on("pageerror", error => { throw error; }); page.on("console", message => { if (message.type() === "error") throw new Error(message.text()); });
        await page.goto(`/hosts/${mode}/?editor=candidate`); await expect(primary(page)).toBeVisible(); await ready(page);
    });
    test("keyboard completion, find and shared history remain usable during remote conflict review", async ({ page }) => {
        const original = "const saMORE = 123; // TODO\n😀 const value = 2;";
        await primary(page).fill(original); await completionCaret(page);
        const before = await snapshot(page); await page.keyboard.press("Control+Space"); await offer(page);
        await expect(page.locator('[aria-label="Left host pane"] .st-token-keyword').first()).toHaveText("const");
        await expect(page.locator('[aria-label="Left host pane"] .st-diagnostic')).toHaveText("TODO");
        await expect(primary(page)).toBeFocused(); await page.keyboard.press("Alt+Enter"); await ready(page);
        expect(await text(page)).toBe(original.replace("saMORE", "sample"));
        expect((await snapshot(page)).history.undoDepth).toBe(before.history.undoDepth + 1);
        await secondary(page).press("Control+z"); expect(await text(page)).toBe(original);
        await secondary(page).press("Control+Shift+z"); expect(await text(page)).toBe(original.replace("saMORE", "sample"));
        await primary(page).press("Control+f"); const query = page.getByRole("textbox", { name: "Find source", exact: true });
        await expect(query).toBeFocused(); await query.fill("TODO"); await expect(page.getByLabel("Find status", { exact: true })).toContainText("1 matches · ready");
        await query.press("Enter"); await expect(primary(page)).toBeFocused();
        await primary(page).press("Control+h"); const replacement = page.getByRole("textbox", { name: "Replacement", exact: true });
        await expect(replacement).toBeFocused(); await replacement.fill("DONE"); await replacement.press("Enter");
        const corrected = original.replace("saMORE", "sample").replace("TODO", "DONE"); expect(await text(page)).toBe(corrected);
        await page.evaluate(() => window.hostFixture.externalWrite("const remote = 9; // TODO"));
        await page.getByRole("button", { name: "Save source", exact: true }).click();
        await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
        await page.getByRole("button", { name: "Finish save", exact: true }).click(); await expect(page.getByRole("region", { name: "Save conflict", exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Review remote source", exact: true }).click();
        await page.getByRole("button", { name: "Finish remote review", exact: true }).click(); await ready(page);
        const working = page.getByRole("textbox", { name: "Comparison working source", exact: true });
        await working.press("Control+End"); await working.pressSequentially("\nconst saMORE");
        await working.press("ArrowLeft"); await working.press("ArrowLeft"); await working.press("ArrowLeft"); await working.press("ArrowLeft");
        await working.press("Control+Space"); await offer(page); await page.keyboard.press("Alt+Enter"); await ready(page);
        expect(await text(page)).toBe(corrected + "\nconst sample");
        expect(await page.evaluate(() => window.hostFixture.referenceRange(0, window.hostFixture.snapshot().bindings.comparison!.baseline!.length))).toBe("const remote = 9; // TODO");
        await expect(page.locator('.st-comparison .st-token-keyword').first()).toHaveText("const");
        await page.getByRole("button", { name: "Save reviewed source", exact: true }).click();
        await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
        await working.press("Control+End"); await working.pressSequentially(" later");
        await page.getByRole("button", { name: "Finish save", exact: true }).click();
        await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(0);
        expect(await text(page)).toBe(corrected + "\nconst sample later"); expect((await snapshot(page)).source.dirty).toBe(true);
        expect((await snapshot(page)).activity.background).toBeGreaterThan(before.activity.background); expect((await snapshot(page)).source.exports).toBe(0); // Later working buffer, after the save capture.
        await page.evaluate(() => window.hostFixture.dispose());
        expect((await snapshot(page)).diagnostics).toMatchObject({ leases: 0, views: 0, subscriptions: 0 });
    });
    test("view changes cancel captured replies; pending remount/disposal releases every language lease", async ({ page }) => {
        await primary(page).fill("const saMORE = 1; // TODO"); await completionCaret(page);
        await page.evaluate(() => window.hostFixture.setProviderDelay(200)); await primary(page).press("Control+Space");
        await secondary(page).focus(); await secondary(page).press("Control+Home");
        await expect.poll(async () => (await snapshot(page)).bindings.language.sessions.find(s => s.id === "primary")!.provider.stale).toBe(1);
        await expect(page.getByRole("option")).toHaveCount(0); expect(await text(page)).toBe("const saMORE = 1; // TODO");
        await completionCaret(page); await page.evaluate(() => window.hostFixture.setProviderDelay(1000)); await primary(page).press("Control+Space");
        const selection = (await snapshot(page)).bindings.views.map(v => ({ id: v.id, selection: v.selection }));
        await page.evaluate(() => window.hostFixture.unmount());
        expect((await snapshot(page)).diagnostics).toMatchObject({ subscriptions: 0, leases: 2, views: 2 }); // Retained view handles only.
        expect((await snapshot(page)).bindings.language.sessions).toEqual([]);
        await page.evaluate(() => window.hostFixture.mount()); await ready(page);
        expect((await snapshot(page)).bindings.views.map(v => ({ id: v.id, selection: v.selection }))).toEqual(selection);
        await expect(page.getByRole("option")).toHaveCount(0);
        await primary(page).focus(); await page.evaluate(() => window.hostFixture.setProviderDelay(1000)); await primary(page).press("Control+Space");
        await page.evaluate(() => window.hostFixture.dispose()); const disposed = await snapshot(page);
        expect(disposed.diagnostics).toMatchObject({ leases: 0, views: 0, subscriptions: 0 }); expect(disposed.bindings.language.sessions).toEqual([]);
        expect(disposed.hostSubscriptions).toBe(0);
    });
    test("provider outage, malformed reply and reconnect preserve local typing and a fresh completion", async ({ page }) => {
        await primary(page).fill("const saMORE = 1; // TODO"); await completionCaret(page);
        await page.evaluate(() => window.hostFixture.faultProviderNext("malformed")); await primary(page).press("Control+Space");
        await expect(page.getByLabel("Language status", { exact: true })).toContainText("Malformed");
        await page.evaluate(() => window.hostFixture.faultProviderNext("failure")); await primary(page).press("Control+Space");
        await expect(page.getByLabel("Language status", { exact: true })).toContainText("unavailable");
        await primary(page).pressSequentially("x"); expect(await text(page)).toBe("const saxMORE = 1; // TODO");
        await page.getByRole("button", { name: "Reconnect provider", exact: true }).click();
        await primary(page).press("Control+Space"); await offer(page); await primary(page).press("Alt+Enter");
        expect(await text(page)).toBe("const sample = 1; // TODO");
        await primary(page).press("Control+z"); expect(await text(page)).toBe("const saxMORE = 1; // TODO");
        expect((await snapshot(page)).source.exports).toBe(0);
    });
    test("proposal locks reject an offered completion; a fresh correction survives save, acknowledgement retry and the next request", async ({ page }) => {
        await primary(page).fill("const saMORE = 1; // TODO"); await completionCaret(page); await primary(page).press("Control+Space"); await offer(page);
        await page.getByRole("button", { name: "Associate agent", exact: true }).click();
        await page.getByRole("button", { name: "Request proposal", exact: true }).click();
        const captured = (await snapshot(page)).requestInput, revision = (await snapshot(page)).source.revision;
        await page.getByRole("button", { name: "Replace completion", exact: true }).click();
        expect((await snapshot(page)).source.revision).toBe(revision); expect(await text(page)).toBe("const saMORE = 1; // TODO");
        await expect(page.getByLabel("Language status", { exact: true })).toContainText("rejected");
        await page.evaluate(() => window.hostFixture.deliverProposal("const saMORE = 2; // TODO")); await ready(page);
        await completionCaret(page); await primary(page).press("Control+Space"); await offer(page); await primary(page).press("Alt+Enter");
        await expect(secondary(page)).toHaveValue("const sample = 2; // TODO");
        await page.getByRole("button", { name: "Save source", exact: true }).click(); await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
        await primary(page).press("Control+End"); await primary(page).pressSequentially(" correction");
        await page.evaluate(() => window.hostFixture.finishSave()); await expect.poll(async () => (await snapshot(page)).review.acknowledgements.length).toBe(1);
        await page.getByRole("button", { name: "Retry acknowledgement", exact: true }).click();
        await expect.poll(async () => (await snapshot(page)).review.acknowledgements[0]?.status).toBe("failed");
        await page.getByRole("button", { name: "Retry acknowledgement", exact: true }).click(); await expect.poll(async () => (await snapshot(page)).review.proposal).toBeNull();
        expect(await text(page)).toBe("const sample = 2; // TODO correction");
        await page.getByRole("button", { name: "Request proposal", exact: true }).click();
        expect((await snapshot(page)).requestInput!.sourceLength).toBe("const sample = 2; // TODO correction".length);
        expect((await snapshot(page)).requestInput!.sourceRevision).toBeGreaterThan(captured!.sourceRevision);
        await page.evaluate(() => window.hostFixture.dispose()); expect((await snapshot(page)).diagnostics).toMatchObject({ leases: 0, views: 0, subscriptions: 0 });
    });
    test("100k-line highlighting, worker requests and keyboard search stay bounded with review mounted", async ({ page }) => {
        await page.evaluate(() => { const fixture = window.hostFixture; fixture.editSource(fixture.snapshot().source.revision,
            [{ from: 0, to: fixture.snapshot().source.length, insert: "const saMORE = 123; // TODO\n".repeat(100_000) }]); });
        await page.getByRole("button", { name: "Open source review", exact: true }).click(); await ready(page);
        await expect(page.locator(".st-comparison-added.st-token-keyword").first()).toHaveText("const");
        await completionCaret(page); await primary(page).press("Control+Space"); await offer(page);
        const s = await snapshot(page), session = s.bindings.language.sessions.find(s => s.id === "primary")!;
        expect(session.provider.postedUnits).toBeLessThanOrEqual(4096); expect(session.presentation.cachedLines).toBeLessThanOrEqual(128);
        expect(s.bindings.views.every(v => v.metrics!.inputUnits <= 2600 && v.metrics!.viewport.rows < 50)).toBe(true);
        await primary(page).press("Control+f"); await page.getByRole("textbox", { name: "Find source", exact: true }).fill("TODO");
        await expect(page.getByLabel("Find status", { exact: true })).toContainText("100000 matches · ready");
        await page.getByRole("textbox", { name: "Find source", exact: true }).press("Escape"); await expect(primary(page)).toBeFocused();
        expect((await snapshot(page)).source.exports).toBe(0); await page.evaluate(() => window.hostFixture.dispose());
        expect((await snapshot(page)).diagnostics).toMatchObject({ leases: 0, views: 0, subscriptions: 0 });
    });
});
