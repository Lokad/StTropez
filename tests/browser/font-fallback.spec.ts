import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const state = (page: Page) => page.evaluate(() => window.shapingFixture.fallback.snapshot());
const ready = (page: Page) => expect.poll(async () => (await state(page)).status, { timeout: 20000 }).toBe("ready");
async function load(page: Page) { await page.evaluate(() => window.shapingFixture.fallback.load()); expect((await state(page)).fontVersions).toEqual([1, 1]); }
test.beforeEach(async ({ page }) => { page.on("pageerror", e => { throw e; }); await page.goto("/shaping/"); await page.waitForFunction(() => window.shapingFixture?.ready); });

test("font cascade measurements retain native profiles and execute normalization features per selected font", async ({ page, browser }, info) => {
    await load(page); const rows = await page.evaluate(() => window.shapingFixture.fallback.measure()); expect(rows).not.toBeNull();
    const sha256 = createHash("sha256").update(JSON.stringify(rows)).digest("hex"); await mkdir("artifacts/fallback", { recursive: true }); await writeFile(`artifacts/fallback/native-${info.project.name}.json`, JSON.stringify({ created: new Date().toISOString(), browser: browser.version(), rows, sha256, differences: rows!.filter(r => r.difference !== 0).length }, null, 2));
    expect(rows!.length).toBe(16); expect(rows!.slice(0, 3).map(r => r.core)).toEqual([40, 20, 100]);
    expect(rows![0]!.parts[0]!.glyphs).toEqual([4]); expect(rows![1]!.parts[0]!.glyphs).toEqual([5]);
    expect(rows![5]!.normalized).toBe("Å\u0327\u0301"); expect(rows![6]!.normalized).toBe("Ω"); expect(rows![8]!.clusters[0]!.fontIndex).toBe(1); expect(rows![9]!.clusters[0]!.coverage).toBe("variation-fallback");
    expect(rows![11]!.clusters).toHaveLength(1); expect(rows![11]!.clusters[0]!.fontIndex).toBe(1); expect(rows![14]!.clusters[0]!.coverage).toBe("missing");
    expect(rows![11]!.core).toBe(80);
    expect(rows![15]!.clusters[0]!.fontIndex).toBe(1); expect(rows![15]!.core).toBe(90); expect(rows![15]!.clusters[0]!.coverage).toBe("covered");
    console.log(`Native fallback profile ${info.project.name}: ${rows!.filter(r => r.difference !== 0).length} differences, ${sha256}`);
    const profiles = { chromium: [3, "fa15fb9592856fdf0f914d4546a3267eac0e99ba7e14ded084031e3a8d89d6c3"], firefox: [6, "665cf9288ec192028292c2491c547f80aa6b7267e14477cdd1d88573252f1620"], webkit: [10, "7e7642b4f7ea0a12e3bc35ff3c2f835c381a1fc8d7eb1de75d4e6dbc852d4bf4"] } as const;
    const profile = profiles[info.project.name as keyof typeof profiles]; expect(rows!.filter(r => r.difference !== 0).length).toBe(profile[0]); expect(sha256).toBe(profile[1]);
});

test("default-ignorable visibility preserves glyph provenance and records native control widths", async ({ page, browser }, info) => {
    await load(page); const rows = await page.evaluate(() => window.shapingFixture.fallback.measureVisibility()); expect(rows).not.toBeNull();
    await mkdir("artifacts/glyph-visibility", { recursive: true }); await writeFile(`artifacts/glyph-visibility/native-${info.project.name}.json`, JSON.stringify({ created: new Date().toISOString(), browser: browser.version(), rows, differences: rows!.filter(r => r.difference !== 0).length }, null, 2));
    expect(rows!.map(r => r.core)).toEqual([...Array(13).fill(110), 0, 80, 160, 160]);
    for (const row of rows!.slice(0, 14)) { const hidden = row.parts.flatMap(p => p.visibility ?? []).filter(g => g.hidden); expect(hidden).toHaveLength(1); expect(hidden[0]!.advance).toBe(0); expect(hidden[0]!.properties!.defaultIgnorable).toBe(true); expect(hidden[0]!.sources.length).toBeGreaterThan(0); }
    for (const row of rows!.slice(15)) expect(row.parts.flatMap(p => p.visibility ?? []).some(g => g.hidden)).toBe(false);
    expect(rows!.slice(0, 14).map(r => r.native)).toEqual([...Array(13).fill(110), 0]);
    const native = { chromium: [80, 203.603515625, 160], firefox: [120, 203.60000610351562, 160], webkit: [137.3046875, 219.98046875, 110] } as const;
    expect(rows!.slice(14).map(r => r.native)).toEqual(native[info.project.name as keyof typeof native]);
    await page.getByRole("textbox", { name: "Cascade source", exact: true }).fill("A\u200dB"); await page.getByRole("button", { name: "Analyze font cascade", exact: true }).click(); await ready(page);
    expect((await state(page))).toMatchObject({ hiddenGlyphs: 1, pixels: 110 }); await expect(page.locator("#cascade-status")).toContainText("1 hidden glyphs with zero advance");
    console.log(`Native visibility profile ${info.project.name}: ${rows!.filter(r => r.difference !== 0).length} differences`);
});

test("the visible pipeline preserves source, canonical origins and whole-cluster font selection", async ({ page }) => {
    await load(page); await page.getByRole("textbox", { name: "Cascade source", exact: true }).fill("ÁαA\ufe0f"); await page.getByRole("button", { name: "Analyze font cascade", exact: true }).click(); await ready(page);
    expect(await page.getByRole("textbox", { name: "Cascade source", exact: true }).inputValue()).toBe("ÁαA\ufe0f"); expect((await state(page))).toMatchObject({ current: true, points: 5, clusters: 3, fontRuns: 2, parts: 3, sourceExports: 0 });
    const observed = await page.evaluate(() => ({ first: window.shapingFixture.fallback.pointAt(0), mark: window.shapingFixture.fallback.pointAt(1), clusters: [0, 1, 2].map(i => window.shapingFixture.fallback.clusterAt(i)) }));
    expect(observed.first!.codePoint).toBe(65); expect(observed.first!.sources).toEqual([{ from: 0, to: 1 }]); expect(observed.mark!.sources).toEqual([{ from: 0, to: 1 }]); expect(observed.clusters.map(c => c!.fontIndex)).toEqual([0, 1, 1]);
    await expect(page.locator("#cascade-status")).toContainText("Whole clusters use the host's ordered fonts");
});

test("independent native typing and animation frames continue during a captured cascade pipeline", async ({ page }) => {
    await load(page); await page.getByRole("textbox", { name: "Cascade source", exact: true }).fill("A".repeat(100_000)); await page.getByRole("button", { name: "Analyze font cascade", exact: true }).click(); expect((await state(page)).status).toBe("running");
    await page.locator("#typing").fill("foreground typing"); const frames = await page.evaluate(() => new Promise<number>(resolve => { let n = 0; const tick = () => { if (++n === 3) resolve(n); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); })); expect(frames).toBe(3);
    expect(await page.locator("#typing").inputValue()).toBe("foreground typing"); await ready(page); expect((await state(page))).toMatchObject({ current: true, points: 100_000, clusters: 100_000, fontRuns: 1, sourceExports: 0 }); expect((await state(page)).steps).toBeGreaterThan(10);
});

test("source, preference and either font generation expire scheduled work without retargeting retained results", async ({ page }) => {
    for (const changed of ["source", "preference", "primary", "secondary"] as const) {
        if (changed !== "source") { await page.goto("/shaping/"); await page.waitForFunction(() => window.shapingFixture?.ready); }
        await load(page); await page.evaluate(() => window.shapingFixture.fallback.analyze()); await ready(page); await page.evaluate(() => window.shapingFixture.fallback.retain()); const retained = await page.evaluate(() => window.shapingFixture.fallback.retained());
        await page.getByRole("textbox", { name: "Cascade source", exact: true }).fill("A".repeat(100_000)); await page.evaluate(() => window.shapingFixture.fallback.analyze()); expect((await state(page)).status).toBe("running");
        if (changed === "source") await page.getByRole("textbox", { name: "Cascade source", exact: true }).fill("later");
        if (changed === "preference") await page.getByLabel("Cascade preference").selectOption("decomposed");
        if (changed === "primary") await page.evaluate(() => window.shapingFixture.fallback.replacePrimary());
        if (changed === "secondary") await page.evaluate(() => window.shapingFixture.fallback.replace());
        await expect.poll(async () => (await state(page)).status).toBe("expired"); expect((await state(page)).points).toBeNull(); const after = await page.evaluate(() => window.shapingFixture.fallback.retained()); expect(after!.current).toBe(false); expect(after!.pixels).toBe(retained!.pixels); expect(after!.first).toEqual(retained!.first);
    }
});

test("cancellation and disposal stop queued work and release both native faces", async ({ page }) => {
    const before = await page.evaluate(() => document.fonts.size); await load(page); expect(await page.evaluate(() => document.fonts.size)).toBe(before + 2);
    await page.getByRole("textbox", { name: "Cascade source", exact: true }).fill("A".repeat(100_000)); await page.evaluate(() => window.shapingFixture.fallback.analyze()); await page.getByRole("button", { name: "Cancel font cascade", exact: true }).click(); expect((await state(page))).toMatchObject({ status: "cancelled", points: null });
    const steps = (await state(page)).steps; await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); expect((await state(page)).steps).toBe(steps);
    await page.evaluate(() => { window.shapingFixture.fallback.analyze(); window.shapingFixture.fallback.dispose(); }); expect((await state(page))).toMatchObject({ status: "disposed", points: null, fontVersions: [null, null] }); expect(await page.evaluate(() => document.fonts.size)).toBe(before);
});

test("heated raw ranges preserve clipped UTF16 bounds across normalization, graphemes and bidi", async ({ page, browser }, info) => {
    const observed = await page.evaluate(() => { let conditions = 0; const differences: unknown[] = [];
        for (let i = 0; i < 2500; i++) for (const [text, to, codes, boundaries] of [["👩‍💻", 4, [0x1f469, 0x200d, 0xd83d], [0, 3, 4]], ["א😀", 2, [0x5d0, 0xd83d], [0, 1, 2]]] as const) {
            const value = window.shapingFixture.ranges(text + "x".repeat(i % 9), 0, to); conditions++;
            if (JSON.stringify(value.points.map(p => p.codePoint)) !== JSON.stringify(codes) || JSON.stringify(value.boundaries) !== JSON.stringify(boundaries) || value.scanned.some(n => n !== to)
                || value.points.some(p => p.sources.some(s => s.from < 0 || s.to > to)) || value.lastLevel !== 2) if (differences.length < 10) differences.push({ text, to, value });
        } return { conditions, differences }; });
    await mkdir("artifacts/fallback", { recursive: true }); await writeFile(`artifacts/fallback/ranges-${info.project.name}.json`, JSON.stringify({ created: new Date().toISOString(), browser: browser.version(), ...observed }, null, 2));
    expect(observed.conditions).toBe(5000); expect(observed.differences).toEqual([]);
});
