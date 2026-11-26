import { routeLanguageWorker } from "./demo-worker-route.ts";
import { test, expect } from "./fixtures.ts";
import { runDemoCompletionCatalogue, runDemoSnippets, runDemoProjectResults, runDemoEditingRules, runDemoFolding, runDemoFoldingBoundaries, runDemoHighlights, runDemoUnopenedNavigation } from "./demo-walkthrough.ts";
import { holdDemoFolds } from "./demo-folding-gate.ts";
import { runDemoDiagnosticRetention } from "./demo-diagnostics.ts";

test("development serves the browser provider without starting a server project", async ({ page }) => {
    const serverRequests: string[] = [], workers: string[] = [];
    page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/demo-provider")) serverRequests.push(request.url()); });
    page.on("worker", worker => workers.push(worker.url()));
    await runDemoUnopenedNavigation(page, "/");
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
    await routeLanguageWorker(page, (client, server) => {
        const requests = new Set<number>();
        client.onMessage(message => {
            const value = JSON.parse(message);
            if (value.method === "textDocument/documentHighlight") requests.add(value.id);
            if (value.method === "$/cancelRequest" && requests.has(value.params.id)) cancellations++;
            server.send(message);
        });
        server.onMessage(message => {
            const value = JSON.parse(message);
            if (requests.has(value.id)) replies.push(() => client.send(message)); else client.send(message);
        });
    });
    await page.goto("/");
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await source.press("Control+a"); await page.keyboard.insertText("let value = 1;\nvalue += 1;\n");
    await source.press("Control+Home"); await source.press("Control+ArrowRight"); await source.press("ArrowRight");
    await expect.poll(() => replies.length).toBeGreaterThan(0);
    await source.press("Control+End"); await expect.poll(() => cancellations).toBeGreaterThan(0);
    for (const reply of replies.splice(0)) reply();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator('#editor [class*="st-occurrence-"]')).toHaveCount(0);
    await source.press("Control+Home"); await source.press("Control+ArrowRight"); await source.press("ArrowRight");
    await expect.poll(() => replies.length).toBeGreaterThan(0);
    await page.getByRole("button", { name: "pricing.ts", exact: true }).click();
    for (const reply of replies.splice(0)) reply();
    await expect(page.getByRole("textbox", { name: "pricing.ts", exact: true })).toBeVisible();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator('#editor [class*="st-occurrence-"]')).toHaveCount(0);
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

test("the type error sample offers a spelling fix from Problems and shows the correction in Changes", async ({ page }) => {
    await page.goto("/?sample=errors");
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30_000 });
    const pricingTab = page.getByRole("button", { name: "pricing.ts", exact: true });
    await pricingTab.click();
    const pricing = page.getByRole("textbox", { name: "pricing.ts", exact: true });
    await pricing.press("Control+Home");
    await pricing.press("End");
    await pricing.press("Shift+Home");
    const firstLine = (await pricing.inputValue()).split("\n", 1)[0]!;
    await page.locator('[data-panel="problems"]').click();
    const problem = page.getByRole("button", { name: /TS2551:.*quanity/ });
    const review = page.locator(".demo-problem").getByRole("button", { name: /^Review .*fix/ });
    await problem.click();
    await expect(review).toBeEnabled();
    await problem.click();
    await review.click();
    const popup = page.getByRole("region", { name: "Quick fixes", exact: true });
    await popup.getByRole("button", { name: "Change spelling to 'quantity'", exact: true }).click();
    await expect(page.locator("#panel-content")).toHaveText("No problems in this project.");
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    const panes = page.locator(".st-comparison-panes > section");
    await expect(panes.first()).toContainText("item.quanity >= 1");
    await expect(panes.last()).toContainText("item.quantity >= 1");
    await page.locator("#code-menu summary").click();
    const back = page.getByRole("button", { name: "Back to previous location" });
    await expect(back).toBeEnabled();
    await back.click();
    await expect(pricingTab).toHaveAttribute("aria-pressed", "true");
    const working = page.getByRole("textbox", { name: "Comparison working source" });
    await expect(working).toBeFocused();
    await expect.poll(() => working.evaluate((input: HTMLTextAreaElement) =>
        [input.selectionStart, input.selectionDirection, input.value.slice(input.selectionStart, input.selectionEnd)]))
        .toEqual([0, "backward", firstLine]);
});

test("real member completion preserves provider punctuation, resolves, applies once and undoes", async ({ page }) => {
    let requests = 0;
    const releaseFolds = await holdDemoFolds(page, "main.ts", method => {
        if (method === "textDocument/completion") requests++;
    });
    await page.goto("/"); await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30_000 });
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await source.press("Control+End"); await page.keyboard.insertText("\nconst basket = cart;\n");
    await source.pressSequentially("bask");
    await expect(page.getByRole("option", { name: "basket", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".st-completion pre")).toContainText("basket");
    await page.keyboard.type(".");
    await expect(page.locator("#editor .st-viewport-row").last()).toHaveText("basket.");
    await expect(page.getByRole("listbox", { name: "Completions", exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: "at", exact: true })).toBeVisible();
    const beforePrefix = requests;
    await source.pressSequentially("ma"); await source.press("Backspace");
    await expect(page.getByRole("option", { name: "map", exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: "at", exact: true })).toHaveCount(0);
    await source.pressSequentially("a");
    await page.getByRole("option", { name: "map", exact: true }).click();
    await expect(page.locator(".st-completion")).toBeHidden();
    expect(requests).toBe(beforePrefix);
    await expect(page.locator("#editor")).toContainText("basket.map");
    await source.press("Control+z"); await expect(page.locator("#editor")).toContainText("basket.ma");
    await expect(page.locator("#editor")).not.toContainText("basket.map");
    await source.press("Control+Space"); await expect(page.getByRole("option", { name: "map", exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: "at", exact: true })).toHaveCount(0);
    await expect(page.locator(".st-completion pre")).toContainText("map");
    const manualRequests = requests;
    await source.press("Backspace");
    await expect.poll(() => requests).toBe(manualRequests + 1);
    await expect(page.getByRole("option", { name: "map", exact: true })).toBeVisible();
    await releaseFolds(); await expect(page.locator("#editor .st-fold-button").first()).toBeVisible();
    await expect(page.getByRole("option", { name: "map", exact: true })).toBeVisible();
    await source.press("Enter"); await expect(page.locator("#editor")).toContainText("basket.map");
    await source.press("Control+z"); await expect(page.locator("#editor .st-viewport-row").last()).toHaveText("basket.m");
    await source.press("Control+Space"); await expect(page.getByRole("option", { name: "map", exact: true })).toBeVisible();
    await source.press("Escape"); await expect(page.locator(".st-completion")).toBeHidden();
    await expect(source).toBeFocused();
});

test("late real diagnostic responses cannot annotate a newer project or follow later focus", async ({ page }) => {
    let armed = false, held = false, release: (() => void) | undefined;
    await routeLanguageWorker(page, (client, provider) => {
        const requests = new Set<number>();
        client.onMessage(message => {
            const value = JSON.parse(message);
            if (armed && value.method === "sttropez/diagnostics" && value.params.kind === "semantic") requests.add(value.id);
            provider.send(message);
        });
        provider.onMessage(message => {
            const value = JSON.parse(message);
            if (!held && requests.has(value.id) && value.result?.body?.some((problem: { code: number }) => problem.code === 2551)) {
                held = true; release = () => client.send(message); return;
            }
            client.send(message);
        });
    });
    await page.goto("/"); await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30_000 });
    armed = true; await page.locator("#sample").selectOption("errors");
    await expect.poll(() => held, { timeout: 30_000 }).toBe(true);
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await source.press("Control+f"); await page.getByRole("textbox", { name: "Find text", exact: true }).fill("quanity");
    await expect(page.locator(".st-find-status")).toHaveText("1 of 1");
    await page.locator(".st-find-next").click();
    await page.getByRole("button", { name: "Close", exact: true }).click(); await source.pressSequentially("quantity");
    await page.getByRole("button", { name: "pricing.ts", exact: true }).click();
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30_000 }); release!();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.locator('[data-panel="problems"]').click();
    await expect(page.locator("#panel-content")).toHaveText("No problems in this project.");
    await expect(page.getByRole("textbox", { name: "pricing.ts", exact: true })).toBeVisible();
});

test("connection and partial mount failures preserve editing and retry their own owners", async ({ page }) => {
    await page.addInitScript(() => {
        const state = { armed: false, reported: 0, starts: 0, ready: 0, failure: new Error("Injected language control mount failure") };
        Object.assign(window, { demoMountFailure: state });
        window.Worker = class extends Worker {
            constructor(url: string | URL, options?: WorkerOptions) {
                super(url, options);
                if (!String(url).endsWith("/demo-language-worker.js")) return;
                state.starts++;
                this.addEventListener("message", event => { if (event.data?.ready) state.ready++; });
            }
        };
        const append = Element.prototype.append, report = console.error;
        Element.prototype.append = function (...nodes) {
            append.apply(this, nodes);
            if (state.armed && nodes.some(node => node instanceof Element && node.classList.contains("st-code-actions"))) {
                state.armed = false; throw state.failure;
            }
        };
        console.error = (...args: unknown[]) => {
            if (args.length === 1 && args[0] === state.failure) { state.reported++; return; }
            report(...args);
        };
    });
    let attempts = 0;

    await page.route("**/demo-language-worker.js", route => {
        attempts++;
        return route.fulfill({ contentType: "text/javascript", body: 'onmessage = () => postMessage({error: "Unavailable"});' });
    });
    await page.goto("/"); await expect(page.locator("#language-status")).toHaveText("Language service unavailable");
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await source.press("Control+Home"); await source.pressSequentially("// Offline edit\n"); await source.press("Control+s");
    await expect(page.locator("#status")).toContainText("Saved in this browser");
    await expect(page.locator("#folding-status")).toContainText("retried"); expect(attempts).toBe(1);
    await page.unroute("**/demo-language-worker.js");
    await page.evaluate(() => { (window as unknown as { demoMountFailure: { armed: boolean } }).demoMountFailure.armed = true; });
    await page.getByRole("button", { name: "Retry language service", exact: true }).click();
    await expect(page.locator("#language-status")).toHaveText("Language controls unavailable");
    expect(await page.evaluate(() => (window as unknown as { demoMountFailure: { reported: number } }).demoMountFailure.reported)).toBe(1);
    await expect(page.locator(".st-completion, .demo-snippet, .st-hover, .st-locations, .st-rename, .st-code-actions")).toHaveCount(0);
    await source.press("Control+Home"); await source.pressSequentially("// Mount recovery\n"); await source.press("Control+s");
    await expect(page.locator("#status")).toContainText("Saved in this browser");
    await page.getByRole("button", { name: "Retry language controls", exact: true }).click();
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30_000 });
    expect(await page.evaluate(() => {
        const { starts, ready } = (window as unknown as { demoMountFailure: { starts: number; ready: number } }).demoMountFailure;
        return { starts, ready };
    })).toEqual({ starts: 2, ready: 1 });
    await expect(page.locator("#editor")).toContainText("// Offline edit");
    await source.press("Control+End"); await source.pressSequentially("\ncart.");
    await expect(page.locator(".st-completion")).toBeVisible();
});
