import { latch } from "../helpers/latch.ts";
import { expect, test } from "./fixtures.ts";
import { runDemoHostIntegrations } from "./demo-host-integrations.ts";
import { runDemoDiagnosticRetention } from "./demo-diagnostics.ts";

test("view controls survive file switches and saved-reference replacement in both review panes", async ({ page, baseURL }, info) => {
    await page.setViewportSize({ width: 2000, height: 1000 }); await page.goto(baseURL!);
    const source = page.locator("#editor .st-viewport"), input = source.getByRole("textbox");
    await expect(source.locator(".st-current-line")).toHaveCount(1);
    const mounted = await source.elementHandle(), initialHeight = await source.evaluate(element => element.scrollHeight);
    await page.locator("#view-menu summary").click();
    for (const id of ["view-rulers", "view-ligatures", "view-trailing-space", "view-minimap"]) await page.locator(`#${id}`).check();
    await expect(source.locator(".st-column-ruler").first()).toBeVisible();
    await expect(source.locator(".st-minimap-marker")).toBeVisible();
    await expect(page.locator(".demo-output .st-minimap-marker")).toBeVisible();
    await expect(source).toHaveCSS("font-variant-ligatures", "normal");
    await expect.poll(() => source.evaluate(element => element.scrollHeight)).toBeGreaterThan(initialHeight);
    expect(await mounted!.evaluate(element => element.isConnected)).toBe(true);
    await page.locator("#view-menu summary").press("Escape"); await expect(page.locator("#view-menu")).not.toHaveAttribute("open", "");
    await input.press("Control+Home"); await page.keyboard.type("// View controls\n");
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    const panes = page.locator(".st-comparison-panes > section"), left = panes.first(), right = panes.last();
    await expect(page.locator(".st-comparison")).toHaveAttribute("data-status", "ready");
    for (const pane of [left, right]) {
        await expect(pane.locator(".st-column-ruler").first()).toBeVisible();
        await expect(pane.locator(".st-minimap-marker")).toBeVisible();
        await expect(pane.locator(".st-current-line")).toHaveCount(1);
        await expect(pane.locator(".st-viewport")).toHaveCSS("font-variant-ligatures", "normal");
    }
    await page.locator("#save").click();
    await expect(left.locator('.st-viewport-row[data-line="0"]')).toHaveText("// View controls");
    await expect(left.locator(".st-column-ruler").first()).toBeVisible();
    await expect(left.locator(".st-viewport")).toHaveCSS("font-variant-ligatures", "normal");
    await page.locator("#files button").filter({ hasText: "pricing.ts" }).click();
    await expect(page.locator(".st-comparison")).toHaveAttribute("data-status", "ready");
    for (const pane of [left, right]) await expect(pane.locator(".st-column-ruler").first()).toBeVisible();
    await page.locator("#sample").selectOption("unicode");
    await expect(page.locator(".st-comparison")).toHaveAttribute("data-status", "ready");
    for (const pane of [left, right]) await expect(pane.locator(".demo-token-string").first()).toBeVisible();
    await page.locator("#view-menu summary").click();
    for (const id of ["view-rulers", "view-current-line", "view-ligatures", "view-trailing-space", "view-minimap"]) await expect(page.locator(`#${id}`)).toBeChecked();
    await info.attach("presentation-controls", { body: await page.screenshot(), contentType: "image/png" });
    for (const id of ["view-rulers", "view-current-line", "view-ligatures", "view-trailing-space", "view-minimap"]) await page.locator(`#${id}`).uncheck();
    for (const pane of [left, right]) {
        await expect(pane.locator(".st-column-ruler, .st-current-line-background, .st-minimap")).toHaveCount(0);
        await expect(pane.locator(".st-viewport")).toHaveCSS("font-variant-ligatures", "none");
    }
    await page.locator("#view-menu summary").press("Escape"); await expect(page.locator("#view-menu summary")).toBeFocused();
});

test("character warnings explain source characters and stay consistent across review panes", async ({ page, baseURL }, info) => {
    await page.goto(baseURL!); await page.locator("#sample").selectOption("unicode");
    const source = page.getByRole("textbox", { name: "greetings.ts", exact: true });
    const warnings = page.locator("#editor .st-viewport-layer .st-character-warning");
    await expect(warnings.first()).toHaveText("\u200b"); await expect(page.locator("#analysis-status")).toContainText("syntax & emit");
    await source.press("Control+Home"); await page.locator("#code-menu summary").click();
    await page.getByRole("button", { name: "Inspect source characters", exact: true }).click();
    const details = page.locator("#character-warning-details"), invisible = details.getByRole("button", { name: /U\+200B/ });
    await expect(invisible).toHaveText("Ln 1, Col 16: Invisible character (U+200B)");
    await expect(details).toContainText("Non-breaking space (U+00A0)");
    await info.attach("warning-inspector", { body: await page.screenshot(), contentType: "image/png" });
    await invisible.click(); await source.press("Backspace"); await expect(warnings.first()).toHaveText("\u00a0");
    await invisible.click(); await expect(details).toHaveText("The source or warning settings changed. Inspect again.");
    await source.press("Control+z"); await expect(warnings.first()).toHaveText("\u200b");
    await page.locator("#character-warnings").uncheck(); await expect(warnings).toHaveCount(0);
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    await expect(page.locator(".st-comparison")).toHaveAttribute("data-status", "ready");
    const panes = page.locator(".st-comparison-panes > section"), left = panes.first(), right = panes.last();
    const marks = ".st-viewport-layer .st-character-warning";
    await expect(left.locator(marks)).toHaveCount(0); await expect(right.locator(marks)).toHaveCount(0);
    await page.locator("#code-menu summary").click(); await page.locator("#character-warnings").check();
    await expect(left.locator(marks).first()).toHaveText("\u200b"); await expect(right.locator(marks).first()).toHaveText("\u200b");
    expect(await left.locator(marks).allTextContents()).toEqual(await right.locator(marks).allTextContents());
    await page.locator("#code-menu summary").click();
    await info.attach("warning-review", { body: await page.screenshot(), contentType: "image/png" });
});

test("diagnostics remain mapped while dirty syntax and dependent semantics are rechecked", async ({ page, baseURL }, info) => {
    const requests = await runDemoDiagnosticRetention(page, baseURL!);
    await info.attach("diagnostic-requests", { body: JSON.stringify(requests, null, 2), contentType: "application/json" });
});

test("host language, structured/literal insertion and mapped notes share editing and review", async ({ page, baseURL }) => {
    await runDemoHostIntegrations(page, baseURL!);
});
import { runDemoUnopenedNavigation, runDemoActions } from "./demo-walkthrough.ts";

test("broader project actions retain preview, stale recovery and atomic multi-file history", async ({ page, baseURL }) => { await runDemoActions(page, baseURL!); });

test("unopened targets load for navigation and atomic rename with read-only declarations and return", async ({ page, baseURL }) => {
    await runDemoUnopenedNavigation(page, baseURL!);
});
import { runDemoCompletionCatalogue, runDemoConflict, runDemoSnippets, runDemoWalkthrough, runDemoProjectResults, runDemoEditingRules, runDemoFolding, runDemoFoldingBoundaries, runDemoHighlights, runDemoDocumentation } from "./demo-walkthrough.ts";

test("documentation and diagnostic details preserve metadata and open permitted help through the host", async ({ page, baseURL }) => { await runDemoDocumentation(page, baseURL!); });

test("occurrences follow the caret, edits and large virtualized documents", async ({ page, baseURL }) => { await runDemoHighlights(page, baseURL!, true); });

test("automatic folding survives edits, find and independent review views", async ({ page, baseURL }) => { await runDemoFolding(page, baseURL!); });
test("review folding preserves adjacent branches and statements in both panes", async ({ page, baseURL }) => { await runDemoFoldingBoundaries(page, baseURL!); });
import { runDemoPresentationContinuity, runDemoSyntaxDemand, runDemoMetadataBatching } from "./demo-presentation.ts";

test("metadata batches frame writes while typing, switching files and disposing", async ({ page, baseURL }, info) => {
    const counts = await runDemoMetadataBatching(page, baseURL!);
    await info.attach("metadata-work", { body: JSON.stringify(counts, null, 2), contentType: "application/json" });
});

test("syntax worker retains large documents and emits only for the visible JavaScript panel", async ({ page, baseURL }, info) => {
    const traffic = await runDemoSyntaxDemand(page, baseURL!);
    await info.attach("syntax-traffic", { body: JSON.stringify(traffic, null, 2), contentType: "application/json" });
});

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

test("peer recovery reads only the changed sample while unrelated samples stay cached", async ({ page, baseURL }, info) => {
    type Probe = { reads: string[]; notices: number };
    await page.addInitScript(() => {
        const probe: Probe = { reads: [], notices: 0 }, name = "sttropez-demo-recovery-v1";
        Object.assign(window, { demoRecoveryProbe: probe });
        const get = IDBObjectStore.prototype.get, Native = BroadcastChannel;
        IDBObjectStore.prototype.get = function (key) {
            if (this.transaction.db.name === name) probe.reads.push(String(key));
            return get.call(this, key);
        };
        window.BroadcastChannel = class extends Native {
            constructor(channel: string) { super(channel); if (channel === name) this.addEventListener("message", () => { probe.notices++; }); }
        };
    });
    await page.goto(baseURL!); await expect(page.locator("#recovery-status")).toHaveText("Recovery is ready.");
    await page.locator("#sample").selectOption("host");
    await expect(page.locator("#recovery-status")).toHaveText("Recovery is ready.");
    const peer = await page.context().newPage();
    try {
        await peer.goto(baseURL!); await expect(peer.locator("#recovery-status")).toHaveText("Recovery is ready.");
        await page.evaluate(() => { const probe = (window as unknown as { demoRecoveryProbe: Probe }).demoRecoveryProbe; probe.reads = []; probe.notices = 0; });
        const source = peer.getByRole("textbox", { name: "main.ts", exact: true });
        await source.press("Control+Home"); await peer.keyboard.insertText("// Peer recovery\n");
        await expect(peer.locator("#recovery-status")).toHaveText("Recovery draft captured in this browser.");
        // Both cached stores receive the native broadcast. Only its owning slot may read.
        await page.waitForFunction(() => {
            const probe = (window as unknown as { demoRecoveryProbe: Probe }).demoRecoveryProbe;
            return probe.notices === 2 && probe.reads.includes("pricing");
        });
        const work = await page.evaluate(() => (window as unknown as { demoRecoveryProbe: Probe }).demoRecoveryProbe);
        await info.attach("recovery-work", { body: JSON.stringify(work, null, 2), contentType: "application/json" });
        expect(work.reads).toEqual(["pricing"]);
        await expect(page.locator("#recovery-offer")).toBeHidden();
        await expect(page.locator("#recovery-status")).toHaveText("Recovery is ready.");
        await page.locator("#sample").selectOption("pricing");
        await expect(page.locator("#recovery-offer")).toBeVisible();
        await peer.close();
        await page.getByRole("button", { name: "Restore draft", exact: true }).click();
        await expect(page.locator("#editor")).toContainText("// Peer recovery");
    } finally { if (!peer.isClosed()) await peer.close(); }
});

test("reset names its sample and recovery follows the stored draft across sample switches and reload", async ({ page, baseURL }) => {
    const prompts: string[] = []; page.on("dialog", dialog => { prompts.push(dialog.message()); void dialog.accept(); });
    const startup = latch<void>();
    await page.route("**/app.js", async route => { await startup.promise; await route.continue(); }, { times: 1 });
    const opening = page.goto(baseURL!);
    try {
        await expect(page.getByRole("button", { name: "Reset sample", exact: true })).toBeDisabled();
        await expect(page.getByLabel("Example", { exact: true })).toBeDisabled();
    } finally { startup.resolve(); await opening; }
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
    await page.locator("#find-toggle").click(); await page.locator("#find-query").fill("Row");
    await expect(page.locator("#find-status")).toHaveText("100000 matches");
    await expect.poll(() => page.locator("#editor .demo-search").count()).toBeGreaterThan(0);
    expect(await viewport.evaluate(root => root.scrollTop)).toBe(sourceTop);
    await page.locator("#find-close").click(); await expect(page.locator("#editor .demo-search")).toHaveCount(0);
    await source.press("Control+End"); await source.pressSequentially("\nMath.ma");
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
    await source.press("Escape"); await source.press("Control+Space"); await expect(page.getByRole("option", { name: "max", exact: true })).toBeVisible();
    await page.getByRole("option", { name: "max", exact: true }).click(); await expect(page.locator("#editor")).toContainText("Math.max");
    await source.press("Control+z"); await expect(page.locator("#editor")).toContainText("Math.ma"); await source.press("Control+y");
    await expect(page.locator("#editor")).toContainText("Math.max"); await source.press("Control+s"); await expect(page.locator("#status")).toContainText("Saved in this browser");
    expect(await source.evaluate(input => (input as HTMLTextAreaElement).value.length)).toBeLessThanOrEqual(2600);
    expect(await page.locator("#editor .st-viewport-row").count()).toBeLessThan(60);
});
