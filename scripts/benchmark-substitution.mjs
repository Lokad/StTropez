import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { SfntFont } from "../src/index.ts";
import { fontFixture } from "../tests/fixtures/consumer/font-fixture.ts";
import { nativeSubstitutionCases } from "../tests/fixtures/substitution.ts";
import { distribution, environment, sourceIdentity } from "./measurement.mjs";

const source = await sourceIdentity(), original = SfntFont.from(fontFixture()), fixtures = nativeSubstitutionCases();
const prepared = [{ name: "compile-original", compile: true, font: original, feature: "liga", input: [] },
    ...[2_000, 20_000, 200_000].map(length => ({ name: `ligature-${length}`, font: original, feature: "liga", input: Array.from({ length }, (_, from) => ({ glyphId: from % 2 ? 5 : 4, source: { from, to: from + 1 } })), expectedCount: length / 2, expectedUnits: length / 2 * 500, expectedChanges: length / 2 })),
    { name: "multiple-20000", font: SfntFont.from(fixtures.find(c => c.name === "multiple").bytes), feature: "liga", input: Array.from({ length: 20_000 }, (_, from) => ({ glyphId: 3, source: { from, to: from + 1 } })), expectedCount: 40_000, expectedUnits: 12_000_000, expectedChanges: 20_000 },
    { name: "distant-marks-100000", font: SfntFont.from(fixtures.find(c => c.name === "ignored-mark").bytes), feature: "liga", input: Array.from({ length: 100_002 }, (_, from) => ({ glyphId: from === 0 ? 2 : from === 100_001 ? 3 : 9, source: { from, to: from + 1 } })), expectedCount: 100_001, expectedUnits: 500, expectedChanges: 1 },
    { name: "context-expansion-20000", font: SfntFont.from(fixtures.find(c => c.name === "context-expansion").bytes), feature: "liga", input: Array.from({ length: 20_000 }, (_, from) => ({ glyphId: [2, 3, 4, 5][from % 4], source: { from, to: from + 1 } })), expectedCount: 25_000, expectedUnits: 10_500_000, expectedChanges: 10_000 }];
const cases = [];
for (const c of prepared) {
    const plan = c.font.substitutionPlan({ features: [{ tag: c.feature }] }), samples = [];
    for (let trial = 0; trial < 23; trial++) {
        const before = process.memoryUsage(), start = performance.now(), result = c.compile ? c.font.substitutionPlan({ features: [{ tag: c.feature }] }) : plan.apply(c.input), elapsedMs = performance.now() - start, after = process.memoryUsage();
        let detail;
        if (c.compile) { assert.deepEqual(result.selection.lookups, [0]); detail = { lookups: result.selection.lookups.length }; }
        else {
            assert.equal(result.glyphs.length, c.expectedCount); assert.equal(result.substitutions, c.expectedChanges); let units = 0, sourceSpans = 0, marks = 0;
            for (const glyph of result.glyphs) { units += c.font.nominalGlyphMetrics(glyph.glyphId).advanceWidth; sourceSpans += glyph.sources.length; if (glyph.attachment) { marks++; assert.equal(glyph.attachment.glyphIndex, 0); assert.equal(glyph.attachment.component, 0); } }
            assert.equal(units, c.expectedUnits); if (c.name.startsWith("distant")) { assert.equal(marks, 100_000); assert.deepEqual(result.glyphs[0].sources, [{ from: 0, to: 1 }, { from: 100_001, to: 100_002 }]); }
            detail = { inputGlyphs: c.input.length, glyphs: result.glyphs.length, substitutions: result.substitutions, operations: result.operations, units, sourceSpans, marks,
                first: result.glyphs[0], last: result.glyphs.at(-1) };
        }
        if (trial >= 3) samples.push({ elapsedMs, heapBefore: before.heapUsed, heapAfter: after.heapUsed, ...detail });
    }
    cases.push({ name: c.name, warmup: 3, measured: samples.length, elapsedMs: distribution(samples.map(s => s.elapsedMs)), samples }); console.log(JSON.stringify({ name: c.name, p95Ms: cases.at(-1).elapsedMs.p95 }));
}
assert.equal((await sourceIdentity()).sha256, source.sha256); await mkdir("artifacts/bench/substitution", { recursive: true });
await writeFile("artifacts/bench/substitution/latest.json", JSON.stringify({ schemaVersion: 1, created: new Date().toISOString(), source, environment: environment(), cases,
    note: "Original TS OpenType GSUB stage over supplied logical glyphs/source spans. Compilation is separate from execution; font bytes, input and expected counts/units precede timing. Synchronous apply drains the shared cooperative kernel; this condition uses the raw-array validation/copy path, linked edits and frozen publication, with verification after clocks. All supplied context is available, including 100,000 ignored marks. Raw heap observations are neither retained nor peak bytes. These global clocks do not qualify event-loop responsiveness, ordinary edits, complete script shaping, fallback/variable geometry, ink/carets, renderer integration or production budgets. Separate cursor measurements retain slice clocks and owned input construction. Browser correctness retains27 original-font native cases per engine in both execution modes, including known single-character/mixed-script differences. No runtime package, worker or WASM selected." }, null, 2));

