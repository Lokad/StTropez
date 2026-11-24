import { ready, test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";

const state = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const selection = (s: Awaited<ReturnType<typeof state>>, id = "primary") => s.bindings.views.find(v => v.id === id)!.selection;
const root = (page: Page) => page.locator('.st-editor:has(> textarea[aria-label="Primary source"])');
async function waitForReview(page: Page): Promise<void> {
    await ready(page);
    await page.waitForFunction(() => { const s = window.hostFixture.snapshot(); return window.hostFixture.settled && (s.bindings.activeViews === 2 && s.bindings.comparison !== null && [...document.querySelectorAll(".st-comparison h3")].some(h => h.textContent === `Baseline · ${s.bindings.comparison?.baseline?.version}`)); });
}
async function point(page: Page, offset: number): Promise<{ x: number; y: number }> {
    return root(page).evaluate((element, position) => {
        const row = element.querySelector(".st-viewport-row"); if (!row) throw new Error("Missing visible source row.");
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT), nodes: Text[] = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
        const locate = (value: number) => { for (const node of nodes) { if (value <= node.length) return { node, offset: value }; value -= node.length; } throw new Error("Missing row offset."); };
        const a = locate(position), b = locate(position + 1), range = document.createRange(); range.setStart(a.node, a.offset); range.setEnd(b.node, b.offset);
        const rectangle = range.getBoundingClientRect(); return { x: rectangle.left + rectangle.width * .25, y: rectangle.top + rectangle.height * .5 };
    }, offset);
}
async function begin(page: Page, offset: number): Promise<number> {
    const element = root(page); await element.scrollIntoViewIfNeeded();
    const got = Number(await element.getAttribute("data-pointer-got")), p = await point(page, offset);
    expect(p.y).toBeGreaterThanOrEqual(0);
    await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(p.x + .5, p.y);
    await expect.poll(async () => Number(await element.getAttribute("data-pointer-got"))).toBeGreaterThan(got);
    const pointer = Number(await element.getAttribute("data-pointer-id")); expect(await element.evaluate((node, id) => node.hasPointerCapture(id), pointer)).toBe(true); return pointer;
}
async function move(page: Page, offset: number): Promise<void> { const p = await point(page, offset); await page.mouse.move(p.x, p.y); }
async function setup(page: Page): Promise<string> {
    const original = Array(60).fill("const sample = '😀 é';").join("\r\n");
    await page.evaluate(value => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: value }]); f.selectSource("secondary", f.snapshot().source.revision, { anchor: 4, head: 1 }); }, original);
    await page.getByRole("button", { name: "Open source review", exact: true }).click(); await waitForReview(page);
    const working = page.getByRole("textbox", { name: "Comparison working source", exact: true }); await working.press("Control+Home");
    for (let i = 0; i < 10; i++) await working.press("ArrowRight"); for (let i = 0; i < 2; i++) await working.press("Shift+ArrowRight"); await waitForReview(page);
    await root(page).evaluate(element => {
        element.dataset.pointerGot = "0"; element.dataset.pointerLost = "0";
        element.addEventListener("pointerdown", event => { element.dataset.pointerId = String((event as PointerEvent).pointerId); });
        element.addEventListener("gotpointercapture", () => { element.dataset.pointerGot = String(Number(element.dataset.pointerGot) + 1); });
        element.addEventListener("lostpointercapture", () => { element.dataset.pointerLost = String(Number(element.dataset.pointerLost) + 1); });
    }); return original;
}
async function exact(page: Page, expected: string): Promise<void> {
    expect(await page.evaluate(value => { const f = window.hostFixture; return f.snapshot().source.length === value.length && f.range(0, value.length) === value; }, expected)).toBe(true);
}
test.describe(`plain pointer gesture ownership`, () => {
    test.beforeEach(async ({ page }) => {

        await page.goto(`/hosts/plain/?editor=candidate`); await expect(page.getByRole("textbox", { name: "Primary source", exact: true })).toBeVisible();
    });
    test.afterEach(async ({ page }) => {
        await page.mouse.up(); await page.evaluate(() => window.hostFixture.dispose()); const stopped = await state(page);
        expect(stopped.diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); expect(stopped.hostSubscriptions).toBe(0);
    });
    test(`capture loss leaves hover inert and subsequent typing inserts at the retained caret`, async ({ page }) => {
        const original = await setup(page), pointer = await begin(page, 2), down = await state(page), element = root(page);
        await element.evaluate((node, id) => node.releasePointerCapture(id), pointer); await page.mouse.move(10, 10); await page.mouse.up();
        await expect.poll(async () => Number(await element.getAttribute("data-pointer-lost"))).toBeGreaterThan(0); const before = await state(page);
        await move(page, 8); await waitForReview(page); const hovered = await state(page);
        expect(selection(hovered)).toEqual(selection(down)); expect(selection(hovered)).toMatchObject({ anchor: 2, head: 2 });
        expect(selection(hovered, "secondary")).toEqual(selection(before, "secondary")); expect(hovered.bindings.comparison!.selection).toEqual(before.bindings.comparison!.selection);
        expect(hovered.history).toEqual(before.history); expect(hovered.source.revision).toBe(before.source.revision);
        const input = page.getByRole("textbox", { name: "Primary source", exact: true }); await expect(input).toBeFocused(); await input.pressSequentially("q"); await waitForReview(page);
        const expected = original.slice(0, 2) + "q" + original.slice(2), edited = await state(page); await exact(page, expected);
        expect(selection(edited)).toMatchObject({ anchor: 3, head: 3 }); expect(selection(edited, "secondary")).toMatchObject({ anchor: 5, head: 1 });
        expect(edited.bindings.comparison!.selection).toMatchObject({ anchor: 11, head: 13 }); expect(edited.history.undoDepth).toBe(before.history.undoDepth + 1);
        expect(edited.source.exports).toBe(0); expect(edited.bindings.views.every(v => v.metrics!.inputUnits <= 2600 && v.metrics!.viewport.rows < 100 && v.metrics!.viewport.readUnits < 20000)).toBe(true);
        await input.press("Control+z"); await waitForReview(page); await exact(page, original); await input.press("Control+Shift+z"); await waitForReview(page); await exact(page, expected);
        await begin(page, 4); await move(page, 12); expect(selection(await state(page))).toMatchObject({ anchor: 4, head: 12 }); await page.mouse.up();
        const released = selection(await state(page)); await move(page, 16); await waitForReview(page); expect(selection(await state(page))).toEqual(released);
    });
    test("unrelated pointers cannot end a drag; cancellation, changed revisions and detached views cannot continue one", async ({ page }) => {
        const original = await setup(page), pointer = await begin(page, 2); await move(page, 8);
        await root(page).evaluate((node, id) => { node.dispatchEvent(new PointerEvent("pointercancel", { pointerId: id + 100, bubbles: true })); }, pointer);
        await move(page, 10); expect(selection(await state(page))).toMatchObject({ anchor: 2, head: 10 });
        await root(page).evaluate((node, id) => { node.dispatchEvent(new PointerEvent("lostpointercapture", { pointerId: id + 100, bubbles: true })); }, pointer);
        await move(page, 12); expect(selection(await state(page))).toMatchObject({ anchor: 2, head: 12 });
        await root(page).evaluate((node, id) => { node.dispatchEvent(new PointerEvent("pointercancel", { pointerId: id, bubbles: true })); }, pointer);
        expect(await root(page).evaluate((node, id) => node.hasPointerCapture(id), pointer)).toBe(false); const cancelled = selection(await state(page));
        await move(page, 16); expect(selection(await state(page))).toEqual(cancelled); await page.mouse.up();
        // Begin outside the painted selection: dragging selected text now starts a text transfer.
        const revisionPointer = await begin(page, 1); await page.evaluate(() => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: s.source.length, to: s.source.length, insert: "!" }]); }); await waitForReview(page);
        const changed = selection(await state(page)); await move(page, 15); expect(selection(await state(page))).toEqual(changed);
        expect(await root(page).evaluate((node, id) => node.hasPointerCapture(id), revisionPointer)).toBe(false); await page.mouse.move(10, 10); await page.mouse.up();
        await begin(page, 2); await page.evaluate(() => window.hostFixture.unmount()); await page.mouse.move(10, 10); await page.evaluate(() => window.hostFixture.mount()); await waitForReview(page);
        const retained = selection(await state(page)); await move(page, 8); expect(selection(await state(page))).toEqual(retained); await page.mouse.up();
        await exact(page, original + "!"); expect((await state(page)).source.exports).toBe(0);
    });
});
