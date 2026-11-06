import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { SfntFont } from "../src/index.ts";
import { fontFixture } from "../tests/fixtures/consumer/font-fixture.ts";
import { nativeSubstitutionCases } from "../tests/fixtures/substitution.ts";
import { distribution, environment, sourceIdentity } from "./measurement.mjs";

const source = await sourceIdentity(), fixtures = nativeSubstitutionCases(), original = SfntFont.from(fontFixture());
const font = name => SfntFont.from(fixtures.find(c => c.name === name).bytes), cases = [], prepared = [
    { name: "builder-200000", font: original, n: 200_000, pattern: [4, 5], builder: true, budget: 256, expected: 200_000 },
    ...[256, 4096].map(budget => ({ name: `ligature-200000-budget-${budget}`, font: original, n: 200_000, pattern: [4, 5], budget, expected: 100_000, changes: 100_000 })),
    { name: "multiple-20000", font: font("multiple"), n: 20_000, pattern: [3], budget: 4096, expected: 40_000, changes: 20_000 },
    { name: "distant-marks-100000", font: font("ignored-mark"), n: 100_002, ids: Array.from({ length: 100_002 }, (_, i) => i === 0 ? 2 : i === 100_001 ? 3 : 9), budget: 4096, expected: 100_001, changes: 1 },
    { name: "context-expansion-20000", font: font("context-expansion"), n: 20_000, pattern: [2, 3, 4, 5], budget: 4096, expected: 25_000, changes: 10_000 },
    { name: "reverse-200001", font: font("reverse"), n: 200_001, ids: [...Array(200_000).fill(2), 3], budget: 4096, expected: 200_001, changes: 200_000 },
    ...["input", "publish"].map(cancel => ({ name: `cancel-${cancel}-200000`, font: original, n: 200_000, pattern: [4, 5], budget: 4096, cancel }))
];
for (const c of prepared) {
    const entries = Array.from({ length: c.n }, (_, from) => ({ glyphId: c.ids?.[from] ?? c.pattern[from % c.pattern.length], source: { from, to: from + 1 } })), batches = [];
    for (let from = 0; from < entries.length; from += 256) batches.push(entries.slice(from, from + 256));
    const prepare = c.font.createGlyphRunBuilder(); for (const batch of batches) prepare.append(batch); const supplied = prepare.finish(); prepare.dispose();
    const plan = c.font.substitutionPlan({ features: [{ tag: "liga" }] }), samples = [];
    for (let trial = 0; trial < 23; trial++) {
        const before = process.memoryUsage(), start = performance.now(), task = c.builder ? c.font.createGlyphRunBuilder() : plan.createCursor(supplied), constructorMs = performance.now() - start;
        const slices = [], deltas = [], phases = {}; let previous = 0, result = null, built = null, step = null, maximum = { elapsedMs: 0, phase: "input", workUnits: 0 };
        const record = (sliceStart, phase, delta) => { const elapsedMs = performance.now() - sliceStart; slices.push(elapsedMs); deltas.push(delta); phases[phase] = (phases[phase] ?? 0) + 1; if (elapsedMs > maximum.elapsedMs) maximum = { elapsedMs, phase, workUnits: delta }; };
        if (c.builder) {
            for (const batch of batches) { const sliceStart = performance.now(); task.append(batch); record(sliceStart, "append", batch.length); }
            const sliceStart = performance.now(); built = task.finish(); record(sliceStart, "finish", 0);
        } else while (true) {
            const sliceStart = performance.now(); step = task.next(c.budget); record(sliceStart, step.phase, step.workUnits - previous); previous = step.workUnits;
            if (step.status === "ready") { result = step.result; break; }
            if (c.cancel && step.phase === c.cancel && (c.cancel !== "publish" || step.publishedGlyphs > 0)) break;
        }
        task.dispose(); const elapsedMs = performance.now() - start, after = process.memoryUsage();
        assert.ok(deltas.every(d => d <= c.budget + 260)); assert.equal(task.snapshot().status, "disposed"); assert.equal(task.snapshot().result, null);
        if (c.builder) { assert.equal(built.length, c.expected); assert.equal(built.at(c.n - 1).source.from, c.n - 1); }
        else if (c.cancel) { assert.equal(result, null); assert.equal(step.phase, c.cancel); }
        else { assert.equal(result.glyphs.length, c.expected); assert.equal(result.substitutions, c.changes); if (c.name.startsWith("distant")) { assert.deepEqual(result.glyphs[0].sources, [{ from: 0, to: 1 }, { from: 100_001, to: 100_002 }]); assert.ok(result.glyphs.slice(1).every(g => g.attachment?.glyphIndex === 0 && g.attachment.component === 0)); } }
        if (trial >= 3) samples.push({ elapsedMs, constructorMs, heapBefore: before.heapUsed, heapAfter: after.heapUsed, slicesMs: distribution(slices), workDeltas: deltas, endingPhases: phases, maximum,
            steps: slices.length, workUnits: c.builder ? c.n : step.workUnits, finalPhase: c.builder ? "finish" : step.phase, preparedGlyphs: c.builder ? built.length : step.preparedGlyphs,
            publishedGlyphs: c.builder ? built.length : step.publishedGlyphs, glyphs: result?.glyphs.length ?? built?.length ?? null, substitutions: result?.substitutions ?? null });
    }
    cases.push({ name: c.name, inputGlyphs: c.n, builder: !!c.builder, budget: c.budget, cancel: c.cancel ?? null, warmup: 3, measured: samples.length, elapsedMs: distribution(samples.map(s => s.elapsedMs)), constructorMs: distribution(samples.map(s => s.constructorMs)), maximumSliceMs: distribution(samples.map(s => Math.max(...s.slicesMs.samples))), samples });
    console.log(JSON.stringify({ name: c.name, elapsedP95Ms: cases.at(-1).elapsedMs.p95, constructorP95Ms: cases.at(-1).constructorMs.p95, maximumSliceP95Ms: cases.at(-1).maximumSliceMs.p95 }));
}
assert.equal((await sourceIdentity()).sha256, source.sha256); await mkdir("artifacts/bench/substitution-cursor", { recursive: true });
await writeFile("artifacts/bench/substitution-cursor/latest.json", JSON.stringify({ schemaVersion: 1, created: new Date().toISOString(), source, environment: environment(), cases,
    note: "Already compiled GSUB plans and supplied nominal records; font parsing/compilation, caller mapping, records/batch allocation and initial owned runs precede clocks. Builder condition measures constructor, every <=256-record append, immutable block-root finish and disposal. Other conditions measure cursor construction, every next, timing bookkeeping and disposal. Raw slices include native allocation/freeze and GC; maximum-call end phase retained. Builder deltas count supplied records; cursor deltas count inspected kernel operations. Budgets are quanta, not hard time deadlines. CPU draining performs no event-loop scheduling; browser scenarios separately cover bounded input preparation, GSUB->positioning, native typing/frame progress across font replacement and cancellation. 3 warmups/20 measurements. Raw heap samples are neither peak nor stabilized retained bytes. Complete Unicode/script/mask/fallback/variable geometry, combined layout lifecycle, cooperative compilation and actual renderer integration remain open. No runtime dependency/worker/WASM selected." }, null, 2));
