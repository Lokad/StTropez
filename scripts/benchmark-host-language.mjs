import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { openHarness } from "./browser-harness.mjs";
import { corpus } from "../fixtures/workloads.ts";
import { distribution, environment, sourceIdentity } from "./measurement.mjs";
import { installHostReferenceProbe } from "./host-reference-probe.mjs";

const source = await sourceIdentity(), smoke = process.env.STTROPEZ_HOST_SMOKE === "1", warmup = smoke ? 0 : 3, measured = smoke ? 1 : 10;
const harness = await openHarness(), page = harness.page, cases = []; let activeCase;
const snapshot = () => page.evaluate(() => window.hostFixture.snapshot()), clock = () => page.evaluate(() => performance.now());
const click = name => page.getByRole("button", { name, exact: true }).click();
const ready = () => page.evaluate(() => globalThis.hostReferenceProbe.waitReady());
try {
    for (const host of ["plain", "react"]) for (const corpusId of ["normal", "unique-lines-100000", "single-line"]) {
        const header = "const saMORE = 123; // TODO\n", body = corpusId === "unique-lines-100000"
            ? Array.from({ length: 100_000 }, (_, i) => `const v${String(i).padStart(6, "0")} = 123456;\n`).join("") : corpus(corpusId);
        const original = header + body, proposal = original + "\nagent proposal", corrected = proposal.replace("saMORE", "sample"), samples = [];
        for (let iteration = 0; iteration < warmup + measured; iteration++) {
            activeCase = { host, corpus: corpusId, iteration, stage: "mount" };
            await page.goto(new URL(`/hosts/${host}/?editor=candidate`, page.url()).href);
            const input = page.getByRole("textbox", { name: "Primary source", exact: true }); await input.waitFor();
            await page.evaluate(installHostReferenceProbe);
            await page.evaluate(text => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]); }, original);
            await click("Open source review"); await ready();
            const before = await snapshot(), start = await clock(), stages = {};
            const stage = async (name, action) => { activeCase.stage = name; const began = await clock(); await action(); await ready(); stages[name] = await clock() - began; };
            await stage("proposal", async () => { await click("Associate agent"); await click("Request proposal"); await page.evaluate(text => window.hostFixture.deliverProposal(text), proposal); });
            await input.press("Control+Home"); for (let i = 0; i < 8; i++) await input.press("ArrowRight"); await ready();
            await stage("capturedHover", async () => { await input.press("Control+k"); await input.press("Control+i");
                await page.getByRole("tooltip").filter({ hasText: "Symbol in this source." }).waitFor(); });
            await input.evaluate(node => {
                node.addEventListener("beforeinput", () => { window.hostFixture.requestProvider(); }, { once: true });
            });
            const preTyping = await snapshot();
            await stage("typingWithProviderRequest", async () => { await input.pressSequentially("z"); });
            const typed = await snapshot(), metrics = typed.bindings.views.find(v => v.id === "primary").metrics;
            assert.equal(typed.bindings.hover.presentation.visible, false); assert.equal(typed.bindings.hover.layoutObserver, false);
            const hover = typed.bindings.hover.sessions.find(s => s.id === "primary").counters;
            assert.equal(hover.posted, 1); assert.equal(hover.received, 1); assert.ok(hover.postedUnits <= 4096);
            assert.equal(typed.source.revision, preTyping.source.revision + 1); assert.equal(typed.source.length, proposal.length + 1);
            assert.equal(typed.bindings.views.find(v => v.id === "primary").selection.head, 9);
            await page.waitForFunction(() => window.hostFixture.snapshot().bindings.language.sessions.find(s => s.id === "primary").provider.stale === 1);
            assert.equal(await page.getByRole("listbox", { name: "Completion choices", exact: true }).getByRole("option").count(), 0);
            await stage("freshCompletion", async () => { await input.press("Control+z"); await input.press("Control+Space"); await page.getByRole("option", { name: "sample", exact: true }).waitFor(); await input.press("Alt+Enter"); });
            await stage("keyboardFind", async () => { await input.press("Control+f"); const field = page.getByRole("textbox", { name: "Find source", exact: true });
                await field.fill("TODO"); await page.waitForFunction(() => document.querySelector('[aria-label="Find status"]').textContent.includes("· ready")); await field.press("Escape"); });
            await stage("saveAndLaterCorrection", async () => { await click("Save source"); await page.waitForFunction(() => window.hostFixture.snapshot().pendingSaves.length === 1);
                await input.press("Control+End"); await input.pressSequentially(" later"); await page.evaluate(() => window.hostFixture.finishSave());
                await page.waitForFunction(() => window.hostFixture.snapshot().review.acknowledgements.length === 1); });
            const exportsBeforeNextRequest = (await snapshot()).source.exports; assert.equal(exportsBeforeNextRequest, 0);
            await stage("acknowledgeAndNextRequest", async () => { await click("Retry acknowledgement"); await page.waitForFunction(() => window.hostFixture.snapshot().review.acknowledgements[0]?.status === "failed");
                await click("Retry acknowledgement"); await page.waitForFunction(() => window.hostFixture.snapshot().review.proposal === null); await click("Request proposal"); });
            const workflowAutomationProxyMs = await clock() - start, after = await snapshot();
            assert.equal(after.requestInput.sourceLength, corrected.length + 6); assert.equal(after.source.dirty, true);
            assert.equal(await page.evaluate(text => window.hostFixture.range(0, text.length) === text, corrected + " later"), true);
            assert.equal(await page.evaluate(text => window.hostFixture.referenceRange(0, text.length) === text, original), true);
            assert.ok(after.activity.background > before.activity.background); assert.equal(after.bindings.mounts, before.bindings.mounts);
            assert.equal(after.source.exports, 1); // The explicitly captured next agent request exports its immutable input.
            assert.ok(after.bindings.views.every(v => v.metrics.inputUnits < 2600 && v.metrics.viewport.rows < 100));
            assert.ok(after.bindings.language.sessions.every(s => s.presentation.cachedLines <= 128));
            const provider = after.bindings.language.sessions.find(s => s.id === "primary").provider;
            assert.equal(provider.posted, 2); assert.equal(provider.applied, 1); assert.equal(provider.stale, 1); assert.ok(provider.postedUnits <= 8192);
            await page.evaluate(() => window.hostFixture.dispose()); const disposed = await snapshot();
            assert.equal(disposed.hostSubscriptions, 0); assert.equal(disposed.diagnostics.leases, 0); assert.equal(disposed.diagnostics.views, 0); assert.equal(disposed.diagnostics.subscriptions, 0);
            if (iteration >= warmup) samples.push({ workflowAutomationProxyMs, stages, typingInputHandlerMs: metrics.lastInputMs,
                provider, hover, backgroundUpdates: after.activity.background - before.activity.background, sourceLength: after.source.length, exportsBeforeNextRequest, exportsAfterNextRequest: after.source.exports });
        }
        cases.push({ host, corpus: corpusId, length: original.length, warmup, measured, samples,
            workflowAutomationProxyMs: distribution(samples.map(s => s.workflowAutomationProxyMs)), inputHandlerMs: distribution(samples.map(s => s.typingInputHandlerMs)),
            stages: Object.fromEntries(Object.keys(samples[0].stages).map(name => [name, distribution(samples.map(s => s.stages[name]))])) });
        console.log(JSON.stringify({ host, corpus: corpusId, measured, semanticChecks: "passed" }));
    }
    assert.deepEqual(harness.errors, []); assert.equal((await sourceIdentity()).sha256, source.sha256);
    const report = { schemaVersion: 1, created: new Date().toISOString(), source, smoke, environment: { ...environment(), browser: harness.browser.version() }, cases, errors: harness.errors,
        boundaries: "Fresh page per workflow; setup/mount and full text/reference oracles outside the total clock. Both candidate hosts, 20Hz traffic, three working views plus immutable comparison. A captured safe-text hover uses an independent real-worker lane and is ready before actual typing. Typing dismisses the popup and releases its layout observer in beforeinput, then starts a bounded completion worker request in the same beforeinput task, so its reply must follow the edit and be rejected. A fresh keyboard completion, search/cancel, save with later typing, acknowledgement failure/retry and next request follow. No service delay imposed. Input-event handler elapsed time is a separate adapter snapshot, excluding beforeinput/provider posting. It includes synchronous work inside that span and does not measure process CPU time. Stage and whole workflow automation proxies include controls, transport, each stage's explicit provider gates and shared live-owner working/reference settlement (complete selections/folds, pending input/commands, caret/scans/drag, comparison alignment/scroll), source revision/reference label and two consecutive frames. They are not browser-input-to-ready point timings or physical display latency. Existing host-input benchmark retains its separate point/burst clocks and targets. Native IME/clipboard remain unqualified. Historical reports retain their original readiness definition." };
    await mkdir("artifacts/bench/host-language", { recursive: true }); await writeFile(`artifacts/bench/host-language/${smoke ? "smoke" : "latest"}.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ cases: cases.length, summary: cases.map(c => ({ host: c.host, corpus: c.corpus, handlerP95: c.inputHandlerMs.p95, workflowP95: c.workflowAutomationProxyMs.p95 })) }, null, 2));
} catch (error) {
    await mkdir("artifacts/bench/host-language", { recursive: true });
    await writeFile(`artifacts/bench/host-language/failure-${new Date().toISOString().replaceAll(":", "-")}.json`, JSON.stringify({ source, smoke, activeCase, completedCases: cases, error: String(error), stack: error?.stack }, null, 2));
    console.error(JSON.stringify({ activeCase })); throw error;
} finally { await harness.close(); }
