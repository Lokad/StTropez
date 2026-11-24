import { ready, test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
import { hostTextEquals } from "../../scripts/host-scene.mjs";
const snap = (p: Page) => p.evaluate(() => window.hostFixture.snapshot());
const command = (p: Page, name: string) => p.getByRole("button", { name, exact: true }).click();
const primary = (p: Page) => p.getByRole("textbox", { name: "Primary source", exact: true });
const selections = (s: Awaited<ReturnType<typeof snap>>) => Object.fromEntries(s.bindings.views.map(v => [v.id, v.selectionSet]));
async function waitForLoad(page: Page): Promise<void> {
    await ready(page);
    await page.waitForFunction(() => { const s = window.hostFixture.snapshot(); return window.hostFixture.settled && (!s.bindings.instruction?.pending && s.bindings.views.length === 2); });
}
async function exact(p: Page, text: string) { expect(await hostTextEquals(p, text)).toBe(true); }
test.afterEach(async ({ page }, info) => { if (info.status !== info.expectedStatus && !page.isClosed()) await info.attach("load-failure-state", { contentType: "application/json", body: JSON.stringify(await snap(page), null, 2) }); });
test(`plain repeated loads release clean documents and preserve reachable drafts`, async ({ page: p }) => {
      await p.goto(`/hosts/plain/`); await expect(primary(p)).toBeVisible();
    const original = '// @transfer {"destination":"target.csv","batchSize":"1000"}\r\n' + "row café😀\r\n".repeat(8);
    await p.evaluate(text => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]); }, original);
    await primary(p).press("Control+End"); await primary(p).pressSequentially("X"); await command(p, "Save source"); await command(p, "Run captured inputs");
    await expect.poll(async () => (await snap(p)).pendingRuns.length).toBe(1); await expect.poll(async () => (await snap(p)).pendingSaves.length).toBe(1);
    await p.evaluate(() => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: 0, insert: "// later\r\n" }]); }); const text = "// later\r\n" + original + "X";
    const field = p.getByRole("textbox", { name: "Instruction destination", exact: true });
    await primary(p).press("Control+Home"); await primary(p).press("ArrowDown"); await command(p, "Anchor instruction at caret"); await expect(field).toBeVisible(); await field.evaluate(node => (node as HTMLTextAreaElement).setSelectionRange(1, 4, "backward"));
    await waitForLoad(p); const before = await snap(p), owned = ({ subscriptions: _subscriptions, ...rest }: typeof before.diagnostics) => rest;
    let steadySubscriptions: number | undefined;
    const restored = async () => {
        await expect.poll(async () => owned((await snap(p)).diagnostics)).toEqual(owned(before.diagnostics));
        const count = (await snap(p)).diagnostics.subscriptions; expect(count).toBeLessThanOrEqual(before.diagnostics.subscriptions);
        steadySubscriptions ??= count; expect(count).toBe(steadySubscriptions);
    };
    for (let i = 0; i < 6; i++) {
        await command(p, "Begin delayed load"); await expect(primary(p)).toHaveCount(0);
        if (i % 2 === 0) { await command(p, "Reopen primary source"); await command(p, "Finish delayed load"); }
        else { await command(p, "Finish delayed load"); await expect(primary(p)).toBeVisible(); await command(p, "Reopen primary source"); }
        await waitForLoad(p); await restored();
        const after = await snap(p); expect(after.pendingSaves).toEqual(before.pendingSaves); expect(after.pendingRuns).toEqual(before.pendingRuns); expect(after.history).toEqual(before.history);
        expect(selections(after)).toEqual(selections(before)); expect(after.source.revision).toBe(before.source.revision);
        await expect(field).toHaveValue("target.csv"); expect(await field.evaluate(node => { const f = node as HTMLTextAreaElement; return [f.selectionStart, f.selectionEnd, f.selectionDirection]; })).toEqual([1, 4, "backward"]); expect(after.bindings.views.every(v => v.metrics.viewport.rows < 100)).toBe(true);
    }
    await exact(p, text); await command(p, "Begin delayed load"); await command(p, "Finish delayed load"); await expect(primary(p)).toBeVisible(); await primary(p).press("Control+End"); await primary(p).pressSequentially(" draft café😀"); await primary(p).press("Shift+Home"); await waitForLoad(p);
    const loaded = (await snap(p)).bindings.views.find(v => v.id === "primary")!;
    await command(p, "Reopen primary source"); await waitForLoad(p); await exact(p, text); await command(p, "Begin delayed load"); expect((await snap(p)).loadPending).toBe(false);
    await expect(p.getByRole("status", { name: "Host messages", exact: true })).toContainText("unsaved changes"); await command(p, "Dismiss message");
    await command(p, "Reopen loaded source"); await waitForLoad(p); expect((await snap(p)).bindings.views.find(v => v.id === "primary")?.selectionSet).toEqual(loaded.selectionSet);
    expect(await p.evaluate(id => window.hostFixture.navigationDocument(id).text, loaded.documentId)).toBe("loaded resource draft café😀");
    await command(p, "Reopen primary source"); await command(p, "Discard loaded source"); await waitForLoad(p); await restored(); await exact(p, text);
    expect(await p.evaluate(id => { try { window.hostFixture.navigationDocument(id); return false; } catch { return true; } }, loaded.documentId)).toBe(true);
    await command(p, "Finish save"); await command(p, "Finish run"); await expect.poll(async () => (await snap(p)).activity.pendingRuns).toBe(0); expect((await snap(p)).source.dirty).toBe(true); await exact(p, text);
    const completed = (await snap(p)).diagnostics;
    await command(p, "Prompt close"); await command(p, "Confirm close"); await expect(primary(p)).toHaveCount(0);
    await command(p, "Begin delayed load"); expect((await snap(p)).loadPending).toBe(true); await command(p, "Finish delayed load"); await expect(primary(p)).toBeVisible();
    await command(p, "Prompt close"); await command(p, "Confirm close"); await command(p, "Reopen primary source"); await waitForLoad(p); await exact(p, text);
    expect(owned((await snap(p)).diagnostics)).toEqual(owned(completed));
    await p.evaluate(() => window.hostFixture.dispose());
});
