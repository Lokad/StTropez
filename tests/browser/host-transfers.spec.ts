import { ready, test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
import { hostTextEquals } from "../../scripts/host-scene.mjs";
const snapshot = (p: Page) => p.evaluate(() => window.hostFixture.snapshot());
const button = (p: Page, name: string) => p.getByRole("button", { name, exact: true });
const sets = (s: Awaited<ReturnType<typeof snapshot>>) => ({ views: s.bindings.views.map(v => ({ id: v.id, set: v.selectionSet })), working: s.bindings.comparison?.selectionSet, reference: s.bindings.comparison?.referenceViewport?.selectionSet });
async function waitForReview(page: Page): Promise<void> {
    await ready(page);
    await page.waitForFunction(() => { const s = window.hostFixture.snapshot(); return window.hostFixture.settled && s.bindings.comparison !== null; });
}
async function exact(p: Page, text: string) { expect(await hostTextEquals(p, text)).toBe(true); }

test(`plain transfer settings and immutable Run/log inspection retain independent inputs`, async ({ page: p }) => {
      await p.goto(`/hosts/plain/`);
    const input = p.getByRole("textbox", { name: "Primary source", exact: true }), destination = p.getByRole("textbox", { name: "Transfer destination", exact: true }), batch = p.getByRole("textbox", { name: "Transfer batch size", exact: true }), path = p.getByRole("textbox", { name: "Configuration path", exact: true });
    await expect(input).toBeVisible(); await button(p, "Open source review").click(); const original = "café😀\r\nrow two";
    await p.evaluate(text => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]); }, original);
    await button(p, "Capture review acceptance").click(); await button(p, "Finish review acceptance").click(); await waitForReview(p);
    await destination.fill(" captured.csv "); await batch.fill("1e"); await expect(button(p, "Save transfer settings")).toBeDisabled(); await batch.press("Control+s"); await button(p, "Run captured inputs").click();
    expect((await snapshot(p)).activity.pendingRuns).toBe(0); await expect(batch).toHaveValue("1e"); await button(p, "Dismiss message").click(); await batch.fill("2000"); await batch.press("Control+s");
    await expect(button(p, "Finish transfer settings save")).toBeEnabled(); const transferCapture = await p.evaluate(() => window.hostFixture.transferCapture()); expect(transferCapture?.value.destination).toBe(" captured.csv ");
    await destination.evaluate(node => { node.dataset.retained = "transfer-field"; });
    await button(p, "Finish transfer settings save").evaluate(node => { node.dataset.retained = "transfer-finish"; });
    await button(p, "Run captured inputs").click(); await expect.poll(async () => (await snapshot(p)).runResources.runs.length).toBe(1); const first = (await snapshot(p)).runResources.runs[0]!;
    await button(p, "Advance Run 1 progress").evaluate(node => { node.dataset.retained = "run-progress"; });
    await button(p, "Inspect Run 1 log 1").evaluate(node => { node.dataset.retained = "run-log"; });
    const firstInput = await p.evaluate(id => window.hostFixture.runInput(id), first.id); expect(firstInput?.transfer.value).toMatchObject({ destination: " captured.csv ", batchSize: "2000" }); expect(firstInput?.source.value).toBe(original);
    await destination.fill("newer.csv"); await path.fill("connection-later.csv"); await input.press("Control+End"); await input.pressSequentially("!"); await waitForReview(p); await exact(p, original + "!");
    const edited = await snapshot(p), progress = button(p, "Advance Run 1 progress"); await progress.focus(); await progress.press("Enter"); await expect(progress).toBeFocused(); await button(p, "Inspect Run 1").click(); await waitForReview(p);
    const inspector = p.getByRole("region", { name: "Resource inspection", exact: true }); await expect(inspector).toContainText("captured.csv"); await expect(inspector.locator("pre")).toHaveText(original.slice(0, 512));
    await button(p, "Inspect current source").evaluate(node => { node.dataset.retained = "inspection-link"; });
    await button(p, "Refresh resource inspection").click();
    await expect(button(p, "Inspect current source")).toHaveAttribute("data-retained", "inspection-link");
    expect(sets(await snapshot(p))).toEqual(sets(edited)); expect((await snapshot(p)).history).toEqual(edited.history);
    await button(p, "Inspect Run 1 log 2").click(); await expect(inspector).toContainText("30%"); await button(p, "Inspect captured Run").click(); await expect(inspector).toContainText("captured.csv");
    await button(p, "Finish transfer settings save").click(); await expect.poll(async () => (await snapshot(p)).transfer.serverVersion).toBe("transfer-v1"); await expect(destination).toHaveValue("newer.csv"); expect((await snapshot(p)).transfer.dirty).toBe(true);
    await expect(destination).toHaveAttribute("data-retained", "transfer-field");
    await expect(button(p, "Finish transfer settings save")).toHaveAttribute("data-retained", "transfer-finish");
    await expect(button(p, "Finish transfer settings save")).toBeDisabled();
    await button(p, "Inspect current configuration").click(); await expect(inspector.locator("pre")).toContainText("connection-later.csv");
    await path.fill("refresh-only.csv"); await expect(inspector.locator("pre")).toContainText("connection-later.csv");
    await button(p, "Refresh resource inspection").click(); await expect(inspector.locator("pre")).toContainText("refresh-only.csv");
    await button(p, "Run captured inputs").click(); await expect.poll(async () => (await snapshot(p)).runResources.runs.length).toBe(2); await button(p, "Inspect Run 2").click(); const second = (await snapshot(p)).runResources.runs[1]!;
    await button(p, "Finish run").click(); await expect.poll(async () => (await snapshot(p)).runResources.runs[0]?.status).toBe("completed"); expect((await snapshot(p)).runResources.selected).toBe(second.id); await expect(inspector).toContainText("newer.csv");
    await expect(button(p, "Advance Run 1 progress")).toHaveAttribute("data-retained", "run-progress");
    await expect(button(p, "Advance Run 1 progress")).toBeDisabled();
    await expect(button(p, "Inspect Run 1 log 1")).toHaveAttribute("data-retained", "run-log");
    await p.evaluate(() => window.hostFixture.dispose());
    expect((await snapshot(p)).runResources.runs.map(run => run.status)).toEqual(["completed", "interrupted"]);
});
