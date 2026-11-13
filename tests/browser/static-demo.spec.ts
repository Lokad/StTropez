import { expect, test } from "@playwright/test";
import { runDemoConflict, runDemoWalkthrough } from "./demo-walkthrough.ts";

test("browser-only demo completes the real editing and review walkthrough below a repository path", async ({ page, baseURL }) => {
    const requests: string[] = [], sockets: string[] = [];
    page.on("request", request => requests.push(request.url())); page.on("websocket", socket => sockets.push(socket.url()));
    await runDemoWalkthrough(page, baseURL!);
    expect(sockets).toEqual([]);
    const root = new URL(baseURL!);
    expect(requests.every(request => { const url = new URL(request); return url.origin === root.origin && url.pathname.startsWith(root.pathname); })).toBe(true);
    expect(requests.some(request => new URL(request).pathname.includes("demo-provider"))).toBe(false);
});

test("browser-only providers retain two-page save/conflict and recovery ownership", async ({ page, baseURL }) => {
    await runDemoConflict(page, baseURL!);
});

test("browser global completion refreshes its bounded page after a typed prefix", async ({ page, baseURL }) => {
    await page.goto(baseURL!); await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await source.press("Control+End"); await source.pressSequentially("\ncalculateTotal(cart, ");
    await source.press("Control+Space"); await expect(page.getByRole("listbox", { name: "Completions", exact: true })).toBeVisible();
    await source.pressSequentially("Mat"); await expect(page.getByRole("option", { name: "Math", exact: true })).toBeVisible();
    await source.press("Escape"); await expect(page.getByRole("listbox", { name: "Completions", exact: true })).toBeHidden();
    await expect(source).toBeFocused();
});

test("browser worker failure leaves typing/save usable and Retry synchronizes the latest code", async ({ page, baseURL }) => {
    let block = true;
    await page.route("**/demo-language-worker.js", route => block ? route.abort() : route.continue());
    await page.goto(baseURL!); await expect(page.locator("#language-status")).toHaveText("Language service unavailable");
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await source.press("Control+End"); await source.pressSequentially("\n// Saved while provider unavailable"); await source.press("Control+s");
    await expect(page.locator("#status")).toContainText("Saved in this browser");
    block = false; await page.getByRole("button", { name: "Retry language service", exact: true }).click();
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    await expect(page.locator("#editor")).toContainText("// Saved while provider unavailable");
    await source.press("Control+End"); await source.pressSequentially("\nMath.ma"); await source.press("Escape"); await source.press("Control+Space");
    await expect(page.getByRole("option", { name: "max", exact: true })).toBeVisible();
    await page.getByRole("option", { name: "max", exact: true }).click(); await expect(page.locator("#editor")).toContainText("Math.max");
});

test("large browser-only sample keeps editing/navigation/history and current language feedback", async ({ page, baseURL }) => {
    await page.goto(baseURL!); await page.locator("#sample").selectOption("large");
    const source = page.getByRole("textbox", { name: "large.ts", exact: true });
    await expect(source).toBeVisible(); await source.press("Control+End"); await source.pressSequentially("\nMath.ma");
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    await source.press("Escape"); await source.press("Control+Space"); await expect(page.getByRole("option", { name: "max", exact: true })).toBeVisible();
    await page.getByRole("option", { name: "max", exact: true }).click(); await expect(page.locator("#editor")).toContainText("Math.max");
    await source.press("Control+z"); await expect(page.locator("#editor")).toContainText("Math.ma"); await source.press("Control+y");
    await expect(page.locator("#editor")).toContainText("Math.max"); await source.press("Control+s"); await expect(page.locator("#status")).toContainText("Saved in this browser");
    expect(await source.evaluate(input => (input as HTMLTextAreaElement).value.length)).toBeLessThanOrEqual(2600);
    expect(await page.locator("#editor .st-viewport-row").count()).toBeLessThan(60);
});
