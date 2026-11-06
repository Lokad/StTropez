import assert from "node:assert/strict";
import test from "node:test";
import { AdvanceIndex, PositioningLimitError, SfntFont } from "../src/index.ts";
import type { PositioningCursor, PositioningResult, SubstitutionResult } from "../src/index.ts";
import { FontBytes, assembleFont, fontFixture, fontTables } from "./fixtures/consumer/font-fixture.ts";
import { classes, contexts, gdef, lookup } from "./fixtures/substitution.ts";
import { anchor, cursivePos, kernPairs, nativePositioningCases, pairPos, positionFont, singlePos } from "./fixtures/positioning.ts";
const input = (font: SfntFont, ids: readonly number[]): SubstitutionResult => font.substitutionPlan({ features: [] }).apply(ids.map((glyphId, from) => ({ glyphId, source: { from: 1_000_000 + from, to: 1_000_001 + from } })));
function finish(cursor: PositioningCursor, budget = 256): PositioningResult {
    let previous = cursor.snapshot(), step = cursor.next(budget);
    while (true) {
        assert.ok(step.workUnits - previous.workUnits <= budget + 260); assert.ok(Object.isFrozen(step));
        if (step.status === "ready") return step.result!;
        assert.equal(step.status, "running"); assert.equal(step.result, null); previous = step; step = cursor.next(budget);
    }
}

test("cooperative positioning preserves every original fixture at different work budgets", () => {
    for (const c of nativePositioningCases()) {
        const font = SfntFont.from(c.bytes); let from = 0;
        const supplied = font.substitutionPlan({ features: c.substitute ? [{ tag: "liga" }] : [] }).apply([...c.text].map(ch => { const start = from; from += ch.length; return { glyphId: font.glyphIndex(ch.codePointAt(0)!), source: { from: start, to: from } }; }));
        const plan = font.positioningPlan({ features: [{ tag: c.feature }], direction: c.direction, legacyKerning: c.legacy, ppem: { x: 100, y: 100 }, contourPoints: c.points ?? [] }), synchronous = plan.apply(supplied);
        for (const budget of [256, 777, 4096]) {
            const cursor = plan.createCursor(supplied), result = finish(cursor, budget); assert.deepEqual(result.glyphs, synchronous.glyphs, c.name); assert.equal(result.operations, synchronous.operations); assert.equal(result.adjustments, synchronous.adjustments); assert.equal(Math.abs(result.advances.total) / 10, c.width);
            for (let i = 0; i <= result.glyphs.length; i++) assert.equal(result.advances.prefix(i), synchronous.advances.prefix(i)); cursor.dispose(); assert.equal(result.font, font); assert.equal(cursor.snapshot().result, null);
        }
    }
});

test("ignored-mark search can pause inside a single lookup without losing its context", () => {
    const font = SfntFont.from(positionFont([lookup(2, [pairPos([{ first: 2, pairs: [{ second: 3, firstValue: [undefined, undefined, -100] }] }])], 8)], { feature: "test", definition: gdef(classes(9, [3])) }));
    const supplied = input(font, [2, ...Array<number>(20_000).fill(9), 3]), cursor = font.positioningPlan({ features: [{ tag: "test" }] }).createCursor(supplied); let step = cursor.next(256), searches = 0, last = 0;
    while (step.status === "running") { assert.equal(step.result, null); assert.ok(step.workUnits - last <= 516); last = step.workUnits; if (step.phase === "lookups") searches++; step = cursor.next(256); }
    assert.ok(searches >= Math.floor(20_000 / 256) - 1); assert.equal(step.result!.advances.total, 1200); assert.equal(step.result!.glyphs[0]!.xAdvance, 500); assert.equal(step.result!.glyphs.at(-1)!.source.sources[0]!.from, 1_020_001); cursor.dispose();
});

test("long cursive chains and rerooting preserve results across attachment yields", () => {
    const data = cursivePos([2], [{ entry: anchor(100, 100), exit: anchor(500, 200) }]), font = SfntFont.from(positionFont([lookup(3, [data]), lookup(3, [data], 1)], { feature: "test" })), supplied = input(font, Array<number>(12_000).fill(2)), plan = font.positioningPlan({ features: [{ tag: "test" }] });
    const cursor = plan.createCursor(supplied), result = finish(cursor, 512); assert.deepEqual(result.glyphs, plan.apply(supplied).glyphs); assert.equal(result.advances.total, 4_800_200); cursor.dispose();
});

test("cancellation during pens and publication exposes no partial result or mutable source", () => {
    const font = SfntFont.from(fontFixture()), supplied = input(font, Array<number>(20_000).fill(2)), plan = font.positioningPlan({ features: [] });
    for (const phase of ["pens", "publish"] as const) {
        const cursor = plan.createCursor(supplied), initial = cursor.snapshot(); let step = cursor.next(256);
        while (step.status === "running" && (step.phase !== phase || phase === "publish" && !step.publishedGlyphs)) step = cursor.next(256);
        assert.equal(step.status, "running"); assert.equal(step.result, null); cursor.dispose(); cursor.dispose(); assert.equal(cursor.snapshot().status, "disposed"); assert.equal(cursor.next(256).result, null); assert.equal(initial.workUnits, 0); assert.equal(initial.preparedGlyphs, 0);
    }
    const result = finish(plan.createCursor(supplied)); assert.equal(result.glyphs[0]!.source, supplied.glyphs[0]); assert.equal(result.advances.total, 12_000_000);
});

test("operation and nested-depth failures are terminal without publishing partial geometry", () => {
    const font = SfntFont.from(fontFixture()), supplied = input(font, Array<number>(2000).fill(2)), cursor = font.positioningPlan({ features: [] }).createCursor(supplied, { maxOperations: 500 });
    assert.throws(() => finish(cursor), PositioningLimitError); assert.equal(cursor.snapshot().status, "failed"); assert.equal(cursor.snapshot().result, null); const failed = cursor.snapshot(); assert.deepEqual(cursor.next(), failed); assert.match(failed.failure!, /operations/); cursor.dispose();
    const recursive = SfntFont.from(positionFont([lookup(7, [contexts([2], [[{ rest: [], actions: [[0, 0]] }]])])], { feature: "test" })), nested = recursive.positioningPlan({ features: [{ tag: "test" }] }).createCursor(input(recursive, [2]), { maxDepth: 4 });
    assert.throws(() => nested.next(), (error: unknown) => error instanceof PositioningLimitError && error.limit === "depth"); assert.equal(nested.snapshot().status, "failed"); nested.dispose();
});

test("cursor metrics capture an immutable index and copied primitive options", () => {
    const font = SfntFont.from(fontFixture()), supplied = input(font, [2, 3, 2]), raw = [1000, 0, -50], metrics = AdvanceIndex.from(raw), options = { advanceWidths: metrics, maxOperations: 1000 };
    const cursor = font.positioningPlan({ features: [], direction: "rtl" }).createCursor(supplied, options); raw.fill(0); options.maxOperations = 1; const result = finish(cursor);
    assert.equal(result.advances.total, -950); assert.deepEqual(result.glyphs.map(g => g.x), [-1000, -1000, -950]); assert.equal(result.advances.prefix(1), -1000); cursor.dispose(); assert.equal(result.advances.total, -950);
});

test("cooperative inputs require owned snapshots and budgets reject invalid progress requests", () => {
    const font = SfntFont.from(fontFixture()), supplied = input(font, [2]), plan = font.positioningPlan({ features: [] });
    assert.throws(() => plan.createCursor(Object.freeze({ ...supplied })), /owned immutable/); assert.equal(plan.apply({ ...supplied }).advances.total, 600);
    assert.throws(() => plan.createCursor(input(SfntFont.from(fontFixture()), [2])), /captured substitution font/); assert.throws(() => plan.createCursor(supplied, { advanceWidths: AdvanceIndex.from([]) }));
    const cursor = plan.createCursor(supplied); for (const budget of [0, 255, 256.5, NaN, Infinity]) assert.throws(() => cursor.next(budget), RangeError); assert.equal(cursor.snapshot().workUnits, 0); cursor.dispose(); assert.equal(cursor.next().status, "disposed");
});

test("empty results finish atomically and retained geometry survives cursor disposal", () => {
    const font = SfntFont.from(fontFixture()), cursor = font.positioningPlan({ features: [] }).createCursor(input(font, [])), result = finish(cursor); assert.equal(result.advances.total, 0); assert.deepEqual(result.glyphs, []); assert.ok(Object.isFrozen(result)); cursor.dispose(); assert.equal(result.advances.length, 0);
});

test("empty and single-glyph streams charge lookup-pass and kerning-table traversal", () => {
    const count = 1000, font = SfntFont.from(positionFont(Array.from({ length: count }, () => lookup(1, [singlePos([2], [[0]])])), { feature: "test" })), cursor = font.positioningPlan({ features: [{ tag: "test" }] }).createCursor(input(font, []));
    const empty = cursor.next(256); assert.equal(empty.status, "running"); assert.equal(empty.phase, "lookups"); assert.equal(empty.workUnits, 256); assert.equal(empty.result, null); const complete = finish(cursor); assert.equal(complete.advances.total, 0); assert.equal(complete.operations, count); cursor.dispose();
    const subtable = kernPairs([]).slice(4), bytes = new FontBytes(4 + count * subtable.length).u16(2, count); for (let i = 0; i < count; i++) bytes.data.set(subtable, 4 + i * subtable.length);
    const tables = fontTables(fontFixture()); tables.set("kern", bytes.data); const legacy = SfntFont.from(assembleFont(tables)), single = legacy.positioningPlan({ features: [], legacyKerning: true }).createCursor(input(legacy, [2]));
    const pending = single.next(256); assert.equal(pending.status, "running"); assert.equal(pending.phase, "legacy"); assert.equal(pending.workUnits, 256); assert.equal(pending.result, null); const result = finish(single); assert.equal(result.advances.total, 600); assert.equal(result.operations, count + 8); single.dispose();
});

test("owned provenance is captured without rescanning a large component list", () => {
    const font = SfntFont.from(fontFixture()), components = Array.from({ length: 20_000 }, (_, from) => [{ from, to: from + 1 }]), supplied = font.substitutionPlan({ features: [] }).apply([{ glyphId: 2, glyphClass: 1, components, sources: components.flat(), attachment: null }]);
    const cursor = font.positioningPlan({ features: [] }).createCursor(supplied); assert.equal(cursor.snapshot().workUnits, 0); const result = finish(cursor); assert.ok(result.operations < 32); assert.equal(result.glyphs[0]!.source, supplied.glyphs[0]); assert.equal(result.glyphs[0]!.source.components.length, 20_000); cursor.dispose();
});

test("nested contextual actions can yield while a deep lookup stack is suspended", () => {
    const lookups = Array.from({ length: 39 }, (_, index) => lookup(7, [contexts([2], [[{ rest: [], actions: [[0, index + 1]] }]])])); lookups.push(lookup(1, [singlePos([2], [[undefined, undefined, -100]])]));
    const font = SfntFont.from(positionFont(lookups, { feature: "test", selected: [0] })), supplied = input(font, Array<number>(1000).fill(2)), plan = font.positioningPlan({ features: [{ tag: "test" }] }), cursor = plan.createCursor(supplied), result = finish(cursor);
    assert.equal(result.advances.total, 500_000); assert.deepEqual(result.glyphs, plan.apply(supplied).glyphs); assert.ok(result.operations > 100_000); cursor.dispose();
});
