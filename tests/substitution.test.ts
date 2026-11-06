import assert from "node:assert/strict";
import test from "node:test";
import { SfntFont, SubstitutionLimitError } from "../src/index.ts";
import type { SubstitutionInputGlyph } from "../src/index.ts";
import { FontBytes, assembleFont, fontFixture, fontTables } from "./fixtures/consumer/font-fixture.ts";
import { classes, contexts, coverageContext, extension, fontWithSubstitution, gdef, gsub, language, ligatures, lookup, multiple, ranges, reverse, script, single, variations } from "./fixtures/substitution.ts";

const input = (ids: readonly number[]): SubstitutionInputGlyph[] => ids.map((glyphId, from) => ({ glyphId, source: { from, to: from + 1 } }));
const planFor = (lookups: readonly Uint8Array[], definition?: Uint8Array) => SfntFont.from(fontWithSubstitution(gsub(lookups), definition)).substitutionPlan({ features: [{ tag: "test" }] });
const ids = (result: ReturnType<ReturnType<typeof planFor>["apply"]>) => result.glyphs.map(g => g.glyphId);
const nested = (first: Uint8Array, second = lookup(1, [single([3], [5])]), definition?: Uint8Array) => SfntFont.from(fontWithSubstitution(gsub([first, second], { features: [{ tag: "test", lookups: [0] }] }), definition)).substitutionPlan({ features: [{ tag: "test" }] });
const glyphDefinition = gdef(classes(0, [0, 1, 1, 1, 1, 1, 2, 1, 2, 3]));

test("the original font substitutes a real ligature with immutable component/source and font identities", () => {
    const bytes = fontFixture(), font = SfntFont.from(bytes), plan = font.substitutionPlan({ features: [{ tag: "liga" }] }); bytes.fill(0);
    const original = input([4, 5]), result = plan.apply(original); assert.deepEqual(ids(result), [6]); assert.equal(result.font, font); assert.equal(result.selection, plan.selection);
    assert.deepEqual(result.glyphs[0]!.components, [[{ from: 0, to: 1 }], [{ from: 1, to: 2 }]]); assert.equal(font.nominalGlyphMetrics(result.glyphs[0]!.glyphId).advanceWidth, 500);
    (original[0] as { source: { from: number } }).source.from = 99; assert.equal(result.glyphs[0]!.sources[0]!.from, 0);
    for (const value of [plan, plan.selection, plan.selection.features, plan.selection.features[0], plan.selection.features[0]!.lookups, result, result.glyphs, result.glyphs[0], result.glyphs[0]!.components, result.glyphs[0]!.components[0], result.glyphs[0]!.sources[0]]) assert.ok(Object.isFrozen(value));
    assert.deepEqual(ids(font.substitutionPlan({ features: [] }).apply(input([4, 5]))), [4, 5]);
});

test("script/language selection includes required features and orders distinct lookups by font order", () => {
    const bytes = gsub([lookup(1, [single([2], [3])]), lookup(1, [single([3], [4])]), lookup(1, [single([4], [5])])], {
        features: [{ tag: "liga", lookups: [2] }, { tag: "locl", lookups: [1] }, { tag: "rlig", lookups: [0] }],
        scripts: [{ tag: "DFLT", bytes: script(language([0, 1], 2)) }, { tag: "latn", bytes: script(language([0]), [{ tag: "TRK ", bytes: language([1], 2) }]) }]
    }), font = SfntFont.from(fontWithSubstitution(bytes));
    const selected = font.substitutionPlan({ script: "latn", language: "TRK ", features: [{ tag: "rlig", value: 0 }, { tag: "locl" }] });
    assert.deepEqual(selected.selection.lookups, [0, 1]); assert.deepEqual(ids(selected.apply(input([2]))), [4]); assert.equal(selected.selection.features[0]!.required, true);
    assert.equal(font.substitutionPlan({ script: "arab", features: [] }).selection.script, "DFLT");
    assert.equal(font.substitutionPlan({ script: "latn", language: "ENG ", features: [] }).selection.language, null);
    const noDefault = SfntFont.from(fontWithSubstitution(gsub([], { scripts: [{ tag: "latn", bytes: script(null, [{ tag: "TRK ", bytes: language([]) }]) }] })));
    assert.equal(noDefault.substitutionPlan({ script: "arab", features: [] }).selection.script, null); assert.deepEqual(noDefault.substitutionPlan({ script: "latn", features: [] }).selection.lookups, []);
});

test("single formats use indexed coverage, signed modulo deltas and first matching subtable semantics", () => {
    const indexed = planFor([lookup(1, [single([1, 2, 3], [4, 5, 6], ranges([[1, 3, 0]]))])]); assert.deepEqual(ids(indexed.apply(input([0, 1, 2, 3]))), [0, 4, 5, 6]);
    assert.deepEqual(ids(planFor([lookup(1, [single([2], -1)])]).apply(input([2]))), [1]);
    assert.deepEqual(ids(planFor([lookup(1, [single([2], [3]), single([3], [4])])]).apply(input([2]))), [3]);
    const tables = fontTables(fontWithSubstitution(gsub([lookup(1, [single([65534], 2)])]))); new DataView(tables.get("maxp")!.buffer).setUint16(4, 65535);
    new DataView(tables.get("hhea")!.buffer).setUint16(34, 1); tables.set("hmtx", new Uint8Array(4 + 65534 * 2));
    const wrap = SfntFont.from(assembleFont(tables)).substitutionPlan({ features: [{ tag: "test" }] }); assert.deepEqual(ids(wrap.apply(input([65534]))), [0]);
});

test("multiple substitutions preserve provenance without revisiting outputs and alternate values select explicitly", () => {
    const font = SfntFont.from(fontWithSubstitution(gsub([lookup(2, [multiple([2], [[4, 5]])]), lookup(3, [multiple([4], [[6, 8]])])])));
    const result = font.substitutionPlan({ features: [{ tag: "test", value: 2 }] }).apply(input([2, 2])); assert.deepEqual(ids(result), [8, 5, 8, 5]);
    assert.deepEqual(result.glyphs.map(g => g.sources), [[{ from: 0, to: 1 }], [{ from: 0, to: 1 }], [{ from: 1, to: 2 }], [{ from: 1, to: 2 }]]);
    assert.deepEqual(ids(font.substitutionPlan({ features: [{ tag: "test", value: 3 }] }).apply(input([2]))), [4, 5]);
    assert.deepEqual(ids(planFor([lookup(2, [multiple([2], [[2, 2]])])]).apply(input([2]))), [2, 2]);
});

test("ligature preference skips marks while preserving each mark's component association", () => {
    const plan = planFor([lookup(4, [ligatures([2], [[{ to: 8, rest: [3, 4] }, { to: 6, rest: [3] }]])], 8)], glyphDefinition), result = plan.apply(input([2, 9, 3, 9, 4, 3]));
    assert.deepEqual(ids(result), [8, 9, 9, 3]); assert.deepEqual(result.glyphs[0]!.sources, [{ from: 0, to: 1 }, { from: 2, to: 3 }, { from: 4, to: 5 }]);
    assert.deepEqual(result.glyphs[1]!.attachment, { glyphIndex: 0, component: 0 }); assert.deepEqual(result.glyphs[2]!.attachment, { glyphIndex: 0, component: 1 });
    assert.deepEqual(ids(plan.apply(input([2, 3]))), [6]);
});

test("mark filtering sets supersede attachment classes and IgnoreMarks supersedes both", () => {
    const definition = gdef(classes(0, [0, 1, 1, 1, 1, 1, 2, 3, 2, 3]), classes(7, [2, 0, 1]), [[9]]), ligature = ligatures([2], [[{ to: 6, rest: [3] }]]);
    const filtered = planFor([lookup(4, [ligature], 0x110)], definition); assert.deepEqual(ids(filtered.apply(input([2, 7, 3]))), [6, 7]); assert.deepEqual(ids(filtered.apply(input([2, 9, 3]))), [2, 9, 3]);
    assert.deepEqual(ids(planFor([lookup(4, [ligature], 0x118)], definition).apply(input([2, 9, 7, 3]))), [6, 9, 7]);
    assert.deepEqual(ids(planFor([lookup(4, [ligature], 0x100)], definition).apply(input([2, 7, 3]))), [6, 7]);
});

test("all three contextual formats match glyph, class and coverage sequences", () => {
    const rule = { rest: [3, 4], actions: [[1, 1]] as const }, classRule = { rest: [2, 3], actions: [[1, 1]] as const }, definition = classes(0, [0, 0, 1, 2, 3]);
    for (const subtable of [contexts([2], [[rule]]), contexts([2], [null, [classRule]], { inputClass: definition }), coverageContext([[2], [3], [4]], [[1, 1]])]) {
        const plan = nested(lookup(5, [subtable])); assert.deepEqual(ids(plan.apply(input([2, 3, 4, 3]))), [2, 5, 4, 3]); assert.deepEqual(ids(plan.apply(input([2, 4, 3]))), [2, 4, 3]);
    }
});

test("all chained formats use closest-first backtrack and unmodified lookahead context", () => {
    const rule = { rest: [3], back: [6, 7], ahead: [8, 9], actions: [[1, 1]] as const }, classRule = { rest: [2], back: [1, 2], ahead: [1, 2], actions: [[1, 1]] as const };
    const backClass = classes(6, [1, 2]), inputClass = classes(2, [1, 2]), aheadClass = classes(8, [1, 2]);
    for (const subtable of [contexts([2], [[rule]], { chain: true }), contexts([2], [null, [classRule]], { chain: true, backClass, inputClass, aheadClass }), coverageContext([[2], [3]], [[1, 1]], [[6], [7]], [[8], [9]])]) {
        const plan = nested(lookup(6, [subtable])); assert.deepEqual(ids(plan.apply(input([7, 6, 2, 3, 8, 9]))), [7, 6, 2, 5, 8, 9]); assert.deepEqual(ids(plan.apply(input([6, 7, 2, 3, 8, 9]))), [6, 7, 2, 3, 8, 9]);
    }
});

test("context action indices address the sequence after earlier expansion or contraction", () => {
    const expansion = SfntFont.from(fontWithSubstitution(gsub([lookup(5, [contexts([2], [[{ rest: [3], actions: [[0, 1], [3, 2]] }]])]), lookup(2, [multiple([2], [[4, 5, 4]])]), lookup(1, [single([3], [8])])], { features: [{ tag: "test", lookups: [0] }] })));
    assert.deepEqual(ids(expansion.substitutionPlan({ features: [{ tag: "test" }] }).apply(input([2, 3]))), [4, 5, 4, 8]);
    const contraction = SfntFont.from(fontWithSubstitution(gsub([lookup(5, [contexts([2], [[{ rest: [3, 4, 5], actions: [[1, 1], [2, 2]] }]])]), lookup(4, [ligatures([3], [[{ to: 6, rest: [4] }]])]), lookup(1, [single([5], [8])])], { features: [{ tag: "test", lookups: [0] }] })));
    const result = contraction.substitutionPlan({ features: [{ tag: "test" }] }).apply(input([2, 3, 4, 5])); assert.deepEqual(ids(result), [2, 6, 8]); assert.equal(result.glyphs[1]!.components.length, 2);
});

test("parent filtering affects initial context matching while nested lookup flags control each action", () => {
    const program = gsub([lookup(5, [contexts([2], [[{ rest: [3], actions: [[0, 1], [1, 2]] }]])], 8), lookup(1, [single([2], [9])]), lookup(1, [single([3], [8])])], { features: [{ tag: "test", lookups: [0] }] });
    const plan = SfntFont.from(fontWithSubstitution(program, glyphDefinition)).substitutionPlan({ features: [{ tag: "test" }] }); assert.deepEqual(ids(plan.apply(input([2, 9, 3]))), [9, 9, 8]);
    const consumed = nested(lookup(5, [contexts([2], [[{ rest: [3], actions: [[0, 1]] }]])], 8), lookup(4, [ligatures([2], [[{ to: 6, rest: [9, 3] }]])]), glyphDefinition);
    assert.deepEqual(ids(consumed.apply(input([2, 9, 3]))), [6]);
    const ignored = nested(lookup(5, [contexts([9], [[{ rest: [], actions: [[0, 1]] }]])]), lookup(1, [single([9], [8])], 8), glyphDefinition); assert.deepEqual(ids(ignored.apply(input([9]))), [9]);
});

test("reverse chaining observes substitutions already made to its right, including through extension lookups", () => {
    const subtable = reverse([2], [3], [], [[3]]);
    for (const entry of [lookup(8, [subtable]), lookup(7, [extension(8, subtable)])]) assert.deepEqual(ids(planFor([entry]).apply(input([2, 2, 2, 3]))), [3, 3, 3, 3]);
    const bytes = single([2], [8]), wide = new FontBytes(70008 + bytes.length).u16(0, 1).u16(2, 1).u32(4, 70008).put(70008, bytes);
    assert.deepEqual(ids(planFor([lookup(7, [wide.data])]).apply(input([2]))), [8]);
});

test("a matched no-action context blocks later subtables and nested ligatures can consume beyond the parent input", () => {
    const blocked = nested(lookup(5, [contexts([2], [[{ rest: [], actions: [] }]]), contexts([2], [[{ rest: [], actions: [[0, 1]] }]])]), lookup(1, [single([2], [8])])); assert.deepEqual(ids(blocked.apply(input([2]))), [2]);
    const complete = nested(lookup(5, [contexts([2], [[{ rest: [], actions: [[0, 1]] }]])]), lookup(4, [ligatures([2], [[{ to: 6, rest: [3] }]])])); assert.deepEqual(ids(complete.apply(input([2, 3, 2, 3]))), [6, 6]);
});

test("feature variations choose the first matching supported record using explicit normalized axes", () => {
    const replacement = (lookupIndex: number) => [{ feature: 0, lookups: [lookupIndex] }], fv = variations([{ conditions: [[0, .5, 1]], replacements: replacement(1) }, { conditions: null, replacements: replacement(2) }]);
    const axes = new FontBytes(36).u32(0, 0x10000).u16(4, 16).u16(6, 2).u16(8, 1).u16(10, 20).u16(14, 4);
    const font = SfntFont.from(fontWithSubstitution(gsub([lookup(1, [single([2], [3])]), lookup(1, [single([2], [4])]), lookup(1, [single([2], [5])])], { variations: fv }), undefined, axes.data));
    const normal = font.substitutionPlan({ features: [{ tag: "test" }] }), heavy = font.substitutionPlan({ features: [{ tag: "test" }], normalizedCoordinates: [.75] });
    assert.equal(normal.selection.featureVariation, 1); assert.equal(heavy.selection.featureVariation, 0); assert.deepEqual(ids(normal.apply(input([2]))), [5]); assert.deepEqual(ids(heavy.apply(input([2]))), [4]);
    assert.throws(() => font.substitutionPlan({ features: [], normalizedCoordinates: [2] })); assert.throws(() => font.substitutionPlan({ features: [], normalizedCoordinates: [] }));
});

test("staged ligatures retain source components and remap previous and newly skipped marks", () => {
    const bytes = gsub([lookup(4, [ligatures([2], [[{ to: 6, rest: [3] }]])], 8), lookup(4, [ligatures([6], [[{ to: 8, rest: [4] }]])], 8)], { features: [{ tag: "liga", lookups: [0] }, { tag: "rlig", lookups: [1] }] });
    const font = SfntFont.from(fontWithSubstitution(bytes, glyphDefinition)), first = font.substitutionPlan({ features: [{ tag: "liga" }] }).apply(input([2, 9, 3, 9, 4])), next = font.substitutionPlan({ features: [{ tag: "rlig" }] }).apply(first.glyphs);
    assert.deepEqual(ids(first), [6, 9, 9, 4]); assert.deepEqual(ids(next), [8, 9, 9]); assert.equal(next.glyphs[0]!.components.length, 3);
    assert.deepEqual(next.glyphs.slice(1).map(g => g.attachment), [{ glyphIndex: 0, component: 0 }, { glyphIndex: 0, component: 1 }]); assert.equal(first.glyphs[0]!.components.length, 2);
    const all = font.substitutionPlan({ features: [{ tag: "liga" }, { tag: "rlig" }] }).apply(input([2, 9, 3, 9, 4])); assert.deepEqual(next.glyphs, all.glyphs);
});

test("execution budgets abort recursion, expansion and work without mutating input or the plan", () => {
    const cycle = nested(lookup(5, [contexts([2], [[{ rest: [], actions: [[0, 0]] }]])])); assert.throws(() => cycle.apply(input([2]), { maxDepth: 4 }), (e: unknown) => e instanceof SubstitutionLimitError && e.limit === "depth");
    const plan = planFor([lookup(2, [multiple([2], [[2, 2]])])]), original = input([2]), before = structuredClone(original);
    assert.throws(() => plan.apply(original, { maxGlyphs: 1 }), SubstitutionLimitError); assert.throws(() => plan.apply(original, { maxOperations: 1 }), SubstitutionLimitError); assert.deepEqual(original, before); assert.deepEqual(ids(plan.apply(original)), [2, 2]);
});

test("invalid offsets, glyphs, definitions and source mappings cannot publish partial substitution results", () => {
    const bytes = gsub([lookup(4, [ligatures([4], [[{ to: 6, rest: [5] }]])])]);
    for (let end = 0; end < bytes.length; end += 7) assert.throws(() => SfntFont.from(fontWithSubstitution(bytes.slice(0, end))).substitutionPlan({ features: [{ tag: "test" }] }));
    for (const entry of [lookup(1, [single([2], [10])]), lookup(2, [multiple([2], [[]])]), lookup(7, [extension(7, single([2], [3]))]), lookup(1, [single([2], [3])], 0x20), lookup(1, [single([2], [3])], 8)]) assert.throws(() => planFor([entry]));
    assert.throws(() => nested(lookup(5, [contexts([2], [[{ rest: [], actions: [[0, 3]] }]])])));
    const plan = planFor([]); for (const data of [[{ glyphId: 10, source: { from: 0, to: 1 } }], [{ glyphId: 2, source: { from: -1, to: 1 } }], [{ glyphId: 2, glyphClass: 0, sources: [], components: [], attachment: null }]]) assert.throws(() => plan.apply(data));
    const original = plan.apply(input([2, 3])).glyphs; assert.throws(() => plan.apply(original.map((g, i) => ({ ...g, attachment: { glyphIndex: 1 - i, component: 0 } }))));
});

test("base/ligature filtering uses range classes and absent GSUB remains an immutable no-op", () => {
    const definition = gdef(ranges([[2, 3, 1], [6, 6, 2], [9, 9, 3]]));
    assert.deepEqual(ids(planFor([lookup(1, [single([2], [8])], 2)], definition).apply(input([2]))), [2]);
    assert.deepEqual(ids(planFor([lookup(1, [single([6], [8])], 4)], definition).apply(input([6]))), [6]);
    const tables = fontTables(fontFixture()); tables.delete("GSUB"); const font = SfntFont.from(assembleFont(tables)), plan = font.substitutionPlan({ features: [{ tag: "liga" }] });
    assert.deepEqual(plan.selection.lookups, []); assert.deepEqual(ids(plan.apply(input([2, 3]))), [2, 3]); assert.equal(plan.selection.script, null);
    assert.throws(() => font.substitutionPlan({ features: [{ tag: "liga" }, { tag: "liga" }] })); assert.throws(() => font.substitutionPlan({ script: "bad", features: [] }));
});

test("unknown variation conditions and unsupported substitution versions allow later matching records", () => {
    const axes = new FontBytes(36).u32(0, 0x10000).u16(4, 16).u16(6, 2).u16(8, 1).u16(10, 20).u16(14, 4);
    for (const mode of ["condition", "version", "axis"]) {
        const fv = variations([{ conditions: [[0, .5, 1]], replacements: [{ feature: 0, lookups: [1] }] }, { conditions: null, replacements: [{ feature: 0, lookups: [2] }] }]), view = new DataView(fv.buffer), conditions = view.getUint32(8), first = conditions + view.getUint32(conditions + 2);
        if (mode === "condition") view.setUint16(first, 99); else if (mode === "axis") view.setUint16(first + 2, 1); else view.setUint32(view.getUint32(12), 0x20000);
        const font = SfntFont.from(fontWithSubstitution(gsub([lookup(1, [single([2], [3])]), lookup(1, [single([2], [4])]), lookup(1, [single([2], [5])])], { variations: fv }), undefined, axes.data));
        const plan = font.substitutionPlan({ features: [{ tag: "test" }], normalizedCoordinates: [.75] }); assert.equal(plan.selection.featureVariation, 1); assert.deepEqual(ids(plan.apply(input([2]))), [5]);
    }
});

test("linked edits match an independent flat sequence oracle across repeated generated glyph inputs", () => {
    const plan = planFor([lookup(1, [single([2], [3])]), lookup(2, [multiple([3], [[4, 5]])]), lookup(4, [ligatures([4], [[{ to: 6, rest: [5] }]])])]); let random = 0x217a;
    for (let run = 0; run < 200; run++) {
        const sequence = Array.from({ length: 40 }, () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random % 10; }), original = input(sequence);
        const reference = sequence.map((glyphId, from) => ({ glyphId: glyphId === 2 ? 3 : glyphId, components: [[{ from, to: from + 1 }]] }));
        for (let i = 0; i < reference.length; i++) if (reference[i]!.glyphId === 3) { const components = reference[i]!.components; reference.splice(i, 1, { glyphId: 4, components }, { glyphId: 5, components }); i++; }
        for (let i = 0; i + 1 < reference.length; i++) if (reference[i]!.glyphId === 4 && reference[i + 1]!.glyphId === 5) reference.splice(i, 2, { glyphId: 6, components: [...reference[i]!.components, ...reference[i + 1]!.components] });
        assert.deepEqual(plan.apply(original).glyphs.map(g => ({ glyphId: g.glyphId, components: g.components })), reference); assert.deepEqual(original, input(sequence));
    }
});
