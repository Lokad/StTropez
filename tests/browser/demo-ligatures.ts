import { expect, type Page } from "@playwright/test";

export async function checkDemoLigatures(page: Page, url: string) {
    await page.goto(url);
    const source = page.locator("#editor .st-viewport");
    const row = source.locator(".st-viewport-row").filter({ hasText: "const readyToShip" });
    await expect(row.locator(".demo-token-keyword").first()).toHaveText("const");
    expect(await page.evaluate(async () => (await document.fonts.load('14px "Fira Code"')).length)).toBe(1);
    await expect(row).toHaveCSS("font-family", /Fira Code/);
    const menu = page.locator("#view-menu summary"), toggle = page.locator("#view-ligatures");
    await expect(toggle).toBeChecked();

    // Compare painted ink: Fira Code keeps the same advance width in either mode.
    const crop = await row.evaluate(el => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const at = node.textContent!.indexOf("!==");
            if (at < 0) continue;
            const range = document.createRange();
            range.setStart(node, at); range.setEnd(node, at + 3);
            const box = range.getBoundingClientRect();
            return { x: Math.floor(box.x), y: Math.floor(box.y),
                width: Math.ceil(box.right) - Math.floor(box.x), height: Math.ceil(box.bottom) - Math.floor(box.y) };
        }
        throw new Error("Missing inequality operator.");
    });
    const ink = () => page.screenshot({ clip: crop });
    const toggleLigatures = async () => {
        await menu.click(); await toggle.click(); await menu.press("Escape");
    };
    const on = await ink();
    await toggleLigatures();
    expect((await ink()).equals(on)).toBe(false);
    await toggleLigatures();
    expect((await ink()).equals(on)).toBe(true);

    // Place the caret inside the painted ligature, then extend it by one source character.
    await page.mouse.click(crop.x + crop.width / 3, crop.y + crop.height / 2);
    const input = source.getByRole("textbox");
    await input.press("Shift+ArrowRight");
    await expect(row.locator(".st-viewport-selected")).toHaveText("=");
    expect(await input.evaluate(el => {
        const text = el as HTMLTextAreaElement;
        return text.value.slice(text.selectionStart - 1, text.selectionEnd + 1);
    })).toBe("!==");
}
