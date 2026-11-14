import { ready, expect, test } from "./fixtures.ts";
import type { Page } from "@playwright/test";
const snapshot = (page: Page) => page.evaluate(() => window.editingFixture.snapshot());

async function setup(page: Page, text: string, direction: "ltr" | "rtl" = "ltr") {
    await page.evaluate(({ text, direction }) => { (document.querySelector("#primary .st-viewport") as HTMLElement).style.setProperty("--st-text-direction", direction); window.editingFixture.setText(text); window.editingFixture.select("primary", { anchor: 0, head: 0 }); window.editingFixture.focus("primary"); }, { text, direction }); await ready(page);
}
const position = (page: Page) => page.evaluate(() => { const s = window.editingFixture.snapshot(), p = window.editingFixture.coords(s.primary.selection.head, s.primary.selection.headAffinity)!;
    return { x: p.left - document.querySelector("#primary .st-viewport")!.getBoundingClientRect().left + s.primary.viewport.scrollLeft, offset: p.offset }; });
test.beforeEach(async ({ page }) => {  await page.goto("/editing/"); await ready(page); });

test("mixed-script boundaries have distinct affinities and pointer selection retains the measured side", async ({ page }) => {
    await setup(page, "abc אבג xyz");
    const points = await page.evaluate(() => ({ before: window.editingFixture.coords(4, "before")!, after: window.editingFixture.coords(4, "after")! }));
    expect(points.after.left - points.before.left).toBeGreaterThan(10);
    for (const point of [points.before, points.after]) {
        await page.mouse.click(point.left, point.top + point.height / 2); await ready(page);
        const selected = (await snapshot(page)).primary.selection;
        const result = await page.evaluate(s => window.editingFixture.coords(s.head, s.headAffinity)!, selected);
        expect(Math.abs(result.left - point.left)).toBeLessThan(1);
    }
    expect((await snapshot(page)).document!.exports).toBe(0);
});

for (const direction of ["ltr", "rtl"] as const) test(`visual arrows traverse bidi runs, isolates, overrides, brackets and graphemes in ${direction} paragraphs`, async ({ page }) => {
    const samples = ["abc אבג xyz", "אבג", "a א b", "abc العربية 123 xyz", "a é 👩‍💻 z", "a \u2067אבג 123\u2069 z", "a (אבג [12]) z", "a \u202eabc\u202c z", "a \u2068אבג \u2066xy\u2069\u2069 z", "a \u200fב\u200e z"];
    for (const text of samples) {
        await setup(page, text, direction);
        const first = await page.evaluate(text => {
            const boundaries = [0, ...[...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(s => s.index + s.segment.length)];
            const points = boundaries.flatMap(offset => (["before", "after"] as const).map(a => window.editingFixture.coords(offset, a)!));
            points.sort((a, b) => a.left - b.left); return points[0]!;
        }, text);
        await page.evaluate(p => window.editingFixture.select("primary", { anchor: p.offset, head: p.offset, anchorAffinity: p.affinity, headAffinity: p.affinity }), first); await ready(page);
        const initial = await position(page), before = await snapshot(page); let current = initial, steps = 0;
        for (; steps < text.length * 2 + 4; steps++) {
            await page.keyboard.press("ArrowRight"); await ready(page); const next = await position(page);
            if (Math.abs(next.x - current.x) <= .25) break;
            expect(next.x, JSON.stringify({ text, direction })).toBeGreaterThan(current.x + .25); current = next;
        }
        expect(steps).toBeLessThan(text.length * 2 + 4);
        for (let count = 0; count < steps; count++) { await page.keyboard.press("ArrowLeft"); await ready(page); const next = await position(page); expect(next.x, JSON.stringify({ text, direction })).toBeLessThan(current.x - .25); current = next; }
        expect(Math.abs(current.x - initial.x)).toBeLessThan(.5);
        const after = await snapshot(page); expect(after.primary.visualMoves - before.primary.visualMoves).toBe(steps * 2 + 1);
        expect(after.document).toMatchObject({ revision: before.document!.revision, exports: 0 }); expect(after.primary.viewport.partialRows).toBe(0);
    }
});

test("a single offscreen RTL glyph has correct endpoints without mutating styles or document Selection", async ({ page }) => {
    await setup(page, "prefix ".repeat(12) + "א suffix");
    await page.locator("#primary .st-viewport").evaluate(e => { (e as HTMLElement).style.width = "160px"; });
    await expect.poll(() => page.evaluate(() => window.editingFixture.snapshot().primary.viewport.width)).toBe(160); await ready(page);
    const result = await page.locator('#primary [data-line="0"]').evaluate(row => {
        const before = row.getAttribute("style"), selection = document.getSelection(), anchor = selection?.anchorNode, offset = selection?.anchorOffset;
        const a = window.editingFixture.coords(84, "after")!, b = window.editingFixture.coords(85, "before")!;
        return { a, b, stableStyle: row.getAttribute("style") === before, stableSelection: selection?.anchorNode === anchor && selection?.anchorOffset === offset };
    });
    expect(result.stableStyle).toBe(true); expect(result.stableSelection).toBe(true); expect(result.a.left).toBeGreaterThan(result.b.left);
    await page.evaluate(() => window.editingFixture.select("primary", { anchor: 84, head: 84 })); await ready(page);
    const after = await page.evaluate(() => ({ a: window.editingFixture.coords(84, "after")!, b: window.editingFixture.coords(85, "before")! }));
    expect(after.a.left).toBeGreaterThan(after.b.left); expect((await snapshot(page)).document!.exports).toBe(0);
});

test("selection collapse uses visual edges and Shift retains logical anchor and affinity", async ({ page }) => {
    await setup(page, "abc אבג xyz");
    for (const [key, expected] of [["ArrowRight", 4], ["ArrowLeft", 7]] as const) {
        await page.evaluate(() => window.editingFixture.select("primary", { anchor: 4, head: 7 })); await ready(page);
        await page.keyboard.press(key); await ready(page); expect((await snapshot(page)).primary.selection).toMatchObject({ anchor: expected, head: expected });
    }
    await page.evaluate(() => window.editingFixture.select("primary", { anchor: 4, head: 4, anchorAffinity: "after", headAffinity: "after" })); await ready(page);
    await page.keyboard.press("Shift+ArrowLeft"); await ready(page);
    expect((await snapshot(page)).primary.selection).toMatchObject({ anchor: 4, head: 5, anchorAffinity: "after" });
    await page.keyboard.press("Shift+ArrowRight"); await ready(page); expect((await snapshot(page)).primary.selection).toMatchObject({ anchor: 4, head: 4, anchorAffinity: "after" });
});

test("visual line edges follow paragraph flow across CRLF while zero-advance controls stay navigable", async ({ page }) => {
    for (const direction of ["ltr", "rtl"] as const) {
        await setup(page, "אבג\r\nabc", direction);
        const head = direction === "ltr" ? 0 : 3;
        await page.evaluate(head => window.editingFixture.select("primary", { anchor: head, head, anchorAffinity: head ? "before" : "after", headAffinity: head ? "before" : "after" }), head); await ready(page);
        await page.keyboard.press(direction === "ltr" ? "ArrowRight" : "ArrowLeft"); await ready(page);
        expect((await snapshot(page)).primary.selection.head).toBe(direction === "ltr" ? 5 : 8);
        await page.keyboard.press(direction === "ltr" ? "ArrowLeft" : "ArrowRight"); await ready(page); expect((await snapshot(page)).primary.selection.head).toBe(head);
    }
    await setup(page, "\u2067\u2069"); await page.keyboard.press("ArrowRight"); await ready(page); expect((await snapshot(page)).primary.selection.head).toBe(2);
    await page.keyboard.press("ArrowLeft"); await ready(page); expect((await snapshot(page)).primary.selection.head).toBe(0);
    expect((await snapshot(page)).document!.exports).toBe(0);
});

test("font changes preserve Latin ligature interiors and measured bidi affinities", async ({ page }) => {
    await setup(page, "office אבג ffi é 👩‍💻");
    await page.locator("#primary .st-viewport").evaluate(e => { const style = (e as HTMLElement).style; style.fontFamily = '"Times New Roman", serif'; style.fontSize = "21px"; style.lineHeight = "2"; style.fontVariantLigatures = "normal"; style.fontKerning = "normal"; style.fontStyle = "italic"; });
    await expect.poll(() => page.evaluate(() => window.editingFixture.snapshot().primary.viewport.lineHeight)).toBe(42); await ready(page);
    for (let head = 1; head <= 6; head++) { await page.keyboard.press("ArrowRight"); await ready(page); expect((await snapshot(page)).primary.selection.head).toBe(head); }
    const points = await page.evaluate(() => ({ before: window.editingFixture.coords(7, "before")!, after: window.editingFixture.coords(7, "after")! }));
    expect(points.after.left - points.before.left).toBeGreaterThan(10); expect(points.after.height).toBeGreaterThan(14);
    expect((await snapshot(page)).primary.visualMoves).toBe(6); expect((await snapshot(page)).document!.exports).toBe(0);
});

test("RTL paragraph flow keeps horizontal scrolling in positive container coordinates", async ({ page }) => {
    await setup(page, "prefix ".repeat(12) + "א " + "suffix ".repeat(12), "rtl");
    await page.locator("#primary .st-viewport").evaluate(e => { (e as HTMLElement).style.width = "160px"; });
    await expect.poll(() => page.evaluate(() => window.editingFixture.snapshot().primary.viewport.width)).toBe(160);
    await page.evaluate(() => window.editingFixture.select("primary", { anchor: 84, head: 84, anchorAffinity: "after", headAffinity: "after" })); await ready(page);
    const before = await snapshot(page); expect(before.primary.viewport.scrollLeft).toBeGreaterThan(0);
    expect(await page.locator("#primary .st-viewport").evaluate(e => getComputedStyle(e).direction)).toBe("ltr");
    expect(await page.locator('#primary [data-line="0"]').evaluate(e => getComputedStyle(e).direction)).toBe("rtl");
    const initial = await position(page); await page.keyboard.press("ArrowLeft"); await ready(page); const after = await position(page);
    expect(after.x).toBeLessThan(initial.x - .25); expect((await snapshot(page)).primary.visualMoves).toBe(before.primary.visualMoves + 1);
    expect((await snapshot(page)).document).toMatchObject({ revision: before.document!.revision, exports: 0 });
});
