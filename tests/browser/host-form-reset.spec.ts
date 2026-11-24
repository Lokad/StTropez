import { ready, test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";

const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const exact = (page: Page, text: string) => page.evaluate(text => {
    const fixture = window.hostFixture;
    return fixture.snapshot().source.length === text.length && fixture.range(0, text.length) === text;
}, text);
async function waitForViews(page: Page): Promise<void> {
    await ready(page);
    await page.waitForFunction(() => { const s = window.hostFixture.snapshot(); return window.hostFixture.settled && (s.bindings.activeViews === 2); });
}
const nativeState = (page: Page) => page.locator("textarea").evaluateAll(nodes => nodes.map(node => {
    const input = node as HTMLTextAreaElement;
    return { label: input.getAttribute("aria-label"), value: input.value, start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection };
}));

for (const editor of ["native", "candidate"] as const) for (const mode of ["plain", "react"] as const) {
    test(`${mode} ${editor} host form reset preserves source projections, captured save and shared history`, async ({ page }) => {

        await page.goto(`/hosts/${mode}/?editor=${editor}`);
        const button = (name: string) => page.getByRole("button", { name, exact: true });
        const primary = page.getByRole("textbox", { name: "Primary source", exact: true });
        const original = "const café = 'é 😀';\r\nconst end = 123;";
        await page.evaluate(text => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]); }, original);
        await button("Open source review").click(); await waitForViews(page);
        await button("Capture review acceptance").click(); await button("Finish review acceptance").click(); await waitForViews(page);
        const offset = original.length;
        expect(await page.evaluate(offset => { const f = window.hostFixture, revision = f.snapshot().source.revision;
            return f.selectSource("primary", revision, { anchor: offset, head: offset }) && f.selectSource("secondary", revision, { anchor: 5, head: 0 });
        }, offset)).toBe(true);
        await button("Save source").click(); await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
        await page.evaluate(() => {
            const host = document.getElementById("host")!, form = document.createElement("form"); form.id = "outer-host-form";
            host.parentNode!.insertBefore(form, host); form.append(host);
            const field = document.createElement("input"); field.setAttribute("aria-label", "Unrelated host field");
            field.defaultValue = "host default"; field.value = "host changed"; form.append(field);
            form.addEventListener("submit", event => event.preventDefault());
        });
        await primary.focus(); await waitForViews(page);
        const before = await snapshot(page), nativeBefore = await nativeState(page);
        expect(before.bindings.views.find(view => view.id === "primary")!.selection).toMatchObject({ anchor: offset, head: offset });
        await page.evaluate(() => (document.getElementById("outer-host-form") as HTMLFormElement).reset());
        await expect(page.getByRole("textbox", { name: "Unrelated host field", exact: true })).toHaveValue("host default");
        const reset = await snapshot(page);
        expect(reset.source.revision).toBe(before.source.revision); expect(reset.history).toEqual(before.history);
        expect(reset.pendingSaves).toEqual(before.pendingSaves); expect(reset.bindings.views.map(view => view.selection)).toEqual(before.bindings.views.map(view => view.selection));
        expect(await nativeState(page)).toEqual(nativeBefore); expect(await exact(page, original)).toBe(true);
        await primary.pressSequentially("q"); await waitForViews(page);
        const expected = original.slice(0, offset) + "q" + original.slice(offset), typed = await snapshot(page);
        expect(await exact(page, expected)).toBe(true); expect(typed.source.revision).toBe(before.source.revision + 1);
        expect(typed.bindings.views.find(view => view.id === "primary")!.selection).toMatchObject({ anchor: offset + 1, head: offset + 1 });
        expect(typed.bindings.views.find(view => view.id === "secondary")!.selection).toEqual(before.bindings.views.find(view => view.id === "secondary")!.selection);
        // Export counters belong to each immutable buffer; the new revision starts at zero.
        if (editor === "candidate") expect(typed.source.exports).toBe(0);
        await page.evaluate(() => window.hostFixture.finishSave());
        await expect.poll(async () => (await snapshot(page)).source.serverVersion).toBe("v1"); await waitForViews(page);
        expect(await exact(page, expected)).toBe(true); expect((await snapshot(page)).source.dirty).toBe(true);
        await primary.press("Control+z"); await waitForViews(page); expect(await exact(page, original)).toBe(true); expect((await snapshot(page)).source.dirty).toBe(false);
        await primary.press("Control+Shift+z"); await waitForViews(page); expect(await exact(page, expected)).toBe(true); expect((await snapshot(page)).source.dirty).toBe(true);
        await page.evaluate(() => window.hostFixture.dispose()); const disposed = await snapshot(page);
        expect(disposed.diagnostics.views).toBe(0); expect(disposed.diagnostics.leases).toBe(0); expect(disposed.diagnostics.subscriptions).toBe(0); expect(disposed.hostSubscriptions).toBe(0);
    });
}
