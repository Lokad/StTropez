import { test, expect } from "./fixtures.ts";
import { runDemoCompletionCatalogue, runDemoSnippets, runDemoProjectResults, runDemoEditingRules, runDemoFolding, runDemoFoldingBoundaries, runDemoHighlights, runDemoUnopenedNavigation } from "./demo-walkthrough.ts";
import { holdDemoFolds } from "./demo-folding-gate.ts";
import { runDemoDiagnosticRetention } from "./demo-diagnostics.ts";

test("development serves the browser provider without starting a server project", async ({ page }) => {
    const serverRequests: string[] = [], workers: string[] = [];
    page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/demo-provider")) serverRequests.push(request.url()); });
    page.on("worker", worker => workers.push(worker.url()));
    await runDemoUnopenedNavigation(page, "/?provider=browser");
    expect(workers.some(url => url.endsWith("/demo-language-worker.js"))).toBe(true);
    expect(serverRequests).toEqual([]);
});

test("diagnostics remain mapped while dirty syntax and dependent semantics are rechecked", async ({ page }, info) => {
    const requests = await runDemoDiagnosticRetention(page);
    await info.attach("diagnostic-requests", { body: JSON.stringify(requests, null, 2), contentType: "application/json" });
});

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
    await source.press("Control+Home"); await source.press("Control+ArrowRight"); await source.press("ArrowRight");
    await expect.poll(() => replies.length).toBeGreaterThan(0);
    await source.press("Control+End"); await expect.poll(() => cancellations).toBeGreaterThan(0);
    for (const reply of replies.splice(0)) reply();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator('#editor [class*="demo-occurrence-"]')).toHaveCount(0);
    await source.press("Control+Home"); await source.press("Control+ArrowRight"); await source.press("ArrowRight");
    await expect.poll(() => replies.length).toBeGreaterThan(0);
    await page.getByRole("button", { name: "pricing.ts", exact: true }).click();
    for (const reply of replies.splice(0)) reply();
    await expect(page.getByRole("textbox", { name: "pricing.ts", exact: true })).toBeVisible();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator('#editor [class*="demo-occurrence-"]')).toHaveCount(0);
});

test("automatic folding survives edits, find and independent review views", async ({ page }) => { await runDemoFolding(page); });
test("review folding preserves adjacent branches and statements in both panes", async ({ page }) => { await runDemoFoldingBoundaries(page); });

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

});

test("real member completion preserves provider punctuation, resolves, applies once and undoes", async ({ page }) => {
    const releaseFolds = await holdDemoFolds(page, "main.ts");
    let requests = 0;
    page.on("websocket", socket => socket.on("framesent", frame => { if (JSON.parse(frame.payload.toString()).method === "textDocument/completion") requests++; }));
    await page.goto("/"); await expect(page.locator("#language-status")).toHaveText("Language ready");
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await source.press("Control+End"); await page.keyboard.insertText("\nconst basket = cart;\n");
    await source.pressSequentially("bask");
    await expect(page.getByRole("option", { name: "basket", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".demo-completion pre")).toContainText("basket");
    await page.keyboard.type(".");
    await expect(page.locator("#editor .st-viewport-row").last()).toHaveText("basket.");
    await expect(page.getByRole("listbox", { name: "Completions", exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: "at", exact: true })).toBeVisible();
    const beforePrefix = requests;
    await source.pressSequentially("ma"); await source.press("Backspace");
    await expect(page.getByRole("option", { name: "map", exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: "at", exact: true })).toHaveCount(0);
    await source.press("Backspace");
    await expect(page.getByRole("option", { name: "push", exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: "map", exact: true })).toHaveAttribute("aria-selected", "true");
    await source.pressSequentially("ma");
    await page.getByRole("option", { name: "map", exact: true }).click();
    await expect(page.locator(".demo-completion")).toBeHidden();
    expect(requests).toBe(beforePrefix);
    await expect(page.locator("#editor")).toContainText("basket.map");
    await source.press("Control+z"); await expect(page.locator("#editor")).toContainText("basket.ma");
    await expect(page.locator("#editor")).not.toContainText("basket.map");
    await source.press("Control+Space"); await expect(page.getByRole("option", { name: "map", exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: "at", exact: true })).toHaveCount(0);
    await expect(page.locator(".demo-completion pre")).toContainText("map");
    const manualRequests = requests;
    await source.press("Backspace");
    await expect.poll(() => requests).toBe(manualRequests + 1);
    await expect(page.getByRole("option", { name: "map", exact: true })).toBeVisible();
    await releaseFolds(); await expect(page.locator("#editor .st-fold-button").first()).toBeVisible();
    await expect(page.getByRole("option", { name: "map", exact: true })).toBeVisible();
    await source.press("Enter"); await expect(page.locator("#editor")).toContainText("basket.map");
    await source.press("Control+z"); await expect(page.locator("#editor .st-viewport-row").last()).toHaveText("basket.m");
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

test("connection and partial mount failures preserve editing and retry their own owners", async ({ page, baseURL, browserErrors }) => {
    await page.addInitScript(() => {
        const state = { armed: false, reported: 0, failure: new Error("Injected language control mount failure") };
        Object.assign(window, { demoMountFailure: state });
        const append = Element.prototype.append, report = console.error;
        Element.prototype.append = function (...nodes) {
            append.apply(this, nodes);
            if (state.armed && this === document.body && nodes.some(node => node instanceof Element && node.classList.contains("demo-actions"))) {
                state.armed = false; throw state.failure;
            }
        };
        console.error = (...args: unknown[]) => {
            if (args.length === 1 && args[0] === state.failure) { state.reported++; return; }
            report(...args);
        };
    });
    let attempts = 0;
    const starts: string[] = [];
    page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/demo-provider") starts.push(request.url()); });
    browserErrors.allowConsoleError("Failed to load resource: the server responded with a status of 503 (Service Unavailable)", new URL("/demo-provider?sample=pricing", baseURL).href);
    await page.route("**/demo-provider?sample=pricing", route => { attempts++; return route.fulfill({ status: 503, body: "Unavailable" }); });
    await page.goto("/"); await expect(page.locator("#language-status")).toHaveText("Language service unavailable");
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await source.press("Control+Home"); await source.pressSequentially("// Offline edit\n"); await source.press("Control+s");
    await expect(page.locator("#status")).toContainText("Saved in this browser");
    await expect(page.locator("#folding-status")).toContainText("retried"); expect(attempts).toBe(1);
    await page.unroute("**/demo-provider?sample=pricing");
    await page.evaluate(() => { (window as unknown as { demoMountFailure: { armed: boolean } }).demoMountFailure.armed = true; });
    await page.getByRole("button", { name: "Retry language service", exact: true }).click();
    await expect(page.locator("#language-status")).toHaveText("Language controls unavailable");
    expect(await page.evaluate(() => (window as unknown as { demoMountFailure: { reported: number } }).demoMountFailure.reported)).toBe(1);
    await expect(page.locator(".demo-completion, .demo-snippet, .demo-language-popups, .demo-symbols, .demo-rename, .demo-actions")).toHaveCount(0);
    await source.press("Control+Home"); await source.pressSequentially("// Mount recovery\n"); await source.press("Control+s");
    await expect(page.locator("#status")).toContainText("Saved in this browser");
    const connectedStarts = starts.length;
    await page.getByRole("button", { name: "Retry language controls", exact: true }).click();
    await expect(page.locator("#language-status")).toHaveText("Language ready");
    expect(starts.length).toBe(connectedStarts);
    await expect(page.locator("#editor")).toContainText("// Offline edit");
    await source.press("Control+End"); await source.pressSequentially("\ncart.");
    await expect(page.locator(".demo-completion")).toBeVisible();
});
