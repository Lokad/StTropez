import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { TextBuffer, normalizeText, SfntFont, FontCascade, createFontNormalizationCursor, createNormalizedGraphemeCursor } from "../src/index.ts";
import { coverageFontFixture } from "../tests/fixtures/font-coverage.ts";
import { fallbackFontFixtures } from "../tests/fixtures/fallback-layout.ts";
import { createFallbackPipeline } from "../examples/shaping/fallback-pipeline.ts";
import { sourceIdentity, distribution, environment } from "./measurement.mjs";
const verify = process.argv.includes("--verify"), now = () => verify ? 0 : performance.now(), source = await sourceIdentity(), budget = 4096, cases = [];
const font = (points, variants = []) => SfntFont.from(coverageFontFixture(points, variants)), primary = font([65, 0x301, 0x30a, 0x327, 0xc5]), alias = font([0x2126]), emoji = font([0x1f469, 0x1f4bb]),
    variation = font([], [{ base: 0x2764, selector: 0xfe0f, glyph: 8 }]);
const prepared = [
    { name: "ascii-200000", input: "A".repeat(200_000), fonts: [primary], points: 200_000, clusters: 200_000, runs: 1, fontIndex: 0 },
    { name: "partial-composition-20000", input: "A\u0327\u030a\u0301".repeat(20_000), fonts: [primary, font([0x1fa, 0x327])], points: 60_000, clusters: 20_000, runs: 1, fontIndex: 0 },
    { name: "aliases-30000", input: "Ω".repeat(30_000), fonts: [alias], points: 30_000, clusters: 30_000, runs: 1, fontIndex: 0, first: 0x2126 },
    { name: "whole-emoji-fallback-20000", input: "👩‍💻".repeat(20_000), fonts: [font([0x1f469]), emoji], points: 60_000, clusters: 20_000, runs: 1, fontIndex: 1 },
    { name: "variation-priority-20000", input: "❤\ufe0f".repeat(20_000), fonts: [font([0x2764]), variation], points: 40_000, clusters: 20_000, runs: 1, fontIndex: 1 },
    { name: "marks-1000000", input: "A" + "\u0301".repeat(1_000_000), fonts: [primary], points: 1_000_001, clusters: 1, runs: 1, fontIndex: 0 },
    { name: "reused-graphemes-200000", input: "A".repeat(200_000), fonts: [primary], points: 200_000, clusters: 200_000, runs: 1, fontIndex: 0, reuse: true },
    { name: "font-through-positioning-30000", input: "Aα".repeat(15_000), fonts: fallbackFontFixtures().map(bytes => SfntFont.from(bytes)), points: 30_000, clusters: 30_000, runs: 30_000, pipeline: true, pixels: 900_000 },
    { name: "cancel-search-hangul", input: "각".repeat(20_000), fonts: [font([0xac02]), font([0xac01])], cancel: "search" },
    ...["normalize", "publish"].map(cancel => ({ name: `cancel-${cancel}-90000`, input: "A" + "\u0301".repeat(90_000), fonts: [primary], cancel }))
];
function complete(cursor) { try { let s = cursor.next(65536); while (s.status === "running") s = cursor.next(65536); return s.result; } finally { cursor.dispose(); } }
for (const c of prepared) {
    const caseBudget = c.cancel === "search" ? 256 : budget, text = normalizeText(TextBuffer.from(c.input), { form: "none" }), cascade = FontCascade.from(c.fonts), graphemes = c.reuse ? complete(createNormalizedGraphemeCursor(text)) : undefined, reads = text.source.readMetrics(), samples = [];
    for (let trial = 0; trial < (verify ? 1 : 23); trial++) {
        const before = process.memoryUsage(), began = now(), cursor = c.pipeline ? createFallbackPipeline(text, cascade, "composed") : createFontNormalizationCursor(text, cascade, { graphemes }), constructorMs = now() - began,
            slices = [], deltas = [], phases = {}; let step, previous = 0, maximum = { elapsedMs: 0, phase: "grapheme", workUnits: 0 };
        while (true) { const at = now(); step = cursor.next(caseBudget); const elapsedMs = now() - at, delta = step.workUnits - previous; previous = step.workUnits; slices.push(elapsedMs); deltas.push(delta); phases[step.phase] = (phases[step.phase] ?? 0) + 1;
            if (elapsedMs > maximum.elapsedMs) maximum = { elapsedMs, phase: step.phase, workUnits: delta }; if (c.cancel && step.status === "running" && step.phase === c.cancel || step.status === "ready") break;
            assert.equal(step.result, null);
        }
        cursor.dispose(); const elapsedMs = now() - began, after = process.memoryUsage(), result = c.pipeline ? step.result?.fonts : step.result;
        assert.deepEqual(text.source.readMetrics(), reads); assert.equal(cursor.snapshot().status, "disposed"); assert.equal(cursor.snapshot().result, null); assert.ok(deltas.every(d => d <= caseBudget + (c.pipeline ? 512 : 256)));
        if (c.cancel) { assert.equal(step.status, "running"); assert.equal(step.result, null); assert.equal(step.phase, c.cancel); }
        else { assert.equal(result.text.form, "font"); assert.equal(result.text.length, c.points); assert.equal(result.clusterCount, c.clusters); assert.equal(result.runCount, c.runs); assert.equal(result.input, text); assert.equal(result.text.at(0).codePoint, c.first ?? (c.name.startsWith("partial") ? 0xc5 : c.input.codePointAt(0)));
            for (let i = 0; i < result.clusterCount; i++) { const cluster = result.clusterAt(i); assert.equal(cluster.coverage, "covered"); if (c.fontIndex !== undefined) assert.equal(cluster.fontIndex, c.fontIndex); }
            if (c.pipeline) { assert.equal(step.result.parts.length, 30_000); assert.equal(step.result.pixels, c.pixels); assert.deepEqual(step.result.parts[0].positioned.glyphs[0].source.components, [[{ from: 0, to: 1 }]]); }
        }
        if (!verify && trial >= 3) samples.push({ elapsedMs, constructorMs, heapBefore: before.heapUsed, heapAfter: after.heapUsed, slicesMs: distribution(slices), workDeltas: deltas, endingPhases: phases, maximum, steps: slices.length, workUnits: step.workUnits,
            clusters: result?.clusterCount ?? null, fontRuns: result?.runCount ?? null, outputPoints: result?.text.length ?? null, searchStates: c.pipeline ? null : step.searchStates, fontsTried: c.pipeline ? null : step.fontsTried, finalPhase: step.phase, pixels: c.pipeline ? step.result?.pixels ?? null : null });
    }
    if (verify) { console.log(`Verified ${c.name}`); continue; }
    cases.push({ name: c.name, inputPoints: text.length, sourceUnits: text.source.length, pipeline: c.pipeline ?? false, reusedGraphemes: c.reuse ?? false, cancel: c.cancel ?? null, budget: caseBudget, warmup: 3, measured: samples.length,
        elapsedMs: distribution(samples.map(s => s.elapsedMs)), constructorMs: distribution(samples.map(s => s.constructorMs)), maximumSliceMs: distribution(samples.map(s => Math.max(...s.slicesMs.samples))), samples });
    console.log(JSON.stringify({ name: c.name, elapsedP95Ms: cases.at(-1).elapsedMs.p95, maximumSliceP95Ms: cases.at(-1).maximumSliceMs.p95 }));
}
assert.equal((await sourceIdentity()).sha256, source.sha256);
if (!verify) { await mkdir("artifacts/bench/font-normalization", { recursive: true }); await writeFile("artifacts/bench/font-normalization/latest.json", JSON.stringify({ schemaVersion: 1, created: new Date().toISOString(), source, environment: environment(), unicode: "18.0.0", cases,
    note: "Immutable original-point construction and font parsing/cascade capture precede clocks. Reused grapheme indexes also precede clocks. Per-cursor candidate compilation, canonical coverage/search, publication, constructors, timing bookkeeping and disposal are included. Fixture pipeline includes font/script selection, ranged mapping, per-run plan compilation, GSUB/GPOS and retained positioned parts. This explicit example uses ccmp/locl and Latn/Grek/Hebr/DFLT policy, not full language shaping. Query/semantic assertions follow clocks. Raw call clocks/work deltas/ending phases/maximum calls and heap observations are retained. Three warmups/twenty trials. CPU draining excludes event-loop scheduling. Native allocation/freeze/GC and compilation remain atomic: operation budgets do not qualify frame deadlines or stabilized retained/peak memory. Closed supplied-font cmap coverage does not certify glyph appearance, language/script support, default-ignorable advances, system font matching, variants/outlines/ink/carets or renderer integration. --verify runs all assertions once with clocks disabled and writes no measurement report." }, null, 2)); }
