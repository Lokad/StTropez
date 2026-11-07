import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { openHarness } from "./browser-harness.mjs";
import { distribution as measuredDistribution, environment, sourceIdentity } from "./measurement.mjs";
import { typeHostSuffix } from "./host-typing.mjs";
import { installHostReferenceProbe } from "./host-reference-probe.mjs";

const source = await sourceIdentity(), smoke = process.env.STTROPEZ_REFERENCE_SMOKE === "1", warmup = smoke ? 0 : 3, measured = smoke ? 1 : 10;
const distribution = values => ({ ...measuredDistribution(values), max: Math.max(...values) });
const harness = await openHarness(), page = harness.page, cases = new Map(), displays = []; let activeCase, mounted = false;
const directory = "artifacts/bench/host-reference", snapshot = () => page.evaluate(() => window.hostFixture.snapshot());
const click = name => page.getByRole("button", { name, exact: true }).click();
const ready = () => page.evaluate(() => globalThis.hostReferenceProbe.waitReady());
const fullText = text => page.evaluate(text => { const f = window.hostFixture; return f.snapshot().source.length === text.length && f.range(0, text.length) === text; }, text);
async function dispose() {
    if (!mounted) return; await page.evaluate(() => window.hostFixture.dispose()); mounted = false;
    const state = await snapshot(); assert.equal(state.diagnostics.views, 0); assert.equal(state.diagnostics.leases, 0);
    assert.equal(state.diagnostics.subscriptions, 0); assert.equal(state.hostSubscriptions, 0);
}
async function mount(host) {
    await dispose(); await page.goto(new URL(`/hosts/${host}/?editor=candidate`, page.url()).href);
    await page.waitForFunction(() => window.hostFixture?.snapshot().bindings.activeViews === 2); mounted = true;
    await page.evaluate(installHostReferenceProbe); await click("Open source review"); await ready();
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
    assert.equal(await fullText(original), true);
    const operation = reference === "identity" ? "review acceptance" : "reference refresh";
    await click(`Capture ${operation}`); await ready();
    await page.evaluate(reference => globalThis.hostReferenceProbe.arm({ kind: "reference", operation: reference }), reference);
    const actionStart = performance.now(); await click(`Finish ${operation}`);
    const refresh = await page.evaluate(() => globalThis.hostReferenceProbe.read()); refresh.completeActionProxyMs = performance.now() - actionStart;
    assert.equal(refresh.referenceIsWorkingBuffer, reference === "identity"); assert.equal(refresh.hunks, 0);
    assert.equal(refresh.referenceLabel, `Baseline · ${refresh.referenceVersion}`);
    assert.equal(refresh.exports, saved.source.exports); assert.equal(refresh.generations.length, 1);
    if (reference === "identity") { assert.equal(refresh.finalDiffProgress.work, 0); assert.equal(refresh.finalDiffProgress.readUnits, 0); }
    else { assert.ok(refresh.finalDiffProgress.work > 0); assert.ok(refresh.finalDiffProgress.readUnits > 0); }
    assert.equal(await page.evaluate(text => window.hostFixture.referenceRange(0, text.length) === text, original), true);
    return { refresh, setup: { saveAutomationProxyMs, submittedRevision: submitted.revision, serverVersion: saved.source.serverVersion, exportsBeforeInput: refresh.exports } };
}
async function measureInput(input, text, mode) {
    await page.evaluate(text => globalThis.hostReferenceProbe.arm({ kind: "input", text }), text);
    let start, history;
    if (mode === "cold-newline") { start = performance.now(); await input.press("Enter"); }
    else history = await typeHostSuffix(input, text, () => { start = performance.now(); return page.keyboard.type(text, { delay: mode === "sustained" ? 8 : 0 }); });
    const result = await page.evaluate(() => globalThis.hostReferenceProbe.read()); result.completeActionProxyMs = performance.now() - start; result.history = history ?? null;
    assert.equal(result.records.length, text.length); assert.equal(result.generations.length, text.length);
    assert.ok(result.rows.every(n => n < 100)); assert.ok(result.readUnits.every(n => n < 20000));
    assert.ok(result.inputUnits.every(n => n <= 2600)); assert.ok(result.comparisonInputUnits <= 2600);
    assert.equal(result.exports, 0); assert.equal(result.records.at(-1).supersededBeforeObservedWorkingReady, false);
    assert.equal(result.generations.at(-1).status, "ready");
    assert.equal(result.generations.at(-1).steps, result.finalDiffBatch.steps);
    assert.equal(result.generations.at(-1).totalStepMs, result.finalDiffBatch.totalStepMs);
    assert.equal(result.generations.at(-1).work, result.finalDiffProgress.work);
    assert.ok(result.observedDiffBatchMs >= result.finalDiffBatch.totalStepMs);
    return result;
}
function summarize(item) {
    const samples = item.samples, large = item.length > 100000, handlers = samples.flatMap(s => s.input.records.map(r => r.inputHandlerMs));
    const cadence = samples.flatMap(s => s.input.records.slice(1).map((record, i) => record.beforeinputAt - s.input.records[i].beforeinputAt));
    const result = { ...item, saveAutomationProxyMs: distribution(samples.map(s => s.setup.saveAutomationProxyMs)),
        referenceToReviewReadyProxyMs: distribution(samples.map(s => s.refresh.browserToFullReviewReadyProxyMs)),
        completeReferenceActionProxyMs: distribution(samples.map(s => s.refresh.completeActionProxyMs)),
        referenceClickDispatchObservationMs: distribution(samples.map(s => s.refresh.clickDispatchObservationMs)),
        inputHandlerMs: distribution(handlers), inputHandlerMaxMs: Math.max(...handlers),
        actualInputGapMs: cadence.length ? distribution(cadence) : null,
        inputToFullReviewReadyProxyMs: distribution(samples.map(s => s.input.browserToFullReviewReadyProxyMs)),
        lastInputToFullReviewReadyProxyMs: distribution(samples.map(s => s.input.lastInputToFullReviewReadyProxyMs)),
        completeInputActionProxyMs: distribution(samples.map(s => s.input.completeActionProxyMs)),
        observedInputDiffBatchMs: distribution(samples.map(s => s.input.observedDiffBatchMs)),
        finalInputDiffBatchMs: distribution(samples.map(s => s.input.finalDiffBatch.totalStepMs)),
        observedInputDiffWork: distribution(samples.map(s => s.input.observedDiffWork)),
        supersededWhileObservedRunning: samples.map(s => s.input.generations.filter(g => g.supersededWhileObservedRunning).length) };
    result.targets = { inputHandlerMs: 16, lastInputReviewReadyMs: large ? 250 : 100, completePointInputActionMs: item.mode === "sustained" ? null : large ? 500 : 200,
        referenceRefreshMs: null }; // Reference replacement is a separate whole-document operation.
    result.assessment = { handlerMet: result.inputHandlerMs.p95 <= result.targets.inputHandlerMs,
        reviewReadinessMet: result.lastInputToFullReviewReadyProxyMs.p95 <= result.targets.lastInputReviewReadyMs,
        completeActionMet: result.targets.completePointInputActionMs === null ? null : result.completeInputActionProxyMs.p95 <= result.targets.completePointInputActionMs };
    return result;
}
try {
    for (const host of ["plain", "react"]) for (const corpus of ["unicode-crlf", "lines-100000", "unique-lines-100000", "single-line"]) for (const history of ["fresh", "accumulated"]) {
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
                    if (history === "fresh") await mount(host);
                    const { refresh, setup } = await prepare(original, reference), input = page.getByRole("textbox", { name: "Primary source", exact: true });
                    const offset = position === "beginning" ? 0 : position === "end" ? original.length : corpus === "single-line" ? 1200000 : Math.floor(count / 2) * (line.length + eol.length) + 7;
                    await input.focus();
                    assert.equal(await page.evaluate(offset => { const f = window.hostFixture, revision = f.snapshot().source.revision;
                        return f.selectSource("primary", revision, { anchor: offset, head: offset }) && f.selectSource("secondary", revision, { anchor: 2, head: 4 }); }, offset), true);
                    await input.press(offset === original.length ? "ArrowLeft" : "ArrowRight"); await input.press(offset === original.length ? "ArrowRight" : "ArrowLeft"); await ready();
                    const before = await snapshot(), primary = before.bindings.views.find(v => v.id === "primary"); assert.equal(primary.selection.anchor, offset); assert.equal(primary.selection.head, offset);
                    if (iteration === 0 && reference === "identity" && pattern === "mixed" && position === "beginning" && mode === "cold-character") displays.push({ host, corpus, history,
                        ...await input.evaluate(node => { const root = node.closest(".st-viewport"), style = getComputedStyle(root); return { font: style.font, width: root.clientWidth, height: root.clientHeight, devicePixelRatio }; }) });
                    const text = mode === "cold-newline" ? "\n" : mode === "cold-character" ? pattern === "repeated" ? "x" : "z"
                        : pattern === "repeated" ? "x".repeat(32) : "abcdefghijklmnopqrstuvwxyzabcdef";
                    activeCase.stage = "input"; const observed = await measureInput(input, text, mode), expected = original.slice(0, offset) + text + original.slice(offset);
                    assert.equal(observed.revision, before.source.revision + text.length); assert.equal(await fullText(expected), true);
                    assert.equal(observed.referenceVersion, refresh.referenceVersion); assert.equal(observed.referenceEpoch, refresh.referenceEpoch);
                    assert.equal(await page.evaluate(text => window.hostFixture.referenceRange(0, text.length) === text, original), true);
                    assert.equal(observed.secondarySelection.anchor, 2 + (offset < 2 ? text.length : 0)); assert.equal(observed.secondarySelection.head, 4 + (offset < 4 ? text.length : 0));
                    activeCase.stage = "history"; const groups = observed.history?.groups ?? observed.historyAfter.undoDepth - observed.historyBefore.undoDepth;
                    assert.ok(groups >= 1 && groups <= text.length);
                    for (let i = 0; i < groups; i++) await input.press("Control+z"); await ready(); assert.equal(await fullText(original), true); assert.equal((await snapshot()).source.dirty, false);
                    for (let i = 0; i < groups; i++) await input.press("Control+Shift+z"); await ready(); assert.equal(await fullText(expected), true); assert.equal((await snapshot()).source.dirty, true);
                    if (iteration >= warmup) {
                        const id = [host, corpus, history, reference, pattern, position, mode].join(":"), item = cases.get(id) ?? { host, editor: "candidate", corpus, history, reference, pattern, position, mode,
                            length: original.length, offset, text, warmup, measured, requestedKeyDelayMs: mode === "sustained" ? 8 : 0, samples: [] };
                        item.samples.push({ iteration, setup, refresh, input: observed }); cases.set(id, item);
                    }
                    if (history === "fresh") await dispose();
                }
                await dispose();
            }
            console.log(JSON.stringify({ host, corpus, history, iteration, sample: iteration < warmup ? "warmup" : iteration - warmup + 1, semanticChecks: "passed" }));
        }
    }
    assert.equal(cases.size, 336); assert.ok([...cases.values()].every(c => c.samples.length === measured));
    assert.deepEqual(harness.errors, []); assert.equal((await sourceIdentity()).sha256, source.sha256);
    const report = { schemaVersion: 1, created: new Date().toISOString(), source, smoke, environment: { ...environment(), browser: harness.browser.version(), displays },
        cases: [...cases.values()].map(summarize), errors: harness.errors,
        boundaries: "Paired exact-working-buffer acceptance versus independently stored equal saved-reference refresh. Both arms save identical non-trailing-whitespace source before the reference clock; save automation and explicit export counts are separate. Fresh pages isolate each condition; accumulated pages retain the existing pattern/position/mode ordering per arm and iteration. Both candidate hosts, normal Unicode/CRLF, repeated/distinct100k and long-line corpora,3positions,character/Enter/32-key bursts; long-line repeated-x character/burst controls remain explicit. Reference clocks begin at finish-command click capture; document bubbling observes both plain and delegated React handlers. Complete action clocks include automation. Input clocks start at beforeinput; adapter input-event handler duration excludes beforeinput and observation cost. Full readiness requires exact model/selections,all working/reference viewports,caret/scans,completed comparison and2frames. Render observations alone are narrower. Per-generation counters are sampled at input capture/bubble,render events and frames; stale scheduler counters are not attributed to a new generation. Observed sums include superseded generations, while final-generation counters remain separate. Observer and history tracing overhead is included in full clocks. Original host-input benchmark/results unchanged; new instrumented observations do not replace earlier misses. Reference refresh is whole-document work with no point-action budget. No service delay,physical display or native-device qualification." };
    await mkdir(directory, { recursive: true }); await writeFile(`${directory}/${smoke ? "smoke" : "latest"}.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ conditions: report.cases.length, inputEvents: report.cases.flatMap(c => c.samples.flatMap(s => s.input.records)).length,
        misses: report.cases.filter(c => Object.values(c.assessment).includes(false)).map(c => ({ host: c.host, corpus: c.corpus, history: c.history, reference: c.reference,
            pattern: c.pattern, position: c.position, mode: c.mode, handlerP95: c.inputHandlerMs.p95, readyP95: c.lastInputToFullReviewReadyProxyMs.p95, actionP95: c.completeInputActionProxyMs.p95 })) }, null, 2));
} catch (error) {
    await mkdir(directory, { recursive: true });
    await writeFile(`${directory}/failure-${Date.now()}.json`, JSON.stringify({ source, smoke, activeCase, error: String(error), stack: error.stack,
        completed: [...cases.values()], state: mounted ? await snapshot().catch(() => null) : null, errors: harness.errors }, null, 2));
    if (mounted) await page.screenshot({ path: `${directory}/failure-${Date.now()}.png`, fullPage: true }).catch(() => {});
    throw error;
} finally { await dispose().catch(() => {}); await harness.close(); }
