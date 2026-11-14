import { ready, test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";

type State = ReturnType<Window["hostFixture"]["snapshot"]>;
type DiagnosticTrace = { commandTrusted?: boolean; events: { type: string; trusted: boolean }[] };
declare global { interface Window { diagnosticTrace?: DiagnosticTrace } }
const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const source = (page: Page) => page.evaluate(() => { const f = window.hostFixture; return f.range(0, f.snapshot().source.length); });
const primary = (page: Page) => page.getByRole("textbox", { name: "Primary source", exact: true });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const diagnostic = (page: Page) => page.getByLabel("Source diagnostics", { exact: true }).getByRole("button").first();
const selection = (state: State) => state.bindings.views.find(v => v.id === "primary")!.selection;

async function request(page: Page): Promise<void> {
    await primary(page).focus(); await page.keyboard.press("Control+Home"); await page.keyboard.press("Control+Space");
    await expect(diagnostic(page)).toBeVisible(); await ready(page);
}
test.afterEach(async ({ page }, info) => {
    if (page.isClosed()) return;
    await info.attach("diagnostic-composition-events", { contentType: "application/json", body: JSON.stringify(await page.evaluate(() => window.diagnosticTrace ?? {})) });
    if (info.status !== info.expectedStatus) {
        await info.attach("diagnostic-composition-state", { contentType: "application/json", body: JSON.stringify(await snapshot(page)) });
        await info.attach("diagnostic-composition-source", { contentType: "text/plain", body: await source(page) });
    }
});

for (const host of ["plain", "react"] as const) for (const phase of ["ordinary", "commit", "cancel"] as const)
    test(`${host} diagnostic selection ${phase} preserves composition and captured work`, async ({ page }) => {

        // The save fixture trims trailing whitespace; internal CRLF and Unicode remain exact.
        const original = "const sample = 123;\r\n// TODO verify café 😀\r\nconst end = 1;", todo = original.indexOf("TODO");
        await page.goto(`/hosts/${host}/?editor=candidate`); await expect(primary(page)).toBeVisible();
        await page.evaluate(text => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]); }, original);
        await ready(page);
        for (const name of ["Save source", "Finish save", "Open source review", "Capture reference refresh", "Finish reference refresh"]) await button(page, name).click();
        await ready(page); expect(await source(page)).toBe(original);
        const baseline = (await snapshot(page)).bindings.comparison!.baseline!;
        await button(page, "Save source").click(); await request(page);
        const before = await snapshot(page); expect(selection(before)).toMatchObject({ anchor: 0, head: 0 });
        expect(before.bindings.language.sessions.find(s => s.id === "primary")!.provider.diagnostics).toBe(1);
        await primary(page).evaluate(node => {
            window.diagnosticTrace = { events: [] };
            for (const type of ["compositionstart", "input", "compositionend"])
                node.addEventListener(type, event => window.diagnosticTrace!.events.push({ type, trusted: event.isTrusted }));
        });
        if (phase !== "ordinary") await primary(page).evaluate(node => {
            const input = node as HTMLTextAreaElement;
            // Synthetic protocol staging, separate from the native IME/device gate.
            input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
            input.setRangeText("東京", input.selectionStart, input.selectionEnd, "end");
            input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "東京", isComposing: true }));
        });
        await diagnostic(page).evaluate(node => node.addEventListener("click", event => { window.diagnosticTrace!.commandTrusted = event.isTrusted; }, { capture: true, once: true }));
        // Explicit host callback avoids a focus move that could end native composition.
        if (phase === "ordinary") await diagnostic(page).click(); else await diagnostic(page).evaluate(node => (node as HTMLButtonElement).click());
        const during = await snapshot(page);
        expect(during.source.revision).toBe(before.source.revision); expect(during.history).toEqual(before.history); expect(await source(page)).toBe(original);
        if (phase === "ordinary") expect(selection(during)).toMatchObject({ anchor: todo, head: todo + 4 });
        else {
            expect(selection(during)).toEqual(selection(before));
            expect(during.bindings.views.find(v => v.id === "primary")!.metrics!.composing).toBe(true);
            expect(during.bindings.language.sessions.find(s => s.id === "primary")!.provider.diagnostics).toBe(1);
            await primary(page).evaluate((node, commit) => {
                const input = node as HTMLTextAreaElement;
                if (!commit) input.setRangeText("", input.selectionStart - 2, input.selectionEnd, "end");
                input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: commit ? "東京" : "" }));
            }, phase === "commit");
        }
        await ready(page); const expected = phase === "commit" ? "東京" + original : original, groups = phase === "commit" ? 1 : 0;
        expect(await source(page)).toBe(expected); const afterComposition = await snapshot(page);
        expect(afterComposition.source.revision).toBe(before.source.revision + groups);
        expect(afterComposition.history.undoDepth).toBe(before.history.undoDepth + groups);
        if (phase === "cancel") {
            // Cancellation retains the diagnostics; the same command now works without a new request.
            await diagnostic(page).click();
        } else if (phase === "commit") {
            // Text edits expire diagnostics. A fresh worker request remains usable after composition.
            await expect(diagnostic(page)).toHaveCount(0); await request(page); await diagnostic(page).click();
        }
        await ready(page); const edited = await snapshot(page);
        expect(selection(edited)).toMatchObject({ anchor: todo + groups * 2, head: todo + groups * 2 + 4 });
        expect(await source(page)).toBe(expected); expect(edited.history).toEqual(afterComposition.history);
        expect(edited.inputRecovery).toEqual(before.inputRecovery); expect(edited.pendingSaves).toEqual(before.pendingSaves);
        expect(edited.source.exports).toBe(groups ? 0 : before.source.exports); expect(edited.bindings.comparison!.baseline).toEqual(baseline);
        expect(await page.evaluate(text => window.hostFixture.referenceRange(0, text.length) === text, original)).toBe(true);
        const trace = await page.evaluate(() => window.diagnosticTrace!);
        expect(trace.commandTrusted).toBe(phase === "ordinary"); expect(trace.events.every(e => !e.trusted)).toBe(true);
        expect(trace.events.map(e => e.type)).toEqual(phase === "ordinary" ? [] : ["compositionstart", "input", "compositionend"]);
        await button(page, "Finish save").click(); await ready(page); expect(await source(page)).toBe(expected);
        expect((await snapshot(page)).source).toMatchObject({ serverVersion: "v2", dirty: groups > 0 });
        await page.getByRole("textbox", { name: "Secondary source", exact: true }).focus();
        if (groups) await page.keyboard.press("Control+z");
        await ready(page); expect(await source(page)).toBe(original); expect((await snapshot(page)).source.dirty).toBe(false);
        if (groups) await page.keyboard.press("Control+Shift+z");
        await ready(page); expect(await source(page)).toBe(expected);
        await page.evaluate(() => window.hostFixture.dispose()); const disposed = await snapshot(page);
        expect(disposed.diagnostics).toMatchObject({ views: 0, subscriptions: 0, leases: 0 }); expect(disposed.hostSubscriptions).toBe(0);
    });
