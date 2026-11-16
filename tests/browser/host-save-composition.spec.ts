import { ready, test, expect } from "./fixtures.ts";

const snapshot = (page: import("@playwright/test").Page) => page.evaluate(() => window.hostFixture.snapshot());
const source = (page: import("@playwright/test").Page) => page.evaluate(() => { const f = window.hostFixture; return f.range(0, f.snapshot().source.length); });
async function waitForReview(page: import("@playwright/test").Page): Promise<void> {
    await ready(page);
    await page.waitForFunction(() => { const s = window.hostFixture.snapshot(); return window.hostFixture.settled && (s.bindings.comparison !== null); });
}
const selection = (state: Awaited<ReturnType<typeof snapshot>>, id: string) => state.bindings.views.find(v => v.id === id)!.selection;

for (const host of ["plain", "react"] as const) for (const reply of ["unchanged", "canonical"] as const)
    test(`${host} ${reply} save reply preserves staged input or captured recovery`, async ({ page }) => {

        const button = (name: string) => page.getByRole("button", { name, exact: true });
        const primary = page.getByRole("textbox", { name: "Primary source", exact: true });
        const original = "alpha omega\r\n// café 😀" + (reply === "canonical" ? "  " : "");
        const canonical = original.trimEnd(), attempted = original.replace("omega", "東京"), nativeAttempt = attempted.replaceAll("\r\n", "\n");
        await page.goto(`/hosts/${host}/?editor=candidate`);
        await page.evaluate(text => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]); }, original);
        for (const name of ["Open source review", "Capture review acceptance", "Finish review acceptance"]) await button(name).click();
        await waitForReview(page); await button("Save source").click();
        await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
        await primary.focus();
        expect(await page.evaluate(() => { const f = window.hostFixture, r = f.snapshot().source.revision;
            return f.selectSource("primary", r, { anchor: 6, head: 11 }) && f.selectSource("secondary", r, { anchor: 2, head: 4 }); })).toBe(true);
        const before = await snapshot(page);
        await primary.evaluate(node => {
            const input = node as HTMLTextAreaElement;
            // Protocol staging only. Native IME/reconversion remains a separate device gate.
            input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
            input.setRangeText("東京", input.selectionStart, input.selectionEnd, "end");
            input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "東京", isComposing: true }));
        });
        await expect(primary).toHaveValue(nativeAttempt); expect(await source(page)).toBe(original);
        await primary.press("Control+s"); expect((await snapshot(page)).pendingSaves).toEqual(before.pendingSaves);
        // Deliver without moving focus; a clicked control could end a real composition first.
        await page.evaluate(() => window.hostFixture.finishSave());
        await expect.poll(async () => (await snapshot(page)).source.serverVersion).toBe("v1");
        await expect.poll(async () => (await snapshot(page)).pendingCommands).toBe(0);
        const during = await snapshot(page);
        expect(await source(page)).toBe(canonical); await expect(primary).toHaveValue(nativeAttempt); await expect(primary).toBeFocused();
        expect(during.bindings.views.find(v => v.id === "primary")!.metrics!.composing).toBe(true);
        expect(selection(during, "secondary")).toEqual(selection(before, "secondary"));
        expect(during.bindings.comparison!.baseline).toEqual(before.bindings.comparison!.baseline);
        expect(during.inputRecovery).toEqual([]);
        expect(await page.evaluate(n => window.hostFixture.referenceRange(0, n), original.length)).toBe(original);
        await primary.evaluate(node => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "東京" })));
        await waitForReview(page); const after = await snapshot(page);
        if (reply === "canonical") {
            expect(await source(page)).toBe(canonical); expect(after.source.dirty).toBe(false);
            expect(after.source.revision).toBe(before.source.revision + 1);
            expect(after.inputRecovery).toEqual([{ documentId: before.bindings.views.find(v => v.id === "primary")!.documentId,
                expectedRevision: before.source.revision, reason: "stale-revision", contextFrom: 0, attemptedUnits: nativeAttempt.length }]);
            expect(await page.evaluate(() => window.hostFixture.recoveryText())).toBe(nativeAttempt);
            expect(JSON.stringify(after)).not.toContain("東京");
            const preview = page.locator('section[aria-label="Input recovery"] pre');
            await preview.evaluate(node => { node.dataset.retained = "input-recovery"; });
            await button("Inspect recovered input").click();
            await expect(preview).toHaveText(nativeAttempt); await expect(preview).toHaveAttribute("data-retained", "input-recovery");
        } else {
            expect(await source(page)).toBe(attempted); expect(after.source.dirty).toBe(true); expect(after.inputRecovery).toEqual([]);
            expect(after.history.undoDepth).toBe(before.history.undoDepth + 1);
            await primary.press("Control+z"); await waitForReview(page); expect(await source(page)).toBe(canonical); expect((await snapshot(page)).source.dirty).toBe(false);
            await primary.press("Control+Shift+z"); await waitForReview(page); expect(await source(page)).toBe(attempted);
        }
        const retained = await snapshot(page);
        await page.evaluate(() => window.hostFixture.unmount()); await page.evaluate(() => window.hostFixture.mount()); await waitForReview(page);
        const remounted = await snapshot(page);
        expect(await source(page)).toBe(reply === "canonical" ? canonical : attempted);
        expect(remounted.inputRecovery).toEqual(retained.inputRecovery);
        for (const id of ["primary", "secondary"]) expect(selection(remounted, id)).toEqual(selection(retained, id));
        // The new comparison controller has its own local epoch; reference identity/content persist.
        expect(remounted.bindings.comparison!.baseline!.version).toBe(retained.bindings.comparison!.baseline!.version);
        expect(remounted.bindings.comparison!.baseline!.length).toBe(original.length);
        expect(await page.evaluate(n => window.hostFixture.referenceRange(0, n), original.length)).toBe(original);
        if (reply === "canonical") {
            expect(await page.evaluate(() => window.hostFixture.recoveryText())).toBe(nativeAttempt);
            await primary.focus(); await primary.press("Control+End"); await primary.pressSequentially(" later"); await waitForReview(page);
            expect(await source(page)).toBe(canonical + " later");
            await primary.press("Control+z"); await waitForReview(page); expect(await source(page)).toBe(canonical); expect((await snapshot(page)).source.dirty).toBe(false);
            await primary.press("Control+Shift+z"); await waitForReview(page); expect(await source(page)).toBe(canonical + " later");
        }
        await page.evaluate(() => window.hostFixture.dispose()); const disposed = await snapshot(page);
        expect(disposed.diagnostics).toMatchObject({ views: 0, subscriptions: 0, leases: 0 }); expect(disposed.hostSubscriptions).toBe(0);
    });
