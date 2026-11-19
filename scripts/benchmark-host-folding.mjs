import assert from "node:assert/strict";
import { createReportWriter } from "./benchmark-report.mjs";
import { performance } from "node:perf_hooks";
import { openHarness } from "./browser-harness.mjs";
import { distribution, environment, sourceIdentity, timingSummary } from "./measurement.mjs";
import { corpus } from "../fixtures/workloads.ts";
import { installHostReferenceProbe } from "./host-reference-probe.mjs";
import { hostTextEquals } from "./host-scene.mjs";

/** @typedef {{kind: "navigation" | "typing", keydownHandlerMs: number, inputHandlerMs: number | null,
 * keyToReviewReadyMs: number, beforeInputToReviewReadyMs: number | null, revision: number, historyDepth: number,
 * head: number, exports: number, inputUnits: number, rows: number[], comparisonRows: number, maxReadUnits: number,
 * background: number, focused: boolean}} FoldObservation */
/** @typedef {FoldObservation & {completeActionProxyMs: number}} FoldPoint */
/** @typedef {typeof globalThis & {foldPointMeasurement: Promise<FoldObservation>}} MeasurementGlobal */
const commonClocks = /** @type {const} */ (["keydownHandlerMs", "keyToReviewReadyMs", "completeActionProxyMs"]);
const typingClocks = /** @type {const} */ ([...commonClocks, "inputHandlerMs", "beforeInputToReviewReadyMs"]);
/** @typedef {{iteration: number, warmup: boolean, status: string, navigation: FoldPoint | null, typing: FoldPoint | null,
 * workflowMs?: number, released?: {views: number, leases: number, subscriptions: number, host: number}}} Workflow */
/** @typedef {{host: string, corpus: string, length: number, foldCount: number, warmup: number, measured: number, raw: Workflow[],
 * distributions: {navigation: Record<typeof commonClocks[number], ReturnType<typeof distribution>>,
 * typing: Record<typeof typingClocks[number], ReturnType<typeof distribution>>, workflowMs: ReturnType<typeof distribution>} | null}} Group */

const source = await sourceIdentity(), writer = await createReportWriter("artifacts/bench/host-folding", "full");
const harness = await openHarness(), page = harness.page, warmup = 2, measured = 10;
const report = { schemaVersion: 1, created: new Date().toISOString(), source,
    environment: { ...environment(), browser: harness.browser.version(), buildMode: harness.buildMode, viewport: { width: 1440, height: 900 } },
    cases: /** @type {Group[]} */ ([]), status: "running", active: /** @type {{host: string, corpus: string, iteration: number} | null} */ (null),
    scope: "One/1000 captured folds on normal/100k source, one active caret, independent secondary and immutable comparison, 20Hz host traffic. ArrowDown skips hidden rows; typing on the next visible header/footer and shared undo preserve raw text. The setup completion offer is dismissed before measuring editor navigation. No closed navigation experiment or prior score rerun.",
    clocks: "keydownHandlerMs/inputHandlerMs are adapter handlers. Readiness starts at captured keydown; typing also records beforeinput-to-readiness (includes beforeinput work). The shared live-owner predicate requires every working/reference editor, complete sets, fold generations, pending input/commands, caret/scans, alignment/scroll and comparison; the point confirms the immutable reference and two RAFs. Later language results are outside this gate; an actual provider reply and completion dismissal are required before the points. CompleteActionProxyMs includes browser automation, excluding listener setup/oracles. Workflow includes setup, fold creation, controls, oracles, undo and disposal; it has no point-action budget. No CPU, physical display, OS input or native IME claim.",
    retention: "Every raw warmup/measured workflow is retained, including completed points of a failed workflow. A partial report is written on failure; no automatic retries." };
const save = () => writer.write(report);
/** @param {string} name */
const click = name => page.getByRole("button", { name, exact: true }).click();
const ready = () => page.evaluate(() => window.hostReferenceProbe.waitReady());
/** @param {string} text */
const equals = text => hostTextEquals(page, text);
/** @param {"navigation" | "typing"} kind @param {{length: number, head: number, foldCount: number}} expected */
async function point(kind, expected) {
    await page.evaluate(({ kind, expected }) => {
        const input = document.querySelector('textarea[aria-label="Primary source"]'), prior = window.hostFixture.snapshot(), listeners = new AbortController();
        const before = prior.bindings.views.find(v => v.id === "primary")?.metrics, captured = prior.bindings.comparison, reference = captured?.referenceViewport;
        if (!(input instanceof HTMLTextAreaElement) || !before || !captured || !reference) throw new Error("Fold point requires its captured candidate and reference views.");
        /** @type {MeasurementGlobal} */ (globalThis).foldPointMeasurement = new Promise((resolve, reject) => {
            /** @type {number | undefined} */ let keyStart;
            /** @type {number | undefined} */ let inputStart;
            let frames = 0, finished = false;
            /** @param {string} message */
            const fail = message => { if (finished) return; finished = true; listeners.abort(); clearTimeout(timeout); reject(new Error(message)); };
            const timeout = setTimeout(() => fail("Fold point did not reach complete review readiness."), 20000);
            const check = () => {
                if (finished) return; const s = window.hostFixture.snapshot(), c = s.bindings.comparison, p = s.bindings.views.find(v => v.id === "primary");
                let full;
                try { full = window.hostReferenceProbe.isReady(s); }
                catch (error) { fail(error instanceof Error ? error.message : String(error)); return; }
                if (!c?.referenceViewport || !p?.metrics || keyStart === undefined) { fail("Fold point lost its captured views or keydown clock."); return; }
                full &&= c.baseline?.version === captured.baseline?.version && c.referenceViewport.revision === reference.revision;
                if (!full) { frames = 0; requestAnimationFrame(check); return; }
                if (s.source.revision !== prior.source.revision + (kind === "typing" ? 1 : 0) || s.source.length !== expected.length || p.selection.anchor !== expected.head || p.selection.head !== expected.head
                    || p.metrics.viewport.collapsedFolds !== expected.foldCount || p.metrics.viewport.visibleLines !== expected.foldCount + 1 || s.source.exports !== 0 || kind === "typing" && (inputStart === undefined || p.metrics.inputEvents !== before.inputEvents + 1)) {
                    fail("Fold point failed its exact source/selection, capture or projection assertion."); return;
                }
                if (++frames < 2) { requestAnimationFrame(check); return; }
                const metrics = s.bindings.views.map(v => v.metrics);
                if (!metrics.every(m => m !== null)) { fail("Fold point lost candidate view metrics."); return; }
                finished = true; listeners.abort(); clearTimeout(timeout);
                resolve({ kind, keydownHandlerMs: p.metrics.lastKeydownMs, inputHandlerMs: kind === "typing" ? p.metrics.lastInputMs : null,
                    keyToReviewReadyMs: performance.now() - keyStart, beforeInputToReviewReadyMs: inputStart === undefined ? null : performance.now() - inputStart,
                    revision: s.source.revision, historyDepth: s.history.undoDepth, head: p.selection.head, exports: s.source.exports, inputUnits: p.metrics.inputUnits,
                    rows: metrics.map(m => m.viewport.rows), comparisonRows: c.workingViewport.rows + c.referenceViewport.rows,
                    maxReadUnits: Math.max(...metrics.map(m => m.viewport.readUnits), c.workingViewport.readUnits, c.referenceViewport.readUnits), background: s.activity.background,
                    focused: document.activeElement === input });
            };
            input.addEventListener("keydown", event => { if (keyStart !== undefined || event.key !== (kind === "typing" ? "!" : "ArrowDown")) return;
                keyStart = performance.now(); requestAnimationFrame(check); }, { capture: true, signal: listeners.signal });
            input.addEventListener("beforeinput", event => { if (kind === "typing" && event.inputType === "insertText" && event.data === "!") inputStart = performance.now(); }, { capture: true, signal: listeners.signal });
        });
    }, { kind, expected });
    const started = performance.now(); if (kind === "typing") await page.keyboard.type("!"); else await page.keyboard.press("ArrowDown");
    const observation = await page.evaluate(() => /** @type {MeasurementGlobal} */ (globalThis).foldPointMeasurement), completeActionProxyMs = performance.now() - started;
    const sample = Object.assign(observation, { completeActionProxyMs });
    assert.equal(sample.focused, true); assert.ok(sample.inputUnits <= 2600); assert.ok(sample.rows.every(n => n < 100)); assert.ok(sample.comparisonRows < 100); assert.ok(sample.maxReadUnits < 20000);
    return sample;
}
try {
    await save();
    for (const host of ["plain", "react"]) for (const id of /** @type {const} */ (["normal", "lines-100000"])) {
        const body = corpus(id), original = "fold header\r\n" + body + (body.endsWith("\n") ? "" : "\r\n") + "fold footer", footer = original.length - 11;
        const starts = [0]; for (let at = original.indexOf("\n"); at >= 0; at = original.indexOf("\n", at + 1)) starts.push(at + 1);
        const foldCount = id === "lines-100000" ? 1000 : 1, headers = Array.from({ length: foldCount }, (_, i) => { const start = starts[Math.floor(i * (starts.length - 1) / foldCount)]; assert.ok(start !== undefined, "Fold header requires its captured line start."); return start; });
        const ranges = headers.map((anchor, i) => ({ anchor, head: headers[i + 1] ?? footer })), target = headers[1] ?? footer;
        /** @type {Group} */ const group = { host, corpus: id, length: original.length, foldCount, warmup, measured, raw: [], distributions: null }; report.cases.push(group);
        for (let iteration = 0; iteration < warmup + measured; iteration++) {
            const started = performance.now();
            /** @type {Workflow} */ const sample = { iteration, warmup: iteration < warmup, status: "running", navigation: null, typing: null }; group.raw.push(sample); report.active = { host, corpus: id, iteration };
            await page.goto(`/hosts/${host}/?editor=candidate`);
            await page.evaluate(installHostReferenceProbe);
            await page.evaluate(text => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]); }, original);
            await click("Open source review"); await ready(); await click("Capture review acceptance"); await click("Finish review acceptance"); await ready();
            const input = page.getByRole("textbox", { name: "Primary source", exact: true }); await input.focus();
            await page.evaluate(ranges => { const f = window.hostFixture; f.selectSourceSet("primary", f.snapshot().source.revision, ranges); }, ranges);
            await click("Fold selected lines"); await ready();
            await page.evaluate(() => { const f = window.hostFixture; f.selectSource("primary", f.snapshot().source.revision, { anchor: 0, head: 0 }); f.requestProvider(); });
            await page.waitForFunction(() => (window.hostFixture.snapshot().bindings.language.sessions.find(s => s.id === "primary")?.provider.received ?? 0) > 0);
            await ready(); await input.scrollIntoViewIfNeeded(); await input.focus();
            // The explicit provider request opens completion; ArrowDown must target the editor.
            await input.press("Escape"); await ready();
            const before = await page.evaluate(() => window.hostFixture.snapshot());
            const provider = before.bindings.language.sessions.find(s => s.id === "primary");
            assert.ok(provider && !provider.provider.offer, "Fold navigation requires the setup completion offer to be dismissed.");
            sample.navigation = await point("navigation", { length: original.length, head: target, foldCount });
            sample.typing = await point("typing", { length: original.length + 1, head: target + 1, foldCount });
            assert.equal(sample.typing.historyDepth, before.history.undoDepth + 1); assert.equal(await equals(original.slice(0, target) + "!" + original.slice(target)), true);
            await page.getByRole("textbox", { name: "Secondary source", exact: true }).press("Control+z"); await ready(); assert.equal(await equals(original), true);
            const restored = (await page.evaluate(() => window.hostFixture.snapshot())).bindings.views.find(v => v.id === "primary")?.metrics;
            assert.ok(restored, "Fold undo requires its primary candidate view."); assert.equal(restored.viewport.collapsedFolds, foldCount);
            await page.evaluate(() => window.hostFixture.dispose());
            const released = await page.evaluate(() => { const s = window.hostFixture.snapshot(); return { views: s.diagnostics.views, leases: s.diagnostics.leases, subscriptions: s.diagnostics.subscriptions, host: s.hostSubscriptions }; });
            assert.deepEqual(released, { views: 0, leases: 0, subscriptions: 0, host: 0 }); assert.deepEqual(harness.errors, []);
            Object.assign(sample, { status: "passed", workflowMs: performance.now() - started, released }); await save();
        }
        const observed = group.raw.filter(s => !s.warmup);
        /** @template {typeof typingClocks[number]} Key @param {"navigation" | "typing"} name @param {readonly Key[]} keys */
        const summarize = (name, keys) => /** @type {Record<Key, ReturnType<typeof distribution>>} */ (Object.fromEntries(keys.map(k => [k, distribution(observed.map(s => {
            const value = s[name]?.[k]; assert.ok(typeof value === "number", "Fold summary requires its completed point clock."); return value;
        }))])));
        group.distributions = { navigation: summarize("navigation", commonClocks), typing: summarize("typing", typingClocks), workflowMs: distribution(observed.map(s => { assert.ok(s.workflowMs !== undefined, "Fold summary requires its completed workflow."); return s.workflowMs; })) };
    }
    assert.equal((await sourceIdentity()).sha256, source.sha256, "Source changed during measurement.");
    report.status = "passed"; report.active = null; Object.assign(report, { finished: new Date().toISOString() }); await save();
    console.log(JSON.stringify(report.cases.map(g => { assert.ok(g.distributions, "Fold report requires its completed distributions."); return { host: g.host, corpus: g.corpus, navigationReadyMs: timingSummary(g.distributions.navigation.keyToReviewReadyMs),
        inputHandlerMs: timingSummary(g.distributions.typing.inputHandlerMs), inputReadyMs: timingSummary(g.distributions.typing.keyToReviewReadyMs), completeInputMs: timingSummary(g.distributions.typing.completeActionProxyMs) }; })));
} catch (error) { report.status = "failed"; Object.assign(report, { failure: error instanceof Error ? error.stack ?? String(error) : String(error), finished: new Date().toISOString() }); await save(); throw error; }
finally { await harness.close(); }
