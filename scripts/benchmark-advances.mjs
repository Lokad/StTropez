import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { AdvanceIndex, createAdvanceBuilder } from "../src/index.ts";
import { distribution, environment, sourceIdentity } from "./measurement.mjs";

const source = await sourceIdentity(), cases = [];
for (const config of [{ name: "positive-2400000", length: 2_400_000, pattern: [32.25] }, { name: "signed-200000", length: 200_000, pattern: [4, -4] },
    { name: "zero-1000000", length: 1_000_000, pattern: [0] }, { name: "mixed-200000", length: 200_000, pattern: [9.25, 0, -1.5, 3.75] }]) {
    const values = new Float64Array(config.length), prefixes = new Float64Array(config.length + 1), samples = [];
    for (let i = 0; i < values.length; i++) { values[i] = config.pattern[i % config.pattern.length]; prefixes[i + 1] = prefixes[i] + values[i]; }
    for (let trial = 0; trial < 23; trial++) {
        const builder = createAdvanceBuilder(), appendMs = [], buildStart = performance.now();
        for (let from = 0; from < values.length; from += 256) {
            const start = performance.now(); builder.append(values, from, Math.min(values.length, from + 256)); appendMs.push(performance.now() - start);
            assert.equal(builder.snapshot().result, null);
        }
        const buildLoopMs = performance.now() - buildStart, sealStart = performance.now(), index = builder.finish(), sealMs = performance.now() - sealStart;
        builder.dispose(); assert.equal(index.total, prefixes.at(-1));
        const prefixMs = [], offsets = [0, Math.floor(values.length / 2), values.length];
        for (let query = 0; query < 60; query++) {
            const at = query < 3 ? offsets[query] : query * 719 % values.length, start = performance.now(), actual = index.prefix(at); prefixMs.push(performance.now() - start); assert.equal(actual, prefixes[at]);
        }
        const low = config.name.startsWith("signed") ? 4 : config.name.startsWith("zero") ? -.5 : index.total - 256;
        const high = config.name.startsWith("signed") ? 5 : config.name.startsWith("zero") ? .5 : index.total, windowStart = performance.now(), window = index.window(low, high, 64), windowMs = performance.now() - windowStart;
        if (config.name.startsWith("signed")) { assert.equal(window.cells.length, 0); assert.equal(window.readValues, 0); assert.equal(window.visitedNodes, 1); }
        if (config.name.startsWith("zero")) { assert.equal(window.cells.length, 64); assert.equal(window.truncated, true); }
        if (config.name.startsWith("positive")) { assert.equal(window.truncated, false); assert.ok(window.cells.length > 0); assert.ok(window.readValues <= 512); assert.ok(window.visitedNodes < 100); }
        for (const cell of window.cells) { assert.equal(cell.from, prefixes[cell.index]); assert.equal(cell.to, prefixes[cell.index + 1]); }
        const at = Math.floor(values.length / 2), replacement = values[at] + 1.25, updateStart = performance.now();
        const changed = index.replace(at, at + 1, AdvanceIndex.from([replacement])), updateMs = performance.now() - updateStart;
        const flatStart = performance.now(), flat = prefixes.slice(); for (let i = at + 1; i < flat.length; i++) flat[i] += 1.25; const flatUpdateMs = performance.now() - flatStart;
        for (const offset of offsets) assert.equal(changed.prefix(offset), flat[offset]); assert.equal(index.total, prefixes.at(-1));
        const versions = [index, changed]; let current = changed;
        for (let edit = 0; edit < 25; edit++) { const offset = edit * 7919 % index.length; current = current.replace(offset, offset + 1, AdvanceIndex.from([2.5])); versions.push(current); }
        const retained = AdvanceIndex.retained(versions); assert.ok(retained.values < values.length + 256 * 100);
        if (trial >= 3) samples.push({ buildLoopMs, appendMs, sealMs, prefixMs, windowMs, window, updateMs, flatUpdateMs, retained, diagnostics: index.diagnostics() });
    }
    const result = { name: config.name, length: config.length, warmup: 3, measured: samples.length, buildLoopMs: distribution(samples.map(s => s.buildLoopMs)),
        appendMs: distribution(samples.flatMap(s => s.appendMs)), sealMs: distribution(samples.map(s => s.sealMs)), prefixMs: distribution(samples.flatMap(s => s.prefixMs)),
        windowMs: distribution(samples.map(s => s.windowMs)), updateMs: distribution(samples.map(s => s.updateMs)), flatUpdateMs: distribution(samples.map(s => s.flatUpdateMs)), samples };
    cases.push(result); console.log(JSON.stringify({ name: result.name, buildP95Ms: result.buildLoopMs.p95, appendP95Ms: result.appendMs.p95, sealP95Ms: result.sealMs.p95,
        updateP95Ms: result.updateMs.p95, flatUpdateP95Ms: result.flatUpdateMs.p95, maximumReadValues: Math.max(...samples.map(s => s.window.readValues)) }));
}
assert.equal((await sourceIdentity()).sha256, source.sha256); await mkdir("artifacts/bench/advances", { recursive: true });
await writeFile("artifacts/bench/advances/latest.json", JSON.stringify({ schemaVersion: 1, created: new Date().toISOString(), source, environment: environment(), cases,
    note: "Precomputed measured-value kernel; values/reference prefixes are generated before timing. Append calls copy at most 256 supplied advances and sealing publishes an existing root. buildLoopMs also includes orchestration, assertion and timing-sample overhead. Local replacement starts from already computed advances; it excludes font shaping, source/cluster mapping and view updates. Flat comparison copies a complete immutable prefix array and adjusts its suffix. Retention counters count actual shared nodes/numeric slots across 27 retained roots, not heap bytes or long-session memory. Signed/zero data and native-scale coordinates exercise geometry semantics without selecting a font backend. JavaScript binary64 sums use normal floating-point rounding; these fixtures use exact binary fractions. Desktop diagnostics, not renderer or production budgets." }, null, 2));
