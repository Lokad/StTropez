import assert from "node:assert/strict";
import test from "node:test";
import { AdvanceIndex, SfntFont, TextBuffer, createGlyphRunBuilder, normalizeText } from "../src/index.ts";
import type { GlyphProperties, GlyphMappingCursor, GlyphMappingResult, PositioningCursor, PositioningResult, SubstitutionCursor, SubstitutionResult } from "../src/index.ts";
import { coverageFontFixture } from "./fixtures/font-coverage.ts";
import { assembleFont, fontTables } from "./fixtures/consumer/font-fixture.ts";
import { classes, coverageContext, extension, gdef, gsub, ligatures, lookup, multiple, reverse, single } from "./fixtures/substitution.ts";
import { anchor, cursivePos, markPos, singlePos } from "./fixtures/positioning.ts";
type Cursor = GlyphMappingCursor | SubstitutionCursor | PositioningCursor;
function finish(cursor: GlyphMappingCursor): GlyphMappingResult;
function finish(cursor: SubstitutionCursor): SubstitutionResult;
function finish(cursor: PositioningCursor): PositioningResult;
function finish(cursor: Cursor) { try { let previous = 0, s = cursor.next(256); while (true) { assert.ok(s.workUnits - previous <= 512); previous = s.workUnits;
    if (s.status === "ready") return s.result!; assert.equal(s.status, "running"); assert.equal(s.result, null); s = cursor.next(256); } } finally { cursor.dispose(); } }
function font(subs: readonly Uint8Array[] = [], positions: readonly Uint8Array[] = []): SfntFont {
    const tables = fontTables(coverageFontFixture([[65, 3], [0x200d, 2], [0x200c, 2], [0x301, 9]]));
    tables.set("GSUB", gsub(subs, { features: [{ tag: "test", lookups: subs.length ? [0] : [] }] }));
    tables.set("GPOS", gsub(positions, { features: [{ tag: "test", lookups: positions.map((_, i) => i) }] })); return SfntFont.from(assembleFont(tables));
}
const mapped = (f: SfntFont, value: string) => finish(f.createGlyphMappingCursor(normalizeText(TextBuffer.from(value), { form: "none" }), { variationSelectors: "preserve" }));
const shape = (f: SfntFont, value: string, features = [{ tag: "test" }]) => finish(f.substitutionPlan({ features }).createCursor(mapped(f, value).run));
const properties = (extra: Partial<GlyphProperties> = {}): GlyphProperties => ({ defaultIgnorable: false, zeroWidthJoiner: false, zeroWidthNonJoiner: false, variationSelector: false, substituted: false, ligated: false, ...extra });

test("mapping captures Unicode properties independently of missing glyphs, UTF-16 spans and consumed selectors", () => {
    const f = font(), value = "A\u200d\u200c\u00ad\u034f\u2060\u{e0061}\ufe0f\u180b\u180f\u{e0100}\u0000 \ud800", result = mapped(f, value);
    const expected = [0, 3, 5, 1, 1, 1, 1, 9, 9, 9, 9, 0, 0, 0]; assert.equal(result.run.length, expected.length);
    for (let i = 0; i < expected.length; i++) { const p = result.run.at(i).properties!, flags = +p.defaultIgnorable | +p.zeroWidthJoiner << 1 | +p.zeroWidthNonJoiner << 2 | +p.variationSelector << 3;
        assert.equal(flags, expected[i]); assert.equal(p.substituted, false); assert.equal(p.ligated, false); assert.ok(Object.isFrozen(p)); }
    assert.equal(result.run.at(6).glyphId, 0); assert.deepEqual(result.run.at(6).sources, [{ from: 6, to: 8 }]);
    const consumed = finish(f.createGlyphMappingCursor(normalizeText(TextBuffer.from("A\ufe0f"), { form: "none" }))); assert.equal(consumed.run.length, 1);
    assert.deepEqual(consumed.run.at(0).properties, properties()); assert.equal(consumed.run.at(0).sources.length, 2);
    const overlap = finish(f.createGlyphMappingCursor(normalizeText(TextBuffer.from("Á\u200d"), { form: "NFD" })));
    assert.deepEqual(overlap.run.at(0).sources, overlap.run.at(1).sources); assert.equal(overlap.run.at(1).properties!.defaultIgnorable, false); assert.equal(overlap.run.at(2).properties!.defaultIgnorable, true);
});

test("all substitution lookup types carry control lineage and distinguish substitutions from unmatched controls", () => {
    const cases = [
        { entries: [lookup(1, [single([2], [4])])], text: "\u200d", ids: [4] },
        { entries: [lookup(2, [multiple([2], [[4, 5]])])], text: "\u200d", ids: [4, 5] },
        { entries: [lookup(3, [multiple([2], [[4]])])], text: "\u200d", ids: [4] },
        { entries: [lookup(4, [ligatures([2], [[{ to: 6, rest: [3] }]])])], text: "\u200dA", ids: [6], mixed: true },
        { entries: [lookup(5, [coverageContext([[2], [3]], [[0, 1]])]), lookup(1, [single([2], [4])])], text: "\u200dA", ids: [4, 3] },
        { entries: [lookup(6, [coverageContext([[2]], [[0, 1]], [[3]], [[3]])]), lookup(1, [single([2], [4])])], text: "A\u200dA", ids: [3, 4, 3], index: 1 },
        { entries: [lookup(7, [extension(1, single([2], [4]))])], text: "\u200d", ids: [4] },
        { entries: [lookup(8, [reverse([2], [4], [[3]], [[3]])])], text: "A\u200dA", ids: [3, 4, 3], index: 1 }
    ];
    for (const c of cases) { const f = font(c.entries), output = shape(f, c.text); assert.deepEqual(output.glyphs.map(g => g.glyphId), c.ids); const p = output.glyphs[c.index ?? 0]!.properties!;
        assert.equal(p.substituted, true); assert.equal(p.zeroWidthJoiner, true); assert.equal(p.defaultIgnorable, !c.mixed); assert.equal(p.ligated, !!c.mixed);
        const placed = finish(f.positioningPlan({ features: [] }).createCursor(output)); assert.equal(placed.glyphs[c.index ?? 0]!.hidden, false); }
    const f = font([lookup(1, [single([3], [4])])]), unchanged = shape(f, "\u200dA"); assert.equal(unchanged.glyphs[0]!.properties!.substituted, false);
    assert.deepEqual(f.positioningPlan({ features: [] }).apply(unchanged).glyphs.map(g => g.hidden), [true, false]);
    const identity = font([lookup(1, [single([2], [2])])]); assert.equal(identity.positioningPlan({ features: [] }).apply(shape(identity, "\u200d")).glyphs[0]!.hidden, false);
});

test("ligatures merge all contributing properties, preserve exact components and survive later expansion", () => {
    const f = font([lookup(4, [ligatures([2], [[{ to: 6, rest: [2] }]])])]), first = shape(f, "\u200d\u200c");
    assert.deepEqual(first.glyphs[0]!.properties, properties({ defaultIgnorable: true, zeroWidthJoiner: true, zeroWidthNonJoiner: true, substituted: true, ligated: true }));
    assert.deepEqual(first.glyphs[0]!.components, [[{ from: 0, to: 1 }], [{ from: 1, to: 2 }]]);
    const tables = fontTables(coverageFontFixture([[65, 3], [0x200d, 2]])); tables.set("GSUB", gsub([lookup(4, [ligatures([2], [[{ to: 6, rest: [2] }]])]), lookup(2, [multiple([6], [[4, 5]])]) ]));
    const expandedFont = SfntFont.from(assembleFont(tables)), expanded = shape(expandedFont, "\u200d\u200d"); assert.deepEqual(expanded.glyphs.map(g => g.glyphId), [4, 5]);
    for (const g of expanded.glyphs) { assert.equal(g.properties!.ligated, true); assert.equal(g.properties!.substituted, true); assert.equal(g.components.length, 2); }
    const empty = expandedFont.substitutionPlan({ features: [] }).apply(expanded); assert.deepEqual(empty.glyphs, expanded.glyphs);
    const mixed = f.substitutionPlan({ features: [{ tag: "test" }] }).apply([{ glyphId: 2, source: { from: 0, to: 1 } }, { glyphId: 2, source: { from: 1, to: 2 }, properties: properties({ defaultIgnorable: true, zeroWidthJoiner: true }) }]);
    assert.equal(mixed.glyphs[0]!.properties!.defaultIgnorable, false); assert.equal(mixed.glyphs[0]!.properties!.zeroWidthJoiner, true);
});

test("hidden glyphs retain context through positioning but contribute no advance, offset or attachment in either direction", () => {
    const tables = fontTables(coverageFontFixture([[65, 3], [0x200d, 2]])); tables.set("GPOS", gsub([lookup(9, [extension(1, singlePos([2], [[45, 60, 125]]))]), lookup(7, [coverageContext([[2], [3]], [[1, 2]])]), lookup(1, [singlePos([3], [[10, 20, 50]])])], { features: [{ tag: "test", lookups: [0, 1] }] }));
    const actual = SfntFont.from(assembleFont(tables)), input = shape(actual, "\u200dA", []);
    for (const direction of ["ltr", "rtl"] as const) { const plan = actual.positioningPlan({ features: [{ tag: "test" }], direction }), result = finish(plan.createCursor(input));
        assert.deepEqual(result.glyphs.map(g => [g.hidden, g.xAdvance, g.xOffset, g.yOffset]), [[true, 0, 0, 0], [false, 750, 10, 20]]); assert.equal(result.glyphs[0]!.attachment, null);
        assert.equal(result.advances.total, direction === "ltr" ? 750 : -750); assert.equal(result.advances.prefix(1), 0); assert.equal(result.glyphs[0]!.source, input.glyphs[0]);
        const widths = AdvanceIndex.from([1234, 321]), overridden = finish(plan.createCursor(input, { advanceWidths: widths })); assert.equal(Math.abs(overridden.advances.total), 371); }
});

test("cursive distances start with zero hidden advances and hidden mark attachments are suppressed", () => {
    const tables = fontTables(coverageFontFixture([[65, 3], [66, 4], [0x200d, 2]])); tables.set("GDEF", gdef(classes(2, [3, 1, 1])));
    tables.set("GPOS", gsub([lookup(3, [cursivePos([3, 4], [{ exit: anchor(500, 40) }, { entry: anchor(0, 10) }])], 8)]));
    const f = SfntFont.from(assembleFont(tables)), result = f.positioningPlan({ features: [{ tag: "test" }] }).apply(shape(f, "A\u200dB", []));
    assert.deepEqual(result.glyphs.map(g => g.xAdvance), [500, 0, 400]); assert.equal(result.advances.total, 900); assert.equal(result.glyphs[2]!.y, 30);
    tables.set("GPOS", gsub([lookup(4, [markPos(4, [{ glyph: 2, markClass: 0, anchor: anchor(10, 20) }], [{ glyph: 3, components: [[anchor(300, 200)]] }], 1)])]));
    const marked = SfntFont.from(assembleFont(tables)), supplied = shape(marked, "A\u200d", []), hidden = marked.positioningPlan({ features: [{ tag: "test" }] }).apply(supplied), visible = marked.positioningPlan({ features: [{ tag: "test" }], defaultIgnorables: "preserve" }).apply(supplied);
    assert.equal(visible.glyphs[1]!.attachment!.kind, "mark"); assert.equal(hidden.glyphs[1]!.attachment, null); assert.deepEqual([hidden.glyphs[1]!.xOffset, hidden.glyphs[1]!.yOffset, hidden.glyphs[1]!.xAdvance], [0, 0, 0]);
});

test("preserve policy is captured; unannotated inputs remain visible and caller properties are copied and validated", () => {
    const f = font(), options = { features: [], defaultIgnorables: "preserve" as "hide" | "preserve" }, plan = f.positioningPlan(options); options.defaultIgnorables = "hide";
    const input = shape(f, "\u200dA", []), result = plan.apply(input); assert.equal(plan.defaultIgnorables, "preserve"); assert.deepEqual(result.glyphs.map(g => g.hidden), [false, false]); assert.equal(result.advances.total, 1300);
    const p = { ...properties({ defaultIgnorable: true }) }, builder = createGlyphRunBuilder(f); builder.append([{ glyphId: 2, source: { from: 0, to: 1 }, properties: p }]); p.defaultIgnorable = false;
    const run = builder.finish(); builder.dispose(); assert.equal(run.slice().at(0).properties!.defaultIgnorable, true); assert.ok(Object.isFrozen(run.at(0).properties));
    assert.equal(f.positioningPlan({ features: [] }).apply(f.substitutionPlan({ features: [] }).apply(run)).advances.total, 0);
    const raw = f.substitutionPlan({ features: [] }).apply([{ glyphId: 0, source: { from: 0, to: 1 } }]); assert.equal(raw.glyphs[0]!.properties, undefined); assert.equal(f.positioningPlan({ features: [] }).apply(raw).advances.total, 500);
    const unowned = { ...input, glyphs: input.glyphs.map(g => ({ ...g, properties: { ...g.properties! } })) }; const placed = f.positioningPlan({ features: [] }).apply(unowned); unowned.glyphs[0]!.properties.defaultIgnorable = false; assert.equal(placed.glyphs[0]!.source.properties!.defaultIgnorable, true);
    const bad = { ...properties(), substituted: 1 } as unknown as GlyphProperties; const b = createGlyphRunBuilder(f); assert.throws(() => b.append([{ glyphId: 2, source: { from: 0, to: 1 }, properties: bad }]), /properties/); b.dispose();
    assert.throws(() => f.substitutionPlan({ features: [] }).apply([{ glyphId: 2, source: { from: 0, to: 1 }, properties: bad }]), /properties/);
    assert.throws(() => f.positioningPlan({ features: [] }).apply({ ...input, glyphs: [{ ...input.glyphs[0]!, properties: bad }] }), /properties/);
    assert.throws(() => f.positioningPlan({ features: [], defaultIgnorables: "remove" as "hide" }), /visibility/);
});

test("visibility and publication remain cooperative, cancellable and retain only completed immutable results", () => {
    const f = font(), input = shape(f, "A\u200d".repeat(10_000), []), plan = f.positioningPlan({ features: [] });
    for (const phase of ["visibility", "publish"] as const) { const cursor = plan.createCursor(input); let s = cursor.next(256); while (s.status === "running" && s.phase !== phase) s = cursor.next(256); assert.equal(s.status, "running"); assert.equal(s.result, null); cursor.dispose(); assert.equal(cursor.next().status, "disposed"); assert.equal(cursor.snapshot().result, null); }
    const result = finish(plan.createCursor(input)); assert.equal(result.advances.total, 7_000_000); assert.equal(result.glyphs.filter(g => g.hidden).length, 10_000); assert.ok(Object.isFrozen(result.glyphs[1]!.source.properties));
    assert.equal(input.glyphs[1]!.properties!.substituted, false); assert.deepEqual(result.glyphs[1]!.source.sources, [{ from: 1, to: 2 }]);
});
