import { ready, test, expect } from "./fixtures.ts";

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
        popup.textContent = "Range popup"; document.body.append(popup);
        const events: string[] = [], overlay = f.overlay(popup, { dismissOn: ["focus-leave"], onDismiss: reason => events.push(reason) });
        const show = () => overlay.show({ revision: f.snapshot().document!.revision, from: 6, to });
        show(); return { show, events, dispose: () => { overlay.dispose(); popup.remove(); } };
    }, text.length - 6);
    const popup = page.getByRole("button", { name: "Range popup", includeHidden: true });
    await expect(popup).toBeVisible();
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
    expect(await call.evaluate(value => value.events)).toEqual(["focus-leave"]);
    await call.evaluate(value => value.show()); await expect(popup).toBeVisible();
    await page.evaluate(() => window.editingFixture.edit([{ from: 0, to: 0, insert: "x" }]));
    await expect(popup).toBeHidden(); await expect(other).toBeFocused();
    await call.evaluate(value => value.dispose()); await call.dispose();
});
