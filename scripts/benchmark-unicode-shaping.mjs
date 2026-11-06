import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { TextBuffer, SfntFont, normalizeText, createNormalizationCursor } from "../src/index.ts";
import { fontFixture } from "../tests/fixtures/consumer/font-fixture.ts";
import { distribution, environment, sourceIdentity } from "./measurement.mjs";

const source = await sourceIdentity(), font = SfntFont.from(fontFixture()), cases = [], budget = 4096;
const substitution = font.substitutionPlan({ features: [{ tag: "liga" }] }), positioning = font.positioningPlan({ features: [], legacyKerning: true });
const prepared = [
    { name: "nfc-ascii-200000", text: "A".repeat(200_000), form: "NFC", points: 200_000 },
    { name: "nfkd-mixed-60000", text: "é각ﬁ".repeat(20_000), form: "NFKD", points: 140_000 },
    { name: "nfd-canonical-segment-90000", text: "A" + "\u0315\u0300\u0323".repeat(30_000), form: "NFD", points: 90_001 },
    { name: "nfc-hangul-75000", text: "각".repeat(25_000), form: "NFC", points: 25_000 },
    { name: "mapping-160000", text: "ﬁAB A\ufe0f😀".repeat(20_000), form: "NFKD", points: 160_000, mode: "map", glyphs: 140_000 },
    { name: "normalization-through-positioning-160000", text: "ﬁAB A\ufe0f😀".repeat(20_000), form: "NFKD", points: 160_000, mode: "pipeline", glyphs: 120_000, units: 77_000_000 },
    { name: "cancel-normalization-compose-90000", text: "A" + "\u0315\u0300\u0323".repeat(30_000), form: "NFC", cancel: "compose" },
    { name: "cancel-mapping-publish-160000", text: "ﬁAB A\ufe0f😀".repeat(20_000), form: "NFKD", mode: "map", cancel: "publish" }
];
for (const c of prepared) {
    const buffer = TextBuffer.from(c.text), supplied = c.mode === "map" ? normalizeText(buffer, { form: c.form }) : null, samples = [];
    for (let trial = 0; trial < 23; trial++) {
        const reads = buffer.readMetrics(), before = process.memoryUsage(), start = performance.now(), tasks = [], constructors = [];
        const create = (stage, make) => { const at = performance.now(), cursor = make(); constructors.push({ stage, elapsedMs: performance.now() - at }); tasks.push(cursor); return cursor; };
        let stage = c.mode === "map" ? "map" : "normalize", cursor = create(stage, () => c.mode === "map" ? font.createGlyphMappingCursor(supplied) : createNormalizationCursor(buffer, { form: c.form })),
            previous = 0, normalized = supplied, mapped = null, shaped = null, result = null, step = null, maximum = { elapsedMs: 0, stage, phase: "scan", workUnits: 0 };
        const slices = [], deltas = [], phases = {}, stages = {};
        while (true) {
            const at = performance.now(); step = cursor.next(budget); const elapsedMs = performance.now() - at, delta = step.workUnits - previous; previous = step.workUnits;
            slices.push(elapsedMs); deltas.push(delta); const key = `${stage}:${step.phase}`; phases[key] = (phases[key] ?? 0) + 1;
            if (elapsedMs > maximum.elapsedMs) maximum = { elapsedMs, stage, phase: step.phase, workUnits: delta };
            assert.ok(slices.length < 1_000_000);
            if (c.cancel && step.status === "running" && step.phase === c.cancel) break;
            if (step.status !== "ready") continue;
            stages[stage] = { workUnits: step.workUnits, steps: Object.entries(phases).filter(([k]) => k.startsWith(`${stage}:`)).reduce((n, [, v]) => n + v, 0) };
            if (stage === "normalize") normalized = step.result;
            else if (stage === "map") mapped = step.result;
            else if (stage === "substitute") shaped = step.result;
            else result = step.result;
            cursor.dispose();
            if (c.mode !== "pipeline" || stage === "position") break;
            if (stage === "normalize") { stage = "map"; cursor = create(stage, () => font.createGlyphMappingCursor(normalized)); }
            else if (stage === "map") { stage = "substitute"; cursor = create(stage, () => substitution.createCursor(mapped.run)); }
            else { stage = "position"; cursor = create(stage, () => positioning.createCursor(shaped)); }
            previous = 0;
        }
        for (const task of tasks) task.dispose(); const elapsedMs = performance.now() - start, after = process.memoryUsage();
        for (const task of tasks) { assert.equal(task.snapshot().status, "disposed"); assert.equal(task.snapshot().result, null); }
        assert.ok(deltas.every(d => d <= budget + 512)); assert.equal(buffer.readMetrics().textExports, 0);
        if (c.cancel) { assert.equal(step.status, "running"); assert.equal(step.result, null); assert.equal(step.phase, c.cancel); }
        else {
            assert.equal(normalized.length, c.points); assert.equal(normalized.text(), c.text.normalize(c.form));
            assert.equal(normalized.source, buffer); assert.ok(Object.isFrozen(normalized.at(0).sources));
            if (c.name.includes("canonical-segment")) assert.ok(stages.normalize.workUnits < buffer.length * 32);
            if (c.mode === "map") { assert.equal(mapped.run.length, c.glyphs); assert.equal(mapped.missingGlyphs, 0); assert.deepEqual(mapped.run.at(0).sources, [{ from: 0, to: 1 }]); assert.deepEqual(mapped.run.at(1).sources, [{ from: 0, to: 1 }]); }
            if (c.mode === "pipeline") { assert.equal(result.glyphs.length, c.glyphs); assert.equal(result.advances.total, c.units); assert.deepEqual(result.glyphs[0].source.components, [[{ from: 0, to: 1 }], [{ from: 0, to: 1 }]]); }
        }
        const readUnits = buffer.readMetrics().sliceUnits - reads.sliceUnits;
        if (c.mode === "map") assert.equal(readUnits, 0);
        if (trial >= 3) samples.push({ elapsedMs, constructorMs: constructors.reduce((n, c) => n + c.elapsedMs, 0), constructors, heapBefore: before.heapUsed, heapAfter: after.heapUsed,
            slicesMs: distribution(slices), workDeltas: deltas, endingPhases: phases, maximum, stages, steps: slices.length, readUnits, finalStage: stage, finalPhase: step.phase,
            points: normalized?.length ?? null, mappedGlyphs: mapped?.run.length ?? null, glyphs: result?.glyphs.length ?? null, advanceUnits: result?.advances.total ?? null });
    }
    cases.push({ name: c.name, sourceUnits: buffer.length, normalizedPoints: c.points ?? null, form: c.form, mode: c.mode ?? "normalize", cancel: c.cancel ?? null, budget, warmup: 3, measured: samples.length,
        elapsedMs: distribution(samples.map(s => s.elapsedMs)), constructorMs: distribution(samples.map(s => s.constructorMs)), maximumSliceMs: distribution(samples.map(s => Math.max(...s.slicesMs.samples))), samples });
    console.log(JSON.stringify({ name: c.name, elapsedP95Ms: cases.at(-1).elapsedMs.p95, maximumSliceP95Ms: cases.at(-1).maximumSliceMs.p95 }));
}
assert.equal((await sourceIdentity()).sha256, source.sha256); await mkdir("artifacts/bench/unicode-shaping", { recursive: true });
await writeFile("artifacts/bench/unicode-shaping/latest.json", JSON.stringify({ schemaVersion: 1, created: new Date().toISOString(), source, environment: environment(), unicode: "18.0.0", cases,
    note: "Caller source construction, font parsing/plan compilation and mapping-only normalized inputs precede clocks. Pipeline clocks include each cursor construction, next, stage transition, timing bookkeeping and disposal. Validation and explicit text exports follow clocks. Stable Unicode controls use native normalization; complete Unicode18 conformance is checked separately against licensed data. Raw slice clocks, counted deltas, maximum-call ending stage/phase and heap observations retained. Quanta do not bound atomic native allocation/freeze/GC time. CPU draining has no event-loop scheduling. Unbounded canonical segments require proportional temporary storage. Heap samples are neither stabilized retained nor peak bytes. Browser scenarios separately exercise diagnostic source/style/font capture and native typing. Font-aware normalization, script itemization/masks/fallback, variable/outline/ink/caret geometry, combined workspace lifecycle, compilation scheduling and renderer integration remain open. No runtime dependency/worker/WASM selected." }, null, 2));
