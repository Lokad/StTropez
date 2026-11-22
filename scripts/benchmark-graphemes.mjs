import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { TextBuffer } from "../src/index.ts";
import { createGraphemeCursor } from "../src/kernels/index.ts";
import { distribution, environment, sourceIdentity } from "./measurement.mjs";

const verify = process.argv.includes("--verify"), now = () => verify ? 0 : performance.now(), source = await sourceIdentity(), budget = 4096, cases = [];
/** @typedef {{name: string, text: string, kind?: "string"} & ({clusters: number, cancel?: never} | {cancel: "scan" | "publish", clusters?: never})} Condition */
/** @type {Condition[]} */
const prepared = [
    { name: "ascii-rope-200000", text: "A".repeat(200_000), clusters: 200_000 },
    { name: "marks-rope-1000000", text: "A" + "\u0301".repeat(1_000_000), clusters: 1 },
    { name: "emoji-zwj-string-200005", text: "👩" + "\u0301".repeat(200_000) + "‍💻", clusters: 1, kind: "string" },
    { name: "regional-indicators-rope-200002", text: "🇦".repeat(100_001), clusters: 50_001 },
    { name: "unicode18-linker-extend-200002", text: "्" + "\u0301".repeat(200_000) + "क", clusters: 1 },
    { name: "crlf-rope-200000", text: "\r\n".repeat(100_000), clusters: 100_000 },
    .../** @type {const} */ (["scan", "publish"]).map(cancel => ({ name: `cancel-${cancel}-200000`, text: "A".repeat(200_000), cancel }))
];
for (const c of prepared) {
    const buffer = TextBuffer.from(c.text), samples = [];
    for (let trial = 0; trial < (verify ? 1 : 23); trial++) {
        const before = process.memoryUsage(), began = now(), constructorAt = now(), cursor = createGraphemeCursor(c.kind === "string" ? c.text : buffer), constructorMs = now() - constructorAt;
        const slices = [], deltas = [];
        /** @type {Partial<Record<ReturnType<typeof cursor.next>["phase"], number>>} */ const phases = {};
        let step, prior = 0, maximum = { elapsedMs: 0, phase: "scan", workUnits: 0 };
        while (true) {
            const at = now(); step = cursor.next(budget); const elapsedMs = now() - at, delta = step.workUnits - prior; prior = step.workUnits;
            slices.push(elapsedMs); deltas.push(delta); phases[step.phase] = (phases[step.phase] ?? 0) + 1;
            if (elapsedMs > maximum.elapsedMs) maximum = { elapsedMs, phase: step.phase, workUnits: delta };
            if (c.cancel && step.status === "running" && step.phase === c.cancel || step.status === "ready") break;
            assert.equal(step.result, null);
        }
        cursor.dispose(); const elapsedMs = now() - began, after = process.memoryUsage();
        assert.equal(cursor.snapshot().result, null); assert.equal(cursor.snapshot().status, "disposed"); assert.ok(deltas.every(d => d <= budget + 256)); assert.equal(buffer.readMetrics().textExports, 0);
        if (c.cancel) { assert.equal(step.status, "running"); assert.equal(step.phase, c.cancel); assert.equal(step.result, null); }
        else {
            const index = step.result; assert.ok(index, "Completed grapheme scan requires its published index."); assert.equal(index.clusterCount, c.clusters); assert.equal(index.boundaryCount, c.clusters + 1); assert.equal(index.boundaryAt(0), 0); assert.equal(index.to, buffer.length);
            assert.equal(index.following(0), index.boundaryAt(1)); assert.equal(index.preceding(index.to), index.boundaryAt(c.clusters - 1)); assert.equal(index.clusterIndexAt(index.to - 1), c.clusters - 1);
            assert.ok(step.workUnits < (buffer.length) * 8 + 256);
        }
        if (!verify && trial >= 3) samples.push({ elapsedMs, constructorMs, heapBefore: before.heapUsed, heapAfter: after.heapUsed, slicesMs: distribution(slices), workDeltas: deltas, endingPhases: phases, maximum,
            steps: slices.length, workUnits: step.workUnits, readUnits: step.readUnits, inputPoints: step.inputPoints, clusters: step.result?.clusterCount ?? null, publishedBoundaries: step.publishedBoundaries, finalPhase: step.phase });
    }
    if (verify) { console.log(`Verified ${c.name}`); continue; }
    const item = { name: c.name, inputUnits: buffer.length, coordinate: "utf16", kind: c.kind ?? "buffer", budget, cancel: c.cancel ?? null, warmup: 3, measured: samples.length,
        elapsedMs: distribution(samples.map(s => s.elapsedMs)), constructorMs: distribution(samples.map(s => s.constructorMs)), maximumSliceMs: distribution(samples.map(s => Math.max(...s.slicesMs.samples))), samples };
    cases.push(item); console.log(JSON.stringify({ name: c.name, elapsedP95Ms: item.elapsedMs.p95, maximumSliceP95Ms: item.maximumSliceMs.p95 }));
}
assert.equal((await sourceIdentity()).sha256, source.sha256);
if (!verify) {
    await mkdir("artifacts/bench/graphemes", { recursive: true }); await writeFile("artifacts/bench/graphemes/latest.json", JSON.stringify({ schemaVersion: 1, created: new Date().toISOString(), source, environment: environment(), unicode: "18.0.0", cases,
        note: "Immutable rope construction precedes clocks. Constructors, next calls, boundary publication, timing bookkeeping and disposal are included; query assertions follow clocks. Three warmups and twenty measured trials, raw call clocks/work deltas, ending phases, maximum calls and heap samples are retained. CPU draining does not measure event-loop scheduling. Counted work cannot bound atomic allocation/freeze/GC, frame deadlines or retained/peak memory. Browser tests separately exercise cooperative whole-line commands and stale captures. Browser-native shaping/fallback, language tailoring and certified ink/caret geometry are outside this segmentation benchmark. --verify runs all assertions once with clocks disabled and writes no measurement report." }, null, 2));
}
