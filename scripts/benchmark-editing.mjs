import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { openHarness } from "./browser-harness.mjs";
import { distribution, environment, sourceIdentity } from "./measurement.mjs";
import { corpusIds } from "../tests/fixtures/workloads.ts";

const harness = await openHarness();
try {
    await harness.page.goto(new URL("/editing/", harness.page.url()).href);
    const ready = () => harness.page.waitForFunction(() => { const state = window.editingFixture?.snapshot();
        return state && state.primary.viewport.revision === state.document?.revision && !state.primary.viewport.pending && !state.secondary.viewport.pending; });
    await ready();
    assert.equal(await harness.page.locator("textarea.st-input-context").count(), 2);
    assert.equal(await harness.page.locator("textarea.st-editor").count(), 0, "Whole-value fallback satisfied the candidate measurement.");
    const cases = [];
    for (const corpus of corpusIds) for (const position of ["start", "middle", "end"]) {
        await harness.page.evaluate(corpus => window.editingFixture.load(corpus), corpus); await ready();
        const length = (await harness.page.evaluate(() => window.editingFixture.snapshot())).document.length;
        const offset = position === "start" ? 0 : position === "middle" ? Math.floor(length / 2) : length;
        await harness.page.evaluate(offset => { window.editingFixture.select("primary", { anchor: offset, head: offset }); window.editingFixture.focus("primary"); }, offset); await ready();
        const samples = [];
        for (let index = 0; index < 23; index++) {
            await harness.page.evaluate(() => {
                const input = document.querySelector("#primary textarea"), before = window.editingFixture.snapshot();
                globalThis.editingMeasurement = new Promise((resolve, reject) => {
                    let start;
                    const timeout = setTimeout(() => reject(new Error("Candidate input measurement did not complete.")), 5000);
                    input.addEventListener("beforeinput", () => { start = performance.now(); }, { once: true });
                    input.addEventListener("input", () => {
                        const check = () => {
                            const state = window.editingFixture.snapshot();
                            if (state.primary.viewport.revision !== state.document.revision || state.secondary.viewport.revision !== state.document.revision
                                || state.primary.viewport.pending || state.secondary.viewport.pending) { requestAnimationFrame(check); return; }
                            clearTimeout(timeout);
                            resolve({ beforeInputToFrameProxyMs: performance.now() - start, inputHandlerMs: state.primary.lastInputMs,
                                inputEvents: state.primary.inputEvents - before.primary.inputEvents, commits: state.primary.commits - before.primary.commits,
                                revisionDelta: state.document.revision - before.document.revision, length: state.document.length, wholeTextExports: state.document.exports,
                                primary: state.primary, secondary: state.secondary });
                        }; requestAnimationFrame(check);
                    }, { once: true });
                });
            });
            await harness.page.keyboard.type("z");
            const sample = await harness.page.evaluate(() => globalThis.editingMeasurement);
            assert.equal(sample.inputEvents, 1); assert.equal(sample.commits, 1); assert.equal(sample.revisionDelta, 1);
            assert.equal(sample.wholeTextExports, 0); assert.equal(sample.length, length + index + 1);
            assert.equal(await harness.page.evaluate(offset => window.editingFixture.range(offset, offset + 1), offset + index), "z");
            assert.ok(Number.isFinite(sample.inputHandlerMs)); assert.ok(Number.isFinite(sample.beforeInputToFrameProxyMs));
            for (const view of [sample.primary, sample.secondary]) {
                assert.ok(view.inputUnits <= 2600); assert.equal(view.conflicts, 0);
                assert.ok(view.viewport.rows <= Math.ceil(view.viewport.height / view.viewport.lineHeight) + 10);
                assert.ok(view.viewport.readUnits <= view.viewport.rows * (Math.max(512, Math.ceil(view.viewport.width / view.viewport.columnWidth)) + 80));
            }
            if (index >= 3) samples.push(sample);
        }
        cases.push({ corpus, position, initialLength: length, warmup: 3, measured: 20,
            inputHandlerMs: distribution(samples.map(sample => sample.inputHandlerMs)), beforeInputToFrameProxyMs: distribution(samples.map(sample => sample.beforeInputToFrameProxyMs)), samples });
    }
    assert.deepEqual(harness.errors, []);
    const display = await harness.page.locator("#primary .st-viewport").evaluate(element => {
        const style = getComputedStyle(element); return { viewport: { width: innerWidth, height: innerHeight }, devicePixelRatio,
            font: { family: style.fontFamily, size: style.fontSize, lineHeight: style.lineHeight, weight: style.fontWeight,
                style: style.fontStyle, ligatures: style.fontVariantLigatures, kerning: style.fontKerning, letterSpacing: style.letterSpacing }, tabSize: style.tabSize };
    });
    const report = { schemaVersion: 1, created: new Date().toISOString(), source: await sourceIdentity(), environment: { ...environment(), browser: harness.browser.version(), display },
        runtime: "bounded-editing-candidate", activeViews: 2, features: { visibleLineTokens: true, find: "idle", provider: "connected; no pending requests" }, cases, errors: harness.errors,
        note: "Actual automated keyboard insertion through bounded native context into core history and two DOM views. Input timing covers the adapter input-event handler including model commit and context refresh, excluding native event processing/layout/paint. Beforeinput-to-frame-ready is an animation-frame scheduling proxy, not display/physical latency. No IME/AT/native-device or long contextual-line qualification follows." };
    await mkdir("artifacts/bench/editing", { recursive: true }); await writeFile("artifacts/bench/editing/latest.json", JSON.stringify(report, null, 2));
    console.log(JSON.stringify(cases.map(item => ({ corpus: item.corpus, position: item.position, inputP95: item.inputHandlerMs.p95, frameProxyP95: item.beforeInputToFrameProxyMs.p95,
        maxInputUnits: Math.max(...item.samples.map(sample => sample.primary.inputUnits)) })), null, 2));
} finally { await harness.close(); }
