import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const input = (page: Page, name = "Primary source") => page.getByRole("textbox", { name, exact: true });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
async function ready(page: Page): Promise<void> {
    await expect.poll(() => page.evaluate(() => { const s = window.hostFixture.snapshot(), c = s.bindings.comparison;
        return s.bindings.views.every(v => v.metrics && !v.metrics.pendingCaret && !v.metrics.viewport.pending && v.metrics.viewport.revision === s.source.revision && v.metrics.viewport.foldGeneration === v.foldGeneration)
            && (!c || c.status === "ready" && !c.input.pendingCaret && !c.workingViewport.pending && !c.referenceViewport?.pending && c.workingViewport.foldGeneration === c.foldGeneration);
    })).toBe(true);
}
async function exact(page: Page, text: string): Promise<void> {
    expect(await page.evaluate(text => { const f = window.hostFixture; if (f.snapshot().source.length !== text.length) return false;
        for (let from = 0; from < text.length; from += 32768) if (f.range(from, Math.min(text.length, from + 32768)) !== text.slice(from, from + 32768)) return false; return true;
    }, text)).toBe(true);
}
for (const host of ["plain", "react"]) {
    for (const large of [false, true]) test(`${host} ${large ? "100k" : "normal"} folding preserves independent views, review, history, captured Save/Run and remount`, async ({ page }) => {
        test.setTimeout(120000); page.on("pageerror", error => { throw error; }); await page.goto(`/hosts/${host}/?editor=candidate`);
        const original = "header\r\nneedle one\r\nneedle two\r\n" + (large ? "const filler = 1;\r\n".repeat(100000) : "") + "footer\r\nend", footer = original.indexOf("footer");
        await page.evaluate(text => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]); }, original);
        await button(page, "Open source review").click(); await ready(page); const reference = (await snapshot(page)).bindings.comparison!.baseline!.version;
        await input(page).focus(); await page.evaluate(to => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 0, head: to }]); }, footer);
        const before = await snapshot(page); await button(page, "Fold selected lines").click(); await ready(page);
        let s = await snapshot(page); expect(s.source.revision).toBe(before.source.revision); expect(s.history).toEqual(before.history);
        expect(s.bindings.views.find(v => v.id === "primary")!.metrics!.viewport).toMatchObject({ visibleLines: 3, rows: 3, collapsedFolds: 1 });
        expect(s.bindings.views.find(v => v.id === "secondary")!.metrics!.viewport.collapsedFolds).toBe(0); expect(s.bindings.comparison!.workingViewport.collapsedFolds).toBe(0);
        await input(page).press("ArrowDown"); await ready(page); expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selection.head).toBe(footer);
        await input(page).press("PageDown"); await ready(page); expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selection.head).toBe(original.length - 3);
        await input(page).press("Control+Home"); await ready(page); await input(page).pressSequentially("X"); await ready(page); await exact(page, "X" + original);
        expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.metrics!.viewport.collapsedFolds).toBe(1);
        await input(page, "Secondary source").press("Control+z"); await ready(page); await exact(page, original);
        await input(page).press("Control+Shift+z"); await ready(page); await exact(page, "X" + original);
        await input(page, "Secondary source").press("Control+z"); await ready(page); await exact(page, original); expect((await snapshot(page)).source.exports).toBe(0);
        await input(page).press("Control+s"); await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
        await input(page).press("Control+End"); await ready(page); await input(page).pressSequentially(" later"); await ready(page); await page.evaluate(() => window.hostFixture.finishSave());
        await expect.poll(async () => (await snapshot(page)).pendingCommands).toBe(0); await ready(page); await exact(page, original + " later");
        await input(page).press("Control+z"); await ready(page); await exact(page, original); expect((await snapshot(page)).source.dirty).toBe(false);
        // Save explicitly exports its captured revision; ordinary folding/input above did not.
        const exports = (await snapshot(page)).source.exports;
        const working = input(page, "Comparison working source"); await working.focus();
        await page.evaluate(to => { const f = window.hostFixture; f.selectSourceSet("comparison", f.snapshot().source.revision, [{ anchor: 0, head: to }]); }, footer);
        await button(page, "Fold selected lines").click(); await ready(page); expect((await snapshot(page)).bindings.comparison!.workingViewport.collapsedFolds).toBe(1);
        await working.press("Control+f"); await page.getByRole("textbox", { name: "Find source", exact: true }).fill("needle two");
        await expect(page.getByLabel("Find status", { exact: true })).toContainText("1 matches · ready"); await button(page, "Find next").click(); await ready(page);
        s = await snapshot(page); expect(s.bindings.comparison!.selection).toMatchObject({ anchor: original.indexOf("needle two"), head: original.indexOf("needle two") + 10 });
        expect(s.bindings.comparison!.workingViewport.collapsedFolds).toBe(0); expect(s.bindings.views.find(v => v.id === "primary")!.metrics!.viewport.collapsedFolds).toBe(1);
        await working.press("Control+Shift+["); await ready(page); expect((await snapshot(page)).bindings.comparison!.workingViewport.collapsedFolds).toBe(1);
        await button(page, "Next change").click(); await ready(page); expect((await snapshot(page)).bindings.comparison!.workingViewport.collapsedFolds).toBe(0);
        expect((await snapshot(page)).bindings.comparison!.baseline!.version).toBe(reference); expect(await page.evaluate(() => window.hostFixture.referenceRange(0, 5))).toBe("start");
        expect((await snapshot(page)).source.exports).toBe(exports);
        const viewId = (await snapshot(page)).bindings.views.find(v => v.id === "primary")!.viewId;
        await page.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); }); await ready(page);
        s = await snapshot(page); expect(s.bindings.views.find(v => v.id === "primary")!.viewId).toBe(viewId); expect(s.bindings.views.find(v => v.id === "primary")!.metrics!.viewport.collapsedFolds).toBe(1);
        await exact(page, original); await button(page, "Run captured inputs").click(); await expect.poll(async () => (await snapshot(page)).pendingRuns.length).toBe(1);
        expect(await page.evaluate(text => window.hostFixture.runCapture(0)!.source === text, original)).toBe(true); await button(page, "Finish run").click();
        await page.evaluate(() => window.hostFixture.dispose()); expect((await snapshot(page)).diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); expect((await snapshot(page)).hostSubscriptions).toBe(0);
        await expect.poll(() => page.workers().length).toBe(0);
    });
    test(`${host} disclosure rejects old DOM captures, expires hover and respects composition`, async ({ page }) => {
        page.on("pageerror", error => { throw error; }); await page.goto(`/hosts/${host}/?editor=candidate`); const text = "const alpha\r\nconst beta\r\nend";
        await page.evaluate(text => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]); }, text);
        await input(page).focus(); await page.evaluate(to => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 0, head: to }]); }, text.indexOf("end"));
        await button(page, "Fold selected lines").click(); await ready(page); await input(page).press("ArrowRight"); await input(page).press("ArrowRight"); await ready(page);
        await input(page).press("Control+k"); await input(page).press("Control+i"); await expect(page.getByRole("tooltip")).toContainText("Declares a constant binding.");
        await button(page, "Expand lines 2–2").focus(); await button(page, "Expand lines 2–2").press("Space"); await ready(page); await expect(page.getByRole("tooltip")).toBeHidden();
        await button(page, "Collapse lines 2–2").press("Enter"); await ready(page);
        await button(page, "Expand lines 2–2").evaluate(node => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: 0, insert: "X" }]); (node as HTMLButtonElement).click(); });
        await ready(page); expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.metrics!.viewport.collapsedFolds).toBe(1); await exact(page, "X" + text);
        await input(page).focus(); await input(page).evaluate(node => node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))); await ready(page);
        const staged = await snapshot(page); await button(page, "Fold selected lines").click(); await expect(page.getByLabel("Fold status", { exact: true })).toContainText("Finish composition");
        expect((await snapshot(page)).source.revision).toBe(staged.source.revision); expect((await snapshot(page)).history).toEqual(staged.history);
        await expect(button(page, "Expand lines 2–2")).toBeDisabled();
        await input(page).evaluate(node => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }))); await ready(page); await expect(button(page, "Expand lines 2–2")).toBeEnabled();
        await input(page).press("Control+End"); await input(page).pressSequentially("!"); await ready(page); await exact(page, "X" + text + "!"); expect((await snapshot(page)).source.exports).toBe(0);
        await page.evaluate(() => window.hostFixture.dispose()); expect((await snapshot(page)).diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); expect((await snapshot(page)).hostSubscriptions).toBe(0);
    });
}
