import { ready, isolatedTest as test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";

const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const source = (page: Page) => page.evaluate(() => window.hostFixture.range(0, window.hostFixture.snapshot().source.length));
const field = (page: Page, name = "Primary source") => page.getByRole("textbox", { name, exact: true });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });

async function seed(page: Page, text: string, offset = text.indexOf("saMORE") + 2) {
    await page.evaluate(text => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]); }, text);
    await field(page).focus(); await page.evaluate(offset => { const f = window.hostFixture; f.selectSource("primary", f.snapshot().source.revision, { anchor: offset, head: offset }); }, offset); await ready(page);
}
async function offer(page: Page) { await field(page).press("Control+Space"); await expect(page.getByRole("option", { name: "sample", exact: true })).toBeVisible(); }

test.describe(`plain LSP review host`, () => {
    test.beforeEach(async ({ page }) => {
         await page.goto("/hosts/plain/?language=lsp"); await expect(field(page)).toBeVisible(); await ready(page);
    });
    test("LSP completion in conflict review preserves its reference and captured Save/Run identities", async ({ page }) => {
        const original = "const local = 1; // TODO", remote = "const remote = 9;\r\n"; await seed(page, original, original.length);
        await page.evaluate(text => window.hostFixture.externalWrite(text), remote); await button(page, "Save source").click(); await button(page, "Finish save").click();
        await button(page, "Review remote source").click(); await button(page, "Finish remote review").click(); await ready(page);
        const working = field(page, "Comparison working source"); await working.press("Control+End"); await working.pressSequentially("\nconst saMORE"); for (let i = 0; i < 4; i++) await working.press("ArrowLeft");
        await working.press("Control+Space"); await expect(page.getByRole("option", { name: "sample", exact: true })).toBeVisible(); await working.press("Alt+Enter"); await ready(page);
        const corrected = original + "\nconst sample"; expect(await source(page)).toBe(corrected); expect(await page.evaluate(text => window.hostFixture.referenceRange(0, text.length), remote)).toBe(remote);
        await field(page, "Comparison baseline source").focus(); await field(page, "Comparison baseline source").press("Control+Space"); await expect(page.getByRole("listbox", { name: "Completions" })).toBeHidden(); await expect(field(page, "Comparison baseline source")).toHaveAttribute("readonly", "");
        await working.focus(); const identity = (await snapshot(page)).source.id; await button(page, "Save reviewed source").click(); await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
        await working.press("Control+End"); await working.pressSequentially(" later"); await button(page, "Finish save").click(); await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(0); expect((await snapshot(page)).source.dirty).toBe(true);
        await button(page, "Run captured inputs").click(); await expect.poll(async () => (await snapshot(page)).pendingRuns.length).toBe(1);
        expect((await snapshot(page)).pendingRuns[0]!.sourceId).toBe(identity); expect(await page.evaluate(() => window.hostFixture.runCapture(0))).toMatchObject({ source: corrected + " later" });
    });
    test("read-only completion rejects the detached option and keyboard acceptance", async ({ page }) => {
        const original = "const saMORE = 1; // TODO";
        await seed(page, original);
        await offer(page);
        const option = page.getByRole("option", { name: "sample", exact: true });
        const stale = await option.elementHandle();
        expect(stale).not.toBeNull();
        const before = await snapshot(page);
        await page.evaluate(() => window.hostFixture.setSourceReadOnly(true));
        await expect(page.getByRole("option")).toHaveCount(0);

        await stale!.evaluate(node => (node as HTMLButtonElement).click());
        await stale!.dispose();
        await field(page).press("Alt+Enter");
        expect(await source(page)).toBe(original);
        expect((await snapshot(page)).history).toEqual(before.history);

        await page.evaluate(() => window.hostFixture.setSourceReadOnly(false));
        await offer(page);
        await field(page).press("Alt+Enter");
        await expect(field(page, "Secondary source")).toHaveValue("const sample = 1; // TODO");
    });
});
