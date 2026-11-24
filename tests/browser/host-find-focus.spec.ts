import { ready, test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
import { hostTextEquals } from "../../scripts/host-scene.mjs";

type FocusEventRecord = Readonly<{ type: string; key: string | null; trusted: boolean; label: string | null; revision: number }>;
declare global { interface Window { replaceFocusEvents?: FocusEventRecord[] } }
const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const primary = (page: Page) => page.getByRole("textbox", { name: "Primary source", exact: true });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
async function exact(page: Page, text: string): Promise<void> { expect(await hostTextEquals(page, text)).toBe(true); }

test.afterEach(async ({ page }, info) => {
    if (page.isClosed()) return;
    await info.attach("replace-focus-events", { contentType: "application/json", body: JSON.stringify(await page.evaluate(() => window.replaceFocusEvents), null, 2) });
    if (info.status !== info.expectedStatus) {
        await info.attach("replace-focus-failed-state", { contentType: "application/json", body: JSON.stringify(await snapshot(page), null, 2) });
        await info.attach("replace-focus-failed-source", { contentType: "text/plain", body: await page.evaluate(() => {
            const f = window.hostFixture; return f.range(0, f.snapshot().source.length);
        }) });
    }
});

for (const arm of ["stay", "form", "interrupt"] as const)
    test(`plain 50000 replace all ${arm} preserves focus intent and captured work`, async ({ page }) => {

        const original = Array(50000).fill("sample").join("\r\n"), changed = original.replaceAll("sample", "changed");
        await page.goto(`/hosts/plain/?editor=candidate`); await expect(primary(page)).toBeVisible();
        await page.evaluate(text => { const f = window.hostFixture, s = f.snapshot();
            f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]);
        }, original); await ready(page);
        for (const name of ["Save source", "Finish save", "Open source review", "Capture reference refresh", "Finish reference refresh"])
            await button(page, name).click();
        await ready(page); const reference = (await snapshot(page)).bindings.comparison!;
        expect(reference.referenceIsWorkingBuffer).toBe(false); expect(reference.hunks).toBe(0);
        await button(page, "Save source").click(); await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
        await primary(page).focus(); await page.keyboard.press("Control+Home"); await ready(page);
        const before = await snapshot(page), field = page.getByRole("textbox", { name: "Configuration path", exact: true }), path = await field.inputValue();
        await page.keyboard.press("Control+f"); await page.getByRole("textbox", { name: "Find source", exact: true }).fill("sample");
        const status = page.getByLabel("Find status", { exact: true }); await expect(status).toHaveText("50000 matches · ready");
        await page.getByRole("textbox", { name: "Replacement", exact: true }).fill("changed");
        await page.evaluate(() => {
            const events: FocusEventRecord[] = []; window.replaceFocusEvents = events;
            for (const type of ["keydown", "focusin"]) document.addEventListener(type, event => {
                const element = event.target as HTMLInputElement;
                events.push({ type, key: event instanceof KeyboardEvent ? event.key : null, trusted: event.isTrusted,
                    label: element.getAttribute("aria-label") ?? element.labels?.[0]?.textContent ?? null, revision: window.hostFixture.snapshot().source.revision });
            }, true);
        });
        await button(page, "Replace all").click(); await expect(status).toHaveText("50000 matches · replacing");
        if (arm === "form") {
            await field.click(); await page.keyboard.press("End"); await page.keyboard.type(".during");
            expect((await snapshot(page)).source.revision).toBe(before.source.revision);
        } else if (arm === "interrupt") { await primary(page).focus(); await page.keyboard.type("!"); }
        await expect(status).toHaveText(arm === "interrupt" ? "50000 matches · ready" : "Replaced 50000 matches."); await ready(page);
        const expected = arm === "interrupt" ? "!" + original : changed, settled = await snapshot(page);
        await exact(page, expected); expect(settled.history.undoDepth).toBe(before.history.undoDepth + 1);
        expect(settled.pendingSaves).toEqual(before.pendingSaves); expect(settled.source.exports).toBe(0);
        expect(settled.bindings.comparison!.baseline!.version).toBe(reference.baseline!.version);
        expect(await page.evaluate(text => window.hostFixture.referenceRange(0, text.length) === text, original)).toBe(true);
        if (arm === "form") {
            await expect.soft(field).toBeFocused();
            // Send to the actual active element; refocusing a locator would hide the regression.
            await page.keyboard.type(".after"); await ready(page);
            await expect.soft(field).toHaveValue(path + ".during.after"); await exact(page, expected);
        } else await expect(primary(page)).toBeFocused();
        const events = await page.evaluate(() => window.replaceFocusEvents!);
        const keys = events.filter(event => event.type === "keydown");
        expect(keys.every(event => event.trusted)).toBe(true);
        if (arm === "form") expect(keys.filter(event => event.key === ".")).toHaveLength(2);
        await button(page, "Finish save").click(); const saved = await snapshot(page);
        expect(saved.source.serverVersion).toBe("v2"); expect(saved.source.dirty).toBe(true); await exact(page, expected);
        await page.getByRole("textbox", { name: "Secondary source", exact: true }).focus(); await page.keyboard.press("Control+z");
        await ready(page); await exact(page, original); expect((await snapshot(page)).source.dirty).toBe(false);
        await page.keyboard.press("Control+Shift+z"); await ready(page); await exact(page, expected);
        expect((await snapshot(page)).source.dirty).toBe(true); expect((await snapshot(page)).source.exports).toBe(0);
        await page.evaluate(() => window.hostFixture.dispose()); const disposed = await snapshot(page);
        expect(disposed.diagnostics).toMatchObject({ views: 0, subscriptions: 0, leases: 0 }); expect(disposed.hostSubscriptions).toBe(0);
    });
