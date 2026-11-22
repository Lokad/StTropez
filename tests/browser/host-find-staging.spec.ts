import { moveEditorIntoShadow } from "../helpers/shadow-editor.ts";
import { ready, test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";

type State = ReturnType<Window["hostFixture"]["snapshot"]>;
type FindStagingTrace = { commandTrusted?: boolean; events: { type: string; trusted: boolean }[] };
declare global { interface Window { findStagingTrace?: FindStagingTrace } }
const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const primary = (page: Page) => page.getByRole("textbox", { name: "Primary source", exact: true });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const selection = (s: State) => s.bindings.views.find(v => v.id === "primary")!.selection;
const source = (page: Page) => page.evaluate(() => { const f = window.hostFixture; return f.range(0, f.snapshot().source.length); });

test("host commands use confirmed matches immediately while a local edit is awaiting find repair", async ({ page }) => {
    await page.goto("/hosts/plain/?editor=candidate"); await ready(page);
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
    await page.goto("/hosts/plain/?editor=candidate"); await ready(page);
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

test.afterEach(async ({ page }, info) => {
    if (page.isClosed()) return;
    await info.attach("find-staging-events", { contentType: "application/json", body: JSON.stringify(await page.evaluate(() => window.findStagingTrace ?? {})) });
    if (info.status !== info.expectedStatus) {
        await info.attach("find-staging-failed-state", { contentType: "application/json", body: JSON.stringify(await snapshot(page)) });
        await info.attach("find-staging-failed-source", { contentType: "text/plain", body: await source(page) });
    }
});

for (const host of ["plain", "react"] as const) for (const action of ["Find next", "Find previous", "Replace current"] as const)
    for (const composing of [false, true]) test(`${host} ${action} ${composing ? "composition" : "ordinary"} preserves staged selection and captured work`, async ({ page }) => {

        // The save fixture trims trailing whitespace; internal CRLF and Unicode remain exact.
        const original = "const sample = 123;\r\n// café 😀\r\nconst sample = 456;", first = original.indexOf("sample"), second = original.lastIndexOf("sample");
        const composed = original.slice(0, first) + "東京" + original.slice(first + 6), replaced = original.slice(0, first) + "changed" + original.slice(first + 6);
        await page.goto(`/hosts/${host}/?editor=candidate`); await expect(primary(page)).toBeVisible();
        await page.evaluate(text => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]); }, original);
        await ready(page);
        for (const name of ["Save source", "Finish save", "Open source review", "Capture reference refresh", "Finish reference refresh"]) await button(page, name).click();
        await ready(page); expect(await source(page)).toBe(original);
        const baseline = (await snapshot(page)).bindings.comparison!.baseline!;
        await button(page, "Save source").click();
        await primary(page).focus(); await page.keyboard.press("Control+Home"); await page.keyboard.press("Control+f");
        await page.getByRole("textbox", { name: "Find source", exact: true }).fill("sample");
        await expect(page.getByLabel("Find status", { exact: true })).toHaveText("2 matches · ready");
        await page.getByRole("textbox", { name: "Replacement", exact: true }).fill("changed"); await button(page, "Find next").click();
        await ready(page); const before = await snapshot(page);
        expect(selection(before)).toMatchObject({ anchor: first, head: first + 6 });
        await primary(page).evaluate(node => {
            window.findStagingTrace = { events: [] };
            for (const type of ["compositionstart", "compositionend", "input"])
                node.addEventListener(type, event => window.findStagingTrace!.events.push({ type, trusted: event.isTrusted }));
        });
        if (composing) await primary(page).evaluate(node => {
            const input = node as HTMLTextAreaElement;
            // Synthetic protocol staging; this does not exercise a native IME.
            input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
            input.setRangeText("東京", input.selectionStart, input.selectionEnd, "end");
            input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "東京", isComposing: true }));
        });
        const command = button(page, action);
        await command.evaluate(node => node.addEventListener("click", event => { window.findStagingTrace!.commandTrusted = event.isTrusted; }, { capture: true, once: true }));
        // A host callback deliberately avoids moving focus/ending native composition.
        if (composing) await command.evaluate(node => (node as HTMLButtonElement).click()); else await command.click();
        const during = await snapshot(page), trace = await page.evaluate(() => window.findStagingTrace!);
        expect(trace.commandTrusted).toBe(!composing); expect(trace.events.every(e => !e.trusted)).toBe(true);
        let expected = action === "Replace current" ? replaced : original;
        if (composing) {
            expect(during.source.revision).toBe(before.source.revision); expect(during.history).toEqual(before.history);
            expect(selection(during)).toEqual(selection(before)); expect(await source(page)).toBe(original);
            expect(during.bindings.views.find(v => v.id === "primary")!.metrics!.composing).toBe(true);
            expect(during.inputRecovery).toEqual(before.inputRecovery);
            await primary(page).evaluate(node => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "東京" })));
            await ready(page); expect(await source(page)).toBe(composed);
            const committed = await snapshot(page); expect(committed.source.revision).toBe(before.source.revision + 1);
            expect(committed.history.undoDepth).toBe(before.history.undoDepth + 1);
            expect(selection(committed)).toMatchObject({ anchor: first + 2, head: first + 2 });
            expect(committed.inputRecovery).toEqual(before.inputRecovery);
            // A fresh command after composition remains usable; rejection did not cancel the search index.
            if (action === "Replace current") await button(page, "Find next").click();
            await command.click(); await ready(page);
            expected = action === "Replace current" ? composed.replace("sample", "changed") : composed;
        } else if (action !== "Replace current") expect(selection(during)).toMatchObject({ anchor: second, head: second + 6 });
        await ready(page); expect(await source(page)).toBe(expected); const edited = await snapshot(page);
        const groups = composing ? action === "Replace current" ? 2 : 1 : action === "Replace current" ? 1 : 0;
        expect(edited.source.revision).toBe(before.source.revision + groups); expect(edited.history.undoDepth).toBe(before.history.undoDepth + groups);
        expect(edited.pendingSaves).toEqual(before.pendingSaves); expect(edited.source.exports).toBe(groups ? 0 : before.source.exports);
        expect(edited.inputRecovery).toEqual(before.inputRecovery); expect(edited.bindings.comparison!.baseline).toEqual(baseline);
        expect(await page.evaluate(text => window.hostFixture.referenceRange(0, text.length) === text, original)).toBe(true);
        await button(page, "Finish save").click(); await ready(page); expect(await source(page)).toBe(expected);
        expect((await snapshot(page)).source).toMatchObject({ serverVersion: "v2", dirty: groups > 0 });
        await page.getByRole("textbox", { name: "Secondary source", exact: true }).focus();
        for (let i = 0; i < groups; i++) await page.keyboard.press("Control+z");
        await ready(page); expect(await source(page)).toBe(original); expect((await snapshot(page)).source.dirty).toBe(false);
        for (let i = 0; i < groups; i++) await page.keyboard.press("Control+Shift+z");
        await ready(page); expect(await source(page)).toBe(expected);
        await page.evaluate(() => window.hostFixture.dispose()); const disposed = await snapshot(page);
        expect(disposed.diagnostics).toMatchObject({ views: 0, subscriptions: 0, leases: 0 }); expect(disposed.hostSubscriptions).toBe(0);
    });
