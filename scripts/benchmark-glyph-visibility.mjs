import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { SfntFont, TextBuffer, normalizeText } from "../src/index.ts";
import { coverageFontFixture } from "../tests/fixtures/font-coverage.ts";
import { assembleFont, fontTables } from "../tests/fixtures/consumer/font-fixture.ts";
import { gsub, ligatures, lookup, multiple, single } from "../tests/fixtures/substitution.ts";
import { sourceIdentity, distribution, environment } from "./measurement.mjs";
const source = await sourceIdentity(), verify = process.argv.includes("--verify"), now = () => verify ? 0 : performance.now(), budget = 4096, cases = [];
const finish = cursor => { try { let s = cursor.next(65536); while (s.status === "running") s = cursor.next(65536); return s.result; } finally { cursor.dispose(); } };
const font = entries => { const tables = fontTables(coverageFontFixture([[65, 3], [0x200d, 2]])); tables.set("GSUB", gsub(entries)); return SfntFont.from(assembleFont(tables)); };
const plain = font([]), singleFont = font([lookup(1, [single([2], [4])])]), multipleFont = font([lookup(2, [multiple([2], [[4, 5]])])]), ligatureFont = font([lookup(4, [ligatures([3], [[{ to: 6, rest: [2] }]])])]);
for (const c of [
    { name: "map-400000", kind: "map", font: plain, text: "A\u200d".repeat(200_000), n: 400_000 },
    { name: "single-200000", kind: "substitute", font: singleFont, text: "\u200d".repeat(200_000), n: 200_000 },
    { name: "multiple-100000", kind: "substitute", font: multipleFont, text: "\u200d".repeat(100_000), n: 200_000 },
    { name: "ligatures-100000", kind: "substitute", font: ligatureFont, text: "A\u200d".repeat(100_000), n: 100_000 },
    { name: "position-400000", kind: "position", font: plain, text: "A\u200d".repeat(200_000), n: 400_000, total: 140_000_000 },
    { name: "preserve-400000", kind: "position", font: plain, text: "A\u200d".repeat(200_000), n: 400_000, total: 260_000_000, preserve: true },
    ...["visibility", "publish"].map(cancel => ({ name: `cancel-${cancel}-400000`, kind: "position", font: plain, text: "A\u200d".repeat(200_000), cancel }))
]) {
    const text = normalizeText(TextBuffer.from(c.text), { form: "none" }), reads = text.source.readMetrics(), mapped = c.kind === "map" ? null : finish(c.font.createGlyphMappingCursor(text)),
        substitution = c.kind === "map" ? null : c.font.substitutionPlan({ features: [{ tag: "test" }] }), shaped = c.kind === "position" ? finish(substitution.createCursor(mapped.run)) : null,
        position = c.kind === "position" ? c.font.positioningPlan({ features: [], defaultIgnorables: c.preserve ? "preserve" : "hide" }) : null, samples = [];
    for (let trial = 0; trial < (verify ? 1 : 23); trial++) {
        const before = process.memoryUsage(), began = now(), cursor = c.kind === "map" ? c.font.createGlyphMappingCursor(text) : c.kind === "substitute" ? substitution.createCursor(mapped.run) : position.createCursor(shaped), constructorMs = now() - began;
        const slices = [], deltas = [], phases = {}; let s, previous = 0, maximum = { elapsedMs: 0, phase: "source", workUnits: 0 };
        while (true) { const at = now(); s = cursor.next(budget); const elapsedMs = now() - at, delta = s.workUnits - previous; previous = s.workUnits;
            slices.push(elapsedMs); deltas.push(delta); phases[s.phase] = (phases[s.phase] ?? 0) + 1; if (elapsedMs > maximum.elapsedMs) maximum = { elapsedMs, phase: s.phase, workUnits: delta };
            if (s.status === "ready" || c.cancel && s.phase === c.cancel) break; assert.equal(s.status, "running"); assert.equal(s.result, null); }
        cursor.dispose(); const elapsedMs = now() - began, after = process.memoryUsage(); assert.deepEqual(text.source.readMetrics(), reads); assert.equal(cursor.snapshot().result, null); assert.ok(deltas.every(d => d <= budget + 256));
        if (c.cancel) { assert.equal(s.status, "running"); assert.equal(s.result, null); }
        else if (c.kind === "map") { assert.equal(s.result.run.length, c.n); assert.equal(s.result.run.at(1).properties.defaultIgnorable, true); assert.equal(s.result.run.at(0).properties.defaultIgnorable, false); }
        else if (c.kind === "substitute") { assert.equal(s.result.glyphs.length, c.n); for (const g of s.result.glyphs) { assert.equal(g.properties.substituted, true); assert.equal(g.properties.zeroWidthJoiner, true); assert.equal(g.properties.ligated, c.font === ligatureFont); assert.equal(g.properties.defaultIgnorable, c.font !== ligatureFont); } }
        else { assert.equal(s.result.glyphs.length, c.n); assert.equal(s.result.advances.total, c.total); assert.equal(s.result.glyphs[1].hidden, !c.preserve); assert.equal(s.result.glyphs[1].xAdvance, c.preserve ? 600 : 0); }
        if (!verify && trial >= 3) samples.push({ elapsedMs, constructorMs, heapBefore: before.heapUsed, heapAfter: after.heapUsed, slicesMs: distribution(slices), workDeltas: deltas, endingPhases: phases, maximum, steps: slices.length, workUnits: s.workUnits, finalPhase: s.phase, total: s.result?.advances?.total ?? null });
    }
    if (verify) { console.log(`Verified ${c.name}`); continue; }
    const row = { name: c.name, kind: c.kind, inputPoints: text.length, glyphs: c.n ?? null, cancel: c.cancel ?? null, budget, warmup: 3, measured: samples.length,
        elapsedMs: distribution(samples.map(s => s.elapsedMs)), constructorMs: distribution(samples.map(s => s.constructorMs)), maximumSliceMs: distribution(samples.map(s => s.maximum.elapsedMs)), samples }; cases.push(row);
    console.log(JSON.stringify({ name: c.name, elapsedP95Ms: row.elapsedMs.p95, maximumSliceP95Ms: row.maximumSliceMs.p95 }));
}
assert.equal((await sourceIdentity()).sha256, source.sha256);
if (!verify) { await mkdir("artifacts/bench/glyph-visibility", { recursive: true }); await writeFile("artifacts/bench/glyph-visibility/latest.json", JSON.stringify({ schemaVersion: 1, created: new Date().toISOString(), source, environment: environment(), unicode: "18.0.0", cases,
    note: "Captured fonts/plans, raw normalized text, and prior pipeline stages precede clocks. Each condition measures its named cooperative stage, constructor, timing bookkeeping and disposal. Query assertions follow clocks. Three warmups/twenty trials; raw calls, work deltas, phases, maximum calls and heap observations retained. Cursor-local Unicode metadata and visibility masks are included. No event-loop, hard frame, stabilized retained-memory or full script shaping qualification. --verify disables clocks and writes no timing report." }, null, 2)); }
