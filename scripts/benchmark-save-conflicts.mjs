import assert from "node:assert/strict";
import { createReportWriter } from "./benchmark-report.mjs";
import { openHarness } from "./browser-harness.mjs";
import { distribution, environment, sourceIdentity, timingSummary } from "./measurement.mjs";
import { corpus } from "../fixtures/workloads.ts";
import { typeHostSuffix } from "./host-typing.mjs";
import { createHostScene } from "./host-scene.mjs";

const source = await sourceIdentity(), smoke = process.env.STTROPEZ_CONFLICT_SMOKE === "1", warmup = smoke ? 0 : 3, measured = smoke ? 1 : 10;
const writer = await createReportWriter("artifacts/bench/save-conflicts", smoke ? "smoke" : "full");
const harness = await openHarness(), scene = createHostScene(harness.page), cases = [], snapshot = scene.snapshot;
const click = name => harness.page.getByRole("button", { name, exact: true }).click();
const ready = scene.sourceReady;
try {
    for (const editor of ["native", "candidate"]) for (const host of ["plain", "react"]) for (const corpusId of editor === "candidate" ? ["normal", "lines-100000", "unique-lines-100000", "single-line"] : ["normal"]) {
        const original = (corpusId === "unique-lines-100000" ? Array.from({ length: 100000 }, (_, index) => `const value${String(index).padStart(6, "0")} = 123;\n`).join("") : corpus(corpusId)).trimEnd(), remote = `remote ${original}`, samples = [];
        for (let iteration = 0; iteration < warmup + measured; iteration++) {
            await scene.mount(host, editor); await ready();
            await harness.page.evaluate(({ original, remote }) => { const f = window.hostFixture, s = f.snapshot();
                f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: original }]); f.externalWrite(remote); }, { original, remote });
            await ready(); const before = await snapshot(), input = harness.page.getByRole("textbox", { name: "Primary source", exact: true });
            const workflowStart = performance.now(); await click("Save source");
            await harness.page.waitForFunction(() => window.hostFixture.snapshot().pendingSaves.length === 1);
            await harness.page.evaluate(() => window.hostFixture.finishSave());
            await harness.page.waitForFunction(() => window.hostFixture.snapshot().saveConflict !== null);
            const conflictOutcomeActionProxyMs = performance.now() - workflowStart;
            assert.equal((await snapshot()).source.serverVersion, "v0");
            const reviewStart = performance.now(); await click("Review remote source");
            await input.press("Control+End"); await input.pressSequentially(" during review");
            await harness.page.evaluate(() => window.hostFixture.finishConflictReview()); await ready();
            const reviewWithTypingActionProxyMs = performance.now() - reviewStart;
            assert.equal(await input.evaluate(node => node.ownerDocument.activeElement === node), true);
            await harness.page.evaluate(editor => {
                const input = document.querySelector('textarea[aria-label="Primary source"]'), before = window.hostFixture.snapshot();
                globalThis.conflictInputMeasurement = new Promise((resolve, reject) => {
                    const listeners = new AbortController();
                    let start, frames = 0, frame, finished = false;
                    const cleanup = () => { finished = true; listeners.abort(); cancelAnimationFrame(frame); clearTimeout(timeout); };
                    const fail = error => { if (finished) return; cleanup(); reject(error); };
                    const timeout = setTimeout(() => fail(new Error("Conflict input readiness timed out.")), 10000);
                    document.addEventListener("beforeinput", event => {
                        if (event.target === input && start === undefined) start = performance.now();
                    }, { capture: true, signal: listeners.signal });
                    input.addEventListener("input", () => {
                        if (start === undefined) { fail(new Error("Conflict input missed its beforeinput origin.")); return; }
                        const check = () => {
                            if (finished) return;
                            try {
                                const f = window.hostFixture, s = f.snapshot(), c = s.bindings.comparison, view = s.bindings.views.find(v => v.id === "primary");
                                if (!c || !(editor === "candidate" ? window.hostReferenceProbe.isReady(s) : window.hostReferenceProbe.isSourceReady(s))) {
                                    frames = 0; frame = requestAnimationFrame(check); return;
                                }
                                if (s.source.revision !== before.source.revision + 1 || s.source.length !== before.source.length + 1
                                    || f.range(before.source.length, s.source.length) !== "z" || view.selection.anchor !== s.source.length || view.selection.head !== s.source.length) {
                                    fail(new Error("Conflict input had incorrect text, revision or selection.")); return;
                                }
                                if (++frames < 2) { frame = requestAnimationFrame(check); return; }
                                const inputToReviewReadyProxyMs = performance.now() - start;
                                cleanup(); resolve({ inputHandlerMs: view.metrics?.lastInputMs ?? null, inputToReviewReadyProxyMs,
                                    wholeTextExports: s.source.exports, sourceContextUnits: view.metrics?.inputUnits ?? null, comparisonContextUnits: c.input.inputUnits,
                                    sourceRows: view.metrics?.viewport.rows ?? null, comparisonRows: c.workingViewport.rows + c.referenceViewport.rows,
                                    diffWork: c.work, workingViewportRenders: c.workingViewport.renders, referenceViewportRenders: c.referenceViewport.renders });
                            } catch (error) { fail(error); }
                        }; frame = requestAnimationFrame(check);
                    }, { once: true, signal: listeners.signal });
                });
                // The next automation call consumes the result; handle early rejection meanwhile.
                globalThis.conflictInputMeasurement.catch(() => {});
            }, editor);
            const pointStart = performance.now(); await harness.page.keyboard.type("z");
            const point = await harness.page.evaluate(() => globalThis.conflictInputMeasurement); point.completeActionProxyMs = performance.now() - pointStart;
            if (editor === "candidate") { assert.equal(point.wholeTextExports, 0); assert.ok(point.sourceContextUnits < 2600); assert.ok(point.sourceRows < 100); }
            assert.ok(point.comparisonContextUnits < 2600); assert.ok(point.comparisonRows < 200);
            const retryStart = performance.now(); await click("Save reviewed source");
            await harness.page.waitForFunction(() => window.hostFixture.snapshot().pendingSaves.length === 1);
            const retryCapture = await snapshot(); assert.equal(retryCapture.pendingSaves[0].expectedServerVersion, "v1");
            await input.press("Control+End"); const lateTyping = await typeHostSuffix(input, " later");
            assert.equal(lateTyping.beforeDepth, retryCapture.history.undoDepth);
            await harness.page.evaluate(() => window.hostFixture.finishSave());
            await harness.page.waitForFunction(() => window.hostFixture.snapshot().source.serverVersion === "v2"); await ready();
            const retryWithTypingActionProxyMs = performance.now() - retryStart;
            for (let undo = 0; undo < lateTyping.groups; undo++) await input.press("Control+z");
            assert.equal((await snapshot()).source.dirty, false);
            for (let redo = 0; redo < lateTyping.groups; redo++) await input.press("Control+Shift+z"); await ready();
            const workflowActionProxyMs = performance.now() - workflowStart, after = await snapshot();
            assert.equal(after.activity.writes, 1); assert.equal(after.activity.errors, 0); assert.equal(after.saveConflict, null);
            assert.equal(after.bindings.mounts, before.bindings.mounts); assert.equal(await input.evaluate(node => node.ownerDocument.activeElement === node), true);
            // Full text and remote-reference oracles deliberately run outside timed intervals.
            assert.equal(await scene.exactText(`${original} during reviewz later`), true);
            assert.equal(await scene.exactText(remote, "reference"), true);
            await scene.dispose();
            const sample = { conflictOutcomeActionProxyMs, reviewWithTypingActionProxyMs, retryWithTypingActionProxyMs, workflowActionProxyMs, point, lateTyping,
                backgroundUpdates: after.activity.background - before.activity.background, sourceRevisions: after.source.revision - before.source.revision };
            if (iteration >= warmup) samples.push(sample);
        }
        const timing = key => distribution(samples.map(sample => sample[key]));
        const result = { host, editor, corpus: corpusId, length: original.length, warmup, measured,
            conflictOutcomeActionProxyMs: timing("conflictOutcomeActionProxyMs"), reviewWithTypingActionProxyMs: timing("reviewWithTypingActionProxyMs"),
            retryWithTypingActionProxyMs: timing("retryWithTypingActionProxyMs"), workflowActionProxyMs: timing("workflowActionProxyMs"),
            inputHandlerMs: editor === "candidate" ? distribution(samples.map(s => s.point.inputHandlerMs)) : null,
            inputToReviewReadyProxyMs: distribution(samples.map(s => s.point.inputToReviewReadyProxyMs)), completeActionProxyMs: distribution(samples.map(s => s.point.completeActionProxyMs)), samples };
        const large = original.length > 100000;
        const statistic = result.completeActionProxyMs.statistic;
        result.provisionalBudgets = { statistic, n: measured, handlerMs: 16, readyMs: large ? 250 : 100, completeActionMs: large ? 500 : 200,
            handlerMet: result.inputHandlerMs ? result.inputHandlerMs[statistic] <= 16 : null,
            readinessMet: result.inputToReviewReadyProxyMs[statistic] <= (large ? 250 : 100), completeActionMet: result.completeActionProxyMs[statistic] <= (large ? 500 : 200) };
        cases.push(result); console.log(JSON.stringify({ host, editor, corpus: corpusId, handlerMs: result.inputHandlerMs ? timingSummary(result.inputHandlerMs) : null,
            reviewReadyMs: timingSummary(result.inputToReviewReadyProxyMs), completeActionMs: timingSummary(result.completeActionProxyMs), workflowMs: timingSummary(result.workflowActionProxyMs) }));
    }
    assert.deepEqual(harness.errors, []); assert.equal((await sourceIdentity()).sha256, source.sha256);
    await writer.write({ schemaVersion: 1, status: "passed", created: new Date().toISOString(), source, smoke,
        environment: { ...environment(), browser: harness.browser.version(), buildMode: harness.buildMode, viewport: { width: 1440, height: 900 } }, cases, errors: harness.errors,
        note: "Deferred local conflict/review/retry workflows with two source views, immutable remote reference, editable comparison and 20Hz host traffic. External writer setup is outside the workflow clock. No network or imposed service delay. Stage timings include automation controls, typing while waiting, settlement and completed comparison/view readiness. Setup permits absent review and native source metrics. Point input requires review, begins at document-capture beforeinput on the intended input and ends after exact text/revision/primary selection, complete source/reference/working editor settlement and the displayed reference version are current for two frames. Complete point action begins before keyboard automation and includes transport and returning the readiness result. Adapter-handler elapsed time is separate; the native baseline has no corresponding handler timer. These elapsed clocks do not measure process CPU time. Full text/reference oracles are outside timing. Three warmups and ten fresh-page measured workflows per condition unless explicitly smoke. Neither proxy measures physical presentation; this diagnostic does not qualify native IME, contextual long-line geometry, production tails or adoption budgets." });
} catch (error) { await writer.write({ status: "failed", source, smoke, cases, error: String(error), browserErrors: harness.errors }); throw error; }
finally { try { await scene.dispose(); } finally { await harness.close(); } }
