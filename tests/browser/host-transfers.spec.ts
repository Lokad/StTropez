import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
const snapshot = (p: Page) => p.evaluate(() => window.hostFixture.snapshot());
const button = (p: Page, name: string) => p.getByRole("button", { name, exact: true });
const sets = (s: Awaited<ReturnType<typeof snapshot>>) => ({ views: s.bindings.views.map(v => ({ id: v.id, set: v.selectionSet })), working: s.bindings.comparison?.selectionSet, reference: s.bindings.comparison?.referenceViewport?.selectionSet });
async function ready(p: Page) { await p.waitForFunction(() => { const s = window.hostFixture.snapshot(), c = s.bindings.comparison;
    return !s.draft?.busy && s.bindings.views.every(v => v.metrics && !v.metrics.pendingInput && !v.metrics.pendingCommand && !v.metrics.pendingCaret && !v.metrics.viewport.pending)
        && c?.status === "ready" && c.workingRevision === s.source.revision && !c.input.pendingInput && !c.input.pendingCaret && !c.workingViewport.pending && !c.referenceViewport?.pending; }); }
async function exact(p: Page, text: string) { expect(await p.evaluate(text => { const f = window.hostFixture; if (f.snapshot().source.length !== text.length) return false;
    for (let i = 0; i < text.length; i += 32768) if (f.range(i, Math.min(text.length, i + 32768)) !== text.slice(i, i + 32768)) return false; return true; }, text)).toBe(true); }
async function draftAction(p: Page, name: string) { await button(p, name).click(); await expect(button(p, "Confirm draft action")).toBeEnabled(); await button(p, "Confirm draft action").click(); await ready(p); }

for (const host of ["plain", "react"]) for (const large of [false, true]) test(`${host} ${large ? "100k" : "normal"} transfer settings and immutable Run/log inspection retain independent inputs`, async ({ page: p }, info) => {
    const errors: string[] = []; p.on("pageerror", e => errors.push(e.message)); await p.goto(`/hosts/${host}/?editor=candidate`);
    const input = p.getByRole("textbox", { name: "Primary source", exact: true }), destination = p.getByRole("textbox", { name: "Transfer destination", exact: true }), batch = p.getByRole("textbox", { name: "Transfer batch size", exact: true }), path = p.getByRole("textbox", { name: "Configuration path", exact: true });
    await expect(input).toBeVisible(); await button(p, "Open source review").click(); const original = large ? "const café = '😀';\r\n".repeat(100000) + "tail" : "café😀\r\nrow two";
    await p.evaluate(text => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]); }, original);
    await button(p, "Capture review acceptance").click(); await button(p, "Finish review acceptance").click(); await ready(p);
    await destination.fill(" captured.csv "); await batch.fill("1e"); await expect(button(p, "Save transfer settings")).toBeDisabled(); await batch.press("Control+s"); await button(p, "Run captured inputs").click();
    expect((await snapshot(p)).activity.pendingRuns).toBe(0); await expect(batch).toHaveValue("1e"); await button(p, "Dismiss message").click(); await batch.fill("2000"); await batch.press("Control+s");
    await expect(button(p, "Finish transfer settings save")).toBeEnabled(); const transferCapture = await p.evaluate(() => window.hostFixture.transferCapture()); expect(transferCapture?.value.destination).toBe(" captured.csv ");
    await button(p, "Run captured inputs").click(); await expect.poll(async () => (await snapshot(p)).runResources.runs.length).toBe(1); const first = (await snapshot(p)).runResources.runs[0]!;
    const firstInput = await p.evaluate(id => window.hostFixture.runInput(id), first.id); expect(firstInput?.transfer.value).toMatchObject({ destination: " captured.csv ", batchSize: "2000" }); expect(firstInput?.source.value).toBe(original);
    await destination.fill("newer.csv"); await path.fill("connection-later.csv"); await input.press("Control+End"); await input.pressSequentially("!"); await ready(p); await exact(p, original + "!");
    const edited = await snapshot(p), progress = button(p, "Advance Run 1 progress"); await progress.focus(); await progress.press("Enter"); await expect(progress).toBeFocused(); await button(p, "Inspect Run 1").click(); await ready(p);
    const inspector = p.getByRole("region", { name: "Resource inspection", exact: true }); await expect(inspector).toContainText("captured.csv"); await expect(inspector.locator("pre")).toHaveText(original.slice(0, 512));
    expect(sets(await snapshot(p))).toEqual(sets(edited)); expect((await snapshot(p)).history).toEqual(edited.history); expect((await snapshot(p)).source.exports).toBe(edited.source.exports);
    await button(p, "Inspect Run 1 log 2").click(); await expect(inspector).toContainText("30%"); await button(p, "Inspect captured Run").click(); await expect(inspector).toContainText("captured.csv");
    await button(p, "Finish transfer settings save").click(); await expect.poll(async () => (await snapshot(p)).transfer.serverVersion).toBe("transfer-v1"); await expect(destination).toHaveValue("newer.csv"); expect((await snapshot(p)).transfer.dirty).toBe(true);
    await button(p, "Run captured inputs").click(); await expect.poll(async () => (await snapshot(p)).runResources.runs.length).toBe(2); await button(p, "Inspect Run 2").click(); const second = (await snapshot(p)).runResources.runs[1]!;
    await button(p, "Finish run").click(); await expect.poll(async () => (await snapshot(p)).runResources.runs[0]?.status).toBe("completed"); expect((await snapshot(p)).runResources.selected).toBe(second.id); await expect(inspector).toContainText("newer.csv");
    await input.press("Control+z"); await ready(p); await exact(p, original); await input.press("Control+y"); await ready(p); await exact(p, original + "!");
    await button(p, "Fail run").click(); await expect.poll(async () => (await snapshot(p)).runResources.runs[1]?.status).toBe("failed"); await button(p, "Dismiss message").click();
    await button(p, "Save transfer settings").click(); await expect(button(p, "Fail transfer settings save")).toBeEnabled(); await button(p, "Fail transfer settings save").click(); await expect(p.getByLabel("Transfer save status", { exact: true })).toContainText("failed"); await button(p, "Dismiss message").click();
    await batch.fill("invalid"); await button(p, "Keep recovery draft").click(); await ready(p); expect((await snapshot(p)).draft?.hasTransfer).toBe(true); await p.reload(); await expect(input).toBeVisible(); await button(p, "Open source review").click(); await ready(p);
    await draftAction(p, "Restore transfer draft"); await expect(destination).toHaveValue("newer.csv"); await expect(batch).toHaveValue("invalid"); await expect(path).toHaveValue("source.csv"); await exact(p, "start");
    await draftAction(p, "Restore source draft"); await exact(p, original + "!"); await batch.fill("100"); await destination.fill(" final.csv "); await destination.press("Control+s"); await expect(button(p, "Finish transfer settings save")).toBeEnabled();
    await p.evaluate(() => window.hostFixture.unmount()); const dormant = await snapshot(p); expect(dormant.diagnostics.subscriptions).toBe(4); expect(dormant.hostSubscriptions).toBe(1);
    await p.evaluate(() => window.hostFixture.mount()); await ready(p); await button(p, "Finish transfer settings save").click(); await expect(destination).toHaveValue("final.csv");
    await button(p, "Run captured inputs").click(); await expect.poll(async () => (await snapshot(p)).runResources.runs.length).toBe(1); await button(p, "Inspect Run 1").click();
    if (!large) await info.attach("transfer-run-inspection", { body: await p.screenshot(), contentType: "image/png" });
    await p.evaluate(() => window.hostFixture.dispose()); const stopped = await snapshot(p); expect(stopped.runResources.runs[0]?.status).toBe("interrupted"); expect(stopped.diagnostics).toMatchObject({ views: 0, subscriptions: 0, leases: 0 }); expect(stopped.hostSubscriptions).toBe(0); expect(errors).toEqual([]);
});
