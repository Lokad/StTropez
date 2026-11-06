import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { TextBuffer, SfntFont, normalizeText, itemizeScripts, createScriptItemizationCursor, createScriptGlyphCursor } from "../src/index.ts";
import { scriptFontFixture } from "../tests/fixtures/script-layout.ts";
import { distribution, environment, sourceIdentity } from "./measurement.mjs";

const verify = process.argv.includes("--verify"), now = () => verify ? 0 : performance.now(), source = await sourceIdentity(), font = SfntFont.from(scriptFontFixture()), budget = 4096, cases = [];
const plans = new Map([["Latn", "latn"], ["Grek", "grek"], ["Hebr", "hebr"]].map(([alias, script]) => [alias, { sub: font.substitutionPlan({ script, features: [{ tag: "test" }] }), pos: font.positioningPlan({ script, features: [] }) }]));
const prepared = [
    { name: "ascii-200000", input: "A".repeat(200_000), runs: 1, clusters: 200_000 },
    { name: "nested-scripts-180000", input: "A(α[א]β)B".repeat(20_000), runs: 80_001, clusters: 180_000, pairs: 40_000 },
    { name: "foreign-marks-90000", input: "A" + "\u05b0".repeat(90_000), runs: 1, clusters: 1 },
    { name: "shared-script-160000", input: "Aーアあ".repeat(40_000), runs: 120_000, clusters: 160_000 },
    { name: "malformed-brackets-60002", input: "A" + "(".repeat(20_000) + "[".repeat(20_000) + "}".repeat(20_000) + ")", runs: 1, clusters: 60_002, pairs: 1, unmatched: 59_999, maxBracketDepth: 50_000 },
    { name: "partition-150000", input: "Aαא".repeat(50_000), runs: 150_000, mode: "partition" },
    { name: "itemization-through-positioning-60000", input: "AAααאא".repeat(10_000), runs: 30_000, clusters: 60_000, mode: "pipeline", glyphs: 60_000, units: 26_000_000 },
    ...["resolve", "publish"].map(cancel => ({ name: `cancel-${cancel}-180000`, input: "A(α[א]β)B".repeat(20_000), cancel }))
];
const complete = cursor => { let step = cursor.next(65536); while (step.status === "running") step = cursor.next(65536); const result = step.result; cursor.dispose(); return result; };
for (const c of prepared) {
    const text = normalizeText(TextBuffer.from(c.input), { form: "none" }), supplied = c.mode === "partition" ? itemizeScripts(text) : null,
        mapping = c.mode ? complete(font.createGlyphMappingCursor(text)) : null, reads = text.source.readMetrics(), samples = [];
    for (let trial = 0; trial < (verify ? 1 : 23); trial++) {
        const before = process.memoryUsage(), start = now(), slices = [], deltas = [], phases = {}, stages = {}, constructions = {}; let constructorMs = 0, maximumConstructor = { elapsedMs: 0, stage: "itemize" };
        const create = (stage, make) => { const at = now(), cursor = make(), elapsedMs = now() - at; constructorMs += elapsedMs; constructions[stage] = (constructions[stage] ?? 0) + 1; if (elapsedMs > maximumConstructor.elapsedMs) maximumConstructor = { elapsedMs, stage }; return cursor; };
        let stage = c.mode === "partition" ? "partition" : "itemize", cursor = create(stage, () => c.mode === "partition" ? createScriptGlyphCursor(mapping, supplied) : createScriptItemizationCursor(text, { maxBracketDepth: c.maxBracketDepth ?? 1024 })),
            prior = 0, index = supplied, parts = null, shaped = null, part = 0, glyphs = 0, units = 0, first = null, step = null, maximum = { elapsedMs: 0, stage, phase: "cluster", workUnits: 0 };
        while (true) {
            const at = now(); step = cursor.next(budget); const elapsedMs = now() - at, delta = step.workUnits - prior; prior = step.workUnits; slices.push(elapsedMs); deltas.push(delta);
            const key = `${stage}:${step.phase}`; phases[key] = (phases[key] ?? 0) + 1; if (elapsedMs > maximum.elapsedMs) maximum = { elapsedMs, stage, phase: step.phase, workUnits: delta };
            if (c.cancel && step.status === "running" && step.phase === c.cancel) break;
            if (step.status !== "ready") continue;
            stages[stage] = (stages[stage] ?? 0) + step.workUnits; cursor.dispose();
            if (stage === "itemize") {
                index = step.result; if (c.mode !== "pipeline") break; stage = "partition"; cursor = create(stage, () => createScriptGlyphCursor(mapping, index));
            } else if (stage === "partition") {
                parts = step.result; if (c.mode !== "pipeline") break; stage = "substitute"; cursor = create(stage, () => plans.get(parts.at(part).script.script).sub.createCursor(parts.at(part).glyphs));
            } else if (stage === "substitute") {
                shaped = step.result; stage = "position"; cursor = create(stage, () => plans.get(parts.at(part).script.script).pos.createCursor(shaped));
            } else {
                glyphs += step.result.glyphs.length; units += step.result.advances.total; first ??= step.result.glyphs[0];
                if (++part === parts.length) break; stage = "substitute"; cursor = create(stage, () => plans.get(parts.at(part).script.script).sub.createCursor(parts.at(part).glyphs));
            }
            prior = 0;
        }
        cursor.dispose(); const elapsedMs = now() - start, after = process.memoryUsage(); assert.equal(cursor.snapshot().result, null); assert.equal(cursor.snapshot().status, "disposed"); assert.ok(deltas.every(d => d <= budget + 256)); assert.deepEqual(text.source.readMetrics(), reads);
        if (c.cancel) { assert.equal(step.status, "running"); assert.equal(step.result, null); assert.equal(step.phase, c.cancel); }
        else {
            assert.equal(index.runCount, c.runs); if (c.clusters !== undefined) assert.equal(index.clusterCount, c.clusters); assert.equal(index.text, text);
            if (!c.mode) { assert.equal(step.pairedBrackets, c.pairs ?? 0); assert.equal(step.unmatchedBrackets, c.unmatched ?? 0); assert.equal(index.scriptAt(index.to - 1), c.name.startsWith("shared") ? "Hira" : "Latn"); }
            if (parts) { assert.equal(parts.length, c.runs); assert.equal(parts.at(0).glyphs.at(0), mapping.run.at(0)); }
            if (c.mode === "partition") assert.equal(step.scannedGlyphs, mapping.run.length);
            if (c.mode === "pipeline") { assert.equal(glyphs, c.glyphs); assert.equal(units, c.units); assert.deepEqual(first.source.components, [[{ from: 0, to: 1 }]]); assert.equal(constructions.substitute, c.runs); assert.equal(constructions.position, c.runs); }
            assert.equal(deltas.reduce((a, b) => a + b, 0), Object.values(stages).reduce((a, b) => a + b, 0));
        }
        if (!verify && trial >= 3) samples.push({ elapsedMs, constructorMs, maximumConstructor, constructions, heapBefore: before.heapUsed, heapAfter: after.heapUsed,
            slicesMs: distribution(slices), workDeltas: deltas, endingPhases: phases, maximum, stages, steps: slices.length, workUnits: deltas.reduce((a, b) => a + b, 0), finalStage: stage, finalPhase: step.phase,
            runs: index?.runCount ?? null, clusters: index?.clusterCount ?? null, parts: parts?.length ?? null, glyphs: c.mode === "pipeline" ? glyphs : null, advanceUnits: c.mode === "pipeline" ? units : null });
    }
    if (verify) { console.log(`Verified ${c.name}`); continue; }
    cases.push({ name: c.name, inputPoints: text.length, budget, mode: c.mode ?? "itemize", cancel: c.cancel ?? null, warmup: 3, measured: samples.length,
        elapsedMs: distribution(samples.map(s => s.elapsedMs)), constructorMs: distribution(samples.map(s => s.constructorMs)), maximumSliceMs: distribution(samples.map(s => Math.max(...s.slicesMs.samples))), samples });
    console.log(JSON.stringify({ name: c.name, elapsedP95Ms: cases.at(-1).elapsedMs.p95, maximumSliceP95Ms: cases.at(-1).maximumSliceMs.p95 }));
}
assert.equal((await sourceIdentity()).sha256, source.sha256);
if (!verify) { await mkdir("artifacts/bench/scripts", { recursive: true }); await writeFile("artifacts/bench/scripts/latest.json", JSON.stringify({ schemaVersion: 1, created: new Date().toISOString(), source, environment: environment(), unicode: "18.0.0", cases,
    note: "Source construction, explicit none-normalization, font parsing/plan compilation and mapping precede clocks. Partition-only script indexes also precede clocks. Pipeline measures itemization, owned glyph partitioning and per-run GSUB/positioning; completed positions are consumed into totals rather than retained as a whole renderer result. Constructors, next calls, transitions, timing bookkeeping and disposal are included. Raw slice clocks/work deltas, maximum-call ending stage/phase and heap observations retained. Native allocation/freeze/GC remain atomic; counted quanta do not guarantee time deadlines. CPU draining has no event-loop scheduling. Browser tests separately exercise actual scheduled feature dispatch and native typing/replacement. Script interpretation is a documented contextual policy, independent of bidi, language/font selection and complete complex-script shaping. Font-aware normalization/fallback, feature masks, variable/outline/ink/caret geometry, combined workspace lifecycle, compilation scheduling and renderer/production budgets remain open. No runtime dependency/worker/WASM selected. --verify executes all assertions once with clocks disabled and writes no measurement report." }, null, 2)); }
