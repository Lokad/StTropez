import { test, expect, ready } from "./fixtures.ts";
import type { PointerDwellPosition } from "../../src/browser/index.ts";

test("a dwell stays on its source revision and fold projection", async ({ page }) => {
    await page.goto("/editing/");
    await page.evaluate(() => { const f = window.editingFixture; f.setText("head\ninside\nlast"); f.select("primary", { anchor: 1, head: 1 }); });
    await ready(page);
    const probe = await page.evaluateHandle(() => {
        const f = window.editingFixture, visits: PointerDwellPosition[] = [];
        const dwell = f.pointerDwell(point => visits.push(point), 80);
        const visit = (offset: number) => {
            const point = f.coords(offset)!;
            document.querySelector("#primary .st-viewport")!.dispatchEvent(new PointerEvent("pointermove", { bubbles: true,
                pointerType: "mouse", clientX: point.left + 1, clientY: point.top + point.height / 2 }));
            return dwell.isPending();
        };
        return { visits, visit, dwell };
    });
    expect(await probe.evaluate(p => { const armed = p.visit(6); window.editingFixture.folds([{ id: "body", from: 0, to: 12, collapsed: true }]); return armed; })).toBe(true);
    await expect.poll(() => probe.evaluate(p => p.dwell.isPending())).toBe(false);
    expect(await probe.evaluate(p => p.visits)).toEqual([]);
    await ready(page);
    expect(await probe.evaluate(p => { const armed = p.visit(1); window.editingFixture.edit([{ from: 0, to: 0, insert: "x" }]); return armed; })).toBe(true);
    await expect.poll(() => probe.evaluate(p => p.dwell.isPending())).toBe(false);
    expect(await probe.evaluate(p => p.visits)).toEqual([]);
    await ready(page);
    expect(await probe.evaluate(p => p.visit(1))).toBe(true);
    await expect.poll(() => probe.evaluate(p => p.visits.map(point => point.offset))).toEqual([1]);
    expect(await probe.evaluate(p => { const armed = p.visit(3); window.editingFixture.dispose(); return [armed, p.dwell.isPending()]; })).toEqual([true, false]);
    await probe.dispose();
});
