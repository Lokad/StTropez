import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { nativeSubstitutionCases } from "../fixtures/substitution.ts";

test.beforeEach(async ({ page }) => { page.on("pageerror", error => { throw error; }); await page.goto("/shaping/"); await page.waitForFunction(() => window.shapingFixture?.ready); });

test("all GSUB forms retain native observations with single-character and mixed-context controls", async ({ page, browser }, info) => {
    const rows = [];
    for (const c of nativeSubstitutionCases()) {
        const row = await page.evaluate(async c => {
            const asset = window.shapingFixture.font.createAsset(c.name), before = document.fonts.size, source = new Uint8Array(c.bytes);
            try {
                const result = await asset.request(0, source)!.settled; source.fill(0); if (result.status !== "ready") throw new Error(asset.getSnapshot().failure ?? result.status);
                const current = asset.getSnapshot().current!, font = current.data; let offset = 0;
                const glyphs = [...c.text].map(character => { const from = offset; offset += character.length; return { glyphId: font.glyphIndex(character.codePointAt(0)!), source: { from, to: offset } }; });
                const substituted = font.substitutionPlan({ features: [{ tag: c.feature, value: c.value }] }).apply(glyphs), units = substituted.glyphs.reduce((sum, glyph) => sum + font.nominalGlyphMetrics(glyph.glyphId).advanceWidth, 0);
                const builder = font.createGlyphRunBuilder(); builder.append(glyphs); const supplied = builder.finish(); builder.dispose(); const cursor = font.substitutionPlan({ features: [{ tag: c.feature, value: c.value }] }).createCursor(supplied);
                let step = cursor.next(256); while (step.status === "running") step = cursor.next(256); const cooperative = step.result!.glyphs; cursor.dispose(); if (JSON.stringify(cooperative) !== JSON.stringify(substituted.glyphs)) throw new Error("Cooperative/native fixture source mismatch.");
                const span = document.createElement("span"); span.textContent = c.text; Object.assign(span.style, { display: "inline-block", whiteSpace: "pre", fontFamily: current.family, fontSize: "100px", fontKerning: "none", fontFeatureSettings: `"${c.feature}" ${c.value}` });
                document.body.append(span); const nativePx = span.getBoundingClientRect().width; span.remove();
                return { glyphs: substituted.glyphs.map(g => g.glyphId), mapped: substituted.glyphs, units, px: units / 10, nativePx, dpr: devicePixelRatio, generation: current.generation };
            } finally { asset.dispose(); if (document.fonts.size !== before) throw new Error("Owned font face leak."); }
        }, { ...c, bytes: Array.from(c.bytes) });
        expect(row.glyphs, c.name).toEqual(c.expectedGlyphs); expect(row.nativePx, c.name).toBe(c.nativeWidths[info.project.name] ?? row.px);
        rows.push({ name: c.name, text: c.text, feature: c.feature, value: c.value, fontSha256: createHash("sha256").update(c.bytes).digest("hex"), ...row, difference: row.nativePx - row.px });
    }
    await mkdir("artifacts", { recursive: true }); await writeFile(`artifacts/substitution-native-${info.project.name}.json`, JSON.stringify({ created: new Date().toISOString(), engine: info.project.name, browser: browser.version(), viewport: page.viewportSize(), fontSizePx: 100, kerning: "none", rows }, null, 2));
});

test("the visible original font compares nominal, substituted, positioned and native widths", async ({ page }) => {
    await page.getByRole("button", { name: "Load fixture font", exact: true }).click(); await expect.poll(() => page.evaluate(() => window.shapingFixture.font.snapshot().status)).toBe("ready");
    const rows = await page.evaluate(() => window.shapingFixture.font.measure()!);
    expect(rows.find(r => r.text === "fi")).toMatchObject({ nominalPx: 60, substitutedPx: 50, nativePx: 50 });
    expect(rows.find(r => r.text === "AB")).toMatchObject({ nominalPx: 130, substitutedPx: 130, positionedPx: 120, nativePx: 120 });
    await expect(page.locator("#font-status")).toContainText("Script analysis, native variation behavior, ink/carets");
});

test("captured font plans and source mappings survive replacement while the old native version expires", async ({ page }) => {
    const state = await page.evaluate(async () => {
        const f = window.shapingFixture.font; await f.request().settled; const current = f.asset.getSnapshot().current!, plan = current.data.substitutionPlan({ features: [{ tag: "liga" }] });
        const input = [{ glyphId: 4, source: { from: 100_000, to: 100_001 } }, { glyphId: 5, source: { from: 100_001, to: 100_002 } }], result = plan.apply(input); input[0]!.source.from = 99;
        await f.request(800).settled; const expired = !f.asset.isCurrent(current.generation), same = result.font === current.data && plan.font === current.data;
        f.asset.dispose(); return { expired, same, glyphs: result.glyphs, oldA: plan.font.nominalGlyphMetrics(2).advanceWidth, disposed: f.snapshot().status, replay: plan.apply([{ glyphId: 4, source: { from: 0, to: 1 } }, { glyphId: 5, source: { from: 1, to: 2 } }]).glyphs.map(g => g.glyphId) };
    });
    expect(state.expired).toBe(true); expect(state.same).toBe(true); expect(state.oldA).toBe(600); expect(state.disposed).toBe("disposed"); expect(state.replay).toEqual([6]); expect(state.glyphs[0]!.sources).toEqual([{ from: 100_000, to: 100_001 }, { from: 100_001, to: 100_002 }]);
});
