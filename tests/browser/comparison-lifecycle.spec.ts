import { ready, test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";

async function waitForReview(page: Page): Promise<void> {
    await ready(page);
    await page.waitForFunction(() => { const s = window.hostFixture.snapshot(); return window.hostFixture.settled && (s.bindings.comparison !== null); });
}

test(`plain retains independent comparison views through close, background edits and full remount`, async ({ page }) => {

    await page.goto(`/hosts/plain/`);
    await page.waitForFunction(() => window.hostFixture?.snapshot().bindings.activeViews === 2);
    await page.evaluate(() => {
        const f = window.hostFixture, s = f.snapshot();
        f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: Array.from({ length: 300 }, (_, i) => `${i}: ${"abcdefghij".repeat(30)}`).join("\n") }]);
    });
    const click = (name: string) => page.getByRole("button", { name, exact: true }).click();
    await click("Open source review"); await waitForReview(page);
    await click("Capture review acceptance"); await click("Finish review acceptance"); await waitForReview(page);
    await page.evaluate(() => {
        const f = window.hostFixture, s = f.snapshot();
        f.editSource(s.source.revision, [{ from: 10000, to: 10001, insert: "CHANGED" }]);
    }); await waitForReview(page);
    await click("Next change");
    await page.getByRole("textbox", { name: "Comparison baseline source", exact: true }).press("Shift+ArrowRight");
    const input = page.getByRole("textbox", { name: "Comparison working source", exact: true });
    await input.press("Control+End"); await input.press("Shift+Home"); await waitForReview(page);
    await page.locator(".st-comparison-panes .st-viewport").evaluateAll(nodes => nodes.forEach((node, i) => {
        node.scrollTop = i ? 2600 : 1800; node.scrollLeft = i ? 350 : 250;
    }));
    await page.waitForFunction(() => { const c = window.hostFixture.snapshot().bindings.comparison!;
        return c.workingViewport.scrollTop === 2600 && c.referenceViewport?.scrollTop === 1800; }); await waitForReview(page);
    const before = (await page.evaluate(() => window.hostFixture.snapshot())).bindings.comparison!;
    expect(before.selection.anchor).toBeGreaterThan(before.selection.head);
    expect(before.referenceViewport!.selection!.anchor).toBeLessThan(before.referenceViewport!.selection!.head);
    await click("Close source review");
    await page.evaluate(() => { const f = window.hostFixture; f.unmount(); f.editSource(f.snapshot().source.revision, [{ from: 0, to: 0, insert: "prefix" }]); f.mount(); });
    await click("Open source review"); await waitForReview(page);
    const after = (await page.evaluate(() => window.hostFixture.snapshot())).bindings.comparison!;
    expect(after.viewId).toBe(before.viewId);
    expect(after.selection).toEqual({ ...before.selection, anchor: before.selection.anchor + 6, head: before.selection.head + 6 });
    expect(after.workingViewport.scrollTop).toBeCloseTo(before.workingViewport.scrollTop, 3);
    expect(after.workingViewport.scrollLeft).toBeCloseTo(before.workingViewport.scrollLeft, 3);
    expect(after.referenceViewport!.selection).toEqual(before.referenceViewport!.selection);
    expect(after.referenceViewport!.scrollTop).toBeCloseTo(before.referenceViewport!.scrollTop, 3);
    expect(after.referenceViewport!.scrollLeft).toBeCloseTo(before.referenceViewport!.scrollLeft, 3);
    await page.evaluate(() => { const f = window.hostFixture; f.unmount(); f.editSource(f.snapshot().source.revision, [{ from: 0, to: 0, insert: "++" }]); f.mount(); });
    await waitForReview(page);
    const remounted = (await page.evaluate(() => window.hostFixture.snapshot())).bindings.comparison!;
    expect(remounted.viewId).toBe(before.viewId);
    expect(remounted.selection).toEqual({ ...before.selection, anchor: before.selection.anchor + 8, head: before.selection.head + 8 });
    expect(remounted.referenceViewport!.selection).toEqual(before.referenceViewport!.selection);
    expect(remounted.referenceViewport!.scrollTop).toBeCloseTo(before.referenceViewport!.scrollTop, 3);
    expect(await input.evaluate(node => node === document.activeElement)).toBe(false);
    // Select an unchanged character after both edits. Acceptance maps it onto the new saved copy.
    const reference = page.getByRole("textbox", { name: "Comparison baseline source", exact: true });
    await reference.press("Control+End"); await reference.press("Shift+ArrowLeft"); await waitForReview(page);
    const retained = (await page.evaluate(() => window.hostFixture.snapshot())).bindings.comparison!;
    await click("Capture review acceptance"); await click("Finish review acceptance"); await waitForReview(page);
    const replaced = (await page.evaluate(() => window.hostFixture.snapshot())).bindings.comparison!;
    expect(replaced.viewId).toBe(before.viewId); expect(replaced.selection).toEqual(remounted.selection);
    const shift = replaced.baseline!.length - retained.baseline!.length, selection = retained.referenceViewport!.selection!;
    expect(replaced.referenceViewport!.selection).toEqual({ ...selection, anchor: selection.anchor + shift, head: selection.head + shift });
    expect(replaced.referenceViewport!.scrollTop).toBeCloseTo(retained.referenceViewport!.scrollTop, 3);
    expect(replaced.referenceViewport!.scrollLeft).toBeCloseTo(retained.referenceViewport!.scrollLeft, 3);
    await page.evaluate(() => window.hostFixture.dispose());
});


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
