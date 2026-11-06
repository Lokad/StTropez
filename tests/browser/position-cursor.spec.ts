import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => { page.on("pageerror", error => { throw error; }); await page.goto("/shaping/"); await page.waitForFunction(() => window.shapingFixture?.ready); });

test("host tasks and native typing continue while captured positioning runs across font replacement", async ({ page }) => {
    const run = await page.evaluateHandle(async () => {
        const f = window.shapingFixture.font; await f.request().settled; const captured = f.asset.getSnapshot().current!, font = captured.data,
            supplied = font.substitutionPlan({ features: [] }).apply(Array.from({ length: 200_000 }, (_, from) => ({ glyphId: from % 2 ? 3 : 2, source: { from, to: from + 1 } }))), cursor = font.positioningPlan({ features: [], legacyKerning: true }).createCursor(supplied);
        const host = document.createElement("div"), input = document.createElement("input"), button = document.createElement("button"); Object.assign(host.style, { position: "fixed", top: "0", left: "0", background: "white", zIndex: "2147483647" }); input.setAttribute("aria-label", "Host activity"); button.textContent = "Host counter"; host.append(input, button); document.body.append(host);
        let clicks = 0, frames = 0, steps = 0, running = true, timer = 0, frame = 0; button.onclick = () => clicks++; const paint = () => { if (running) { frames++; frame = requestAnimationFrame(paint); } }; frame = requestAnimationFrame(paint);
        let resolve!: (value: { total: number; steps: number; frames: number; clicks: number; typed: string; stale: boolean; source: number; disposedResult: boolean }) => void, reject!: (error: unknown) => void;
        const done = new Promise<{ total: number; steps: number; frames: number; clicks: number; typed: string; stale: boolean; source: number; disposedResult: boolean }>((yes, no) => { resolve = yes; reject = no; });
        const advance = () => {
            try { const step = cursor.next(4096); steps++; if (step.status === "running") { if (step.result !== null) throw new Error("Partial positioning publication."); timer = window.setTimeout(advance, 0); }
                else { running = false; const result = step.result!; cursor.dispose(); resolve({ total: result.advances.total, steps, frames, clicks, typed: input.value, stale: !f.asset.isCurrent(captured.generation), source: result.glyphs.at(-1)!.source.sources[0]!.from, disposedResult: cursor.snapshot().result === null }); }
            } catch (error) { running = false; reject(error); }
        }; timer = window.setTimeout(advance, 0);
        return { done, snapshot: cursor.snapshot, cleanup: () => { running = false; window.clearTimeout(timer); cancelAnimationFrame(frame); cursor.dispose(); host.remove(); } };
    });
    try {
        await page.getByRole("button", { name: "Host counter", exact: true }).click(); await page.getByRole("textbox", { name: "Host activity", exact: true }).fill("still responsive");
        expect(await run.evaluate(r => r.snapshot().status)).toBe("running"); await page.evaluate(() => window.shapingFixture.font.request(800).settled);
        const result = await run.evaluate(r => r.done); expect(result).toMatchObject({ total: 120_000_000, clicks: 1, typed: "still responsive", stale: true, source: 199_999, disposedResult: true }); expect(result.frames).toBeGreaterThan(0); expect(result.steps).toBeGreaterThan(100);
    } finally { await run.evaluate(r => r.cleanup()); await run.dispose(); }
});

test("a host can cancel after private glyph publication begins without exposing a partial result", async ({ page }) => {
    const run = await page.evaluateHandle(async () => {
        const f = window.shapingFixture.font; await f.request().settled; const font = f.asset.getSnapshot().current!.data, supplied = font.substitutionPlan({ features: [] }).apply(Array.from({ length: 20_000 }, (_, from) => ({ glyphId: 2, source: { from, to: from + 1 } }))), cursor = font.positioningPlan({ features: [] }).createCursor(supplied);
        const button = document.createElement("button"); button.textContent = "Cancel positioning"; Object.assign(button.style, { position: "fixed", top: "0", left: "0", zIndex: "2147483647" }); document.body.append(button); button.onclick = () => cursor.dispose(); let timer = 0, gated = false;
        const advance = () => { const step = cursor.next(4096); if (step.status === "running" && step.phase === "publish" && step.publishedGlyphs > 0) gated = true; else if (step.status === "running") timer = window.setTimeout(advance, 0); };
        timer = window.setTimeout(advance, 0); return { snapshot: cursor.snapshot, gated: () => gated, source: () => supplied.glyphs[0]!.sources[0]!.from, cleanup: () => { window.clearTimeout(timer); cursor.dispose(); button.remove(); } };
    });
    try {
        await expect.poll(() => run.evaluate(r => r.gated())).toBe(true); const pending = await run.evaluate(r => r.snapshot()); expect(pending.status).toBe("running"); expect(pending.publishedGlyphs).toBeGreaterThan(0); expect(pending.result).toBeNull();
        await page.getByRole("button", { name: "Cancel positioning", exact: true }).click(); const cancelled = await run.evaluate(r => ({ ...r.snapshot(), firstSource: r.source() })); expect(cancelled).toMatchObject({ status: "disposed", result: null, firstSource: 0 });
    } finally { await run.evaluate(r => r.cleanup()); await run.dispose(); }
});
