import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { AdvanceIndex, SfntFont } from "../src/index.ts";
import { classes, gdef, lookup } from "../tests/fixtures/substitution.ts";
import { anchor, cursivePos, markPos, nativePositioningCases, positionFont } from "../tests/fixtures/positioning.ts";
import { distribution, environment, sourceIdentity } from "./measurement.mjs";

const source = await sourceIdentity(), fixtures = nativePositioningCases(), pair = SfntFont.from(fixtures.find(c => c.name === "pair-values").bytes), legacy = SfntFont.from(fixtures.find(c => c.name === "legacy-pair").bytes);
const cursive = SfntFont.from(positionFont([lookup(3, [cursivePos([2], [{ entry: anchor(100, 100), exit: anchor(500, 200) }])])], { feature: "test" })), marks = SfntFont.from(positionFont([lookup(6, [markPos(6, [{ glyph: 9, markClass: 0, anchor: anchor(50, 700) }], [{ glyph: 9, components: [[anchor(100, 850)]] }], 1)])], { feature: "test", definition: gdef(classes(9, [3])) }));
const prepared = [
    ...[256, 4096].map(budget => ({ name: `pair-200000-budget-${budget}`, font: pair, n: 200_000, ids: [2, 3], budget, expected: 115_000_000 })),
    { name: "cursive-100000", font: cursive, n: 100_000, ids: [2], budget: 4096, expected: 40_000_200, lastY: 9_999_900 },
    { name: "marks-100000", font: marks, n: 100_000, ids: [9], budget: 4096, expected: 0, lastY: 14_999_850 },
    { name: "legacy-rtl-200000", font: legacy, n: 200_000, ids: [3, 2], budget: 4096, expected: -120_000_000, legacy: true, direction: "rtl" },
    { name: "signed-metrics-240000", font: legacy, n: 240_000, ids: [2], budget: 4096, expected: -76_000_000, direction: "rtl", metrics: true },
    ...["pens", "publish"].map(cancel => ({ name: `cancel-${cancel}-200000`, font: pair, n: 200_000, ids: [2, 3], budget: 4096, cancel }))
], cases = [];
for (const c of prepared) {
    const input = c.font.substitutionPlan({ features: [] }).apply(Array.from({ length: c.n }, (_, from) => ({ glyphId: c.ids[from % c.ids.length], source: { from, to: from + 1 } }))), metrics = c.metrics ? AdvanceIndex.from(Array.from({ length: c.n }, (_, i) => [1000, 0, -50][i % 3])) : undefined;
    const plan = c.font.positioningPlan({ features: [{ tag: "test" }], direction: c.direction ?? "ltr", legacyKerning: !!c.legacy }), options = metrics ? { advanceWidths: metrics } : {}, samples = [];
    for (let trial = 0; trial < 23; trial++) {
        const before = process.memoryUsage(), start = performance.now(), cursor = plan.createCursor(input, options), constructorMs = performance.now() - start, slices = [], deltas = [], phases = {}; let step = cursor.snapshot(), previous = 0, result = null, maximum = { elapsedMs: 0, phase: "source", workUnits: 0, preparedGlyphs: 0, publishedGlyphs: 0 };
        while (true) {
            const sliceStart = performance.now(); step = cursor.next(c.budget); slices.push(performance.now() - sliceStart); deltas.push(step.workUnits - previous); previous = step.workUnits; phases[step.phase] = (phases[step.phase] ?? 0) + 1;
            if (slices.at(-1) > maximum.elapsedMs) maximum = { elapsedMs: slices.at(-1), phase: step.phase, workUnits: deltas.at(-1), preparedGlyphs: step.preparedGlyphs, publishedGlyphs: step.publishedGlyphs };
            if (step.status === "ready") { result = step.result; break; }
            if (c.cancel && step.phase === c.cancel && (c.cancel !== "publish" || step.publishedGlyphs > 0)) break;
        }
        cursor.dispose(); const elapsedMs = performance.now() - start, after = process.memoryUsage();
        assert.ok(deltas.every(d => d <= c.budget + 260)); assert.equal(cursor.snapshot().status, "disposed"); assert.equal(cursor.snapshot().result, null);
        if (c.cancel) { assert.equal(result, null); assert.equal(step.phase, c.cancel); if (c.cancel === "publish") assert.ok(step.publishedGlyphs > 0); }
        else { assert.equal(result.advances.total, c.expected); assert.equal(result.glyphs.length, c.n); if (c.lastY !== undefined) assert.equal(result.glyphs.at(-1).y, c.lastY); }
        if (trial >= 3) samples.push({ elapsedMs, constructorMs, heapBefore: before.heapUsed, heapAfter: after.heapUsed, slicesMs: distribution(slices), workDeltas: deltas, endingPhases: phases,
            steps: slices.length, maximum, workUnits: step.workUnits, finalPhase: step.phase, preparedGlyphs: step.preparedGlyphs, publishedGlyphs: step.publishedGlyphs, total: result?.advances.total ?? null });
    }
    cases.push({ name: c.name, glyphs: c.n, budget: c.budget, cancel: c.cancel ?? null, warmup: 3, measured: samples.length, elapsedMs: distribution(samples.map(s => s.elapsedMs)), constructorMs: distribution(samples.map(s => s.constructorMs)), maximumSliceMs: distribution(samples.map(s => Math.max(...s.slicesMs.samples))), samples });
    console.log(JSON.stringify({ name: c.name, elapsedP95Ms: cases.at(-1).elapsedMs.p95, constructorP95Ms: cases.at(-1).constructorMs.p95, maximumSliceP95Ms: cases.at(-1).maximumSliceMs.p95 }));
}
assert.equal((await sourceIdentity()).sha256, source.sha256); await mkdir("artifacts/bench/position-cursor", { recursive: true });
await writeFile("artifacts/bench/position-cursor/latest.json", JSON.stringify({ schemaVersion: 1, created: new Date().toISOString(), source, environment: environment(), cases,
    note: "Already compiled GPOS plans over owned GSUB snapshots; font parsing/compilation, GSUB and metric-index construction precede clocks. Each trial includes cursor construction, every next call, timing/array bookkeeping, final disposal and private publication. Slice clocks enclose actual next calls including initial typed-array allocation, index construction, attachment resolution and final flat-array freeze. Work budgets count inspected kernel operations; bounded table/index searches, GC and native allocation/freeze are not hard time deadlines. Raw slice clocks and work deltas retained. 3 warmups/20 measured trials. CPU draining performs no event-loop scheduling; browser scenarios separately verify task/frame/native typing progress and cancellation. Cancellation exposes no partial result. Raw heap observations are not stabilized retained/peak bytes. GSUB/compilation, full script/fallback/variable geometry, combined layout lifecycle and actual renderer scheduling remain open. No runtime dependency, worker or WASM selected." }, null, 2));
