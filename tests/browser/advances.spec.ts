import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => { page.on("pageerror", error => { throw error; }); await page.goto("/shaping/"); await page.waitForFunction(() => window.shapingFixture?.ready); await page.evaluate(() => window.shapingFixture.fontsReady()); });

test("retained origins reconstruct native kerning, joining, isolates, overrides and proportional observations", async ({ page }) => {
    const results = await page.evaluate(() => {
        const f = window.shapingFixture, results = [];
        for (const [text, font, direction] of [["AVATAR office é 👩‍💻", "24px Arial", "ltr"], ["abc \u2067אבג 123\u2069 xyz", "italic 24px Times New Roman", "ltr"],
            ["العربية (123)", "24px Arial", "rtl"], ["\u202e" + "a".repeat(600) + "123\u202c", "24px Arial", "ltr"]] as const) {
            f.mount(text, { font, direction }); const ranges = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)]
                .filter(p => /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(p.segment) && (p.index < 12 || p.index > text.length - 7)).map(p => ({ from: p.index, to: p.index + p.segment.length }));
            const captured = f.retain(0, ranges)!; f.dispose(); results.push({ captured, current: f.retainedCurrent(), origins: ranges.map((_, i) => f.retainedOrigin(i)), released: f.snapshot(), nodes: f.hostNodes() });
        } f.clearOrigins(); return results;
    });
    let reversals = 0;
    for (const result of results) {
        expect(result.current).toBe(false); expect(result.nodes).toBe(0); expect(result.released!.domTextUnits).toBe(0);
        for (const [i, sample] of result.captured.samples.entries()) {
            expect(sample.rectangles.length).toBeGreaterThan(0); expect(sample.left).toBe(Math.min(...sample.rectangles.map(r => r.left)));
            expect(Math.abs(result.origins[i]! - sample.left)).toBeLessThan(.000001); if (i && sample.left < result.captured.samples[i - 1]!.left) reversals++;
        }
        expect(result.captured.index.length).toBe(result.origins.length);
    }
    expect(reversals).toBeGreaterThan(3);
});

test("native origin captures retain probe generation and revision instead of retargeting new source", async ({ page }) => {
    const state = await page.evaluate(() => {
        const f = window.shapingFixture; f.mount("AVATAR"); const captured = f.retain(0, [{ from: 1, to: 2 }])!, origin = f.retainedOrigin(0), current = f.retainedCurrent();
        f.replace(0, 0, 1, "WW"); const stale = f.retainedCurrent(), rejected = f.retain(0, [{ from: 0, to: 1 }]);
        f.mount("new source"); const replaced = f.retainedCurrent(), historicalOrigin = f.retainedOrigin(0); f.dispose();
        return { captured, origin, current, stale, rejected, replaced, historicalOrigin };
    });
    expect(state.current).toBe(true); expect(state.stale).toBe(false); expect(state.rejected).toBeNull(); expect(state.replaced).toBe(false); expect(state.historicalOrigin).toBe(state.origin);
});
