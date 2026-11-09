import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
const snapshot = (page: Page) => page.evaluate(() => window.editingFixture.snapshot());
async function ready(page: Page) {
    await expect.poll(() => page.evaluate(() => { const s = window.editingFixture?.snapshot(); return s && !s.primary.pendingWord && !s.primary.viewport.pending && s.primary.viewport.revision === s.document?.revision; }), { timeout: 15000 }).toBe(true);
}
async function setup(page: Page, text: string, head = 0) {
    await page.evaluate(({ text, head }) => { window.editingFixture.setText(text); window.editingFixture.select("primary", { anchor: head, head }); window.editingFixture.focus("primary"); }, { text, head }); await ready(page);
}
test.beforeEach(async ({ page }) => { page.on("pageerror", error => { throw error; }); await page.goto("/editing/"); await ready(page); });

test("word keys navigate full model ranges, extend selections and delete one undoable code word", async ({ page }) => {
    const text = "alpha_beta  gamma.delta 😀 café"; await setup(page, text);
    for (const head of [12, 17, 18, 24, 27, 31]) { await page.keyboard.press("Control+ArrowRight"); await ready(page); expect((await snapshot(page)).primary.selection.head).toBe(head); }
    await page.keyboard.press("Control+Shift+ArrowLeft"); await ready(page); expect((await snapshot(page)).primary.selection).toMatchObject({ anchor: 31, head: 27 });
    const before = (await snapshot(page)).history!.undoDepth;
    await page.keyboard.press("Control+Backspace"); await ready(page);
    expect(await page.evaluate(() => window.editingFixture.range(0, 27))).toBe(text.slice(0, 27));
    expect((await snapshot(page)).history!.undoDepth).toBe(before + 1);
    await page.keyboard.press("Control+z"); await ready(page); expect(await page.evaluate(() => window.editingFixture.range(0, 31))).toBe(text);
    expect((await snapshot(page)).primary.selection).toMatchObject({ anchor: 31, head: 27 });
    await setup(page, "👩‍💻  αβ"); await page.keyboard.press("Control+Delete"); await ready(page);
    expect(await page.evaluate(() => window.editingFixture.range(0, 2))).toBe("αβ"); expect((await snapshot(page)).document!.exports).toBe(0);
});

test("a million-unit word yields, deletes beyond native context and restores through shared history", async ({ page }) => {
    await setup(page, "x".repeat(1_000_000) + "  tail"); const before = await snapshot(page);
    await page.keyboard.press("Control+Delete"); await ready(page); const after = await snapshot(page);
    expect(after.document).toMatchObject({ length: 4, revision: before.document!.revision + 1, exports: 0 });
    expect(await page.evaluate(() => window.editingFixture.range(0, 4))).toBe("tail"); expect(after.history!.undoDepth).toBe(before.history!.undoDepth + 1);
    await page.keyboard.press("Control+z"); await ready(page); expect((await snapshot(page)).document!.length).toBe(1_000_006);
    await page.keyboard.press("Control+ArrowRight"); await ready(page); expect((await snapshot(page)).primary.selection.head).toBe(1_000_002);
    expect((await snapshot(page)).primary.inputUnits).toBeLessThan(2600);
});

test("pending word deletion expires after revision, selection or tab-generation changes", async ({ page }) => {
    for (const changed of ["revision", "selection", "generation"] as const) {
        await page.goto("/editing/"); await ready(page); await setup(page, "x".repeat(1_000_000));
        const before = await snapshot(page);
        const pending = await page.getByRole("textbox", { name: "Primary source", exact: true }).evaluate((input, changed) => {
            input.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", ctrlKey: true, bubbles: true, cancelable: true }));
            const pending = window.editingFixture.snapshot().primary.pendingWord;
            if (changed === "revision") window.editingFixture.edit([{ from: 0, to: 0, insert: "!" }]);
            if (changed === "selection") window.editingFixture.select("primary", { anchor: 2, head: 2 });
            if (changed === "generation") window.editingFixture.replacePrimary();
            return pending;
        }, changed);
        expect(pending).toBe(true);
        await expect.poll(() => page.evaluate(() => window.editingFixture.snapshot().primary.pendingWord)).toBe(false);
        const after = await snapshot(page); expect(after.document!.length).toBe(1_000_000 + (changed === "revision" ? 1 : 0));
        expect(after.primary.commits).toBe(before.primary.commits); expect(after.document!.exports).toBe(0);
    }
});

test("page and line movement retain a measured column across short lines and extend backward selections", async ({ page }) => {
    const lines = Array.from({ length: 60 }, () => "0123456789abcdef"); lines[7] = "xy";
    const starts = lines.map((_, index) => lines.slice(0, index).reduce((n, value) => n + value.length + 1, 0));
    await setup(page, lines.join("\n"), starts[6]! + 8);
    await page.keyboard.press("ArrowDown"); await ready(page); expect((await snapshot(page)).primary.selection.head).toBe(starts[7]! + 2);
    await page.keyboard.press("ArrowDown"); await ready(page); expect((await snapshot(page)).primary.selection.head).toBe(starts[8]! + 8);
    const s = await snapshot(page), pageLines = Math.max(1, Math.floor(s.primary.viewport.height / s.primary.viewport.lineHeight) - 1);
    await page.keyboard.press("PageDown"); await ready(page);
    expect((await snapshot(page)).primary.selection.head).toBe(starts[8 + pageLines]! + 8);
    await page.keyboard.press("Shift+PageUp"); await ready(page);
    expect((await snapshot(page)).primary.selection).toMatchObject({ anchor: starts[8 + pageLines]! + 8, head: starts[8]! + 8 });
    expect((await snapshot(page)).document!.exports).toBe(0);
});

test("non-cancellable word input uses its captured revision and preserves rejected native attempts", async ({ page }) => {
    await setup(page, "alpha beta", 10);
    await page.getByRole("textbox", { name: "Primary source", exact: true }).evaluate(node => {
        const input = node as HTMLTextAreaElement;
        input.dispatchEvent(new InputEvent("beforeinput", { inputType: "deleteWordBackward", bubbles: true, cancelable: false }));
        input.value = "alpha "; input.dispatchEvent(new InputEvent("input", { inputType: "deleteWordBackward", bubbles: true }));
    }); await ready(page); expect(await page.evaluate(() => window.editingFixture.range(0, 6))).toBe("alpha ");
    await setup(page, "alpha beta", 10); const before = (await snapshot(page)).primary.commits;
    await page.getByRole("textbox", { name: "Primary source", exact: true }).evaluate(node => {
        const input = node as HTMLTextAreaElement;
        input.dispatchEvent(new InputEvent("beforeinput", { inputType: "deleteWordBackward", bubbles: true, cancelable: false }));
        window.editingFixture.edit([{ from: 0, to: 0, insert: "!" }]);
        input.value = "alpha "; input.dispatchEvent(new InputEvent("input", { inputType: "deleteWordBackward", bubbles: true }));
    }); await ready(page);
    expect((await snapshot(page)).primary.commits).toBe(before); expect((await snapshot(page)).conflicts.at(-1)!.reason).toBe("stale-word-input");
    expect(await page.evaluate(() => window.editingFixture.range(0, 11))).toBe("!alpha beta");
    await setup(page, "alpha beta", 10); const conflictCount = (await snapshot(page)).conflicts.length;
    await page.getByRole("textbox", { name: "Primary source", exact: true }).evaluate(node => {
        const input = node as HTMLTextAreaElement;
        input.dispatchEvent(new InputEvent("beforeinput", { inputType: "deleteWordBackward", bubbles: true, cancelable: false }));
        window.editingFixture.readOnly(true);
        input.value = "alpha "; input.dispatchEvent(new InputEvent("input", { inputType: "deleteWordBackward", bubbles: true }));
    }); await ready(page);
    expect((await snapshot(page)).conflicts).toHaveLength(conflictCount + 1);
    expect((await snapshot(page)).conflicts.at(-1)).toMatchObject({ reason: "stale-word-input", attemptedUnits: 6 });
    expect(await page.evaluate(() => window.editingFixture.range(0, 10))).toBe("alpha beta");
});

test("page movement preserves raw CRLF offsets and measured columns in horizontally scrolled Unicode rows", async ({ page }) => {
    const line = "prefix\t東京 é 👩‍💻 0123456789 ".repeat(4), text = Array.from({ length: 55 }, () => line).join("\r\n"), column = line.indexOf("0123456789", 30) + 5;
    await setup(page, text, (line.length + 2) * 10 + column);
    await page.locator("#primary .st-viewport").evaluate(element => { (element as HTMLElement).style.width = "240px"; });
    await expect.poll(() => page.evaluate(() => window.editingFixture.snapshot().primary.viewport.width)).toBe(240); await ready(page);
    const before = await snapshot(page), count = Math.max(1, Math.floor(before.primary.viewport.height / before.primary.viewport.lineHeight) - 1);
    expect(before.primary.viewport.scrollLeft).toBeGreaterThan(0);
    await page.keyboard.press("PageDown"); await ready(page); expect((await snapshot(page)).primary.selection.head).toBe((line.length + 2) * (10 + count) + column);
    await page.keyboard.press("PageUp"); await ready(page); expect((await snapshot(page)).primary.selection.head).toBe((line.length + 2) * 10 + column);
    await page.keyboard.press("Control+Home"); await ready(page); await page.keyboard.press("Shift+PageUp"); await ready(page);
    expect((await snapshot(page)).primary.selection).toMatchObject({ anchor: 0, head: 0 });
    await page.keyboard.press("Control+End"); await ready(page); await page.keyboard.press("Shift+PageDown"); await ready(page);
    expect((await snapshot(page)).primary.selection).toMatchObject({ anchor: text.length, head: text.length });
    expect((await snapshot(page)).document).toMatchObject({ exports: 0, revision: before.document!.revision });
});

test("pending word deletion orders typing and read-only transitions reject its final transaction", async ({ page }) => {
    await setup(page, "x".repeat(1_000_000)); const before = (await snapshot(page)).primary.commits;
    await page.getByRole("textbox", { name: "Primary source", exact: true }).evaluate(node => {
        const input = node as HTMLTextAreaElement;
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", ctrlKey: true, bubbles: true, cancelable: true }));
        if (!window.editingFixture.snapshot().primary.pendingWord) throw new Error("Word command did not yield.");
        input.setRangeText("!", input.selectionStart, input.selectionEnd, "end"); input.dispatchEvent(new InputEvent("input", { inputType: "insertText", bubbles: true }));
    }); await ready(page);
    expect((await snapshot(page)).document).toMatchObject({ length: 1, exports: 0 }); expect((await snapshot(page)).primary.commits).toBe(before + 2);
    expect(await page.evaluate(() => window.editingFixture.range(0, 1))).toBe("!");
    await page.keyboard.press("Control+z"); await ready(page); expect((await snapshot(page)).document!.length).toBe(0);
    await page.keyboard.press("Control+z"); await ready(page); expect((await snapshot(page)).document).toMatchObject({ length: 1_000_000, exports: 0 });
    expect((await snapshot(page)).primary.selection).toMatchObject({ anchor: 0, head: 0 });
    await setup(page, "x".repeat(1_000_000)); const revision = (await snapshot(page)).document!.revision;
    await page.getByRole("textbox", { name: "Primary source", exact: true }).evaluate(node => {
        node.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", ctrlKey: true, bubbles: true, cancelable: true })); window.editingFixture.readOnly(true);
    }); await ready(page); expect((await snapshot(page)).document).toMatchObject({ length: 1_000_000, revision });
    await page.keyboard.press("Control+Delete"); await ready(page); expect((await snapshot(page)).document!.revision).toBe(revision);
    await page.keyboard.press("Control+ArrowRight"); await ready(page); expect((await snapshot(page)).primary.selection.head).toBe(1_000_000);
});

test("nearest caret reveal leaves an already visible row and horizontal position stable", async ({ page }) => {
    await setup(page, Array.from({ length: 60 }, () => "0123456789abcdef").join("\n"), 17 * 20 + 4);
    const before = (await snapshot(page)).primary.viewport;
    for (let index = 0; index < 4; index++) { await page.keyboard.press("ArrowRight"); await ready(page); }
    const after = (await snapshot(page)).primary.viewport;
    expect(after.scrollTop).toBe(before.scrollTop); expect(after.scrollLeft).toBe(before.scrollLeft);
    expect((await snapshot(page)).primary.selection.head).toBe(17 * 20 + 8);
    await setup(page, "\n0123456789abcdef", 9);
    await page.keyboard.press("ArrowUp"); await ready(page); expect((await snapshot(page)).primary.selection.head).toBe(0);
    await page.getByRole("textbox", { name: "Primary source", exact: true }).evaluate(input => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", ctrlKey: true, bubbles: true, cancelable: true })));
    await page.keyboard.press("ArrowDown"); await ready(page);
    expect((await snapshot(page)).primary.selection.head).toBe(1);
});
