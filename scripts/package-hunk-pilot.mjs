import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { distribution, environment, sourceIdentity } from "./measurement.mjs";
import { typeHostSuffix } from "./host-typing.mjs";
import { installHostReferenceProbe } from "./host-reference-probe.mjs";

/** Browser observations only; the comparison's real button performs the transaction. */
function observeHunkRevert() {
    const fixture = window.hostFixture, before = fixture.snapshot();
    const button = [...document.querySelectorAll("button")].find(node => node.textContent === "Use baseline");
    if (!button || button.disabled) throw new Error("Select a ready hunk before observing its actual revert control.");
    const listeners = new AbortController(), same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    let started, finished = false, resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    promise.catch(() => {});
    const cleanup = () => { finished = true; listeners.abort(); clearTimeout(timer); };
    const fail = error => { if (!finished) { cleanup(); reject(error); } };
    const timer = setTimeout(() => fail(new Error("Hunk click readiness timed out.")), 20000);
    button.addEventListener("click", event => {
        if (!event.isTrusted) { fail(new Error("Hunk revert requires an actual browser click.")); return; }
        started = performance.now();
    }, { capture: true, once: true, signal: listeners.signal });
    document.addEventListener("click", event => {
        if (event.target !== button || finished) return;
        const dispatched = performance.now(), afterDispatch = fixture.snapshot();
        void window.hostReferenceProbe.waitReady().then(afterReady => {
            if (finished) return;
            const c = afterReady.bindings.comparison, old = before.bindings.comparison;
            if (started === undefined || afterDispatch.source.revision !== before.source.revision + 1
                || afterReady.source.id !== before.source.id || afterReady.source.revision !== before.source.revision + 1
                || afterReady.source.length !== before.source.length + 1 || afterReady.source.exports !== 0
                || afterReady.history.undoDepth !== before.history.undoDepth + 1 || afterReady.history.redoDepth !== 0
                || !same(afterReady.pendingSaves, before.pendingSaves) || afterReady.source.serverVersion !== before.source.serverVersion
                || afterReady.bindings.mounts !== before.bindings.mounts || c.viewId !== old.viewId
                || !same(afterReady.bindings.views.map(v => v.viewId), before.bindings.views.map(v => v.viewId))
                || c.baseline.version !== old.baseline.version || c.baseline.epoch !== old.baseline.epoch
                || afterReady.trustedInputEvents !== before.trustedInputEvents || afterReady.untrustedInputEvents !== 0
                || fixture.range(0, 7) !== "remote " || fixture.range(afterReady.source.length - 5, afterReady.source.length) !== " tail") {
                fail(new Error("Hunk revert changed capture, ownership, source, history or immutable reference incorrectly.")); return;
            }
            const ready = performance.now(); cleanup();
            resolve({ clickDispatchObservationMs: dispatched - started, clickToFullReviewReadyProxyMs: ready - started,
                before, afterDispatch, afterReady, finalDiffBatch: c.work, finalDiffProgress: c.progress });
        }, fail);
    }, { signal: listeners.signal });
    window.packagedHunkObservation = Object.freeze({ read: () => promise });
}

/** A coupled review/save workflow using only the actual isolated consumer page. */
export async function runPackagedHunkPilot(browser, baseUrl, { directory, packageSha256, benchmark = false }) {
    const source = await sourceIdentity(), warmup = benchmark ? 3 : 0, measured = benchmark ? 10 : 1;
    const cases = [], errors = [], completedSamples = [];
    let page, activeCase, currentSample;
    await mkdir(directory, { recursive: true });
    try {
        for (const corpus of ["normal", "lines-100000"]) {
            const original = corpus === "normal"
                ? "const café = 'e\u0301 👩‍💻';\r\nconst middle = 1;\r\nconst stable = 2;\r\nconst end = 3;"
                : Array.from({ length: 100000 }, (_, i) => `const value${String(i).padStart(6, "0")} = 123;`).join("\n");
            const samples = [], warmupSamples = [];
            for (let iteration = 0; iteration < warmup + measured; iteration++) {
                activeCase = { corpus, iteration, stage: "mount" }; currentSample = { iteration, typingGroups: {} };
                page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
                page.on("pageerror", error => errors.push(error.message));
                page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
                await page.goto(new URL("/pilot", baseUrl).href);
                await page.waitForFunction(() => typeof window.mountPackagedPilot === "function");
                await page.evaluate(text => window.mountPackagedPilot(text), original);
                await page.evaluate(installHostReferenceProbe);
                const snapshot = () => page.evaluate(() => window.hostFixture.snapshot());
                const ready = () => page.evaluate(() => window.hostReferenceProbe.waitReady());
                const button = name => page.getByRole("button", { name, exact: true });
                const primary = page.getByRole("textbox", { name: "Primary source", exact: true });
                const peer = page.getByRole("textbox", { name: "Secondary source", exact: true });
                const bounds = state => {
                    for (const view of state.bindings.views) {
                        assert.ok(view.metrics.inputUnits <= 2600);
                        assert.ok(view.metrics.viewport.rows < 100 && view.metrics.viewport.readUnits < 20000);
                    }
                    const c = state.bindings.comparison;
                    assert.ok(c.input.inputUnits <= 2600 && c.workingViewport.rows + c.referenceViewport.rows < 100);
                    assert.ok(c.workingViewport.readUnits < 20000 && c.referenceViewport.readUnits < 20000);
                    assert.deepEqual(state.errors, []);
                };
                const exact = async (text, reference = false) => assert.equal(await page.evaluate(({ text, reference }) => {
                    const f = window.hostFixture, s = f.snapshot();
                    if ((reference ? s.bindings.comparison.baseline.length : s.source.length) !== text.length) return false;
                    for (let from = 0; from < text.length; from += 32768) {
                        const to = Math.min(text.length, from + 32768);
                        if ((reference ? f.referenceRange(from, to) : f.range(from, to)) !== text.slice(from, to)) return false;
                    }
                    return true;
                }, { text, reference }), true);
                const type = async (stage, input, text) => {
                    const history = await typeHostSuffix(input, text); currentSample.typingGroups[stage] = history;
                    await ready(); const s = await snapshot(); assert.equal(s.source.exports, 0); bounds(s); return history;
                };
                const captured = async (expectedServerVersion, text) => {
                    await page.waitForFunction(() => window.hostFixture.snapshot().pendingSaves.length === 1);
                    const s = await snapshot(), capture = s.pendingSaves[0];
                    assert.equal(capture.resourceId, s.source.id); assert.equal(capture.revision, s.source.revision);
                    assert.equal(capture.expectedServerVersion, expectedServerVersion); assert.equal(capture.length, text.length);
                    assert.equal(await page.evaluate(({ id, text }) => {
                        for (let from = 0; from < text.length; from += 32768) {
                            const to = Math.min(text.length, from + 32768);
                            if (window.hostFixture.pendingRange(id, from, to) !== text.slice(from, to)) return false;
                        }
                        return true;
                    }, { id: capture.id, text }), true);
                    assert.equal(s.source.saveStatus, "saving");
                    assert.equal(await page.getByLabel("Save result", { exact: true }).textContent(), "Saving captured source");
                    return capture;
                };
                const respond = async (capture, kind, version) => {
                    assert.equal(await page.evaluate(({ id, kind, version }) => window.hostFixture.respond(id, kind, version),
                        { id: capture.id, kind, version }), true);
                    await page.waitForFunction(() => window.hostFixture.snapshot().pendingCommands === 0); await ready();
                };
                const primaryState = s => s.bindings.views.find(v => v.id === "primary");
                const peerState = s => s.bindings.views.find(v => v.id === "secondary");
                const baseline = s => s.bindings.comparison.baseline;
                await ready(); const initial = await snapshot(); bounds(initial);
                assert.equal(initial.source.dirty, false); assert.equal(initial.source.exports, 0);
                const viewIds = initial.bindings.views.map(v => v.viewId), comparisonViewId = initial.bindings.comparison.viewId;
                const began = performance.now();

                activeCase.stage = "capture conflict and two remote changes";
                await primary.focus(); await primary.press("Control+Home"); await type("local", primary, "local ");
                await button("Save source").click(); const first = await captured("v0", "local " + original);
                await primary.focus(); await primary.press("Control+End"); await type("tail", primary, " tail");
                const submitted = "local " + original + " tail", remote = "remote " + original;
                await exact(submitted); await respond(first, "conflict");
                assert.equal(await page.getByLabel("Save result", { exact: true }).textContent(), "Conflict with v1; review remote source");
                await button("Review remote source").click(); await ready(); await exact(remote, true);
                assert.equal((await snapshot()).bindings.comparison.hunks, 2);
                await button("Save reviewed source").click(); const oldSave = await captured("v1", submitted);
                assert.equal(await button("Save source").isEnabled(), false);
                assert.equal(await button("Save reviewed source").isEnabled(), false);
                const peerSelection = { anchor: 6 + original.indexOf("\n") + 1 + 12, head: 6 + original.indexOf("\n") + 1 + 3,
                    anchorAffinity: "before", headAffinity: "after" };
                assert.equal(await page.evaluate(selection => {
                    const f = window.hostFixture; return f.selectSource("secondary", f.snapshot().source.revision, selection);
                }, peerSelection), true);
                await ready(); const beforeNavigation = await snapshot();

                activeCase.stage = "navigate both hunks and revert first during pending reviewed save";
                await button("Next change").click(); await ready();
                let s = await snapshot(), ranges = s.bindings.comparison.hunkRanges;
                assert.equal(ranges.length, 2); assert.equal(ranges[0].working.from, 0);
                assert.equal(ranges[0].working.to, "local".length);
                assert.equal(ranges[0].baseline.to, "remote".length);
                assert.equal(s.bindings.comparison.selection.anchor, ranges[0].working.from);
                assert.equal(s.bindings.comparison.selection.head, ranges[0].working.to);
                await button("Previous change").click(); await ready(); s = await snapshot();
                assert.equal(s.bindings.comparison.selection.anchor, ranges[1].working.from);
                assert.equal(s.bindings.comparison.selection.head, ranges[1].working.to);
                await button("Next change").click(); await ready();
                const beforeRevert = await snapshot();
                assert.deepEqual(beforeRevert.bindings.views.map(v => v.selection), beforeNavigation.bindings.views.map(v => v.selection));
                assert.equal(await button("Use baseline").isEnabled(), true);
                await page.evaluate(observeHunkRevert); const revertBegan = performance.now();
                await button("Use baseline").click();
                const revert = await page.evaluate(() => window.packagedHunkObservation.read());
                revert.completeActionProxyMs = performance.now() - revertBegan; currentSample.revert = revert;
                const reverted = remote + " tail"; await exact(reverted); await exact(remote, true);
                s = await snapshot(); bounds(s); assert.equal(s.bindings.comparison.hunks, 1);
                assert.equal(primaryState(s).selection.head, reverted.length);
                const mappedPeer = { ...peerSelection, anchor: peerSelection.anchor + 1, head: peerSelection.head + 1 };
                assert.deepEqual(peerState(s).selection, mappedPeer);
                assert.equal(await button("Use baseline").isEnabled(), false);
                assert.equal(s.pendingSaves[0].id, oldSave.id); assert.equal(s.source.serverVersion, "v0");

                activeCase.stage = "human correction and point typing before old receipt";
                await primary.focus(); const correction = await type("correction", primary, " fixed");
                await primary.press("ArrowLeft"); await primary.press("ArrowRight"); await ready();
                await page.evaluate(() => window.hostReferenceProbe.arm({ kind: "input", text: "q" }));
                let pointBegan;
                const pointHistory = await typeHostSuffix(primary, "q", () => { pointBegan = performance.now(); return primary.press("q"); });
                const point = await page.evaluate(() => window.hostReferenceProbe.read());
                point.completeActionProxyMs = performance.now() - pointBegan; currentSample.point = point; currentSample.pointHistory = pointHistory;
                const corrected = reverted + " fixedq"; await exact(corrected); await exact(remote, true);
                assert.equal(point.records.length, 1); assert.equal(point.exports, 0); assert.equal(pointHistory.groups, 1);
                const beforeReceipt = await snapshot(); assert.equal(beforeReceipt.source.revision, 19);
                assert.equal(beforeReceipt.source.dirty, true); assert.equal(beforeReceipt.pendingSaves[0].id, oldSave.id);
                assert.deepEqual(peerState(beforeReceipt).selection, mappedPeer);
                await respond(oldSave, "saved", "v2"); await exact(corrected); await exact(remote, true);
                const receipt = await snapshot(); assert.equal(receipt.source.serverVersion, "v2"); assert.equal(receipt.source.dirty, true);
                assert.equal(receipt.source.saveStatus, "idle"); assert.equal(receipt.lastOutcome.submittedRevision, oldSave.revision);
                assert.equal(receipt.lastOutcome.canonicalApplied, false); assert.deepEqual(baseline(receipt), baseline(beforeReceipt));
                assert.equal(await page.getByLabel("Source status", { exact: true }).textContent(), `Server v2 · local revision 19 · unsaved changes`);
                await button("Next change").click(); await ready();
                if (!benchmark) await page.screenshot({ path: `${directory}/hunk-${browser.browserType().name()}-${corpus}-old-receipt.png` });

                activeCase.stage = "shared undo to captured saved value and peer redo";
                await button("Show saved reference").click(); await ready(); await exact(submitted, true);
                assert.equal(baseline(await snapshot()).version, "saved:v2");
                await peer.focus(); await peer.press("Control+z"); await ready(); await exact(reverted + " fixed");
                for (let i = 0; i < correction.groups; i++) await peer.press("Control+z");
                await ready(); await exact(reverted);
                const beforeHunkUndo = await snapshot(); assert.equal(beforeHunkUndo.source.dirty, true);
                await peer.press("Control+z"); await ready(); await exact(submitted);
                const saved = await snapshot(); assert.equal(saved.source.dirty, false);
                assert.equal(saved.history.undoDepth, beforeRevert.history.undoDepth);
                assert.deepEqual(peerState(saved).selection, peerSelection); assert.equal(saved.bindings.comparison.hunks, 0);
                await primary.focus(); await primary.press("Control+Shift+z"); await ready(); await exact(reverted);
                for (let i = 0; i < correction.groups; i++) await primary.press("Control+Shift+z");
                await ready(); await exact(reverted + " fixed");
                await primary.press("Control+Shift+z"); await ready(); await exact(corrected);
                const redone = await snapshot(); assert.equal(redone.source.dirty, true);
                assert.equal(redone.source.revision, 19 + 2 * (correction.groups + 2));
                assert.deepEqual(peerState(redone).selection, mappedPeer);
                assert.deepEqual(redone.bindings.views.map(v => v.viewId), viewIds);
                assert.equal(redone.bindings.comparison.viewId, comparisonViewId);

                activeCase.stage = "next captured save survives retained-view remount";
                await button("Save source").click(); const nextSave = await captured("v2", corrected);
                await peer.focus(); const beforeRemount = await snapshot();
                assert.equal(await page.evaluate(() => window.hostFixture.remount()), true); await ready();
                const remounted = await snapshot();
                assert.deepEqual(remounted.bindings.views.map(v => v.viewId), viewIds);
                assert.equal(remounted.bindings.comparison.viewId, comparisonViewId);
                assert.deepEqual(remounted.bindings.views.map(v => v.selection), beforeRemount.bindings.views.map(v => v.selection));
                assert.deepEqual(remounted.bindings.comparison.selection, beforeRemount.bindings.comparison.selection);
                assert.equal(remounted.source.revision, beforeRemount.source.revision);
                assert.equal(remounted.pendingSaves[0].id, nextSave.id); assert.equal(remounted.bindings.mounts, 2);
                assert.equal(await peer.evaluate(node => node.ownerDocument.activeElement === node), true);
                await respond(nextSave, "saved", "v3"); await exact(corrected);
                assert.equal((await snapshot()).source.serverVersion, "v3"); assert.equal((await snapshot()).source.dirty, false);
                await button("Show saved reference").click(); await ready(); await exact(corrected, true);
                const final = await snapshot(); bounds(final); assert.equal(baseline(final).version, "saved:v3");
                assert.equal(final.bindings.comparison.hunks, 0); assert.equal(final.trustedInputEvents, 18); assert.equal(final.untrustedInputEvents, 0);
                assert.equal(final.reportedFailures, 0); assert.ok(final.activity.background > 0);
                if (!benchmark) await page.screenshot({ path: `${directory}/hunk-${browser.browserType().name()}-${corpus}-saved.png` });
                await page.evaluate(() => { window.hostFixture.dispose(); window.hostFixture.release(); });
                const released = await snapshot();
                for (const field of ["resources", "documents", "views", "tabs", "leases", "subscriptions"]) assert.equal(released.diagnostics[field], 0);
                assert.equal(released.diagnostics.history.groups, 0); assert.equal(await page.locator(".st-editing-candidate").count(), 0);
                const sample = { ...currentSample, sourceLength: original.length, workflowAutomationProxyMs: performance.now() - began,
                    trustedInputEvents: 18, savePreconditions: [first, oldSave, nextSave], viewIds, comparisonViewId,
                    beforeRevert, beforeReceipt, receipt, beforeHunkUndo, saved, redone, beforeRemount, remounted, final, released };
                (iteration < warmup ? warmupSamples : samples).push(sample); completedSamples.push({ corpus, ...sample });
                assert.deepEqual(errors, []);
                console.log(JSON.stringify({ corpus, iteration, measured: iteration >= warmup, semanticChecks: "passed",
                    revertDispatchMs: revert.clickDispatchObservationMs, revertReadyMs: revert.clickToFullReviewReadyProxyMs,
                    inputHandlerMs: point.records[0].inputHandlerMs, inputReadyMs: point.lastInputToFullReviewReadyProxyMs,
                    workflowMs: sample.workflowAutomationProxyMs }));
                await page.close(); page = undefined; currentSample = undefined;
            }
            const stats = values => ({ ...distribution(values), max: Math.max(...values) });
            const metric = select => stats(samples.map(select)), large = corpus !== "normal";
            const metrics = {
                hunkClickDispatchObservationMs: metric(s => s.revert.clickDispatchObservationMs),
                hunkClickToFullReviewReadyProxyMs: metric(s => s.revert.clickToFullReviewReadyProxyMs),
                hunkCompleteActionProxyMs: metric(s => s.revert.completeActionProxyMs),
                inputHandlerMs: metric(s => s.point.records[0].inputHandlerMs),
                inputToFullReviewReadyProxyMs: metric(s => s.point.lastInputToFullReviewReadyProxyMs),
                completePointActionProxyMs: metric(s => s.point.completeActionProxyMs),
                workflowAutomationProxyMs: metric(s => s.workflowAutomationProxyMs),
            };
            cases.push({ corpus, length: original.length, warmup, measured, diagnosticOnly: !benchmark, ...metrics,
                assessment: benchmark ? { handlerMet: metrics.inputHandlerMs.p95 <= 16,
                    readinessMet: metrics.inputToFullReviewReadyProxyMs.p95 <= (large ? 250 : 100),
                    pointActionMet: metrics.completePointActionProxyMs.p95 <= (large ? 500 : 200) } : null,
                warmupSamples, samples });
        }
        assert.equal((await sourceIdentity()).sha256, source.sha256);
        const report = { schemaVersion: 1, source, created: new Date().toISOString(), packageSha256, benchmark,
            environment: { ...environment(), browser: browser.browserType().name(), browserVersion: browser.version() }, cases, errors,
            boundaries: "Restored public modules/declarations/CSS in an isolated consumer; local host-owned deferred ports and20Hzprogress. " +
                "Fresh page/controller per normalCRLF/distinct100k workflow. Two separated row hunks; first-row revert while reviewed save is pending, then real correction and q before old receipt. " +
                "Hunk navigation uses real controls. Click capture-to-document-bubble observation includes synchronous subscribers and intervening observers, excludes preceding pointer/focus work, and is not an exact adapter handler or complete traced callback. " +
                "Hunk readiness waits exact model/revision/history/capture/identity plus allthreeworkingpanes/renderedselections/reference/version/caret/scans/diff/twoframes via the shared readiness probe. Complete action includes pointer/focus, automation and observations. " +
                "Only q after revert/correction receives point targets: handler<=16ms,ready<=100/250ms,action<=200/500ms. Adapter elapsed excludes beforeinput and observers; full q readiness starts at beforeinput. Hunk and whole-workflow metrics have no keystroke budget. " +
                "Initial mount/probe/ready excluded; workflow runs from first actual edit through disposal/explicit release, including controls/transport/local settlement/oracles/cleanup. No imposed service delay. SemanticN1 includes screenshots and establishes no tail; repeated3warm+10measurements exclude screenshots. " +
                "Explicit save captures serialize; ordinary edit buffers exportzero. Undo can restore an explicitly exported saved buffer. This short-row hunk control is not a full-document bulk revert, cold startup, React packaged host, production tail or speedup experiment. " +
                "All prior misses remain; nativeIME/reconversion/OSclipboard/AT/physicaldisplay unverified. No process CPU or complete task attribution." };
        await writeFile(`${directory}/hunk-${benchmark ? "bench-" : ""}${browser.browserType().name()}.json`, JSON.stringify(report, null, 2));
        return report;
    } catch (error) {
        const path = `${directory}/hunk-failure-${Date.now()}-${process.pid}`;
        const diagnostic = page ? await page.evaluate(() => {
            const f = window.hostFixture; if (!f) return null; const s = f.snapshot();
            return { snapshot: s, start: f.range(0, Math.min(512, s.source.length)), end: f.range(Math.max(0, s.source.length - 512), s.source.length) };
        }).catch(() => null) : null;
        await writeFile(path + ".json", JSON.stringify({ source, packageSha256, activeCase, error: String(error?.stack ?? error),
            cases, completedSamples, currentSample, diagnostic, errors }, null, 2));
        if (page) await page.screenshot({ path: path + ".png", fullPage: true }).catch(() => {});
        throw error;
    } finally { await page?.close(); }
}
