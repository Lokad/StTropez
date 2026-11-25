import { ready, test, expect } from "./fixtures.ts";

test("a growing popup moves when its opening side can no longer show the content", async ({ page }) => {
    await page.goto("/editing/");
    await page.evaluate(() => {
        document.querySelector<HTMLElement>("#primary")!.style.cssText = "position:fixed;top:100px;left:50px;width:600px;height:450px";
        window.editingFixture.setText("source");
    });
    await ready(page);
    const call = await page.evaluateHandle(() => {
        const f = window.editingFixture, element = document.createElement("aside");
        element.textContent = "Result"; element.style.cssText = "width:160px;height:30px"; document.body.append(element);
        const overlay = f.overlay(element, { prefer: "above" }), anchor = { revision: f.snapshot().document!.revision, offset: 1 };
        overlay.show(anchor);
        return { element, grow() { element.style.height = "250px"; overlay.show(anchor); }, dispose() { overlay.dispose(); element.remove(); } };
    });
    try {
        await expect.poll(() => call.evaluate(({ element }) => !element.hidden && element.getBoundingClientRect().bottom <= window.editingFixture.coords(1)!.top)).toBe(true);
        await call.evaluate(handle => handle.grow());
        await expect.poll(() => call.evaluate(({ element }) => {
            const box = element.getBoundingClientRect(), caret = window.editingFixture.coords(1)!;
            return [box.height, box.top >= caret.top + caret.height];
        })).toEqual([250, true]);
    } finally { await call.evaluate(handle => handle.dispose()); await call.dispose(); }
});

test("a range follows its painted text through horizontal clipping and folding until focus leaves", async ({ page }) => {
    await page.goto("/editing/");
    const text = "head\r\n" + "0123456789".repeat(2000) + "\r\ntail";
    await page.evaluate(text => {
        const f = window.editingFixture;
        f.setText(text); f.discoverFolds(() => [{ from: 0, to: text.length - 4, group: "block" }]);
        f.select("primary", { anchor: 1, head: 1 }); f.focus("primary");
    }, text);
    const fold = page.locator("#primary .st-fold-button"), viewport = page.locator("#primary .st-viewport");
    await expect(fold).toHaveAttribute("aria-expanded", "true"); await ready(page);
    const call = await page.evaluateHandle(to => {
        const f = window.editingFixture, popup = document.createElement("button");
        popup.textContent = "Range popup";
        popup.onclick = () => { popup.dataset.clicked = "true"; };
        const root = document.querySelector<HTMLElement>("#primary .st-editor")!;
        root.style.setProperty("--popup-theme", "local");
        root.style.transform = "translateX(12px)";
        root.style.zoom = "1.25";
        const events: string[] = [], overlay = f.overlay(popup, { dismissOn: ["focus-leave"], onHide(reason, hadFocus) {
            events.push(reason);
            if (hadFocus && (reason === "clipped" || reason === "expired")) f.focus("primary");
        } });
        const show = () => overlay.show({ revision: f.snapshot().document!.revision, from: 6, to });
        show(); return { show, events, hide: overlay.hide, dispose: overlay.dispose };
    }, text.length - 6);
    const popup = page.getByRole("button", { name: "Range popup", includeHidden: true });
    await expect(popup).toBeVisible();
    expect(await popup.evaluate(el => [el.parentElement?.matches(".st-editor"), getComputedStyle(el).getPropertyValue("--popup-theme")]))
        .toEqual([true, "local"]);
    expect(await popup.evaluate(el => Math.abs(el.getBoundingClientRect().left - window.editingFixture.coords(6)!.left))).toBeLessThan(2);
    await popup.click();
    await expect(popup).toHaveAttribute("data-clicked", "true");
    await viewport.evaluate(el => { el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2; }); await ready(page);
    await expect.poll(() => page.evaluate(() => window.editingFixture.snapshot().primary.viewport.scrollLeft)).toBeGreaterThan(100);
    expect(await page.evaluate(to => [window.editingFixture.coords(6), window.editingFixture.coords(to)], text.length - 6)).toEqual([undefined, undefined]);
    await expect(popup).toBeVisible();
    await viewport.evaluate(el => { el.scrollLeft = 0; }); await ready(page);
    await fold.click(); await expect(fold).toHaveAttribute("aria-expanded", "false"); await expect(popup).toBeHidden();
    await fold.click(); await expect(popup).toBeVisible();
    await popup.focus(); await expect(popup).toBeFocused();
    const other = page.getByRole("textbox", { name: "Secondary source", exact: true });
    await other.focus(); await expect(popup).toBeHidden(); await expect(other).toBeFocused();
    expect(await call.evaluate(value => value.events)).toEqual(["clipped", "focus-leave"]);
    await call.evaluate(value => value.show()); await expect(popup).toBeVisible();
    await page.evaluate(() => window.editingFixture.edit([{ from: 0, to: 0, insert: "x" }]));
    await expect(popup).toBeHidden(); await expect(other).toBeFocused();
    await call.evaluate(value => value.show()); await expect(popup).toBeVisible(); await popup.focus();
    await page.evaluate(() => window.editingFixture.edit([{ from: 0, to: 0, insert: "y" }]));
    await expect(popup).toBeHidden();
    const input = page.getByRole("textbox", { name: "Primary source", exact: true });
    await expect(input).toBeFocused(); await page.keyboard.type("!"); await expect(input).toHaveValue(/!/);
    await call.evaluate(value => { value.show(); value.hide(); value.hide(); value.show(); value.dispose(); value.dispose(); });
    expect(await call.evaluate(value => value.events)).toEqual(["clipped", "focus-leave", "expired", "expired", "hide", "disposed"]);
    await expect(popup).toHaveCount(0);
    await call.dispose();
});
