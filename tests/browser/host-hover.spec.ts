import { ready, isolatedTest as test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
import { holdLspReplies } from "../helpers/lsp-replies.ts";
import { paintedCharacter } from "../helpers/painted-character.ts";
import { publishFixtureDiagnostics, sourceDiagnosticUri } from "./fixture-diagnostics.ts";
const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const primary = (page: Page) => page.getByRole("textbox", { name: "Primary source", exact: true });
const tooltip = (page: Page) => page.getByRole("tooltip");

async function point(page: Page, column = 1): Promise<{ x: number; y: number }> {
    return page.locator('.st-editor:has(> textarea[aria-label="Primary source"]) .st-viewport-row').first().evaluate((row, offset) => {
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const length = node.textContent!.length;
            if (offset < length) {
                const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 1);
                const box = range.getBoundingClientRect(); return { x: box.left + box.width / 4, y: box.top + box.height / 2 };
            }
            offset -= length;
        }
        throw new Error("No rendered text at this column.");
    }, column);
}

test("pointer hover uses the latest position when diagnostics divide a symbol", async ({ page }) => {
    const replies = await holdLspReplies(page, "textDocument/hover");
    await page.goto("/hosts/plain/?language=lsp"); await ready(page);
    await page.evaluate(() => { const f = window.hostFixture, doc = f.snapshot().source; f.editSource(doc.revision, [{ from: 0, to: doc.length, insert: "TODOvalue = other;" }]); });
    const field = primary(page), warning = page.getByRole("button", { name: /Resolve this placeholder/ }).first();
    await field.focus(); await field.press("Control+Home"); await field.press("Control+Space"); await expect(warning).toBeVisible(); await field.press("Escape");
    const uri = await sourceDiagnosticUri(page);
    const move = async (column: number) => { const at = await point(page, column); await page.mouse.move(at.x, at.y); };
    replies.hold();
    await move(2);
    await expect.poll(replies.waiting).toBe(true);
    await expect(tooltip(page)).toContainText("Resolve this placeholder.");
    await expect(tooltip(page)).not.toContainText("Symbol in this source.");
    await replies.release();
    await expect(tooltip(page)).toContainText("TODOvalue Symbol in this source.");
    await expect(tooltip(page)).toContainText("Resolve this placeholder.");
    await publishFixtureDiagnostics(page, uri, "clear"); await expect(warning).toBeHidden();
    const initial = replies.requestCount();
    await page.clock.install(); await move(7); await page.clock.runFor(400);
    await publishFixtureDiagnostics(page, uri, "normal"); await expect(warning).toBeVisible();
    await expect(tooltip(page)).not.toContainText("Resolve this placeholder.");
    await move(2); await expect(tooltip(page)).toContainText("Resolve this placeholder.");
    expect(replies.requestCount()).toBe(initial);
    await move(13); await expect(tooltip(page)).toContainText("other Symbol in this source.");
    expect(replies.requestCount()).toBe(initial + 1);
});
test(`plain keyboard hover keeps complete selections, safe text, input focus and shared history`, async ({ page }) => {
    const replies = await holdLspReplies(page, "textDocument/hover");
    await page.goto(`/hosts/plain/?language=lsp`);
    const original = "const café = 1;\r\n𐐀value = 2;";
    await page.evaluate(text => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]); f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 2, head: 2 }, { anchor: 7, head: 7 }]); }, original);
    await primary(page).focus(); await ready(page); const before = await snapshot(page), selected = before.bindings.views.find(v => v.id === "primary")!.selectionSet;
    await primary(page).press("Control+k"); await primary(page).press("Control+i");
    // A delayed pointer move over blank space must not cancel keyboard inspection.
    await primary(page).locator("..").dispatchEvent("pointermove", { clientX: -100, clientY: -100, buttons: 0 });
    await expect(tooltip(page)).toContainText("Declares a constant binding."); expect(await primary(page).evaluate(node => node.ownerDocument.activeElement === node)).toBe(true);
    // Keyboard inspection anchors to the returned word, even with the caret inside it.
    const wordStart = await page.locator('.st-editor:has(> textarea[aria-label="Primary source"]) .st-viewport-row').first().evaluate(row => {
        const node = document.createTreeWalker(row, NodeFilter.SHOW_TEXT).nextNode()!;
        const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 1); return range.getBoundingClientRect().left;
    });
    await expect.poll(async () => Math.abs((await tooltip(page).boundingBox())!.x - wordStart)).toBeLessThan(2);
    await page.evaluate(() => window.hostFixture.externalWrite("remote")); await primary(page).press("Control+s");
    await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1); await page.evaluate(() => window.hostFixture.finishSave());
    await expect(page.getByRole("region", { name: "Save conflict", exact: true })).toBeVisible();
    await expect.poll(async () => { const popup = await tooltip(page).boundingBox(), root = await page.locator('.st-editor:has(> textarea[aria-label="Primary source"])').boundingBox(); return popup && root ? popup.y - root.y : -1; }).toBeGreaterThan(0);
    await tooltip(page).click(); expect(await primary(page).evaluate(node => node.ownerDocument.activeElement === node)).toBe(true);
    await primary(page).press("Escape"); await expect(tooltip(page)).toBeHidden(); expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selectionSet).toEqual(selected);
    expect((await snapshot(page)).history).toEqual(before.history); expect((await snapshot(page)).source.revision).toBe(before.source.revision);
    await page.evaluate(() => window.hostFixture.faultHoverNext("primary", "markup")); await primary(page).press("Control+k"); await primary(page).press("Control+i");
    await expect(tooltip(page)).toContainText("<img"); await expect(tooltip(page).locator("img,script")).toHaveCount(0); expect(await page.evaluate(() => Reflect.get(window, "hoverExecuted"))).toBeUndefined();
    const word = await paintedCharacter(tooltip(page), "literal information", 2);
    await page.mouse.dblclick(word.x, word.y);
    await expect.poll(() => page.evaluate(() => getSelection()?.toString().trim())).toBe("literal");
    await page.keyboard.type("X"); await ready(page); await expect(tooltip(page)).toBeHidden(); await expect(primary(page)).toBeFocused();
    expect(await page.evaluate(() => window.hostFixture.range(0, window.hostFixture.snapshot().source.length))).toBe(original.slice(0, 2) + "X" + original.slice(2, 7) + "X" + original.slice(7));
    expect((await snapshot(page)).history.undoDepth).toBe(before.history.undoDepth + 1);
    await page.evaluate(() => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: "const working = 1;\r\nconst second = 2;" }]); });
    await page.getByRole("button", { name: "Open source review", exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).bindings.comparison?.status).toBe("ready");
    await page.evaluate(() => { const f = window.hostFixture; f.selectSourceSet("comparison", f.snapshot().source.revision, [{ anchor: 2, head: 2 }]); });
    const working = page.getByRole("textbox", { name: "Comparison working source", exact: true });
    await working.focus(); await ready(page); await working.press("Control+k"); await working.press("Control+i"); await expect(tooltip(page)).toContainText("Declares a constant binding.");
    await expect(working.locator("..").getByRole("tooltip")).toBeVisible();
    await tooltip(page).dispatchEvent("scroll"); await expect(tooltip(page)).toBeVisible();
    expect(await working.evaluate(node => node.ownerDocument.activeElement === node)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`hover-plain.png`) }); await expect(tooltip(page)).toBeVisible();
    const captured = await snapshot(page);
    replies.hold(); await page.evaluate(() => window.hostFixture.inspectSymbol("comparison")); await expect.poll(replies.waiting).toBe(true);
    await page.evaluate(() => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, [{ anchor: 2, head: 2 }]); });
    await primary(page).focus(); await ready(page); await primary(page).press("Control+k"); await primary(page).press("Control+i"); await expect(tooltip(page)).toContainText("Declares a constant binding.");
    await expect.poll(replies.cancelled).toBe(true); await replies.release();
    await expect(working.locator("..").getByRole("tooltip")).toBeHidden();
    await expect(primary(page).locator("..").getByRole("tooltip")).toContainText("Declares a constant binding.");
    const after = await snapshot(page);
    expect(after.bindings.comparison!.selectionSet).toEqual(captured.bindings.comparison!.selectionSet); expect(after.history).toEqual(captured.history);
    expect(after.source.revision).toBe(captured.source.revision);
    await tooltip(page).focus();
    await page.getByRole("heading", { level: 1 }).click();
    await expect(tooltip(page)).toBeHidden();
    await page.evaluate(() => window.hostFixture.dispose()); const final = await snapshot(page);
    expect(final.bindings.lsp).toMatchObject({ scopes: 0, documents: 0, created: 1, terminated: 1 });
});
test(`plain pointer hover preserves host focus and refuses stale replies across edits and remount`, async ({ page }) => {
    test.setTimeout(90000); const replies = await holdLspReplies(page, "textDocument/hover"); await page.goto(`/hosts/plain/?language=lsp`);
    await page.evaluate(() => { const f = window.hostFixture, text = "const sample = 1234567;\r\n".repeat(300); f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]); f.setSourceReadOnly(true); });
    await primary(page).press("Control+Home"); await ready(page); const form = page.getByRole("textbox", { name: "Configuration path", exact: true }); await form.fill("keep-focus.csv");
    const at = await point(page); await page.mouse.move(at.x, at.y); await expect(tooltip(page)).toContainText("Declares a constant binding.");
    expect(await form.evaluate(node => node.ownerDocument.activeElement === node)).toBe(true);
    await tooltip(page).evaluate(node => node.focus({ preventScroll: true }));
    await primary(page).evaluate(node => node.focus({ preventScroll: true })); await expect(tooltip(page)).toBeVisible();
    await tooltip(page).evaluate(node => node.focus({ preventScroll: true }));
    await form.evaluate(node => node.focus({ preventScroll: true })); await expect(tooltip(page)).toBeHidden();
    replies.hold(); await page.evaluate(() => { const f = window.hostFixture; f.setSourceReadOnly(false); f.inspectSymbol("primary"); }); await expect.poll(replies.waiting).toBe(true);
    await page.evaluate(() => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: 0, insert: "human" }]); });
    await expect(tooltip(page)).toBeHidden(); await expect.poll(replies.cancelled).toBe(true); await replies.release(); await expect(tooltip(page)).toBeHidden();
    expect(await form.evaluate(node => node.ownerDocument.activeElement === node)).toBe(true); expect(await page.evaluate(() => window.hostFixture.range(0, 5))).toBe("human");
    await page.mouse.move(1, 1);
    replies.hold(); await page.evaluate(() => window.hostFixture.inspectSymbol("primary")); await expect.poll(replies.waiting).toBe(true);
    const history = (await snapshot(page)).history;
    await page.evaluate(() => { const f = window.hostFixture; f.unmount(); f.mount(); }); await ready(page); await expect(tooltip(page)).toBeHidden();
    await expect.poll(replies.cancelled).toBe(true); await primary(page).focus(); await replies.release(); await expect(tooltip(page)).toBeHidden();
    expect((await snapshot(page)).history).toEqual(history);
    await page.evaluate(() => { const f = window.hostFixture, at = f.range(0, 100).indexOf("\r\n") + 4; f.selectSource("primary", f.snapshot().source.revision, { anchor: at, head: at }); });
    await primary(page).press("Control+k"); await primary(page).press("Control+i"); await expect(tooltip(page)).toContainText("Declares a constant binding.");
    expect(await page.evaluate(() => window.hostFixture.range(0, 5))).toBe("human");
    await page.evaluate(() => window.hostFixture.dispose()); const final = await snapshot(page);
    expect(final.bindings.lsp).toMatchObject({ scopes: 0, documents: 0, created: 1, terminated: 1 });
});
