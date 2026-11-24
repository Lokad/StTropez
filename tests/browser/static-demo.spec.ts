import { expect, test } from "./fixtures.ts";
import { latch } from "../helpers/latch.ts";
import { runDemoWalkthrough } from "./demo-walkthrough.ts";

test("browser-only demo completes the real editing and review walkthrough below a repository path", async ({ page, baseURL }) => {
    const requests: string[] = [], sockets: string[] = [];
    page.on("request", request => requests.push(request.url())); page.on("websocket", socket => sockets.push(socket.url()));
    await runDemoWalkthrough(page, baseURL!);
    expect(sockets).toEqual([]);
    const root = new URL(baseURL!);
    expect(requests.every(request => { const url = new URL(request); return url.origin === root.origin && url.pathname.startsWith(root.pathname); })).toBe(true);
    expect(requests.some(request => new URL(request).pathname.includes("demo-provider"))).toBe(false);
});

test("browser worker failure leaves typing/save usable and Retry synchronizes the latest code", async ({ page, baseURL }) => {
    let block = true; const retry = latch<void>();
    await page.route("**/demo-language-worker.js", async route => {
        if (block) await route.abort();
        else { await retry.promise; await route.continue(); }
    });
    await page.goto(baseURL!); await expect(page.locator("#language-status")).toHaveText("Language service unavailable");
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await source.press("Control+End"); await source.pressSequentially("\n// Saved while provider unavailable"); await source.press("Control+s");
    await expect(page.locator("#status")).toContainText("Saved in this browser");
    block = false; await page.getByRole("button", { name: "Retry language service", exact: true }).click();
    try {
        await source.press("Control+End"); await source.pressSequentially("\nMath.ma"); await source.press("Control+Space");
        await expect(page.getByLabel("Language command", { exact: true })).toContainText("completions");
    } finally { retry.resolve(); }
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    await expect(page.locator("#editor")).toContainText("// Saved while provider unavailable");
    await expect(page.getByRole("option", { name: "max", exact: true })).toBeVisible();
    await page.getByRole("option", { name: "max", exact: true }).click(); await expect(page.locator("#editor")).toContainText("Math.max");
});
