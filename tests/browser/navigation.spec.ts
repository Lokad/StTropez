import { ready, expect, test } from "./fixtures.ts";
import type { Page } from "@playwright/test";
const snapshot = (page: Page) => page.evaluate(() => window.editingFixture.snapshot());

async function setup(page: Page, text: string, head = 0) {
    await page.evaluate(({ text, head }) => { window.editingFixture.setText(text); window.editingFixture.select("primary", { anchor: head, head }); window.editingFixture.focus("primary"); }, { text, head }); await ready(page);
}
test.beforeEach(async ({ page }) => {  await page.goto("/editing/"); await ready(page); });

test("occurrence shortcuts wrap, keep the current word primary and type over the visible matches", async ({ page }) => {
    const source = "cat scatter cat CAT cat";
    await setup(page, source, 13);
    const heads = () => page.evaluate(() => window.editingFixture.selectionSet().ranges.map(range => range.head));
    await page.keyboard.press("Control+d"); await page.keyboard.press("Control+d"); await page.keyboard.press("Control+d");
    expect(await heads()).toEqual([3, 15, 23]); expect((await snapshot(page)).primary.selection.head).toBe(3);
    await page.keyboard.type("X"); const row = page.locator("#primary .st-viewport-row").first();
    await expect(row).toHaveJSProperty("textContent", "X scatter X CAT X");
    await page.keyboard.press("Control+z");
    await page.evaluate(() => window.editingFixture.selections([{ anchor: 15, head: 12 }]));
    await page.keyboard.press("Control+Shift+l"); expect(await heads()).toEqual([0, 5, 12, 20]);
    expect((await snapshot(page)).primary.selection).toMatchObject({ anchor: 15, head: 12 });
    await page.keyboard.type("Y"); await expect(row).toHaveJSProperty("textContent", "Y sYter Y CAT Y");
    await setup(page, "name\n" + "other\n".repeat(10_000) + "name", 2);
    await page.keyboard.press("Control+Shift+l"); await page.keyboard.type("Z"); await ready(page);
    expect(await page.evaluate(() => { const f = window.editingFixture, length = f.snapshot().document!.length; return [f.range(0, 2), f.range(length - 2, length)]; })).toEqual(["Z\n", "\nZ"]);
});

test("occurrence shortcuts take a touching word and leave a caret between separators", async ({ page }) => {
    const row = page.locator("#primary .st-viewport-row").first();
    for (const shortcut of ["Control+d", "Control+Shift+l"]) {
        // A combining accent and a supplementary letter both belong to this word.
        const word = "cafe\u0301𐐀", text = word + ":  " + word;
        await setup(page, text, word.length); await page.keyboard.press(shortcut); await page.keyboard.type("X");
        await expect(row).toHaveJSProperty("textContent", shortcut === "Control+d" ? "X:  " + word : "X:  X");
        await setup(page, text, word.length + 1); await page.keyboard.press(shortcut); await page.keyboard.type("X");
        await expect(row).toHaveJSProperty("textContent", word + ":X  " + word);
    }
    await setup(page, "a: b:c", 1);
    await page.keyboard.press("Shift+ArrowRight"); await page.keyboard.press("Control+Shift+l"); await page.keyboard.type("!");
    await expect(row).toHaveJSProperty("textContent", "a! b!c");
});

test("adding carets carries the visual column across short lines and cursor undo restores the primary range", async ({ page }) => {
    await setup(page, "abcd\nx\nlast", 3);
    const heads = () => page.evaluate(() => window.editingFixture.selectionSet().ranges.map(range => range.head));
    await page.keyboard.press("Control+Alt+ArrowDown"); await ready(page); expect(await heads()).toEqual([3, 6]);
    await page.keyboard.press("Control+Alt+ArrowDown"); await ready(page); expect(await heads()).toEqual([3, 6, 10]);
    expect((await snapshot(page)).primary.selection.head).toBe(10);
    await page.keyboard.press("Control+u"); expect(await heads()).toEqual([3, 6]);
    expect((await snapshot(page)).primary.selection.head).toBe(6);
    await page.keyboard.type("A"); await page.keyboard.press("Control+u");
    expect(await heads()).toEqual([4, 8]);
    await expect(page.locator("#primary .st-viewport-row")).toHaveText(["abcAd", "xA", "last"]);
    await page.keyboard.press("Control+z"); await page.keyboard.press("Control+Alt+ArrowUp"); await ready(page);
    expect(await heads()).toContain(1);
});

test("copying a selection vertically retains both columns through a blank row and Undo restores every range", async ({ page }) => {
    for (const up of [false, true]) {
        const text = "abcdef\r\n\r\nABCDEF", start = up ? 10 : 0, anchor = up ? 1 : 4, head = up ? 4 : 1;
        await setup(page, text);
        await page.evaluate(({ anchor, head }) => window.editingFixture.selections([{ anchor, head }]), { anchor: start + anchor, head: start + head });
        const copy = up ? "Control+Alt+ArrowUp" : "Control+Alt+ArrowDown";
        await page.keyboard.press(copy); await ready(page); await page.keyboard.press(copy); await ready(page);
        const ranges = () => page.evaluate(() => window.editingFixture.selectionSet().ranges.map(({ anchor, head }) => [anchor, head]));
        const expected = [[anchor, head], [8, 8], [10 + anchor, 10 + head]];
        expect(await ranges()).toEqual(expected); expect((await snapshot(page)).primary.selection.head).toBe(up ? head : 10 + head);
        await page.keyboard.type("X");
        await expect(page.locator("#primary .st-viewport-row")).toHaveText(["aXef", "X", "AXEF"]);
        await page.keyboard.press("Control+z"); await ready(page); expect(await ranges()).toEqual(expected);
        expect(await page.evaluate(() => { const f = window.editingFixture; return f.range(0, f.snapshot().document!.length); })).toBe(text);
    }
});

test("line selection grows on repeat and scrolling leaves its text and keyboard focus in place", async ({ page }) => {
    const source = "one\r\ntwo\nthree\n" + "row\n".repeat(200);
    await setup(page, source, 2);
    await page.keyboard.press("Control+l"); await page.keyboard.press("Control+l");
    const before = await snapshot(page);
    expect(before.primary.selection).toMatchObject({ anchor: 0, head: 9 });
    const { lineHeight, height } = before.primary.viewport;
    for (const [key, distance] of [["Control+ArrowDown", lineHeight], ["Alt+PageDown", lineHeight + height],
        ["Control+ArrowUp", height], ["Alt+PageUp", 0]] as const) {
        await page.keyboard.press(key); await ready(page);
        const after = await snapshot(page);
        expect(Math.abs(after.primary.viewport.scrollTop - distance)).toBeLessThanOrEqual(1);
        expect(after.primary.selection).toEqual(before.primary.selection);
    }
    await expect(page.getByRole("textbox", { name: "Primary source", exact: true })).toBeFocused();
    await page.keyboard.type("X");
    await expect(page.locator("#primary .st-viewport-row").first()).toHaveJSProperty("textContent", "Xthree");
});

test("Backspace follows indentation stops, then typing paints at the resulting caret", async ({ page }) => {
    await setup(page, " \t      x  y", 8);
    await page.keyboard.press("Backspace"); await page.keyboard.press("Backspace"); await page.keyboard.type("A");
    await expect(page.locator("#primary .st-viewport-row").first()).toHaveJSProperty("textContent", " \tAx  y");
    await page.keyboard.press("Home"); await page.keyboard.press("Backspace");
    await expect(page.locator("#primary .st-viewport-row").first()).toHaveJSProperty("textContent", "Ax  y");
    await page.keyboard.press("End"); await page.keyboard.press("ArrowLeft"); await page.keyboard.press("Backspace");
    await expect(page.locator("#primary .st-viewport-row").first()).toHaveJSProperty("textContent", "Ax y");
    await setup(page, " ".repeat(100_000) + "end", 100_000);
    await page.keyboard.press("Backspace"); await page.keyboard.type("Y"); await ready(page);
    expect(await page.evaluate(() => window.editingFixture.range(99_996, 100_000))).toBe("Yend");
});

test("Home toggles between the first nonblank and the start of its own line", async ({ page }) => {
    await setup(page, "one\r\n\t  second\r\n   \r\n", 13);
    await page.keyboard.press("Shift+Home");
    expect((await snapshot(page)).primary.selection).toMatchObject({ anchor: 13, head: 8 });
    await page.keyboard.press("Shift+Home");
    expect((await snapshot(page)).primary.selection).toMatchObject({ anchor: 13, head: 5 });
    await page.keyboard.press("Home");
    expect((await snapshot(page)).primary.selection).toMatchObject({ anchor: 8, head: 8 });
    await page.keyboard.type("X");
    await expect(page.locator("#primary .st-viewport-row").nth(1)).toHaveJSProperty("textContent", "\t  Xsecond");
    await page.keyboard.press("Control+Home");
    expect((await snapshot(page)).primary.selection.head).toBe(0);
    const boundary = await page.evaluate(() => {
        const f = window.editingFixture;
        f.keymap.unbind("Shift+Home"); f.keymap.bind("F8", "select-to-line-start");
        f.commands.run("move-to-document-end");
        const end = f.selectionSet().ranges[0]!.head;
        f.select("primary", { anchor: 13, head: 13 });
        const input = document.querySelector<HTMLTextAreaElement>("#primary textarea")!;
        const unbound = input.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", shiftKey: true, bubbles: true, cancelable: true }));
        return { end, length: f.snapshot().document!.length, unbound };
    });
    expect(boundary.end).toBe(boundary.length); expect(boundary.unbound).toBe(true);
    await page.keyboard.press("F8");
    expect((await snapshot(page)).primary.selection).toMatchObject({ anchor: 13, head: 8 });
    const hostField = await page.evaluate(() => {
        const field = document.createElement("input"); field.value = "host"; document.body.append(field);
        field.addEventListener("keydown", window.editingFixture.keymap.handle); field.focus(); field.setSelectionRange(4, 4);
        const handled = !field.dispatchEvent(new KeyboardEvent("keydown", { key: "F8", bubbles: true, cancelable: true }));
        const result = { handled, caret: field.selectionStart }; field.remove(); return result;
    });
    expect(hostField).toEqual({ handled: false, caret: 4 });
    await setup(page, " ".repeat(100_000) + "last", 100_004);
    await page.keyboard.press("Home");
    await page.keyboard.type("Y");
    await ready(page);
    expect(await page.evaluate(() => window.editingFixture.range(100_000, 100_005))).toBe("Ylast");
});

test("word keys navigate full model ranges, extend selections and delete one undoable code word", async ({ page }) => {
    const text = "alpha_beta  gamma.delta 😀 café"; await setup(page, text);
    for (const head of [10, 17, 23, 26, 31]) { await page.keyboard.press("Control+ArrowRight"); await ready(page); expect((await snapshot(page)).primary.selection.head).toBe(head); }
    await page.keyboard.press("Control+Shift+ArrowLeft"); await ready(page); expect((await snapshot(page)).primary.selection).toMatchObject({ anchor: 31, head: 27 });
    await page.evaluate(() => {
        const keys = window.editingFixture.keymap;
        keys.unbind("Ctrl+Backspace"); keys.bind("F8", "delete-word-backward");
    });
    const before = (await snapshot(page)).history!.undoDepth;
    await page.keyboard.press("Control+Backspace"); await ready(page);
    expect((await snapshot(page)).history!.undoDepth).toBe(before);
    await page.keyboard.press("F8"); await ready(page);
    expect(await page.evaluate(() => window.editingFixture.range(0, 27))).toBe(text.slice(0, 27));
    expect((await snapshot(page)).history!.undoDepth).toBe(before + 1);
    await page.keyboard.press("Control+z"); await ready(page); expect(await page.evaluate(() => window.editingFixture.range(0, 31))).toBe(text);
    expect((await snapshot(page)).primary.selection).toMatchObject({ anchor: 31, head: 27 });
    await setup(page, "👩‍💻  αβ"); await page.keyboard.press("Control+Delete"); await ready(page);
    expect(await page.evaluate(() => window.editingFixture.range(0, 4))).toBe("  αβ");
});

test("a long word yields, deletes beyond native context and restores through shared history", async ({ page }) => {
    await setup(page, "x".repeat(200_000) + "  tail"); const before = await snapshot(page);
    await page.keyboard.press("Control+Delete"); await ready(page); const after = await snapshot(page);
    expect(after.document).toMatchObject({ length: 6, revision: before.document!.revision + 1 });
    expect(await page.evaluate(() => window.editingFixture.range(0, 6))).toBe("  tail"); expect(after.history!.undoDepth).toBe(before.history!.undoDepth + 1);
    await page.keyboard.press("Control+z"); await ready(page); expect((await snapshot(page)).document!.length).toBe(200_006);
    await page.keyboard.press("Control+ArrowRight"); await ready(page); expect((await snapshot(page)).primary.selection.head).toBe(200_000);
});

test("word movement stops at line boundaries and word deletion treats indentation separately", async ({ page }) => {
    const text = "a.b   \r\n    next word";
    await setup(page, text, 1);
    for (const head of [3, 6, 16]) {
        await page.keyboard.press("Control+ArrowRight"); await ready(page);
        expect((await snapshot(page)).primary.selection.head).toBe(head);
    }
    for (const head of [12, 8, 2]) {
        await page.keyboard.press("Control+ArrowLeft"); await ready(page);
        expect((await snapshot(page)).primary.selection.head).toBe(head);
    }
    await setup(page, text, 12);
    await page.keyboard.press("Control+Backspace"); await ready(page);
    expect(await page.evaluate(() => window.editingFixture.range(0, 12))).toBe("a.b   \r\nnext");
    await page.keyboard.press("Control+Backspace"); await ready(page);
    expect(await page.evaluate(() => window.editingFixture.range(0, 10))).toBe("a.b   next");
    await page.keyboard.press("Control+z"); await page.keyboard.press("Control+z"); await ready(page);
    await page.evaluate(() => window.editingFixture.select("primary", { anchor: 6, head: 6 }));
    await page.keyboard.press("Control+Delete"); await ready(page);
    const input = page.getByRole("textbox", { name: "Primary source", exact: true });
    await expect(input).toBeFocused();
    await expect(page.locator("#primary .st-viewport-row").first()).toHaveJSProperty("textContent", "a.b   next word");
});

test("pending word deletion expires after revision, selection or tab-generation changes", async ({ page }) => {
    for (const changed of ["revision", "selection", "generation"] as const) {
        await page.goto("/editing/"); await ready(page); await setup(page, "x".repeat(200_000));
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
        const after = await snapshot(page); expect(after.document!.length).toBe(200_000 + (changed === "revision" ? 1 : 0));
        expect(after.primary.commits).toBe(before.primary.commits);
    }
});

test("page and line movement retain a measured column across short lines and extend backward selections", async ({ page }) => {
    const lines = Array.from({ length: 60 }, () => "0123456789abcdef"); lines[7] = "xy";
    const starts = lines.map((_, index) => lines.slice(0, index).reduce((n, value) => n + value.length + 1, 0));
    await setup(page, lines.join("\n"), starts[6]! + 8);
    await page.keyboard.press("ArrowDown"); await ready(page); expect((await snapshot(page)).primary.selection.head).toBe(starts[7]! + 2);
    await page.keyboard.press("ArrowDown"); await ready(page); expect((await snapshot(page)).primary.selection.head).toBe(starts[8]! + 8);
    const s = await snapshot(page), pageLines = Math.max(1, Math.floor(s.primary.viewport.height / s.primary.viewport.lineHeight) - 1);
    await page.evaluate(() => {
        const keys = window.editingFixture.keymap;
        keys.unbind("PageDown"); keys.bind("F8", "move-page-down");
    });
    await page.keyboard.press("PageDown"); await ready(page);
    expect((await snapshot(page)).primary.selection.head).toBe(starts[8]! + 8);
    await page.keyboard.press("F8"); await ready(page);
    expect((await snapshot(page)).primary.selection.head).toBe(starts[8 + pageLines]! + 8);
    await page.keyboard.press("Shift+PageUp"); await ready(page);
    expect((await snapshot(page)).primary.selection).toMatchObject({ anchor: starts[8 + pageLines]! + 8, head: starts[8]! + 8 });
});

test("non-cancellable word input uses its captured revision and preserves rejected native attempts", async ({ page }) => {
    await setup(page, "alpha beta", 10);
    await page.getByRole("textbox", { name: "Primary source", exact: true }).evaluate(node => {
        const input = node as HTMLTextAreaElement;
        input.dispatchEvent(new InputEvent("beforeinput", { inputType: "deleteWordBackward", bubbles: true, cancelable: false }));
        input.value = "alpha "; input.dispatchEvent(new InputEvent("input", { inputType: "deleteWordBackward", bubbles: true }));
    }); await ready(page); expect(await page.evaluate(() => window.editingFixture.range(0, 6))).toBe("alpha ");
    await setup(page, "alpha beta", 10);
    const beforeMismatch = await snapshot(page);
    await page.getByRole("textbox", { name: "Primary source", exact: true }).evaluate(node => {
        const input = node as HTMLTextAreaElement;
        input.dispatchEvent(new InputEvent("beforeinput", { inputType: "deleteWordBackward", bubbles: true, cancelable: false }));
        input.value = "alpha bet"; input.dispatchEvent(new InputEvent("input", { inputType: "deleteContentBackward", bubbles: true }));
    });
    await ready(page);
    expect(await page.evaluate(() => { const f = window.editingFixture; return f.range(0, f.snapshot().document!.length); })).toBe("alpha beta");
    expect((await snapshot(page)).history).toEqual(beforeMismatch.history);
    expect((await snapshot(page)).conflicts.at(-1)).toMatchObject({ reason: "stale-delete-input", attemptedUnits: 9 });
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
    await expect.poll(() => page.evaluate(() => {
        const { width, gutterWidth } = window.editingFixture.snapshot().primary.viewport;
        return width + gutterWidth;
    })).toBe(240); await ready(page);
    const before = await snapshot(page), count = Math.max(1, Math.floor(before.primary.viewport.height / before.primary.viewport.lineHeight) - 1);
    expect(before.primary.viewport.scrollLeft).toBeGreaterThan(0);
    await page.keyboard.press("PageDown"); await ready(page); expect((await snapshot(page)).primary.selection.head).toBe((line.length + 2) * (10 + count) + column);
    await page.keyboard.press("PageUp"); await ready(page); expect((await snapshot(page)).primary.selection.head).toBe((line.length + 2) * 10 + column);
    await page.keyboard.press("Control+Home"); await ready(page); await page.keyboard.press("Shift+PageUp"); await ready(page);
    expect((await snapshot(page)).primary.selection).toMatchObject({ anchor: 0, head: 0 });
    await page.keyboard.press("Control+End"); await ready(page); await page.keyboard.press("Shift+PageDown"); await ready(page);
    expect((await snapshot(page)).primary.selection).toMatchObject({ anchor: text.length, head: text.length });
    expect((await snapshot(page)).document).toMatchObject({ revision: before.document!.revision });
});

test("pending word deletion orders native deletion and typing and respects permission changes", async ({ page }) => {
    const text = "x".repeat(200_000) + " tail";
    await setup(page, text); const before = (await snapshot(page)).primary.commits;
    await page.getByRole("textbox", { name: "Primary source", exact: true }).evaluate(node => {
        const input = node as HTMLTextAreaElement;
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", ctrlKey: true, bubbles: true, cancelable: true }));
        if (!window.editingFixture.snapshot().primary.pendingWord) throw new Error("Word command did not yield.");
        window.editingFixture.keymap.unbind("Ctrl+Delete");
        window.editingFixture.keymap.unbind("Enter");
        const unbound = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
        input.dispatchEvent(unbound);
        if (!unbound.defaultPrevented) throw new Error("Unbound Enter reached the native input during deletion.");
        input.dispatchEvent(new InputEvent("beforeinput", { inputType: "deleteWordForward", bubbles: true, cancelable: true }));
        input.setRangeText("!", input.selectionStart, input.selectionEnd, "end"); input.dispatchEvent(new InputEvent("input", { inputType: "insertText", bubbles: true }));
    }); await ready(page);
    expect((await snapshot(page)).document).toMatchObject({ length: 1 }); expect((await snapshot(page)).primary.commits).toBe(before + 3);
    expect(await page.evaluate(() => window.editingFixture.range(0, 1))).toBe("!");
    await page.keyboard.press("Control+z"); await ready(page); expect((await snapshot(page)).document!.length).toBe(0);
    await page.keyboard.press("Control+z"); await ready(page); expect(await page.evaluate(() => window.editingFixture.range(0, 5))).toBe(" tail");
    await page.keyboard.press("Control+z"); await ready(page); expect((await snapshot(page)).document).toMatchObject({ length: text.length });
    expect((await snapshot(page)).primary.selection).toMatchObject({ anchor: 0, head: 0 });
    await setup(page, "x".repeat(200_000)); const revision = (await snapshot(page)).document!.revision;
    await page.getByRole("textbox", { name: "Primary source", exact: true }).evaluate(node => {
        window.editingFixture.keymap.bind("Ctrl+Delete", "delete-word-forward");
        node.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", ctrlKey: true, bubbles: true, cancelable: true })); window.editingFixture.readOnly(true);
    }); await ready(page); expect((await snapshot(page)).document).toMatchObject({ length: 200_000, revision });
    await page.keyboard.press("Control+Delete"); await ready(page); expect((await snapshot(page)).document!.revision).toBe(revision);
    await page.keyboard.press("Control+ArrowRight"); await ready(page); expect((await snapshot(page)).primary.selection.head).toBe(200_000);
    const readOnly = await page.evaluate(() => {
        const f = window.editingFixture;
        return [f.command("delete-backward"), f.command("delete-word-backward"), f.command("select-word-backward")];
    });
    expect(readOnly).toEqual([false, false, true]); await ready(page);
    expect((await snapshot(page)).primary.selection).toMatchObject({ anchor: 200_000, head: 0 });
});

test("horizontal arrows move offscreen carets by grapheme without measuring their rows", async ({ page }) => {
    const lines = Array.from({ length: 2000 }, (_, i) => (i % 2 ? "abe\u0301" : "abcd") + i);
    await setup(page, lines.join("\n"));
    let start = 0;
    const carets = lines.map(line => {
        const head = start + 2;
        start += line.length + 1;
        return { anchor: head, head };
    });
    const primary = 999;
    await page.evaluate(({ carets, primary }) => window.editingFixture.selections(carets, primary), { carets, primary });
    await ready(page);
    const measurement = await page.locator("#primary .st-viewport").evaluateHandle(root => {
        let measured = false;
        const observer = new MutationObserver(records => {
            measured ||= records.some(record => Array.from(record.addedNodes).some(node =>
                node instanceof Element && node.classList.contains("st-viewport-command-measure")));
        });
        observer.observe(root, { childList: true });
        return () => { observer.disconnect(); return measured; };
    });
    await page.keyboard.press("ArrowRight");
    await ready(page);
    const selection = await page.evaluate(() => window.editingFixture.selectionSet());
    expect(selection.primary).toBe(primary);
    expect(selection.ranges).toEqual(carets.map(({ head }, i) => {
        const offset = head + (i % 2 ? 2 : 1);
        return { anchor: offset, head: offset, anchorAffinity: "before", headAffinity: "before" };
    }));
    expect(await measurement.evaluate(stop => stop())).toBe(false);
    await measurement.dispose();
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

test("navigation reuses immediate style captures and rejects synchronous layout changes", async ({ page }, testInfo) => {
    const text = Array.from({ length: 60 }, () => "0123456789abcdef").join("\n"), head = 17 * 20 + 4;
    const counts = [], changes = [];
    for (const key of ["ArrowRight", "ArrowDown"]) {
        await setup(page, text, head);
        counts.push(await page.getByRole("textbox", { name: "Primary source", exact: true }).evaluate((input, key) => {
            const root = input.parentElement!, getStyle = window.getComputedStyle; let reads = 0;
            window.getComputedStyle = (element, pseudo) => {
                const style = getStyle.call(window, element, pseudo);
                if (element !== root) return style;
                return new Proxy(style, { get(target, name) {
                    if (name === "fontVariantLigatures") reads++;
                    const value: unknown = Reflect.get(target, name, target);
                    return typeof value === "function" ? value.bind(target) : value;
                } });
            };
            try {
                input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
                const state = window.editingFixture.snapshot();
                return { key, reads, head: state.primary.selection.head, pending: state.primary.pendingCommand };
            } finally { window.getComputedStyle = getStyle; }
        }, key));
        await ready(page);
    }
    for (const phase of ["render", "geometry"] as const) {
        // Give the vertical destination fresh glyphs so it has no cached geometry.
        await setup(page, phase === "geometry" ? text.replaceAll("0123456789abcdef", "ghijklmnopqrstuv") : text, head);
        changes.push(await page.getByRole("textbox", { name: "Primary source", exact: true }).evaluate((input, phase) => {
            const root = input.parentElement!, nativeRects = Range.prototype.getClientRects; let changed = 0;
            const alter = () => { if (!changed) { changed++; root.style.letterSpacing = "1px"; } };
            let stop = () => {};
            if (phase === "render") { stop = window.editingFixture.onRender("primary", () => { stop(); alter(); }); root.scrollTop += 2; root.dispatchEvent(new Event("scroll")); }
            else Range.prototype.getClientRects = function () {
                if (this.startContainer.parentElement?.closest('.st-viewport-row[data-line="21"]')) alter();
                return nativeRects.call(this);
            };
            try {
                const key = phase === "geometry" ? "ArrowDown" : "ArrowRight";
                input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
                const state = window.editingFixture.snapshot();
                return { phase, changed, head: state.primary.selection.head, pending: state.primary.pendingCommand, conflicts: state.conflicts.length };
            } finally { Range.prototype.getClientRects = nativeRects; stop(); }
        }, phase));
        await testInfo.attach(`navigation-${phase}`, { body: JSON.stringify(changes.at(-1)), contentType: "application/json" });
        await ready(page); await page.keyboard.press("ArrowRight"); await ready(page);
        expect((await snapshot(page)).primary.selection.head).toBe(head + 1);
        await page.locator("#primary .st-viewport").evaluate(root => (root as HTMLElement).style.letterSpacing = "");
    }
    await testInfo.attach("navigation-style", { body: JSON.stringify({ counts, changes }), contentType: "application/json" });
    for (const result of counts) {
        expect(result.head).toBe(head + (result.key === "ArrowRight" ? 1 : 17));
        expect(result.pending).toBe(false);
        // Includes the viewport's metric reads; vertical preflight adds one flush.
        expect(result.reads).toBeGreaterThan(0); expect(result.reads).toBeLessThanOrEqual(result.key === "ArrowRight" ? 5 : 6);
    }
    for (const result of changes) expect(result).toMatchObject({ changed: 1, head, pending: false, conflicts: 0 });
});
