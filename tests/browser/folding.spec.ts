import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
const input = (page: Page, name = "Primary source") => page.getByRole("textbox", { name, exact: true });
test("automatic discovery preserves newer view choices, cancels changed targets and waits for composition", async ({ page }) => {
    await page.goto("/editing/");
    await page.evaluate(() => {
        const f = window.editingFixture; f.setText("head\n  child\nend");
        const pending: { signal: AbortSignal; resolve: (value: readonly { from: number; to: number }[]) => void }[] = [];
        Object.assign(window, { pendingFolds: pending });
        f.discoverFolds((_, signal) => new Promise(resolve => pending.push({ signal, resolve })));
    });
    const count = () => page.evaluate(() => (window as unknown as { pendingFolds: unknown[] }).pendingFolds.length);
    const resolve = () => page.evaluate(() => (window as unknown as { pendingFolds: { resolve: (value: readonly { from: number; to: number }[]) => void }[] }).pendingFolds.at(-1)!.resolve([{ from: 0, to: 13 }]));
    await expect.poll(count).toBe(1); await resolve();
    await expect.poll(() => page.evaluate(() => window.editingFixture.foldStatus()?.status)).toBe("ready");
    await page.evaluate(() => window.editingFixture.refreshFolds()); await expect.poll(count).toBe(2);
    await page.evaluate(() => window.editingFixture.foldCommand("collapse-all")); await resolve();
    await expect.poll(() => page.evaluate(() => window.editingFixture.foldStatus()?.status)).toBe("ready");
    expect((await page.evaluate(() => window.editingFixture.folding())).regions[0]!.collapsed).toBe(true);
    await page.evaluate(() => window.editingFixture.refreshFolds()); await expect.poll(count).toBe(3);
    await input(page).dispatchEvent("compositionstart", { data: "" });
    await resolve();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect((await page.evaluate(() => window.editingFixture.foldStatus()))?.status).toBe("pending");
    await input(page).dispatchEvent("compositionend", { data: "" });
    await expect.poll(() => page.evaluate(() => window.editingFixture.foldStatus()?.status)).toBe("ready");
    await page.evaluate(() => window.editingFixture.refreshFolds()); await expect.poll(count).toBe(4);
    await page.evaluate(() => window.editingFixture.setText("new\n  body\nlast"));
    expect(await page.evaluate(() => (window as unknown as { pendingFolds: { signal: AbortSignal }[] }).pendingFolds[3]!.signal.aborted)).toBe(true);
    await expect.poll(count).toBe(5); await page.evaluate(() => window.editingFixture.replacePrimary()); await resolve();
    expect(await page.evaluate(() => (window as unknown as { pendingFolds: { signal: AbortSignal }[] }).pendingFolds[4]!.signal.aborted)).toBe(true);
    await page.evaluate(() => window.editingFixture.dispose());
    expect((await page.evaluate(() => window.editingFixture.snapshot())).diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 });
});
test("a host generator may invalidate itself without reentrant cancellation or leaking its iterator", async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message)); await page.goto("/editing/");
    await page.evaluate(() => {
        const f = window.editingFixture; f.setText("head\n  child\nend"); let first = true;
        Object.assign(window, { foldIteratorClosed: false });
        f.discoverFolds(function* () {
            if (first) { first = false; try { f.edit([{ from: 0, to: 0, insert: "prefix\n" }]); yield; } finally { Object.assign(window, { foldIteratorClosed: true }); } }
            return [];
        });
    });
    await expect.poll(() => page.evaluate(() => window.editingFixture.foldStatus()?.status)).toBe("ready");
    expect(await page.evaluate(() => (window as unknown as { foldIteratorClosed: boolean }).foldIteratorClosed)).toBe(true); expect(errors).toEqual([]);
});
async function ready(page: Page): Promise<void> {
    await expect.poll(() => page.evaluate(() => { const f = window.editingFixture, s = f.snapshot();
        return !s.primary.pendingCaret && !s.primary.viewport.pending && !s.secondary.pendingCaret && !s.secondary.viewport.pending
            && s.primary.viewport.revision === s.document!.revision && s.primary.viewport.foldGeneration === f.folding().generation;
    })).toBe(true);
}
test("folded rows keep independent views, disclosure keys and visible-line navigation while Find reveals raw matches", async ({ page }) => {
    await page.goto("/editing/"); const text = "head\r\none\r\ntwo\r\nlast\r\n";
    await page.evaluate(text => { const f = window.editingFixture; f.setText(text); f.folds([{ id: "body", from: 0, to: text.indexOf("last"), collapsed: true }]); }, text); await ready(page);
    const primary = page.locator("#primary .st-viewport-row"), secondary = page.locator("#secondary .st-viewport-row");
    expect(await primary.allTextContents()).toEqual(["head", "last", ""]); expect(await secondary.allTextContents()).toEqual(["head", "one", "two", "last", ""]);
    await expect(primary.first()).toHaveAttribute("data-folded-summary", "… 2 lines hidden");
    expect(await primary.first().evaluate(node => getComputedStyle(node, "::after").content)).toContain("2 lines hidden");
    // The marker is presentation only: full raw copy and text-node geometry still address source.
    const copied = await input(page).evaluate(node => {
        const f = window.editingFixture; f.select("primary", { anchor: 0, head: f.snapshot().document!.length });
        const event = new ClipboardEvent("copy", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true }); node.dispatchEvent(event);
        f.select("primary", { anchor: 0, head: 0 }); return event.clipboardData!.getData("text/plain");
    }); expect(copied).toBe(text);
    await input(page).press("Escape"); await input(page).press("Shift+Tab");
    expect(await page.evaluate(() => document.getElementById("primary")!.contains(document.activeElement))).toBe(false);
    await input(page).focus(); await input(page).press("Escape"); await input(page).press("Tab");
    expect(await page.evaluate(() => document.getElementById("primary")!.contains(document.activeElement))).toBe(false);
    await input(page).press("ArrowDown"); await ready(page); expect((await page.evaluate(() => window.editingFixture.snapshot())).primary.selection.head).toBe(16);
    await input(page).press("ArrowUp"); await ready(page); expect((await page.evaluate(() => window.editingFixture.snapshot())).primary.selection.head).toBe(0);
    await input(page).press("End"); await input(page).press("ArrowRight"); await ready(page); expect((await page.evaluate(() => window.editingFixture.snapshot())).primary.selection.head).toBe(16);
    const disclosure = page.getByRole("button", { name: "Expand lines 2–3", exact: true }); await disclosure.focus(); await disclosure.press("Space"); await ready(page);
    await expect(page.getByRole("button", { name: "Collapse lines 2–3", exact: true })).toHaveAttribute("aria-expanded", "true"); expect(await primary.allTextContents()).toEqual(["head", "one", "two", "last", ""]);
    await expect(primary.first()).not.toHaveAttribute("data-folded-summary");
    await page.getByRole("button", { name: "Collapse lines 2–3", exact: true }).press("Enter"); await ready(page);
    expect(await primary.allTextContents()).toEqual(["head", "last", ""]);
    // A queued viewport paint between pointerdown/up must preserve the pressed disclosure.
    await disclosure.hover(); await page.mouse.down();
    const painted = await disclosure.evaluate(() => new Promise<boolean>(resolve => {
        const f = window.editingFixture, before = f.snapshot().primary.viewport.renders;
        f.select("primary", { anchor: 1, head: 1 });
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(f.snapshot().primary.viewport.renders > before)));
    })); expect(painted).toBe(true);
    await page.mouse.up(); await expect(page.getByRole("button", { name: "Collapse lines 2–3", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Collapse lines 2–3", exact: true }).press("Enter"); await ready(page);
    await page.getByRole("textbox", { name: "Find", exact: true }).fill("two"); await expect(page.locator("#find-status")).toContainText("1 matches · ready");
    await page.getByRole("button", { name: "Next match", exact: true }).click(); await ready(page);
    expect((await page.evaluate(() => window.editingFixture.snapshot())).primary.selection).toMatchObject({ anchor: 11, head: 14 });
    expect((await page.evaluate(() => window.editingFixture.folding())).regions[0]!.collapsed).toBe(false);
    await input(page).pressSequentially("TWO"); await ready(page); expect(await page.evaluate(() => window.editingFixture.range(0, 22))).toBe("head\r\none\r\nTWO\r\nlast\r\n");
    await input(page, "Secondary source").press("Control+z"); await ready(page); expect(await page.evaluate(() => window.editingFixture.range(0, 22))).toBe(text);
    expect((await page.evaluate(() => window.editingFixture.snapshot())).document!.exports).toBe(0);
    await page.evaluate(() => window.editingFixture.dispose()); expect((await page.evaluate(() => window.editingFixture.snapshot())).diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 });
});
test("a 100k-line fold keeps row work bounded, maps edits and undo, and reveals a hidden typing target", async ({ page }) => {
    test.setTimeout(120000); await page.goto("/editing/"); const text = "start\r\n" + "const row = 1;\r\n".repeat(100000) + "end", end = text.length - 3;
    await page.evaluate(({ text, end }) => { const f = window.editingFixture; f.setText(text); f.folds([{ id: "many", from: 0, to: end, collapsed: true }]); }, { text, end }); await ready(page);
    let state = await page.evaluate(() => window.editingFixture.snapshot()); expect(state.primary.viewport.visibleLines).toBe(2); expect(state.primary.viewport.rows).toBe(2); expect(state.primary.inputUnits).toBeLessThanOrEqual(2600);
    expect(await page.locator("#primary .st-viewport-row").allTextContents()).toEqual(["start", "end"]);
    await expect(page.locator("#primary .st-viewport-row").first()).toHaveAttribute("data-folded-summary", "… 100000 lines hidden");
    await input(page).press("PageDown"); await ready(page); expect((await page.evaluate(() => window.editingFixture.snapshot())).primary.selection.head).toBe(end);
    await input(page).press("PageUp"); await ready(page); expect((await page.evaluate(() => window.editingFixture.snapshot())).primary.selection.head).toBe(0);
    const middle = Math.floor(text.length / 2); await page.evaluate(at => window.editingFixture.edit([{ from: at, to: at, insert: "new\r\n" }]), middle); await ready(page);
    state = await page.evaluate(() => window.editingFixture.snapshot()); expect(state.primary.viewport.visibleLines).toBe(2); expect(state.primary.viewport.rows).toBe(2);
    await input(page, "Secondary source").press("Control+z"); await ready(page); expect((await page.evaluate(() => window.editingFixture.snapshot())).primary.viewport.visibleLines).toBe(2);
    await page.evaluate(at => window.editingFixture.select("primary", { anchor: at, head: at }), middle); await ready(page);
    expect((await page.evaluate(() => window.editingFixture.folding())).regions[0]!.collapsed).toBe(false);
    await page.evaluate(end => window.editingFixture.folds([{ id: "many", from: 0, to: end, collapsed: true }]), end); await ready(page);
    await input(page).pressSequentially("!"); await ready(page); state = await page.evaluate(() => window.editingFixture.snapshot());
    expect(state.primary.selection.head).toBe(middle + 1); expect(state.primary.viewport.visibleLines).toBe(100002); expect(state.document!.exports).toBe(0);
    expect(await page.evaluate(at => window.editingFixture.range(at, at + 5), middle)).toBe("!" + text.slice(middle, middle + 4));
    await page.evaluate(() => window.editingFixture.dispose()); expect((await page.evaluate(() => window.editingFixture.snapshot())).diagnostics).toMatchObject({ views: 0, leases: 0, subscriptions: 0 });
});
