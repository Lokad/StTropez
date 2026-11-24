import { ready, test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";

const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const primary = (s: Awaited<ReturnType<typeof snapshot>>) => s.bindings.views.find(v => v.id === "primary")!;
const root = (page: Page) => page.locator('.st-editor:has(> textarea[aria-label="Primary source"])');
const input = (page: Page) => page.getByRole("textbox", { name: "Primary source", exact: true });
async function waitForReview(page: Page): Promise<void> {
    await ready(page);
    await page.waitForFunction(() => { const s = window.hostFixture.snapshot(); return window.hostFixture.settled && (s.bindings.activeViews === 2 && s.bindings.comparison !== null); });
}
async function exact(page: Page, text: string): Promise<void> {
    expect(await page.evaluate(value => { const f = window.hostFixture; return f.snapshot().source.length === value.length && f.range(0, value.length) === value; }, text)).toBe(true);
}
async function frames(page: Page, count = 8): Promise<void> {
    await page.evaluate(count => new Promise<void>(resolve => { const step = () => { if (--count) requestAnimationFrame(step); else resolve(); }; requestAnimationFrame(step); }), count);
}
type Axis = "x" | "y";
async function begin(page: Page, host: string, axis: Axis, sign: -1 | 1) {
    await page.goto(`/hosts/${host}/?editor=candidate`); await expect(input(page)).toBeVisible();
    const line = "const sample = '😀 é';", original = axis === "x" ? "x".repeat(48000) : Array(1000).fill(line).join("\r\n");
    await page.evaluate(text => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]); f.selectSource("secondary", f.snapshot().source.revision, { anchor: 4, head: 1 }); }, original);
    await page.getByRole("button", { name: "Open source review", exact: true }).click(); await waitForReview(page);
    await page.getByRole("button", { name: "Save source", exact: true }).click(); await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
    await page.evaluate(() => window.hostFixture.finishSave()); await expect.poll(async () => (await snapshot(page)).source.serverVersion).toBe("v1");
    await page.getByRole("button", { name: "Capture reference refresh", exact: true }).click(); await page.getByRole("button", { name: "Finish reference refresh", exact: true }).click(); await waitForReview(page);
    await input(page).press("Control+Home");
    if (axis === "x" || sign < 0) {
        await page.evaluate(offset => { const f = window.hostFixture; f.selectSource("primary", f.snapshot().source.revision, { anchor: offset, head: offset }); }, axis === "x" ? 24000 : 500 * (line.length + 2));
        await input(page).press("ArrowRight"); await input(page).press("ArrowLeft");
    }
    await waitForReview(page); await root(page).scrollIntoViewIfNeeded();
    const point = await root(page).evaluate(element => {
        const box = element.getBoundingClientRect(), rows = [...element.querySelectorAll<HTMLElement>(".st-viewport-row")].filter(row => { const r = row.getBoundingClientRect(); return r.top >= box.top + element.clientTop && r.bottom <= box.top + element.clientTop + element.clientHeight; });
        const row = rows[Math.min(2, rows.length - 1)]; if (!row) throw new Error("Missing visible source row.");
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT), nodes: Text[] = [];
        for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
        const locate = (offset: number) => { for (const node of nodes) { if (offset <= node.length) return { node, offset }; offset -= node.length; } throw new Error("Missing visible text offset."); };
        const offset = row.dataset.complete === "false" ? 40 : 2, a = locate(offset), b = locate(offset + 1), range = document.createRange(); range.setStart(a.node, a.offset); range.setEnd(b.node, b.offset); const r = range.getBoundingClientRect();
        element.dataset.pointerGot = "0"; element.addEventListener("gotpointercapture", () => { element.dataset.pointerGot = "1"; }); element.addEventListener("pointerdown", event => { element.dataset.pointerId = String((event as PointerEvent).pointerId); });
        return { x: r.left + r.width * .25, y: r.top + r.height * .5, top: box.top + element.clientTop, bottom: box.top + element.clientTop + element.clientHeight,
            left: box.left + element.clientLeft, right: box.left + element.clientLeft + element.clientWidth, offset: Number(row.dataset.from) + offset };
    });
    await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.move(point.x + .5, point.y);
    await expect.poll(() => root(page).getAttribute("data-pointer-got")).toBe("1"); const before = await snapshot(page), key = axis === "x" ? "scrollLeft" : "scrollTop", start = primary(before).metrics!.viewport[key];
    await page.mouse.move(axis === "x" ? sign > 0 ? point.right + 32 : point.left - 32 : point.x, axis === "y" ? sign > 0 ? point.bottom + 32 : point.top - 32 : point.y);
    await expect.poll(async () => Math.sign(primary(await snapshot(page)).metrics!.viewport[key] - start), { timeout: 2000 }).toBe(sign);
    return { original, point, before, key } as const;
}
for (const host of ["plain", "react"]) for (const axis of ["y", "x"] as const) for (const sign of [1, -1] as const) test(`${host} ${axis === "y" ? "multiline" : "long-line"} captured drag keeps selecting past the ${axis}${sign} edge, stops on release and remains one undoable typing target`, async ({ page }) => {
    const { original, point, before, key } = await begin(page, host, axis, sign);

    const first = primary(await snapshot(page)).selection.head;
    await expect.poll(async () => Math.sign(primary(await snapshot(page)).selection.head - first)).toBe(sign);
    const held = await snapshot(page); expect(primary(held).selection.anchor).toBe(point.offset); expect(held.source.revision).toBe(before.source.revision); expect(primary(held).metrics!.dragScrollFrames).toBeGreaterThan(0);
    expect(held.history).toEqual(before.history); expect(held.source.exports).toBe(before.source.exports);
    expect(held.bindings.views.find(v => v.id === "secondary")!.selection).toEqual(before.bindings.views.find(v => v.id === "secondary")!.selection);
    expect(held.bindings.comparison!.selection).toEqual(before.bindings.comparison!.selection);
    await page.mouse.up(); await waitForReview(page); const released = await snapshot(page); await frames(page); await page.mouse.move(point.x, point.y); await frames(page);
    const stopped = await snapshot(page); expect(primary(stopped).selection).toEqual(primary(released).selection); expect(primary(stopped).metrics!.viewport[key]).toBe(primary(released).metrics!.viewport[key]);
    await expect(input(page)).toBeFocused(); const selected = primary(stopped).selection, from = Math.min(selected.anchor, selected.head), to = Math.max(selected.anchor, selected.head);
    await input(page).pressSequentially("q"); await waitForReview(page); const expected = original.slice(0, from) + "q" + original.slice(to), edited = await snapshot(page); await exact(page, expected);
    expect(primary(edited).selection).toMatchObject({ anchor: from + 1, head: from + 1 }); expect(edited.history.undoDepth).toBe(before.history.undoDepth + 1); expect(edited.source.exports).toBe(0);
    expect(edited.bindings.views.every(v => v.metrics!.inputUnits <= 2600 && v.metrics!.viewport.rows < 100 && v.metrics!.viewport.readUnits < 20000)).toBe(true);
    expect(edited.bindings.comparison!.baseline!.version).toBe("reference:saved-v1"); expect(await page.evaluate(value => window.hostFixture.referenceRange(0, value.length) === value, original)).toBe(true);
    await input(page).press("Control+z"); await waitForReview(page); await exact(page, original); expect((await snapshot(page)).source.dirty).toBe(false);
    await input(page).press("Control+Shift+z"); await waitForReview(page); await exact(page, expected); expect((await snapshot(page)).source.dirty).toBe(true);
    await page.evaluate(() => window.hostFixture.dispose()); expect((await snapshot(page)).diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); expect((await snapshot(page)).hostSubscriptions).toBe(0);
});

for (const host of ["plain", "react"]) for (const cancellation of ["capture-loss", "owned-cancel", "revision", "selection", "remount", "replacement", "dispose"] as const) test(`${host} queued drag scrolling stops after ${cancellation} without later selection or scroll writes`, async ({ page }) => {
    const { original, point } = await begin(page, host, "y", 1), element = root(page), pointer = Number(await element.getAttribute("data-pointer-id"));
    expect(await element.evaluate((node, id) => node.hasPointerCapture(id), pointer)).toBe(true);
    let expected = original;
    if (cancellation === "capture-loss") await element.evaluate((node, id) => node.releasePointerCapture(id), pointer);
    else if (cancellation === "owned-cancel") await element.evaluate((node, id) => node.dispatchEvent(new PointerEvent("pointercancel", { pointerId: id, bubbles: true })), pointer);
    else if (cancellation === "revision") { await page.evaluate(() => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: s.source.length, to: s.source.length, insert: "!" }]); }); expected += "!"; }
    else if (cancellation === "selection") await page.evaluate(() => { const f = window.hostFixture; f.selectSource("primary", f.snapshot().source.revision, { anchor: 700, head: 700 }); });
    else if (cancellation === "remount") { await page.evaluate(() => window.hostFixture.unmount()); await page.evaluate(() => window.hostFixture.mount()); }
    else if (cancellation === "replacement") {
        for (const label of ["Replace primary panel", "Reopen primary source"]) await page.evaluate(label => { const button = [...document.querySelectorAll("button")].find(b => b.textContent === label); if (!button) throw new Error("Missing host command."); button.click(); }, label);
    } else {
        await page.evaluate(() => window.hostFixture.dispose()); await frames(page, 12); await page.mouse.up();
        expect((await snapshot(page)).diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); expect((await snapshot(page)).hostSubscriptions).toBe(0); return;
    }
    await waitForReview(page); const stopped = await snapshot(page), stoppedView = primary(stopped); expect(stoppedView.metrics!.pendingDragScroll).toBe(false);
    if (cancellation === "selection") expect(stoppedView.selection).toMatchObject({ anchor: 700, head: 700 });
    await frames(page, 12); await page.mouse.up(); await page.mouse.move(point.x, point.y); await frames(page); const later = await snapshot(page);
    expect(primary(later).selection).toEqual(stoppedView.selection); expect(primary(later).metrics!.viewport.scrollTop).toBe(stoppedView.metrics!.viewport.scrollTop);
    expect(primary(later).metrics!.dragScrollFrames).toBe(stoppedView.metrics!.dragScrollFrames); expect(later.history).toEqual(stopped.history); expect(later.source.revision).toBe(stopped.source.revision); await exact(page, expected);
    await page.evaluate(() => window.hostFixture.dispose()); expect((await snapshot(page)).diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 }); expect((await snapshot(page)).hostSubscriptions).toBe(0);
});
