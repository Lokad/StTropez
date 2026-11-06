import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
    page.on("pageerror", error => { throw error; });
    await page.goto("/probes/");
    await expect.poll(() => page.evaluate(() => window.probe?.ready)).toBe(true);
});

test("textarea and contenteditable preserve UTF-16 selection through real replacement input", async ({ page }) => {
    for (const name of ["Native probe", "Contenteditable probe"]) {
        const input = page.getByRole("textbox", { name });
        await input.fill("a😀b");
        await input.focus();
        await input.evaluate(element => {
            if (element instanceof HTMLTextAreaElement) element.setSelectionRange(1, 3);
            else {
                const range = document.createRange();
                range.setStart(element.firstChild!, 1); range.setEnd(element.firstChild!, 3);
                const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range);
            }
        });
        await input.press("x");
        if (name === "Native probe") await expect(input).toHaveValue("axb");
        else await expect(input).toHaveText("axb");
        const events = await page.evaluate(name => window.probe.events().filter(event => event.surface === name), name);
        expect(events.slice(-2).map(event => event.type)).toEqual(["beforeinput", "input"]);
        expect(events.slice(-2).every(event => event.trusted)).toBe(true);
        expect(events.at(-1)?.selection).toEqual([2, 2]);
    }
});

test("browser-protocol composition exercises both candidates without claiming native IME qualification", async ({ page, browserName }, testInfo) => {
    test.skip(browserName !== "chromium", "Chromium CDP composition control flow; native IME remains a manual gate on every engine.");
    const cdp = await page.context().newCDPSession(page);
    for (const name of ["Native probe", "Contenteditable probe"]) {
        const input = page.getByRole("textbox", { name });
        await input.fill(""); await input.focus();
        await cdp.send("Input.imeSetComposition", { text: "に", selectionStart: 1, selectionEnd: 1 });
        await cdp.send("Input.insertText", { text: "日本語" });
        if (name === "Native probe") await expect(input).toHaveValue("日本語");
        else await expect(input).toHaveText("日本語");
        const events = await page.evaluate(name => window.probe.events().filter(event => event.surface === name), name);
        expect(events.some(event => event.type === "compositionstart" && event.trusted)).toBe(true);
        expect(events.some(event => event.type === "input" && event.composing)).toBe(true);
        expect(events.some(event => event.type === "compositionend")).toBe(true);
    }
    await testInfo.attach("composition-events.json", { body: JSON.stringify(await page.evaluate(() => window.probe.events()), null, 2), contentType: "application/json" });
});

test("visible local tokens and actual worker completion/diagnostics use Unicode replacement ranges", async ({ page }) => {
    const input = page.getByRole("textbox", { name: "Provider source" });
    await input.fill("😀 const sam = 1; // TODO");
    const keyword = page.locator(".token-keyword"), number = page.locator(".token-number"), comment = page.locator(".token-comment");
    await expect(keyword).toHaveText("const");
    const colors = await Promise.all([keyword, number, comment].map(locator => locator.evaluate(node => getComputedStyle(node).color)));
    expect(new Set(colors).size).toBe(3);
    await input.evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(12, 12));
    await page.getByRole("button", { name: "Complete", exact: true }).click();
    await expect(input).toHaveValue("😀 const sample = 1; // TODO");
    await expect(page.getByRole("list", { name: "Diagnostics" })).toHaveText("24: Resolve this placeholder.");
    const counters = await page.evaluate(() => window.probe.counters());
    expect(counters).toMatchObject({ posted: 1, received: 1, applied: 1, stale: 0 });
});

test("stale and cancelled worker replies are rejected; disconnect/reconnect leaves local editing usable", async ({ page }) => {
    const input = page.getByRole("textbox", { name: "Provider source" });
    await page.evaluate(() => window.probe.setDelay(200));
    await input.fill("sam");
    await page.getByRole("button", { name: "Complete", exact: true }).click();
    await input.fill("human correction");
    await expect.poll(() => page.evaluate(() => window.probe.counters().stale)).toBe(1);
    await expect(input).toHaveValue("human correction");
    await page.getByRole("button", { name: "Complete", exact: true }).click();
    await page.getByRole("button", { name: "Cancel request" }).click();
    await expect.poll(() => page.evaluate(() => window.probe.counters().received)).toBe(2);
    await expect(input).toHaveValue("human correction");
    await page.getByRole("button", { name: "Disconnect provider" }).click();
    await input.fill("const sam");
    await input.press("End"); await input.press("x");
    await expect(page.locator(".token-keyword")).toHaveText("const");
    await expect(input).toHaveValue("const samx");
    await page.getByRole("button", { name: "Complete", exact: true }).click();
    await expect(page.locator("#provider-status")).toContainText("unavailable");
    await page.getByRole("button", { name: "Reconnect provider" }).click();
    await page.getByRole("button", { name: "Complete", exact: true }).click();
    await expect(input).toHaveValue("const sample");
    expect(await page.evaluate(() => window.probe.counters())).toMatchObject({ posted: 3, received: 3, applied: 1, stale: 2, cancelled: 1, connections: 2 });
});

test("pinned workspace workload types in split views during background traffic, moves and disposes", async ({ page }) => {
    await page.getByRole("button", { name: "Start workspace workload" }).click();
    const views = page.getByRole("textbox", { name: "Workspace source" });
    await expect(views).toHaveCount(2);
    await expect.poll(() => page.evaluate(() => window.probe.workspace()?.ticks ?? 0)).toBeGreaterThan(0);
    await views.first().fill("shared source");
    await views.first().press("End"); await views.first().pressSequentially(" typing", { delay: 25 });
    await expect(views.nth(1)).toHaveValue("shared source typing");
    expect((await page.evaluate(() => window.probe.workspace()))?.sourceUndoDepth).toBe(2);
    await views.first().press("Control+z"); await expect(views.nth(1)).toHaveValue("shared source");
    await views.first().press("Control+Shift+z"); await expect(views.nth(1)).toHaveValue("shared source typing");
    await page.getByRole("button", { name: "Move workload view" }).click();
    await expect(views.first()).toHaveValue("shared source typing");
    expect(await page.evaluate(() => window.probe.workspace())).toMatchObject({ resources: 100, tabs: 100, activeViews: 2, annotations: 1_000, sourceLength: 20 });
    await page.getByRole("button", { name: "Dispose workspace workload" }).click();
    const stopped = await page.evaluate(() => window.probe.workspace());
    await expect(views).toHaveCount(0);
    // Wait on an independent rendering boundary, then verify no background callbacks survive disposal.
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
    expect(await page.evaluate(() => window.probe.workspace())).toEqual(stopped);
    expect(stopped?.activeViews).toBe(0);
});
