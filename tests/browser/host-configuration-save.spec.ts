import { ready, test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
import { hostTextEquals } from "../../scripts/host-scene.mjs";

const snapshot = (p: Page) => p.evaluate(() => window.hostFixture.snapshot());
const button = (p: Page, name: string) => p.getByRole("button", { name, exact: true });
const sets = (s: Awaited<ReturnType<typeof snapshot>>) => ({ views: s.bindings.views.map(v => ({ id: v.id, set: v.selectionSet })),
    working: s.bindings.comparison?.selectionSet, reference: s.bindings.comparison?.referenceViewport?.selectionSet });
async function waitForReview(page: Page): Promise<void> {
    await ready(page);
    await page.waitForFunction(() => { const s = window.hostFixture.snapshot(); return window.hostFixture.settled && (s.bindings.activeViews === 2 && s.bindings.comparison !== null); });
}
async function exact(p: Page, text: string) { expect(await hostTextEquals(p, text)).toBe(true); }

test(`plain configuration Save stays independent through typing, review, Run and remount`, async ({ page: p }, info) => {

    await p.goto(`/hosts/plain/`);
    const input = p.getByRole("textbox", { name: "Primary source", exact: true }), field = p.getByRole("textbox", { name: "Configuration path", exact: true });
    await expect(input).toBeVisible(); const original = "café😀\r\nrow two";
    await p.evaluate(value => { window.hostFixture.previewProposal(value); window.hostFixture.applyProposal(); }, original); await waitForReview(p);
    await p.evaluate(() => { const f = window.hostFixture, revision = f.snapshot().source.revision;
        for (const id of ["primary", "secondary", "comparison"] as const) if (!f.selectSourceSet(id, revision, [{ anchor: 4, head: 0 }, { anchor: 6, head: 6 }], 1)) throw new Error("Complete selection rejected"); }); await waitForReview(p);
    const prior = await snapshot(p), reference = await p.evaluate(() => { const f = window.hostFixture; return f.referenceRange(0, f.snapshot().bindings.comparison!.baseline!.length); }); await field.fill(" captured.csv ");
    await field.evaluate(node => { node.dataset.retained = "configuration-field"; });
    await button(p, "Finish configuration save").evaluate(node => { node.dataset.retained = "configuration-finish"; });
    for (const control of [input, field]) {
        await control.focus();
        const consumed = await control.evaluate(node => [
            { keyCode: 229 }, { modifierAltGraph: true }, { isComposing: true }, { repeat: true },
        ].map(detail => {
            const key = new KeyboardEvent("keydown", { key: "s", code: "KeyS", ctrlKey: true, bubbles: true, cancelable: true, ...detail });
            node.dispatchEvent(key); return key.defaultPrevented;
        }));
        expect(consumed).toEqual([false, false, false, true]);
    }
    expect((await snapshot(p)).pendingSaves).toEqual(prior.pendingSaves);
    expect((await snapshot(p)).configurationSave.pending).toBe(false); await field.press("Control+s");
    await expect(button(p, "Finish configuration save")).toBeEnabled(); const captured = await p.evaluate(() => window.hostFixture.configurationCapture());
    expect(captured).toMatchObject({ resourceId: prior.configuration.id, value: { path: " captured.csv ", format: "csv" }, expectedServerVersion: null });
    expect(sets(await snapshot(p))).toEqual(sets(prior)); expect((await snapshot(p)).history).toEqual(prior.history);
    await field.fill("later.csv"); await input.press("Control+End"); await input.pressSequentially("!"); await waitForReview(p); await exact(p, original + "!");
    await button(p, "Save source").click(); await expect.poll(async () => (await snapshot(p)).pendingSaves.length).toBe(1);
    await button(p, "Run captured inputs").click(); await expect.poll(async () => (await snapshot(p)).activity.pendingRuns).toBe(1);
    expect((await p.evaluate(() => window.hostFixture.runCapture(0)))?.configuration.path).toBe("later.csv");
    const edited = await snapshot(p); await button(p, "Finish configuration save").click();
    await expect.poll(async () => (await snapshot(p)).configuration.serverVersion).toBe("configuration-v1");
    expect((await snapshot(p)).configuration.dirty).toBe(true); await expect(field).toHaveValue("later.csv"); expect(sets(await snapshot(p))).toEqual(sets(edited)); expect((await snapshot(p)).history).toEqual(edited.history);
    await expect(field).toHaveAttribute("data-retained", "configuration-field");
    await expect(button(p, "Finish configuration save")).toHaveAttribute("data-retained", "configuration-finish");
    await expect(button(p, "Finish configuration save")).toBeDisabled();
    await input.press("Control+z"); await waitForReview(p); await exact(p, original); await input.press("Control+y"); await waitForReview(p); await exact(p, original + "!");
    await button(p, "Save configuration").click(); await expect(button(p, "Fail configuration save")).toBeEnabled();
    await button(p, "Fail configuration save").click(); await expect(p.getByLabel("Configuration save status", { exact: true })).toContainText("failed");
    await button(p, "Dismiss message").click(); await button(p, "Save configuration").click(); await expect(button(p, "Finish configuration save")).toBeEnabled();
    // Service work outlives views; remount keeps the captured resource and later form value.
    await p.evaluate(() => window.hostFixture.unmount());
    await p.evaluate(() => window.hostFixture.mount()); await waitForReview(p); await expect(field).toHaveValue("later.csv");
    await button(p, "Finish configuration save").click(); await expect.poll(async () => (await snapshot(p)).configuration.dirty).toBe(false);
    await field.fill("local.csv"); await button(p, "Simulate external configuration change").click(); await button(p, "Save configuration").click();
    await expect(button(p, "Finish configuration save")).toBeEnabled(); await button(p, "Finish configuration save").click();
    await expect(button(p, "Review remote configuration")).toBeEnabled(); await expect(button(p, "Save reviewed configuration")).toBeDisabled();
    await button(p, "Review remote configuration").click(); await expect(p.getByRole("region", { name: "Configuration save", exact: true }).locator("pre")).toContainText("remote.csv");
    await field.fill("merged.csv"); await button(p, "Save reviewed configuration").click(); await expect(button(p, "Finish configuration save")).toBeEnabled();
    await field.fill("newest.csv"); const beforeReceipt = await snapshot(p); await button(p, "Finish configuration save").click();
    await expect.poll(async () => (await snapshot(p)).configuration.serverVersion).toBe("configuration-v4"); await expect(field).toHaveValue("newest.csv");
    expect(sets(await snapshot(p))).toEqual(sets(beforeReceipt)); expect((await snapshot(p)).history).toEqual(beforeReceipt.history);
    await field.fill("   "); await expect(field).toHaveAttribute("aria-invalid", "true"); await expect(button(p, "Save configuration")).toBeDisabled();
    await button(p, "Run captured inputs").click(); expect((await snapshot(p)).activity.pendingRuns).toBe(1); await button(p, "Dismiss message").click();
    await button(p, "Finish save").click(); await button(p, "Finish run").click(); await expect.poll(async () => (await snapshot(p)).activity.pendingRuns).toBe(0);
    await field.fill(" final.csv "); await field.press("Control+s"); await expect(button(p, "Finish configuration save")).toBeEnabled(); await button(p, "Finish configuration save").click();
    await expect(field).toHaveValue("final.csv"); await expect.poll(async () => (await snapshot(p)).configuration.dirty).toBe(false); await exact(p, original + "!");
    expect(await p.evaluate(value => window.hostFixture.referenceRange(0, value.length) === value, reference!)).toBe(true);
    const baseline = prior.bindings.comparison!.baseline!;
    expect((await snapshot(p)).bindings.comparison!.baseline).toMatchObject({ version: baseline.version, length: baseline.length });
    await info.attach("configuration-save", { body: await p.screenshot(), contentType: "image/png" });
    await p.evaluate(() => window.hostFixture.dispose());
});
