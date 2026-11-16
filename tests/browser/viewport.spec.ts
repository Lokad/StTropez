import { ready, test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";

async function checkRows(page: Page): Promise<void> {
    expect(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("#primary .st-viewport-row")].every(row => {
        const from = Number(row.dataset.from), to = Number(row.dataset.to);
        return row.textContent === window.viewportFixture.range(from, to).replaceAll("\r", "␍");
    }))).toBe(true);
}
test.beforeEach(async ({ page }) => {

    await page.goto("/viewport/"); await ready(page);
});

test("reloading shorter and empty text resets both live viewport row indexes", async ({ page }) => {
    for (const text of ["first\nlast", "", "a\nb\nc"]) {
        expect(await page.evaluate(value => window.viewportFixture.reload(value), text)).toBe(true);
        await ready(page);
        for (const pane of ["primary", "secondary"]) await expect(page.locator(`#${pane} .st-viewport-row`)).toHaveText(text.split("\n"));
    }
});

test("browser zoom wheels are not cancelled or interpreted as editor scrolling", async ({ page }) => {
    await page.evaluate(() => window.viewportFixture.scroll("primary", 2000, 0)); await ready(page);
    const root = page.locator("#primary .st-viewport"), before = await page.evaluate(() => window.viewportFixture.snapshot().primary.scrollTop);
    expect(await root.evaluate(node => ["ctrlKey", "metaKey"].map(modifier => {
        const event = new WheelEvent("wheel", { [modifier]: true, deltaY: 120, bubbles: true, cancelable: true });
        let prevented = false;
        // Observe the editor handler, then suppress synthetic native scrolling (notably WebKit).
        node.addEventListener("wheel", next => { prevented = next.defaultPrevented; next.preventDefault(); }, { once: true });
        node.dispatchEvent(event); return prevented;
    }))).toEqual([false, false]);
    await ready(page); expect(await page.evaluate(() => window.viewportFixture.snapshot().primary.scrollTop)).toBe(before);
});

test("100k lines render bounded indexed ranges and reach the final line without whole-text export", async ({ page }) => {
    const initial = await page.evaluate(() => window.viewportFixture.snapshot());
    expect(initial.document).toMatchObject({ length: 2_400_000, lines: 100_001, longest: 23, exports: 0 });
    expect(initial.primary.rows).toBeLessThan(40); expect(initial.primary.readUnits).toBeLessThan(8_000);
    await page.evaluate(() => window.viewportFixture.scroll("primary", Number.MAX_SAFE_INTEGER, 0)); await ready(page);
    const end = await page.evaluate(() => window.viewportFixture.snapshot());
    expect(end.primary.lastLine).toBe(100_001); expect(end.primary.firstLine).toBeGreaterThan(99_900);
    expect(end.document!.exports).toBe(0); expect(end.secondary.firstLine).toBe(0); await checkRows(page);
    const geometry = await page.locator('#primary [data-line="100000"]').evaluate(node => ({ row: node.getBoundingClientRect().top,
        top: node.closest(".st-viewport")!.getBoundingClientRect().top, height: node.closest(".st-viewport")!.clientHeight }));
    expect(geometry.row - geometry.top).toBeGreaterThan(0); expect(geometry.row - geometry.top).toBeLessThan(geometry.height);
});

test("a huge line uses bounded horizontal text windows and scaled native scrollbar coordinates", async ({ page }) => {
    await page.evaluate(() => window.viewportFixture.load("single-line")); await ready(page);
    await page.evaluate(() => window.viewportFixture.reveal("primary", 2_400_000)); await ready(page);
    const end = await page.evaluate(() => window.viewportFixture.snapshot());
    expect(end.primary.horizontalExtent).toBeGreaterThan(4_000_000); expect(end.primary.physicalWidth).toBe(4_000_000);
    expect(end.primary.textUnits).toBeLessThan(400); expect(end.primary.readUnits).toBeLessThan(410);
    expect(end.document!.exports).toBe(0);
    expect(Number(await page.locator("#primary .st-viewport-row").getAttribute("data-to"))).toBe(2_400_000);
    await page.locator("#primary .st-viewport").evaluate(node => { node.scrollLeft = 0; });
    await expect.poll(() => page.evaluate(() => window.viewportFixture.snapshot().primary.scrollLeft)).toBe(0); await ready(page);
    expect(Number(await page.locator("#primary .st-viewport-row").getAttribute("data-from"))).toBe(0);
    await page.locator("#primary .st-viewport").hover(); await page.mouse.wheel(100, 0);
    await expect.poll(() => page.evaluate(() => window.viewportFixture.snapshot().primary.scrollLeft)).toBe(100); await ready(page);
    await page.locator("#primary .st-viewport").evaluate(node => { node.scrollLeft = node.scrollWidth; });
    await expect.poll(() => page.evaluate(() => window.viewportFixture.snapshot().primary.scrollLeft)).toBeGreaterThan(10_000_000); await ready(page); await checkRows(page);
});

test("multiple edits before a frame map the scroll anchor and shared undo restores it", async ({ page }) => {
    await page.evaluate(() => window.viewportFixture.reveal("primary", 1_200_000)); await ready(page);
    const before = await page.evaluate(() => window.viewportFixture.snapshot());
    await page.evaluate(() => {
        for (const insert of ["first\n", "second\n"]) window.viewportFixture.edit(window.viewportFixture.snapshot().document!.revision, [{ from: 0, to: 0, insert }]);
    }); await ready(page);
    const after = await page.evaluate(() => window.viewportFixture.snapshot());
    expect(after.primary.scrollTop).toBeCloseTo(before.primary.scrollTop + before.primary.lineHeight * 2, 3);
    expect(after.document!.exports).toBe(0); expect(after.secondary.scrollTop).toBe(0);
    await page.getByRole("button", { name: "Undo", exact: true }).click(); await ready(page);
    await page.getByRole("button", { name: "Undo", exact: true }).click(); await ready(page);
    expect((await page.evaluate(() => window.viewportFixture.snapshot())).primary.scrollTop).toBeCloseTo(before.primary.scrollTop, 3); await checkRows(page);
});

test("full selection sets paint bounded ranges and round-trip while legacy states restore one range", async ({ page }) => {
    const ranges = [{ anchor: 1, head: 4 }, { anchor: 10, head: 8, anchorAffinity: "before" as const, headAffinity: "after" as const }, { anchor: 1_200_000, head: 1_200_000 }];
    await page.evaluate(value => window.viewportFixture.select("primary", value, 1), ranges); await ready(page);
    const captured = await page.evaluate(() => window.viewportFixture.capture("primary"));
    expect(captured.selectionSet?.primary).toBe(1); expect(captured.selectionSet?.ranges).toHaveLength(3);
    expect(captured).toMatchObject({ anchor: 10, head: 8, anchorAffinity: "before", headAffinity: "after" });
    const first = page.locator('#primary .st-viewport-row[data-line="0"]');
    expect(await first.locator(".st-viewport-selected").allTextContents()).toEqual(await page.evaluate(() => [window.viewportFixture.range(1, 4), window.viewportFixture.range(8, 10)]));
    expect(await page.evaluate(() => { const f = window.viewportFixture, state = f.capture("primary"), s = f.snapshot().primary;
        return Object.isFrozen(state) && Object.isFrozen(state.selectionSet) && Object.isFrozen(state.selectionSet!.ranges)
            && s.selectionSet === state.selectionSet && s.selection === s.selectionSet!.ranges[s.selectionSet!.primary]; })).toBe(true);
    await page.evaluate(state => { const f = window.viewportFixture; f.select("primary", [{ anchor: 12, head: 12 }]); f.restore("primary", state); }, captured); await ready(page);
    expect((await page.evaluate(() => window.viewportFixture.snapshot())).primary.selectionSet).toEqual(captured.selectionSet);
    expect(await page.evaluate(state => { const f = window.viewportFixture; f.restore("secondary", { ...state, anchor: 0, head: 0 }); return f.settled; }, captured)).toBe(false);
    await ready(page);
    expect(await page.evaluate(() => window.viewportFixture.snapshot().secondary.selectionSet)).toEqual(captured.selectionSet);
    expect((await page.evaluate(() => window.viewportFixture.snapshot())).secondary.selection).toEqual(captured.selectionSet!.ranges[1]);
    const invalid = await page.evaluate(state => { const f = window.viewportFixture, before = f.capture("primary");
        try { f.restore("primary", { ...state, selectionSet: { ranges: [{ anchor: -1, head: 0 }], primary: 0 } }); return false; }
        catch { return JSON.stringify(f.capture("primary")) === JSON.stringify(before); } }, captured);
    expect(invalid).toBe(true);
    const invalidScroll = await page.evaluate(() => {
        const f = window.viewportFixture, before = f.capture("primary"), other = f.capture("secondary");
        return [NaN, Infinity, -Infinity].flatMap(value => ["scrollTop", "scrollLeft"].map(axis => {
            try { f.restore("primary", { ...other, [axis]: value, selectionSet: { ranges: [{ anchor: 0, head: 0 }], primary: 0 },
                folding: { ...other.folding!, regions: [{ id: "restore-fold", from: 0, to: 500, collapsed: true }] } }); return false; }
            catch (error) { return error instanceof RangeError && error.message === "Invalid scroll position." && JSON.stringify(f.capture("primary")) === JSON.stringify(before); }
        }));
    });
    expect(invalidScroll).toEqual(Array(6).fill(true));
    await page.evaluate(state => { const { selectionSet: _, ...legacy } = state;
        window.viewportFixture.restore("primary", { ...legacy, anchor: 12, head: 12 }); }, captured); await ready(page);
    const after = await page.evaluate(() => window.viewportFixture.snapshot());
    expect(after.primary.selectionSet).toMatchObject({ primary: 0, ranges: [{ anchor: 12, head: 12 }] });
    expect(after.secondary.selectionSet).toEqual(captured.selectionSet); expect(after.document!.exports).toBe(0);
    expect(after.primary.rows).toBeLessThan(40); expect(after.primary.readUnits).toBeLessThan(8000);
});

test("resize, font metrics and tall rows keep scaled vertical scrolling reachable", async ({ page }) => {
    await page.evaluate(() => window.viewportFixture.resize(480, 240, "100px"));
    await expect.poll(() => page.evaluate(() => window.viewportFixture.snapshot().primary.lineHeight)).toBe(100); await ready(page);
    await page.evaluate(() => window.viewportFixture.scroll("primary", Number.MAX_SAFE_INTEGER, 0)); await ready(page);
    const end = await page.evaluate(() => window.viewportFixture.snapshot());
    expect(end.primary.physicalHeight).toBe(4_000_000); expect(end.primary.lastLine).toBe(100_001); expect(end.primary.rows).toBeLessThan(12);
    await page.locator("#primary .st-viewport").press("PageUp");
    await expect.poll(() => page.evaluate(() => window.viewportFixture.snapshot().primary.scrollTop)).toBeCloseTo(end.primary.scrollTop - end.primary.height * .9, 3);
    await page.evaluate(() => window.viewportFixture.scroll("primary", Number.MAX_SAFE_INTEGER, 0)); await ready(page);
    const oldWidth = end.primary.columnWidth;
    await page.locator("#primary .st-viewport").evaluate(node => (node as HTMLElement).style.setProperty("--st-font-size", "20px"));
    await expect.poll(() => page.evaluate(() => window.viewportFixture.snapshot().primary.columnWidth)).toBeGreaterThan(oldWidth * 1.3); await ready(page);
    expect((await page.evaluate(() => window.viewportFixture.snapshot())).primary.lastLine).toBe(100_001); await checkRows(page);
});

test("Unicode/CRLF rows preserve bounded content and stale tab generations disable only their own view", async ({ page }) => {
    await page.evaluate(() => window.viewportFixture.load("unicode")); await ready(page); await checkRows(page);
    expect(await page.locator("#primary .st-viewport-row").first().textContent()).toContain("👩‍💻");
    expect((await page.evaluate(() => window.viewportFixture.snapshot())).document!.exports).toBe(0);
    await page.evaluate(() => window.viewportFixture.replacePrimary());
    await expect(page.locator("#primary .st-viewport")).toHaveAttribute("aria-disabled", "true");
    expect(await page.locator("#primary .st-viewport-row").count()).toBe(0);
    await page.evaluate(() => window.viewportFixture.edit(window.viewportFixture.snapshot().document!.revision, [{ from: 0, to: 0, insert: "later " }]));
    await expect.poll(() => page.evaluate(() => window.viewportFixture.snapshot().secondary.revision)).toBe(2);
    expect((await page.evaluate(() => window.viewportFixture.snapshot())).primary.revision).toBeNull();
});

test("unrelated 20Hz traffic and persisted transitions retain views until final teardown", async ({ page }, info) => {
    info.annotations.push({ type: "page-transition-policy", description: "Synthetic persisted/final events; native back/forward-cache qualification remains external." });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); await ready(page);
    const before = await page.evaluate(() => window.viewportFixture.snapshot()); await page.evaluate(() => window.viewportFixture.background(true));
    await expect.poll(() => page.evaluate(() => window.viewportFixture.snapshot().ticks)).toBeGreaterThan(3);
    const after = await page.evaluate(() => window.viewportFixture.snapshot()); expect(after.primary.renders).toBe(before.primary.renders);
    expect(after.secondary.renders).toBe(before.secondary.renders);
    await page.evaluate(() => window.viewportFixture.scroll("primary", 200, 0)); await ready(page);
    const retained = await page.evaluate(() => window.viewportFixture.snapshot());
    for (let index = 0; index < 2; index++) {
        await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })); window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); });
        const current = await page.evaluate(() => window.viewportFixture.snapshot());
        expect(current.disposed).toBe(false); expect(current.document).toEqual(retained.document);
        expect(current.primary.scrollTop).toBe(retained.primary.scrollTop); expect(current.primary.revision).toBe(retained.primary.revision);
    }
    await page.locator("#prepend").click(); await ready(page); expect(await page.evaluate(() => window.viewportFixture.range(0, 15))).toBe("new first line\n");
    await page.evaluate(() => { window.viewportFixture.scroll("primary", 200, 0); window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false })); });
    const stopped = await page.evaluate(() => window.viewportFixture.snapshot());
    expect(stopped.diagnostics).toMatchObject({ resources: 0, documents: 0, views: 0, subscriptions: 0, leases: 0 });
    expect(stopped.primary).toMatchObject({ disposed: true, pending: false, rows: 0, textUnits: 0 });
    expect(await page.locator(".st-viewport").count()).toBe(0);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false })));
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
    expect(await page.evaluate(() => window.viewportFixture.snapshot())).toEqual(stopped);
});
