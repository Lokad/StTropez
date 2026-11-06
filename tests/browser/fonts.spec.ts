import { expect, test } from "@playwright/test";
import { fontFixture } from "../fixtures/consumer/font-fixture.ts";

test.beforeEach(async ({ page }) => { page.on("pageerror", error => { throw error; }); await page.goto("/shaping/"); await page.waitForFunction(() => window.shapingFixture?.ready); });

test("owned font data matches nominal native widths and exposes kerning/ligature shaping differences", async ({ page }) => {
    await page.getByRole("button", { name: "Load fixture font", exact: true }).click(); await expect.poll(() => page.evaluate(() => window.shapingFixture.font.snapshot().status)).toBe("ready");
    const state = await page.evaluate(() => ({ state: window.shapingFixture.font.snapshot(), rows: window.shapingFixture.font.measure()!, current: window.shapingFixture.font.asset.isCurrent(1) }));
    expect(state.current).toBe(true); expect(state.state.current!.metadata.unitsPerEm).toBe(1000); expect(state.state.current!.metadata.glyphCount).toBe(10);
    for (const text of ["A B", "😀"]) { const row = state.rows.find(r => r.text === text)!; expect(Math.abs(row.nominalPx - row.nativePx)).toBeLessThan(.05); }
    expect(state.rows.find(r => r.text === "AB")!).toMatchObject({ nominalUnits: 1300, nominalPx: 130, nativePx: 120 });
    expect(state.rows.find(r => r.text === "fi")!).toMatchObject({ nominalUnits: 600, nominalPx: 60, nativePx: 50 });
    const variant = state.rows.find(r => r.text === "A\ufe0f")!; expect(variant.glyphs).toEqual([8]); expect(variant.nominalUnits).toBe(900); expect(Number.isFinite(variant.nativePx)).toBe(true);
});

test("font generation and copied bytes prevent retargeting on an insecure origin without randomUUID", async ({ page }) => {
    const source = page.url();
    await page.route("http://font-fixture.test/**", async route => {
        const url = new URL(route.request().url());
        await route.fulfill({ response: await page.request.get(new URL(url.pathname + url.search, source).href) });
    });
    await page.goto("http://font-fixture.test/shaping/"); await page.waitForFunction(() => window.shapingFixture?.ready);
    expect(await page.evaluate(() => ({ secure: isSecureContext, uuid: typeof crypto.randomUUID, random: typeof crypto.getRandomValues })))
        .toEqual({ secure: false, uuid: "undefined", random: "function" });
    const state = await page.evaluate(async () => {
        const f = window.shapingFixture.font, subscribe = f.asset.subscribe, get = f.asset.getSnapshot, observed: string[] = [], stop = subscribe(() => { const s = get(); observed.push(`${s.generation}:${s.status}`); });
        const first = f.request(600), second = f.request(800), results = await Promise.all([first.settled, second.settled]), snapshot = get();
        const rejected = f.asset.request(0, new Uint8Array()), unchanged = get() === snapshot, metrics = snapshot.current!.data.nominalGlyphMetrics(2);
        stop(); return { results, observed, rejected, unchanged, metrics, stable: subscribe === f.asset.subscribe && get === f.asset.getSnapshot, current: f.asset.isCurrent(2), old: f.asset.isCurrent(1) };
    });
    expect(state.results).toEqual([{ generation: 1, status: "stale" }, { generation: 2, status: "ready" }]); expect(state.observed).not.toContain("1:ready"); expect(state.metrics.advanceWidth).toBe(800);
    expect(state.rejected).toBeNull(); expect(state.unchanged).toBe(true); expect(state.stable).toBe(true); expect(state.current).toBe(true); expect(state.old).toBe(false);
});

test("an injected load rejection after real native decode preserves the previous font and foreign faces", async ({ page }) => {
    const state = await page.evaluate(async bytes => {
        const f = window.shapingFixture.font, foreign = new FontFace("HostExistingFixture", new Uint8Array(bytes)); await foreign.load(); document.fonts.add(foreign);
        const nativeLoad = FontFace.prototype.load; let decoded = false;
        try {
            await f.request().settled; const before = f.asset.getSnapshot(), active = before.current!;
            FontFace.prototype.load = function(this: FontFace) { return nativeLoad.call(this).then(() => { decoded = true; throw new Error("Injected native load rejection."); }); };
            const failed = await f.request(800).settled, after = f.asset.getSnapshot();
            let invalid = false; try { f.asset.request(after.generation, new Uint8Array()); } catch { invalid = true; }
            return { decoded, failed, status: after.status, failure: after.failure, same: active === after.current, current: f.asset.isCurrent(active.generation), foreign: document.fonts.has(foreign), invalid, unchanged: f.asset.getSnapshot() === after };
        } finally { FontFace.prototype.load = nativeLoad; document.fonts.delete(foreign); }
    }, Array.from(fontFixture()));
    expect(state.decoded).toBe(true); expect(state.failed.status).toBe("failed"); expect(state.status).toBe("failed"); expect(state.failure).toBe("Injected native load rejection."); expect(state.same).toBe(true); expect(state.current).toBe(true);
    expect(state.foreign).toBe(true); expect(state.invalid).toBe(true); expect(state.unchanged).toBe(true);
});

test("cancelled and disposed font loads cannot publish or register a late face", async ({ page }) => {
    const state = await page.evaluate(async () => {
        const f = window.shapingFixture.font, names = () => [...document.fonts].filter(face => face.family.startsWith("_stfont_")).map(face => face.family);
        await f.request().settled; const old = f.asset.getSnapshot().current!, cancelled = f.request(800); f.asset.cancel(); const cancelResult = await cancelled.settled;
        const afterCancel = { current: f.asset.isCurrent(old.generation), names: names() }, pending = f.request(700); f.asset.dispose(); const result = await pending.settled;
        return { cancelResult, afterCancel, result, state: f.snapshot(), names: names(), retainedMetric: old.data.nominalGlyphMetrics(2), oldCurrent: f.asset.isCurrent(old.generation) };
    });
    expect(state.cancelResult.status).toBe("stale"); expect(state.afterCancel.current).toBe(true); expect(state.afterCancel.names.length).toBe(1);
    expect(state.result.status).toBe("disposed"); expect(state.state).toMatchObject({ status: "disposed", current: null }); expect(state.names).toEqual([]); expect(state.oldCurrent).toBe(false); expect(state.retainedMetric.advanceWidth).toBe(600);
});
