import { test, expect } from "@playwright/test";
import { runDemoCompletionCatalogue, runDemoSnippets, runDemoProjectResults, runDemoEditingRules, runDemoFolding, runDemoHighlights } from "./demo-walkthrough.ts";
import { holdDemoFolds } from "./demo-folding-gate.ts";

test("occurrences follow the caret, edits and large virtualized documents", async ({ page }) => { await runDemoHighlights(page); });

test("late occurrences cannot follow a changed caret or disposed file view", async ({ page }) => {
    const replies: (() => void)[] = []; let cancellations = 0;
    await page.routeWebSocket("**/demo-provider/*", client => {
        const server = client.connectToServer(), requests = new Set<number>();
        client.onMessage(message => {
            const value = JSON.parse(message.toString());
            if (value.method === "textDocument/documentHighlight") requests.add(value.id);
            if (value.method === "$/cancelRequest" && requests.has(value.params.id)) cancellations++;
            server.send(message);
        });
        server.onMessage(message => {
            const value = JSON.parse(message.toString());
            if (requests.has(value.id)) replies.push(() => client.send(message)); else client.send(message);
        });
    });
    await page.goto("/"); const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await source.press("Control+a"); await page.keyboard.insertText("let value = 1;\nvalue += 1;\n");
    await source.press("Control+Home"); await source.press("Control+ArrowRight");
    await expect.poll(() => replies.length).toBeGreaterThan(0);
    await source.press("Control+End"); await expect.poll(() => cancellations).toBeGreaterThan(0);
    for (const reply of replies.splice(0)) reply();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator('#editor [class*="demo-occurrence-"]')).toHaveCount(0);
    await source.press("Control+Home"); await source.press("Control+ArrowRight");
    await expect.poll(() => replies.length).toBeGreaterThan(0);
    await page.getByRole("button", { name: "pricing.ts", exact: true }).click();
    for (const reply of replies.splice(0)) reply();
    await expect(page.getByRole("textbox", { name: "pricing.ts", exact: true })).toBeVisible();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator('#editor [class*="demo-occurrence-"]')).toHaveCount(0);
});

test("automatic folding survives edits, find and independent review views", async ({ page }) => { await runDemoFolding(page); });

test("configured editing commands, quotes and comments share review and undo", async ({ page }) => { await runDemoEditingRules(page); });

test("project-wide results retain late problems, references and rename edits with bounded pages", async ({ page }) => {
    await runDemoProjectResults(page);
});

test("demo snippet fields and lazy declarations share input, traversal and history", async ({ page }) => {
    await runDemoSnippets(page);
});

test("real provider retains the 1200-field catalogue through filtering, acceptance and undo", async ({ page }) => {
    await runDemoCompletionCatalogue(page);
});

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
    const releaseFolds = await holdDemoFolds(page, "main.ts");
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
    await source.press("Control+Space"); await expect(page.getByRole("option", { name: "map", exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: "at", exact: true })).toHaveCount(0);
    await expect(page.locator(".demo-completion pre")).toContainText("map");
    await releaseFolds(); await expect(page.locator("#editor .st-fold-button").first()).toBeVisible();
    await expect(page.getByRole("option", { name: "map", exact: true })).toBeVisible();
    await source.press("Enter"); await expect(page.locator("#editor")).toContainText("cart.map");
    await source.press("Control+z"); await expect(page.locator("#editor")).toContainText("cart.ma");
    await source.press("Control+Space"); await expect(page.getByRole("option", { name: "map", exact: true })).toBeVisible();
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
    let attempts = 0;
    await page.route("**/demo-provider?sample=pricing", route => { attempts++; return route.fulfill({ status: 503, body: "Unavailable" }); });
    await page.goto("/"); await expect(page.locator("#language-status")).toHaveText("Language service unavailable");
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await source.press("Control+Home"); await source.pressSequentially("// Offline edit\n"); await source.press("Control+s");
    await expect(page.locator("#status")).toContainText("Saved in this browser");
    await expect(page.locator("#folding-status")).toContainText("retried"); expect(attempts).toBe(1);
    await page.unroute("**/demo-provider?sample=pricing"); await page.getByRole("button", { name: "Retry language service", exact: true }).click();
    await expect(page.locator("#language-status")).toHaveText("Language ready");
    await expect(page.locator("#editor")).toContainText("// Offline edit");
    await source.press("Control+End"); await source.pressSequentially("\ncart.");
    await expect(page.locator(".demo-completion")).toBeVisible();
});
