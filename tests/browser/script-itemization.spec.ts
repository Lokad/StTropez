import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
test.beforeEach(async ({ page }) => { page.on("pageerror", error => { throw error; }); await page.goto("/shaping/"); await page.waitForFunction(() => window.shapingFixture?.ready); });
async function load(page: import("@playwright/test").Page) { await page.getByRole("button", { name: "Load script fixture font", exact: true }).click(); await expect.poll(() => page.evaluate(() => window.shapingFixture.font.snapshot().status)).toBe("ready"); }
async function analyze(page: import("@playwright/test").Page, text: string) { await page.getByRole("textbox", { name: "Unicode source", exact: true }).fill(text); await page.getByLabel("Normalization form").selectOption("none"); await page.getByRole("button", { name: "Analyze Unicode text", exact: true }).click(); await expect.poll(() => page.evaluate(() => window.shapingFixture.unicode.snapshot().status), { timeout: 30_000 }).toBe("ready"); }

test("script-specific features run over distinct owned views and retain native differences with covered controls", async ({ page, browser }, info) => {
    await load(page); const rows = [];
    for (const text of ["Aα", "AAαα", "AAααאא", "AAאאAA", "A α א", "AαA", "αאA", "ABαβאב"]) {
        await analyze(page, text); const row = await page.evaluate(text => {
            const ui = window.shapingFixture.unicode, state = ui.snapshot(), current = window.shapingFixture.font.asset.getSnapshot().current!, runs = Array.from({ length: state.scriptParts! }, (_, i) => ({ script: ui.scriptAt(i), glyphs: ui.positionedPart(i)!.glyphs.map(g => g.source.glyphId), sources: ui.positionedPart(i)!.glyphs.map(g => g.source.sources) }));
            const control = current.data.createGlyphRunBuilder(); for (let i = 0; i < [...text].length; i++) control.append([{ glyphId: current.data.glyphIndex([...text][i]!.codePointAt(0)!), source: { from: i, to: i + 1 } }]); const supplied = control.finish(); control.dispose(); const whole = current.data.substitutionPlan({ features: [{ tag: "test" }] }).apply(supplied);
            const span = document.createElement("span"); span.textContent = text; Object.assign(span.style, { display: "inline-block", font: `100px "${current.family}"`, whiteSpace: "pre", fontFeatureSettings: '"test" 1, "liga" 0, "kern" 0', fontKerning: "none", direction: "ltr", unicodeBidi: "isolate" }); document.body.append(span); const nativeWidth = span.getBoundingClientRect().width; span.remove();
            return { text, state, runs, nativeWidth, coreWidth: state.advanceUnits! / 10, wholeGlyphs: whole.glyphs.map(g => g.glyphId) };
        }, text); rows.push(row); expect(row.state.current).toBe(true); expect(row.state.missingGlyphs).toBe(0); expect(row.state.scriptRuns).toBe(row.runs.length);
    }
    expect(rows[0]!.runs.map(r => r.script!.script)).toEqual(["Latn", "Grek"]); expect(rows[0]!.runs.flatMap(r => r.glyphs)).toEqual([3, 4]); expect(rows[0]!.wholeGlyphs).toEqual([6]); expect(rows[0]!.coreWidth).toBe(110);
    expect(rows[2]!.runs.flatMap(r => r.glyphs)).toEqual([3, 3, 4, 4, 5, 5]); expect(rows[2]!.coreWidth).toBe(260); expect(rows[2]!.runs[2]!.sources).toEqual([[{ from: 4, to: 5 }], [{ from: 5, to: 6 }]]);
    await mkdir("artifacts", { recursive: true }); await writeFile(`artifacts/script-native-${info.project.name}.json`, JSON.stringify({ created: new Date().toISOString(), engine: info.project.name, browser: browser.version(), rows, differences: rows.filter(r => r.nativeWidth !== r.coreWidth).length }, null, 2));
    expect(rows[2]!.nativeWidth).toBe(rows[2]!.coreWidth);
    expect(rows.map(r => r.nativeWidth - r.coreWidth)).toEqual(info.project.name === "webkit" ? [0, 0, 0, 0, 40, 0, 50, 0] : Array(8).fill(0));
});
test("a long script-feature pipeline yields to native typing and expires on active font replacement", async ({ page }) => {
    await load(page); await page.getByRole("textbox", { name: "Unicode source", exact: true }).fill("Aαא".repeat(4000)); await page.getByLabel("Normalization form").selectOption("none"); await page.getByRole("button", { name: "Analyze Unicode text", exact: true }).click();
    await expect.poll(() => page.evaluate(() => ["substitute", "position"].includes(window.shapingFixture.unicode.snapshot().stage ?? "")), { timeout: 20_000 }).toBe(true); expect(await page.evaluate(() => window.shapingFixture.unicode.scriptAt(0))).toBeNull();
    await page.getByLabel("Independent input").pressSequentially("responsive"); expect(await page.evaluate(() => window.shapingFixture.unicode.snapshot().status)).toBe("running"); await page.evaluate(() => window.shapingFixture.font.request(800).settled);
    await expect.poll(() => page.evaluate(() => window.shapingFixture.unicode.snapshot().status)).toBe("expired"); expect(await page.evaluate(() => window.shapingFixture.unicode.positionedPart(0))).toBeNull(); await expect(page.getByLabel("Independent input")).toHaveValue("responsive");
});
test("combining/paired script interpretation is visible and preview controls cannot reorder adjacent labels", async ({ page }) => {
    await analyze(page, "A(α[א]β)B\u202e\u2069"); const data = await page.evaluate(() => ({ state: window.shapingFixture.unicode.snapshot(), scripts: Array.from({ length: window.shapingFixture.unicode.snapshot().scriptRuns! }, (_, i) => window.shapingFixture.unicode.scriptAt(i)), preview: document.getElementById("unicode-status")!.textContent }));
    expect(data.scripts.map(s => s!.script)).toEqual(["Latn", "Grek", "Hebr", "Grek", "Latn"]); expect(data.state.glyphs).toBeNull(); expect(data.preview).toContain("\\u202e\\u2069"); expect(data.preview).toContain("9");
    await analyze(page, "A\u05b0\ufe0fα\u093e"); expect(await page.evaluate(() => window.shapingFixture.unicode.snapshot())).toMatchObject({ scriptRuns: 2, clusters: 2 });
});
