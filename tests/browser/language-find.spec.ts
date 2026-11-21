import { ready, test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
const snapshot = (page: Page) => page.evaluate(() => window.editingFixture.snapshot());

async function found(page: Page, count: number) { await expect.poll(async () => { const s = (await snapshot(page)).find; return s.status === "ready" ? s.count : -1; }).toBe(count); }
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
    const viewport = page.locator("#primary .st-viewport"), field = page.getByRole("textbox", { name: "Find", exact: true });
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
    await jump("Next", 50000); expect(await position()).toEqual(original);
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
    const field = page.getByRole("textbox", { name: "Find", exact: true });
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
    await page.getByRole("textbox", { name: "Find", exact: true }).fill("saMORE"); await found(page, 2);
    await expect(page.locator("#primary .st-search-match")).toHaveCount(2);
    await page.getByRole("button", { name: "Next match", exact: true }).click();
    expect((await snapshot(page)).primary.selection).toMatchObject({ anchor: text.indexOf("saMORE"), head: text.indexOf("saMORE") + 6 });
    await page.getByRole("button", { name: "Previous match", exact: true }).click(); expect((await snapshot(page)).primary.selection.anchor).toBe(text.lastIndexOf("saMORE"));
    await page.getByRole("textbox", { name: "Replace with", exact: true }).fill("$&");
    const depth = (await snapshot(page)).history!.undoDepth;
    await page.getByRole("button", { name: "Replace all", exact: true }).click(); await found(page, 0); await ready(page);
    const expected = text.split("saMORE").join("$&");
    expect(await page.evaluate(length => window.editingFixture.range(0, length), (await snapshot(page)).document!.length)).toBe(expected);
    expect((await snapshot(page)).history!.undoDepth).toBe(depth + 1);
    await page.keyboard.press("ControlOrMeta+z"); await found(page, 2);
    expect(await page.evaluate(length => window.editingFixture.range(0, length), text.length)).toBe(text);
    await page.getByRole("button", { name: "Next match", exact: true }).click();
    await page.getByRole("textbox", { name: "Replace with", exact: true }).fill("sample");
    await page.getByRole("button", { name: "Replace match", exact: true }).click(); await found(page, 1);
    expect((await snapshot(page)).document!.exports).toBe(0);
});

test("visible search highlights follow scrolling, equal-count queries and edits beyond 200 matches", async ({ page }) => {
    const text = Array.from({ length: 400 }, (_, i) => `const needle_${i} = needle_${i};`).join("\n");
    await page.evaluate(text => window.editingFixture.setText(text), text); await ready(page);
    const query = page.getByRole("textbox", { name: "Find", exact: true }), input = page.getByRole("textbox", { name: "Primary source", exact: true });
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

test("keyboard find routing, read-only replacement and a pilot-sized replace-all retain exact history", async ({ page }) => {
    await page.evaluate(() => { window.editingFixture.load("lines-10000"); window.editingFixture.focus("primary"); });
    await page.keyboard.press("ControlOrMeta+f"); await expect(page.getByRole("textbox", { name: "Find", exact: true })).toBeFocused();
    await page.keyboard.type("const"); await found(page, 10_000);
    const query = page.getByRole("textbox", { name: "Find", exact: true });
    const revision = (await snapshot(page)).document!.revision;
    for (let match = 0; match < 5; match++) {
        await page.keyboard.press("Enter"); await expect(query).toBeFocused();
        expect((await snapshot(page)).primary.selection).toMatchObject({ anchor: match * 24, head: match * 24 + 5 });
    }
    await page.keyboard.press("Shift+Enter");
    await expect(query).toBeFocused();
    expect((await snapshot(page)).document!.revision).toBe(revision);
    const replacement = page.getByRole("textbox", { name: "Replace with", exact: true });
    await replacement.fill("let"); await page.keyboard.press("Enter"); await found(page, 9_999);
    await expect(replacement).toBeFocused();
    await expect(page.locator("#primary .st-viewport-row").filter({ hasText: /^let sample/ })).toBeVisible();
    expect((await snapshot(page)).primary.selection).toMatchObject({ anchor: 94, head: 99 });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("textbox", { name: "Primary source", exact: true })).toBeFocused();
    await page.keyboard.press("ControlOrMeta+z");
    await page.keyboard.press("ControlOrMeta+h"); await found(page, 10_000); await expect(replacement).toBeFocused();
    await page.evaluate(() => window.editingFixture.readOnly(true)); await page.getByRole("button", { name: "Replace all", exact: true }).click();
    await expect(page.locator("#find-status")).toHaveText("read-only"); expect((await snapshot(page)).document!.length).toBe(240_000);
    expect((await snapshot(page)).find.reason).toBe("editing-unavailable");
    await page.evaluate(() => window.editingFixture.readOnly(false)); const before = await snapshot(page);
    await page.getByRole("button", { name: "Replace all", exact: true }).click(); await found(page, 0); await ready(page);
    expect((await snapshot(page)).document).toMatchObject({ revision: before.document!.revision + 1, length: 220_000, exports: 0 });
    expect((await snapshot(page)).history!.undoDepth).toBe(before.history!.undoDepth + 1);
    expect(await page.evaluate(() => window.editingFixture.range(0, 22))).toBe("let sample = 1234567;\n");
    await page.keyboard.press("ControlOrMeta+z"); await found(page, 10_000); expect((await snapshot(page)).document!.length).toBe(240_000);
});

test("100k-line search yields, retains confirmed matches and rejects stale replace-all planning", async ({ page }) => {
    const progress = await page.evaluate(() => new Promise<{
        before: ReturnType<typeof window.editingFixture.snapshot>;
        partial: ReturnType<typeof window.editingFixture.snapshot>;
        cancelled: ReturnType<typeof window.editingFixture.snapshot>;
    }>(resolve => {
        const f = window.editingFixture, before = f.snapshot(); f.find("const");
        setTimeout(() => { const partial = f.snapshot(); f.cancelFind(); resolve({ before, partial, cancelled: f.snapshot() }); }, 0);
    }));
    expect(progress.partial.find.status).toBe("searching");
    expect(progress.partial.find.scanned).toBeGreaterThan(0);
    expect(progress.partial.find.scanned).toBeLessThan(progress.partial.document!.length);
    expect(progress.partial.find.count).toBeGreaterThan(0);
    expect(progress.cancelled.find.status).toBe("cancelled");
    expect(progress.cancelled.history).toEqual(progress.before.history);
    expect(progress.cancelled.document).toEqual(progress.before.document);
    await page.evaluate(() => window.editingFixture.find("const")); await found(page, 100_000);
    expect((await snapshot(page)).document!.exports).toBe(0);
    const retained = await page.evaluate(() => {
        const f = window.editingFixture; f.edit([{ from: 1200000, to: 1200005, insert: "let" }]);
        return { find: f.snapshot().find, next: (document.getElementById("find-next") as HTMLButtonElement).disabled,
            all: (document.getElementById("replace-all") as HTMLButtonElement).disabled };
    });
    expect(retained.find.status).toBe("searching"); expect(retained.find.count).toBeGreaterThan(49000);
    expect(retained.next).toBe(false); expect(retained.all).toBe(true);
    await found(page, 99999); await page.getByRole("textbox", { name: "Primary source", exact: true }).press("ControlOrMeta+z"); await found(page, 100000);
    await page.evaluate(() => { window.editingFixture.replaceAll("let"); window.editingFixture.edit([{ from: 0, to: 0, insert: "later " }]); }); await found(page, 100_000);
    expect(await page.evaluate(() => window.editingFixture.range(0, 11))).toBe("later const");
    await page.evaluate(() => { window.editingFixture.find("sample"); window.editingFixture.cancelFind(); window.editingFixture.edit([{ from: 0, to: 0, insert: "!" }]); });
    expect((await snapshot(page)).find.status).toBe("cancelled");
    await page.evaluate(() => { window.editingFixture.find("const"); window.editingFixture.dispose(); });
    expect((await snapshot(page)).diagnostics).toMatchObject({ resources: 0, documents: 0, subscriptions: 0, views: 0, leases: 0 });
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
