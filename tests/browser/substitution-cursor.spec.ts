import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => { page.on("pageerror", error => { throw error; }); await page.goto("/shaping/"); await page.waitForFunction(() => window.shapingFixture?.ready); });

test("bounded input preparation, GSUB and positioning let host typing continue across font replacement", async ({ page }) => {
    const task = await page.evaluateHandle(async () => {
        const f = window.shapingFixture.font; await f.request().settled; const captured = f.asset.getSnapshot().current!, font = captured.data, text = "fiAB".repeat(20_000), builder = font.createGlyphRunBuilder(), substitution = font.substitutionPlan({ features: [{ tag: "liga" }] }), positioning = font.positioningPlan({ features: [], legacyKerning: true });
        let stage: "input" | "substitution" | "positioning" | "ready" | "failed" = "input", from = 0, timer = 0, frame = 0, frames = 0, steps = 0;
        let sub: ReturnType<typeof substitution.createCursor> | undefined, pos: ReturnType<typeof positioning.createCursor> | undefined;
        const host = document.createElement("div"), input = document.createElement("input"), button = document.createElement("button"); Object.assign(host.style, { position: "fixed", left: "0", top: "0", zIndex: "2147483647", background: "white" }); input.setAttribute("aria-label", "Glyph host activity"); button.textContent = "Glyph host counter"; host.append(input, button); document.body.append(host); let clicks = 0; button.onclick = () => clicks++;
        const paint = () => { if (stage !== "ready" && stage !== "failed") { frames++; frame = requestAnimationFrame(paint); } }; frame = requestAnimationFrame(paint);
        let resolve!: (result: { total: number; glyphs: number; source: number; clicks: number; typed: string; frames: number; steps: number; stale: boolean; released: boolean }) => void, reject!: (error: unknown) => void;
        const done = new Promise<{ total: number; glyphs: number; source: number; clicks: number; typed: string; frames: number; steps: number; stale: boolean; released: boolean }>((yes, no) => { resolve = yes; reject = no; });
        const advance = () => {
            try {
                steps++;
                if (stage === "input") {
                    const to = Math.min(text.length, from + 256), entries = []; for (let i = from; i < to; i++) entries.push({ glyphId: font.glyphIndex(text.charCodeAt(i)), source: { from: i, to: i + 1 } }); builder.append(entries); from = to;
                    if (from === text.length) { const supplied = builder.finish(); builder.dispose(); sub = substitution.createCursor(supplied); stage = "substitution"; }
                } else if (stage === "substitution") { const state = sub!.next(4096); if (state.status === "ready") { pos = positioning.createCursor(state.result!); sub!.dispose(); stage = "positioning"; } else if (state.result) throw new Error("Partial GSUB result."); }
                else if (stage === "positioning") { const state = pos!.next(4096); if (state.status === "ready") { const result = state.result!; stage = "ready"; pos!.dispose(); resolve({ total: result.advances.total, glyphs: result.glyphs.length, source: result.glyphs.at(-1)!.source.sources[0]!.from, clicks, typed: input.value, frames, steps, stale: !f.asset.isCurrent(captured.generation), released: sub!.snapshot().result === null && pos!.snapshot().result === null && builder.snapshot().result === null }); return; } else if (state.result) throw new Error("Partial positioning result."); }
                timer = window.setTimeout(advance, 0);
            } catch (error) { stage = "failed"; reject(error); }
        }; timer = window.setTimeout(advance, 0);
        return { done, stage: () => stage, cleanup: () => { stage = "failed"; window.clearTimeout(timer); cancelAnimationFrame(frame); sub?.dispose(); pos?.dispose(); builder.dispose(); host.remove(); } };
    });
    try {
        await page.getByRole("button", { name: "Glyph host counter", exact: true }).click(); await page.getByRole("textbox", { name: "Glyph host activity", exact: true }).pressSequentially("responsive"); expect(await task.evaluate(t => t.stage())).not.toBe("ready");
        await page.evaluate(() => window.shapingFixture.font.request(800).settled); const result = await task.evaluate(t => t.done);
        expect(result).toMatchObject({ total: 34_000_000, glyphs: 60_000, source: 79_999, clicks: 1, typed: "responsive", stale: true, released: true }); expect(result.frames).toBeGreaterThan(0); expect(result.steps).toBeGreaterThan(400);
    } finally { await task.evaluate(t => t.cleanup()); await task.dispose(); }
});

test("native cancellation after private GSUB publication leaves the owned input reusable", async ({ page }) => {
    const task = await page.evaluateHandle(async () => {
        const f = window.shapingFixture.font; await f.request().settled; const font = f.asset.getSnapshot().current!.data, builder = font.createGlyphRunBuilder();
        for (let from = 0; from < 20_000; from += 256) builder.append(Array.from({ length: Math.min(256, 20_000 - from) }, (_, i) => ({ glyphId: (from + i) % 2 ? 5 : 4, source: { from: from + i, to: from + i + 1 } })));
        const supplied = builder.finish(); builder.dispose(); const plan = font.substitutionPlan({ features: [{ tag: "liga" }] }), cursor = plan.createCursor(supplied), button = document.createElement("button"); button.textContent = "Cancel substitution"; Object.assign(button.style, { position: "fixed", left: "0", top: "0", zIndex: "2147483647" }); document.body.append(button); button.onclick = () => cursor.dispose(); let gated = false, timer = 0;
        const advance = () => { const step = cursor.next(4096); if (step.status === "running" && step.phase === "publish" && step.publishedGlyphs > 0) gated = true; else if (step.status === "running") timer = window.setTimeout(advance, 0); }; timer = window.setTimeout(advance, 0);
        return { gated: () => gated, snapshot: cursor.snapshot, replay: () => { const result = plan.apply(supplied); return { glyphs: result.glyphs.length, first: result.glyphs[0]!.glyphId, source: supplied.at(0).glyphId }; }, cleanup: () => { window.clearTimeout(timer); cursor.dispose(); button.remove(); } };
    });
    try {
        await expect.poll(() => task.evaluate(t => t.gated())).toBe(true); const pending = await task.evaluate(t => t.snapshot()); expect(pending.status).toBe("running"); expect(pending.publishedGlyphs).toBeGreaterThan(0); expect(pending.result).toBeNull();
        await page.getByRole("button", { name: "Cancel substitution", exact: true }).click(); expect(await task.evaluate(t => t.snapshot().status)).toBe("disposed"); expect(await task.evaluate(t => t.replay())).toEqual({ glyphs: 10_000, first: 6, source: 4 });
    } finally { await task.evaluate(t => t.cleanup()); await task.dispose(); }
});
