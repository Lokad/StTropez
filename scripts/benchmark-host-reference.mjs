import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { openHarness } from "./browser-harness.mjs";
import { distribution as measuredDistribution, environment, sourceIdentity, timingSummary } from "./measurement.mjs";
import { measureHostEdit, summarizeHostEdits } from "./host-edit-measurement.mjs";
import { createReportWriter } from "./benchmark-report.mjs";
import { createHostScene } from "./host-scene.mjs";

const source = await sourceIdentity(), smoke = process.env.STTROPEZ_REFERENCE_SMOKE === "1", retentionCheck = process.argv.includes("--retention-check");
assert.ok(!smoke || !retentionCheck, "Select either the smoke run or the focused retention check.");
const warmup = retentionCheck ? 2 : smoke ? 0 : 3, measured = smoke || retentionCheck ? 1 : 10;
const distribution = values => ({ ...measuredDistribution(values), max: Math.max(...values) });
const harness = await openHarness(), page = harness.page, scene = createHostScene(page), cases = new Map(), warmupCases = new Map(), displays = []; let activeCase, activeSample;
const directory = "artifacts/bench/host-reference", snapshot = scene.snapshot;
const writer = await createReportWriter(directory, retentionCheck ? "retention-check" : smoke ? "smoke" : "full");
const click = name => page.getByRole("button", { name, exact: true }).click();
const ready = scene.ready, fullText = scene.exactText, dispose = scene.dispose;
async function mount(host) {
    await dispose(); await scene.mount(host); await click("Open source review"); await ready();
}
async function prepare(original, reference) {
    await page.evaluate(original => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: original }]); }, original);
    // Common untimed setup gives both arms a completed identical reference before the save.
    await click("Capture review acceptance"); await click("Finish review acceptance"); await ready();
    const submitted = (await snapshot()).source, start = performance.now(); await click("Save source");
    await page.waitForFunction(() => window.hostFixture.snapshot().pendingSaves.length === 1);
    assert.deepEqual((await snapshot()).pendingSaves.map(s => ({ revision: s.revision, length: s.length })), [{ revision: submitted.revision, length: original.length }]);
    await page.evaluate(() => window.hostFixture.finishSave());
    await page.waitForFunction(revision => { const s = window.hostFixture.snapshot(); return s.activity.lastSavedRevision === revision
        && s.pendingCommands === 0 && s.source.saveStatus === "idle" && s.source.dirty === false; }, submitted.revision);
    await ready(); const saveAutomationProxyMs = performance.now() - start, saved = await snapshot();
    activeSample.save = { saveAutomationProxyMs, submittedRevision: submitted.revision, serverVersion: saved.source.serverVersion };
    assert.equal(await fullText(original), true);
    const operation = reference === "identity" ? "review acceptance" : "reference refresh";
    await click(`Capture ${operation}`); await ready();
    await page.evaluate(reference => globalThis.hostReferenceProbe.arm({ kind: "reference", operation: reference }), reference);
    const actionStart = performance.now(); await click(`Finish ${operation}`);
    const refresh = await page.evaluate(() => globalThis.hostReferenceProbe.read()); refresh.completeActionProxyMs = performance.now() - actionStart;
    activeSample.refresh = refresh;
    assert.equal(refresh.referenceIsWorkingBuffer, reference === "identity"); assert.equal(refresh.hunks, 0);
    assert.equal(refresh.referenceLabel, `Baseline · ${refresh.referenceVersion}`);
    assert.equal(refresh.exports, saved.source.exports); assert.equal(refresh.generations.length, 1);
    if (reference === "identity") { assert.equal(refresh.finalDiffProgress.work, 0); assert.equal(refresh.finalDiffProgress.readUnits, 0); }
    else { assert.ok(refresh.finalDiffProgress.work > 0); assert.ok(refresh.finalDiffProgress.readUnits > 0); }
    assert.equal(await scene.exactText(original, "reference"), true);
    return { refresh, setup: { saveAutomationProxyMs, submittedRevision: submitted.revision, serverVersion: saved.source.serverVersion, exportsBeforeInput: refresh.exports } };
}
function summarize(item) {
    const samples = item.samples, large = item.length > 100000;
    const result = { ...item, saveAutomationProxyMs: distribution(samples.map(s => s.setup.saveAutomationProxyMs)),
        referenceToReviewReadyProxyMs: distribution(samples.map(s => s.refresh.browserToFullReviewReadyProxyMs)),
        completeReferenceActionProxyMs: distribution(samples.map(s => s.refresh.completeActionProxyMs)),
        referenceClickDispatchObservationMs: distribution(samples.map(s => s.refresh.clickDispatchObservationMs)),
        ...summarizeHostEdits(samples.map(sample => sample.input)),
        observedInputDiffBatchMs: distribution(samples.map(s => s.input.observedDiffBatchMs)),
        finalInputDiffBatchMs: distribution(samples.map(s => s.input.finalDiffBatch.totalStepMs)),
        observedInputDiffWork: distribution(samples.map(s => s.input.observedDiffWork)),
        supersededWhileObservedRunning: samples.map(s => s.input.generations.filter(g => g.supersededWhileObservedRunning).length) };
    result.targets = { handlerMs: 16, reviewReadyMs: large ? 250 : 100, completePointActionMs: item.mode === "sustained" ? null : large ? 500 : 200,
        referenceRefreshMs: null }; // Reference replacement is a separate whole-document operation.
    result.assessment = { handlerMet: (result.keydownHandlerMs ?? result.inputHandlerMs).p95 <= result.targets.handlerMs,
        reviewReadinessMet: (result.commandToFullReviewReadyProxyMs ?? result.lastInputToFullReviewReadyProxyMs).p95 <= result.targets.reviewReadyMs,
        completeActionMet: result.targets.completePointActionMs === null ? null : result.completeActionProxyMs.p95 <= result.targets.completePointActionMs };
    return result;
}
try {
    await writer.write({ status: "running", source, smoke, retentionCheck, cases: [], warmupCases: [] });
    for (const host of retentionCheck ? ["plain"] : ["plain", "react"])
    for (const corpus of retentionCheck ? ["unicode-crlf"] : ["unicode-crlf", "lines-100000", "unique-lines-100000", "single-line"])
    for (const history of retentionCheck ? ["accumulated"] : ["fresh", "accumulated"]) {
        const line = corpus === "unicode-crlf" ? "const café = 'e\u0301 👩‍💻 東京';" : corpus === "unique-lines-100000" ? "const value000000 = 123;" : "const sample = 1234567;";
        const count = corpus === "unicode-crlf" ? 60 : 100000, eol = corpus === "unicode-crlf" ? "\r\n" : "\n";
        const original = corpus === "single-line" ? "x".repeat(2400000) : corpus === "unique-lines-100000"
            ? Array.from({ length: count }, (_, i) => `const value${String(i).padStart(6, "0")} = 123;`).join(eol) : Array(count).fill(line).join(eol);
        assert.equal(original.trimEnd(), original);
        for (let iteration = 0; iteration < warmup + measured; iteration++) {
            // Balance arm order; each arm has its own page and retained history.
            for (const reference of iteration % 2 ? ["independent", "identity"] : ["identity", "independent"]) {
                if (history === "accumulated") await mount(host);
                for (const pattern of corpus === "single-line" ? ["mixed", "repeated"] : ["mixed"])
                for (const position of ["beginning", "middle", "end"]) for (const mode of pattern === "repeated" ? ["cold-character", "sustained"] : ["cold-character", "cold-newline", "sustained"]) {
                    activeCase = { host, corpus, history, reference, iteration, pattern, position, mode, stage: "setup" };
                    activeSample = { phase: iteration < warmup ? "warmup" : "observation", iteration };
                    if (history === "fresh") await mount(host);
                    const { refresh, setup } = await prepare(original, reference), input = page.getByRole("textbox", { name: "Primary source", exact: true });
                    activeSample.setup = setup;
                    const offset = position === "beginning" ? 0 : position === "end" ? original.length : corpus === "single-line" ? 1200000 : Math.floor(count / 2) * (line.length + eol.length) + 7;
                    await input.focus();
                    assert.equal(await page.evaluate(offset => { const f = window.hostFixture, revision = f.snapshot().source.revision;
                        return f.selectSource("primary", revision, { anchor: offset, head: offset }) && f.selectSource("secondary", revision, { anchor: 2, head: 4 }); }, offset), true);
                    await input.press(offset === original.length ? "ArrowLeft" : "ArrowRight"); await input.press(offset === original.length ? "ArrowRight" : "ArrowLeft"); await ready();
                    const before = await snapshot(), primary = before.bindings.views.find(v => v.id === "primary"); assert.equal(primary.selection.anchor, offset); assert.equal(primary.selection.head, offset);
                    if (iteration === 0 && reference === "identity" && pattern === "mixed" && position === "beginning" && mode === "cold-character") displays.push({ host, corpus, history,
                        ...await input.evaluate(node => { const root = node.closest(".st-viewport"), style = getComputedStyle(root); return { font: style.font, width: root.clientWidth, height: root.clientHeight, devicePixelRatio }; }) });
                    const text = mode === "cold-newline" ? eol : mode === "cold-character" ? pattern === "repeated" ? "x" : "z"
                        : pattern === "repeated" ? "x".repeat(32) : "abcdefghijklmnopqrstuvwxyzabcdef";
                    activeCase.stage = "input"; const observed = await measureHostEdit(page, input, text, mode, observed => { activeSample.input = observed; }), expected = original.slice(0, offset) + text + original.slice(offset);
                    assert.equal(observed.revision, before.source.revision + observed.transactions); assert.equal(await fullText(expected), true);
                    assert.equal(observed.referenceVersion, refresh.referenceVersion); assert.equal(observed.referenceEpoch, refresh.referenceEpoch);
                    assert.equal(await scene.exactText(original, "reference"), true);
                    assert.equal(observed.secondarySelection.anchor, 2 + (offset < 2 ? text.length : 0)); assert.equal(observed.secondarySelection.head, 4 + (offset < 4 ? text.length : 0));
                    activeCase.stage = "history"; const groups = observed.history?.groups ?? observed.historyAfter.undoDepth - observed.historyBefore.undoDepth;
                    assert.ok(groups >= 1 && groups <= observed.transactions);
                    for (let i = 0; i < groups; i++) await input.press("Control+z"); await ready(); assert.equal(await fullText(original), true); assert.equal((await snapshot()).source.dirty, false);
                    for (let i = 0; i < groups; i++) await input.press("Control+Shift+z"); await ready(); assert.equal(await fullText(expected), true); assert.equal((await snapshot()).source.dirty, true);
                    {
                        const selectedCases = iteration >= warmup ? cases : warmupCases;
                        const id = [host, corpus, history, reference, pattern, position, mode].join(":"), item = selectedCases.get(id) ?? { host, editor: "candidate", corpus, history, reference, pattern, position, mode,
                            length: original.length, offset, text, warmup, measured, requestedKeyDelayMs: mode === "sustained" ? 8 : 0, samples: [] };
                        item.samples.push({ iteration, setup, refresh, input: observed }); selectedCases.set(id, item);
                    }
                    if (history === "fresh") await dispose();
                }
                await dispose();
            }
            await writer.write({ status: "running", source, smoke, retentionCheck, cases: [...cases.values()], warmupCases: [...warmupCases.values()] });
            console.log(JSON.stringify({ host, corpus, history, iteration, sample: iteration < warmup ? "warmup" : iteration - warmup + 1, semanticChecks: "passed" }));
        }
    }
    const expectedConditions = retentionCheck ? 18 : 336;
    assert.equal(cases.size, expectedConditions); assert.ok([...cases.values()].every(c => c.samples.length === measured));
    assert.equal(warmupCases.size, warmup ? expectedConditions : 0); assert.ok([...warmupCases.values()].every(c => c.samples.length === warmup));
    assert.deepEqual(harness.errors, []); assert.equal((await sourceIdentity()).sha256, source.sha256);
    const report = { schemaVersion: 2, status: "passed", created: new Date().toISOString(), source, smoke, retentionCheck, diagnosticOnly: smoke || retentionCheck,
        warmup, measured, environment: { ...environment(), browser: harness.browser.version(), buildMode: harness.buildMode, displays },
        cases: [...cases.values()].map(summarize), warmupCases: [...warmupCases.values()], errors: harness.errors,
        boundaries: "Paired exact-working-buffer acceptance versus independently stored equal saved-reference refresh. Both arms save identical non-trailing-whitespace source before the reference clock; save automation and explicit export counts are separate. Fresh pages isolate each condition; accumulated pages retain the existing pattern/position/mode ordering per arm and iteration. Both candidate hosts, normal Unicode/CRLF, repeated/distinct100k and long-line corpora,3positions,character/Enter/32-key bursts; long-line repeated-x character/burst controls remain explicit. Reference clocks begin at finish-command click capture; document bubbling observes both plain and delegated React handlers. Complete action clocks include automation. Handled Enter starts at trusted keydown, records keydown-handler time and commits contextual LF/CRLF text in one transaction. Native insertText starts at beforeinput; adapter input-event handler duration excludes beforeinput and observation cost. Model transaction counts are independent of inserted UTF-16 units. Full readiness requires exact model/selections,all working/reference viewports,pending input/commands,caret/scans,completed comparison and2frames. Render observations alone are narrower. Per-generation counters are sampled at input capture/bubble,render events and frames; stale scheduler counters are not attributed to a new generation. Observed sums include superseded generations, while final-generation counters remain separate. Observer and history tracing overhead is included in full clocks. The input benchmark shares this observation contract; historical measurements and misses remain separate. Reference refresh is whole-document work with no point-action budget. No service delay,physical display or native-device qualification." };
    report.retention = { warmupWorkflows: report.warmupCases.reduce((count, item) => count + item.samples.length, 0),
        observedWorkflows: report.cases.reduce((count, item) => count + item.samples.length, 0),
        warmupEvents: report.warmupCases.reduce((count, item) => count + item.samples.reduce((sum, sample) => sum + sample.input.records.length, 0), 0),
        observedEvents: report.cases.reduce((count, item) => count + item.samples.reduce((sum, sample) => sum + sample.input.records.length, 0), 0) };
    report.boundaries += " Raw warmups are retained separately and never enter measured distributions or target assessments. Active setup/reference/input results are captured after their clocks close and before assertions, so failures retain available partial evidence. The same Page navigates to fresh host documents; browser/process caches may persist. Comparison totalStepMs sums inner-loop elapsed time within a generation, while maxStepMs is a loop maximum; neither includes outer render/rescheduling or measures a complete callback or CPU. The focused retention check uses eighteen existing normal accumulated controls with two warmups/one observation for reporting validation only.";
    await writer.write(report); console.log(JSON.stringify({ report: writer.file, latest: writer.latest }));
    console.log(JSON.stringify({ conditions: report.cases.length, diagnosticOnly: report.diagnosticOnly, retention: report.retention, observedEvents: report.cases.flatMap(c => c.samples.flatMap(s => s.input.records)).length,
        misses: report.cases.filter(c => Object.values(c.assessment).includes(false)).map(c => ({ host: c.host, corpus: c.corpus, history: c.history, reference: c.reference,
            pattern: c.pattern, position: c.position, mode: c.mode, handlerKind: c.handlerKind, handlerMs: timingSummary(c.keydownHandlerMs ?? c.inputHandlerMs), readyMs: timingSummary(c.commandToFullReviewReadyProxyMs ?? c.lastInputToFullReviewReadyProxyMs), actionMs: timingSummary(c.completeActionProxyMs) })) }, null, 2));
} catch (error) {
    await writer.write({ status: "failed", source, smoke, retentionCheck, activeCase, activeSample, error: String(error), stack: error.stack,
        cases: [...cases.values()], warmupCases: [...warmupCases.values()], state: scene.mounted ? await snapshot().catch(() => null) : null,
        observation: scene.mounted ? await page.evaluate(() => globalThis.hostReferenceProbe?.snapshot()).catch(() => null) : null, errors: harness.errors });
    if (scene.mounted) await page.screenshot({ path: writer.file.replace(/\.json$/, ".png"), fullPage: true }).catch(() => {});
    console.error(JSON.stringify({ failedReport: writer.file })); throw error;
} finally { await dispose().catch(() => {}); await harness.close(); }
