import assert from "node:assert/strict";
import test from "node:test";
import { TextBuffer, SfntFont, normalizeText, itemizeScripts, createScriptGlyphCursor } from "../src/index.ts";
import type { GlyphMappingResult, ScriptIndex } from "../src/index.ts";
import { fontFixture } from "./fixtures/consumer/font-fixture.ts";
import { scriptFontFixture } from "./fixtures/script-layout.ts";
function finish<T>(cursor: Readonly<{ next: (budget?: number) => Readonly<{ status: string; workUnits: number; result: T | null }>; dispose: () => void }>, budget = 256): T { let work = 0; while (true) { const step = cursor.next(budget); assert.ok(step.workUnits - work <= budget + 256); work = step.workUnits; if (step.status === "ready") return step.result!; assert.equal(step.status, "running"); assert.equal(step.result, null); } }
const mapped = (font: SfntFont, source: string) => finish(font.createGlyphMappingCursor(normalizeText(TextBuffer.from(source), { form: "NFKD" })));

test("script partitions select conflicting font features independently and forbid a cross-script ligature", () => {
    const font = SfntFont.from(scriptFontFixture()), mapping = mapped(font, "Aαא"), scripts = itemizeScripts(mapping.text), cursor = createScriptGlyphCursor(mapping, scripts), parts = finish(cursor); cursor.dispose();
    assert.equal(parts.mapping, mapping); assert.equal(parts.scripts, scripts); assert.equal(parts.length, 3); const tags = { Latn: "latn", Grek: "grek", Hebr: "hebr" }, glyphs: number[] = []; let total = 0;
    for (let i = 0; i < parts.length; i++) { const part = parts.at(i), script = tags[part.script.script as keyof typeof tags], substitution = font.substitutionPlan({ script, features: [{ tag: "test" }] }).createCursor(part.glyphs), shaped = finish(substitution); substitution.dispose();
        assert.equal(shaped.selection.script, script); const positioned = font.positioningPlan({ script, features: [] }).createCursor(shaped), positionedResult = finish(positioned); positioned.dispose(); total += positionedResult.advances.total; glyphs.push(...shaped.glyphs.map(g => g.glyphId)); assert.deepEqual(shaped.glyphs[0]!.sources, [{ from: i, to: i + 1 }]); }
    assert.deepEqual(glyphs, [3, 4, 5]); assert.equal(total, 1300); assert.deepEqual(font.substitutionPlan({ features: [{ tag: "test" }] }).apply(mapping.run).glyphs.map(g => g.glyphId), [6, 2]);
    assert.equal(cursor.snapshot().result, null); assert.ok(Object.isFrozen(parts.at(0))); assert.ok(Object.isFrozen(parts)); assert.throws(() => parts.at(3));
});
test("generic glyph slices share immutable records across block boundaries and preserve source coordinates", () => {
    const font = SfntFont.from(fontFixture()), mapping = mapped(font, "ﬁAB ".repeat(100)), original = mapping.run, slice = original.slice(255, 490), nested = slice.slice(1, 230);
    assert.equal(slice.length, 235); assert.equal(nested.length, 229); for (let i = 0; i < nested.length; i++) assert.equal(nested.at(i), original.at(i + 256)); assert.equal(nested.font, font);
    const plan = font.substitutionPlan({ features: [{ tag: "liga" }] }), a = plan.apply(nested), cursor = plan.createCursor(nested), b = finish(cursor); cursor.dispose(); assert.deepEqual(b, a); assert.ok(Object.isFrozen(slice)); assert.equal(original.slice(0, 0).length, 0); assert.throws(() => original.slice(-1)); assert.throws(() => slice.slice(0, 236)); assert.throws(() => nested.at(229));
    const builder = font.createGlyphRunBuilder(); builder.append([{ glyphId: 2, source: { from: 90, to: 91 } }]); const nominal = builder.finish().slice(); builder.dispose(); assert.deepEqual(nominal.at(0).source, { from: 90, to: 91 });
});
test("empty selector-only runs, normalized ranges and compatibility origins retain exact ownership", () => {
    const font = SfntFont.from(fontFixture()), mapping = mapped(font, "\ufe0f\nﬁ"), scripts = itemizeScripts(mapping.text), cursor = createScriptGlyphCursor(mapping, scripts), parts = finish(cursor); cursor.dispose();
    assert.equal(parts.length, 3); assert.equal(parts.at(0).glyphs.length, 0); assert.equal(parts.at(1).glyphs.length, 1); assert.equal(parts.at(2).glyphs.length, 2); assert.deepEqual(parts.at(2).glyphs.at(0).sources, [{ from: 2, to: 3 }]); assert.deepEqual(parts.at(2).glyphs.at(1).sources, [{ from: 2, to: 3 }]);
    const subset = itemizeScripts(mapping.text, { from: 2, to: 4 }), selected = finish(createScriptGlyphCursor(mapping, subset)); assert.equal(selected.length, 1); assert.equal(selected.at(0).fromGlyph, 1); assert.equal(selected.at(0).toGlyph, 3);
    const empty = mapped(font, ""), emptyCursor = createScriptGlyphCursor(empty, itemizeScripts(empty.text)); assert.equal(finish(emptyCursor).length, 0); emptyCursor.dispose();
});
test("a range that splits an adjacent variation glyph fails without returning a partial partition", () => {
    const font = SfntFont.from(fontFixture()), mapping = mapped(font, "A\ufe0fB"); for (const options of [{ from: 1 }, { to: 1 }]) { const cursor = createScriptGlyphCursor(mapping, itemizeScripts(mapping.text, options)); assert.throws(() => finish(cursor), /bisects/); assert.equal(cursor.snapshot().status, "failed"); assert.equal(cursor.snapshot().result, null); cursor.dispose(); }
});
test("large partitions suspend, cancel private publication and retain completed input for replay", () => {
    const font = SfntFont.from(scriptFontFixture()), mapping = mapped(font, "Aαא".repeat(15_000)), scripts = itemizeScripts(mapping.text), cursor = createScriptGlyphCursor(mapping, scripts), step = cursor.next(4096);
    assert.equal(step.status, "running"); assert.ok(step.publishedParts > 0 && step.publishedParts < scripts.runCount); assert.equal(step.result, null); cursor.dispose(); cursor.dispose(); assert.equal(cursor.next().status, "disposed");
    const next = createScriptGlyphCursor(mapping, scripts), parts = finish(next, 4096); assert.equal(parts.length, 45_000); assert.equal(parts.at(44_999).glyphs.at(0), mapping.run.at(44_999)); assert.equal(next.snapshot().scannedGlyphs, 45_000); next.dispose(); assert.equal(parts.at(0).glyphs.length, 1);
});
test("partition input identities and limits are checked independently of structural lookalikes", () => {
    const font = SfntFont.from(fontFixture()), mapping = mapped(font, "AB"), scripts = itemizeScripts(mapping.text); assert.throws(() => createScriptGlyphCursor({ ...mapping } as GlyphMappingResult, scripts)); assert.throws(() => createScriptGlyphCursor(mapping, {} as ScriptIndex)); assert.throws(() => createScriptGlyphCursor(mapping, itemizeScripts(normalizeText(mapping.text.source))));
    const cursor = createScriptGlyphCursor(mapping, scripts, { maxOperations: 1 }); assert.throws(() => finish(cursor), /limit/); assert.equal(cursor.snapshot().status, "failed"); assert.equal(cursor.snapshot().result, null); cursor.dispose(); assert.throws(() => createScriptGlyphCursor(mapping, scripts, { maxOperations: 0 }));
});
