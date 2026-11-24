import { ready, test, expect } from "./fixtures.ts";
import type { Page, Locator } from "@playwright/test";
const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());

const painted = (input: Locator) => input.evaluate(node => !(node.parentElement!.querySelector(".st-input-caret") as HTMLElement).hidden);
test(`plain raw CRLF caret remains painted and moves vertically in source and comparison`, async ({ page }, testInfo) => {
    test.setTimeout(120000);
     await page.goto(`/hosts/plain/`);
    await page.evaluate(() => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: "a\r\nb" }]); });
    await page.getByRole("button", { name: "Open source review", exact: true }).click(); await ready(page);
    for (const view of ["primary", "comparison"] as const) {
        const input = page.getByRole("textbox", { name: view === "primary" ? "Primary source" : "Comparison working source", exact: true });
        await input.press("Control+f"); await page.getByRole("checkbox", { name: "Regular expression", exact: true }).check();
        await page.getByRole("textbox", { name: "Find source", exact: true }).fill("(?<=a\\r)(?=\\n)");
        await expect(page.getByLabel("Find status", { exact: true })).toContainText("1 matches · ready"); await page.getByRole("button", { name: "Find next", exact: true }).click(); await ready(page);
        const selection = () => snapshot(page).then(s => view === "primary" ? s.bindings.views.find(v => v.id === view)!.selection : s.bindings.comparison!.selection!);
        expect(await selection()).toMatchObject({ anchor: 2, head: 2 });
        await expect(input.locator("..").locator('.st-viewport-row[data-line="0"] .st-search-match[data-ornament="point"]')).toHaveCount(1);
        await input.focus(); await ready(page); expect(await painted(input)).toBe(true);
        if (view === "comparison" && testInfo.project.name === "chromium") await page.screenshot({ path: testInfo.outputPath("raw-crlf-caret.png"), fullPage: true });
        await input.press("ArrowDown"); await ready(page); expect(await selection()).toMatchObject({ anchor: 4, head: 4 }); expect(await painted(input)).toBe(true);
        await page.getByRole("button", { name: "Find next", exact: true }).click(); await ready(page); expect(await selection()).toMatchObject({ anchor: 2, head: 2 });
        await input.pressSequentially("!"); await ready(page); expect(await page.evaluate(() => window.hostFixture.range(0, 5))).toBe("a\r!\nb");
        await input.press("Control+z"); await ready(page); expect(await page.evaluate(() => window.hostFixture.range(0, 4))).toBe("a\r\nb");
        expect(await selection()).toMatchObject({ anchor: 2, head: 2 }); expect(await painted(input)).toBe(true); expect((await snapshot(page)).source.exports).toBe(0);
    }
    await page.evaluate(() => window.hostFixture.dispose());
});
