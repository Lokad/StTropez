import assert from "node:assert/strict";
import test from "node:test";
import { SfntFont, PositioningLimitError } from "../src/index.ts";
import type { PositioningOptions, PositioningPlan } from "../src/index.ts";
import { FontBytes, assembleFont, fontFixture, fontTables } from "./fixtures/consumer/font-fixture.ts";
import { classes, contexts, coverageContext, gdef, gsub, ligatures, lookup, ranges, variations, words } from "./fixtures/substitution.ts";
import { anchor, cursivePos, device, fvarAxis, itemVariationStore, kernClass, kernPairs, markPos, pairClassPos, pairPos, positionFont, singlePos, variableDefinition, variationIndex } from "./fixtures/positioning.ts";
const input = (font: SfntFont, glyphs: readonly number[], features: PositioningOptions["features"] = []) => font.substitutionPlan({ features }).apply(glyphs.map((glyphId, from) => ({ glyphId, source: { from, to: from + 1 } })));
const planFor = (lookups: readonly Uint8Array[], options: Readonly<{ definition?: Uint8Array; selected?: readonly number[] }> = {}, plan: Partial<PositioningOptions> = {}): PositioningPlan => SfntFont.from(positionFont(lookups, { feature: "test", ...options })).positioningPlan({ features: [{ tag: "test" }], ...plan });
const run = (plan: PositioningPlan, glyphs: readonly number[]) => plan.apply(input(plan.font, glyphs));
const markDefinition = gdef(classes(0, [0, 1, 1, 1, 1, 1, 2, 3, 2, 3]));

test("owned positioning combines actual substitutions and explicit legacy kerning into retained advances", () => {
    const bytes = fontFixture(), font = SfntFont.from(bytes), shaped = input(font, [4, 5, 2, 3], [{ tag: "liga" }]), plan = font.positioningPlan({ features: [], legacyKerning: true }); bytes.fill(0);
    const result = plan.apply(shaped); assert.equal(result.font, font); assert.equal(result.advances.total, 1700); assert.deepEqual(result.glyphs.map(g => g.x), [0, 500, 1000]); assert.equal(result.advances.prefix(2), 1000);
    assert.deepEqual(result.glyphs[0]!.source.components, [[{ from: 0, to: 1 }], [{ from: 1, to: 2 }]]); assert.equal(result.legacyKerning, true);
    assert.equal(font.positioningPlan({ features: [] }).apply(shaped).advances.total, 1800);
    for (const value of [result, result.glyphs, result.glyphs[0], result.glyphs[0]!.source, result.glyphs[0]!.source.components[0], result.advances]) assert.ok(Object.isFrozen(value));
});

test("single formats adjust both placement axes and horizontal advances while ignoring vertical advance fields", () => {
    const shared = run(planFor([lookup(1, [singlePos([2, 3], [[10, 20, -100, 500]])])]), [2, 3]);
    assert.deepEqual(shared.glyphs.map(g => [g.x, g.y, g.xAdvance]), [[10, 20, 500], [510, 20, 600]]); assert.equal(shared.advances.total, 1100);
    const indexed = run(planFor([lookup(1, [singlePos([2, 3], [[10, 20, -100], [30, -40, 50]])])]), [2, 3]);
    assert.deepEqual(indexed.glyphs.map(g => [g.x, g.y, g.xAdvance]), [[10, 20, 500], [530, -40, 750]]);
    const rtl = run(planFor([lookup(1, [singlePos([2, 3], [[10, 20, -100]])])], {}, { direction: "rtl" }), [2, 3]);
    assert.equal(rtl.advances.total, -1100); assert.deepEqual(rtl.glyphs.map(g => g.x), [-490, -1090]);
});

test("pair list formats support both records and the specified overlapping-pair scan policy", () => {
    const first = planFor([lookup(2, [pairPos([{ first: 2, pairs: [{ second: 3, firstValue: [undefined, undefined, -100], secondValue: [20, undefined, -50] }] }])])]);
    const result = run(first, [2, 3, 3]); assert.equal(result.advances.total, 1850); assert.deepEqual(result.glyphs.map(g => g.x), [0, 520, 1150]);
    const sets = [{ first: 2, pairs: [{ second: 3, firstValue: [undefined, undefined, -100] }] }, { first: 3, pairs: [{ second: 3, firstValue: [undefined, undefined, -10] }] }];
    assert.equal(run(planFor([lookup(2, [pairPos(sets)])]), [2, 3, 3]).advances.total, 1890);
    const consumed = sets.map(set => ({ ...set, pairs: set.pairs.map(pair => ({ ...pair, secondValue: [0] })) })); assert.equal(run(planFor([lookup(2, [pairPos(consumed)])]), [2, 3, 3]).advances.total, 1900);
});

test("pair class matrices include implicit class zero and both class definition formats", () => {
    for (const defs of [[classes(2, [1]), classes(3, [1])], [ranges([[2, 2, 1]]), ranges([[3, 3, 1]])]]) {
        const zero = { first: [undefined, undefined, 0] }, kern = { first: [undefined, undefined, -100] }, plan = planFor([lookup(2, [pairClassPos([2], defs[0]!, defs[1]!, [[zero, zero], [zero, kern]])])]);
        const result = run(plan, [2, 3, 2, 0]); assert.equal(result.advances.total, 2300); assert.deepEqual(result.glyphs.map(g => g.xAdvance), [500, 700, 600, 500]);
    }
});

test("all contextual formats apply nested positioning to the full matched glyph sequence", () => {
    const action = [[1, 1]] as const;
    for (const table of [contexts([2], [[{ rest: [3, 4], actions: action }]]), contexts([2], [null, [{ rest: [2, 3], actions: action }]], { inputClass: classes(2, [1, 2, 3]) }), coverageContext([[2], [3], [4]], action)]) {
        const plan = planFor([lookup(7, [table]), lookup(1, [singlePos([3], [[undefined, 80, -100]])])], { selected: [0] }), result = run(plan, [2, 3, 4, 3]);
        assert.deepEqual(result.glyphs.map(g => g.y), [0, 80, 0, 0]); assert.deepEqual(result.glyphs.map(g => g.xAdvance), [600, 600, 400, 700]);
    }
});

test("all chained formats respect closest-first backtrack and available lookahead", () => {
    const rule = { rest: [3], back: [6, 7], ahead: [8, 9], actions: [[1, 1]] as const }, classRule = { ...rule, rest: [2], back: [1, 2], ahead: [1, 2] };
    for (const table of [contexts([2], [[rule]], { chain: true }), contexts([2], [null, [classRule]], { chain: true, backClass: classes(6, [1, 2]), inputClass: classes(2, [1, 2]), aheadClass: classes(8, [1, 2]) }), coverageContext([[2], [3]], [[1, 1]], [[6], [7]], [[8], [9]])]) {
        const plan = planFor([lookup(8, [table]), lookup(1, [singlePos([3], [[undefined, 80]])])], { selected: [0] }); assert.equal(run(plan, [7, 6, 2, 3, 8, 9]).glyphs[3]!.y, 80); assert.equal(run(plan, [6, 7, 2, 3, 8, 9]).glyphs[3]!.y, 0);
    }
});

test("extension positioning uses full 32-bit offsets", () => {
    const target = singlePos([2], [[undefined, undefined, -100]]), extension = new FontBytes(70008 + target.length).u16(0, 1).u16(2, 1).u32(4, 70008).put(70008, target);
    assert.equal(run(planFor([lookup(9, [extension.data])]), [2]).advances.total, 500);
});

test("cursive chains align both axes and the flag determines which end keeps its baseline", () => {
    const table = cursivePos([2, 3, 4], [{ exit: anchor(500, 100) }, { entry: anchor(100, 300), exit: anchor(600, 200) }, { entry: anchor(50, 50) }]);
    const forward = run(planFor([lookup(3, [table])]), [2, 3, 4]); assert.equal(forward.advances.total, 1350); assert.deepEqual(forward.glyphs.map(g => [g.x, g.y]), [[0, 0], [400, -200], [950, -50]]);
    const reverseBaseline = run(planFor([lookup(3, [table], 1)]), [2, 3, 4]); assert.deepEqual(reverseBaseline.glyphs.map(g => g.y), [50, -150, 0]);
    const rtlTable = cursivePos([2, 3, 4], [{ exit: anchor(100, 100) }, { entry: anchor(600, 300), exit: anchor(50, 200) }, { entry: anchor(350, 50) }]);
    const rtl = run(planFor([lookup(3, [rtlTable])], {}, { direction: "rtl" }), [2, 3, 4]); assert.equal(rtl.advances.total, -1400); assert.deepEqual(rtl.glyphs.map(g => g.x), [-600, -1100, -1400]);
});

test("mark-to-base and mark-to-mark anchors follow later target placements", () => {
    const mark = { glyph: 9, markClass: 0, anchor: anchor(50, 700) }, base = markPos(4, [mark], [{ glyph: 2, components: [[anchor(300, 700)]] }], 1), stack = markPos(6, [mark], [{ glyph: 9, components: [[anchor(100, 850)]] }], 1);
    const plan = planFor([lookup(4, [base]), lookup(6, [stack]), lookup(1, [singlePos([2], [[20, 30]])])], { definition: markDefinition }), result = run(plan, [2, 9, 9]);
    assert.deepEqual(result.glyphs.map(g => [g.x, g.y]), [[20, 30], [270, 30], [320, 180]]); assert.equal(result.advances.total, 600);
    assert.deepEqual(result.glyphs.slice(1).map(g => g.attachment), [{ kind: "mark", glyphIndex: 0 }, { kind: "mark", glyphIndex: 1 }]);
});

test("mark-to-ligature uses GSUB component associations and defaults trailing marks to the last component", () => {
    const pos = markPos(5, [{ glyph: 9, markClass: 0, anchor: anchor(50, 700) }], [{ glyph: 6, components: [[anchor(200, 700)], [anchor(400, 700)]] }], 1), tables = fontTables(positionFont([lookup(5, [pos])], { definition: markDefinition, feature: "mark" }));
    tables.set("GSUB", gsub([lookup(4, [ligatures([4], [[{ to: 6, rest: [5] }]])], 8)], { features: [{ tag: "liga", lookups: [0] }] }));
    const font = SfntFont.from(assembleFont(tables)), shaped = input(font, [4, 9, 5, 9], [{ tag: "liga" }]), result = font.positioningPlan({ features: [{ tag: "mark" }] }).apply(shaped);
    assert.deepEqual(result.glyphs.map(g => g.source.glyphId), [6, 9, 9]); assert.deepEqual(result.glyphs.map(g => g.x), [0, 150, 350]); assert.equal(result.advances.total, 500);
});

test("device values use captured size, signed packed fields and the immediate pair-set parent", () => {
    const records = [[10, 20, -100, 500, device(10, 10, 1, [0x4000]), device(10, 10, 2, [0xf000]), device(10, 10, 3, [0x0200])]], bytes = positionFont([lookup(1, [singlePos([2], records)])], { feature: "test" }), font = SfntFont.from(bytes), ppem = { x: 10, y: 10 };
    const plan = font.positioningPlan({ features: [{ tag: "test" }], ppem }); ppem.x = 20; const result = run(plan, [2]); assert.equal(result.advances.total, 700); assert.deepEqual([result.glyphs[0]!.x, result.glyphs[0]!.y], [110, -80]);
    assert.equal(run(font.positioningPlan({ features: [{ tag: "test" }] }), [2]).advances.total, 500);
    const pair = pairPos([{ first: 2, pairs: [{ second: 3, firstValue: [undefined, undefined, -100, undefined, undefined, undefined, device(10, 10, 1, [0x4000])] }] }]);
    assert.equal(run(planFor([lookup(2, [pair])], {}, { ppem: { x: 10, y: 10 } }), [2, 3]).advances.total, 1300);
});

test("variation values interpolate owned GDEF item deltas and preserve feature selection", () => {
    const store = itemVariationStore([[[0, 1, 1]]], [words(1, 1, 1, 0, 100)]), target = singlePos([2], [[undefined, undefined, -100, undefined, undefined, undefined, variationIndex(0, 0)]]);
    const font = SfntFont.from(positionFont([lookup(1, [target])], { definition: variableDefinition(store), fvar: fvarAxis(), feature: "test" }));
    for (const [axis, total] of [[0, 500], [.5, 550], [1, 600]]) assert.equal(run(font.positioningPlan({ features: [{ tag: "test" }], normalizedCoordinates: [axis!] }), [2]).advances.total, total);
    const fv = variations([{ conditions: [[0, .5, 1]], replacements: [{ feature: 0, lookups: [1] }] }]);
    const selected = SfntFont.from(positionFont([lookup(1, [singlePos([2], [[undefined, undefined, -100]])]), lookup(1, [singlePos([2], [[undefined, undefined, -200]])])], { feature: "test", fvar: fvarAxis(), variations: fv }));
    const plan = selected.positioningPlan({ features: [{ tag: "test" }], normalizedCoordinates: [.75] }); assert.equal(plan.selection.featureVariation, 0); assert.equal(run(plan, [2]).advances.total, 400);
});

test("item variation stores decode short-byte and long-word delta rows", () => {
    const short = new FontBytes(13).u16(0, 1).u16(2, 1).u16(4, 2).u16(6, 0).u16(8, 1).i16(10, 100).u8(12, 0xec), long = new FontBytes(12).u16(0, 1).u16(2, 0x8001).u16(4, 1).u16(6, 0).u32(8, 200000);
    const store = itemVariationStore([[[0, 1, 1]], [[-1, -1, 0]]], [short.data, long.data]);
    for (const [outer, axis, expected] of [[0, .5, 650], [0, -.5, 590], [1, .5, 100600]]) {
        const pos = singlePos([2], [[undefined, undefined, 0, undefined, undefined, undefined, variationIndex(outer!, 0)]]), font = SfntFont.from(positionFont([lookup(1, [pos])], { feature: "test", fvar: fvarAxis(), definition: variableDefinition(store) }));
        assert.equal(run(font.positioningPlan({ features: [{ tag: "test" }], normalizedCoordinates: [axis!] }), [2]).advances.total, expected);
    }
});

test("anchor point overrides are owned and missing outline points retain design-unit fallbacks", () => {
    const pos = markPos(4, [{ glyph: 9, markClass: 0, anchor: anchor(50, 700, { point: 2 }) }], [{ glyph: 2, components: [[anchor(300, 700)]] }], 1), font = SfntFont.from(positionFont([lookup(4, [pos])], { feature: "mark", definition: markDefinition }));
    const fallback = run(font.positioningPlan({ features: [{ tag: "mark" }] }), [2, 9]); assert.equal(fallback.contourFallbacks, 1); assert.deepEqual([fallback.glyphs[1]!.x, fallback.glyphs[1]!.y], [250, 0]);
    const points = [{ glyphId: 9, pointIndex: 2, x: 60, y: 710 }], plan = font.positioningPlan({ features: [{ tag: "mark" }], contourPoints: points }); points[0]!.x = 900;
    const overridden = run(plan, [2, 9]); assert.equal(overridden.contourFallbacks, 0); assert.deepEqual([overridden.glyphs[1]!.x, overridden.glyphs[1]!.y], [240, -10]);
});

test("lookup filtering shares GDEF rules and right-to-left flags do not reverse single positioning", () => {
    const definition = gdef(classes(0, [0, 1, 1, 1, 1, 1, 2, 3, 2, 3]), classes(7, [2, 0, 1]), [[9]]), table = singlePos([7, 9], [[50]]);
    const filtered = run(planFor([lookup(1, [table], 0x110)], { definition }), [7, 9]); assert.deepEqual(filtered.glyphs.map(g => g.xOffset), [0, 50]);
    assert.deepEqual(run(planFor([lookup(1, [table], 0x118)], { definition }), [7, 9]).glyphs.map(g => g.xOffset), [0, 0]);
    assert.equal(run(planFor([lookup(1, [singlePos([2], [[50]])], 1)]), [2]).glyphs[0]!.xOffset, 50);
});

test("re-rooting cursive chains preserves the newly chosen target's current baseline", () => {
    const table = cursivePos([2, 3], [{ exit: anchor(500, 100) }, { entry: anchor(100, 300) }]), result = run(planFor([lookup(3, [table]), lookup(3, [table], 1)]), [2, 3]);
    assert.equal(result.advances.total, 1100); assert.deepEqual(result.glyphs.map(g => g.y), [0, -200]); assert.deepEqual(result.glyphs[0]!.attachment, { kind: "cursive", glyphIndex: 1 });
});

test("legacy class kerning, accumulation, override and cross-stream reset remain explicit", () => {
    const withKern = (kern: Uint8Array) => { const tables = fontTables(fontFixture()); tables.set("kern", kern); return SfntFont.from(assembleFont(tables)).positioningPlan({ features: [], legacyKerning: true }); };
    assert.equal(run(withKern(kernClass()), [2, 3]).advances.total, 1200);
    for (const [coverage, expected] of [[1, 1150], [9, 1250]]) { const first = kernPairs([[2, 3, -100]]), second = kernPairs([[2, 3, -50]], coverage); const combined = new FontBytes(first.length + second.length - 4).u16(2, 2).put(4, first.slice(4)).put(first.length, second.slice(4)); assert.equal(run(withKern(combined.data), [2, 3]).advances.total, expected); }
    const cross = run(withKern(kernPairs([[2, 3, 50], [3, 4, -32768]], 5)), [2, 3, 4, 5]); assert.deepEqual(cross.glyphs.map(g => g.y), [0, 50, 0, 0]);
});

test("signed and zero positioned advances preserve numeric index semantics", () => {
    const result = run(planFor([lookup(1, [singlePos([2], [[-10, undefined, -700]])])]), [2, 9]); assert.equal(result.advances.total, -100); assert.deepEqual(result.advances.window(-101, -99).cells.map(c => c.index), [0, 1]); assert.equal(result.glyphs[0]!.x, -10);
    assert.equal(result.glyphs[1]!.penX, -100); assert.equal(result.advances.prefix(1), -100);
});

test("work limits and incompatible font/metric inputs cannot mutate the source result", () => {
    const cycle = planFor([lookup(7, [contexts([2], [[{ rest: [], actions: [[0, 0]] }]])])]), original = input(cycle.font, [2]), saved = JSON.stringify(original.glyphs);
    assert.throws(() => cycle.apply(original, { maxDepth: 4 }), PositioningLimitError); assert.throws(() => cycle.apply(original, { maxOperations: 1 }), PositioningLimitError); assert.equal(JSON.stringify(original.glyphs), saved);
    assert.throws(() => cycle.apply(input(SfntFont.from(fontFixture()), [2]))); assert.throws(() => cycle.apply(original, { advanceWidths: [] }));
    const noOp = planFor([]), mutable = { ...input(noOp.font, [2]), glyphs: [{ ...input(noOp.font, [2]).glyphs[0]!, components: [[{ from: 10, to: 11 }]] }] }, result = noOp.apply(mutable); mutable.glyphs[0]!.components[0]![0]!.from = 99; assert.equal(result.glyphs[0]!.source.sources[0]!.from, 10);
});

test("malformed positions, offsets and optional adjustment data fail before result publication", () => {
    assert.throws(() => planFor([lookup(1, [singlePos([2], [[1]])], 0x20)])); assert.throws(() => planFor([lookup(1, [singlePos([2], [[1]])], 8)]));
    const bad = singlePos([2], [[1]]); new DataView(bad.buffer).setUint16(4, 0x100); assert.throws(() => planFor([lookup(1, [bad])]));
    const invalidDevice = singlePos([2], [[undefined, undefined, 0, undefined, undefined, undefined, device(10, 9, 1, [])]]); assert.throws(() => planFor([lookup(1, [invalidDevice])]));
    assert.throws(() => planFor([lookup(1, [singlePos([2], [[undefined, undefined, 0, undefined, undefined, undefined, variationIndex(0, 0)]])])]));
    assert.throws(() => planFor([], {}, { ppem: { x: 0, y: 10 } }));
    const tables = fontTables(fontFixture()); tables.set("kern", kernPairs([[2, 3, -100]], 3)); assert.throws(() => SfntFont.from(assembleFont(tables)).positioningPlan({ features: [], legacyKerning: true }));
});

test("long repeated cursive stages resolve iteratively within proportional work limits", () => {
    const table = cursivePos([2], [{ entry: anchor(100, 100), exit: anchor(500, 200) }]), plan = planFor([lookup(3, [table]), lookup(3, [table])]), n = 10_000;
    const result = run(plan, new Array<number>(n).fill(2)); assert.equal(result.advances.total, (n - 1) * 400 + 600); assert.equal(result.glyphs.at(-1)!.y, (n - 1) * 100); assert.ok(result.operations < n * 100);
});
