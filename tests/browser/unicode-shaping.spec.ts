import { expect, test } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";

test.beforeEach(async ({ page }) => { page.on("pageerror", error => { throw error; }); await page.goto("/shaping/"); await page.waitForFunction(() => window.shapingFixture?.ready); });
async function load(page: import("@playwright/test").Page) { await page.getByRole("button", { name: "Load fixture font", exact: true }).click(); await expect.poll(() => page.evaluate(() => window.shapingFixture.font.snapshot().status)).toBe("ready"); }

test("the visible normalization-to-glyph pipeline preserves document text and exact compatibility provenance", async ({ page }) => {
    await load(page); const text = "ﬁAB A\ufe0f 😀"; await page.getByRole("textbox", { name: "Unicode source", exact: true }).fill(text); await page.getByLabel("Normalization form").selectOption("NFKD"); await page.getByRole("button", { name: "Analyze Unicode text", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.shapingFixture.unicode.snapshot().status)).toBe("ready");
    const state = await page.evaluate(() => ({ state: window.shapingFixture.unicode.snapshot(), first: window.shapingFixture.unicode.sourceAt(0), second: window.shapingFixture.unicode.sourceAt(1), variant: window.shapingFixture.unicode.mappedAt(5) }));
    expect(state.state).toMatchObject({ current: true, points: 9, normalizedUnits: 10, glyphs: 7, missingGlyphs: 0, unsupportedVariations: 0, advanceUnits: 4100, preview: "fiAB A\ufe0f 😀" }); expect(state.first!.sources).toEqual([{ from: 0, to: 1 }]); expect(state.second!.sources).toEqual([{ from: 0, to: 1 }]); expect(state.variant!.glyphId).toBe(8); expect(state.variant!.sources).toEqual([{ from: 4, to: 5 }, { from: 5, to: 6 }]); await expect(page.getByRole("textbox", { name: "Unicode source", exact: true })).toHaveValue(text);
});

test("source, normalization style and active font replacement expire captured analysis", async ({ page }) => {
    await load(page); const source = page.getByRole("textbox", { name: "Unicode source", exact: true }); await source.fill("ﬁAB ".repeat(20_000)); await page.getByRole("button", { name: "Analyze Unicode text", exact: true }).click(); await expect.poll(() => page.evaluate(() => window.shapingFixture.unicode.snapshot().status)).toBe("running");
    await source.press("End"); await source.pressSequentially("x"); await expect.poll(() => page.evaluate(() => window.shapingFixture.unicode.snapshot().status)).toBe("expired"); expect(await page.evaluate(() => window.shapingFixture.unicode.sourceAt(0))).toBeNull();
    await page.getByRole("button", { name: "Analyze Unicode text", exact: true }).click(); await page.getByLabel("Normalization form").selectOption("NFD"); await expect.poll(() => page.evaluate(() => window.shapingFixture.unicode.snapshot().status)).toBe("expired");
    await page.getByRole("button", { name: "Analyze Unicode text", exact: true }).click(); expect(await page.evaluate(() => window.shapingFixture.unicode.snapshot().status)).toBe("running"); await page.evaluate(() => window.shapingFixture.font.request(800).settled); await expect.poll(() => page.evaluate(() => window.shapingFixture.unicode.snapshot().status)).toBe("expired"); expect(await page.evaluate(() => window.shapingFixture.unicode.snapshot().current)).toBe(false);
});

test("long canonical ordering leaves independent native typing responsive", async ({ page }) => {
    await load(page); const text = "A" + "\u0315\u0300\u0323".repeat(20_000); await page.getByRole("textbox", { name: "Unicode source", exact: true }).fill(text); await page.getByLabel("Normalization form").selectOption("NFD"); await page.getByRole("button", { name: "Analyze Unicode text", exact: true }).click();
    await page.getByLabel("Independent input").pressSequentially("responsive"); expect(await page.evaluate(() => window.shapingFixture.unicode.snapshot().status)).toBe("running"); await expect.poll(() => page.evaluate(() => window.shapingFixture.unicode.snapshot().status), { timeout: 20_000 }).toBe("ready");
    const state = await page.evaluate(() => window.shapingFixture.unicode.snapshot()); expect(state.points).toBe(text.length); expect(state.preview).toBe([...text.normalize("NFD")].slice(0, 80).join("")); expect(state.steps).toBeGreaterThan(100); await expect(page.getByLabel("Independent input")).toHaveValue("responsive");
});

test("full disposal removes diagnostic listeners and pending presentation", async ({ page }) => {
    await load(page); await page.getByRole("textbox", { name: "Unicode source", exact: true }).fill("ﬁAB ".repeat(20_000)); await page.getByRole("button", { name: "Analyze Unicode text", exact: true }).click(); const disposed = await page.evaluate(() => { window.shapingFixture.unicode.dispose(); return window.shapingFixture.unicode.snapshot(); });
    expect(disposed.status).toBe("disposed"); await page.getByRole("textbox", { name: "Unicode source", exact: true }).fill("changed"); await page.evaluate(() => window.shapingFixture.font.request(800).settled); expect(await page.evaluate(() => window.shapingFixture.unicode.snapshot())).toEqual(disposed); await expect(page.getByRole("button", { name: "Analyze Unicode text", exact: true })).toBeDisabled();
});

test("native normalization retains every Unicode18 source case and any engine-version differences", async ({ page, browser }, info) => {
    test.setTimeout(90_000);
    const input = gunzipSync(await readFile("tests/fixtures/unicode-shaping/NormalizationTest.txt.gz")).toString("utf8").split(/\r?\n/).filter(line => line && !line.startsWith("@")).map((line, row) => ({ row, columns: line.split(";").slice(0, 5).map(value => String.fromCodePoint(...value.trim().split(/\s+/).map(v => parseInt(v, 16)))) }));
    const observed = await page.evaluate(input => { const differences: { row: number; form: string; source: number[]; expected: number[]; actual: number[] }[] = []; let conditions = 0, coreDifferences = 0; for (const { row, columns } of input) for (const [form, at] of [["NFC", 1], ["NFD", 2], ["NFKC", 3], ["NFKD", 4]] as const) { const actual = columns[0]!.normalize(form); if (window.shapingFixture.normalize(columns[0]!, form) !== columns[at]) coreDifferences++; if (actual !== columns[at]) differences.push({ row, form, source: [...columns[0]!].map(c => c.codePointAt(0)!), expected: [...columns[at]!].map(c => c.codePointAt(0)!), actual: [...actual].map(c => c.codePointAt(0)!) }); conditions++; } return { rows: input.length, conditions, coreDifferences, differences }; }, input);
    await mkdir("artifacts", { recursive: true }); await writeFile(`artifacts/unicode-native-${info.project.name}.json`, JSON.stringify({ created: new Date().toISOString(), engine: info.project.name, browser: browser.version(), unicode: "18.0.0", ...observed }, null, 2)); expect(observed.rows).toBe(20_171); expect(observed.conditions).toBe(80_684); expect(observed.coreDifferences).toBe(0);
    // Retain the entire observed native gap; a changed engine profile requires explicit review.
    const baseline = info.project.name === "webkit" ? { count: 674, sha256: "ee47b3712fba25995fb0d4d90c32bf64de79599c0affd6052c8fcf95f2d721c6" } : { count: 400, sha256: "f4839018a507b481471d8068e67d2d24bdfc515d7bf1a14c02ea7bb8e00a7554" };
    expect(observed.differences.length).toBe(baseline.count); expect(createHash("sha256").update(JSON.stringify(observed.differences)).digest("hex")).toBe(baseline.sha256);
});
