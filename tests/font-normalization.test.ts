import assert from "node:assert/strict";
import test from "node:test";
import { SfntFont, TextBuffer, FontCascade, createFontNormalizationCursor, FontNormalizationLimitError, normalizeText, createNormalizedGraphemeCursor, createGraphemeCursor, itemizeScripts, createScriptGlyphCursor } from "../src/index.ts";
import type { FontNormalizationCursor, FontNormalizationIndex, FontNormalizationOptions, NormalizedText } from "../src/index.ts";
import { canonicalVariantAt, canonicalVariantCount, canonicalVariantRange } from "../src/core/canonical-variants.ts";
import { coverageFontFixture } from "./fixtures/font-coverage.ts";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { assembleFont, fontTables, FontBytes, cmapTable } from "./fixtures/consumer/font-fixture.ts";
const font = (cps: readonly (number | readonly [number, number])[]) => SfntFont.from(coverageFontFixture(cps));
const original = (text: string) => normalizeText(TextBuffer.from(text), { form: "none" });
function finish(cursor: FontNormalizationCursor, budget = 256): FontNormalizationIndex { let prior = 0; while (true) { const step = cursor.next(budget); assert.ok(Object.isFrozen(step)); assert.ok(step.workUnits - prior <= budget + 256, String(step.workUnits - prior)); prior = step.workUnits; if (step.status === "ready") return step.result!; assert.equal(step.status, "running"); assert.equal(step.result, null); } }
const run = (text: string, fonts: readonly SfntFont[], options: FontNormalizationOptions = {}) => { const cursor = createFontNormalizationCursor(original(text), FontCascade.from(fonts), options); try { return finish(cursor); } finally { cursor.dispose(); } };

test("font composition preferences retain a covering primary font and exact canonical origins", () => {
    const primary = font([65, 0x327, 0x30a, 0x301, 0xc5]), fallback = font([0x1fa, 0x327]), source = "A\u0327\u030a\u0301", result = run(source, [primary, fallback]);
    assert.equal(result.text.form, "font"); assert.equal(result.text.text(), "Å\u0327\u0301"); assert.equal(result.clusterAt(0).fontIndex, 0); assert.equal(result.clusterAt(0).coverage, "covered");
    assert.deepEqual(result.text.at(0).sources, [{ from: 0, to: 1 }, { from: 2, to: 3 }]); assert.deepEqual(result.text.at(1).sources, [{ from: 1, to: 2 }]); assert.equal(result.input.text(), source);
    assert.equal(run(source, [primary, fallback], { preference: "decomposed" }).text.text(), source);
    assert.equal(run("A\u030a\u0301", [fallback]).text.text(), "Ǻ");
});

test("whole-grapheme fallback never combines fonts across marks, emoji, RI or revised Indic conjuncts", () => {
    for (const [text, primary, secondary] of [["a\u0301", [97], [97, 0x301]], ["👩‍💻", [0x1f469], [0x1f469, 0x1f4bb]], ["🇦🇧", [0x1f1e6], [0x1f1e6, 0x1f1e7]], ["\u094dक", [0x94d], [0x94d, 0x915]]] as const) {
        const result = run(text, [font(primary), font(secondary)]); assert.equal(result.clusterCount, 1); assert.equal(result.runCount, 1); assert.equal(result.clusterAt(0).fontIndex, 1); assert.equal(result.clusterAt(0).coverage, "covered"); assert.equal(result.text.text().normalize("NFD"), text.normalize("NFD"));
    }
    const missing = run("🇦🇧", [font([0x1f1e6]), font([0x1f1e7])]); assert.equal(missing.clusterAt(0).coverage, "missing"); assert.equal(missing.clusterAt(0).fontIndex, 0); assert.equal(missing.clusterAt(0).missingGlyphs, 1);
});

test("canonical aliases, exclusions and nonadjacent combining classes are covered without compatibility substitution", () => {
    const aliases = font([0x212b, 0x327, 0x301, 0x2126, 0x344]);
    for (const input of ["Å\u0327\u0301", "A\u0327\u030a\u0301", "Å\u0327\u0301"]) { const result = run(input, [aliases]); assert.equal(result.clusterAt(0).coverage, "covered"); assert.equal(result.text.text(), "Å\u0327\u0301"); }
    for (const input of ["Ω", "Ω"]) assert.equal(run(input, [aliases]).text.text(), "Ω");
    assert.equal(run("\u0308\u0301", [aliases]).text.text(), "\u0344");
    const ligature = run("ﬁ", [font([102, 105]), font([0xfb01])]); assert.equal(ligature.text.text(), "ﬁ"); assert.equal(ligature.clusterAt(0).fontIndex, 1);
    const blocked = run("A\u0301\u0300", [font([0xc0, 0x301]), font([65, 0x301, 0x300])]); assert.equal(blocked.clusterAt(0).fontIndex, 1); assert.equal(blocked.text.text().normalize("NFD"), "A\u0301\u0300");
});

test("every canonical table entry and Hangul syllable is selectable from its decomposed equivalent", () => {
    for (let i = 0; i < canonicalVariantCount; i++) { const v = canonicalVariantAt(i), [a, b] = canonicalVariantRange(v.decomposition[0]!); assert.ok(a <= i && i < b);
        const text = String.fromCodePoint(...v.decomposition), result = run(text, [font([v.codePoint])]); assert.equal(result.clusterCount, 1, String(v.codePoint)); assert.equal(result.clusterAt(0).coverage, "covered", String(v.codePoint)); assert.equal(result.text.text(), String.fromCodePoint(v.codePoint)); assert.equal(normalizeText(TextBuffer.from(String.fromCodePoint(v.codePoint)), { form: "NFD" }).text(), text);
    }
    const hangul = font(Array.from({ length: 11172 }, (_, i) => 0xac00 + i));
    for (let cp = 0xac00; cp <= 0xd7a3; cp++) { const syllable = String.fromCodePoint(cp), value = normalizeText(TextBuffer.from(syllable), { form: "NFD" }).text(); assert.equal(run(value, [hangul]).text.text(), syllable); }
    console.log(`Font canonical coverage: ${canonicalVariantCount} table entries /11172 Hangul syllables.`);
});

test("variation pairs stay atomic and a full-sequence fallback outranks an earlier base-only face", () => {
    const base = font([0xc5, 65]), variant = SfntFont.from(coverageFontFixture([], [{ base: 0xc5, selector: 0xfe0f, glyph: 8 }])), result = run("Å\ufe0f", [base, variant], { preference: "decomposed" });
    assert.equal(result.clusterAt(0).fontIndex, 1); assert.equal(result.clusterAt(0).coverage, "covered"); assert.equal(result.text.text(), "Å\ufe0f");
    const map = variant.createGlyphMappingCursor(result.text); let m = map.next(); while (m.status === "running") m = map.next(); assert.equal(m.result!.run.at(0).glyphId, 8); assert.deepEqual(m.result!.run.at(0).sources, [{ from: 0, to: 1 }, { from: 1, to: 2 }]); map.dispose();
    const degraded = run("Å\ufe0f", [base]); assert.equal(degraded.clusterAt(0).coverage, "variation-fallback"); assert.equal(degraded.clusterAt(0).unsupportedVariations, 1); assert.equal(degraded.text.text(), "Å\ufe0f");
    const zero = SfntFont.from(coverageFontFixture([65], [{ base: 65, selector: 0xfe0f, glyph: 0 }])); assert.equal(run("A\ufe0f", [zero]).clusterAt(0).coverage, "variation-fallback");
});

test("default ignorables, structural controls, script selectors and raw surrogates remain visible in layout text", () => {
    const empty = font([]), text = "\u200c\u200d\r\n\t\ufe0f"; const cursor = createFontNormalizationCursor(original(text), FontCascade.from([empty])), result = finish(cursor);
    assert.equal(result.text.text(), text); for (let i = 0; i < result.clusterCount; i++) assert.equal(result.clusterAt(i).coverage, "covered"); assert.equal(cursor.snapshot().orphanSelectors, 1); cursor.dispose();
    const mongol = createFontNormalizationCursor(original("\u1820\u180b"), FontCascade.from([font([0x1820])])); assert.equal(finish(mongol).text.text(), "\u1820\u180b"); assert.equal(mongol.snapshot().scriptSelectors, 1); mongol.dispose();
    const raw = createFontNormalizationCursor(original("\ud800"), FontCascade.from([font([0xfffd])])); assert.equal(finish(raw).text.text(), "\ud800"); assert.equal(raw.snapshot().unpairedSurrogates, 1); raw.dispose();
});

test("font runs map their own absolute point ranges and dispatch script features with shared text identity", () => {
    const primary = font([[65, 2], [0x301, 9]]), secondary = font([[0x3b1, 3]]), result = run("ÁαA", [primary, secondary]); assert.equal(result.text.text(), "A\u0301αA"); assert.equal(result.runCount, 3); let units = 0;
    for (let i = 0; i < result.runCount; i++) { const r = result.runAt(i), selected = result.cascade.at(r.fontIndex), mapper = selected.createGlyphMappingCursor(result.text, { from: r.from, to: r.to }); let mapped = mapper.next(); while (mapped.status === "running") mapped = mapper.next(); const mapping = mapped.result!; mapper.dispose();
        const scripts = itemizeScripts(result.text, { from: r.from, to: r.to }), partitioner = createScriptGlyphCursor(mapping, scripts); let p = partitioner.next(); while (p.status === "running") p = partitioner.next(); const parts = p.result!; partitioner.dispose();
        for (let j = 0; j < parts.length; j++) units += selected.positioningPlan({ features: [], legacyKerning: false }).apply(selected.substitutionPlan({ features: [] }).apply(parts.at(j).glyphs)).advances.total;
        assert.equal(mapping.from, r.from); assert.equal(mapping.to, r.to); assert.equal(mapping.pointRangeAt(0).from, r.from); assert.throws(() => createScriptGlyphCursor(mapping, itemizeScripts(result.text)));
    } assert.equal(units, 1900); assert.deepEqual(result.text.at(1).sources, [{ from: 0, to: 1 }]);
});

test("owned range capture, immutable results, empty input and invalid options preserve coordinate separation", () => {
    const input = original("😀Åα"), cascade = FontCascade.from([font([0xc5, 0x3b1])]), g = createNormalizedGraphemeCursor(input, { from: 1, to: 3 }); let s = g.next(); while (s.status === "running") s = g.next(); const graphemes = s.result!; g.dispose();
    const options = { from: 1, to: 3, graphemes }, cursor = createFontNormalizationCursor(input, cascade, options); options.to = 1; const result = finish(cursor); cursor.dispose();
    assert.equal(result.text.from, 2); assert.equal(result.text.to, 4); assert.equal(result.text.text(), "Åα"); assert.deepEqual(result.clusterAt(0), { from: 1, to: 2, sourceFrom: 2, sourceTo: 3, textFrom: 0, textTo: 1, fontIndex: 0, coverage: "covered", missingGlyphs: 0, unsupportedVariations: 0 });
    for (const value of [cascade, result, result.text, result.runAt(0), result.clusterAt(0), result.text.at(0), result.text.at(0).sources]) assert.ok(Object.isFrozen(value)); assert.throws(() => result.clusterAt(2)); assert.throws(() => cascade.at(-1)); assert.throws(() => result.runAt(1));
    assert.equal(run("", [font([])]).clusterCount, 0); assert.equal(run("", [font([])]).runCount, 0); assert.throws(() => FontCascade.from([])); assert.throws(() => createFontNormalizationCursor({} as NormalizedText, cascade)); assert.throws(() => createFontNormalizationCursor(normalizeText(input.source), cascade));
    assert.throws(() => createFontNormalizationCursor(input, cascade, { graphemes })); assert.throws(() => createFontNormalizationCursor(original("😀Åα"), cascade, { from: 1, to: 3, graphemes }));
    const raw = createGraphemeCursor(input.source); const rawStep = raw.next(); assert.throws(() => createFontNormalizationCursor(input, cascade, { graphemes: rawStep.result! })); raw.dispose();
    for (const o of [{ from: -1 }, { to: 9 }, { preference: "invalid" as "composed" }, { maxPoints: 0 }]) assert.throws(() => createFontNormalizationCursor(input, cascade, o));
});

test("long clusters suspend without buffer reads, cancel private phases and expose explicit limits", () => {
    const input = original("A" + "\u0301".repeat(90_000)), cascade = FontCascade.from([font([65, 0x301])]), reads = input.source.readMetrics(), cursor = createFontNormalizationCursor(input, cascade), result = finish(cursor, 4096);
    assert.equal(result.clusterCount, 1); assert.equal(result.text.length, 90_001); assert.deepEqual(input.source.readMetrics(), reads); assert.ok(cursor.snapshot().workUnits < input.length * 128); cursor.dispose(); assert.equal(cursor.snapshot().result, null); assert.equal(result.text.at(90_000).codePoint, 0x301);
    for (const phase of ["grapheme", "prepare", "normalize", "coverage", "publish"] as const) { const c = createFontNormalizationCursor(input, cascade); let step = c.next(); while (step.status === "running" && step.phase !== phase) step = c.next(); assert.equal(step.status, "running", phase); assert.equal(step.result, null); c.dispose(); assert.equal(c.next().status, "disposed"); }
    for (const options of [{ maxOperations: 1 }, { maxPoints: 1 }, { maxClusters: 1 }]) { const c = createFontNormalizationCursor(original("AA"), cascade, options); assert.throws(() => finish(c), FontNormalizationLimitError); assert.equal(c.snapshot().result, null); assert.equal(c.snapshot().status, "failed"); c.dispose(); }
    const complex = createFontNormalizationCursor(original("A\u0327\u030a\u0301"), FontCascade.from([font([0x212b, 0x327, 0x301])]), { maxSearchStates: 1 }); assert.throws(() => finish(complex), /search-states/); complex.dispose();
});

test("canonical font layout retains every official extended-grapheme extent and canonical source meaning", async () => {
    const tables = fontTables(coverageFontFixture([])), mapping = new FontBytes(28).u16(0, 13).u32(4, 28).u32(12, 1).u32(16, 0).u32(20, 0x10ffff).u32(24, 2);
    tables.set("cmap", cmapTable([{ platform: 0, encoding: 6, bytes: mapping.data }])); const cascade = FontCascade.from([SfntFont.from(assembleFont(tables))]);
    const rows = gunzipSync(await readFile(new URL("fixtures/graphemes/GraphemeBreakTest.txt.gz", import.meta.url))).toString("utf8").trim().split(/\r?\n/); let sourceClusters = 0;
    for (const row of rows) { let text = ""; const boundaries: number[] = []; for (const token of row.split(/\s+/)) { if (token === "÷") boundaries.push(text.length); else if (token !== "×") text += String.fromCodePoint(parseInt(token, 16)); }
        const input = original(text), reads = input.source.readMetrics(), cursor = createFontNormalizationCursor(input, cascade), result = finish(cursor); cursor.dispose(); assert.equal(result.clusterCount, boundaries.length - 1); sourceClusters += result.clusterCount;
        for (let i = 0; i < result.clusterCount; i++) { const c = result.clusterAt(i); assert.deepEqual([c.sourceFrom, c.sourceTo], [boundaries[i], boundaries[i + 1]]); assert.equal(c.coverage, "covered"); }
        const segmented = createNormalizedGraphemeCursor(result.text); let p = segmented.next(); while (p.status === "running") p = segmented.next(); assert.equal(p.result!.clusterCount, result.clusterCount); segmented.dispose();
        assert.equal(normalizeText(TextBuffer.from(result.text.text()), { form: "NFD" }).text(), normalizeText(TextBuffer.from(text), { form: "NFD" }).text()); assert.deepEqual(input.source.readMetrics(), reads);
    } console.log(`Font grapheme invariance: ${rows.length} rows /${sourceClusters} source clusters.`);
});

test("search cancellation, copied font lists and work budgets retain captured immutable identities", () => {
    const fonts = [font([0xac02]), font([0xac01])], cascade = FontCascade.from(fonts); fonts[0] = fonts[1]!; assert.notEqual(cascade.at(0), fonts[0]);
    const c = createFontNormalizationCursor(original("각".repeat(1000)), cascade); let p = c.next(); while (p.status === "running" && p.phase !== "search") p = c.next(); assert.equal(p.status, "running"); assert.equal(p.result, null); c.dispose(); assert.equal(c.snapshot().status, "disposed");
    const input = original("A\u0327\u030a\u0301".repeat(1000)), aliases = FontCascade.from([font([0x212b, 0x327, 0x301])]);
    for (const budget of [256, 257, 511, 777, 4096]) { const cursor = createFontNormalizationCursor(input, aliases), result = finish(cursor, budget); assert.equal(result.clusterCount, 1000); cursor.dispose(); }
});
