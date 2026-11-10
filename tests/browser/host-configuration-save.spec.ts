import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

const snapshot = (p: Page) => p.evaluate(() => window.hostFixture.snapshot());
const button = (p: Page, name: string) => p.getByRole("button", { name, exact: true });
const sets = (s: Awaited<ReturnType<typeof snapshot>>) => ({ views: s.bindings.views.map(v => ({ id: v.id, set: v.selectionSet })),
    working: s.bindings.comparison?.selectionSet, reference: s.bindings.comparison?.referenceViewport?.selectionSet });
async function ready(p: Page) { await p.waitForFunction(() => { const s = window.hostFixture.snapshot(), c = s.bindings.comparison;
    return s.bindings.activeViews === 2 && s.bindings.views.every(v => v.metrics && !v.metrics.pendingInput && !v.metrics.pendingCommand && !v.metrics.pendingCaret && !v.metrics.viewport.pending)
        && c?.status === "ready" && c.workingRevision === s.source.revision && !c.input.pendingInput && !c.input.pendingCaret && !c.workingViewport.pending && !c.referenceViewport?.pending; }); }
async function exact(p: Page, text: string) { expect(await p.evaluate(text => { const f = window.hostFixture;
    if (f.snapshot().source.length !== text.length) return false;
    for (let i = 0; i < text.length; i += 32768) if (f.range(i, Math.min(text.length, i + 32768)) !== text.slice(i, i + 32768)) return false; return true;
}, text)).toBe(true); }

for (const host of ["plain", "react"]) for (const large of [false, true]) test(`${host} ${large ? "100k" : "normal"} configuration Save stays independent through typing, review, Run and remount`, async ({ page: p }, info) => {
    const errors: string[] = []; p.on("pageerror", e => errors.push(e.message));
    await p.goto(`/hosts/${host}/?editor=candidate`);
    const input = p.getByRole("textbox", { name: "Primary source", exact: true }), field = p.getByRole("textbox", { name: "Configuration path", exact: true });
    await expect(input).toBeVisible(); const original = large ? Array(100000).fill("const café = 1234567;😀").join("\r\n") : "café😀\r\nrow two";
    await button(p, "Associate agent").click(); await button(p, "Request proposal").click(); await p.evaluate(value => window.hostFixture.deliverProposal(value), original); await ready(p);
    await p.evaluate(() => { const f = window.hostFixture, revision = f.snapshot().source.revision;
        for (const id of ["primary", "secondary", "comparison"] as const) if (!f.selectSourceSet(id, revision, [{ anchor: 4, head: 0 }, { anchor: 6, head: 6 }], 1)) throw new Error("Complete selection rejected"); }); await ready(p);
    const prior = await snapshot(p), reference = await p.evaluate(() => { const f = window.hostFixture; return f.referenceRange(0, f.snapshot().bindings.comparison!.baseline!.length); }); await field.fill(" captured.csv ");
    // Composition/repeat shortcuts consume the browser Save key without starting a resource write.
    await field.dispatchEvent("keydown", { key: "s", ctrlKey: true, isComposing: true }); await field.dispatchEvent("keydown", { key: "s", ctrlKey: true, repeat: true });
    expect((await snapshot(p)).configurationSave.pending).toBe(false); await field.press("Control+s");
    await expect(button(p, "Finish configuration save")).toBeEnabled(); const captured = await p.evaluate(() => window.hostFixture.configurationCapture());
    expect(captured).toMatchObject({ resourceId: prior.configuration.id, value: { path: " captured.csv ", format: "csv" }, expectedServerVersion: null });
    expect(sets(await snapshot(p))).toEqual(sets(prior)); expect((await snapshot(p)).history).toEqual(prior.history);
    await field.fill("later.csv"); await input.press("Control+End"); await input.pressSequentially("!"); await ready(p); await exact(p, original + "!");
    await button(p, "Save source").click(); await expect.poll(async () => (await snapshot(p)).pendingSaves.length).toBe(1);
    await button(p, "Run captured inputs").click(); await expect.poll(async () => (await snapshot(p)).activity.pendingRuns).toBe(1);
    expect((await p.evaluate(() => window.hostFixture.runCapture(0)))?.configuration.path).toBe("later.csv");
    const edited = await snapshot(p); await button(p, "Finish configuration save").click();
    await expect.poll(async () => (await snapshot(p)).configuration.serverVersion).toBe("configuration-v1");
    expect((await snapshot(p)).configuration.dirty).toBe(true); await expect(field).toHaveValue("later.csv"); expect(sets(await snapshot(p))).toEqual(sets(edited)); expect((await snapshot(p)).history).toEqual(edited.history);
    await input.press("Control+z"); await ready(p); await exact(p, original); await input.press("Control+y"); await ready(p); await exact(p, original + "!");
    await button(p, "Save configuration").click(); await expect(button(p, "Fail configuration save")).toBeEnabled();
    await button(p, "Fail configuration save").click(); await expect(p.getByLabel("Configuration save status", { exact: true })).toContainText("failed");
    await button(p, "Dismiss message").click(); await button(p, "Save configuration").click(); await expect(button(p, "Finish configuration save")).toBeEnabled();
    // Service work outlives views; remount keeps the captured resource and later form value.
    await p.evaluate(() => window.hostFixture.unmount()); const dormant = await snapshot(p); expect(dormant.diagnostics.subscriptions).toBe(4); expect(dormant.hostSubscriptions).toBe(1);
    await p.evaluate(() => window.hostFixture.mount()); await ready(p); await expect(field).toHaveValue("later.csv");
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
    // Saved proposal receipts intentionally survive detach; finish their independent acknowledgement.
    await expect.poll(async () => (await snapshot(p)).review.acknowledgements.length).toBe(1);
    await button(p, "Retry acknowledgement").click(); await expect.poll(async () => (await snapshot(p)).review.acknowledgements[0]?.status).toBe("failed");
    await button(p, "Retry acknowledgement").click(); await expect.poll(async () => (await snapshot(p)).review.acknowledgements.length).toBe(0);
    await field.fill(" final.csv "); await field.press("Control+s"); await expect(button(p, "Finish configuration save")).toBeEnabled(); await button(p, "Finish configuration save").click();
    await expect(field).toHaveValue("final.csv"); await expect.poll(async () => (await snapshot(p)).configuration.dirty).toBe(false); await exact(p, original + "!");
    expect(await p.evaluate(value => window.hostFixture.referenceRange(0, value.length) === value, reference!)).toBe(true);
    expect((await snapshot(p)).bindings.comparison!.baseline).toEqual(prior.bindings.comparison!.baseline);
    if (!large) await info.attach("configuration-save", { body: await p.screenshot(), contentType: "image/png" });
    await p.evaluate(() => window.hostFixture.dispose()); const stopped = await snapshot(p); expect(stopped.diagnostics).toMatchObject({ views: 0, subscriptions: 0, leases: 0 }); expect(stopped.hostSubscriptions).toBe(0);
    expect(errors).toEqual([]);
});
