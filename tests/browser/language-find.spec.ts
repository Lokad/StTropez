import { ready, test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
const snapshot = (page: Page) => page.evaluate(() => window.editingFixture.snapshot());

async function found(page: Page, count: number) { await expect.poll(async () => { const s = (await snapshot(page)).find; return s?.status === "ready" ? s.count : -1; }).toBe(count); }
async function openFind(page: Page, replace = false) {
    await page.getByRole("textbox", { name: "Primary source" }).press(replace ? "ControlOrMeta+h" : "ControlOrMeta+f");
    return page.getByRole("textbox", { name: "Find text", exact: true });
}
test.beforeEach(async ({ page }) => {

    await page.goto("/editing/"); await ready(page);
});

test("Find keeps visible results stationary and reveals distant, folded and wrapped matches", async ({ page }) => {
    await page.evaluate(() => {
        const lines = Array<string>(100000).fill("text");
        lines[50000] = "match here"; lines[50001] = "next match";
        lines[90000] = "fold"; lines[90001] = "x".repeat(800) + "match then match";
        const text = lines.join("\n"), f = window.editingFixture;
        f.setText(text); f.folds([{ id: "far", from: text.indexOf("fold"), to: text.indexOf("match", text.indexOf("fold")) + 5, collapsed: true }]);
        f.select("primary", { anchor: 250000, head: 250000 });
    }); await ready(page);
    const viewport = page.locator("#primary .st-viewport"), field = await openFind(page);
    await viewport.evaluate(root => { root.scrollTop = 49996 * parseFloat(getComputedStyle(root).lineHeight); });
    await expect(viewport.locator('[data-line="50000"]')).toBeInViewport();
    await field.fill("match"); await found(page, 4);
    const position = () => viewport.evaluate(root => [root.scrollTop, root.scrollLeft]);
    const original = await position();
    const jump = async (direction: "Next" | "Previous", line: number) => {
        await page.getByRole("button", { name: direction + " match", exact: true }).click(); await ready(page);
        const selected = viewport.locator(`[data-line="${line}"] .st-viewport-selected`).first();
        await expect(selected).toHaveText("match");
        expect(await selected.evaluate(node => {
            const root = node.closest(".st-viewport")!, rect = node.getBoundingClientRect(), box = root.getBoundingClientRect();
            const gutter = root.querySelector(".st-viewport-gutter")!.getBoundingClientRect();
            return rect.left >= gutter.right - 1 && rect.right <= box.left + root.clientLeft + root.clientWidth + 1
                && rect.top >= box.top - 1 && rect.bottom <= box.top + root.clientTop + root.clientHeight + 1;
        })).toBe(true);
    };
    await jump("Next", 50001); expect(await position()).toEqual(original);
    await jump("Previous", 50000); expect(await position()).toEqual(original);
    await jump("Previous", 90001); expect((await position())[1]).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.editingFixture.folding().index.collapsedCount)).toBe(0);
    const far = await position();
    await jump("Previous", 90001); expect(await position()).toEqual(far);
    await jump("Next", 90001); expect(await position()).toEqual(far);
    await jump("Next", 50000);
});

test("literal find paints a zero-width space without widening the matched text", async ({ page }) => {
    await page.evaluate(() => window.editingFixture.setText("a\u200bb")); await ready(page);
    await page.addStyleTag({ content: "#primary { --st-search-current-border: rgb(255, 0, 213); }" });
    const field = await openFind(page);
    await field.fill("\u200b"); await found(page, 1); await page.getByRole("button", { name: "Next match", exact: true }).click();
    const match = page.locator("#primary .st-search-match"); await expect(match).toHaveText("\u200b"); await ready(page);
    expect((await snapshot(page)).primary.selection).toMatchObject({ anchor: 1, head: 2 });
    const box = await match.boundingBox(); expect(box!.width).toBeLessThan(1);
    const image = await page.screenshot({ clip: { x: Math.floor(box!.x) - 1, y: Math.ceil(box!.y), width: 5, height: Math.floor(box!.height) } });
    const painted = await page.evaluate(async png => {
        const image = new Image(); image.src = "data:image/png;base64," + png; await image.decode();
        const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext("2d")!; ctx.drawImage(image, 0, 0);
        const rgba = ctx.getImageData(0, 0, image.width, image.height).data;
        return rgba.filter((r, i) => i % 4 === 0 && r === 255 && rgba[i + 1] === 0 && rgba[i + 2] === 213).length;
    }, image.toString("base64"));
    expect(painted).toBeGreaterThan(4);
});

test("literal find wraps Unicode ranges and replacement is one shared undoable transaction", async ({ page }) => {
    const text = "😀 const saMORE = 123; // TODO\r\nconst saMORE = 2;";
    await page.evaluate(text => window.editingFixture.setText(text), text); await ready(page);
    await (await openFind(page, true)).fill("saMORE"); await found(page, 2);
    await expect(page.locator("#primary .st-search-match")).toHaveCount(2);
    await page.getByRole("button", { name: "Previous match", exact: true }).click();
    expect((await snapshot(page)).primary.selection.anchor).toBe(text.lastIndexOf("saMORE"));
    await page.getByRole("button", { name: "Next match", exact: true }).click();
    expect((await snapshot(page)).primary.selection).toMatchObject({ anchor: text.indexOf("saMORE"), head: text.indexOf("saMORE") + 6 });
    await page.getByRole("textbox", { name: "Replacement text", exact: true }).fill("$&");
    const depth = (await snapshot(page)).history!.undoDepth;
    await page.getByRole("button", { name: "Replace all", exact: true }).click(); await found(page, 0); await ready(page);
    const expected = text.split("saMORE").join("$&");
    expect(await page.evaluate(length => window.editingFixture.range(0, length), (await snapshot(page)).document!.length)).toBe(expected);
    expect((await snapshot(page)).history!.undoDepth).toBe(depth + 1);
    await page.getByRole("textbox", { name: "Secondary source" }).press("ControlOrMeta+z"); await found(page, 2);
    expect(await page.evaluate(length => window.editingFixture.range(0, length), text.length)).toBe(text);
    await page.getByRole("button", { name: "Next match", exact: true }).click();
    await page.getByRole("textbox", { name: "Replacement text", exact: true }).fill("sample");
    await page.getByRole("button", { name: "Replace", exact: true }).click(); await found(page, 1);
});

test("visible search highlights follow scrolling, equal-count queries and edits beyond 200 matches", async ({ page }) => {
    const text = Array.from({ length: 400 }, (_, i) => `const needle_${i} = needle_${i};`).join("\n");
    await page.evaluate(text => window.editingFixture.setText(text), text); await ready(page);
    const query = await openFind(page), input = page.getByRole("textbox", { name: "Primary source", exact: true });
    const highlights = page.locator("#primary .st-search-match");
    await query.fill("needle"); await found(page, 800);
    await expect.poll(() => highlights.count()).toBeGreaterThan(0);
    await input.press("Control+End"); await ready(page);
    await expect(page.locator("#primary")).toContainText("needle_399");
    await expect.poll(() => highlights.count()).toBeGreaterThan(0);
    await expect.poll(() => highlights.allTextContents()).toContain("needle");
    await query.fill("_399"); await found(page, 2); await expect(highlights).toHaveCount(2);
    await query.fill("_398"); await found(page, 2); await expect(highlights).toHaveText(["_398", "_398"]);
    await query.fill("needle"); await found(page, 800);
    await input.press("Control+End"); await input.press("Home"); await input.press("Shift+End"); await input.press("Backspace");
    await found(page, 798); await ready(page); await expect.poll(() => highlights.count()).toBeGreaterThan(0);
    await input.press("ControlOrMeta+z"); await found(page, 800); await ready(page);
    await expect(page.locator("#primary")).toContainText("needle_399"); await expect.poll(() => highlights.count()).toBeGreaterThan(0);
    await query.fill("absent"); await found(page, 0); await expect(highlights).toHaveCount(0);
});

test("replacing 10,000 matches honors read-only changes and shares one undo across panes", async ({ page }) => {
    const query = await openFind(page, true);
    await query.fill("const");
    await found(page, 10_000);
    const all = page.getByRole("button", { name: "Replace all", exact: true });
    await page.getByRole("textbox", { name: "Replacement text" }).fill("let");
    await page.evaluate(() => window.editingFixture.readOnly(true));
    await expect(all).toBeDisabled();
    await page.evaluate(() => window.editingFixture.readOnly(false));
    const before = await snapshot(page);
    await all.click();
    await found(page, 0);
    expect((await snapshot(page)).document).toMatchObject({ revision: before.document!.revision + 1, length: 220_000 });
    expect((await snapshot(page)).history!.undoDepth).toBe(before.history!.undoDepth + 1);
    expect(await page.evaluate(() => window.editingFixture.range(0, 22))).toBe("let sample = 1234567;\n");
    await page.getByRole("textbox", { name: "Secondary source" }).press("ControlOrMeta+z");
    await found(page, 10_000);
    expect((await snapshot(page)).document!.length).toBe(240_000);
});

test("visible highlighting reuses unchanged lines and native glyph selection survives token spans", async ({ page }) => {
    const before = (await snapshot(page)).presentation;
    await page.evaluate(() => window.editingFixture.focus("primary")); await page.keyboard.type("z"); await ready(page);
    const after = (await snapshot(page)).presentation;
    expect(after.primary.lexedLines - before.primary.lexedLines).toBe(1); expect(after.secondary.lexedLines - before.secondary.lexedLines).toBe(1);
    expect(after.primary.cachedLines).toBeLessThanOrEqual(128);
    await page.evaluate(() => window.editingFixture.setText("😀 const saMORE = 123; // TODO")); await ready(page);
    for (const [className, text] of [["keyword", "const"], ["number", "123"], ["comment", "// TODO"]]) await expect(page.locator(`#primary .st-token-${className}`)).toHaveText(text!);
    const colors = await Promise.all(["keyword", "number", "comment"].map(kind => page.locator(`#primary .st-token-${kind}`).evaluate(node => getComputedStyle(node).color)));
    expect(new Set(colors).size).toBe(3);
    const point = await page.evaluate(() => window.editingFixture.coords(9)!); await page.mouse.click(point.left, point.top + point.height / 2);
    expect((await snapshot(page)).primary.selection.head).toBe(9);
    await page.keyboard.press("End"); await page.keyboard.type("x"); await ready(page);
    await expect(page.locator("#primary .st-token-comment")).toHaveText("// TODOx");
    expect(page.workers()).toEqual([]);
});
