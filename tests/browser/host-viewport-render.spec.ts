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

for (const host of ["plain", "react"]) test(`${host} bounded long-context reveal keeps the caret visible through clicking, typing and remount`, async ({ page }) => {
    page.on("pageerror", error => { throw error; });
    await page.goto(`/hosts/${host}/?editor=candidate`);
    await page.getByRole("button", { name: "Open source review", exact: true }).click(); await ready(page);
    const input = page.getByRole("textbox", { name: "Primary source", exact: true });
    // Match the reproduced editing session: focus precedes programmatic range setup.
    await input.focus();
    const visible = (target = input) => target.evaluate(node => {
        const root = node.closest<HTMLElement>(".st-editing-candidate")!, caret = root.querySelector<HTMLElement>(".st-input-caret")!;
        const r = root.getBoundingClientRect(), c = caret.getBoundingClientRect();
        return !caret.hidden && c.left >= r.left && c.left < r.left + root.clientWidth && c.top >= r.top && c.top < r.top + root.clientHeight;
    });
    for (const original of ["x".repeat(4096), "\t".repeat(4096), "\t中e\u0301".repeat(1024)]) {
        await input.focus();
        await page.evaluate(text => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]);
            f.selectSource("primary", f.snapshot().source.revision, { anchor: 2047, head: 2047 }); }, original);
        await input.press("ArrowRight"); await ready(page); await expect.poll(visible).toBe(true);
        expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selection).toMatchObject({ anchor: 2048, head: 2048 });
        await page.getByRole("region", { name: "Primary source", exact: true }).scrollIntoViewIfNeeded(); await ready(page);
        const point = await input.evaluate(node => { const r = node.closest(".st-editing-candidate")!.querySelector(".st-input-caret")!.getBoundingClientRect();
            return { x: r.left - .25, y: r.top + r.height / 2 }; });
        expect(point.y).toBeGreaterThanOrEqual(0); expect(point.y).toBeLessThan(page.viewportSize()!.height);
        await page.mouse.click(point.x, point.y); await ready(page); await expect(input).toBeFocused();
        expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selection).toMatchObject({ anchor: 2048, head: 2048 });
        const beforeLayout = await snapshot(page), primary = beforeLayout.bindings.views.find(v => v.id === "primary")!;
        await input.evaluate(node => { const root = node.closest<HTMLElement>(".st-editing-candidate")!; root.style.width = "160px"; root.style.setProperty("--st-font-size", "20px"); });
        await expect.poll(async () => (await snapshot(page)).bindings.views.find(v => v.id === "primary")!.metrics!.viewport.width).toBe(160);
        await ready(page); await expect.poll(visible).toBe(true);
        const resized = await snapshot(page); expect(resized.source).toEqual(beforeLayout.source); expect(resized.history).toEqual(beforeLayout.history);
        expect(resized.bindings.views.map(v => v.selectionSet)).toEqual(beforeLayout.bindings.views.map(v => v.selectionSet));
        expect(resized.bindings.comparison!.selectionSet).toEqual(beforeLayout.bindings.comparison!.selectionSet);
        expect(resized.bindings.comparison!.baseline).toEqual(beforeLayout.bindings.comparison!.baseline);
        expect(resized.bindings.views.find(v => v.id === "secondary")!.metrics!.viewport.scrollLeft).toBe(beforeLayout.bindings.views.find(v => v.id === "secondary")!.metrics!.viewport.scrollLeft);
        await page.getByRole("region", { name: "Primary source", exact: true }).scrollIntoViewIfNeeded(); await ready(page);
        const resizedPoint = await input.evaluate(node => { const r = node.closest(".st-editing-candidate")!.querySelector(".st-input-caret")!.getBoundingClientRect(); return { x: r.left - .25, y: r.top + r.height / 2 }; });
        expect(resizedPoint.y).toBeGreaterThanOrEqual(0); expect(resizedPoint.y).toBeLessThan(page.viewportSize()!.height);
        await page.mouse.click(resizedPoint.x, resizedPoint.y); await ready(page); await expect(input).toBeFocused();
        expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selection.head).toBe(2048);
        const beforePendingLayout = await snapshot(page);
        await input.evaluate(node => {
            const root = node.closest<HTMLElement>(".st-editing-candidate")!;
            // The viewport queues its caret callback before this host layout change.
            root.addEventListener("sttropez-render", () => { root.style.width = "140px"; root.style.setProperty("--st-font-size", "24px"); }, { once: true });
            window.hostFixture.setSourceReadOnly(true);
        });
        await expect.poll(async () => (await snapshot(page)).bindings.views.find(v => v.id === "primary")!.metrics!.viewport.width).toBe(140);
        await ready(page); await expect.poll(visible).toBe(true); await expect(input).toBeFocused();
        await input.pressSequentially("Q"); await ready(page);
        const afterPendingLayout = await snapshot(page); expect(afterPendingLayout.source).toEqual(beforePendingLayout.source); expect(afterPendingLayout.history).toEqual(beforePendingLayout.history);
        expect(afterPendingLayout.bindings.views.map(v => v.selectionSet)).toEqual(beforePendingLayout.bindings.views.map(v => v.selectionSet));
        expect(await page.evaluate(() => window.hostFixture.range(2047, 2049))).toBe(original.slice(2047, 2049));
        await page.evaluate(() => window.hostFixture.setSourceReadOnly(false)); await ready(page);
        // A host control can own focus while an editor changes size; that editor must not pan.
        await page.getByRole("textbox", { name: "Configuration path", exact: true }).focus(); await ready(page);
        const inactiveLeft = (await snapshot(page)).bindings.views.find(v => v.id === "primary")!.metrics!.viewport.scrollLeft;
        await input.evaluate(node => { const root = node.closest<HTMLElement>(".st-editing-candidate")!; root.style.width = "180px"; root.style.setProperty("--st-font-size", "18px"); });
        await expect.poll(async () => (await snapshot(page)).bindings.views.find(v => v.id === "primary")!.metrics!.viewport.width).toBe(180); await ready(page);
        expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.metrics!.viewport.scrollLeft).toBe(inactiveLeft);
        await expect(page.getByRole("textbox", { name: "Configuration path", exact: true })).toBeFocused();
        await input.evaluate(node => (node as HTMLElement).focus({ preventScroll: true }));
        // A deliberately offscreen caret must not pull manual scrolling back during a later resize.
        await input.evaluate(node => { node.closest<HTMLElement>(".st-editing-candidate")!.scrollLeft = 0; });
        await expect.poll(async () => (await snapshot(page)).bindings.views.find(v => v.id === "primary")!.metrics!.viewport.scrollLeft).toBe(0); await ready(page);
        expect(await visible()).toBe(false);
        await input.evaluate(node => { const root = node.closest<HTMLElement>(".st-editing-candidate")!; root.style.width = "220px"; root.style.setProperty("--st-font-size", "16px"); });
        await expect.poll(async () => (await snapshot(page)).bindings.views.find(v => v.id === "primary")!.metrics!.viewport.width).toBe(220); await ready(page);
        expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.metrics!.viewport.scrollLeft).toBe(0); expect(await visible()).toBe(false);
        expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selectionSet).toEqual(primary.selectionSet);
        await input.evaluate(node => { const root = node.closest<HTMLElement>(".st-editing-candidate")!; root.style.width = ""; root.style.removeProperty("--st-font-size"); });
        await input.press("Control+End"); await ready(page); await expect.poll(visible).toBe(true);
        await input.pressSequentially("z"); await ready(page); await expect.poll(visible).toBe(true);
        expect(await page.evaluate(n => window.hostFixture.range(0, n), original.length + 1)).toBe(original + "z");
        await input.press("Control+z"); await ready(page); await expect.poll(visible).toBe(true);
        expect(await page.evaluate(n => window.hostFixture.range(0, n), original.length)).toBe(original);
        const before = await snapshot(page);
        await page.evaluate(() => window.hostFixture.unmount()); await page.evaluate(() => window.hostFixture.mount());
        await ready(page); await input.focus(); await expect.poll(visible).toBe(true);
        const after = await snapshot(page); expect(after.history).toEqual(before.history);
        expect(after.bindings.views.map(v => v.selection)).toEqual(before.bindings.views.map(v => v.selection));
        expect(after.bindings.views.find(v => v.id === "primary")!.metrics!.viewport.scrollLeft).toBe(before.bindings.views.find(v => v.id === "primary")!.metrics!.viewport.scrollLeft);
        expect(after.source.exports).toBe(0);
        expect(after.bindings.views.every(v => v.metrics!.inputUnits <= 2600 && v.metrics!.viewport.rows < 100 && v.metrics!.viewport.readUnits < 20000)).toBe(true);
        await page.evaluate(() => window.hostFixture.unmount());
        await page.evaluate(() => { const f = window.hostFixture;
            f.editSource(f.snapshot().source.revision, [{ from: 0, to: 0, insert: "q" }]);
            f.editSource(f.snapshot().source.revision, [{ from: 0, to: 1, insert: "r" }]); });
        const detachedHistory = (await snapshot(page)).history;
        await page.evaluate(() => window.hostFixture.mount()); await ready(page);
        await input.evaluate(node => node.focus({ preventScroll: true })); await expect.poll(() => visible()).toBe(true);
        expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selection).toMatchObject({ anchor: 4097, head: 4097 });
        expect((await snapshot(page)).history).toEqual(detachedHistory);
        await input.pressSequentially("z"); await ready(page); await input.press("Control+z"); await ready(page);
        expect(await page.evaluate(n => window.hostFixture.range(0, n), original.length + 1)).toBe("r" + original);
        const comparison = page.getByRole("textbox", { name: "Comparison working source", exact: true });
        await comparison.evaluate(node => node.focus({ preventScroll: true }));
        await comparison.press("Control+End"); await ready(page); await expect.poll(() => visible(comparison)).toBe(true);
        await page.evaluate(() => window.hostFixture.unmount());
        await page.evaluate(() => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: 0, insert: "s" }]); });
        const comparisonHistory = (await snapshot(page)).history;
        await page.evaluate(() => window.hostFixture.mount()); await ready(page);
        await comparison.evaluate(node => node.focus({ preventScroll: true })); await expect.poll(() => visible(comparison)).toBe(true);
        expect((await snapshot(page)).bindings.comparison!.selection).toMatchObject({ anchor: 4098, head: 4098 });
        expect((await snapshot(page)).history).toEqual(comparisonHistory);
        await comparison.pressSequentially("z"); await ready(page); await comparison.press("Control+z"); await ready(page);
        expect(await page.evaluate(n => window.hostFixture.range(0, n), original.length + 2)).toBe("sr" + original);
        expect((await snapshot(page)).source.exports).toBe(0);
    }
    await page.evaluate(() => window.hostFixture.dispose()); const stopped = await snapshot(page);
    expect(stopped.diagnostics).toMatchObject({ views: 0, subscriptions: 0, leases: 0 }); expect(stopped.hostSubscriptions).toBe(0);
});
