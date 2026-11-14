import { test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const input = (page: Page, name = "Primary source") => page.getByRole("textbox", { name, exact: true });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
async function ready(page: Page): Promise<void> {
    await expect.poll(() => page.evaluate(() => { const s = window.hostFixture.snapshot(), c = s.bindings.comparison;
        return s.bindings.views.every(v => v.metrics && !v.metrics.pendingCaret && !v.metrics.viewport.pending && v.metrics.viewport.revision === s.source.revision)
            && (!c || c.status === "ready" && !c.input.pendingCaret && !c.workingViewport.pending && !c.referenceViewport?.pending);
    })).toBe(true);
}
async function exact(page: Page, text: string): Promise<void> {
    expect(await page.evaluate(text => { const f = window.hostFixture; if (f.snapshot().source.length !== text.length) return false;
        for (let from = 0; from < text.length; from += 32768) if (f.range(from, Math.min(text.length, from + 32768)) !== text.slice(from, from + 32768)) return false; return true;
    }, text)).toBe(true);
}
for (const host of ["plain", "react"]) for (const large of [false, true]) test(`${host} ${large ? "100k" : "normal"} replace all stays cancelled after restored authority and permits an explicit retry`, async ({ page }) => {
    test.setTimeout(120000);  await page.goto(`/hosts/${host}/?editor=candidate`);
    const original = "cat cat\r\n" + "const unchanged = 123;\r\n".repeat(large ? 100000 : 1), changed = "dog dog" + original.slice(7);
    await page.evaluate(text => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]);
        f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 0, head: 3 }, { anchor: text.length, head: text.length }]); }, original);
    await button(page, "Open source review").click(); await ready(page);
    for (const authority of ["permission", "lease"] as const) {
        await input(page).press("Control+f"); await page.getByRole("textbox", { name: "Find source", exact: true }).fill("cat");
        const status = page.getByLabel("Find status", { exact: true }); await expect(status).toContainText("2 matches · ready");
        await page.getByRole("textbox", { name: "Replacement", exact: true }).fill("dog"); await ready(page);
        const before = await snapshot(page), selected = before.bindings.views.find(v => v.id === "primary")!.selectionSet;
        await button(page, "Replace all").evaluate((target, authority) => {
            const listener = (event: Event) => {
                if (event.target !== target) return; document.removeEventListener("click", listener);
                const f = window.hostFixture;
                // Document bubbling follows both the plain handler and React's root delegation.
                if (authority === "permission") { f.setSourceReadOnly(true); f.setSourceReadOnly(false); }
                else f.cycleSourceEditLease();
            }; document.addEventListener("click", listener);
        }, authority);
        await button(page, "Replace all").click(); await expect(status).toContainText("Replacement cancelled"); await ready(page); await exact(page, original);
        const cancelled = await snapshot(page); expect(cancelled.source.revision).toBe(before.source.revision); expect(cancelled.history).toEqual(before.history);
        expect(cancelled.bindings.views.find(v => v.id === "primary")!.selectionSet).toEqual(selected); expect(cancelled.diagnostics.subscriptions).toBe(before.diagnostics.subscriptions);
        expect(cancelled.source.exports).toBe(0); expect(await page.evaluate(() => window.hostFixture.referenceRange(0, 5))).toBe("start");
        await button(page, "Replace all").click(); await expect(status).toContainText("Replaced 2 matches."); await ready(page); await exact(page, changed);
        expect((await snapshot(page)).history.undoDepth).toBe(before.history.undoDepth + 1); expect((await snapshot(page)).diagnostics.subscriptions).toBe(before.diagnostics.subscriptions);
        await input(page, "Secondary source").press("Control+z"); await ready(page); await exact(page, original);
        expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selectionSet).toEqual(selected);
    }
    await input(page).press("Control+s"); await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
    await page.evaluate(() => window.hostFixture.finishSave()); await expect.poll(async () => (await snapshot(page)).pendingCommands).toBe(0); await ready(page);
    expect((await snapshot(page)).source.dirty).toBe(false); expect((await snapshot(page)).source.exports).toBe(0);
    await page.evaluate(() => window.hostFixture.dispose()); expect((await snapshot(page)).diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); expect((await snapshot(page)).hostSubscriptions).toBe(0);
});
