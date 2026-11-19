import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { applyTextEdits, TextBuffer, TextDiff } from "../src/index.ts";
import { corpus } from "../fixtures/workloads.ts";
import { openHarness } from "./browser-harness.mjs";
import { distribution, environment, sourceIdentity } from "./measurement.mjs";

/** @typedef {ReturnType<Window["comparisonFixture"]["snapshot"]>["comparison"] & {
 * wallFrameProxyMs: number, hunks: number, exports: number, baselineExports: number, rows: number}} ComparisonSample */

const source = await sourceIdentity(), model = [];
const corpora = /** @type {const} */ (["normal", "lines-10000", "lines-100000", "single-line", "unicode"]);
/** @type {{id: string, text: string, edits: import("../src/index.ts").TextEdit[]}[]} */
const cases = corpora.map(id => {
    const text = corpus(id), at = Math.floor(text.length / 2); return { id, text, edits: [{ from: at, to: at, insert: "changed\r\n" }] };
});
cases.push({ id: "disjoint-lines", text: "baseline\n".repeat(10000), edits: [{ from: 0, to: 90000, insert: "working\n".repeat(10000) }] });
const varied = Array.from({ length: 2000 }, (_, index) => `key-${index}\n`); let offset = 0;
const scattered = varied.flatMap((line, index) => { const from = offset; offset += line.length; return index % 20 === 0 ? [{ from, to: offset, insert: `edited-${index}\n` }] : []; });
cases.push({ id: "many-hunks", text: varied.join(""), edits: scattered });
const repeated = "a\nb\nc\n".repeat(1000);
cases.push({ id: "repeated-rotation", text: repeated, edits: [{ from: 0, to: 2, insert: "" }, { from: repeated.length, to: repeated.length, insert: "a\n" }] });
for (const { id, text, edits } of cases) {
    const a = TextBuffer.from(text), b = a.apply(edits).buffer, expected = applyTextEdits(text, edits), samples = [];
    for (let iteration = 0; iteration < 13; iteration++) {
        const job = new TextDiff(a, b); let result, maxStepMs = 0, steps = 0; const start = performance.now();
        do { const before = performance.now(); result = job.next(32768); maxStepMs = Math.max(maxStepMs, performance.now() - before); steps++; } while (result.status === "running");
        const elapsedMs = performance.now() - start;
        assert.equal(result.status, "ready"); assert.ok(result.hunks.length > 0);
        let reconstructed = text;
        for (const h of [...result.hunks].reverse()) reconstructed = reconstructed.slice(0, h.baseline.from) + b.slice(h.working.from, h.working.to) + reconstructed.slice(h.baseline.to);
        assert.equal(reconstructed, expected);
        if (id === "many-hunks") assert.equal(result.hunks.length, 100);
        if (id === "repeated-rotation") assert.equal(result.lineEdits, 2);
        assert.equal(a.readMetrics().textExports, 0); assert.equal(b.readMetrics().textExports, 0);
        if (iteration >= 3) samples.push({ elapsedMs, maxStepMs, steps, hunks: result.hunks.length, work: result.work, readUnits: result.readUnits, lineComparisons: result.lineComparisons });
        job.dispose();
    }
    model.push({ corpus: id, length: text.length, warmup: 3, measured: 10, elapsedMs: distribution(samples.map(s => s.elapsedMs)), maxStepMs: distribution(samples.map(s => s.maxStepMs)), samples });
}
const harness = await openHarness(), browser = [];
try {
    for (const id of corpora) {
        await harness.page.goto("/comparison/");
        await harness.page.waitForFunction(() => window.comparisonFixture?.snapshot().status === "ready");
        const text = corpus(id), working = text.slice(0, Math.floor(text.length / 2)) + "changed\r\n" + text.slice(Math.floor(text.length / 2));
        await harness.page.evaluate(text => { window.comparisonFixture.setText(text); window.comparisonFixture.begin("accept"); window.comparisonFixture.finish("accept"); }, text);
        await harness.page.waitForFunction(() => window.comparisonFixture.snapshot().status === "ready");
        const warmup = id === "lines-100000" || id === "single-line" ? 0 : 2, measured = warmup ? 10 : 1, samples = [];
        for (let iteration = 0; iteration < warmup + measured; iteration++) {
            const sample = await harness.page.evaluate(text => /** @type {Promise<ComparisonSample>} */ (new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error("Comparison did not become ready.")), 60000);
                const start = performance.now(); window.comparisonFixture.setText(text);
                const check = () => { const s = window.comparisonFixture.snapshot();
                    if (s.status !== "ready" || s.editor.viewport.pending || s.reference?.pending) { requestAnimationFrame(check); return; }
                    if (!s.baseline || !s.reference) { clearTimeout(timeout); reject(new Error("Comparison measurement lost its baseline or reference viewport.")); return; }
                    clearTimeout(timeout); resolve({ wallFrameProxyMs: performance.now() - start, ...s.comparison, hunks: s.hunks.length, exports: s.working.exports, baselineExports: s.baseline.exports, rows: s.editor.viewport.rows + s.reference.rows });
                }; requestAnimationFrame(check);
            })), working);
            assert.equal(sample.hunks, 1); assert.equal(sample.exports, 0); assert.equal(sample.baselineExports, 0); assert.ok(sample.rows < 150);
            if (iteration >= warmup) samples.push(sample);
            // Exact reconstruction is verified outside timing, using bounded reads of both snapshots.
            assert.equal(await harness.page.evaluate(() => {
                const f = window.comparisonFixture, s = f.snapshot(), h = s.hunks[0];
                if (!h || !s.baseline) throw new Error("Comparison reconstruction requires its hunk and baseline.");
                const delta = h.working.to - h.working.from - (h.baseline.to - h.baseline.from);
                /** @param {number} a0 @param {number} b0 @param {number} length */
                const same = (a0, b0, length) => { for (let n = 0; n < length; n += 65536) { const count = Math.min(65536, length - n); if (f.baselineRange(a0 + n, a0 + n + count) !== f.range(b0 + n, b0 + n + count)) return false; } return true; };
                return s.working.length - s.baseline.length === delta && same(0, 0, h.baseline.from) && same(h.baseline.to, h.working.to, s.baseline.length - h.baseline.to);
            }), true);
            await harness.page.evaluate(text => window.comparisonFixture.setText(text), text);
            await harness.page.waitForFunction(() => window.comparisonFixture.snapshot().status === "ready");
        }
        browser.push({ corpus: id, length: text.length, warmup, measured, diagnosticOnly: measured === 1, wallFrameProxyMs: distribution(samples.map(s => s.wallFrameProxyMs)), maxStepMs: distribution(samples.map(s => s.maxStepMs)), samples });
    }
    assert.deepEqual(harness.errors, []); assert.equal((await sourceIdentity()).sha256, source.sha256);
    const report = { schemaVersion: 1, created: new Date().toISOString(), source, environment: { ...environment(), browser: harness.browser.version(), buildMode: harness.buildMode, viewport: { width: 1440, height: 900 } }, model, browser, errors: harness.errors,
        note: "Exact TypeScript line alignment; 32768 work units per core advance. Headless timing includes all advances without scheduling. The browser loop batches at most 32 advances, checking a four-millisecond elapsed limit after each advance. Its counter includes core publication and synchronous listeners or scheduling invoked inside advance, and excludes the outer render and final reschedule. It is not a complete task or callback duration. Wall values include transaction, scheduling, rendering/readiness polling and are not physical presentation. Largest browser cases have one diagnostic observation, no tail estimate. No worker, WASM, production budget or native-device qualification follows from this report." };
    await mkdir("artifacts/bench/comparison", { recursive: true }); await writeFile("artifacts/bench/comparison/latest.json", JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ model: model.map(s => ({ corpus: s.corpus, p95: s.elapsedMs.p95, stepP95: s.maxStepMs.p95 })), browser: browser.map(s => ({ corpus: s.corpus, samples: s.measured, wallProxyP95: s.wallFrameProxyMs.p95, stepP95: s.maxStepMs.p95 })) }, null, 2));
} finally { await harness.close(); }
