import { ready, test, expect } from "./fixtures.ts";
import { expectCaretOnRow } from "../helpers/editor-assertions.ts";
import type { Locator, Page } from "@playwright/test";

const source = (page: Page, name = "Primary source") => page.getByRole("textbox", { name, exact: true });
const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());

async function rectangle(input: Locator, offset: number) {
    return input.evaluate((input, offset) => {
        const root = input.closest(".st-editor")!, row = [...root.querySelectorAll<HTMLElement>(".st-viewport-row")]
            .find(v => offset >= Number(v.dataset.from) && offset < Number(v.dataset.to));
        if (!row) throw new Error(`Source offset ${offset} is not painted.`);
        let remaining = offset - Number(row.dataset.from); const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (remaining >= node.textContent!.length) { remaining -= node.textContent!.length; continue; }
            const range = document.createRange(); range.setStart(node, remaining); range.setEnd(node, remaining + 1);
            const box = range.getBoundingClientRect(), line = row.getBoundingClientRect();
            return { left: box.left, top: box.top, height: box.height, rowTop: line.top, rowHeight: line.height, x: box.left + box.width * .15, y: box.top + box.height / 2 };
        }
        throw new Error("Missing source text node.");
    }, offset);
}
async function caret(input: Locator, offset: number, secondary = false): Promise<void> {
    const expected = await rectangle(input, offset), actual = await input.evaluate((input, secondary) => {
        const node = input.closest(".st-editor")!.querySelector<HTMLElement>(secondary ? ".st-input-secondary-caret" : ".st-input-caret")!;
        const box = node.getBoundingClientRect(), anchor = input.getBoundingClientRect();
        return { hidden: node.hidden, left: box.left, top: box.top, height: box.height, anchorHeight: anchor.height };
    }, secondary);
    expect(actual.hidden).toBe(false); expect(Math.abs(actual.left - expected.left)).toBeLessThan(1.1);
    expectCaretOnRow(actual, { top: expected.rowTop, height: expected.rowHeight });
    if (!secondary) expect(Math.abs(actual.anchorHeight - expected.height)).toBeLessThan(1.1);
}

test(`plain inherited CSS zoom preserves carets, pointer ranges and navigation`, async ({ page }) => {
    test.setTimeout(90000);
    await page.goto(`/hosts/plain/`);
    const line = "0123456789abcdef Δ😀 xyz\r\n", text = line.repeat(80);
    await page.evaluate(text => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]); }, text);
    await ready(page);
    for (const zoom of [1.5, .75]) {
        await source(page).evaluate((input, zoom) => {
            document.documentElement.style.zoom = "1.25";
            const root = input.closest<HTMLElement>(".st-editor")!;
            root.parentElement!.style.zoom = String(zoom / 1.25); root.style.border = "2px solid transparent";
            if (zoom < 1) Object.defineProperty(root, "currentCSSZoom", { value: undefined, configurable: true });
        }, zoom);
        await page.evaluate(() => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 8, head: 8 }, { anchor: 11, head: 11 }]); });
        await source(page).scrollIntoViewIfNeeded(); await source(page).focus(); await ready(page);
        await caret(source(page), 8); await caret(source(page), 11, true);
        await source(page).press("Escape"); await source(page).press("ArrowRight"); await source(page).press("ArrowDown"); await ready(page);
        expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selection.head).toBe(line.length + 9); await caret(source(page), line.length + 9);
        await source(page).press("PageDown"); await ready(page);
        expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selection.head % line.length).toBe(9);
        await source(page).press("Control+Home"); await source(page).press("ArrowDown"); await ready(page);
        const from = line.length + 5, to = line.length + 12, a = await rectangle(source(page), from), b = await rectangle(source(page), to);
        const marker = await source(page).evaluate((input, point) => {
            const root = input.closest(".st-editor")!, dataTransfer = new DataTransfer(); dataTransfer.setData("text/plain", "external");
            Object.defineProperty(dataTransfer, "effectAllowed", { value: "copy" });
            root.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y, dataTransfer }));
            const marker = root.querySelector(".st-text-drop-caret"); if (!marker) throw new Error("Missing drop marker.");
            const box = marker.getBoundingClientRect(); root.dispatchEvent(new DragEvent("dragleave", { bubbles: true }));
            return { left: box.left, top: box.top, height: box.height };
        }, a);
        expect(Math.abs(marker.left - a.left)).toBeLessThan(1.1); expect(Math.abs(marker.top - a.top)).toBeLessThan(1.1);
        expect(Math.abs(marker.height - a.height)).toBeLessThan(1.1);
        await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 3 }); await page.mouse.up(); await ready(page);
        expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selection).toMatchObject({ anchor: from, head: to });
        await source(page).pressSequentially("Q"); await ready(page);
        expect(await page.evaluate(({ from, to }) => window.hostFixture.range(from, to), { from: from - 2, to: from + 3 })).toBe(text.slice(from - 2, from) + "Q" + text.slice(to, to + 2));
        await source(page).press("Control+z"); await ready(page); expect((await snapshot(page)).source.length).toBe(text.length);
        expect(await page.evaluate(() => window.hostFixture.range(0, 100))).toBe(text.slice(0, 100));
    }
    await page.getByRole("button", { name: "Open source review", exact: true }).click(); await ready(page);
    const reference = source(page, "Comparison baseline source"); await reference.scrollIntoViewIfNeeded(); await reference.focus();
    await reference.press("Control+Home"); await reference.press("ArrowRight"); await ready(page); await caret(reference, 1);
    const working = source(page, "Comparison working source"); await working.scrollIntoViewIfNeeded(); await working.focus();
    await working.press("Control+Home"); await working.press("ArrowRight"); await ready(page); await caret(working, 1);

    await page.evaluate(() => window.hostFixture.dispose());
});

test(`plain scroll boundary keeps the caret on source and the native input inside the viewport`, async ({ page }) => {
     await page.goto(`/hosts/plain/`);
    const line = "0123456789abcdef Δ😀 xyz\r\n", text = line.repeat(80), offset = line.length * 20 + 8, input = source(page);
    await page.evaluate(text => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]); }, text);
    for (const zoom of [1, 1.5]) {
        await input.evaluate((input, zoom) => { const root = input.closest<HTMLElement>(".st-editor")!;
            root.parentElement!.style.zoom = String(zoom); root.style.border = "2px solid transparent"; }, zoom);
        await page.evaluate(offset => { const f = window.hostFixture; f.selectSource("primary", f.snapshot().source.revision, { anchor: offset, head: offset }); }, offset);
        await input.focus();
        const first = await input.evaluate(input => { const root = input.closest<HTMLElement>(".st-editor")!;
            root.scrollTop = window.hostFixture.snapshot().bindings.views.find(v => v.id === "primary")!.metrics!.viewport.lineHeight * 20; return root.scrollTop; });
        await expect.poll(async () => (await snapshot(page)).bindings.views.find(v => v.id === "primary")!.metrics!.viewport.scrollTop).toBeCloseTo(first, 3); await ready(page);
        const glyph = await rectangle(input, offset);
        const last = await input.evaluate((input, { glyph, zoom }) => { const root = input.closest<HTMLElement>(".st-editor")!, box = root.getBoundingClientRect();
            const current = (glyph.top - box.top) / zoom - root.clientTop, desired = root.clientHeight - glyph.height / zoom - 1;
            root.scrollTop += current - desired; return root.scrollTop;
        }, { glyph, zoom });
        await expect.poll(async () => (await snapshot(page)).bindings.views.find(v => v.id === "primary")!.metrics!.viewport.scrollTop).toBeCloseTo(last, 3); await ready(page);
        await caret(input, offset);
        const anchor = await input.evaluate((input, zoom) => { const root = input.closest<HTMLElement>(".st-editor")!, box = root.getBoundingClientRect(), at = input.getBoundingClientRect();
            return { top: at.top, bottom: at.bottom, low: box.top + root.clientTop * zoom, high: box.top + (root.clientTop + root.clientHeight) * zoom };
        }, zoom);
        expect(anchor.top).toBeGreaterThanOrEqual(anchor.low); expect(anchor.bottom).toBeLessThanOrEqual(anchor.high);
        const point = await rectangle(input, offset); await page.mouse.click(point.x, point.y); await ready(page);
        expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selection).toMatchObject({ anchor: offset, head: offset }); await caret(input, offset);
        await input.click(); await ready(page);
        expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selection).toMatchObject({ anchor: offset, head: offset });
        await expect(input).toBeFocused();
        await input.pressSequentially("Q"); await ready(page);
        expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selection.head).toBe(offset + 1);
        expect(await page.evaluate(at => window.hostFixture.range(at - 1, at + 2), offset)).toBe(text[offset - 1] + "Q" + text[offset]);
        await input.press("Control+z"); await ready(page); expect((await snapshot(page)).source.length).toBe(text.length);
        expect(await page.evaluate(() => window.hostFixture.range(0, window.hostFixture.snapshot().source.length))).toBe(text);
    }
    await page.evaluate(() => window.hostFixture.dispose());
});
