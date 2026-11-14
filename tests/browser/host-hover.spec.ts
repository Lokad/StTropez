import { test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const primary = (page: Page) => page.getByRole("textbox", { name: "Primary source", exact: true });
const tooltip = (page: Page) => page.getByRole("tooltip");
async function ready(page: Page): Promise<void> {
    await expect.poll(() => page.evaluate(() => { const s = window.hostFixture.snapshot(), c = s.bindings.comparison;
        return s.bindings.views.every(v => v.metrics && !v.metrics.pendingCaret && !v.metrics.viewport.pending && v.metrics.viewport.revision === s.source.revision && v.metrics.viewport.selectionSet === v.selectionSet)
            && (!c || c.status === "ready" && !c.input.pendingCaret && !c.workingViewport.pending && !c.referenceViewport?.pending && c.workingViewport.selectionSet === c.selectionSet);
    })).toBe(true);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function point(page: Page): Promise<{ x: number; y: number }> {
    return page.locator('.st-editing-candidate:has(> textarea[aria-label="Primary source"]) .st-viewport-row').first().evaluate(row => {
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT), node = walker.nextNode(); if (!node) throw new Error("No rendered source word.");
        const range = document.createRange(); range.setStart(node, 1); range.setEnd(node, 2); const box = range.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    });
}
for (const host of ["plain", "react"]) {
    test(`${host} keyboard hover keeps complete selections, safe text, input focus and shared history`, async ({ page }) => {
         await page.goto(`/hosts/${host}/?editor=candidate`);
        const original = "const café = 1;\r\n𐐀value = 2;";
        await page.evaluate(text => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]); f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 2, head: 2 }, { anchor: 7, head: 7 }]); }, original);
        await primary(page).focus(); await ready(page); const before = await snapshot(page), selected = before.bindings.views.find(v => v.id === "primary")!.selectionSet;
        await primary(page).press("Control+k"); await primary(page).press("Control+i");
        await expect(tooltip(page)).toContainText("Declares a constant binding."); expect(await primary(page).evaluate(node => node.ownerDocument.activeElement === node)).toBe(true);
        await page.evaluate(() => window.hostFixture.externalWrite("remote")); await primary(page).press("Control+s");
        await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1); await page.evaluate(() => window.hostFixture.finishSave());
        await expect(page.getByRole("region", { name: "Save conflict", exact: true })).toBeVisible();
        await expect.poll(async () => { const popup = await tooltip(page).boundingBox(), root = await page.locator('.st-editing-candidate:has(> textarea[aria-label="Primary source"])').boundingBox(); return popup && root ? popup.y - root.y : -1; }).toBeGreaterThan(0);
        await tooltip(page).click(); expect(await primary(page).evaluate(node => node.ownerDocument.activeElement === node)).toBe(true);
        await primary(page).press("Escape"); await expect(tooltip(page)).toBeHidden(); expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selectionSet).toEqual(selected);
        expect((await snapshot(page)).history).toEqual(before.history); expect((await snapshot(page)).source.revision).toBe(before.source.revision);
        await page.evaluate(() => window.hostFixture.faultHoverNext("primary", "markup")); await primary(page).press("Control+k"); await primary(page).press("Control+i");
        await expect(tooltip(page)).toContainText("<img"); await expect(tooltip(page).locator("img,script")).toHaveCount(0); expect(await page.evaluate(() => Reflect.get(window, "hoverExecuted"))).toBeUndefined();
        await primary(page).pressSequentially("X"); await ready(page); await expect(tooltip(page)).toBeHidden();
        expect(await page.evaluate(() => window.hostFixture.range(0, window.hostFixture.snapshot().source.length))).toBe(original.slice(0, 2) + "X" + original.slice(2, 7) + "X" + original.slice(7));
        expect((await snapshot(page)).history.undoDepth).toBe(before.history.undoDepth + 1); expect((await snapshot(page)).source.exports).toBe(0);
        const counters = (await snapshot(page)).bindings.hover.sessions.find(s => s.id === "primary")!.counters;
        expect(counters).toMatchObject({ created: 1, posted: 2, received: 2 }); expect(page.workers().some(worker => worker.url().endsWith("/provider-worker.js"))).toBe(true);
        await page.evaluate(() => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: "const working = 1;\r\nconst second = 2;" }]); });
        await page.getByRole("button", { name: "Open source review", exact: true }).click();
        await expect.poll(async () => (await snapshot(page)).bindings.comparison?.status).toBe("ready");
        await page.evaluate(() => { const f = window.hostFixture; f.selectSourceSet("comparison", f.snapshot().source.revision, [{ anchor: 2, head: 2 }]); });
        const working = page.getByRole("textbox", { name: "Comparison working source", exact: true });
        await working.focus(); await ready(page); await working.press("Control+k"); await working.press("Control+i"); await expect(tooltip(page)).toContainText("Declares a constant binding.");
        expect((await snapshot(page)).bindings.hover.presentation.view).toBe("comparison");
        await tooltip(page).dispatchEvent("scroll"); await expect(tooltip(page)).toBeVisible();
        expect(await working.evaluate(node => node.ownerDocument.activeElement === node)).toBe(true);
        await page.screenshot({ path: test.info().outputPath(`hover-${host}.png`) }); await expect(tooltip(page)).toBeVisible();
        const captured = await snapshot(page);
        await page.evaluate(() => { const f = window.hostFixture; f.setHoverDelay("comparison", 1000); f.inspectSymbol("comparison"); f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 2, head: 2 }]); });
        await primary(page).focus(); await ready(page); await primary(page).press("Control+k"); await primary(page).press("Control+i"); await expect(tooltip(page)).toContainText("Declares a constant binding.");
        await expect.poll(async () => (await snapshot(page)).bindings.hover.sessions.find(s => s.id === "comparison")!.counters.received).toBe(2);
        const after = await snapshot(page); expect(after.bindings.hover.presentation.view).toBe("primary");
        expect(after.bindings.comparison!.selectionSet).toEqual(captured.bindings.comparison!.selectionSet); expect(after.history).toEqual(captured.history);
        expect(after.source.revision).toBe(captured.source.revision); expect(after.source.exports).toBe(0);
        await page.evaluate(() => window.hostFixture.dispose()); expect((await snapshot(page)).diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); expect((await snapshot(page)).hostSubscriptions).toBe(0);
    });
    test(`${host} 100k pointer hover preserves host focus and refuses stale replies across edits and remount`, async ({ page }) => {
        test.setTimeout(90000);  await page.goto(`/hosts/${host}/?editor=candidate`);
        await page.evaluate(() => { const f = window.hostFixture, text = "const sample = 1234567;\r\n".repeat(100000); f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]); f.setSourceReadOnly(true); });
        await primary(page).press("Control+Home"); await ready(page); const form = page.getByRole("textbox", { name: "Configuration path", exact: true }); await form.fill("keep-focus.csv");
        const at = await point(page); await page.mouse.move(at.x, at.y); await expect(tooltip(page)).toContainText("Declares a constant binding.");
        expect(await form.evaluate(node => node.ownerDocument.activeElement === node)).toBe(true); expect((await snapshot(page)).source.exports).toBe(0);
        const posted = (await snapshot(page)).bindings.hover.sessions.find(s => s.id === "primary")!.counters; expect(posted.postedUnits).toBeLessThanOrEqual(4096);
        await page.evaluate(() => { const f = window.hostFixture; f.setSourceReadOnly(false); f.setHoverDelay("primary", 1000); f.inspectSymbol("primary"); f.editSource(f.snapshot().source.revision, [{ from: 0, to: 0, insert: "human" }]); });
        await expect(tooltip(page)).toBeHidden(); await expect.poll(async () => (await snapshot(page)).bindings.hover.sessions.find(s => s.id === "primary")!.counters.stale).toBeGreaterThan(0);
        expect(await form.evaluate(node => node.ownerDocument.activeElement === node)).toBe(true); expect(await page.evaluate(() => window.hostFixture.range(0, 5))).toBe("human");
        await page.mouse.move(1, 1);
        await page.evaluate(() => { const f = window.hostFixture; f.inspectSymbol("primary"); f.unmount(); f.mount(); }); await ready(page); await expect(tooltip(page)).toBeHidden();
        expect((await snapshot(page)).bindings.hover.sessions.find(s => s.id === "primary")!.counters).toMatchObject({ created: 0, posted: 0, received: 0 });
        expect(await page.evaluate(() => window.hostFixture.range(0, 5))).toBe("human"); expect((await snapshot(page)).source.exports).toBe(0);
        expect((await snapshot(page)).bindings.views.every(v => v.metrics!.inputUnits <= 2600 && v.metrics!.viewport.rows < 100)).toBe(true);
        await page.evaluate(() => window.hostFixture.dispose()); expect((await snapshot(page)).diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); expect((await snapshot(page)).hostSubscriptions).toBe(0);
    });
}
