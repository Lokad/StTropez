import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
async function ready(page: Page): Promise<void> {
    await expect.poll(() => page.evaluate(() => {
        const s = window.hostFixture.snapshot(), c = s.bindings.comparison;
        return s.bindings.activeViews === 2 && s.bindings.views.every(v => !v.metrics || !v.metrics.pendingCaret && !v.metrics.viewport.pending
            && v.metrics.viewport.revision === s.source.revision && JSON.stringify(v.metrics.viewport.selectionSet) === JSON.stringify(v.selectionSet))
            && c?.status === "ready" && c.workingRevision === s.source.revision && !c.input.pendingCaret && !c.workingViewport.pending && !c.referenceViewport?.pending
            && JSON.stringify(c.workingViewport.selectionSet) === JSON.stringify(c.selectionSet);
    })).toBe(true);
}

for (const host of ["plain", "react"]) for (const editor of ["native", "candidate"]) test(`${host} ${editor} full view selections survive detached edits and comparison remount`, async ({ page }) => {
    page.on("pageerror", error => { throw error; });
    await page.goto(`/hosts/${host}/?editor=${editor}`);
    const line = "const sample = 123;\r\n";
    await page.evaluate(text => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]); }, line.repeat(100000));
    await page.getByRole("button", { name: "Open source review", exact: true }).click(); await ready(page);
    const input = page.getByRole("textbox", { name: "Primary source", exact: true }); await input.evaluate(node => node.focus({ preventScroll: true }));
    await page.evaluate(size => {
        const f = window.hostFixture, revision = f.snapshot().source.revision;
        const ranges = [{ anchor: 1, head: 4 }, { anchor: 9, head: 6 }, { anchor: size + 4, head: size + 4 }, { anchor: size * 2 + 8, head: size * 2 + 8 },
            ...Array.from({ length: 1024 }, (_, index) => ({ anchor: size * (50000 + index), head: size * (50000 + index) }))];
        f.selectSourceSet("primary", revision, ranges, 1);
        f.selectSourceSet("secondary", revision, [{ anchor: 12, head: 12 }, { anchor: size + 9, head: size + 6 }], 1);
        f.selectSourceSet("comparison", revision, [{ anchor: 0, head: 5 }, { anchor: size * 3 + 2, head: size * 3 + 2 }], 1);
    }, line.length); await ready(page);
    const before = await snapshot(page), primary = before.bindings.views.find(v => v.id === "primary")!;
    expect(primary.selectionSet.ranges).toHaveLength(1028); expect(primary.selectionSet.primary).toBe(1);
    const region = page.getByRole("region", { name: "Primary source", exact: true });
    if (editor === "candidate") {
        expect(await region.locator('.st-viewport-row[data-line="0"] .st-viewport-selected').allTextContents()).toEqual([line.slice(1, 4), line.slice(6, 9)]);
        await expect(region.locator(".st-input-secondary-caret")).toHaveCount(2);
        expect(primary.metrics!.viewport.rows).toBeLessThan(100); expect(primary.metrics!.viewport.readUnits).toBeLessThan(20000);
    }
    await page.evaluate(() => window.hostFixture.unmount());
    await page.evaluate(() => { const f = window.hostFixture;
        f.editSource(f.snapshot().source.revision, [{ from: 0, to: 0, insert: "q\n" }]);
        f.editSource(f.snapshot().source.revision, [{ from: 0, to: 0, insert: "r" }]); });
    const detached = await snapshot(page); await page.evaluate(() => window.hostFixture.mount()); await ready(page);
    await input.evaluate(node => node.focus({ preventScroll: true })); await ready(page);
    const after = await snapshot(page);
    const shifted = (set: typeof primary.selectionSet) => ({ ...set, ranges: set.ranges.map(range => ({ ...range, anchor: range.anchor + 3, head: range.head + 3 })) });
    for (const old of before.bindings.views) {
        const current = after.bindings.views.find(v => v.id === old.id)!;
        expect(current.viewId).toBe(old.viewId); expect(current.selectionSet).toEqual(shifted(old.selectionSet));
        expect(current.selection).toEqual(current.selectionSet.ranges[current.selectionSet.primary]);
    }
    expect(after.bindings.comparison!.viewId).toBe(before.bindings.comparison!.viewId);
    expect(after.bindings.comparison!.selectionSet).toEqual(shifted(before.bindings.comparison!.selectionSet));
    expect(after.bindings.comparison!.baseline).toEqual(before.bindings.comparison!.baseline);
    expect(after.history).toEqual(detached.history);
    if (editor === "candidate") {
        await expect(region.locator(".st-input-secondary-caret")).toHaveCount(2);
        expect(after.source.exports).toBe(0);
        await page.getByRole("textbox", { name: "Secondary source", exact: true }).evaluate(node => node.focus({ preventScroll: true }));
        await ready(page); await expect(region.locator(".st-input-secondary-caret")).toHaveCount(0);
        await expect(page.getByRole("region", { name: "Secondary source", exact: true }).locator(".st-input-secondary-caret")).toHaveCount(1);
    }
    await page.evaluate(() => window.hostFixture.dispose()); const stopped = await snapshot(page);
    expect(stopped.diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); expect(stopped.hostSubscriptions).toBe(0);
    expect(await page.locator(".st-input-secondary-caret").count()).toBe(0);
});
