import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function ready(page: Page): Promise<void> {
    await page.waitForFunction(() => {
        const s = window.hostFixture.snapshot(), c = s.bindings.comparison;
        return c?.status === "ready" && !c.input.pendingCaret && !c.workingViewport.pending && !c.referenceViewport?.pending
            && c.workingViewport.revision === s.source.revision
            && JSON.stringify(c.workingViewport.selection) === JSON.stringify(c.selection);
    });
}

for (const host of ["plain", "react"]) for (const editor of ["native", "candidate"]) {
    test(`${host} ${editor} retains independent comparison views through close, background edits and full remount`, async ({ page }) => {
        page.on("pageerror", error => { throw error; });
        await page.goto(`/hosts/${host}/?editor=${editor}`);
        await page.waitForFunction(() => window.hostFixture?.snapshot().bindings.activeViews === 2);
        await page.evaluate(() => {
            const f = window.hostFixture, s = f.snapshot();
            f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: Array.from({ length: 300 }, (_, i) => `${i}: ${"abcdefghij".repeat(30)}`).join("\n") }]);
        });
        const click = (name: string) => page.getByRole("button", { name, exact: true }).click();
        await click("Open source review"); await ready(page);
        await click("Capture review acceptance"); await click("Finish review acceptance"); await ready(page);
        await page.evaluate(() => {
            const f = window.hostFixture, s = f.snapshot();
            f.editSource(s.source.revision, [{ from: 10000, to: 10001, insert: "CHANGED" }]);
        }); await ready(page);
        await click("Next change");
        const input = page.getByRole("textbox", { name: "Comparison working source", exact: true });
        await input.press("Control+End"); await input.press("Shift+Home"); await ready(page);
        await page.locator(".st-comparison-panes .st-viewport").evaluateAll(nodes => nodes.forEach((node, i) => {
            node.scrollTop = i ? 2600 : 1800; node.scrollLeft = i ? 350 : 250;
        }));
        await page.waitForFunction(() => { const c = window.hostFixture.snapshot().bindings.comparison!;
            return c.workingViewport.scrollTop === 2600 && c.referenceViewport?.scrollTop === 1800; }); await ready(page);
        const before = (await page.evaluate(() => window.hostFixture.snapshot())).bindings.comparison!;
        expect(before.selection.anchor).toBeGreaterThan(before.selection.head);
        expect(before.referenceViewport!.selection!.anchor).toBeLessThan(before.referenceViewport!.selection!.head);
        await click("Close source review");
        await page.evaluate(() => { const f = window.hostFixture; f.unmount(); f.editSource(f.snapshot().source.revision, [{ from: 0, to: 0, insert: "prefix" }]); f.mount(); });
        await click("Open source review"); await ready(page);
        const after = (await page.evaluate(() => window.hostFixture.snapshot())).bindings.comparison!;
        expect(after.viewId).toBe(before.viewId);
        expect(after.selection).toEqual({ ...before.selection, anchor: before.selection.anchor + 6, head: before.selection.head + 6 });
        expect(after.workingViewport.scrollTop).toBeCloseTo(before.workingViewport.scrollTop, 3);
        expect(after.workingViewport.scrollLeft).toBeCloseTo(before.workingViewport.scrollLeft, 3);
        expect(after.referenceViewport!.selection).toEqual(before.referenceViewport!.selection);
        expect(after.referenceViewport!.scrollTop).toBeCloseTo(before.referenceViewport!.scrollTop, 3);
        expect(after.referenceViewport!.scrollLeft).toBeCloseTo(before.referenceViewport!.scrollLeft, 3);
        await page.evaluate(() => { const f = window.hostFixture; f.unmount(); f.editSource(f.snapshot().source.revision, [{ from: 0, to: 0, insert: "++" }]); f.mount(); });
        await ready(page);
        const remounted = (await page.evaluate(() => window.hostFixture.snapshot())).bindings.comparison!;
        expect(remounted.viewId).toBe(before.viewId);
        expect(remounted.selection).toEqual({ ...before.selection, anchor: before.selection.anchor + 8, head: before.selection.head + 8 });
        expect(remounted.referenceViewport!.selection).toEqual(before.referenceViewport!.selection);
        expect(remounted.referenceViewport!.scrollTop).toBeCloseTo(before.referenceViewport!.scrollTop, 3);
        expect(await input.evaluate(node => node === document.activeElement)).toBe(false);
        await click("Capture review acceptance"); await click("Finish review acceptance"); await ready(page);
        const replaced = (await page.evaluate(() => window.hostFixture.snapshot())).bindings.comparison!;
        expect(replaced.viewId).toBe(before.viewId); expect(replaced.selection).toEqual(remounted.selection);
        expect(replaced.referenceViewport!.selection).toMatchObject({ anchor: 0, head: 0 });
        expect(replaced.referenceViewport!.scrollTop).toBe(0); expect(replaced.referenceViewport!.scrollLeft).toBe(0);
        await page.evaluate(() => window.hostFixture.dispose());
        expect((await page.evaluate(() => window.hostFixture.snapshot())).diagnostics).toMatchObject({ views: 0, subscriptions: 0, leases: 0 });
    });
}

test("viewport snapshots retain the completed render selection until a selection-only frame finishes", async ({ page }) => {
    await page.goto("/editing/");
    await page.waitForFunction(() => { const s = window.editingFixture?.snapshot(); return s && !s.primary.viewport.pending; });
    const observed = await page.evaluate(() => {
        const f = window.editingFixture, before = f.snapshot();
        f.select("primary", { anchor: 2, head: 6 });
        return { before, after: f.snapshot() };
    });
    expect(observed.after.document!.revision).toBe(observed.before.document!.revision);
    expect(observed.after.primary.selection).toMatchObject({ anchor: 2, head: 6 });
    expect(observed.after.primary.viewport.selection).toEqual(observed.before.primary.viewport.selection);
    expect(observed.after.primary.viewport.pending).toBe(true);
    await page.waitForFunction(() => { const s = window.editingFixture.snapshot();
        return !s.primary.pendingCaret && !s.primary.viewport.pending && s.primary.viewport.selection?.head === 6; });
    const ready = await page.evaluate(() => window.editingFixture.snapshot());
    expect(ready.primary.viewport.selection).toEqual(ready.primary.selection);
    await page.getByRole("textbox", { name: "Primary source", exact: true }).press("ArrowRight");
    const command = await page.evaluate(() => window.editingFixture.snapshot());
    expect(command.primary.keydownEvents).toBe(ready.primary.keydownEvents + 1);
    expect(command.primary.lastKeydownMs).toBeGreaterThanOrEqual(0);
    await page.evaluate(() => window.editingFixture.dispose());
    expect((await page.evaluate(() => window.editingFixture.snapshot())).primary.viewport.selection).toBeNull();
});
