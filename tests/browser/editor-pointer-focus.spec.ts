import { expect, ready, test } from "./fixtures.ts";

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
    await clickAt(1, "middle");
    await expect(input).toBeFocused();
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
        await expect(viewport.locator(".st-viewport-row").first()).toHaveText(letter + "arget");
    }
});
