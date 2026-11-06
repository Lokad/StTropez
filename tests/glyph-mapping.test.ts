import assert from "node:assert/strict";
import test from "node:test";
import { GlyphMappingLimitError, SfntFont, TextBuffer, normalizeText, unicodeVariationSelector } from "../src/index.ts";
import type { GlyphMappingCursor, GlyphMappingResult, NormalizationForm } from "../src/index.ts";
import { fontFixture } from "./fixtures/consumer/font-fixture.ts";
function finish(cursor: GlyphMappingCursor, budget = 256): GlyphMappingResult { let previous = cursor.snapshot(); while (true) { const step = cursor.next(budget); assert.ok(step.workUnits - previous.workUnits <= budget + 260); if (step.status === "ready") return step.result!; assert.equal(step.status, "running"); assert.equal(step.result, null); previous = step; } }
const map = (font: SfntFont, text: string, form: NormalizationForm = "none") => finish(font.createGlyphMappingCursor(normalizeText(TextBuffer.from(text), { form })));

test("captured point ranges map absolute coordinates and reject cuts through consumed variation pairs", () => {
    const font = SfntFont.from(fontFixture()), text = normalizeText(TextBuffer.from("xA\ufe0fα"), { form: "none" }), options = { from: 1, to: 3 }, cursor = font.createGlyphMappingCursor(text, options); options.to = 4; const mapped = finish(cursor); cursor.dispose();
    assert.deepEqual([mapped.from, mapped.to, mapped.run.length], [1, 3, 1]); assert.equal(mapped.run.at(0).glyphId, 8); assert.deepEqual(mapped.pointRangeAt(0), { from: 1, to: 3 }); assert.deepEqual(mapped.run.at(0).sources, [{ from: 1, to: 2 }, { from: 2, to: 3 }]);
    for (const options of [{ from: 2, to: 3 }, { from: 1, to: 2 }, { from: -1 }, { to: 5 }]) assert.throws(() => font.createGlyphMappingCursor(text, options));
    const preserved = finish(font.createGlyphMappingCursor(text, { from: 2, to: 3, variationSelectors: "preserve" })); assert.equal(preserved.run.length, 1); assert.deepEqual(preserved.pointRangeAt(0), { from: 2, to: 3 });
    const empty = finish(font.createGlyphMappingCursor(text, { from: 2, to: 2 })); assert.equal(empty.run.length, 0); assert.equal(empty.from, 2);
});

test("compatibility normalization maps to owned glyphs and preserves repeated provenance through GSUB/positioning", () => {
    const font = SfntFont.from(fontFixture()), mapped = map(font, "ﬁAB", "NFKD"), plan = font.substitutionPlan({ features: [{ tag: "liga" }] }), substitution = plan.createCursor(mapped.run); let shaped = substitution.next(); while (shaped.status === "running") shaped = substitution.next(); const supplied = shaped.result!; substitution.dispose();
    assert.deepEqual(Array.from({ length: mapped.run.length }, (_, i) => mapped.run.at(i).glyphId), [4, 5, 2, 3]); assert.deepEqual(supplied.glyphs.map(g => g.glyphId), [6, 2, 3]); assert.deepEqual(supplied.glyphs[0]!.components, [[{ from: 0, to: 1 }], [{ from: 0, to: 1 }]]); const result = font.positioningPlan({ features: [], legacyKerning: true }).apply(supplied); assert.equal(result.advances.total, 1700); assert.deepEqual(mapped.pointRangeAt(3), { from: 3, to: 4 });
});

test("composed noncontiguous source points remain exact even when the font lacks the glyph", () => {
    const font = SfntFont.from(fontFixture()), mapped = map(font, "A\u0315\u0300", "NFC"); assert.equal(mapped.missingGlyphs, 2); assert.deepEqual(mapped.run.at(0).sources, [{ from: 0, to: 1 }, { from: 2, to: 3 }]); assert.deepEqual(mapped.run.at(1).sources, [{ from: 1, to: 2 }]); assert.equal(mapped.run.at(1).glyphClass, 3); assert.deepEqual(mapped.pointRangeAt(0), { from: 0, to: 1 });
});

test("standard selectors use cmap14, retain pair origins and report unsupported or standalone selectors", () => {
    const font = SfntFont.from(fontFixture()), selected = map(font, "A\ufe0f"); assert.equal(selected.run.length, 1); assert.equal(selected.run.at(0).glyphId, 8); assert.deepEqual(selected.run.at(0).sources, [{ from: 0, to: 1 }, { from: 1, to: 2 }]); assert.deepEqual(selected.pointRangeAt(0), { from: 0, to: 2 }); assert.equal(selected.unsupportedVariations, 0);
    const unsupported = map(font, "A\u{e0100}"); assert.equal(unsupported.run.at(0).glyphId, 2); assert.equal(unsupported.unsupportedVariations, 1); assert.deepEqual(unsupported.run.at(0).sources, [{ from: 0, to: 1 }, { from: 1, to: 3 }]); const ignored = map(font, "\ufe0fA"); assert.equal(ignored.ignoredSelectors, 1); assert.equal(ignored.run.length, 1); assert.deepEqual(ignored.run.at(0).sources, [{ from: 1, to: 2 }]);
});

test("selector preservation and Mongolian selectors remain available for explicit script policy", () => {
    const font = SfntFont.from(fontFixture()), text = normalizeText(TextBuffer.from("A\ufe0f"), { form: "none" }), mapped = finish(font.createGlyphMappingCursor(text, { variationSelectors: "preserve" })); assert.deepEqual([mapped.run.at(0).glyphId, mapped.run.at(1).glyphId], [2, 0]); assert.equal(mapped.missingGlyphs, 1); assert.equal(mapped.run.at(1).glyphClass, 3);
    assert.equal(unicodeVariationSelector(0x180b), true); assert.equal(unicodeVariationSelector(0x180f), true); const mongolian = map(font, "\u1820\u180b"); assert.equal(mongolian.run.length, 2); assert.equal(mongolian.ignoredSelectors, 0); assert.equal(mongolian.unsupportedVariations, 0);
});

test("supplementary points map once and raw unpaired code units retain their original spans", () => {
    const font = SfntFont.from(fontFixture()), mapped = map(font, "😀\ud800"); assert.equal(mapped.run.length, 2); assert.equal(mapped.run.at(0).glyphId, 7); assert.deepEqual(mapped.run.at(0).sources, [{ from: 0, to: 2 }]); assert.equal(mapped.unpairedSurrogates, 1); assert.equal(mapped.missingGlyphs, 1); assert.deepEqual(mapped.run.at(1).sources, [{ from: 2, to: 3 }]);
});

test("mapping captures owned text/options and cancellation leaves source reusable without partial runs", () => {
    const bytes = fontFixture(), font = SfntFont.from(bytes), text = normalizeText(TextBuffer.from("A".repeat(20_000)), { form: "none" }), options = { maxOperations: 100_000 }, cursor = font.createGlyphMappingCursor(text, options); options.maxOperations = 1; bytes.fill(0); const pending = cursor.next(256); assert.equal(pending.status, "running"); assert.ok(pending.mappedGlyphs > 0); assert.equal(pending.result, null); cursor.dispose(); assert.equal(cursor.snapshot().result, null); assert.equal(cursor.next().status, "disposed");
    const second = font.createGlyphMappingCursor(text), result = finish(second); second.dispose(); assert.equal(result.run.length, 20_000); assert.equal(result.run.at(0).glyphId, 2); assert.equal(result.text, text); assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.pointRangeAt(0))); assert.throws(() => result.pointRangeAt(20_000));
});

test("mapping limits and unowned text reject unsafe capture without partial results", () => {
    const font = SfntFont.from(fontFixture()), text = normalizeText(TextBuffer.from("A".repeat(1000)), { form: "none" }); assert.throws(() => font.createGlyphMappingCursor({ ...text } as typeof text), /owned immutable/); const limited = font.createGlyphMappingCursor(text, { maxGlyphs: 10 }); assert.throws(() => limited.next(), (error: unknown) => error instanceof GlyphMappingLimitError && error.limit === "glyphs"); assert.equal(limited.snapshot().status, "failed"); assert.equal(limited.snapshot().result, null); limited.dispose();
    const operations = font.createGlyphMappingCursor(text, { maxOperations: 10 }); assert.throws(() => operations.next(), GlyphMappingLimitError); operations.dispose(); const empty = map(font, ""); assert.equal(empty.run.length, 0); assert.equal(empty.missingGlyphs, 0); assert.throws(() => empty.pointRangeAt(0));
});
