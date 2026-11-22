import { ready, test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
import type { Locator } from "@playwright/test";

const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const source = (page: Page) => page.evaluate(() => window.hostFixture.range(0, window.hostFixture.snapshot().source.length));
const primary = (page: Page) => page.getByRole("textbox", { name: "Primary source", exact: true });

async function setSource(page: Page, text: string): Promise<void> {
    await page.evaluate(text => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]); }, text); await ready(page);
}
async function clipboard(input: Locator, type: "copy" | "cut" | "paste", text = ""): Promise<string> {
    return input.evaluate((node, { type, text }) => {
        const event = new ClipboardEvent(type, { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
        if (!event.clipboardData) throw new Error("Synthetic clipboard fixture requires an event data store.");
        if (type === "paste") event.clipboardData.setData("text/plain", text);
        node.dispatchEvent(event);
        return event.clipboardData.getData("text/plain");
    }, { type, text });
}

for (const mode of ["plain", "react"] as const) test.describe(`${mode} integrated pilot commands`, () => {
    test.beforeEach(async ({ page }) => {

        await page.goto(`/hosts/${mode}/?editor=candidate`); await expect(primary(page)).toBeVisible(); await ready(page);
    });
    test("the command palette filters the originating pane's commands and retires on remount", async ({ page }) => {
        const original = "one\ntwo\nthree";
        await setSource(page, original);
        const secondary = page.getByRole("textbox", { name: "Secondary source", exact: true });
        await secondary.focus();
        await page.evaluate(() => {
            const f = window.hostFixture;
            f.selectSourceSet("secondary", f.snapshot().source.revision, [{ anchor: 5, head: 5 }]);
        });
        const caret = async () => (await snapshot(page)).bindings.views.find(view => view.id === "secondary")!.selection.head;
        expect(await caret()).toBe(5);
        await secondary.press("Control+k"); await secondary.press("Control+p");
        const dialog = page.getByRole("dialog", { name: "Editor commands" });
        const filter = dialog.getByRole("searchbox", { name: "Filter commands" });
        const run = dialog.getByRole("button", { name: "Run command" });
        await expect(filter).toBeFocused(); await filter.fill("qqqq");
        await expect(dialog.getByRole("option", { name: "No matching commands" })).toBeDisabled();
        await expect(run).toBeDisabled(); await filter.fill("insert line below");
        await expect(dialog.getByRole("option")).toHaveCount(1);
        await expect(dialog.getByRole("option")).toContainText("Ctrl+Enter");
        expect(await caret()).toBe(5);
        await filter.press("ArrowDown");
        const matches = dialog.getByRole("listbox"); await expect(matches).toBeFocused();
        await matches.press("Enter"); await expect(dialog).toHaveCount(0); await expect(secondary).toBeFocused();
        await expect.poll(() => source(page)).toBe("one\ntwo\n\nthree");
        await primary(page).press("Control+k"); await primary(page).press("Control+p");
        await filter.fill("undo"); await dialog.getByRole("listbox").selectOption("undo");
        await run.click(); await expect(primary(page)).toBeFocused(); await expect.poll(() => source(page)).toBe(original);
        await secondary.press("Control+y"); await expect.poll(() => source(page)).toBe("one\ntwo\n\nthree");
        await secondary.press("Control+z");

        await page.getByRole("button", { name: "Open source review", exact: true }).click();
        const reference = page.getByRole("textbox", { name: "Comparison baseline source", exact: true });
        await reference.focus();
        await page.getByRole("button", { name: "Editor commands", exact: true }).click();
        await filter.fill("insert line below"); await expect(run).toBeDisabled();
        await expect(dialog.getByRole("option")).toBeDisabled();
        await filter.fill("undo"); await expect(dialog.locator('option[value="undo"]')).toBeDisabled();
        await filter.fill("select all"); await expect(dialog.locator('option[value="select-all"]')).toBeEnabled();
        await filter.fill("select to end of document"); await expect(dialog.locator('option[value="select-to-document-end"]')).toBeEnabled();
        await filter.fill("delete previous word"); await expect(run).toBeDisabled();
        await filter.fill("select to next word"); await expect(dialog.locator('option[value="select-word-forward"]')).toBeEnabled();
        await filter.press("Escape");
        await expect(dialog).toHaveCount(0); await expect(reference).toBeFocused();

        const field = page.getByRole("textbox", { name: "Configuration path", exact: true });
        await field.focus();
        const unhandled = await field.evaluate(node => ["k", "p"].map(key =>
            node.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true }))));
        expect(unhandled).toEqual([true, true]); await expect(dialog).toHaveCount(0);

        await secondary.press("Control+k"); await secondary.press("Control+p"); await filter.fill("delete lines");
        await expect(run).toBeEnabled();
        const retired = await run.elementHandle(); expect(retired).not.toBeNull();
        await page.evaluate(() => { window.hostFixture.unmount(); window.hostFixture.mount(); });
        await expect(dialog).toHaveCount(0);
        await retired!.evaluate(node => (node as HTMLButtonElement).click()); await retired!.dispose();
        expect(await source(page)).toBe(original);
    });
    for (const key of ["Tab", "Shift+Tab"]) test(`read-only ${key} cannot become a deferred edit after the host restores permission`, async ({ page }) => {
        const original = "    const sample = 1;\r\n".repeat(1024); await setSource(page, original);
        await page.getByRole("button", { name: "Open source review", exact: true }).click(); await ready(page);
        await page.evaluate(() => window.hostFixture.setSourceReadOnly(true));
        await expect(primary(page)).toHaveAttribute("readonly", ""); await primary(page).press("Control+a");
        const before = await snapshot(page);
        await primary(page).evaluate(node => {
            const capture = (event: Event) => {
                if ((event as KeyboardEvent).key !== "Tab") return; node.removeEventListener("keydown", capture, true);
                if (!(node as HTMLTextAreaElement).readOnly) throw new Error("Fixture requires a read-only Tab keypress.");
                node.setAttribute("data-locked-command", "captured");
            };
            node.addEventListener("keydown", capture, { capture: true });
            const restore = (event: Event) => {
                if ((event as KeyboardEvent).key !== "Tab") return; node.removeEventListener("keydown", restore);
                if (!(node as HTMLTextAreaElement).readOnly) throw new Error("Permission must remain locked through the editor's handler.");
                queueMicrotask(() => window.hostFixture.setSourceReadOnly(false));
            };
            node.addEventListener("keydown", restore);
        });
        await primary(page).press(key); await expect(primary(page)).toHaveAttribute("data-locked-command", "captured");
        await expect(primary(page)).not.toHaveAttribute("readonly", "");
        // Drive independent browser task turns after the permission change, so a queued edit cannot hide behind an immediate assertion.
        await page.evaluate(() => new Promise<void>(resolve => { let turns = 16; const step = () => { if (--turns) setTimeout(step, 0); else resolve(); }; setTimeout(step, 0); }));
        await ready(page); const after = await snapshot(page);
        expect(after.source.revision).toBe(before.source.revision); expect(after.history).toEqual(before.history); expect(await source(page)).toBe(original);
        expect(after.bindings.views.map(v => v.selection)).toEqual(before.bindings.views.map(v => v.selection));
        expect(after.source.exports).toBe(before.source.exports);
        await page.evaluate(() => window.hostFixture.dispose()); expect((await snapshot(page)).diagnostics).toMatchObject({ leases: 0, views: 0, subscriptions: 0 });
    });
    test("multiline commands, clipboard history and focus escape remain independent during find, review and save", async ({ page }) => {
        const original = "const saMORE = 1;\r\n\tconst second = 2; // TODO\r\nconst third = 3;", corrected = original.replace("saMORE", "sample");
        await setSource(page, original); await page.getByRole("button", { name: "Open source review", exact: true }).click(); await ready(page);
        await primary(page).press("Control+Home"); for (let i = 0; i < 8; i++) await primary(page).press("ArrowRight");
        await primary(page).press("Control+Space"); await expect(page.getByRole("option", { name: "sample", exact: true })).toBeVisible();
        await primary(page).press("Alt+Enter"); expect(await source(page)).toBe(corrected);
        await primary(page).press("Control+f"); const query = page.getByRole("textbox", { name: "Find source", exact: true });
        await query.fill("const"); await expect(page.getByLabel("Find status", { exact: true })).toContainText("3 matches · ready"); await query.press("Enter");
        const third = corrected.indexOf("const third"), rev = (await snapshot(page)).source.revision;
        await page.evaluate(({ rev, third }) => { if (!window.hostFixture.selectSource("secondary", rev, { anchor: third + 6, head: third + 6 })) throw new Error("Selection setup failed."); }, { rev, third });
        await primary(page).press("Control+Home"); await primary(page).press("Shift+ArrowDown"); await primary(page).press("Shift+ArrowDown");
        expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selection).toMatchObject({ anchor: 0, head: third });
        const before = await snapshot(page), indented = "    " + corrected.replace("\r\n", "\r\n    ");
        await primary(page).press("Tab"); await ready(page); expect(await source(page)).toBe(indented);
        expect((await snapshot(page)).history.undoDepth).toBe(before.history.undoDepth + 1);
        expect((await snapshot(page)).bindings.views.find(v => v.id === "secondary")!.selection.head).toBe(third + 14);
        await primary(page).press("Shift+Tab"); expect(await source(page)).toBe(corrected);
        await primary(page).press("Control+z"); expect(await source(page)).toBe(indented);
        await primary(page).press("Control+z"); expect(await source(page)).toBe(corrected);
        await primary(page).press("Control+End"); const bracket = await snapshot(page); await primary(page).pressSequentially("()");
        expect(await source(page)).toBe(corrected + "()"); expect((await snapshot(page)).source.revision).toBe(bracket.source.revision + 1);
        await primary(page).press("Shift+ArrowLeft"); expect(await clipboard(primary(page), "copy")).toBe(")");
        expect(await clipboard(primary(page), "cut")).toBe(")"); expect(await source(page)).toBe(corrected + "(");
        await primary(page).press("Control+z"); expect(await source(page)).toBe(corrected + "()");
        await primary(page).press("Control+Shift+z"); expect(await source(page)).toBe(corrected + "(");
        await page.getByRole("button", { name: "Save source", exact: true }).click(); await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
        await primary(page).press("Control+End"); await primary(page).pressSequentially("."); await clipboard(primary(page), "paste", "A\r\nB");
        const later = corrected + "(.A\r\nB"; expect(await source(page)).toBe(later);
        await page.evaluate(() => window.hostFixture.finishSave()); await expect.poll(async () => (await snapshot(page)).source.serverVersion).toBe("v1");
        await expect(primary(page)).toBeFocused(); expect((await snapshot(page)).source.dirty).toBe(true);
        await primary(page).press("Control+z"); expect(await source(page)).toBe(corrected + "(.");
        await primary(page).press("Control+z"); expect(await source(page)).toBe(corrected + "("); expect((await snapshot(page)).source.dirty).toBe(false);
        await primary(page).press("Control+Shift+z"); await primary(page).press("Control+Shift+z"); expect(await source(page)).toBe(later);
        const retained = await snapshot(page); await primary(page).press("Escape"); await primary(page).press("Tab");
        const form = page.getByRole("textbox", { name: "Configuration path", exact: true }); await expect(form).toBeFocused();
        await form.pressSequentially(" host"); expect(await source(page)).toBe(later); expect((await snapshot(page)).history).toEqual(retained.history);
        await form.press("Shift+Tab"); await expect(primary(page)).toBeFocused();
        expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selection).toEqual(retained.bindings.views.find(v => v.id === "primary")!.selection);
        await ready(page); await expect(page.getByLabel("Find status", { exact: true })).toContainText("3 matches · ready");
        await page.evaluate(() => window.hostFixture.dispose()); expect((await snapshot(page)).diagnostics).toMatchObject({ leases: 0, views: 0, subscriptions: 0 });
    });
    test("read-only editing commands cannot change text or shared history while copying and focus navigation remain usable", async ({ page }) => {
        const original = "😀 é\r\nconst sample = 1; // TODO"; await setSource(page, original);
        await page.getByRole("checkbox", { name: "Paste tables as CSV" }).check();
        await page.getByRole("button", { name: "Open source review", exact: true }).click(); await ready(page);
        await page.evaluate(() => window.hostFixture.setSourceReadOnly(true));
        const notice = page.getByLabel("Primary source edit feedback", { exact: true });
        await primary(page).press("Control+Home"); await primary(page).press("Shift+ArrowRight");
        expect(await clipboard(primary(page), "copy")).toBe("😀"); const before = await snapshot(page);
        await expect(notice).toBeHidden();
        for (const attempt of ["type", "delete", "paste"]) {
            if (attempt === "paste") await clipboard(primary(page), "paste", "blocked");
            else await primary(page).press(attempt === "type" ? "x" : "Delete");
            await expect(notice).toHaveText("This source is read-only.");
            await expect(notice).toBeVisible(); await expect(primary(page)).toBeFocused();
            await primary(page).blur(); await expect(notice).toBeHidden(); await primary(page).focus();
        }
        for (const key of ["Backspace", "Delete", "Tab", "Shift+Tab", "Control+z", "Control+Shift+z"]) await primary(page).press(key);
        await primary(page).pressSequentially("(human)"); await clipboard(primary(page), "cut"); await clipboard(primary(page), "paste", "rejected\r\ntext"); await ready(page);
        const after = await snapshot(page); expect(after.source.revision).toBe(before.source.revision); expect(after.history).toEqual(before.history); expect(await source(page)).toBe(original);
        expect(after.inputRecovery).toEqual(before.inputRecovery);
        await primary(page).press("Escape"); await primary(page).press("Tab"); await expect(page.getByRole("textbox", { name: "Configuration path", exact: true })).toBeFocused();
        await page.evaluate(() => window.hostFixture.setSourceReadOnly(false)); await primary(page).press("Control+End"); await primary(page).pressSequentially("!");
        expect(await source(page)).toBe(original + "!"); await primary(page).press("Control+z"); expect(await source(page)).toBe(original);
        await page.evaluate(() => window.hostFixture.dispose()); expect((await snapshot(page)).diagnostics).toMatchObject({ leases: 0, views: 0, subscriptions: 0 });
    });
    test("large backward clipboard ranges preserve CRLF, reference identity and undo-to-saved across host remount", async ({ page }) => {
        const original = "const sample = 1234567;\r\n".repeat(100_000), from = 100_000, to = original.length - 100_000;
        await setSource(page, original); await page.getByRole("button", { name: "Open source review", exact: true }).click();
        await page.getByRole("button", { name: "Capture review acceptance", exact: true }).click(); await page.getByRole("button", { name: "Finish review acceptance", exact: true }).click(); await ready(page);
        await primary(page).focus(); await page.evaluate(({ from, to }) => { const f = window.hostFixture; if (!f.selectSource("primary", f.snapshot().source.revision, { anchor: to, head: from })) throw new Error("Selection setup failed."); }, { from, to });
        const before = await snapshot(page); expect(before.bindings.views.find(v => v.id === "primary")!.metrics!.inputUnits).toBeLessThan(2600);
        expect(await clipboard(primary(page), "copy")).toBe(original.slice(from, to));
        await clipboard(primary(page), "paste", "A\r\nB"); const pasted = original.slice(0, from) + "A\r\nB" + original.slice(to); await ready(page);
        expect(await source(page)).toBe(pasted); expect((await snapshot(page)).source.exports).toBe(0);
        expect((await snapshot(page)).history.undoDepth).toBe(before.history.undoDepth + 1);
        await page.evaluate(() => window.hostFixture.unmount()); await page.evaluate(() => window.hostFixture.mount()); await ready(page);
        await primary(page).press("Control+z"); expect(await source(page)).toBe(original); await primary(page).press("Control+Shift+z"); expect(await source(page)).toBe(pasted);
        expect(await page.evaluate(length => window.hostFixture.referenceRange(0, length), original.length)).toBe(original);
        const secondary = page.getByRole("textbox", { name: "Secondary source", exact: true });
        await secondary.press("Control+s"); await expect(secondary).toBeFocused();
        await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
        await primary(page).press("Control+End"); await primary(page).pressSequentially("!"); await page.evaluate(() => window.hostFixture.finishSave());
        await expect.poll(async () => (await snapshot(page)).source.serverVersion).toBe("v1"); expect(await source(page)).toBe(pasted + "!");
        await primary(page).press("Control+z"); expect(await source(page)).toBe(pasted); expect((await snapshot(page)).source.dirty).toBe(true);
        // The host's canonical reply trims the final CRLF; only an explicit user edit adopts that text after later typing.
        await primary(page).press("Control+End"); await primary(page).press("Backspace"); expect(await source(page)).toBe(pasted.trimEnd()); expect((await snapshot(page)).source.dirty).toBe(false);
        await primary(page).press("Control+z"); expect(await source(page)).toBe(pasted); expect((await snapshot(page)).source.dirty).toBe(true);
        await primary(page).press("Control+Shift+z"); expect((await snapshot(page)).source.dirty).toBe(false);
        const end = await snapshot(page); expect(end.bindings.views.every(v => v.metrics!.inputUnits < 2600 && v.metrics!.viewport.rows < 50)).toBe(true);
        await page.evaluate(() => window.hostFixture.dispose()); expect((await snapshot(page)).diagnostics).toMatchObject({ leases: 0, views: 0, subscriptions: 0 });
    });
});

for (const editor of ["native", "candidate"] as const) for (const mode of ["plain", "react"] as const) {
    test(`${mode} ${editor} keyboard re-entry preserves backward and collapsed model selections`, async ({ page }) => {

        await page.goto(`/hosts/${mode}/?editor=${editor}`); await expect(primary(page)).toBeVisible();
        const original = "first\r\nsecond😀\r\nthird";
        await page.evaluate(text => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]); }, original);
        await primary(page).focus();
        await page.evaluate(length => { const f = window.hostFixture; if (!f.selectSource("primary", f.snapshot().source.revision, { anchor: length, head: 7 })) throw new Error("Selection setup failed."); }, original.length);
        const selected = (await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selection;
        const form = page.getByRole("textbox", { name: "Configuration path", exact: true });
        await primary(page).press("Escape"); await primary(page).press("Tab"); await expect(form).toBeFocused();
        await form.press("Control+s"); expect((await snapshot(page)).pendingSaves).toEqual([]);
        await form.press("Shift+Tab"); await expect(primary(page)).toBeFocused();
        expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selection).toEqual(selected);
        const captured = await snapshot(page);
        await primary(page).press(editor === "native" ? "Meta+s" : "Control+s"); await expect(primary(page)).toBeFocused();
        await expect.poll(async () => (await snapshot(page)).pendingSaves).toEqual([
            { revision: captured.source.revision, length: original.length, expectedServerVersion: "v0" },
        ]);
        expect((await snapshot(page)).bindings.views.map(v => v.selection)).toEqual(captured.bindings.views.map(v => v.selection));
        await primary(page).pressSequentially("!"); expect(await source(page)).toBe(original.slice(0, 7) + "!");
        await page.evaluate(() => window.hostFixture.finishSave()); await expect.poll(async () => (await snapshot(page)).pendingCommands).toBe(0);
        expect(await source(page)).toBe(original.slice(0, 7) + "!");
        await primary(page).press("Control+z"); expect(await source(page)).toBe(original); expect((await snapshot(page)).source.dirty).toBe(false);
        await primary(page).press("Control+End"); const collapsed = (await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selection;
        await primary(page).press("Escape"); await primary(page).press("Tab"); await expect(form).toBeFocused();
        await form.press("Shift+Tab"); await expect(primary(page)).toBeFocused();
        expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.selection).toEqual(collapsed);
        await primary(page).pressSequentially("x"); expect(await source(page)).toBe(original + "x");
        await page.evaluate(() => window.hostFixture.dispose()); expect((await snapshot(page)).diagnostics).toMatchObject({ leases: 0, views: 0, subscriptions: 0 });
    });
}
