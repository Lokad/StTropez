import { test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
import { holdDemoFolds } from "./demo-folding-gate.ts";

async function symbol(page: Page) {
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await source.press("Control+f"); await page.getByRole("textbox", { name: "Find text", exact: true }).fill("calculateTotal(cart");
    await expect(page.locator("#find-status")).toHaveText("1 matches"); await page.locator("#find-next").click();
    await page.getByRole("button", { name: "Close", exact: true }).click(); await source.press("ArrowLeft"); await source.press("ArrowRight"); return source;
}
async function ready(page: Page) {
    await page.goto("/");
    // Provider setup is a correctness prerequisite; its latency is measured separately.
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
}

test("real definition and reference navigation open the captured file and range without changing text", async ({ page }) => {
    const releaseFolds = await holdDemoFolds(page, "pricing.ts");
    await ready(page); const source = await symbol(page); await source.press("F12");
    const pricing = page.getByRole("textbox", { name: "pricing.ts", exact: true }); await expect(pricing).toBeFocused();
    expect(await pricing.evaluate(node => { const input = node as HTMLTextAreaElement; return input.value.slice(input.selectionStart, input.selectionEnd); })).toBe("calculateTotal");
    await page.locator("#code-menu summary").click(); await page.getByRole("button", { name: "Find references", exact: true }).click();
    const locations = page.getByRole("region", { name: "Symbol locations", exact: true });
    await expect(locations.getByRole("button", { name: /^main.ts ·/ }).first()).toBeVisible();
    await releaseFolds();
    await expect(page.locator("#editor .st-fold-button").first()).toBeVisible();
    await expect(locations).toBeVisible();
    await locations.getByRole("button", { name: /^main.ts ·/ }).last().click();
    await expect(page.getByRole("textbox", { name: "main.ts", exact: true })).toBeFocused();
    await expect(page.locator("#files")).not.toContainText("●");
    await page.getByRole("textbox", { name: "main.ts", exact: true }).press("Shift+F12");
    await expect(locations.getByRole("button", { name: /^pricing.ts ·/ })).toBeVisible();
    await page.getByRole("textbox", { name: "main.ts", exact: true }).press("ArrowDown");
    await expect(locations.locator('[data-location="1"]')).toHaveAttribute("data-chosen", "true");
    await page.getByRole("textbox", { name: "main.ts", exact: true }).press("Enter"); await expect(locations).toBeHidden();
    if (await pricing.count()) await page.locator('[data-file="main.ts"]').click();
    await page.getByRole("textbox", { name: "main.ts", exact: true }).press("Control+End");
    await page.locator("#code-menu summary").click(); await page.getByRole("button", { name: "Go to definition", exact: true }).click();
    await expect(locations).toContainText("No definition in this sample.");
    await page.getByRole("textbox", { name: "main.ts", exact: true }).press("Escape"); await expect(locations).toBeHidden();
});

test("real rename previews a captured name, rejects an old name and shares one undo across files", async ({ page }) => {
    const releaseFolds = await holdDemoFolds(page, "pricing.ts");
    await ready(page); const source = await symbol(page); await source.press("F12");
    const pricing = page.getByRole("textbox", { name: "pricing.ts", exact: true }); await expect(pricing).toBeFocused();
    await page.locator("#code-menu summary").click(); await page.getByRole("button", { name: "Rename symbol", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Rename symbol", exact: true }), name = dialog.getByRole("textbox", { name: "New name", exact: true });
    await expect(name).toHaveValue("calculateTotal"); await expect(name).toBeFocused(); await name.fill("cartTotal");
    await dialog.getByRole("button", { name: "Preview rename", exact: true }).click();
    const apply = dialog.getByRole("button", { name: "Apply rename", exact: true }); await expect(apply).toBeEnabled();
    await releaseFolds(); await expect(page.locator("#editor .st-fold-button").first()).toBeVisible(); await expect(apply).toBeEnabled();
    await expect(dialog.getByLabel("Rename edits")).toContainText("main.ts"); await expect(dialog.getByLabel("Rename edits")).toContainText("pricing.ts");
    await name.fill("basketTotal"); await expect(apply).toBeDisabled();
    await name.press("Enter"); await expect(apply).toBeEnabled(); await expect(dialog.getByLabel("Rename edits")).toContainText("basketTotal");
    await apply.click(); await expect(dialog).toBeHidden(); await expect(pricing).toBeFocused();
    await expect(page.locator("#editor")).toContainText("export function basketTotal(");
    await page.locator('[data-file="main.ts"]').click(); await expect(page.locator("#editor")).toContainText("basketTotal(cart, 0.1)");
    await source.press("Control+z"); await expect(page.locator("#editor")).toContainText("calculateTotal(cart, 0.1)");
    await expect(page.locator("#files")).not.toContainText("●");
    await source.press("Control+y"); await expect(page.locator("#editor")).toContainText("basketTotal(cart, 0.1)");
    await page.locator('[data-file="pricing.ts"]').click(); await expect(page.locator("#editor")).toContainText("export function basketTotal(");
});

test("held real definition replies cannot follow a later file and typing target", async ({ page }) => {
    let held = false, release: (() => void) | undefined;
    await page.routeWebSocket("**/demo-provider/*", client => {
        const server = client.connectToServer(), ids = new Set<number>();
        client.onMessage(message => { const value = JSON.parse(message.toString()); if (value.method === "textDocument/definition") ids.add(value.id); server.send(message); });
        server.onMessage(message => { const value = JSON.parse(message.toString()); if (!held && ids.has(value.id)) { held = true; release = () => client.send(message); } else client.send(message); });
    });
    await ready(page); const source = await symbol(page); await source.press("F12"); await expect.poll(() => held).toBe(true);
    await page.locator('[data-file="pricing.ts"]').click(); const pricing = page.getByRole("textbox", { name: "pricing.ts", exact: true });
    await pricing.press("Control+Home"); await pricing.pressSequentially("// Keep my current helper\n"); release!();
    await expect(pricing).toBeFocused(); await expect(page.locator("#editor")).toContainText("// Keep my current helper");
    await expect(page.locator(".demo-symbols")).toBeHidden();
});

test("typing invalidates a held rename preview while retaining the actual edit", async ({ page }) => {
    let held = false, release: (() => void) | undefined;
    await page.routeWebSocket("**/demo-provider/*", client => {
        const server = client.connectToServer(), ids = new Set<number>();
        client.onMessage(message => { const value = JSON.parse(message.toString()); if (value.method === "textDocument/rename") ids.add(value.id); server.send(message); });
        server.onMessage(message => { const value = JSON.parse(message.toString()); if (!held && ids.has(value.id)) { held = true; release = () => client.send(message); } else client.send(message); });
    });
    await ready(page); const source = await symbol(page); await source.press("F2");
    const dialog = page.getByRole("dialog", { name: "Rename symbol", exact: true });
    await dialog.getByRole("textbox", { name: "New name", exact: true }).fill("cartTotal");
    await dialog.getByRole("button", { name: "Preview rename", exact: true }).click(); await expect.poll(() => held).toBe(true);
    await source.press("Control+Home"); await source.pressSequentially("// Actual edit\n"); release!();
    await expect(dialog.getByRole("button", { name: "Apply rename", exact: true })).toBeDisabled();
    await expect(page.locator("#editor")).toContainText("// Actual edit"); await expect(page.locator("#editor")).toContainText("calculateTotal(cart, 0.1)");
    await expect(page.locator("#editor")).not.toContainText("cartTotal");
    await dialog.getByRole("button", { name: "Cancel rename", exact: true }).click(); await expect(source).toBeFocused();
});

test("real provider restart cancels a rename and resynchronizes edits without remounting the input", async ({ page }) => {
    let held = false, disconnect: (() => void) | undefined;
    await page.routeWebSocket("**/demo-provider/*", client => {
        const server = client.connectToServer(), ids = new Set<number>();
        client.onMessage(message => { const value = JSON.parse(message.toString()); if (value.method === "textDocument/rename") ids.add(value.id); server.send(message); });
        server.onMessage(message => { const value = JSON.parse(message.toString()); if (!held && ids.has(value.id)) { held = true; disconnect = () => client.close({ code: 1011, reason: "Provider restart" }); } else client.send(message); });
    });
    await ready(page); const source = await symbol(page); await source.press("F2");
    const dialog = page.getByRole("dialog", { name: "Rename symbol", exact: true });
    await dialog.getByRole("textbox", { name: "New name", exact: true }).fill("cartTotal");
    await dialog.getByRole("button", { name: "Preview rename", exact: true }).click(); await expect.poll(() => held).toBe(true);
    disconnect!(); await expect(page.locator("#language-status")).toHaveText("Language service unavailable");
    await source.press("Control+Home"); await source.pressSequentially("// Retain offline edit\n");
    const input = await source.elementHandle();
    await page.getByRole("button", { name: "Retry language service", exact: true }).click();
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    expect(await input!.evaluate(node => node.isConnected)).toBe(true);
    await expect(dialog).toHaveCount(0); await expect(page.locator("#editor")).toContainText("// Retain offline edit");
    await source.press("Control+End"); await source.pressSequentially("\ncart.ma");
    await expect(page.getByRole("option", { name: "map", exact: true })).toBeVisible();
    await expect(page.locator("#editor")).not.toContainText("cartTotal");
});
