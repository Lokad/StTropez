import assert from "node:assert/strict";
import test from "node:test";
import { SfntFont, SubstitutionLimitError } from "../src/index.ts";
import type { GlyphRun, SubstitutionCursor, SubstitutionResult } from "../src/index.ts";
import { fontFixture } from "./fixtures/consumer/font-fixture.ts";
import { classes, contexts, fontWithSubstitution, gdef, gsub, ligatures, lookup, multiple, nativeSubstitutionCases, reverse, single } from "./fixtures/substitution.ts";
function run(font: SfntFont, ids: readonly number[]): GlyphRun {
    const builder = font.createGlyphRunBuilder(); for (let from = 0; from < ids.length; from += 256) builder.append(ids.slice(from, from + 256).map((glyphId, i) => ({ glyphId, source: { from: 1_000_000 + from + i, to: 1_000_001 + from + i } })));
    const value = builder.finish(); builder.dispose(); return value;
}
function finish(cursor: SubstitutionCursor, budget = 256): SubstitutionResult {
    let previous = cursor.snapshot();
    while (true) { const step = cursor.next(budget); assert.ok(step.workUnits - previous.workUnits <= budget + 260); assert.ok(Object.isFrozen(step)); if (step.status === "ready") return step.result!; assert.equal(step.status, "running"); assert.equal(step.result, null); previous = step; }
}
const fontFor = (lookups: readonly Uint8Array[], definition?: Uint8Array) => SfntFont.from(fontWithSubstitution(gsub(lookups, { features: [{ tag: "test", lookups: [0] }] }), definition));

test("nominal glyph builders retain immutable blocks across uneven appends and disposal", () => {
    const font = SfntFont.from(fontFixture()), builder = font.createGlyphRunBuilder(), initial = builder.snapshot(); let from = 0;
    for (const count of [1, 255, 7, 256, 255, 3]) { const entries = Array.from({ length: count }, (_, i) => ({ glyphId: (from + i) % 2 ? 3 : 2, source: { from: from + i, to: from + i + 1 } })); builder.append(entries); entries[0]!.source.from = 99; from += count; }
    const value = builder.finish(); assert.equal(builder.finish(), value); assert.equal(value.font, font); assert.equal(value.length, from); assert.equal(initial.length, 0); assert.ok(Object.isFrozen(value));
    for (let i = 0; i < from; i++) { assert.equal(value.at(i).glyphId, i % 2 ? 3 : 2); assert.deepEqual(value.at(i).source, { from: i, to: i + 1 }); assert.ok(Object.isFrozen(value.at(i).source)); }
    builder.dispose(); builder.dispose(); assert.equal(value.at(256).source.from, 256); assert.equal(builder.snapshot().result, null); for (const index of [-1, from, NaN, .5]) assert.throws(() => value.at(index)); assert.throws(() => builder.append([]));
});

test("glyph builder rejection is atomic and input primitives are captured once", () => {
    const builder = SfntFont.from(fontFixture()).createGlyphRunBuilder(), good = { glyphId: 2, source: { from: 0, to: 1 } }; builder.append([good]);
    for (const entries of [Array.from({ length: 257 }, () => good), Array(1), [good, { glyphId: 999, source: { from: 0, to: 1 } }], [{ glyphId: 2, source: { from: 2, to: 1 } }], [{ glyphId: 2, glyphClass: 5, source: { from: 0, to: 1 } }]]) { assert.throws(() => builder.append(entries)); assert.equal(builder.snapshot().length, 1); }
    let reads = 0; builder.append([{ get glyphId() { reads++; assert.throws(() => builder.append([]), /unavailable/); return 3; }, source: { from: 1, to: 2 } }]); assert.equal(reads, 1); const value = builder.finish(); assert.equal(value.length, 2); assert.throws(() => builder.append([])); builder.dispose(); assert.equal(value.at(1).glyphId, 3);
});

test("all original GSUB fixtures agree through synchronous arrays, owned runs and varied cursor budgets", () => {
    for (const c of nativeSubstitutionCases()) {
        const font = SfntFont.from(c.bytes); let offset = 0; const entries = [...c.text].map(ch => { const from = offset; offset += ch.length; return { glyphId: font.glyphIndex(ch.codePointAt(0)!), source: { from, to: offset } }; }), builder = font.createGlyphRunBuilder(); builder.append(entries); const supplied = builder.finish(); builder.dispose();
        const plan = font.substitutionPlan({ features: [{ tag: c.feature, value: c.value }] }), expected = plan.apply(entries); assert.deepEqual(expected.glyphs.map(g => g.glyphId), c.expectedGlyphs, c.name);
        assert.deepEqual(plan.apply(supplied).glyphs, expected.glyphs);
        for (const budget of [256, 777, 4096]) { const cursor = plan.createCursor(supplied), result = finish(cursor, budget); assert.deepEqual(result.glyphs, expected.glyphs, c.name); assert.equal(result.substitutions, expected.substitutions); assert.equal(result.font, font); cursor.dispose(); assert.equal(result.glyphs.length, c.expectedGlyphs.length); }
    }
});

test("cancelling input, associations, validation, ordinals or publication exposes no partial result", () => {
    const font = SfntFont.from(fontFixture()), supplied = run(font, Array<number>(20_000).fill(2)), plan = font.substitutionPlan({ features: [] });
    for (const phase of ["input", "associations", "validate", "ordinals", "publish"] as const) {
        const cursor = plan.createCursor(supplied), initial = cursor.snapshot(); let step = cursor.next(256);
        while (step.status === "running" && (step.phase !== phase || phase === "publish" && !step.publishedGlyphs)) step = cursor.next(256);
        assert.equal(step.status, "running"); assert.equal(step.result, null); cursor.dispose(); assert.equal(cursor.snapshot().status, "disposed"); assert.equal(cursor.next().result, null); assert.equal(initial.workUnits, 0); assert.equal(supplied.at(0).source.from, 1_000_000);
    }
});

test("a distant ignored-mark ligature suspends searches and publishes exact mark associations", () => {
    const c = nativeSubstitutionCases().find(c => c.name === "ignored-mark")!, font = SfntFont.from(c.bytes), supplied = run(font, [2, ...Array<number>(20_000).fill(9), 3]), cursor = font.substitutionPlan({ features: [{ tag: c.feature }] }).createCursor(supplied); let step = cursor.next(256), searches = 0, previous = 0;
    while (step.status === "running") { assert.ok(step.workUnits - previous <= 516); previous = step.workUnits; if (step.phase === "lookups") searches++; assert.equal(step.result, null); step = cursor.next(256); }
    assert.ok(searches > 70); const result = step.result!; assert.equal(result.glyphs.length, 20_001); assert.equal(result.glyphs[0]!.glyphId, 6); assert.deepEqual(result.glyphs[0]!.sources, [{ from: 1_000_000, to: 1_000_001 }, { from: 1_020_001, to: 1_020_002 }]); assert.ok(result.glyphs.slice(1).every(g => g.attachment?.glyphIndex === 0 && g.attachment.component === 0)); cursor.dispose();
});

test("suspended contextual expansion and beyond-input contraction preserve mutable frame slots", () => {
    const expanded = fontFor([lookup(5, [contexts([2], [[{ rest: [3], actions: [[0, 1], [1, 2]] }]])]), lookup(2, [multiple([2], [Array<number>(2000).fill(2)])]), lookup(1, [single([2], [5])])]), expansion = expanded.substitutionPlan({ features: [{ tag: "test" }] }).createCursor(run(expanded, [2, 3]));
    const a = finish(expansion); assert.equal(a.glyphs.length, 2001); assert.equal(a.glyphs[0]!.glyphId, 2); assert.equal(a.glyphs[1]!.glyphId, 5); assert.equal(a.glyphs.at(-1)!.glyphId, 3); assert.deepEqual(a.glyphs[1]!.sources, [{ from: 1_000_000, to: 1_000_001 }]); expansion.dispose();
    const contracted = fontFor([lookup(5, [contexts([2], [[{ rest: [3], actions: [[0, 1], [0, 2]] }]])]), lookup(4, [ligatures([2], [[{ to: 6, rest: Array<number>(2000).fill(3) }]])]), lookup(1, [single([6], [7])])]), contraction = contracted.substitutionPlan({ features: [{ tag: "test" }] }).createCursor(run(contracted, [2, ...Array<number>(2000).fill(3), 4]));
    const b = finish(contraction); assert.deepEqual(b.glyphs.map(g => g.glyphId), [7, 4]); assert.equal(b.glyphs[0]!.components.length, 2001); assert.equal(b.glyphs[1]!.sources[0]!.from, 1_002_001); contraction.dispose();
});

test("multiple substitution snapshots large attached-mark sets while detaching their associations", () => {
    const font = SfntFont.from(fontWithSubstitution(gsub([lookup(4, [ligatures([2], [[{ to: 6, rest: [3] }]])], 8), lookup(2, [multiple([6], [[4, 5]])])], { features: [{ tag: "deco", lookups: [1] }, { tag: "liga", lookups: [0] }] }), gdef(classes(0, [0, 1, 1, 1, 1, 1, 2, 1, 2, 3])))), supplied = run(font, [2, ...Array<number>(12_000).fill(9), 3]);
    const first = finish(font.substitutionPlan({ features: [{ tag: "liga" }] }).createCursor(supplied)), cursor = font.substitutionPlan({ features: [{ tag: "deco" }] }).createCursor(first), result = finish(cursor);
    assert.equal(result.glyphs.length, 12_002); assert.deepEqual(result.glyphs.slice(0, 2).map(g => g.glyphId), [4, 5]); assert.equal(result.glyphs[0]!.components, first.glyphs[0]!.components); assert.ok(result.glyphs.slice(2).every(g => g.attachment === null)); assert.ok(first.glyphs.slice(1).every(g => g.attachment?.glyphIndex === 0)); cursor.dispose();
});

test("owned component provenance is reused and its source flattening remains cooperative", () => {
    const font = SfntFont.from(fontFixture()), components = Array.from({ length: 20_000 }, (_, from) => [{ from, to: from + 1 }]), plan = font.substitutionPlan({ features: [] }), first = plan.apply([{ glyphId: 2, glyphClass: 1, components, sources: components.flat(), attachment: null }]), cursor = plan.createCursor(first);
    assert.equal(cursor.snapshot().workUnits, 0); const pending = cursor.next(256); assert.equal(pending.phase, "publish"); assert.equal(pending.status, "running"); assert.equal(pending.preparedGlyphs, 1); assert.equal(pending.result, null); const result = finish(cursor); assert.equal(result.glyphs[0]!.components, first.glyphs[0]!.components); assert.equal(result.glyphs[0]!.sources.length, 20_000); cursor.dispose();
});

test("reverse chaining keeps right-to-left scan state across thousands of suspensions", () => {
    const font = fontFor([lookup(8, [reverse([2], [3], [], [[3]])])]), cursor = font.substitutionPlan({ features: [{ tag: "test" }] }).createCursor(run(font, [...Array<number>(20_000).fill(2), 3])), result = finish(cursor);
    assert.ok(result.glyphs.every(g => g.glyphId === 3)); assert.equal(result.substitutions, 20_000); assert.equal(result.glyphs[0]!.sources[0]!.from, 1_000_000); cursor.dispose();
});

test("empty input charges selected lookup passes without a bulk uncounted metadata loop", () => {
    const font = SfntFont.from(fontWithSubstitution(gsub(Array.from({ length: 1000 }, () => lookup(1, [single([2], [3])])), { features: [{ tag: "liga", lookups: Array.from({ length: 1000 }, (_, i) => i) }] }))), cursor = font.substitutionPlan({ features: [{ tag: "liga" }] }).createCursor(run(font, [])), first = cursor.next(256);
    assert.equal(first.status, "running"); assert.equal(first.phase, "lookups"); assert.equal(first.workUnits, 256); const result = finish(cursor); assert.equal(result.operations, 1000); assert.deepEqual(result.glyphs, []); cursor.dispose();
});

test("limits, font ownership and invalid requests fail atomically while options remain captured", () => {
    const font = SfntFont.from(fontFixture()), supplied = run(font, Array<number>(2000).fill(2)), plan = font.substitutionPlan({ features: [] }), limited = plan.createCursor(supplied, { maxOperations: 50 });
    assert.throws(() => limited.next(), SubstitutionLimitError); assert.equal(limited.snapshot().status, "failed"); assert.equal(limited.snapshot().result, null); assert.deepEqual(limited.next(), limited.snapshot()); limited.dispose();
    const tooMany = plan.createCursor(supplied, { maxGlyphs: 100 }); assert.throws(() => tooMany.next(), (error: unknown) => error instanceof SubstitutionLimitError && error.limit === "glyphs"); tooMany.dispose();
    const recursive = fontFor([lookup(5, [contexts([2], [[{ rest: [], actions: [[0, 0]] }]])])]), depth = recursive.substitutionPlan({ features: [{ tag: "test" }] }).createCursor(run(recursive, [2]), { maxDepth: 4 }); assert.throws(() => depth.next(), (error: unknown) => error instanceof SubstitutionLimitError && error.limit === "depth"); depth.dispose();
    assert.throws(() => plan.createCursor(run(SfntFont.from(fontFixture()), [2])), /captured glyph-run font/); const owned = plan.apply(supplied); assert.throws(() => plan.createCursor({ ...owned }), /owned immutable/);
    const options = { maxOperations: 100_000 }, cursor = plan.createCursor(supplied, options); options.maxOperations = 1; for (const budget of [0, 255, NaN, Infinity, 256.5]) assert.throws(() => cursor.next(budget), RangeError); assert.equal(finish(cursor).glyphs.length, 2000); cursor.dispose();
});

test("completed substitution feeds cooperative positioning and survives builder/cursor disposal", () => {
    const bytes = fontFixture(), font = SfntFont.from(bytes), supplied = run(font, [4, 5, 2, 3]), substitution = font.substitutionPlan({ features: [{ tag: "liga" }] }).createCursor(supplied), shaped = finish(substitution); bytes.fill(0); substitution.dispose();
    const positioning = font.positioningPlan({ features: [], legacyKerning: true }).createCursor(shaped); let step = positioning.next(256); while (step.status === "running") step = positioning.next(256); const result = step.result!; positioning.dispose();
    assert.deepEqual(result.glyphs.map(g => g.source.glyphId), [6, 2, 3]); assert.equal(result.advances.total, 1700); assert.equal(result.advances.prefix(2), 1000); assert.equal(result.glyphs[0]!.source.components.length, 2); assert.equal(substitution.snapshot().result, null); assert.equal(positioning.snapshot().result, null);
});

test("deep contextual action stacks resume after yields without losing parent continuations", () => {
    const lookups = Array.from({ length: 39 }, (_, i) => lookup(5, [contexts([2], [[{ rest: [], actions: [[0, i + 1]] }]])])); lookups.push(lookup(1, [single([2], [3])]));
    const font = fontFor(lookups), cursor = font.substitutionPlan({ features: [{ tag: "test" }] }).createCursor(run(font, Array<number>(1000).fill(2))), result = finish(cursor); assert.equal(result.substitutions, 1000); assert.ok(result.glyphs.every(g => g.glyphId === 3)); assert.ok(result.operations > 100_000); cursor.dispose();
});
