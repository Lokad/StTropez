import { expect, test } from "./fixtures.ts";
import { runDemoHostIntegrations } from "./demo-host-integrations.ts";

test("host language, structured/literal insertion and mapped notes share editing and review", async ({ page }) => {
    await runDemoHostIntegrations(page);
});

test("failed and late shadow styles leave the current editor usable and allow retry", async ({ page, browserErrors }) => {
    let requests = 0, release: (() => Promise<void>) | undefined;
    await page.route("**/app.css", async route => {
        if (route.request().resourceType() !== "fetch") { await route.continue(); return; }
        requests++;
        if (requests === 1) { await route.fulfill({ status: 503, body: "Styles temporarily unavailable" }); return; }
        if (requests === 2) await new Promise<void>(resolve => { release = async () => { await route.continue(); resolve(); }; });
        else await route.continue();
    });
    await page.goto("/"); const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    const original = await source.inputValue();
    browserErrors.allowConsoleError("Failed to load resource: the server responded with a status of 503 (Service Unavailable)", new URL("app.css", page.url()).href);
    await page.locator("#sample").selectOption("host");
    await expect(page.locator("#status")).toContainText("Host styles could not load");
    await expect(source).toHaveValue(original); await expect(page.locator("#sample")).toHaveValue("pricing");
    await page.locator("#sample").selectOption("host"); await expect.poll(() => release !== undefined).toBe(true);
    await expect(page.locator("#sample")).toBeEnabled(); await source.press("Control+End"); await page.keyboard.type("// still editable");
    // The native input contains a bounded context around the caret, not the complete document.
    await expect(source).toHaveValue(/\/\/ still editable$/);
    await expect(page.locator("#editor .st-viewport-row").last()).toContainText("// still editable");
    await page.locator("#sample").selectOption("unicode"); await expect(page.getByRole("textbox", { name: "greetings.ts", exact: true })).toBeVisible();
    const response = page.waitForResponse(response => response.url().endsWith("/app.css") && response.request().resourceType() === "fetch");
    await release!(); await (await response).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator("#sample")).toHaveValue("unicode"); await expect(page.locator(".demo-shadow-surface")).toHaveCount(0);
    await page.locator("#sample").selectOption("host"); await expect(page.getByRole("textbox", { name: "workflow.rules", exact: true })).toBeVisible();
    await expect(page.locator(".demo-shadow-surface")).toHaveCount(1); expect(requests).toBe(2);
});

test("a pending shadow mount preserves composition begun in the current editor", async ({ page }) => {
    let release: (() => Promise<void>) | undefined;
    await page.route("**/app.css", async route => {
        if (route.request().resourceType() !== "fetch") { await route.continue(); return; }
        await new Promise<void>(resolve => { release = async () => { await route.continue(); resolve(); }; });
    });
    await page.goto("/"); const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await page.locator("#sample").selectOption("host"); await expect.poll(() => release !== undefined).toBe(true);
    await source.focus(); await source.dispatchEvent("compositionstart", { data: "" });
    const response = page.waitForResponse(response => response.url().endsWith("/app.css") && response.request().resourceType() === "fetch");
    await release!(); await (await response).finished();
    await expect(page.locator("#sample")).toHaveValue("pricing"); await expect(source).toBeFocused();
    await expect(page.locator("#sample")).toBeEnabled(); await expect(page.locator(".demo-shadow-surface")).toHaveCount(0);
    await source.dispatchEvent("compositionend", { data: "" });
    await page.locator("#sample").selectOption("host"); await expect(page.getByRole("textbox", { name: "workflow.rules", exact: true })).toBeVisible();
});
