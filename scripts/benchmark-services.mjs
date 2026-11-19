import assert from "node:assert/strict";
import { createReportWriter } from "./benchmark-report.mjs";
import { openHarness } from "./browser-harness.mjs";
import { distribution, environment, sourceIdentity, timingSummary } from "./measurement.mjs";
import { corpus, corpusIds } from "../fixtures/workloads.ts";
/** @typedef {{wallFrameProxyMs: number, maxScanStepMs: number, count: number, scanned: number, exports: number, length: number}} SearchSample */
/** @typedef {{wallFrameProxyMs: number, replaceTransactionMs: number, revisionDelta: number, length: number, matches: number, exports: number, historyDelta: number}} ReplaceSample */
/** @param {string} text @param {string} query */
const caselessCount = (text, query) => { let count = 0; for (const match of text.matchAll(new RegExp(query, "giu"))) { assert.ok(match[0].length); count++; } return count; };
const wholeWord = process.argv.includes("--whole-word"), matchCase = !process.argv.includes("--ignore-case"), regularExpression = process.argv.includes("--regex");
const source = await sourceIdentity(), writer = await createReportWriter("artifacts/bench/services", `${regularExpression ? "regex" : "literal"}-${wholeWord ? "whole-word" : "substring"}-${matchCase ? "case-sensitive" : "ignore-case"}`);
const harness = await openHarness(), search = [], replacements = [];
try {
    await harness.page.goto("/editing/");
    // Full oracle validation is deliberately outside timed intervals and uses bounded buffer reads.
    /** @param {string} expected */
    const equalsText = expected => harness.page.evaluate(expected => {
        if (window.editingFixture.snapshot().document?.length !== expected.length) return false;
        for (let from = 0; from < expected.length; from += 65536) {
            const to = Math.min(expected.length, from + 65536);
            if (window.editingFixture.range(from, to) !== expected.slice(from, to)) return false;
        }
        return true;
    }, expected);
    const ready = () => harness.page.waitForFunction(() => { const s = window.editingFixture?.snapshot(); return s && s.document?.revision === s.primary.viewport.revision && !s.primary.viewport.pending; });
    await ready(); if (!matchCase) await harness.page.getByRole("checkbox", { name: "Match case", exact: true }).uncheck(); if (wholeWord) await harness.page.getByRole("checkbox", { name: "Whole word", exact: true }).check();
    if (regularExpression) await harness.page.getByRole("checkbox", { name: "Regular expression", exact: true }).check();
    for (const id of corpusIds) {
        await harness.page.evaluate(id => window.editingFixture.load(id), id); await ready();
        const text = corpus(id), literal = id === "single-line" ? "xxxx" : matchCase ? "const" : "CONST", query = regularExpression ? `(?<keyword>${literal})` : literal;
        const expected = wholeWord && id === "single-line" ? 0 : matchCase ? text.split(literal).length - 1 : caselessCount(text, literal), samples = [];
        for (let index = 0; index < 13; index++) {
            const sample = await harness.page.evaluate(query => /** @type {Promise<SearchSample>} */ (new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error("Search measurement did not complete.")), 15000);
                const start = performance.now(); window.editingFixture.find(query);
                const check = () => { const s = window.editingFixture.snapshot(); if (s.find.status !== "ready") { requestAnimationFrame(check); return; }
                    if (!s.document) { clearTimeout(timeout); reject(new Error("Search document detached during measurement.")); return; }
                    clearTimeout(timeout); resolve({ wallFrameProxyMs: performance.now() - start, maxScanStepMs: s.find.maxScanStepMs, count: s.find.count, scanned: s.find.scanned,
                        exports: s.document.exports, length: s.document.length }); }; requestAnimationFrame(check);
            })), query);
            assert.equal((await harness.page.evaluate(() => window.editingFixture.snapshot())).find.matchCase, matchCase);
            assert.equal((await harness.page.evaluate(() => window.editingFixture.snapshot())).find.regularExpression, regularExpression);
            assert.equal(sample.count, expected); assert.equal(sample.scanned, text.length); assert.equal(sample.exports, 0);
            assert.equal((await harness.page.evaluate(() => window.editingFixture.snapshot())).find.wholeWord, wholeWord);
            if (index >= 3) samples.push(sample);
        }
        search.push({ corpus: id, wholeWord, matchCase, regularExpression, length: text.length, query, expectedMatches: expected, warmup: 3, measured: 10,
            wallFrameProxyMs: distribution(samples.map(s => s.wallFrameProxyMs)), maxScanStepMs: distribution(samples.map(s => s.maxScanStepMs)), samples });
        if (id === "single-line") continue;
        // Stress replacement has one diagnostic observation; smaller conditions have repeated samples.
        const measured = id === "lines-100000" ? 1 : 10, warmup = id === "lines-100000" ? 0 : 2, replaceSamples = [];
        for (let index = 0; index < measured + warmup; index++) {
            const sample = await harness.page.evaluate(() => /** @type {Promise<ReplaceSample>} */ (new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error("Replacement measurement did not complete.")), 30000);
                const before = window.editingFixture.snapshot();
                if (!before.document || !before.history) { clearTimeout(timeout); reject(new Error("Replacement measurement requires its document and history.")); return; }
                const beforeDocument = before.document, beforeHistory = before.history, start = performance.now(); window.editingFixture.replaceAll("let");
                const check = () => { const s = window.editingFixture.snapshot();
                    if (!s.document || !s.history) { clearTimeout(timeout); reject(new Error("Replacement document or history detached during measurement.")); return; }
                    if (s.document.revision !== beforeDocument.revision + 1 || s.find.status !== "ready" || s.primary.viewport.pending) { requestAnimationFrame(check); return; }
                    clearTimeout(timeout); resolve({ wallFrameProxyMs: performance.now() - start, replaceTransactionMs: s.find.replaceTransactionMs, revisionDelta: s.document.revision - beforeDocument.revision,
                        length: s.document.length, matches: s.find.count, exports: s.document.exports, historyDelta: s.history.undoDepth - beforeHistory.undoDepth });
                }; requestAnimationFrame(check);
            })));
            assert.equal(sample.revisionDelta, 1); assert.equal(sample.length, text.length - expected * 2); assert.equal(sample.matches, 0); assert.equal(sample.exports, 0); assert.equal(sample.historyDelta, 1);
            assert.equal(await equalsText(text.split("const").join("let")), true, "Replacement differs from the full literal oracle.");
            if (index >= warmup) replaceSamples.push(sample);
            await harness.page.evaluate(() => window.editingFixture.history("undo"));
            await harness.page.waitForFunction(expected => { const s = window.editingFixture.snapshot(); return s.find.status === "ready" && s.find.count === expected; }, expected); await ready();
            assert.equal((await harness.page.evaluate(() => window.editingFixture.snapshot())).document?.length, text.length);
            assert.equal(await equalsText(text), true, "Undo differs from the full original oracle.");
        }
        replacements.push({ corpus: id, matches: expected, warmup, measured, diagnosticOnly: measured === 1,
            wallFrameProxyMs: distribution(replaceSamples.map(s => s.wallFrameProxyMs)), transactionMs: distribution(replaceSamples.map(s => s.replaceTransactionMs)), samples: replaceSamples });
    }
    assert.deepEqual(harness.errors, []);
    assert.equal((await sourceIdentity()).sha256, source.sha256, "Source changed during measurement.");
    const report = { schemaVersion: 1, created: new Date().toISOString(), source, environment: { ...environment(), browser: harness.browser.version(), buildMode: harness.buildMode, viewport: { width: 1440, height: 900 } },
        runtime: "bounded-editing-find", wholeWord, matchCase, regularExpression, search, replacements, errors: harness.errors,
        note: `${regularExpression ? "Regex runs in a dedicated module worker with acknowledged source transfer and pages; maxScanStepMs measures only main dispatch/index spans, excluding native matching, later asynchronous transfer, decode and publication. The 80ms pattern delay is included in wall time." : "Literal search runs over pieces; maxScanStepMs covers cursor/index work before publication."} Neither scan metric measures whole callbacks, input handlers, CPU or physical display. Raw warmup timings are omitted (3 per search group; 2 per repeated replacement group). All offsets retained for navigation/replacement; presentation queries visible match ranges. Full oracles use bounded reads outside timing. Planning yields; final fragment assembly and atomic transaction remain proportional bulk work. Transaction timing includes model/publication/context refresh, not paint; wall values include scheduling and readiness polling. The 100k replacement has one diagnostic observation, not a tail estimate or production budget.` };
    await writer.write({ ...report, status: "passed" });
    console.log(JSON.stringify({ search: search.map(item => ({ corpus: item.corpus, matches: item.expectedMatches, scanStepMs: timingSummary(item.maxScanStepMs), wallProxyMs: timingSummary(item.wallFrameProxyMs) })),
        replacements: replacements.map(item => ({ corpus: item.corpus, transactionMs: timingSummary(item.transactionMs), wallProxyMs: timingSummary(item.wallFrameProxyMs) })) }, null, 2));
} catch (error) { await writer.write({ status: "failed", source, wholeWord, matchCase, regularExpression, search, replacements, error: String(error), browserErrors: harness.errors }); throw error; }
finally { await harness.close(); }
