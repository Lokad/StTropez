import { test, expect } from "./fixtures.ts";

test.beforeEach(async ({ page }) => {

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

test("local tokenizer colors actual input without a provider", async ({ page }) => {
    const input = page.getByRole("textbox", { name: "Tokenizer source" });
    await input.fill("😀 const sam = 1; // TODO");
    const keyword = page.locator(".token-keyword"), number = page.locator(".token-number"), comment = page.locator(".token-comment");
    await expect(keyword).toHaveText("const");
    const colors = await Promise.all([keyword, number, comment].map(locator => locator.evaluate(node => getComputedStyle(node).color)));
    expect(new Set(colors).size).toBe(3);
    await input.press("End"); await input.press("x");
    await expect(comment).toHaveText("// TODOx");
    expect(page.workers()).toEqual([]);
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
    await page.evaluate(() => {
        for (let pass = 0; pass < 2; pass++) window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    });
    await expect(views).toHaveCount(2);
    await views.first().press("End"); await views.first().press("!"); await expect(views.nth(1)).toHaveValue("shared source typing!");
    await views.first().press("Control+z"); await expect(views.nth(1)).toHaveValue("shared source typing");
    await page.getByRole("button", { name: "Move workload view" }).click();
    await expect(views.first()).toHaveValue("shared source typing");
    expect(await page.evaluate(() => window.probe.workspace())).toMatchObject({ resources: 100, tabs: 100, activeViews: 2, annotations: 1_000, sourceLength: 20 });
    await page.getByRole("button", { name: "Dispose workspace workload" }).click(); await expect(views).toHaveCount(0);
    await page.getByRole("button", { name: "Start workspace workload" }).click(); await expect(views).toHaveCount(2);
    await page.evaluate(() => {
        for (let pass = 0; pass < 2; pass++) window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
    });
    const stopped = await page.evaluate(() => window.probe.workspace());
    await expect(views).toHaveCount(0);
    // Wait on an independent rendering boundary, then verify no background callbacks survive disposal.
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
    expect(await page.evaluate(() => window.probe.workspace())).toEqual(stopped);
    expect(stopped?.activeViews).toBe(0);
    await expect.poll(() => page.workers().length).toBe(0);
});
