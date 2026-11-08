import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { openHarness } from "./browser-harness.mjs";
import { distribution, environment, sourceIdentity } from "./measurement.mjs";
import { corpus, corpusIds } from "../tests/fixtures/workloads.ts";
const wholeWord = process.argv.includes("--whole-word"), harness = await openHarness();
try {
    await harness.page.goto(new URL("/editing/", harness.page.url()).href);
    // Full oracle validation is deliberately outside timed intervals and uses bounded buffer reads.
    const equalsText = expected => harness.page.evaluate(expected => {
        if (window.editingFixture.snapshot().document.length !== expected.length) return false;
        for (let from = 0; from < expected.length; from += 65536) {
            const to = Math.min(expected.length, from + 65536);
            if (window.editingFixture.range(from, to) !== expected.slice(from, to)) return false;
        }
        return true;
    }, expected);
    const ready = () => harness.page.waitForFunction(() => { const s = window.editingFixture?.snapshot(); return s && s.document?.revision === s.primary.viewport.revision && !s.primary.viewport.pending; });
    await ready(); if (wholeWord) await harness.page.getByRole("checkbox", { name: "Whole word", exact: true }).check();
    const search = [], replacements = [];
    for (const id of corpusIds) {
        await harness.page.evaluate(id => window.editingFixture.load(id), id); await ready();
        const text = corpus(id), query = id === "single-line" ? "xxxx" : "const", expected = wholeWord && id === "single-line" ? 0 : text.split(query).length - 1, samples = [];
        for (let index = 0; index < 13; index++) {
            const sample = await harness.page.evaluate(query => new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error("Search measurement did not complete.")), 15000);
                const start = performance.now(); window.editingFixture.find(query);
                const check = () => { const s = window.editingFixture.snapshot(); if (s.find.status !== "ready") { requestAnimationFrame(check); return; }
                    clearTimeout(timeout); resolve({ wallFrameProxyMs: performance.now() - start, maxScanStepMs: s.find.maxScanStepMs, count: s.find.count, scanned: s.find.scanned,
                        preview: s.find.previewCount, exports: s.document.exports, length: s.document.length }); }; requestAnimationFrame(check);
            }), query);
            assert.equal(sample.count, expected); assert.equal(sample.scanned, text.length); assert.equal(sample.exports, 0); assert.ok(sample.preview <= 200);
            assert.equal((await harness.page.evaluate(() => window.editingFixture.snapshot())).find.wholeWord, wholeWord);
            if (index >= 3) samples.push(sample);
        }
        search.push({ corpus: id, wholeWord, length: text.length, query, expectedMatches: expected, warmup: 3, measured: 10,
            wallFrameProxyMs: distribution(samples.map(s => s.wallFrameProxyMs)), maxScanStepMs: distribution(samples.map(s => s.maxScanStepMs)), samples });
        if (id === "single-line") continue;
        // Stress replacement has one diagnostic observation; smaller conditions have repeated samples.
        const measured = id === "lines-100000" ? 1 : 10, warmup = id === "lines-100000" ? 0 : 2, replaceSamples = [];
        for (let index = 0; index < measured + warmup; index++) {
            const sample = await harness.page.evaluate(() => new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error("Replacement measurement did not complete.")), 30000);
                const before = window.editingFixture.snapshot(), start = performance.now(); window.editingFixture.replaceAll("let");
                const check = () => { const s = window.editingFixture.snapshot();
                    if (s.document.revision !== before.document.revision + 1 || s.find.status !== "ready" || s.primary.viewport.pending) { requestAnimationFrame(check); return; }
                    clearTimeout(timeout); resolve({ wallFrameProxyMs: performance.now() - start, replaceTransactionMs: s.find.replaceTransactionMs, revisionDelta: s.document.revision - before.document.revision,
                        length: s.document.length, matches: s.find.count, exports: s.document.exports, historyDelta: s.history.undoDepth - before.history.undoDepth });
                }; requestAnimationFrame(check);
            }));
            assert.equal(sample.revisionDelta, 1); assert.equal(sample.length, text.length - expected * 2); assert.equal(sample.matches, 0); assert.equal(sample.exports, 0); assert.equal(sample.historyDelta, 1);
            assert.equal(await equalsText(text.split("const").join("let")), true, "Replacement differs from the full literal oracle.");
            if (index >= warmup) replaceSamples.push(sample);
            await harness.page.evaluate(() => window.editingFixture.history("undo"));
            await harness.page.waitForFunction(expected => { const s = window.editingFixture.snapshot(); return s.find.status === "ready" && s.find.count === expected; }, expected); await ready();
            assert.equal((await harness.page.evaluate(() => window.editingFixture.snapshot())).document.length, text.length);
            assert.equal(await equalsText(text), true, "Undo differs from the full original oracle.");
        }
        replacements.push({ corpus: id, matches: expected, warmup, measured, diagnosticOnly: measured === 1,
            wallFrameProxyMs: distribution(replaceSamples.map(s => s.wallFrameProxyMs)), transactionMs: distribution(replaceSamples.map(s => s.replaceTransactionMs)), samples: replaceSamples });
    }
    await harness.page.evaluate(() => { window.editingFixture.setText("😀 const saMORE = 123; // TODO"); window.editingFixture.select("primary", { anchor: 11, head: 11 }); window.editingFixture.requestProvider(); });
    await harness.page.waitForFunction(() => window.editingFixture.snapshot().provider.offer);
    const provider = (await harness.page.evaluate(() => window.editingFixture.snapshot())).provider;
    assert.equal(provider.posted, 1); assert.equal(provider.received, 1); assert.equal(provider.invalid, 0); assert.equal(provider.diagnostics, 1); assert.ok(provider.postedUnits <= 4096);
    assert.deepEqual(harness.errors, []);
    const report = { schemaVersion: 1, created: new Date().toISOString(), source: await sourceIdentity(), environment: { ...environment(), browser: harness.browser.version(), viewport: { width: 1440, height: 900 } },
        runtime: "bounded-editing-find-and-provider", wholeWord, search, replacements, provider, errors: harness.errors,
        note: "Literal search over pieces, bounded scan steps and first-200 display preview; all matching offsets retained for navigation/replacement. Full reference-text comparisons use bounded buffer reads outside timing. Replacement planning yields but final transaction is synchronous and proportional to changed ranges. Transaction timing includes model/publication/context refresh, not paint; wall values include scheduling/readiness polling. The 100k-line replace has one observation, not a tail estimate or production budget. Real worker result is required; no local fallback satisfies that guard." };
    await mkdir("artifacts/bench/services", { recursive: true }); await writeFile("artifacts/bench/services/latest.json", JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ search: search.map(item => ({ corpus: item.corpus, matches: item.expectedMatches, scanStepP95: item.maxScanStepMs.p95, wallProxyP95: item.wallFrameProxyMs.p95 })),
        replacements: replacements.map(item => ({ corpus: item.corpus, samples: item.measured, transactionP95: item.transactionMs.p95, wallProxyP95: item.wallFrameProxyMs.p95 })), provider }, null, 2));
} finally { await harness.close(); }
