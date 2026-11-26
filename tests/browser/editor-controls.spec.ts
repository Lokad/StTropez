import { expect, test } from "./fixtures.ts";

test("clicking the rename status or disabled Apply keeps the next keystroke in the name field", async ({ page }) => {
    await page.goto("/controls/");
    const source = page.getByRole("textbox", { name: "colors.ts" });
    await expect(page.locator(".st-color-swatch")).toBeVisible();
    await source.press("Control+Home");
    await source.press("Control+ArrowRight");
    await source.press("ArrowRight");
    await source.press("F2");
    const dialog = page.getByRole("dialog", { name: "Rename symbol" });
    const name = dialog.getByRole("textbox", { name: "New name" });
    await name.fill("palette");
    await dialog.getByLabel("Rename status").click();
    await page.keyboard.type("s");
    await expect(name).toHaveValue("palettes");
    const apply = dialog.getByRole("button", { name: "Apply rename" });
    await expect(apply).toBeDisabled();
    await apply.click({ force: true });
    await page.keyboard.press("Enter");
    await expect(dialog.getByLabel("Rename edits")).toContainText("palettes");
    await expect(source).toHaveValue('const accent = "#5fae99";\nuse(accent);');
});

test("Escape dismisses the picker after clicking its edit preview", async ({ page }) => {
    await page.goto("/controls/");
    const source = page.getByRole("textbox", { name: "colors.ts" });
    await page.locator(".st-color-swatch").click();
    const dialog = page.getByRole("dialog", { name: "Color picker" });
    await dialog.locator("li").first().click();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(source).toBeFocused();
    await expect(source).toHaveValue('const accent = "#5fae99";\nuse(accent);');
});

test("Enter in a quick-fix list with no available action leaves the source intact", async ({ page }) => {
    await page.routeWebSocket("**/lsp-fixture", client => {
        const server = client.connectToServer();
        client.onMessage(packet => {
            const request = JSON.parse(packet.toString());
            if (request.method === "textDocument/codeAction") {
                client.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: [] }));
            } else server.send(packet);
        });
    });
    await page.goto("/controls/");
    await expect(page.locator(".st-color-swatch")).toBeVisible();
    const source = page.getByRole("textbox", { name: "colors.ts" });
    await source.press("Control+.");
    const panel = page.getByRole("region", { name: "Quick fixes" });
    await expect(panel.getByLabel("Quick-fix status")).toHaveText(/no .*actions/i);
    await page.keyboard.press("Enter");
    await expect(panel).toBeVisible();
    await expect(source).toHaveValue('const accent = "#5fae99";\nuse(accent);');
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
});
