import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { openHarness } from "./browser-harness.mjs";
import { distribution, environment, sourceIdentity } from "./measurement.mjs";
import { corpus } from "../tests/fixtures/workloads.ts";
import { typeHostSuffix } from "./host-typing.mjs";

const source = await sourceIdentity(), smoke = process.env.STTROPEZ_CONFLICT_SMOKE === "1", warmup = smoke ? 0 : 3, measured = smoke ? 1 : 10;
const harness = await openHarness(), cases = [], snapshot = () => harness.page.evaluate(() => window.hostFixture.snapshot());
const click = name => harness.page.getByRole("button", { name, exact: true }).click();
async function ready() {
    await harness.page.waitForFunction(() => { const s = window.hostFixture?.snapshot(), c = s?.bindings.comparison;
        return s && s.bindings.activeViews === 2 && s.bindings.views.every(v => !v.metrics || !v.metrics.pendingDragScroll && !v.metrics.viewport.pending && v.metrics.viewport.revision === s.source.revision)
            && (!c || c.status === "ready" && c.workingRevision === s.source.revision && !c.input.pendingDragScroll && !c.workingViewport.pending && c.workingViewport.revision === s.source.revision
                && c.referenceViewport && !c.referenceViewport.pending); });
    await harness.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
try {
    for (const editor of ["native", "candidate"]) for (const host of ["plain", "react"]) for (const corpusId of editor === "candidate" ? ["normal", "lines-100000", "unique-lines-100000", "single-line"] : ["normal"]) {
        const original = (corpusId === "unique-lines-100000" ? Array.from({ length: 100000 }, (_, index) => `const value${String(index).padStart(6, "0")} = 123;\n`).join("") : corpus(corpusId)).trimEnd(), remote = `remote ${original}`, samples = [];
        for (let iteration = 0; iteration < warmup + measured; iteration++) {
            await harness.page.goto(new URL(`/hosts/${host}/?editor=${editor}`, harness.page.url()).href); await ready();
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
            await harness.page.evaluate(() => {
                const input = document.querySelector('textarea[aria-label="Primary source"]'), before = window.hostFixture.snapshot();
                globalThis.conflictInputMeasurement = new Promise((resolve, reject) => {
                    let start, frames = 0;
                    const timeout = setTimeout(() => reject(new Error("Conflict input readiness timed out.")), 10000);
                    document.addEventListener("beforeinput", () => { start = performance.now(); }, { once: true, capture: true });
                    input.addEventListener("input", () => {
                        const check = () => {
                            const f = window.hostFixture, s = f.snapshot(), c = s.bindings.comparison, view = s.bindings.views.find(v => v.id === "primary");
                            if (!c || c.status !== "ready" || c.workingRevision !== s.source.revision || c.workingViewport.revision !== s.source.revision
                                || c.input.pendingDragScroll || c.workingViewport.pending || !c.referenceViewport || c.referenceViewport.pending
                                || s.bindings.views.some(v => v.metrics && (v.metrics.pendingDragScroll || v.metrics.viewport.pending || v.metrics.viewport.revision !== s.source.revision))) {
                                frames = 0; requestAnimationFrame(check); return;
                            }
                            if (s.source.revision !== before.source.revision + 1 || s.source.length !== before.source.length + 1
                                || f.range(before.source.length, s.source.length) !== "z" || view.selection.anchor !== s.source.length || view.selection.head !== s.source.length) {
                                clearTimeout(timeout); reject(new Error("Conflict input had incorrect text, revision or selection.")); return;
                            }
                            if (++frames < 2) { requestAnimationFrame(check); return; }
                            clearTimeout(timeout); resolve({ inputHandlerMs: view.metrics?.lastInputMs ?? null, inputToReviewReadyProxyMs: performance.now() - start,
                                wholeTextExports: s.source.exports, sourceContextUnits: view.metrics?.inputUnits ?? null, comparisonContextUnits: c.input.inputUnits,
                                sourceRows: view.metrics?.viewport.rows ?? null, comparisonRows: c.workingViewport.rows + c.referenceViewport.rows,
                                diffWork: c.work, workingViewportRenders: c.workingViewport.renders, referenceViewportRenders: c.referenceViewport.renders });
                        }; requestAnimationFrame(check);
                    }, { once: true });
                });
            });
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
            assert.equal(await harness.page.evaluate(({ expected, reference }) => { const f = window.hostFixture;
                if (f.snapshot().source.length !== expected.length || f.snapshot().bindings.comparison.baseline.length !== reference.length) return false;
                for (let from = 0; from < expected.length; from += 32768) if (f.range(from, Math.min(expected.length, from + 32768)) !== expected.slice(from, from + 32768)) return false;
                for (let from = 0; from < reference.length; from += 32768) if (f.referenceRange(from, Math.min(reference.length, from + 32768)) !== reference.slice(from, from + 32768)) return false;
                return true;
            }, { expected: `${original} during reviewz later`, reference: remote }), true);
            await harness.page.evaluate(() => window.hostFixture.dispose()); const disposed = await snapshot();
            assert.equal(disposed.diagnostics.views, 0); assert.equal(disposed.diagnostics.leases, 0); assert.equal(disposed.diagnostics.subscriptions, 0); assert.equal(disposed.hostSubscriptions, 0);
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
        result.provisionalBudgets = { handlerMs: 16, readyMs: large ? 250 : 100, completeActionMs: large ? 500 : 200,
            handlerMet: result.inputHandlerMs ? result.inputHandlerMs.p95 <= 16 : null,
            readinessMet: result.inputToReviewReadyProxyMs.p95 <= (large ? 250 : 100), completeActionMet: result.completeActionProxyMs.p95 <= (large ? 500 : 200) };
        cases.push(result); console.log(JSON.stringify({ host, editor, corpus: corpusId, samples: measured, handlerP95: result.inputHandlerMs?.p95 ?? null,
            reviewReadyP95: result.inputToReviewReadyProxyMs.p95, completeActionP95: result.completeActionProxyMs.p95, workflowP95: result.workflowActionProxyMs.p95 }));
    }
    assert.deepEqual(harness.errors, []); assert.equal((await sourceIdentity()).sha256, source.sha256);
    await mkdir("artifacts/bench/save-conflicts", { recursive: true });
    await writeFile("artifacts/bench/save-conflicts/latest.json", JSON.stringify({ schemaVersion: 1, created: new Date().toISOString(), source, smoke,
        environment: { ...environment(), browser: harness.browser.version(), viewport: { width: 1440, height: 900 } }, cases, errors: harness.errors,
        note: "Deferred local conflict/review/retry workflows with two source views, immutable remote reference, editable comparison and 20Hz host traffic. External writer setup is outside the workflow clock. No network or imposed service delay. Stage timings include automation controls, typing while waiting, settlement and completed comparison/view readiness. Point input begins at document-capture beforeinput and ends after exact text/revision/primary selection and all working viewports plus diff are current for two frames. Complete point action begins before keyboard automation and includes transport and returning the readiness result. Handler CPU is separate; native source-handler CPU is unavailable. Full text/reference oracles are outside timing. Three warmups and ten fresh-page measured workflows per condition unless explicitly smoke. Neither proxy measures physical presentation; this diagnostic does not qualify native IME/AT, contextual long-line geometry, production tails or adoption budgets." }, null, 2));
} finally { await harness.close(); }
