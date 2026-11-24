import { moveEditorIntoShadow } from "../helpers/shadow-editor.ts";
import { ready, test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";

type State = ReturnType<Window["hostFixture"]["snapshot"]>;
const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const primary = (page: Page) => page.getByRole("textbox", { name: "Primary source", exact: true });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const selection = (s: State) => s.bindings.views.find(v => v.id === "primary")!.selection;

test("host commands use confirmed matches immediately while a local edit is awaiting find repair", async ({ page }) => {
    await page.goto("/hosts/plain/"); await ready(page);
    await page.evaluate(() => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: "cat\n".repeat(2000) }]); });
    await ready(page); await primary(page).press("Control+Home"); await primary(page).press("Control+f");
    await page.getByRole("textbox", { name: "Find source", exact: true }).fill("cat");
    await expect(page.getByLabel("Find status", { exact: true })).toHaveText("2000 matches · ready");
    const result = await page.evaluate(() => {
        const f = window.hostFixture, s = f.snapshot();
        // Keep the edit and command in one turn to exercise pending repair deterministically.
        // Synthetic routing checks host ownership; this does not claim native input latency.
        const origin = document.activeElement!; f.editSource(s.source.revision, [{ from: 4000, to: 4003, insert: "dog" }]);
        const buttons = [...document.querySelectorAll("button")], enabled = (label: string) => !buttons.find(b => b.textContent === label)!.disabled;
        const status = document.querySelector('[aria-label="Find status"]')!.textContent;
        const controls = { next: enabled("Find next"), current: enabled("Replace current"), all: enabled("Replace all") };
        origin.dispatchEvent(new KeyboardEvent("keydown", { key: "F3", bubbles: true, cancelable: true }));
        return { status, controls, after: f.snapshot() };
    });
    expect(result.status).toContain("searching"); expect(result.controls).toEqual({ next: true, current: true, all: false });
    expect(selection(result.after)).toMatchObject({ anchor: 0, head: 3 }); expect(result.after.bindings.language.findCommandPending).toBeNull();
    await expect(page.getByLabel("Find status", { exact: true })).toHaveText("1999 matches · ready");
    await primary(page).press("Control+z"); await expect(page.getByLabel("Find status", { exact: true })).toHaveText("2000 matches · ready");
});

test("a pending F3 in a shadow editor respects focus and fold changes", async ({ page }) => {
    await page.goto("/hosts/plain/"); await ready(page);
    const prefix = "some line\n".repeat(20000);
    await primary(page).focus();
    await page.evaluate(text => { const f = window.hostFixture, s = f.snapshot().source;
        f.editSource(s.revision, [{ from: 0, to: s.length, insert: text }]);
        f.selectSource("primary", f.snapshot().source.revision, { anchor: 0, head: 18 });
    }, prefix + "first second third");
    await button(page, "Fold selected lines").click();
    await expect.poll(async () => (await snapshot(page)).bindings.views.find(v => v.id === "primary")!.metrics!.viewport.collapsedFolds).toBe(1);
    const source = primary(page), query = page.getByRole("textbox", { name: "Find source", exact: true });
    await moveEditorIntoShadow(source); await source.press("Control+f");
    const input = (await source.elementHandle())!;
    try {
        for (const needle of ["first", "second", "third"]) {
            const pending = await query.evaluate((node, { input, needle }) => {
                const field = node as HTMLInputElement, source = input as HTMLElement;
                field.value = needle; field.dispatchEvent(new Event("input", { bubbles: true }));
                source.focus();
                source.dispatchEvent(new KeyboardEvent("keydown", { key: "F3", bubbles: true, cancelable: true }));
                const pending = window.hostFixture.snapshot().bindings.language.findCommandPending;
                if (needle === "second") { field.focus(); source.focus(); }
                if (needle === "third") source.dispatchEvent(new KeyboardEvent("keydown", { key: "}", code: "BracketRight", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
                return pending;
            }, { input, needle });
            expect(pending).toBe("navigate");
            await expect(page.getByLabel("Find status", { exact: true })).toHaveText("1 matches · ready");
            await expect.poll(async () => selection(await snapshot(page))).toMatchObject({ anchor: prefix.length, head: prefix.length + 5 });
            expect((await snapshot(page)).bindings.language.findCommandPending).toBeNull();
        }
        expect((await snapshot(page)).bindings.views.find(v => v.id === "primary")!.metrics!.viewport.collapsedFolds).toBe(0);
        await source.press("F3");
        await expect.poll(async () => selection(await snapshot(page))).toMatchObject({ anchor: prefix.length + 13, head: prefix.length + 18 });
    } finally { await input.dispose(); }
});
