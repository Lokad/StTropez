import { expect, ready, test } from "./fixtures.ts";
import type { Page } from "@playwright/test";

async function textPoint(page: Page, offset: number) {
    const at = await page.evaluate(offset => window.editingFixture.coords(offset), offset);
    if (!at) throw new Error("Expected a visible text position");
    return { x: at.left + 1, y: at.top + at.height / 2 };
}

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

test("a click, modifier tap or selection change cancels Escape before Tab", async ({ page }) => {
    await page.goto("/editing/");
    await page.evaluate(() => window.editingFixture.setText("first\nsecond"));
    await ready(page);
    const input = page.getByRole("textbox", { name: "Primary source", exact: true });
    const editor = page.locator("#primary .st-editor");
    await input.focus();
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

test("typing after a native scrollbar drag or track click edits the selected source", async ({ page }, info) => {
    test.skip(info.project.name !== "chromium-scrollbars", "Requires a native scrollbar track.");
    await page.goto("/editing/");
    await page.evaluate(() => window.editingFixture.setText("target\n" + "body\n".repeat(500)));
    const input = page.getByRole("textbox", { name: "Primary source", exact: true });
    const viewport = page.locator("#primary .st-viewport");
    for (const gesture of ["drag", "track"]) {
        await page.evaluate(() => window.editingFixture.select("primary", { anchor: 0, head: 1 }));
        await input.focus();
        await ready(page);
        const track = await viewport.evaluate(el => {
            const rect = el.getBoundingClientRect();
            const left = rect.left + el.clientLeft + el.clientWidth;
            return { x: (left + rect.right - el.clientLeft) / 2, width: rect.right - el.clientLeft - left,
                top: rect.top + el.clientTop, height: el.clientHeight };
        });
        expect(track.width).toBeGreaterThan(2);
        const middle = track.top + track.height / 2;
        if (gesture === "drag") {
            await page.mouse.move(track.x, track.top + 23);
            await page.mouse.down();
            await page.mouse.move(track.x, middle, { steps: 8 });
            await page.mouse.up();
        } else await page.mouse.click(track.x, middle);
        await expect.poll(() => viewport.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
        await expect(input).toBeFocused();
        const letter = gesture === "drag" ? "D" : "T";
        await page.keyboard.type(letter);
        // Track clicks may keep animating after pointerup. Check the final painted row.
        await viewport.evaluate(el => new Promise<void>(resolve => {
            let quietFrames = 0;
            const moved = () => { quietFrames = 0; };
            el.addEventListener("scroll", moved);
            function frame(): void {
                if (++quietFrames < 4) requestAnimationFrame(frame);
                else { el.removeEventListener("scroll", moved); resolve(); }
            }
            requestAnimationFrame(frame);
        }));
        const edited = viewport.locator('.st-viewport-row[data-line="0"]');
        await expect(edited).toHaveText(letter + "arget");
        await expect(edited).toBeInViewport();
    }
});
