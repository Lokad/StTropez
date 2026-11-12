import { test, expect } from "@playwright/test";

test("real TypeScript diagnostics select the captured error and clear after correction", async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto("/"); await page.locator("#sample").selectOption("errors");
    await expect(page.locator("#language-status")).toHaveText("Language ready");
    await page.locator('[data-panel="problems"]').click();
    const problem = page.getByRole("button", { name: /main.ts · TS2345:/ });
    await expect(problem).toContainText("not assignable"); await problem.click();
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await expect(source).toBeFocused(); await source.pressSequentially("0.1");
    await expect(page.locator("#language-status")).toHaveText("Language ready");
    await expect(page.locator("#panel-content")).toHaveText("No problems in this project.");
    await expect(page.locator("#editor")).toContainText("calculateTotal(cart, 0.1)");
    expect(errors).toEqual([]);
});

test("real member completion preserves provider punctuation, resolves, applies once and undoes", async ({ page }) => {
    let requests = 0;
    page.on("websocket", socket => socket.on("framesent", frame => { if (JSON.parse(frame.payload.toString()).method === "textDocument/completion") requests++; }));
    await page.goto("/"); await expect(page.locator("#language-status")).toHaveText("Language ready");
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await source.press("Control+End"); await source.pressSequentially("\ncart.");
    await expect(page.getByRole("listbox", { name: "Completions", exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: "at", exact: true })).toBeVisible();
    const beforePrefix = requests;
    await source.pressSequentially("ma");
    await page.getByRole("option", { name: "map", exact: true }).click();
    await expect(page.locator(".demo-completion")).toBeHidden();
    expect(requests).toBe(beforePrefix);
    await expect(page.locator("#editor")).toContainText("cart.map");
    await source.press("Control+z"); await expect(page.locator("#editor")).toContainText("cart.ma");
    await expect(page.locator("#editor")).not.toContainText("cart.map");
    await source.press("Control+Space"); await expect(page.locator(".demo-completion")).toBeVisible();
    await source.press("Escape"); await expect(page.locator(".demo-completion")).toBeHidden();
    await expect(source).toBeFocused();
});

test("late real diagnostic responses cannot annotate a newer project or follow later focus", async ({ page }) => {
    let armed = false, held = false, release: (() => void) | undefined;
    await page.routeWebSocket("**/demo-provider/*", client => {
        const provider = client.connectToServer(), requests = new Set<number>();
        client.onMessage(message => {
            const value = JSON.parse(message.toString());
            if (armed && value.method === "sttropez/diagnostics" && value.params.kind === "semantic") requests.add(value.id);
            provider.send(message);
        });
        provider.onMessage(message => {
            const value = JSON.parse(message.toString());
            if (!held && requests.has(value.id) && value.result?.body?.some((problem: { code: number }) => problem.code === 2345)) {
                held = true; release = () => client.send(message); return;
            }
            client.send(message);
        });
    });
    await page.goto("/"); await expect(page.locator("#language-status")).toHaveText("Language ready");
    armed = true; await page.locator("#sample").selectOption("errors");
    await expect.poll(() => held).toBe(true);
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await source.press("Control+f"); await page.getByRole("textbox", { name: "Find text", exact: true }).fill('"10%"');
    await expect(page.locator("#find-status")).toHaveText("1 matches");
    await page.locator("#find-next").click();
    await page.getByRole("button", { name: "Close", exact: true }).click(); await source.pressSequentially("0.1");
    await page.getByRole("button", { name: "pricing.ts", exact: true }).click();
    await expect(page.locator("#language-status")).toHaveText("Language ready"); release!();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.locator('[data-panel="problems"]').click();
    await expect(page.locator("#panel-content")).toHaveText("No problems in this project.");
    await expect(page.getByRole("textbox", { name: "pricing.ts", exact: true })).toBeVisible();
});

test("provider startup failure leaves typing and saving usable and retries current documents", async ({ page }) => {
    await page.route("**/demo-provider?sample=pricing", route => route.fulfill({ status: 503, body: "Unavailable" }));
    await page.goto("/"); await expect(page.locator("#language-status")).toHaveText("Language service unavailable");
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await source.press("Control+Home"); await source.pressSequentially("// Offline edit\n"); await source.press("Control+s");
    await expect(page.locator("#status")).toContainText("Saved in this browser");
    await page.unroute("**/demo-provider?sample=pricing"); await page.getByRole("button", { name: "Retry language service", exact: true }).click();
    await expect(page.locator("#language-status")).toHaveText("Language ready");
    await expect(page.locator("#editor")).toContainText("// Offline edit");
    await source.press("Control+End"); await source.pressSequentially("\ncart.");
    await expect(page.locator(".demo-completion")).toBeVisible();
});
