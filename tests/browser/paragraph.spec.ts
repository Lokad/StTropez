import { ready, expect, test } from "./fixtures.ts";
import type { Page } from "@playwright/test";
const snapshot = (page: Page) => page.evaluate(() => window.editingFixture.snapshot());

const analysisReady = (page: Page) => expect.poll(() => page.evaluate(() => window.editingFixture.snapshot().paragraph.status), { timeout: 30000 }).toBe("ready");
test.beforeEach(async ({ page }) => {  await page.goto("/editing/"); await ready(page); });

test("a million-unit paragraph resolves while real navigation and animation frames continue", async ({ page }) => {
    await page.evaluate(() => { window.editingFixture.setText("a".repeat(1_000_000) + " אבג (12) \u2067العربية\u2069"); window.editingFixture.focus("primary"); }); await ready(page);
    const before = await snapshot(page); await page.evaluate(() => window.editingFixture.analyzeCurrentLine());
    expect((await snapshot(page)).paragraph.status).toBe("running");
    const generation = (await snapshot(page)).paragraph.generation;
    expect(await page.evaluate(revision => window.editingFixture.analyzeParagraph(0, 1, revision - 1), before.document!.revision)).toBe(false);
    expect((await snapshot(page)).paragraph.generation).toBe(generation);
    const [, frames] = await Promise.all([page.keyboard.press("ArrowRight"), page.evaluate(() => new Promise<{ frames: number; runningFrames: number }>(resolve => {
        let frames = 0, runningFrames = 0; const step = () => { frames++; if (window.editingFixture.snapshot().paragraph.status === "running") runningFrames++; if (frames === 5) resolve({ frames, runningFrames }); else requestAnimationFrame(step); }; requestAnimationFrame(step);
    }))]);
    expect(frames.frames).toBe(5); expect(frames.runningFrames).toBeGreaterThan(0);
    await ready(page); expect((await snapshot(page)).primary.selection.head).toBe(1);
    await analysisReady(page); const after = await snapshot(page);
    expect(after.paragraph.range).toEqual({ from: 0, to: after.document!.length }); expect(after.paragraph.progress!.scannedUnits).toBe(after.document!.length);
    expect(after.paragraph.turns).toBeGreaterThan(10); expect(after.paragraph.advances).toBeGreaterThan(after.paragraph.turns);
    expect(await page.evaluate(() => window.editingFixture.paragraphLevel(1_000_001))).toBe(1);
    expect(after.document).toMatchObject({ revision: before.document!.revision, exports: 0 }); expect(after.primary.inputUnits).toBeLessThan(2600);
    expect(after.primary.viewport.textUnits).toBeLessThan(512); expect(after.primary.viewport.partialRows).toBe(1); expect(after.paragraph.pending).toBe(false);
});

test("typing invalidates the captured paragraph and explicit cancellation stops queued work", async ({ page }) => {
    await page.evaluate(() => { window.editingFixture.setText("x".repeat(1_000_000)); window.editingFixture.focus("primary"); window.editingFixture.analyzeCurrentLine(); });
    await page.keyboard.type("!"); await ready(page); const stale = await snapshot(page);
    expect(stale.paragraph.status).toBe("stale"); expect(stale.paragraph.visualLength).toBe(0); expect(stale.paragraph.pending).toBe(false);
    expect(stale.document).toMatchObject({ length: 1_000_001, exports: 0 }); expect(await page.evaluate(() => window.editingFixture.range(0, 1))).toBe("!");
    await page.evaluate(() => { window.editingFixture.analyzeCurrentLine(); window.editingFixture.cancelParagraph(); });
    const cancelled = (await snapshot(page)).paragraph;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect((await snapshot(page)).paragraph).toMatchObject({ status: "cancelled", pending: false, generation: cancelled.generation, visualLength: 0 });
});

test("tab generation expires analysis and full disposal clears timers, subscriptions and leases", async ({ page }) => {
    await page.evaluate(() => { window.editingFixture.setText("x".repeat(1_000_000)); window.editingFixture.analyzeCurrentLine(); window.editingFixture.replacePrimary(); });
    const expired = await snapshot(page); expect(expired.paragraph).toMatchObject({ status: "expired", pending: false, visualLength: 0 });
    await page.evaluate(() => window.editingFixture.dispose()); const disposed = await snapshot(page);
    expect(disposed.paragraph).toMatchObject({ status: "disposed", pending: false, visualLength: 0 }); expect(disposed.diagnostics).toMatchObject({ subscriptions: 0, leases: 0, views: 0, documents: 0 });
});

test("Analyze current line captures raw CRLF ranges and source offsets independently of focus", async ({ page }) => {
    await page.evaluate(() => { window.editingFixture.setText("prefix\r\nאבג 123\r\nlast"); window.editingFixture.select("primary", { anchor: 9, head: 9 }); }); await ready(page);
    await page.getByRole("button", { name: "Analyze current line", exact: true }).click(); await analysisReady(page);
    const state = await snapshot(page); expect(state.paragraph.range).toEqual({ from: 8, to: 17 }); expect(state.paragraph.paragraphCount).toBe(1);
    expect(await page.evaluate(() => window.editingFixture.paragraphLevel(8))).toBe(1); expect(await page.evaluate(() => window.editingFixture.paragraphLevel(12))).toBe(2);
    expect(await page.evaluate(() => window.editingFixture.paragraphOffset(0))).toBe(12);
    expect(state.primary.selection).toMatchObject({ anchor: 9, head: 9 }); expect(state.document!.exports).toBe(0);
});
