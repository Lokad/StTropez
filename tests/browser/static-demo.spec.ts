import { expect, test } from "@playwright/test";
import { runDemoUnopenedNavigation } from "./demo-walkthrough.ts";

test("unopened targets load for navigation and atomic rename with read-only declarations and return", async ({ page, baseURL }) => {
    await runDemoUnopenedNavigation(page, baseURL!);
});
import { runDemoCompletionCatalogue, runDemoConflict, runDemoSnippets, runDemoWalkthrough, runDemoProjectResults, runDemoEditingRules, runDemoFolding, runDemoHighlights, runDemoDocumentation } from "./demo-walkthrough.ts";

test("documentation and diagnostic details preserve metadata and open permitted help through the host", async ({ page, baseURL }) => { await runDemoDocumentation(page, baseURL!); });

test("occurrences follow the caret, edits and large virtualized documents", async ({ page, baseURL }) => { await runDemoHighlights(page, baseURL!, true); });

test("automatic folding survives edits, find and independent review views", async ({ page, baseURL }) => { await runDemoFolding(page, baseURL!); });
import { runDemoPresentationContinuity } from "./demo-presentation.ts";

// Native scrollbar drags are part of the demo's user journey, including headless Chromium.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

test("configured editing commands, quotes and comments share review and undo", async ({ page, baseURL }) => { await runDemoEditingRules(page, baseURL!); });

test("project-wide results retain late problems, references and rename edits with bounded pages", async ({ page, baseURL }) => {
    await runDemoProjectResults(page, baseURL!);
});

test("static demo snippet fields and lazy declarations share input, traversal and history", async ({ page, baseURL }) => {
    await runDemoSnippets(page, baseURL!);
});

test("visible presentation survives edits, history and scrolling while compiler replies wait", async ({ page, baseURL }, info) => {
    const observations = await runDemoPresentationContinuity(page, baseURL!);
    await info.attach("presentation-continuity", { body: JSON.stringify(observations, null, 2), contentType: "application/json" });
});

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

test("reset names its sample and recovery follows the stored draft across sample switches and reload", async ({ page, baseURL }) => {
    const prompts: string[] = []; page.on("dialog", dialog => { prompts.push(dialog.message()); void dialog.accept(); });
    await page.goto(baseURL!);
    await page.getByRole("button", { name: "Reset sample", exact: true }).click();
    expect(prompts.at(-1)).toContain("Shopping cart");
    await page.locator("#sample").selectOption("large");
    const source = page.getByRole("textbox", { name: "large.ts", exact: true }); await expect(source).toBeVisible();
    await expect(page.locator("#recovery-status")).toHaveText("Recovery is ready.");
    await expect(page.locator("#recovery-offer")).toBeHidden();
    await source.press("Control+Home"); await source.pressSequentially("// My previous large-file edits\n");
    await expect(page.locator("#recovery-status")).toHaveText("Recovery draft captured in this browser.");
    await page.reload(); await page.getByRole("button", { name: "Reset sample", exact: true }).click();
    await expect(page.locator("#recovery-offer")).toBeHidden();
    await page.locator("#sample").selectOption("large");
    await expect(page.locator("#recovery-offer")).toBeVisible();
    await expect(page.locator("#recovery-message")).toContainText("unsaved draft for large.ts");
    await page.getByRole("button", { name: "Restore draft", exact: true }).click();
    await expect(page.locator("#editor")).toContainText("// My previous large-file edits");
    await page.getByRole("button", { name: "Reset sample", exact: true }).click();
    expect(prompts.at(-1)).toContain("Large file");
    await expect(page.locator("#recovery-status")).toHaveText("All changes are saved.");
    await page.reload(); await page.locator("#sample").selectOption("large");
    await expect(page.locator("#recovery-status")).toHaveText("Recovery is ready.");
    await expect(page.locator("#recovery-offer")).toBeHidden();
    await expect(page.locator("#editor")).not.toContainText("My previous large-file edits");
});

test("browser global completion filters its catalogue after a typed prefix", async ({ page, baseURL }) => {
    await page.goto(baseURL!); await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    const source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await source.press("Control+End"); await source.pressSequentially("\ncalculateTotal(cart, ");
    await source.press("Control+Space"); await expect(page.getByRole("listbox", { name: "Completions", exact: true })).toBeVisible();
    await source.pressSequentially("Mat"); await expect(page.getByRole("option", { name: "Math", exact: true })).toBeVisible();
    await source.press("Escape"); await expect(page.getByRole("listbox", { name: "Completions", exact: true })).toBeHidden();
    await expect(source).toBeFocused();
});

test("the real 1200-field catalogue reaches the last candidate with bounded rows, keyboard acceptance and undo", async ({ page, baseURL }) => {
    await runDemoCompletionCatalogue(page, baseURL!);
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

test("large browser-only sample keeps scroll content, editing/history and language feedback with bounded output", async ({ page, baseURL }, info) => {
    await page.goto(baseURL!); await page.locator("#sample").selectOption("large");
    const source = page.getByRole("textbox", { name: "large.ts", exact: true });
    await expect(source).toBeVisible();
    const viewport = page.locator("#editor .st-viewport");
    if (info.project.name === "chromium") {
        // Exercise the reported native thumb drag during analysis, rather than wheel scrolling.
        const track = await viewport.evaluate(element => {
            const root = element as HTMLElement;
            const box = root.getBoundingClientRect();
            return { x: box.left + root.clientLeft + root.clientWidth + (root.offsetWidth - root.clientWidth) / 2,
                y: box.top + 25, middle: box.top + root.clientHeight / 2, width: root.offsetWidth - root.clientWidth };
        });
        expect(track.width).toBeGreaterThan(0);
        await page.mouse.move(track.x, track.y); await page.mouse.down();
        await page.mouse.move(track.x, track.middle, { steps: 20 }); await page.mouse.up();
    } else await viewport.evaluate(root => { root.scrollTop = root.scrollHeight / 2; });
    await expect.poll(() => viewport.evaluate(root => {
        const box = root.getBoundingClientRect();
        const row = [...root.querySelectorAll<HTMLElement>(".st-viewport-row")].find(row => {
            const at = row.getBoundingClientRect(); return at.top >= box.top && at.bottom <= box.bottom;
        });
        const line = Number(row?.dataset.line), gutter = [...document.querySelectorAll("#gutter span")];
        return line > 40000 && line < 60000 && row?.textContent === `// Row ${line + 1}: try editing or searching here.`
            && gutter.some(number => number.textContent === String(line + 1) && Math.abs(number.getBoundingClientRect().top - row!.getBoundingClientRect().top) < 1);
    })).toBe(true);
    await expect(page.locator("#analysis-status")).toContainText("syntax & emit", { timeout: 30000 });
    const output = page.getByRole("region", { name: "JavaScript output", exact: true });
    expect(await output.locator(".st-viewport-row").count()).toBeLessThan(60);
    expect((await output.textContent())!.length).toBeLessThan(5000);
    const sourceTop = await viewport.evaluate(root => root.scrollTop);
    await output.evaluate(root => { root.scrollTop = root.scrollHeight; });
    await expect(output).toContainText("// Row 100000: try editing or searching here.");
    expect(await viewport.evaluate(root => root.scrollTop)).toBe(sourceTop);
    await source.press("Control+End"); await source.pressSequentially("\nMath.ma");
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    await source.press("Escape"); await source.press("Control+Space"); await expect(page.getByRole("option", { name: "max", exact: true })).toBeVisible();
    await page.getByRole("option", { name: "max", exact: true }).click(); await expect(page.locator("#editor")).toContainText("Math.max");
    await source.press("Control+z"); await expect(page.locator("#editor")).toContainText("Math.ma"); await source.press("Control+y");
    await expect(page.locator("#editor")).toContainText("Math.max"); await source.press("Control+s"); await expect(page.locator("#status")).toContainText("Saved in this browser");
    expect(await source.evaluate(input => (input as HTMLTextAreaElement).value.length)).toBeLessThanOrEqual(2600);
    expect(await page.locator("#editor .st-viewport-row").count()).toBeLessThan(60);
});
