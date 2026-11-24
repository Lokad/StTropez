import { expect, ready, test } from "./fixtures.ts";
import type { Page } from "@playwright/test";

async function textPoint(page: Page, offset: number) {
    const at = await page.evaluate(offset => window.editingFixture.coords(offset), offset);
    if (!at) throw new Error("Expected a visible text position");
    return { x: at.left + 1, y: at.top + at.height / 2 };
}

test.describe("fractional display scale", () => {
    test.use({ deviceScaleFactor: 1.25, viewport: { width: 1280, height: 800 } });
    test("a selection paints continuously across syntax tokens", async ({ page }) => {
        await page.goto("/editing/"); await ready(page);
        const source = page.getByRole("textbox", { name: "Primary source", exact: true });
        await source.press("Control+Home"); await source.press("ArrowDown"); await source.press("Home"); await source.press("Shift+End");
        await ready(page);
        const spans = await page.locator("#primary .st-viewport-selected").evaluateAll(nodes => nodes.map(node => {
            const { left, right, top } = node.getBoundingClientRect();
            return { left, right, top };
        }));
        expect(spans.length).toBeGreaterThan(1);
        const first = spans[0]!, last = spans.at(-1)!, x = Math.floor(first.left), y = Math.floor(first.top);
        const png = await page.screenshot({ clip: { x, y, width: Math.ceil(last.right) - x, height: 5 } });
        const colors = await page.evaluate(async ({ data, left, right, top }) => {
            const image = new Image(); image.src = "data:image/png;base64," + data; await image.decode();
            const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
            const ctx = canvas.getContext("2d")!; ctx.drawImage(image, 0, 0);
            const start = Math.round(left * devicePixelRatio), end = Math.round(right * devicePixelRatio);
            const pixels = ctx.getImageData(start, Math.round(top * devicePixelRatio), end - start, 1).data;
            const colors = new Set<string>();
            for (let i = 0; i < pixels.length; i += 4) colors.add(pixels.subarray(i, i + 3).join(","));
            return [...colors];
        }, { data: png.toString("base64"), left: first.left - x + 2, right: last.right - x - 2, top: first.top - y + 1.2 });
        expect(colors).toEqual(["36,73,107"]);
        await page.keyboard.type("X"); await expect(page.locator('#primary .st-viewport-row[data-line="1"]')).toHaveText("X");
    });
});

test("a click during a host edit places the next character in the clicked text", async ({ page }) => {
    await page.goto("/editing/"); await ready(page);
    await page.evaluate(() => window.editingFixture.setText("first\nsecond"));
    await ready(page);
    const point = await textPoint(page, 9);
    await page.evaluate(() => {
        document.querySelector("#primary")!.addEventListener("pointerdown", () => {
            window.editingFixture.edit([{ from: 0, to: 0, insert: "updated " }]);
        }, { capture: true, once: true });
    });
    await page.mouse.click(point.x, point.y);
    expect(await page.evaluate(() => window.editingFixture.selectionSet().ranges[0]?.head)).toBe(17);
    await page.keyboard.type("!");
    await expect(page.locator('#primary .st-viewport-row[data-line="1"]')).toHaveText("sec!ond");
});

test("three clicks select the line ending and four select the document", async ({ page }) => {
    await page.goto("/editing/");
    await page.evaluate(() => window.editingFixture.setText("one two\r\n\r\nlast"));
    await ready(page);
    const selection = () => page.evaluate(() => window.editingFixture.selectionSet().ranges[0]);
    for (const [offset, anchor, head] of [[2, 0, 9], [9, 9, 11], [13, 11, 15]] as const) {
        const at = await textPoint(page, offset);
        await page.mouse.click(at.x, at.y, { clickCount: 3 });
        expect(await selection()).toMatchObject({ anchor, head });
    }
    const last = await textPoint(page, 13);
    await page.mouse.click(last.x, last.y, { clickCount: 4 });
    expect(await selection()).toMatchObject({ anchor: 0, head: 15 });
    await expect(page.getByRole("textbox", { name: "Primary source", exact: true })).toBeFocused();
    await page.keyboard.type("X"); await expect(page.locator("#primary .st-viewport-row")).toHaveText(["X"]);
});

test("selecting an empty line paints its ending and active caret, including in forced colors", async ({ page, browserName }) => {
    await page.goto("/editing/"); await page.evaluate(() => window.editingFixture.setText("abc\r\n\r\nlast")); await ready(page);
    const input = page.getByRole("textbox", { name: "Primary source", exact: true }), root = page.locator("#primary");
    await input.focus(); await page.evaluate(() => window.editingFixture.select("primary", { anchor: 5, head: 5 }));
    await input.press("Shift+ArrowDown"); await ready(page);
    const breaks = root.locator(".st-selected-line-break"), caret = root.locator(".st-input-caret");
    await expect(breaks).toHaveCount(1); await expect(caret).toBeVisible();
    expect(await page.evaluate(() => window.editingFixture.selectionSet().ranges[0])).toMatchObject({ anchor: 5, head: 7 });
    const marker = await breaks.evaluate(node => {
        const paint = getComputedStyle(node, "::after");
        return { width: parseFloat(paint.width), height: parseFloat(paint.height), row: node.closest(".st-viewport-row")!.getBoundingClientRect().height };
    });
    expect(marker.width).toBeGreaterThan(2); expect(Math.abs(marker.height - marker.row)).toBeLessThan(1);
    await input.press("Control+Home"); await input.press("Shift+End"); await ready(page); await expect(breaks).toHaveCount(0);
    await input.press("Control+a"); await ready(page); await expect(breaks).toHaveCount(2); await expect(caret).toBeVisible();
    const heights = await root.locator(".st-viewport-selected").first().evaluate(span => ({
        selection: span.getBoundingClientRect().height, row: span.closest(".st-viewport-row")!.getBoundingClientRect().height
    }));
    expect(Math.abs(heights.selection - heights.row)).toBeLessThan(1);
    if (browserName === "chromium") {
        await page.emulateMedia({ forcedColors: "active" });
        const colors = await root.evaluate(root => {
            const row = root.querySelector(".st-viewport-row")!, selected = root.querySelector(".st-viewport-selected")!;
            const sample = (color: string) => { const el = document.createElement("span"); el.style.color = color; el.style.forcedColorAdjust = "none";
                root.append(el); const value = getComputedStyle(el).color; el.remove(); return value; };
            return { text: getComputedStyle(selected).color, fill: getComputedStyle(selected).backgroundColor,
                ending: getComputedStyle(row.querySelector(".st-selected-line-break")!, "::after").backgroundColor,
                caret: getComputedStyle(root.querySelector(".st-input-caret")!).backgroundColor,
                highlight: sample("Highlight"), foreground: sample("HighlightText"), ink: sample("CanvasText") };
        });
        expect(colors.fill).toBe(colors.highlight); expect(colors.ending).toBe(colors.highlight);
        expect(colors.text).toBe(colors.foreground); expect(colors.caret).toBe(colors.ink);
    }
    await page.keyboard.type("X"); await expect(root.locator(".st-viewport-row")).toHaveText(["X"]);
});

test("idle carets blink together and stay steady during typing, selection and reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" }); await page.goto("/editing/");
    await page.evaluate(() => window.editingFixture.setText("several carets")); await ready(page);
    const input = page.getByRole("textbox", { name: "Primary source", exact: true });
    await input.focus(); await page.evaluate(() => window.editingFixture.selections([{ anchor: 0, head: 0 }, { anchor: 8, head: 8 }]));
    const layer = page.locator("#primary .st-caret-layer");
    const opacity = () => layer.evaluate(node => getComputedStyle(node).opacity);
    await expect(layer.locator(".st-input-secondary-caret")).toHaveCount(1);
    await expect.poll(opacity, { intervals: [80] }).toBe("0");
    await page.keyboard.type("x"); await ready(page); expect(await opacity()).toBe("1");
    await input.press("Shift+ArrowRight"); await ready(page);
    expect(await layer.evaluate(node => node.getAnimations().length)).toBe(0); await expect(layer).toHaveCSS("opacity", "1");
    await page.emulateMedia({ reducedMotion: "reduce" }); await input.press("ArrowRight"); await ready(page);
    expect(await layer.evaluate(node => node.getAnimations().length)).toBe(0);
});

test("double and triple click drags extend by whole words and lines in both directions", async ({ page }) => {
    await page.goto("/editing/");
    await page.evaluate(() => window.editingFixture.setText("one two three\r\nnext four\nlast"));
    await ready(page);
    const start = await textPoint(page, 6), before = await textPoint(page, 1), after = await textPoint(page, 10);
    await page.mouse.click(start.x, start.y); await page.mouse.down({ clickCount: 2 });
    await page.mouse.move(after.x, after.y, { steps: 3 });
    const selection = () => page.evaluate(() => window.editingFixture.selectionSet().ranges[0]);
    expect(await selection()).toMatchObject({ anchor: 4, head: 13 });
    await page.mouse.move(before.x, before.y, { steps: 3 }); await page.mouse.up({ clickCount: 2 });
    expect(await selection()).toMatchObject({ anchor: 7, head: 0 });
    const middle = await textPoint(page, 17), end = await textPoint(page, 27);
    await page.mouse.dblclick(middle.x, middle.y); await page.mouse.down({ clickCount: 3 });
    await page.mouse.move(end.x, end.y, { steps: 3 });
    expect(await selection()).toMatchObject({ anchor: 15, head: 29 });
    await page.mouse.move(before.x, before.y, { steps: 3 }); await page.mouse.up({ clickCount: 3 });
    expect(await selection()).toMatchObject({ anchor: 25, head: 0 });
    await expect(page.getByRole("textbox", { name: "Primary source", exact: true })).toBeFocused();
    await page.keyboard.type("X"); await expect(page.locator("#primary .st-viewport-row")).toHaveText(["Xlast"]);
});

test("typing across a line-number boundary preserves the text origin and a hidden gutter gives its width back", async ({ page }) => {
    await page.goto("/editing/");
    const root = page.locator("#primary .st-editor"), input = root.locator("textarea");
    const origin = () => root.locator(".st-viewport-row").first().evaluate(el => el.getBoundingClientRect().left);
    for (const count of [9, 99, 999]) {
        await page.evaluate(n => window.editingFixture.setText("x\n".repeat(n - 1) + "end"), count); await ready(page);
        await input.press("Control+End"); await ready(page);
        const x = await origin();
        await input.press("Enter"); await page.keyboard.type("z"); await ready(page);
        await expect(root.locator(`.st-viewport-row[data-line="${count}"]`)).toHaveText("z");
        expect(await origin()).toBe(x);
        await input.press("Control+z"); await input.press("Control+z"); await ready(page);
        await expect(root.locator(`.st-viewport-row[data-line="${count - 1}"]`)).toHaveText("end");
        expect(await origin()).toBe(x);
    }
    const x = await origin(), width = (await root.locator(".st-viewport-gutter").boundingBox())!.width;
    await page.evaluate(() => window.editingFixture.configure({ gutter: false })); await ready(page);
    await expect(root.locator(".st-viewport-gutter")).toBeHidden(); expect(await origin()).toBeCloseTo(x - width);
    await page.keyboard.type("!"); await expect(root.locator('.st-viewport-row[data-line="998"]')).toHaveText("end!");
    await page.evaluate(() => window.editingFixture.configure({ gutter: true })); await ready(page);
    expect(await origin()).toBe(x); await expect(input).toBeFocused();
});

test("gutter selects complete source lines, extends backwards and scrolls with the editor", async ({ page }) => {
    await page.goto("/editing/");
    await page.evaluate(() => window.editingFixture.setText("first\r\n\r\nthird\r\nlast\r\n" + "more\r\n".repeat(90)));
    await ready(page);
    const root = page.locator("#primary .st-editor"), numbers = root.locator(".st-line-numbers span");
    const input = page.getByRole("textbox", { name: "Primary source", exact: true });
    const selection = () => page.evaluate(() => window.editingFixture.selectionSet().ranges[0]);
    const number = (value: string) => numbers.filter({ hasText: new RegExp("^" + value + "$") });
    await number("2").click();
    expect(await selection()).toMatchObject({ anchor: 7, head: 9 });
    await expect(input).toBeFocused();
    await number("4").click({ modifiers: ["Shift"] });
    expect(await selection()).toMatchObject({ anchor: 7, head: 22 });
    await number("3").hover(); await page.mouse.down(); await number("1").hover(); await page.mouse.up();
    expect(await selection()).toMatchObject({ anchor: 16, head: 0 });
    await page.keyboard.type("X"); await expect(root.locator('.st-viewport-row[data-line="0"]')).toHaveText("Xlast");
    await number("1").hover(); await page.mouse.wheel(0, 300);
    await expect.poll(() => root.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    await expect(input).toBeFocused();
});

test("Alt-click removes a caret or selection and leaves the last caret ready to type", async ({ page }) => {
    await page.goto("/editing/"); await page.evaluate(() => {
        const f = window.editingFixture; f.setText("abc\ndef\nghi");
        f.selections([{ anchor: 1, head: 1 }, { anchor: 4, head: 7 }]); f.focus("primary");
    }); await ready(page);
    const click = async (offset: number) => {
        const at = await textPoint(page, offset);
        await page.mouse.click(at.x, at.y);
    };
    await page.keyboard.down("Alt");
    try { await click(5); await click(10); await click(1); await click(10); }
    finally { await page.keyboard.up("Alt"); }
    const set = await page.evaluate(() => window.editingFixture.selectionSet());
    expect(set.ranges).toHaveLength(1); expect(set.ranges[0]).toMatchObject({ anchor: 10, head: 10 });
    await page.keyboard.type("X"); await expect(page.locator("#primary .st-viewport-row")).toHaveText(["abc", "def", "ghXi"]);
});

test("Escape keeps Tab in the editor after removing extra carets or an intervening gesture", async ({ page }) => {
    await page.goto("/editing/");
    await page.evaluate(() => window.editingFixture.setText("first\nsecond"));
    await ready(page);
    const input = page.getByRole("textbox", { name: "Primary source", exact: true });
    const editor = page.locator("#primary .st-editor");
    await input.press("Control+Home");
    const secondLine = await textPoint(page, 6);
    await page.keyboard.down("Alt");
    try { await page.mouse.click(secondLine.x, secondLine.y); }
    finally { await page.keyboard.up("Alt"); }
    expect((await page.evaluate(() => window.editingFixture.selectionSet())).ranges).toHaveLength(2);
    await page.keyboard.down("Escape"); await page.keyboard.down("Escape"); await page.keyboard.up("Escape");
    await page.keyboard.press("Tab");
    await expect(input).toBeFocused();
    await expect(editor.locator(".st-viewport-row")).toHaveText(["first", "    second"]);
    await input.press("Control+z");
    await expect(editor.locator(".st-viewport-row")).toHaveText(["first", "second"]);
    for (const gesture of ["Shift tap", "selection", "click"]) {
        await page.keyboard.press("Escape");
        await expect(editor).toHaveAttribute("data-st-tab-escape", "");
        await expect(editor).toHaveCSS("outline-style", "dashed");
        if (gesture === "Shift tap") await page.keyboard.press("Shift");
        else if (gesture === "selection") {
            await page.evaluate(() => window.editingFixture.select("primary", { anchor: 2, head: 2 }));
        } else {
            const point = await page.evaluate(() => window.editingFixture.coords(6));
            if (!point) throw new Error("Second line is outside the viewport");
            await page.mouse.click(point.left, point.top + point.height / 2);
        }
        await expect(editor).not.toHaveAttribute("data-st-tab-escape", "");
    }
    await page.keyboard.press("Tab");
    await page.keyboard.type("x y");
    await expect(input).toBeFocused();
    await expect(editor.locator(".st-viewport-row").nth(1)).toHaveJSProperty("textContent", "    x ysecond");
});

test("Shift-clicking on either side of a double-clicked word keeps the whole word", async ({ page }) => {
    await page.goto("/editing/"); await page.evaluate(() => window.editingFixture.setText("left center right")); await ready(page);
    const inside = await textPoint(page, 7); await page.mouse.dblclick(inside.x, inside.y);
    await page.keyboard.down("Shift");
    try {
        for (const [offset, anchor, head] of [[2, 11, 2], [15, 5, 15]] as const) {
            const at = await textPoint(page, offset); await page.mouse.click(at.x, at.y);
            expect(await page.evaluate(() => window.editingFixture.snapshot().primary.selection)).toMatchObject({ anchor, head });
        }
    } finally { await page.keyboard.up("Shift"); }
    await page.keyboard.type("X"); await expect(page.locator("#primary .st-viewport-row")).toHaveText("left Xht");
});

test("column drags edit visible rows together and keep the active corner", async ({ page }) => {
    const original = "012345\r\nx\r\nhidden\r\n012345";
    const last = original.lastIndexOf("012345");
    await page.goto("/comparison/");
    await page.evaluate(({ original, last }) => {
        const f = window.comparisonFixture;
        f.setText(original);
        const { view } = f.review.panes.working;
        view.folding.setRanges(view.folding.getSnapshot(), [{ id: "body", from: 8, to: last, collapsed: true }]);
        f.focus();
    }, { original, last });
    await ready(page);
    const state = () => page.evaluate(() => {
        const { ranges, primary } = window.comparisonFixture.review.panes.working.view.getSnapshot().selectionSet;
        return { ranges: ranges.map(r => [r.anchor, r.head]), primary };
    });
    const text = () => page.evaluate(() => {
        const f = window.comparisonFixture;
        return f.range(0, f.snapshot().working.length);
    });
    const [top, bottom] = await page.evaluate(last => [2, last + 5].map(at => {
        const p = window.comparisonFixture.review.panes.working.viewport.coordsAt(at)!;
        return { x: p.left + 1, y: p.top + p.height / 2 };
    }) as [{ x: number; y: number }, { x: number; y: number }], last);
    await page.keyboard.down("Shift"); await page.keyboard.down("Alt");
    await page.mouse.move(bottom.x, bottom.y); await page.mouse.down();
    await page.mouse.move(top.x, top.y, { steps: 5 }); await page.mouse.up();
    await page.keyboard.up("Alt"); await page.keyboard.up("Shift");
    const backwards = { ranges: [[5, 2], [last + 5, last + 2]], primary: 0 };
    expect(await state()).toEqual(backwards);
    await page.keyboard.type("Q"); expect(await text()).toBe("01Q5\r\nx\r\nhidden\r\n01Q5");
    await page.keyboard.press("Control+z"); expect(await text()).toBe(original); expect(await state()).toEqual(backwards);

    await page.evaluate(() => window.comparisonFixture.readOnly(true));
    await page.mouse.move(top.x, top.y); await page.mouse.down({ button: "middle" });
    await page.mouse.move(top.x, bottom.y, { steps: 5 }); await page.mouse.up({ button: "middle" });
    expect(await state()).toEqual({ ranges: [[2, 2], [last + 2, last + 2]], primary: 1 });
    await page.keyboard.type("!"); expect(await text()).toBe(original);
    await page.evaluate(() => window.comparisonFixture.readOnly(false));
    await page.keyboard.type("!"); expect(await text()).toBe("01!2345\r\nx\r\nhidden\r\n01!2345");
});

test("a scrolled column drag replaces graphemes on every crossed row and undoes in one step", async ({ page }) => {
    const row = "A\t🍎AZ\n", first = 502, last = first + 192;
    await page.goto("/editing/");
    await page.evaluate(row => { const f = window.editingFixture; f.setText(row.repeat(1000)); f.focus("primary"); }, row);
    const root = page.locator("#primary .st-viewport");
    const scrollTo = async (line: number) => {
        await root.evaluate((node, line) => { node.scrollTop = (line - 2) * window.editingFixture.snapshot().primary.viewport.lineHeight; }, line);
        await expect(root.locator(`.st-viewport-row[data-line="${line}"]`)).toBeVisible(); await ready(page);
    };
    async function drag(beforeMove?: () => Promise<void>) {
        await scrollTo(first);
        const from = await textPoint(page, first * row.length + 2);
        await page.keyboard.down("Shift"); await page.keyboard.down("Alt");
        await page.mouse.move(from.x, from.y); await page.mouse.down();
        await scrollTo(last);
        const to = await textPoint(page, last * row.length + 4);
        await beforeMove?.();
        await page.mouse.move(to.x, to.y); await page.mouse.up();
        await page.keyboard.up("Alt"); await page.keyboard.up("Shift");
    }
    await drag();
    await page.keyboard.type("X"); await ready(page);
    const changed = row + "A\tXAZ\n".repeat(last - first + 1) + row;
    const start = (first - 1) * row.length;
    const read = (length: number) => page.evaluate(({ start, length }) => window.editingFixture.range(start, start + length), { start, length });
    expect(await read(changed.length)).toBe(changed);
    await page.keyboard.press("Control+z"); await ready(page);
    const original = row.repeat(last - first + 3);
    expect(await read(original.length)).toBe(original);

    // The host changes the selection after pointermove queues the remaining rows.
    await drag(() => root.evaluate((node, at) => node.addEventListener("pointermove", () => {
        const f = window.editingFixture;
        if (!f.snapshot().primary.pendingCommand) throw new Error("Expected pending column measurements");
        f.selections([{ anchor: at, head: at }]);
    }, { once: true }), last * row.length + 5));
    await page.keyboard.type("!"); await ready(page);
    expect(await read(original.length + 1)).toBe(row.repeat(last - first + 1) + "A\t🍎A!Z\n" + row);
    expect(await page.evaluate(() => window.editingFixture.snapshot().document!.exports)).toBe(0);
});

test("right-click targets the word under the pointer and preserves a selection clicked inside", async ({ page }) => {
    await page.goto("/editing/");
    await page.evaluate(() => window.editingFixture.setText("first line\nsecond line"));
    await ready(page);
    const input = page.getByRole("textbox", { name: "Primary source", exact: true });
    const rows = page.locator("#primary .st-viewport-row");
    const clickAt = async (offset: number, button: "left" | "right" | "middle") => {
        const point = await page.evaluate(offset => window.editingFixture.coords(offset), offset);
        if (!point) throw new Error("Source offset is outside the viewport");
        await page.mouse.click(point.left, point.top + point.height / 2, { button });
    };
    await clickAt(2, "left");
    await clickAt(14, "right");
    await expect(input).toBeFocused();
    await page.keyboard.type("Z");
    await expect(rows.nth(1)).toHaveText("secZond line");
    await page.evaluate(() => window.editingFixture.select("primary", { anchor: 5, head: 0 }));
    await ready(page);
    await clickAt(2, "right");
    await expect(input).toBeFocused();
    await page.keyboard.type("Y");
    await expect(rows.first()).toHaveText("Y line");
    // Linux may paste the primary selection on middle-click. This check owns focus and
    // caret placement. Leave clipboard integration to the separate device workflow.
    await input.evaluate(node => {
        const blockPaste = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
        node.ownerDocument.addEventListener("paste", blockPaste, { capture: true, once: true });
    });
    await clickAt(1, "middle");
    await expect(input).toBeFocused();
    expect(await page.evaluate(() => window.editingFixture.snapshot().primary.selection)).toMatchObject({ anchor: 1, head: 1 });
    await page.keyboard.type("X");
    await expect(rows.first()).toHaveText("YX line");
});
