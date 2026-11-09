import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const source = (page: Page, name = "Primary source") => page.getByRole("textbox", { name, exact: true });
const click = (page: Page, name: string) => page.getByRole("button", { name, exact: true }).click();
async function ready(page: Page): Promise<void> {
    await expect.poll(() => page.evaluate(() => { const s = window.hostFixture.snapshot(), c = s.bindings.comparison;
        return s.bindings.views.every(v => v.metrics && !v.metrics.pendingCaret && !v.metrics.viewport.pending && v.metrics.viewport.revision === s.source.revision)
            && (!c || c.status === "ready" && !c.input.pendingCaret && !c.workingViewport.pending && !c.referenceViewport?.pending);
    })).toBe(true);
}
async function exact(page: Page, value: string, reference = false): Promise<void> {
    expect(await page.evaluate(({ value, reference }) => { const f = window.hostFixture, s = f.snapshot();
        if ((reference ? s.bindings.comparison?.baseline?.length : s.source.length) !== value.length) return false;
        for (let from = 0; from < value.length; from += 32768) { const to = Math.min(value.length, from + 32768);
            if ((reference ? f.referenceRange(from, to) : f.range(from, to)) !== value.slice(from, to)) return false; }
        return true;
    }, { value, reference })).toBe(true);
}
for (const host of ["plain", "react"]) for (const large of [false, true])
test(`${host} ${large ? "100k" : "normal"} match-case find keeps Unicode ranges, shared undo, comparison and working Save/Run`, async ({ page }) => {
    test.setTimeout(120000); page.on("pageerror", error => { throw error; });
    await page.goto(`/hosts/${host}/?editor=candidate`);
    const original = "K k K_ 𐐀 𐐨 i ı ss ß café\r\n" + (large ? "const stableValue = 123;\r\n".repeat(100000) : "unchanged\r\n") + "K";
    await page.evaluate(text => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]); }, original);
    await click(page, "Open source review"); await ready(page); await click(page, "Keep draft version");
    await page.getByRole("combobox", { name: "Review version", exact: true }).selectOption("draft"); await click(page, "Finish version load"); await ready(page);
    const baseline = (await snapshot(page)).bindings.comparison!.baseline!.version;
    await source(page).press("Control+Home"); await source(page).press("Control+f");
    const query = page.getByRole("textbox", { name: "Find source", exact: true }), replacement = page.getByRole("textbox", { name: "Replacement", exact: true });
    const matchCase = page.getByRole("checkbox", { name: "Match case", exact: true }), wholeWord = page.getByRole("checkbox", { name: "Whole word", exact: true }), status = page.getByLabel("Find status", { exact: true });
    await expect(matchCase).toBeChecked(); await query.fill("k"); await expect(status).toContainText("1 matches · ready");
    await matchCase.uncheck(); await expect(status).toContainText("4 matches · ready"); await wholeWord.check(); await expect(status).toContainText("3 matches · ready");
    await click(page, "Find next"); expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selection).toMatchObject({ anchor: 0, head: 1 });
    await replacement.fill("$&"); const before = await snapshot(page); await click(page, "Replace current"); await ready(page); await exact(page, "$&" + original.slice(1));
    expect((await snapshot(page)).history.undoDepth).toBe(before.history.undoDepth + 1);
    await source(page, "Secondary source").press("Control+z"); await ready(page); await exact(page, original);
    await source(page, "Comparison working source").press("Control+f"); await expect(matchCase).not.toBeChecked(); await expect(wholeWord).toBeChecked(); await expect(status).toContainText("3 matches · ready");
    await query.fill("𐐨"); await expect(status).toContainText("2 matches · ready"); await click(page, "Find next");
    const selected = (await snapshot(page)).bindings.comparison!.selection; expect(selected.head - selected.anchor).toBe(2);
    expect(await page.evaluate(({ from, to }) => window.hostFixture.range(from, to), { from: selected.anchor, to: selected.head })).toMatch(/^[𐐀𐐨]$/u);
    await query.fill("k"); await expect(status).toContainText("3 matches · ready"); await replacement.fill("dog"); const planned = await snapshot(page);
    await click(page, "Replace all"); await expect(status).toContainText("Replaced 3 matches."); await ready(page);
    const changed = "dog dog" + original.slice(3, -1) + "dog"; await exact(page, changed); await exact(page, original, true);
    expect((await snapshot(page)).history.undoDepth).toBe(planned.history.undoDepth + 1); expect((await snapshot(page)).source.exports).toBe(0);
    await source(page, "Secondary source").press("Control+z"); await ready(page); await exact(page, original);
    await source(page, "Secondary source").press("Control+Shift+z"); await ready(page); await exact(page, changed);
    const working = source(page, "Comparison working source"); await working.press("Control+f"); await replacement.focus(); await replacement.press("Control+s"); await expect(replacement).toBeFocused(); await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
    expect((await snapshot(page)).pendingSaves[0]!.length).toBe(changed.length);
    await working.press("Control+End"); await working.pressSequentially(" later"); await click(page, "Finish save");
    await expect.poll(async () => (await snapshot(page)).pendingCommands).toBe(0); await ready(page); await exact(page, changed + " later");
    await working.press("Control+z"); await ready(page); await exact(page, changed); expect((await snapshot(page)).source.dirty).toBe(false);
    await query.focus(); await click(page, "Run captured inputs"); await expect.poll(async () => (await snapshot(page)).pendingRuns.length).toBe(1);
    expect((await snapshot(page)).pendingRuns[0]!.sourceId).toBe(planned.source.id);
    expect(await page.evaluate(() => window.hostFixture.runCapture(0)!.source.slice(0, 7))).toBe("dog dog"); await click(page, "Finish run");
    await page.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); }); await ready(page);
    await working.press("Control+f"); await expect(matchCase).not.toBeChecked(); await expect(wholeWord).toBeChecked(); await expect(status).toContainText("0 matches · ready");
    expect((await snapshot(page)).bindings.comparison!.baseline!.version).toBe(baseline); await exact(page, changed); await exact(page, original, true);
    await page.evaluate(() => window.hostFixture.dispose()); expect((await snapshot(page)).diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); expect((await snapshot(page)).hostSubscriptions).toBe(0);
});
