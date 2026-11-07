import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
async function ready(page: Page): Promise<void> {
    await expect.poll(() => page.evaluate(() => {
        const s = window.hostFixture.snapshot(), c = s.bindings.comparison;
        return s.bindings.activeViews === 2 && s.bindings.views.every(v => v.metrics && !v.metrics.pendingCaret && !v.metrics.pendingWord && !v.metrics.pendingGrapheme
            && !v.metrics.viewport.pending && v.metrics.viewport.revision === s.source.revision)
            && c?.status === "ready" && c.workingRevision === s.source.revision && !c.input.pendingCaret && !c.workingViewport.pending && !c.referenceViewport?.pending;
    })).toBe(true);
}
for (const host of ["plain", "react"]) for (const large of [false, true]) test(`${host} ${large ? "100k" : "normal"} unchanged decorated rows survive typing and selection while current geometry and changed marks update`, async ({ page }) => {
    page.on("pageerror", error => { throw error; }); page.on("console", message => { if (message.type() === "error") throw new Error(message.text()); });
    await page.goto(`/hosts/${host}/?editor=candidate`); const line = "const sample = 123; // TODO", original = Array(large ? 100000 : 60).fill(line).join("\r\n");
    await page.evaluate(value => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: value }]); }, original);
    await page.getByRole("button", { name: "Open source review", exact: true }).click(); await ready(page);
    const input = page.getByRole("textbox", { name: "Primary source", exact: true }); await input.press("Control+Home"); await ready(page);
    const rows = ["Primary source", "Secondary source", "Comparison working source"].map(name => page.getByRole("region", { name, exact: true }).locator('.st-viewport-row[data-line="4"]'));
    const spans = await Promise.all(rows.map(row => row.locator("span").first().elementHandle())); expect(spans.every(Boolean)).toBe(true);
    for (const span of spans) expect(await span!.textContent()).toBe("const");
    const baseline = page.getByRole("region", { name: "Comparison baseline source", exact: true }).locator('.st-viewport-row[data-line="0"] span').first(), baselineSpan = await baseline.elementHandle(); expect(baselineSpan).not.toBeNull();
    const comparisonClass = await spans[2]!.getAttribute("class"), baselineClass = await baselineSpan!.getAttribute("class"), working = page.getByRole("textbox", { name: "Comparison working source", exact: true });
    await working.press("Control+Home"); await working.press("ArrowRight"); await ready(page);
    expect(await spans[2]!.evaluate(node => node.isConnected), "An unchanged comparison token should survive its own selection update.").toBe(true);
    expect(await baselineSpan!.evaluate(node => node.isConnected), "Unchanged baseline marks should survive a selection-only update.").toBe(true);
    await input.press("Control+Home"); await ready(page);
    await input.press("ArrowRight"); await ready(page);
    for (const span of spans) expect(await span!.evaluate(node => node.isConnected), "An unaffected token node should survive a selection-only update.").toBe(true);
    await input.pressSequentially("q"); await ready(page); const expected = original.slice(0, 1) + "q" + original.slice(1), edited = await snapshot(page);
    expect(await page.evaluate(value => { const f = window.hostFixture; return f.snapshot().source.length === value.length && f.range(0, value.length) === value; }, expected)).toBe(true);
    for (const span of [spans[0], spans[1]]) expect(await span!.evaluate(node => node.isConnected), "Unchanged source tokens should survive a working edit.").toBe(true);
    // Comparison marks expire until the new document revision is aligned.
    await expect(rows[2]!.locator("span").first()).toHaveAttribute("class", comparisonClass!);
    await expect(baseline).toHaveAttribute("class", baselineClass!); await expect(baseline).toHaveText("start");
    for (const row of rows) await expect(row).toHaveAttribute("data-from", String(4 * (line.length + 2) + 1));
    expect(edited.source.exports).toBe(0); expect(edited.bindings.views.every(v => v.metrics!.inputUnits <= 2600 && v.metrics!.viewport.rows < 100 && v.metrics!.viewport.readUnits < 20000)).toBe(true);
    await input.press("Control+z"); await ready(page); for (const row of rows) await expect(row).toHaveAttribute("data-from", String(4 * (line.length + 2)));
    await input.press("Control+Shift+z"); await ready(page);
    const primaryRow = rows[0]!;
    expect(await primaryRow.evaluate(row => { const f = window.hostFixture, from = Number((row as HTMLElement).dataset.from); return f.selectSource("primary", f.snapshot().source.revision, { anchor: from + 2, head: from + 5 }); })).toBe(true);
    await ready(page); await expect(primaryRow.locator(".st-viewport-selected")).toHaveText("nst");
    expect(await primaryRow.evaluate(row => { const f = window.hostFixture, from = Number((row as HTMLElement).dataset.from); return f.selectSource("primary", f.snapshot().source.revision, { anchor: from + 2, head: from + 2 }); })).toBe(true);
    await ready(page); await expect(primaryRow.locator(".st-viewport-selected")).toHaveCount(0); await expect(primaryRow).toHaveText(line);
    const hit = await primaryRow.evaluate(row => {
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT), nodes: Text[] = []; for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
        const locate = (offset: number) => { for (const node of nodes) { if (offset <= node.length) return { node, offset }; offset -= node.length; } throw new Error("Missing visible offset."); };
        const a = locate(8), b = locate(9), range = document.createRange(); range.setStart(a.node, a.offset); range.setEnd(b.node, b.offset); const r = range.getBoundingClientRect();
        return { x: r.left + r.width * .25, y: r.top + r.height * .5, offset: Number((row as HTMLElement).dataset.from) + 8 };
    });
    await page.mouse.click(hit.x, hit.y); await ready(page); expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selection).toMatchObject({ anchor: hit.offset, head: hit.offset });
    expect((await snapshot(page)).source.exports).toBe(0); await page.evaluate(() => window.hostFixture.dispose()); const stopped = await snapshot(page);
    expect(stopped.diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); expect(stopped.hostSubscriptions).toBe(0);
});
