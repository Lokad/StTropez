import { test, expect, ready } from "./fixtures.ts";

// Headless defaults hide scrollbars and therefore miss classic-scrollbar layout feedback.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

test("a fitting demo settles at fractional zoom with visible scrollbars", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 621 });
    await page.goto("/");
    await page.addStyleTag({ content: ".st-viewport::-webkit-scrollbar { width: 15px; height: 15px; }" });
    await expect(page.locator("#analysis-status")).toContainText("syntax & emit");
    await page.evaluate(() => document.fonts.ready.then(() => {}));
    // Let optional provider decorations settle before counting presentation mutations.
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30_000 });
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

test("using the editor scrollbar keeps typing in the focused host field", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "Requires a native scrollbar track.");
    await page.goto("/comparison/");
    await page.evaluate(() => {
        const f = window.comparisonFixture;
        f.setText("target\n" + "body\n".repeat(500));
        f.begin("accept"); f.finish("accept");
        const field = document.createElement("input");
        field.id = "host-query";
        document.body.prepend(field);
        field.focus();
    });
    await ready(page);
    const track = await page.evaluate(() => {
        const viewport = window.comparisonFixture.review.panes.working.viewport.element;
        const box = viewport.getBoundingClientRect(), left = box.left + viewport.clientLeft + viewport.clientWidth;
        return { x: (left + box.right - viewport.clientLeft) / 2, top: box.top + viewport.clientTop, height: viewport.clientHeight };
    });
    await page.mouse.move(track.x, track.top + 23);
    await page.mouse.down();
    await page.mouse.move(track.x, track.top + track.height / 3, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => window.comparisonFixture.review.panes.working.viewport.element.scrollTop)).toBeGreaterThan(0);
    await expect(page.locator("#host-query")).toBeFocused();
    await page.mouse.click(track.x, track.top + track.height * .8);
    await page.keyboard.type("price");
    await expect(page.locator("#host-query")).toHaveValue("price", { timeout: 1000 });
    expect(await page.evaluate(() => window.comparisonFixture.range(0, 6))).toBe("target");
});

test("typing after a native scrollbar drag or track click edits the selected source", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "Requires a native scrollbar track.");
    await page.goto("/editing/");
    await page.evaluate(() => window.editingFixture.setText("target\n" + "body\n".repeat(500)));
    const input = page.getByRole("textbox", { name: "Primary source", exact: true });
    const viewport = page.locator("#primary .st-viewport");
    for (const gesture of ["drag", "track", "track with delayed scroll events"]) {
        await page.evaluate(() => window.editingFixture.select("primary", { anchor: 0, head: 1 }));
        await input.focus();
        await ready(page);
        const track = await viewport.evaluate(el => {
            const rect = el.getBoundingClientRect();
            const left = rect.left + el.clientLeft + el.clientWidth;
            return { x: (left + rect.right - el.clientLeft) / 2, width: rect.right - el.clientLeft - left,
                top: rect.top + el.clientTop, height: el.clientHeight };
        });
        expect(track.width).toBeGreaterThan(2);
        const delayed = gesture === "track with delayed scroll events" ? await viewport.evaluateHandle(el => {
            const started = new Promise<void>(resolve => el.addEventListener("scroll", () => resolve(), { once: true }));
            // The native track still moves. Delay only delivery of its scroll events to the viewport.
            const finished = new Promise<void>(resolve => el.ownerDocument.addEventListener("input", () => {
                const events = new AbortController();
                el.addEventListener("scroll", e => e.stopImmediatePropagation(), { capture: true, signal: events.signal });
                setTimeout(() => { events.abort(); resolve(); }, 80);
            }, { once: true }));
            return { started, finished };
        }) : undefined;
        const middle = track.top + track.height / 2;
        if (gesture === "drag") {
            await page.mouse.move(track.x, track.top + 23);
            await page.mouse.down();
            await page.mouse.move(track.x, middle, { steps: 8 });
            await page.mouse.up();
        } else await page.mouse.click(track.x, middle);
        if (delayed) await delayed.evaluate(pending => pending.started);
        await expect.poll(() => viewport.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
        await expect(input).toBeFocused();
        const letter = gesture === "drag" ? "D" : "T";
        await page.keyboard.type(letter);
        if (delayed) { await delayed.evaluate(pending => pending.finished); await delayed.dispose(); }
        // Track clicks may keep animating after pointerup. Check the final painted row.
        await viewport.evaluate(el => new Promise<void>(resolve => {
            let quietFrames = 0;
            const moved = () => { quietFrames = 0; };
            el.addEventListener("scroll", moved);
            function frame(): void {
                if (++quietFrames < 4) requestAnimationFrame(frame);
                else { el.removeEventListener("scroll", moved); resolve(); }
            }
            requestAnimationFrame(frame);
        }));
        const edited = viewport.locator('.st-viewport-row[data-line="0"]');
        const position = await viewport.evaluate(el => ({
            nativeTop: el.scrollTop, paintedTop: window.editingFixture.snapshot().primary.viewport.scrollTop,
            rowTop: el.querySelector('.st-viewport-row[data-line="0"]')?.getBoundingClientRect().top ?? null,
            viewportTop: el.getBoundingClientRect().top,
        }));
        const target = expect(edited, gesture + " " + JSON.stringify(position));
        await target.toHaveText(letter + "arget");
        await target.toBeInViewport();
    }
});
