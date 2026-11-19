import { ready, test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";

const snapshot = (page: Page) => page.evaluate(() => window.hostFixture.snapshot());
const text = (page: Page) => page.evaluate(() => { const f = window.hostFixture; return f.range(0, f.snapshot().source.length); });
const selections = (state: Awaited<ReturnType<typeof snapshot>>) => ({
    source: state.bindings.views.map(v => ({ id: v.id, selection: v.selection })), comparison: state.bindings.comparison?.selection,
});
async function waitForSavedViews(page: Page): Promise<void> {
    await ready(page);
    await page.waitForFunction(() => {
        const f = window.hostFixture, s = f.snapshot(), c = s.bindings.comparison;
        const raw = s.bindings.views.some(v => v.metrics === null) ? f.range(0, s.source.length) : "";
        const domText = (value: string) => value.replace(/\r\n?/g, "\n");
        return window.hostFixture.settled && (s.bindings.activeViews === 2 && s.bindings.views.every(v => {
            if (v.metrics) return true;
            const label = v.id === "primary" ? "Primary source" : "Secondary source";
            const node = document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`);
            const anchor = domText(raw.slice(0, v.selection.anchor)).length, head = domText(raw.slice(0, v.selection.head)).length;
            return node?.value === domText(raw) && node.selectionStart === Math.min(anchor, head) && node.selectionEnd === Math.max(anchor, head)
                && (node.selectionDirection === "backward") === (anchor > head);
        }) && c !== null && [...document.querySelectorAll(".st-comparison h3")].some(h => h.textContent === `Baseline · ${c.baseline?.version}`));
    });
}

for (const editor of ["native", "candidate"] as const) for (const mode of ["plain", "react"] as const) {
    test.describe(`${mode} ${editor} save failure pilot`, () => {
        test.beforeEach(async ({ page }, testInfo) => {

            if (testInfo.annotations.some(annotation => annotation.type === "native-projection-cache")) {
                await page.addInitScript(() => {
                // Optional projections can be reclaimed between browser tasks. Make
                // that cache boundary deterministic while retaining native weak references.
                const NativeWeakRef = WeakRef;
                Object.defineProperty(globalThis, "WeakRef", { value: class<T extends object> extends NativeWeakRef<T> {
                    expired = false;
                    constructor(value: T) { super(value); queueMicrotask(() => { this.expired = true; }); }
                    override deref(): T | undefined { return this.expired ? undefined : super.deref(); }
                } });
                });
            }
            await page.goto(`/hosts/${mode}/?editor=${editor}`);
            await expect(page.getByRole("textbox", { name: "Primary source", exact: true })).toBeVisible();
        });
        for (const corpus of editor === "candidate" ? ["normal", "lines-100000"] : ["normal"]) {
            test(`${corpus} typing, shared history and review survive a failed save, remounted retry`, {
                annotation: editor === "native" ? [{ type: "native-projection-cache", description: "Optional whole-value projection cache evicted between tasks; native exports are diagnostic and candidate zero-export gates remain strict." }] : [],
            }, async ({ page }) => {
                const button = (name: string) => page.getByRole("button", { name, exact: true });
                const primary = page.getByRole("textbox", { name: "Primary source", exact: true });
                const working = page.getByRole("textbox", { name: "Comparison working source", exact: true });
                const original = corpus === "normal" ? "proposal é 😀\r\nrow two" : Array(100000).fill("const sample = 1234567;").join("\r\n");
                await page.evaluate(value => { window.hostFixture.previewProposal(value); window.hostFixture.applyProposal(); }, original); await waitForSavedViews(page);
                await working.press("Control+Home"); await working.press("Shift+ArrowRight"); await working.press("Shift+ArrowRight");
                await primary.press("Control+End"); await primary.pressSequentially(" corrected");
                const corrected = original + " corrected";
                expect(await page.evaluate(() => { const f = window.hostFixture; return f.selectSource("secondary", f.snapshot().source.revision, { anchor: 4, head: 1 }); })).toBe(true);
                await button("Save source").click(); await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
                await primary.press("Control+End"); await primary.pressSequentially(" later"); await waitForSavedViews(page);
                await primary.evaluate(node => { node.dataset.failureRetained = "yes"; });
                const later = corrected + " later", before = await snapshot(page);
                expect(await text(page)).toBe(later); if (editor === "candidate") expect(before.source.exports).toBe(0);
                await page.evaluate(() => window.hostFixture.failSave());
                await expect.poll(async () => (await snapshot(page)).source.saveStatus).toBe("failed");
                await expect.poll(async () => (await snapshot(page)).pendingCommands).toBe(0);
                await expect(page.getByRole("status", { name: "Host messages", exact: true })).toContainText("Your document is retained");
                await expect(primary).toBeFocused(); await expect(primary).toHaveAttribute("data-failure-retained", "yes");
                const failed = await snapshot(page);
                expect(await text(page)).toBe(later); expect(failed.source.revision).toBe(before.source.revision);
                expect(selections(failed)).toEqual(selections(before)); expect(failed.history).toEqual(before.history);
                expect(failed.server).toEqual(before.server);
                expect(failed.bindings.comparison!.baseline).toEqual(before.bindings.comparison!.baseline);
                expect(failed.comparisonReference).toEqual(before.comparisonReference);
                expect(failed.diagnostics.leases).toBe(before.diagnostics.leases - 1);
                expect(failed.source).toMatchObject({ serverVersion: "v0", dirty: true });
                if (editor === "candidate") expect(failed.source.exports).toBe(0); else expect(failed.source.exports).toBeGreaterThan(0);
                expect(failed.activity).toMatchObject({ writes: 0, errors: 1 });
                await button("Dismiss message").click(); await button("Save source").click();
                await expect.poll(async () => (await snapshot(page)).pendingSaves).toEqual([
                    { revision: failed.source.revision, length: later.length, expectedServerVersion: "v0" },
                ]);
                await primary.press("Control+End"); await primary.pressSequentially(" newest"); await waitForSavedViews(page);
                const newest = later + " newest", retained = selections(await snapshot(page));
                await page.evaluate(() => window.hostFixture.unmount()); await page.evaluate(() => window.hostFixture.mount()); await waitForSavedViews(page);
                expect(selections(await snapshot(page))).toEqual(retained); await primary.focus();
                await page.evaluate(() => window.hostFixture.finishSave());
                await expect.poll(async () => (await snapshot(page)).source.serverVersion).toBe("v1");
                await expect.poll(async () => (await snapshot(page)).pendingCommands).toBe(0);
                await expect(primary).toBeFocused(); expect(await text(page)).toBe(newest);
                const saved = await snapshot(page); expect(saved.source.dirty).toBe(true);
                expect(saved.activity).toMatchObject({ writes: 1, lastSavedRevision: failed.source.revision });
                await primary.press("Control+z"); await waitForSavedViews(page); expect(await text(page)).toBe(later); expect((await snapshot(page)).source.dirty).toBe(false);
                await primary.press("Control+Shift+z"); await waitForSavedViews(page); expect(await text(page)).toBe(newest); expect((await snapshot(page)).source.dirty).toBe(true);
                await button("Capture reference refresh").click(); await button("Finish reference refresh").click(); await waitForSavedViews(page);
                await expect(page.getByRole("heading", { name: "Baseline · reference:saved-v1", exact: true })).toBeVisible();
                expect(await page.evaluate(length => window.hostFixture.referenceRange(0, length), later.length)).toBe(later);
                expect((await snapshot(page)).bindings.comparison!.baseline!.length).toBe(later.length);
                const final = await snapshot(page); expect(final.activity.writes).toBe(1);
                if (editor === "candidate") expect(final.source.exports).toBe(0); else expect(final.source.exports).toBeGreaterThan(0);
                expect(await text(page)).toBe(newest);
                expect(final.activity.background).toBeGreaterThan(before.activity.background);
                if (editor === "candidate") {
                    expect(final.bindings.views.every(v => v.metrics!.inputUnits <= 2600 && v.metrics!.viewport.rows < 100 && v.metrics!.viewport.readUnits < 20000)).toBe(true);
                    expect(final.bindings.comparison!.input.inputUnits).toBeLessThanOrEqual(2600);
                    expect(final.bindings.comparison!.workingViewport.rows).toBeLessThan(100);
                    expect(final.bindings.comparison!.workingViewport.readUnits).toBeLessThan(20000);
                    expect(final.bindings.comparison!.referenceViewport!.rows).toBeLessThan(100);
                    expect(final.bindings.comparison!.referenceViewport!.readUnits).toBeLessThan(20000);
                }
                await page.evaluate(() => window.hostFixture.dispose()); const stopped = await snapshot(page);
                expect(stopped.diagnostics).toMatchObject({ views: 0, subscriptions: 0, leases: 0 }); expect(stopped.hostSubscriptions).toBe(0);
            });
        }
        test("queued captures retain corrections through failure, tab replacement and disposal of a late rejection", async ({ page }) => {
            const button = (name: string) => page.getByRole("button", { name, exact: true });
            const primary = page.getByRole("textbox", { name: "Primary source", exact: true });
            await button("Open source review").click(); await waitForSavedViews(page);
            await primary.press("Control+End"); await primary.pressSequentially(" first");
            await button("Save source").click(); await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
            await primary.press("Control+End"); await primary.pressSequentially(" second");
            const second = await snapshot(page); await button("Save source").click();
            await primary.press("Control+End"); await primary.pressSequentially(" retained"); await waitForSavedViews(page);
            const retained = await snapshot(page); await button("Fail save").click();
            await expect.poll(async () => (await snapshot(page)).pendingSaves).toEqual([
                { revision: second.source.revision, length: second.source.length, expectedServerVersion: "v0" },
            ]);
            expect(await text(page)).toBe("start first second retained"); expect((await snapshot(page)).history).toEqual(retained.history);
            await button("Move primary view").click(); await button("Replace primary panel").click();
            await page.evaluate(() => window.hostFixture.failSave()); await expect.poll(async () => (await snapshot(page)).pendingCommands).toBe(0);
            expect((await snapshot(page)).source).toMatchObject({ serverVersion: "v0", dirty: true, saveStatus: "failed" });
            await button("Reopen primary source").click(); await expect(primary).toBeVisible();
            expect(await text(page)).toBe("start first second retained");
            await button("Save source").click(); await expect.poll(async () => (await snapshot(page)).pendingSaves.length).toBe(1);
            await button("Save source").click();
            await page.evaluate(() => { window.hostFixture.failSave(); return window.hostFixture.dispose(); });
            const stopped = await snapshot(page); expect(stopped.pendingCommands).toBe(0); expect(stopped.pendingSaves).toEqual([]);
            expect(stopped.diagnostics).toMatchObject({ views: 0, subscriptions: 0, leases: 0 }); expect(stopped.hostSubscriptions).toBe(0);
            expect(stopped.activity.writes).toBe(0); expect(await text(page)).toBe("start first second retained");
            await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
            await page.evaluate(() => { window.hostFixture.failSave(); window.hostFixture.finishSave(); });
            expect(await snapshot(page)).toEqual(stopped);
        });
    });
}
