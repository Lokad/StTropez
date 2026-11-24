import { ready, test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
import { hostTextEquals } from "../../scripts/host-scene.mjs";
const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const source = (page: Page, name = "Primary source") => page.getByRole("textbox", { name, exact: true });
const click = (page: Page, name: string) => page.getByRole("button", { name, exact: true }).click();

async function exact(page: Page, value: string, reference = false): Promise<void> { expect(await hostTextEquals(page, value, reference ? "reference" : "source")).toBe(true); }
test(`plain match-case find keeps Unicode ranges, shared undo, comparison and working Save/Run`, async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(`/hosts/plain/`);
    const original = "K k K_ 𐐀 𐐨 i ı ss ß café\r\nunchanged\r\nK";
    await page.evaluate(text => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]); }, original);
    await click(page, "Open source review"); await ready(page); await click(page, "Keep draft version");
    await page.getByRole("combobox", { name: "Review version", exact: true }).selectOption("draft"); await click(page, "Finish version load"); await ready(page);
    const baseline = (await snapshot(page)).bindings.comparison!.baseline!.version;
    await source(page).press("Control+Home"); await source(page).press("Control+f");
    const query = page.getByRole("textbox", { name: "Find source", exact: true }), replacement = page.getByRole("textbox", { name: "Replacement", exact: true });
    const matchCase = page.getByRole("checkbox", { name: "Match case", exact: true }), wholeWord = page.getByRole("checkbox", { name: "Whole word", exact: true }), status = page.getByLabel("Find status", { exact: true });
    await expect(matchCase).toBeChecked(); await query.fill("k"); await expect(status).toContainText("1 matches · ready");
    await matchCase.uncheck(); await expect(status).toContainText("4 matches · ready"); await wholeWord.check(); await expect(status).toContainText("3 matches · ready");
    await wholeWord.press("F3"); await ready(page); expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selection).toMatchObject({ anchor: 0, head: 1 });
    await replacement.press("F3"); await ready(page); expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selection).toMatchObject({ anchor: 2, head: 3 });
    await page.getByRole("button", { name: "Find previous", exact: true }).press("Shift+F3"); await ready(page); expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selection).toMatchObject({ anchor: 0, head: 1 });
    await page.getByRole("button", { name: "Find next", exact: true }).press("Control+f"); await expect(query).toBeFocused(); expect(await query.evaluate(n => n instanceof HTMLInputElement && n.selectionStart === 0 && n.selectionEnd === n.value.length)).toBe(true);
    await wholeWord.press("Control+h"); await expect(replacement).toBeFocused(); await replacement.fill("$&"); const before = await snapshot(page); await replacement.press("Enter"); await ready(page); await exact(page, "$&" + original.slice(1));
    expect((await snapshot(page)).history.undoDepth).toBe(before.history.undoDepth + 1);
    await source(page, "Secondary source").press("Control+z"); await ready(page); await exact(page, original);
    await source(page, "Comparison working source").press("Control+f"); await expect(matchCase).not.toBeChecked(); await expect(wholeWord).toBeChecked(); await expect(status).toContainText("3 matches · ready");
    await query.fill("𐐨"); await expect(status).toContainText("2 matches · ready"); await query.press("Escape"); const current = source(page, "Comparison working source"); await current.press("Control+Home"); await current.press("F3"); await expect(status).toContainText("2 matches · ready"); await ready(page); await expect.poll(async () => (await snapshot(page)).bindings.comparison!.selection.anchor).toBe(original.indexOf("𐐀")); expect((await snapshot(page)).bindings.language.navigationPending).toBe(false);
    const selected = (await snapshot(page)).bindings.comparison!.selection; expect(selected.head - selected.anchor).toBe(2);
    expect(await page.evaluate(({ from, to }) => window.hostFixture.range(from, to), { from: selected.anchor, to: selected.head })).toMatch(/^[𐐀𐐨]$/u);
    await query.fill("k"); await expect(status).toContainText("3 matches · ready"); await replacement.fill("dog"); const planned = await snapshot(page);
    await click(page, "Replace all"); await expect(status).toContainText("Replaced 3 matches."); await ready(page);
    const changed = "dog dog" + original.slice(3, -1) + "dog"; await exact(page, changed); await exact(page, original, true);
    expect((await snapshot(page)).history.undoDepth).toBe(planned.history.undoDepth + 1);
    await source(page, "Secondary source").press("Control+z"); await ready(page); await exact(page, original);
    await source(page, "Secondary source").press("Control+Shift+z"); await ready(page); await exact(page, changed);
    const working = source(page, "Comparison working source");
    await working.press("Control+f");
    for (const control of [wholeWord, matchCase]) {
        const beforeExit = await snapshot(page);
        await control.press("Escape");
        await ready(page);
        await expect(working).toBeFocused();
        const afterExit = await snapshot(page);
        expect(afterExit.bindings.comparison!.selectionSet).toEqual(beforeExit.bindings.comparison!.selectionSet);
        expect(afterExit.history).toEqual(beforeExit.history);
        expect(afterExit.source.revision).toBe(beforeExit.source.revision);
        await working.press("Control+f");
        await expect(status).toContainText("0 matches · ready");
    }
    for (const control of [wholeWord, matchCase]) {
        await control.focus();
        await control.press("Control+s");
        await expect(control).toBeFocused();
        if (control === wholeWord) {
            await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
            await click(page, "Finish save");
            await expect.poll(async () => (await snapshot(page)).pendingCommands).toBe(0);
        }
    }
    await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
    expect((await snapshot(page)).pendingSaves[0]!.length).toBe(changed.length);
    await working.press("Control+End"); await working.pressSequentially(" later"); await click(page, "Finish save");
    await expect.poll(async () => (await snapshot(page)).pendingCommands).toBe(0); await ready(page); await exact(page, changed + " later");
    await working.press("Control+z"); await ready(page); await exact(page, changed); expect((await snapshot(page)).source.dirty).toBe(false);
    await query.focus(); await click(page, "Run captured inputs"); await expect.poll(async () => (await snapshot(page)).pendingRuns.length).toBe(1);
    expect((await snapshot(page)).pendingRuns[0]!.sourceId).toBe(planned.source.id);
    expect(await page.evaluate(() => window.hostFixture.runCapture(0)!.source.slice(0, 7))).toBe("dog dog"); await click(page, "Finish run");
    await page.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); }); await ready(page);
    await working.press("Control+f"); await expect(matchCase).not.toBeChecked(); await expect(wholeWord).toBeChecked(); await expect(status).toContainText("0 matches · ready");
    expect((await snapshot(page)).bindings.comparison!.baseline!.version).toBe(baseline); await exact(page, changed); await exact(page, original, true);
    await page.evaluate(() => window.hostFixture.dispose());
});
