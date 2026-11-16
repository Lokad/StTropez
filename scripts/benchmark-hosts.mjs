import assert from "node:assert/strict";
import { createReportWriter } from "./benchmark-report.mjs";
import { openHarness } from "./browser-harness.mjs";
import { corpus } from "../fixtures/workloads.ts";
import { distribution, environment, sourceIdentity, timingSummary } from "./measurement.mjs";
import { typeHostSuffix } from "./host-typing.mjs";

const source = await sourceIdentity(), smoke = process.env.STTROPEZ_HOST_SMOKE === "1", warmup = smoke ? 0 : 3, measured = smoke ? 1 : 10;
const writer = await createReportWriter("artifacts/bench/hosts", smoke ? "smoke" : "full");
let activeCase;
const harness = await openHarness(), cases = [];
const snapshot = () => harness.page.evaluate(() => window.hostFixture.snapshot());
const click = name => harness.page.getByRole("button", { name, exact: true }).click();
const clock = () => harness.page.evaluate(() => performance.now());
async function ready() {
    await harness.page.waitForFunction(() => {
        const s = window.hostFixture?.snapshot(); return s && s.bindings.activeViews === 2
            && s.bindings.views.every(view => !view.metrics || !view.metrics.pendingDragScroll && !view.metrics.viewport.pending && view.metrics.viewport.revision === s.source.revision)
            && (!s.bindings.comparison || s.bindings.comparison.status === "ready" && s.bindings.comparison.workingRevision === s.source.revision
                && s.bindings.comparison.workingViewport.revision === s.source.revision && !s.bindings.comparison.input.pendingDragScroll && !s.bindings.comparison.workingViewport.pending
                && s.bindings.comparison.referenceViewport && !s.bindings.comparison.referenceViewport.pending);
    });
}
try {
    for (const editor of ["native", "candidate"]) for (const host of ["plain", "react"]) for (const corpusId of editor === "candidate" ? ["normal", "lines-10000", "lines-100000"] : ["normal", "lines-10000"]) {
        const original = corpus(corpusId).trimEnd(), proposal = `agent ${original}`, corrected = `fixed ${proposal}`, samples = [];
        for (let iteration = 0; iteration < warmup + measured; iteration++) {
            activeCase = { editor, host, corpus: corpusId, iteration, stage: "mount" };
            await harness.page.goto(new URL(`/hosts/${host}/?editor=${editor}`, harness.page.url()).href); await ready();
            await harness.page.evaluate(text => { const s = window.hostFixture.snapshot(); window.hostFixture.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]); }, original); await ready();
            assert.equal(await harness.page.locator("textarea.st-input-context").count(), editor === "candidate" ? 2 : 0);
            assert.equal(await harness.page.locator("textarea.st-editor").count(), editor === "native" ? 2 : 0);
            const before = await snapshot(); if (editor === "candidate") assert.equal(before.source.exports, 0);
            const start = await clock();
            activeCase.stage = "proposal";
            await click("Associate agent"); await click("Request proposal");
            const request = (await snapshot()).requestInput; assert.equal(request.sourceLength, original.length);
            await harness.page.evaluate(() => window.hostFixture.setPath("during-request.csv"));
            await harness.page.evaluate(text => window.hostFixture.deliverProposal(text), proposal);
            await harness.page.waitForFunction(() => window.hostFixture.snapshot().review.proposal !== null); await ready();
            const delivered = await snapshot(), input = harness.page.getByRole("textbox", { name: "Primary source", exact: true });
            assert.equal(delivered.bindings.comparison.baseline.length, original.length);
            await input.press("Control+Home"); await input.pressSequentially("fixed "); await ready();
            const correction = await snapshot();
            activeCase.stage = "captured-save-and-later-typing";
            await click("Save source");
            await harness.page.waitForFunction(() => window.hostFixture.snapshot().pendingSaves.length === 1);
            await input.press("Control+End");
            const lateTyping = await typeHostSuffix(input, " later");
            const typing = await snapshot(); await harness.page.evaluate(() => window.hostFixture.finishSave());
            await harness.page.waitForFunction(() => window.hostFixture.snapshot().review.acknowledgements.length === 1);
            assert.equal(await input.evaluate(node => node.ownerDocument.activeElement === node), true);
            assert.equal(lateTyping.beforeDepth, correction.history.undoDepth);
            const lateTypingGroups = lateTyping.groups;
            assert.equal(typing.history.undoDepth - correction.history.undoDepth, lateTypingGroups);
            activeCase = { ...activeCase, stage: "undo-to-saved", correction, typing, lateTyping, lateTypingGroups };
            for (let undo = 0; undo < lateTypingGroups; undo++) {
                await input.press("Control+z"); assert.equal((await snapshot()).history.undoDepth, typing.history.undoDepth - undo - 1);
            }
            assert.equal((await snapshot()).source.dirty, false);
            activeCase.stage = "redo-and-acknowledgement";
            for (let redo = 0; redo < lateTypingGroups; redo++) await input.press("Control+Shift+z");
            await click("Retry acknowledgement"); await harness.page.waitForFunction(() => window.hostFixture.snapshot().review.acknowledgements[0]?.status === "failed");
            await click("Retry acknowledgement"); await harness.page.waitForFunction(() => window.hostFixture.snapshot().review.proposal === null);
            const saved = await snapshot(); assert.equal(saved.activity.writes, 1); assert.equal(saved.source.serverVersion, "v1");
            activeCase.stage = "captured-run";
            await click("Run captured inputs");
            const captured = await harness.page.evaluate(() => window.hostFixture.runCapture(0));
            assert.deepEqual(captured, { source: `${corrected} later`, configuration: { path: "during-request.csv", format: "csv" }, settings: { mode: "preview" } });
            await input.press("End"); await input.pressSequentially("!");
            await harness.page.evaluate(() => window.hostFixture.setPath("during-run.csv"));
            assert.deepEqual(await harness.page.evaluate(() => window.hostFixture.runCapture(0)), captured);
            await harness.page.evaluate(() => window.hostFixture.finishRun());
            await harness.page.waitForFunction(() => window.hostFixture.snapshot().activity.completedRuns === 1);
            assert.equal(await input.evaluate(node => node.ownerDocument.activeElement === node), true);
            await input.pressSequentially("?"); await ready(); const running = await snapshot();
            await click("Request proposal"); const next = await snapshot();
            assert.equal(next.requestInput.sourceLength, corrected.length + 8); assert.equal(next.requestInput.configurationRevision, next.configuration.revision);
            const workflowAutomationProxyMs = await clock() - start;
            // Full text checks run outside timing and use explicit bounded range reads.
            assert.equal(await harness.page.evaluate(expected => {
                const f = window.hostFixture; if (f.snapshot().source.length !== expected.length) return false;
                for (let from = 0; from < expected.length; from += 32768) if (f.range(from, Math.min(expected.length, from + 32768)) !== expected.slice(from, from + 32768)) return false;
                return true;
            }, `${corrected} later!?`), true);
            assert.equal(await harness.page.evaluate(expected => {
                const f = window.hostFixture;
                for (let from = 0; from < expected.length; from += 32768) if (f.referenceRange(from, Math.min(expected.length, from + 32768)) !== expected.slice(from, from + 32768)) return false;
                return true;
            }, original), true);
            assert.equal(next.bindings.mounts, before.bindings.mounts); assert.equal(next.activity.errors, 1);
            const metrics = [correction, typing, running].flatMap(s => s.bindings.views.filter(v => v.id === "primary" && v.metrics).map(v => v.metrics));
            if (editor === "candidate") { assert.ok(metrics.every(s => s.inputUnits < 2600)); assert.ok(next.bindings.views.every(v => v.metrics.viewport.rows < 100)); }
            const disposeStart = await clock(); await harness.page.evaluate(() => window.hostFixture.dispose());
            const disposeAutomationProxyMs = await clock() - disposeStart, disposed = await snapshot();
            assert.equal(disposed.pendingCommands, 0); assert.equal(disposed.diagnostics.leases, 0); assert.equal(disposed.diagnostics.views, 0);
            assert.equal(disposed.diagnostics.subscriptions, 0); assert.equal(disposed.hostSubscriptions, 0);
            const sample = { workflowAutomationProxyMs, disposeAutomationProxyMs, proposalTransactionMs: delivered.proposalTransactionMs,
                observedInputHandlerMs: metrics.map(s => s.lastInputMs), maxInputUnits: metrics.length ? Math.max(...metrics.map(s => s.inputUnits)) : null,
                revisions: next.source.revision - before.source.revision, backgroundUpdates: next.activity.background - before.activity.background,
                reviewHunks: next.bindings.comparison.hunks, reviewMaxStepMs: next.bindings.comparison.work.maxStepMs,
                reviewWorkingRows: next.bindings.comparison.workingViewport.rows, reviewReferenceRows: next.bindings.comparison.referenceViewport.rows,
                lateTypingGroups, lateTypingEvents: lateTyping.events,
                mounts: next.bindings.mounts - before.bindings.mounts, writes: next.activity.writes, acknowledgements: next.activity.acknowledgements, completedRuns: next.activity.completedRuns };
            if (iteration >= warmup) samples.push(sample);
        }
        cases.push({ host, editor, corpus: corpusId, length: original.length, warmup, measured, workflowAutomationProxyMs: distribution(samples.map(s => s.workflowAutomationProxyMs)),
            disposeAutomationProxyMs: distribution(samples.map(s => s.disposeAutomationProxyMs)), proposalTransactionMs: distribution(samples.map(s => s.proposalTransactionMs)), samples });
        console.log(JSON.stringify({ host, editor, corpus: corpusId, workflowProxyMs: timingSummary(cases.at(-1).workflowAutomationProxyMs), proposalMs: timingSummary(cases.at(-1).proposalTransactionMs) }));
    }
    assert.deepEqual(harness.errors, []); assert.equal((await sourceIdentity()).sha256, source.sha256);
    await writer.write({ schemaVersion: 3, status: "passed", created: new Date().toISOString(), source, smoke,
        environment: { ...environment(), browser: harness.browser.version(), viewport: { width: 1440, height: 900 } }, cases, errors: harness.errors,
        note: "Synthetic complete host workflows with two source editor views, an immutable-reference/editable-working comparison after proposal delivery, a typed form and 20Hz activity. Candidate cases include 100,000 lines. Three warmups and ten measured fresh-page workflows per condition unless explicitly smoke mode. Workflow/disposal proxies include automation transport, controls, local deferred service settlement, RAF/readiness polling, completed diff work and current comparison viewports. No imposed network delay or physical presentation is measured. Proposal transaction timing covers synchronous request acceptance and workspace/view notification, excluding host navigation/rendered-frame readiness. Observed input-handler samples are only selected candidate keystrokes; ordinary input has its separate report. Full working/reference text oracles are outside timing. Explicit service capture can export exact whole text; routine candidate rendering and diagnostics remain bounded. Review step metrics describe the latest diff generation, not the longest call across the workflow. Desktop diagnostic measurements establish no production tail, retention, native-device or renderer-selection guarantee." });
} catch (error) {
    const observed = await harness.page.evaluate(() => { const f = window.hostFixture; if (!f) return null; const s = f.snapshot();
        return { snapshot: s, head: f.range(0, Math.min(s.source.length, 80)), tail: f.range(Math.max(0, s.source.length - 100), s.source.length) }; }).catch(failure => ({ observationError: String(failure) }));
    await writer.write({ status: "failed", source, smoke, cases, activeCase, error: String(error), observed, browserErrors: harness.errors });
    throw error;
} finally { await harness.close(); }
