import { expect, test } from "./fixtures.ts";

test("Replace all keeps typing in the replacement field after a click or shortcut", async ({ page }) => {
    await page.goto("/controls/");
    const source = page.getByRole("textbox", { name: "colors.ts" });
    await source.press("Control+h");
    const query = page.getByRole("textbox", { name: "Find text" });
    const replacement = page.getByRole("textbox", { name: "Replacement text" });
    const all = page.getByRole("button", { name: "Replace all", exact: true });
    await query.fill("accent");
    await replacement.fill("tone");
    await all.click();
    await expect(source).toHaveValue('const tone = "#5fae99";\nuse(tone);');
    await page.keyboard.type("s");
    await expect(replacement).toHaveValue("tones");
    await query.fill("tone");
    await expect(all).toBeEnabled();
    await query.press("Control+Alt+Enter");
    await expect(source).toHaveValue('const tones = "#5fae99";\nuse(tones);');
    await expect(replacement).toBeFocused();
});

test("accepting a completion keeps its visible line at the same scroll position", async ({ page }) => {
    await page.goto("/controls/");
    const source = page.getByRole("textbox", { name: "colors.ts" });
    await source.press("Control+a");
    await page.keyboard.insertText("sa\n".repeat(120));
    await source.press("Control+Home");
    const viewport = page.locator(".st-viewport");
    await viewport.evaluate(el => { el.scrollTop = 700; });
    const row = viewport.locator('.st-viewport-row[data-line="36"]');
    await row.click({ position: { x: 5, y: 5 } });
    await source.press("End");
    await source.press("Control+Space");
    await expect(page.getByRole("option", { name: "sample", exact: true })).toBeVisible();
    const top = await viewport.evaluate(el => el.scrollTop);
    expect(top).toBeGreaterThan(0);
    await source.press("Enter");
    await expect(row).toContainText("sample");
    expect(await viewport.evaluate(el => el.scrollTop)).toBe(top);
});

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
