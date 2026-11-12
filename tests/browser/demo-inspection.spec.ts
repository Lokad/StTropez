import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function select(page: Page, query: string) {
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await source.press("Control+f"); await page.getByRole("textbox", { name: "Find text", exact: true }).fill(query);
    await expect(page.locator("#find-status")).toHaveText("1 matches"); await page.locator("#find-next").click();
    await page.getByRole("button", { name: "Close", exact: true }).click(); return source;
}
const hover = (page: Page) => page.locator(".demo-language-popups .host-symbol-info:not(.host-signature)");

test("real type inspection works from Code, keyboard and pointer without changing source or pointer focus", async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto("/"); await expect(page.locator("#language-status")).toHaveText("Language ready");
    const source = await select(page, "calculateTotal(cart"); await source.press("ArrowLeft"); await source.press("ArrowRight");
    await page.locator("#code-menu summary").click(); await page.getByRole("button", { name: "Inspect type", exact: true }).click();
    await expect(hover(page)).toContainText("calculateTotal(items: readonly CartItem[]"); await expect(source).toBeFocused();
    await expect(hover(page)).not.toContainText("```");
    await source.press("Escape"); await expect(hover(page)).toBeHidden();
    await source.press("Control+k"); await source.press("Control+i"); await expect(hover(page)).toContainText("discount");
    await source.press("Escape");
    const point = await page.locator("#editor .st-viewport-row").evaluateAll(rows => {
        for (const row of rows) {
            const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                const from = node.textContent?.indexOf("calculateTotal(cart") ?? -1;
                if (from >= 0) { const range = document.createRange(); range.setStart(node, from + 2); range.setEnd(node, from + 3); const box = range.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; }
            }
        }
        throw new Error("Function text is not rendered.");
    });
    await page.locator("#walkthrough-toggle").focus(); await page.mouse.move(point.x, point.y);
    await expect(hover(page)).toContainText("calculateTotal(items: readonly CartItem[]"); await expect(page.locator("#walkthrough-toggle")).toBeFocused();
    await page.mouse.move(2, 2); await expect(hover(page)).toBeHidden();
    await expect(page.locator("#files")).not.toContainText("●"); expect(errors).toEqual([]);
});

test("real signature help follows typed arguments and respects completion Escape priority", async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto("/"); await expect(page.locator("#language-status")).toHaveText("Language ready");
    const source = page.getByRole("textbox", { name: "main.ts", exact: true }), popup = page.getByRole("tooltip", { name: "Signature help", exact: true });
    await source.press("Control+End"); await source.pressSequentially("\ncalculateTotal(");
    await expect(popup).toContainText("calculateTotal"); await expect(popup.getByLabel("Active signature parameter")).toContainText("items");
    await source.pressSequentially("cart, "); await expect(popup.getByLabel("Active signature parameter")).toContainText("discount");
    await source.press("Control+Space"); await expect(page.locator(".demo-completion")).toBeVisible();
    await source.pressSequentially("Mat"); await expect(page.getByRole("option", { name: "Math", exact: true })).toBeVisible();
    await source.press("Escape"); await expect(page.locator(".demo-completion")).toBeHidden(); await expect(popup).toBeVisible();
    await source.press("Escape"); await expect(popup).toBeHidden();
    await source.press("Control+Shift+Space"); await expect(popup.getByLabel("Active signature parameter")).toContainText("discount");
    await page.getByRole("button", { name: "pricing.ts", exact: true }).click(); await expect(popup).toHaveCount(0);
    expect(errors).toEqual([]);
});

test("held real hover and signature replies cannot reopen a popup after edits or file changes", async ({ page }) => {
    let method = "textDocument/hover", held = false, release: (() => void) | undefined;
    await page.routeWebSocket("**/demo-provider/*", client => {
        const server = client.connectToServer(), pending = new Set<number>();
        client.onMessage(message => { const value = JSON.parse(message.toString()); if (value.method === method) pending.add(value.id); server.send(message); });
        server.onMessage(message => { const value = JSON.parse(message.toString()); if (!held && pending.has(value.id)) { held = true; release = () => client.send(message); } else client.send(message); });
    });
    await page.goto("/"); await expect(page.locator("#language-status")).toHaveText("Language ready");
    const source = await select(page, "calculateTotal(cart"); await source.press("ArrowLeft"); await source.press("ArrowRight");
    await source.press("Control+k"); await source.press("Control+i"); await expect.poll(() => held).toBe(true);
    await source.pressSequentially("x"); release!(); await expect(hover(page)).toBeHidden();
    method = "textDocument/signatureHelp"; held = false;
    await source.press("Control+End"); await source.pressSequentially("\ncalculateTotal("); await expect.poll(() => held).toBe(true);
    await page.getByRole("button", { name: "pricing.ts", exact: true }).click(); release!();
    await expect(page.getByRole("tooltip", { name: "Signature help", exact: true })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "pricing.ts", exact: true })).toBeVisible();
});
