import { test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
import { runDemoActions } from "./demo-walkthrough.ts";

test("broader project actions retain preview, stale recovery and atomic multi-file history", async ({ page }) => { await runDemoActions(page); });

async function openDemo(page: Page) {
    await page.goto("/"); await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
}
async function typo(page: Page, selectProblem = true) {
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await source.press("Control+f"); await page.getByRole("textbox", { name: "Find text", exact: true }).fill("calculateTotal(cart");
    await expect(page.locator(".st-find-status")).toHaveText("1 of 1"); await page.locator(".st-find-next").click();
    await page.getByRole("button", { name: "Close", exact: true }).click(); await source.pressSequentially("calculateTotl(cart");
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    await page.locator('[data-panel="problems"]').click();
    if (selectProblem) await page.getByRole("button", { name: /main\.ts:\d+:\d+ · TS2552:/ }).click();
    return source;
}

test("selecting a real spelling fix applies once and shares undo/redo with actual typing", async ({ page }) => {
    const requests = new Set<number>(), replies: number[] = [];
    page.on("websocket", socket => {
        socket.on("framesent", ({ payload }) => {
            const message = JSON.parse(payload.toString());
            if (message.method === "textDocument/codeAction") requests.add(message.id);
        });
        socket.on("framereceived", ({ payload }) => {
            const message = JSON.parse(payload.toString());
            if (requests.has(message.id) && Array.isArray(message.result)) replies.push(message.result.length);
        });
    });
    await openDemo(page); const source = await typo(page, false);
    await page.locator('[data-file="pricing.ts"]').click();
    const problem = page.locator(".demo-problem").filter({ hasText: /main\.ts:\d+:\d+ · TS2552:/ });
    const popup = page.getByRole("region", { name: "Quick fixes", exact: true });
    expect(requests.size).toBe(0);
    await problem.getByRole("button", { name: /TS2552:/ }).click();
    const review = problem.getByRole("button", { name: /Review fix: Change spelling to 'calculateTotal'/ });
    await expect(review).toBeVisible();
    await expect(source).toBeFocused();
    await expect(popup).toBeHidden();
    await review.click();
    await expect(source).toBeFocused();
    await expect(popup.getByRole("button", { name: "Change spelling to 'calculateTotal'", exact: true })).toBeVisible();
    await expect.poll(async () => {
        const selection = await page.locator("#editor .st-viewport-selected").first().boundingBox(), box = await popup.boundingBox();
        return selection && box ? Math.abs(box.y - selection.y) : Infinity;
    }).toBeLessThan(80);
    await expect(popup.locator("del")).toHaveText("calculateTotl"); await expect(popup.locator("ins")).toHaveText("calculateTotal");
    await expect(page.locator("#editor")).toContainText("calculateTotl(cart, 0.1)");
    await popup.getByRole("button", { name: "Change spelling to 'calculateTotal'", exact: true }).click(); await expect(popup).toBeHidden(); await expect(source).toBeFocused();
    await expect(page.locator("#editor")).toContainText("calculateTotal(cart, 0.1)");
    await expect(page.locator("#panel-content")).toHaveText("No problems in this project.");
    await source.press("Control+z"); await expect(page.locator("#editor")).toContainText("calculateTotl(cart, 0.1)");
    await source.press("Control+y"); await expect(page.locator("#editor")).toContainText("calculateTotal(cart, 0.1)");
    await source.press("Control+End");
    await page.keyboard.insertText("\nconst broken = ;");
    const syntax = page.getByRole("button", { name: /main\.ts:\d+:\d+ · TS1109:/ });
    await expect(syntax).toBeEnabled();
    expect(replies).toEqual([1]);
    await syntax.click();
    await expect.poll(() => replies).toEqual([1, 0]);
    await expect(page.locator(".problem-metadata button")).toHaveCount(0);
    await expect(popup).toBeHidden();
    await expect(source).toBeFocused();
});

test("held real fixes cannot replace newer text or follow later file focus", async ({ page }) => {
    let held = false, release: (() => void) | undefined;
    await page.routeWebSocket("**/demo-provider/*", client => {
        const server = client.connectToServer(), ids = new Set<number>();
        client.onMessage(message => { const value = JSON.parse(message.toString()); if (value.method === "textDocument/codeAction") ids.add(value.id); server.send(message); });
        server.onMessage(message => { const value = JSON.parse(message.toString()); if (!held && ids.has(value.id)) { held = true; release = () => client.send(message); } else client.send(message); });
    });
    await openDemo(page); const source = await typo(page); await expect.poll(() => held).toBe(true);
    await source.press("Control+Home"); await source.pressSequentially("// Keep current text\n");
    await page.locator('[data-file="pricing.ts"]').click(); const pricing = page.getByRole("textbox", { name: "pricing.ts", exact: true });
    await pricing.press("Control+Home"); await pricing.pressSequentially("// Keep helper focus\n"); release!();
    await expect(pricing).toBeFocused(); await expect(page.getByRole("region", { name: "Quick fixes", exact: true })).toBeHidden();
    await expect(page.locator(".demo-problems").getByRole("button", { name: /^Review.*fix/i })).toHaveCount(0);
    await expect(page.locator("#editor")).toContainText("// Keep helper focus");
    await page.locator('[data-file="main.ts"]').click(); await expect(page.locator("#editor")).toContainText("// Keep current text");
    await expect(page.locator("#editor")).toContainText("calculateTotl(cart, 0.1)");
});

test("explicit lazy fix activation applies once after resolution and expires with later typing", async ({ page }) => {
    // A generic delayed LSP wrapper around a real compiler fix supplies the lazy shape.
    let release: (() => void) | undefined, resolutions = 0;
    let holdList = false;
    let deliverList: (() => void) | undefined;
    await page.routeWebSocket("**/demo-provider/*", client => {
        const server = client.connectToServer(), requests = new Map<number, string>(); let edit: unknown;
        client.onMessage(message => {
            const value = JSON.parse(message.toString()); requests.set(value.id, value.method);
            if (value.method === "codeAction/resolve") { resolutions++; release = () => client.send(JSON.stringify({ jsonrpc: "2.0", id: value.id, result: { ...value.params, edit } })); }
            else server.send(message);
        });
        server.onMessage(message => {
            const value = JSON.parse(message.toString()), method = requests.get(value.id);
            if (method === "initialize" && value.result) value.result.capabilities.codeActionProvider = { resolveProvider: true };
            if (method === "textDocument/codeAction" && Array.isArray(value.result)) {
                edit = value.result.find((action: { edit?: unknown }) => action.edit)?.edit;
                value.result = [{ title: "Resolve spelling fix", kind: "quickfix", data: { fixture: "lazy-spelling" } }];
                if (holdList) {
                    holdList = false;
                    deliverList = () => client.send(JSON.stringify(value));
                    return;
                }
            }
            client.send(JSON.stringify(value));
        });
    });
    await openDemo(page);
    const source = await typo(page);
    await expect(page.getByRole("button", { name: "Review fix: Resolve spelling fix" })).toBeVisible();
    const original = await source.inputValue();
    holdList = true;
    await source.press("Control+.");
    const popup = page.getByRole("region", { name: "Quick fixes", exact: true });
    const choice = popup.getByRole("button", { name: "Resolve spelling fix", exact: true });
    await expect.poll(() => !!deliverList).toBe(true);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(source).toHaveValue(original);
    expect(await source.evaluate((field: HTMLTextAreaElement) =>
        field.value.slice(field.selectionStart, field.selectionEnd))).toBe("calculateTotl");
    await expect(popup).toContainText("Requesting code actions.");
    deliverList!();
    await expect(choice).toBeVisible();
    expect(resolutions).toBe(0);
    await choice.click();
    await expect.poll(() => resolutions).toBe(1);
    await page.keyboard.press("Enter");
    await expect(source).toHaveValue(original);
    await expect(page.locator("#editor")).toContainText("calculateTotl(cart, 0.1)");
    await page.locator("#find-toggle").click();
    const query = page.getByRole("textbox", { name: "Find text", exact: true });
    await expect(query).toBeFocused();
    release!();
    await expect(popup).toBeHidden(); await expect(page.locator("#editor")).toContainText("calculateTotal(cart, 0.1)");
    await page.keyboard.insertText("pricing");
    await expect(query).toHaveValue("pricing");
    await query.press("Escape");
    await source.press("Control+z"); await expect(page.locator("#editor")).toContainText("calculateTotl(cart, 0.1)");
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    await page.getByRole("button", { name: /main\.ts:\d+:\d+ · TS2552:/ }).click();
    await source.press("Control+.");
    await expect(choice).toBeVisible();
    await page.keyboard.press("Enter");
    await expect.poll(() => resolutions).toBe(2);
    await source.press("Control+End"); await page.keyboard.insertText("\n// Keep later input"); release!();
    await expect(popup).toBeHidden(); await expect(source).toBeFocused();
    await expect(page.locator("#editor")).toContainText("calculateTotl(cart, 0.1)"); await expect(page.locator("#editor")).toContainText("// Keep later input");
});

test("after a provider restart, holding Enter applies the fresh fix once", async ({ page }) => {
    let held = false, disconnect: (() => void) | undefined;
    await page.routeWebSocket("**/demo-provider/*", client => {
        const server = client.connectToServer(), ids = new Set<number>();
        client.onMessage(message => { const value = JSON.parse(message.toString()); if (value.method === "textDocument/codeAction") ids.add(value.id); server.send(message); });
        server.onMessage(message => { const value = JSON.parse(message.toString()); if (!held && ids.has(value.id)) { held = true; disconnect = () => client.close({ code: 1011, reason: "Provider restart" }); } else client.send(message); });
    });
    await openDemo(page); const source = await typo(page); await source.press("Control+."); await expect.poll(() => held).toBe(true);
    disconnect!(); await expect(page.locator("#language-status")).toHaveText("Language service unavailable");
    await page.getByRole("button", { name: "Retry language service", exact: true }).click();
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    await page.getByRole("button", { name: /main\.ts:\d+:\d+ · TS2552:/ }).click(); await source.press("Control+.");
    const popup = page.getByRole("region", { name: "Quick fixes", exact: true });
    await expect(popup.getByRole("button", { name: "Apply fix", exact: true })).toBeEnabled();
    await page.keyboard.down("Enter");
    await expect(popup).toBeHidden();
    await page.keyboard.down("Enter");
    await page.keyboard.up("Enter");
    await expect(page.locator("#editor")).toContainText("calculateTotal(cart, 0.1)");
    await page.keyboard.press("Control+z");
    await expect(page.locator("#editor")).toContainText("calculateTotl(cart, 0.1)");
});

test("a clean position offers no fabricated fix and Escape preserves source and focus", async ({ page }) => {
    await openDemo(page); const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await source.press("Control+Home");
    await source.dispatchEvent("keydown", { key: ";", code: "Comma", ctrlKey: true });
    const popup = page.getByRole("region", { name: "Quick fixes", exact: true });
    await expect(popup).toContainText("No available actions for this range.");
    await expect(popup.getByRole("button", { name: "Apply fix", exact: true })).toBeDisabled();
    await popup.getByRole("button", { name: "Cancel fix" }).press("Escape");
    await expect(popup).toBeHidden(); await expect(source).toBeFocused(); await expect(page.locator("#files")).not.toContainText("●");
});
