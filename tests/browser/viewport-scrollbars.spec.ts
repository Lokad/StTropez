import { test, expect } from "./fixtures.ts";

// Headless defaults hide scrollbars and therefore miss classic-scrollbar layout feedback.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

test("a fitting demo settles at fractional zoom with visible scrollbars", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 621 });
    await page.goto("/");
    await page.addStyleTag({ content: ".st-viewport::-webkit-scrollbar { width: 15px; height: 15px; }" });
    await expect(page.locator("#analysis-status")).toContainText("syntax & emit");
    await page.evaluate(() => document.fonts.ready.then(() => {}));
    // Let optional provider decorations settle before counting presentation mutations.
    if (await page.locator("#language-status").count()) await expect(page.locator("#language-status")).toHaveText("Language ready");
    await page.evaluate(() => { document.documentElement.style.zoom = "1.25"; });
    const result = await page.locator("#editor .st-viewport").evaluate(async root => {
        let paintBatches = 0, counting = false;
        const paints = new MutationObserver(() => { if (counting) paintBatches++; });
        paints.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
        const states: string[] = [];
        for (let frame = 0; frame < 60; frame++) {
            await new Promise(requestAnimationFrame);
            if (frame >= 12) { counting = true; states.push(JSON.stringify([root.clientWidth, root.clientHeight, root.scrollWidth, root.scrollHeight])); }
        }
        paints.disconnect();
        return { paintBatches, states: [...new Set(states)], horizontal: root.scrollWidth - root.clientWidth, vertical: root.scrollHeight - root.clientHeight };
    });
    expect(result.states).toHaveLength(1); expect(result.paintBatches).toBe(0);
    expect(result.horizontal).toBe(0); expect(result.vertical).toBe(0);
});

test("a hidden measurement probe does not create scrollbars in a narrow short-document view", async ({ page }) => {
    await page.goto("/viewport/");
    await page.evaluate(() => {
        const fixture = window.viewportFixture, document = fixture.snapshot().document!;
        fixture.edit(document.revision, [{ from: 0, to: document.length, insert: "short" }]);
        fixture.resize(200.2, 111.6);
    });
    await expect.poll(() => page.evaluate(() => window.viewportFixture.snapshot().primary.pending)).toBe(false);
    const dimensions = await page.locator("#primary .st-viewport").evaluate(root => ({
        width: root.clientWidth, height: root.clientHeight, scrollWidth: root.scrollWidth, scrollHeight: root.scrollHeight,
        measured: root.querySelector(".st-viewport-measure")!.getBoundingClientRect().width,
    }));
    expect(dimensions.measured).toBeGreaterThan(dimensions.width);
    expect(dimensions.scrollWidth).toBe(dimensions.width); expect(dimensions.scrollHeight).toBe(dimensions.height);
});
