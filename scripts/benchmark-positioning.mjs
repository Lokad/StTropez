import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { SfntFont } from "../src/index.ts";
import { nativePositioningCases, positionFont, cursivePos, markPos, anchor } from "../tests/fixtures/positioning.ts";
import { classes, gdef, lookup } from "../tests/fixtures/substitution.ts";
import { distribution, environment, sourceIdentity } from "./measurement.mjs";

const source = await sourceIdentity(), fixtures = nativePositioningCases(), pair = SfntFont.from(fixtures.find(c => c.name === "pair-values").bytes), legacy = SfntFont.from(fixtures.find(c => c.name === "legacy-pair").bytes), context = SfntFont.from(fixtures.find(c => c.name === "context-3").bytes);
const cursive = SfntFont.from(positionFont([lookup(3, [cursivePos([2], [{ entry: anchor(100, 100), exit: anchor(500, 200) }])])], { feature: "test" }));
const marks = SfntFont.from(positionFont([lookup(6, [markPos(6, [{ glyph: 9, markClass: 0, anchor: anchor(50, 700) }], [{ glyph: 9, components: [[anchor(100, 850)]] }], 1)])], { feature: "test", definition: gdef(classes(9, [3])) }));
const cases = [], prepared = [
    { name: "compile-pair", font: pair, compile: true },
    ...[2_000, 20_000, 200_000].map(n => ({ name: `pair-${n}`, font: pair, n, ids: [2, 3], total: n / 2 * 1150 })),
    { name: "context-20000", font: context, n: 20_001, ids: [2, 3, 4], total: 6_667 * 1600 },
    { name: "cursive-100000", font: cursive, n: 100_000, ids: [2], total: 99_999 * 400 + 600, lastY: 99_999 * 100 },
    { name: "mark-chain-100000", font: marks, n: 100_000, ids: [9], total: 0, lastY: 99_999 * 150 },
    { name: "legacy-rtl-200000", font: legacy, n: 200_000, ids: [3, 2], total: -100_000 * 1200, direction: "rtl", legacyKerning: true }
];
for (const c of prepared) {
    const options = { features: [{ tag: "test" }], direction: c.direction ?? "ltr", legacyKerning: c.legacyKerning ?? false }, plan = c.font.positioningPlan(options), input = c.compile ? null : c.font.substitutionPlan({ features: [] }).apply(Array.from({ length: c.n }, (_, from) => ({ glyphId: c.ids[from % c.ids.length], source: { from, to: from + 1 } }))), samples = [];
    for (let trial = 0; trial < 23; trial++) {
        const before = process.memoryUsage(), start = performance.now(), result = c.compile ? c.font.positioningPlan(options) : plan.apply(input), elapsedMs = performance.now() - start, after = process.memoryUsage(); let detail;
        if (c.compile) { assert.deepEqual(result.selection.lookups, [0]); detail = { lookups: result.selection.lookups.length }; }
        else {
            assert.equal(result.glyphs.length, c.n); assert.equal(result.advances.total, c.total); if (c.lastY !== undefined) assert.equal(result.glyphs.at(-1).y, c.lastY);
            const endpoint = result.advances.prefix(c.n), window = result.advances.window(Math.min(0, endpoint), Math.min(0, endpoint) + 1000, 16);
            assert.equal(endpoint, c.total); detail = { glyphs: c.n, total: endpoint, operations: result.operations, adjustments: result.adjustments, first: { x: result.glyphs[0].x, y: result.glyphs[0].y }, last: { x: result.glyphs.at(-1).x, y: result.glyphs.at(-1).y }, window: { cells: window.cells.length, reads: window.readValues, truncated: window.truncated } };
        }
        if (trial >= 3) samples.push({ elapsedMs, heapBefore: before.heapUsed, heapAfter: after.heapUsed, ...detail });
    }
    cases.push({ name: c.name, warmup: 3, measured: samples.length, elapsedMs: distribution(samples.map(s => s.elapsedMs)), samples }); console.log(JSON.stringify({ name: c.name, p95Ms: cases.at(-1).elapsedMs.p95 }));
}
assert.equal((await sourceIdentity()).sha256, source.sha256); await mkdir("artifacts/bench/positioning", { recursive: true });
await writeFile("artifacts/bench/positioning/latest.json", JSON.stringify({ schemaVersion: 1, created: new Date().toISOString(), source, environment: environment(), cases,
    note: "Original horizontal GPOS/explicit legacy kernel over supplied GSUB snapshots. Font/input/expected results precede timing. Compilation is separate. Execution includes input ownership, adjustments, iterative attachments, frozen glyph publication and signed retained AdvanceIndex construction; assertions/query checks follow timing. 3 warmups/20 measured samples. Raw heap observations are neither peak nor stabilized retained bytes. These synchronous global clocks do not qualify cooperative execution, ordinary edits, Unicode/script/masks/fallback/variable metrics/outlines/ink/carets, native placement policies, bounded rendering or production budgets. No worker, WASM or runtime dependency is selected." }, null, 2));
