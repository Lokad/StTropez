import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { distribution, environment, sourceIdentity } from "./measurement.mjs";
import { typeHostSuffix } from "./host-typing.mjs";
import { installHostReferenceProbe } from "./host-reference-probe.mjs";

const normal = "const café = 'e\u0301 👩‍💻';\r\nconst middle = 1;\r\nconst stable = 2;\r\nconst end = 3;";
const identities = state => ({ source: state.source.id, views: Object.fromEntries(state.bindings.views.map(view => [view.id, view.viewId])), comparison: state.bindings.comparison.viewId });
const selections = state => ({ views: Object.fromEntries(state.bindings.views.map(view => [view.id, view.selection])), comparison: state.bindings.comparison.selection });
function bounds(state) {
    assert.equal(state.bindings.activeViews, 2);
    for (const view of state.bindings.views) {
        assert.ok(view.metrics.inputUnits <= 2600);
        assert.ok(view.metrics.viewport.rows < 100 && view.metrics.viewport.readUnits < 20000);
    }
    const comparison = state.bindings.comparison;
    assert.ok(comparison.input.inputUnits <= 2600);
    assert.ok(comparison.workingViewport.rows + comparison.referenceViewport.rows < 100);
    assert.ok(comparison.workingViewport.readUnits < 20000 && comparison.referenceViewport.readUnits < 20000);
}

function auditBrowserInputs() {
    const listeners = new AbortController(), records = [];
    const names = new Set(["Primary source", "Secondary source", "Comparison working source"]);
    document.addEventListener("input", event => {
        const target = event.target;
        if (!(target instanceof HTMLTextAreaElement) || !names.has(target.getAttribute("aria-label"))) return;
        records.push({ trusted: event.isTrusted, inputType: event.inputType, composing: event.isComposing, units: event.data?.length ?? null,
            view: target.getAttribute("aria-label"), at: performance.now() });
    }, { capture: true, signal: listeners.signal });
    const read = () => records.map(record => ({ ...record }));
    window.packagedReactInputAudit = Object.freeze({ read, stop: () => { listeners.abort(); return read(); } });
}

async function workflow(page, original, activeCase, screenshot) {
    const state = () => page.evaluate(() => window.hostFixture.snapshot());
    const ready = async () => { const current = await page.evaluate(() => window.hostReferenceProbe.waitReady()); bounds(current); return current; };
    const click = name => page.getByRole("button", { name, exact: true }).click();
    const primary = page.getByRole("textbox", { name: "Primary source", exact: true });
    const peer = page.getByRole("textbox", { name: "Secondary source", exact: true });
    const comparison = page.getByRole("group", { name: "Source review", exact: true });
    const checkpoints = [], typing = [], captures = [], selectionNavigation = [];
    Object.assign(activeCase, { checkpoints, typing, captures, selectionNavigation });
    let expected = original;
    const exact = async (value = expected, reference = false) => assert.equal(await page.evaluate(({ value, reference }) => {
        const fixture = window.hostFixture, current = fixture.snapshot();
        if ((reference ? current.bindings.comparison?.baseline.length : current.source.length) !== value.length) return false;
        for (let from = 0; from < value.length; from += 32768) {
            const to = Math.min(value.length, from + 32768);
            if ((reference ? fixture.referenceRange(from, to) : fixture.range(from, to)) !== value.slice(from, to)) return false;
        }
        return true;
    }, { value, reference }), true);
    const append = async text => {
        await primary.focus(); await primary.press("Control+End");
        await primary.press("ArrowLeft"); await primary.press("ArrowRight"); await ready();
        let history;
        if (/^[\x00-\x7f]*$/.test(text)) history = await typeHostSuffix(primary, text);
        else {
            assert.equal(text, " corrected é");
            const ascii = await typeHostSuffix(primary, " corrected ");
            await primary.press("ArrowLeft"); await primary.press("ArrowRight"); await ready();
            const before = await state();
            await primary.evaluate(node => {
                const listeners = new AbortController(), events = [], composition = [];
                node.addEventListener("input", event => events.push({ type: event.inputType, trusted: event.isTrusted,
                    composing: event.isComposing, data: event.data, at: performance.now() }), { capture: true, signal: listeners.signal });
                for (const type of ["compositionstart", "compositionupdate", "compositionend"]) node.addEventListener(type,
                    event => composition.push({ type, trusted: event.isTrusted, data: event.data, at: performance.now() }), { signal: listeners.signal });
                window.readPackagedReactUnicode = () => { listeners.abort(); return { events, composition }; };
            });
            let unicode;
            try { await primary.pressSequentially("é"); }
            finally { unicode = await primary.evaluate(() => window.readPackagedReactUnicode()); }
            const after = await ready();
            assert.equal(unicode.events.length, 1);
            assert.equal(unicode.events[0].data, "é"); assert.equal(unicode.events[0].trusted, true);
            assert.ok(["insertText", "insertCompositionText"].includes(unicode.events[0].type));
            if (unicode.events[0].type === "insertCompositionText") {
                assert.equal(unicode.composition[0]?.type, "compositionstart");
                assert.equal(unicode.composition.at(-1)?.type, "compositionend");
                assert.equal(unicode.composition.at(-1)?.data, "é");
                assert.ok(unicode.composition.every(event => event.trusted));
            }
            assert.equal(after.source.revision, before.source.revision + 1);
            assert.equal(after.history.undoDepth, before.history.undoDepth + 1);
            history = { beforeDepth: ascii.beforeDepth, groups: ascii.groups + 1,
                events: [...ascii.events, ...unicode.events], ascii, unicode,
                unicodeRevision: { before: before.source.revision, after: after.source.revision },
                note: "Automated Unicode browser event path, with an explicit history boundary; not a native IME check." };
        }
        expected += text;
        await ready(); await exact(); assert.equal((await state()).source.exports, 0);
        typing.push({ text, history }); return history;
    };
    const pending = async version => {
        await page.waitForFunction(() => window.hostFixture.snapshot().pendingSaves.length === 1);
        const current = await state(), capture = current.pendingSaves[0];
        assert.equal(capture.expectedServerVersion, version); assert.equal(capture.revision, current.source.revision); assert.equal(capture.length, expected.length);
        captures.push(capture); return capture;
    };
    const settle = async (version, dirty) => {
        await page.waitForFunction(({ version, dirty }) => { const current = window.hostFixture.snapshot(); return current.pendingCommands === 0 && current.source.serverVersion === version && current.source.dirty === dirty; }, { version, dirty });
        const current = await ready(); await exact(); checkpoints.push(current); return current;
    };
    const moveHistory = async (kind, count, value) => {
        await peer.focus();
        for (let index = 0; index < count; index++) { await peer.press(kind === "undo" ? "Control+z" : "Control+Shift+z"); await ready(); }
        expected = value; await exact(); return state();
    };
    const initial = await state(), started = performance.now();
    activeCase.stage = "proposal and correction";
    await click("Associate agent"); await click("Request proposal");
    await page.waitForFunction(() => window.hostFixture.snapshot().requestInput !== null);
    const request = (await state()).requestInput; assert.equal(request.sourceLength, 5);
    await page.evaluate(value => window.hostFixture.deliverProposal(value), original);
    await page.waitForFunction(length => { const current = window.hostFixture.snapshot(); return current.review.proposal !== null && current.source.length === length; }, original.length);
    await ready(); await exact(); const ids = identities(await state());
    const beforePeerNavigation = await state(), secondLineStart = original.indexOf("\n") + 1;
    await peer.focus();
    for (const key of ["Control+Home", "ArrowDown", "Home", ...Array(5).fill("ArrowRight"), ...Array(3).fill("Shift+ArrowLeft")]) {
        await peer.press(key); const current = await ready(), view = current.bindings.views.find(view => view.id === "secondary");
        assert.deepEqual(identities(current), ids); assert.equal(current.source.revision, beforePeerNavigation.source.revision);
        assert.deepEqual(current.history, beforePeerNavigation.history);
        assert.deepEqual(selections(current).views.primary, selections(beforePeerNavigation).views.primary);
        selectionNavigation.push({ key, resourceId: current.source.id, revision: current.source.revision, viewId: view.viewId, selection: view.selection });
    }
    const peerSelection = selections(await state()).views.secondary;
    assert.equal(peerSelection.anchor, secondLineStart + 5); assert.equal(peerSelection.head, secondLineStart + 2);
    await exact();
    await append(" corrected é");
    activeCase.stage = "failed capture and remounted retry";
    await click("Save source"); await pending("v0"); await append(" later");
    const failedSource = expected, beforeFailure = await ready();
    await page.evaluate(() => window.hostFixture.failSave());
    await page.waitForFunction(() => { const current = window.hostFixture.snapshot(); return current.source.saveStatus === "failed" && current.pendingCommands === 0; });
    const failed = await ready(); assert.deepEqual(selections(failed), selections(beforeFailure)); assert.deepEqual(failed.history, beforeFailure.history); await exact();
    assert.equal(failed.source.serverVersion, "v0"); await click("Dismiss message");
    await click("Save source"); const retry = await pending("v0"); assert.equal(retry.length, failedSource.length);
    const tail = await append(" tail"), afterTail = expected;
    await click("Move primary view"); await page.evaluate(() => window.hostFixture.unmount()); await page.evaluate(() => window.hostFixture.mount());
    await ready(); assert.deepEqual(identities(await state()), ids); await exact();
    await page.evaluate(() => window.hostFixture.finishSave()); await settle("v1", true);
    await moveHistory("undo", tail.groups, failedSource); assert.equal((await state()).source.dirty, false);
    await moveHistory("redo", tail.groups, afterTail); assert.equal((await state()).source.dirty, true);
    await click("Retry acknowledgement");
    await page.waitForFunction(() => window.hostFixture.snapshot().review.acknowledgements[0]?.status === "failed");
    await click("Retry acknowledgement"); await page.waitForFunction(() => window.hostFixture.snapshot().review.proposal === null);
    assert.equal((await state()).activity.acknowledgements, 1); await click("Dismiss message");
    await click("Request proposal"); await page.waitForFunction(() => window.hostFixture.snapshot().requestInput !== null);
    const next = await state(); assert.equal(next.requestInput.sourceLength, expected.length); assert.equal(next.requestInput.configurationRevision, next.configuration.revision);
    await click("Interrupt agent"); await click("Deliver proposal"); await page.waitForFunction(() => window.hostFixture.snapshot().pendingCommands === 0); await exact();
    activeCase.stage = "captured Run and independent configuration";
    const configuration = page.getByRole("textbox", { name: "Configuration path", exact: true });
    await configuration.fill("captured-run.csv"); await click("Run captured inputs");
    await page.waitForFunction(() => window.hostFixture.snapshot().pendingRuns.length === 1);
    const run = await page.evaluate(() => window.hostFixture.runCapture(0)); assert.equal(run.source, expected); assert.equal(run.configuration.path, "captured-run.csv");
    await append(" run"); await configuration.fill("during-run.csv"); await primary.focus();
    await page.evaluate(() => window.hostFixture.finishRun()); await page.waitForFunction(() => window.hostFixture.snapshot().activity.completedRuns === 1);
    assert.equal(await primary.evaluate(node => node.ownerDocument.activeElement === node), true); await exact();
    activeCase.stage = "conflict review retains later typing and configuration";
    await click("Save source"); await pending("v1");
    const remote = "remote " + original;
    await page.evaluate(value => window.hostFixture.externalWrite(value), remote);
    await page.evaluate(() => window.hostFixture.finishSave());
    await page.waitForFunction(() => { const current = window.hostFixture.snapshot(); return current.pendingCommands === 0 && current.saveConflict?.observedVersion === "v2"; });
    assert.equal((await state()).source.serverVersion, "v1"); await exact();
    await click("Review remote source");
    await page.waitForFunction(() => window.hostFixture.snapshot().pendingConflictReads === 1);
    await configuration.fill("during-review.csv"); await append(" review");
    await primary.evaluate(node => { node.dataset.pilotContinuity = "pending-remote"; });
    assert.equal(await page.evaluate(() => window.hostFixture.finishConflictReview()), true);
    await ready(); await exact(); await exact(remote, true);
    assert.equal(await primary.evaluate(node => node.ownerDocument.activeElement === node && node.dataset.pilotContinuity === "pending-remote"), true);
    assert.equal(await configuration.inputValue(), "during-review.csv");
    const reviewed = await state(); assert.deepEqual(identities(reviewed), ids);
    assert.equal(reviewed.bindings.comparison.baseline.version, "reference:conflict-v2");
    assert.equal(reviewed.source.serverVersion, "v1");

    activeCase.stage = "real hunk reversion and point input during captured save";
    const captured = expected;
    await click("Save reviewed source"); const oldSave = await pending("v2");
    const beforeHunk = await ready(), peerBeforeHunk = selections(beforeHunk).views.secondary;
    assert.equal(beforeHunk.bindings.comparison.hunks, 2);
    await comparison.getByRole("textbox", { name: "Comparison working source", exact: true }).press("Control+Home"); await ready();
    await comparison.getByRole("button", { name: "Next change", exact: true }).click(); await ready();
    await comparison.getByRole("button", { name: "Use baseline", exact: true }).click();
    expected = "remote " + captured;
    const reverted = await ready(); await exact(); await exact(remote, true);
    assert.equal(reverted.history.undoDepth, beforeHunk.history.undoDepth + 1);
    assert.deepEqual(reverted.pendingSaves, [oldSave]);
    assert.deepEqual(selections(reverted).views.secondary, { ...peerBeforeHunk, anchor: peerBeforeHunk.anchor + 7, head: peerBeforeHunk.head + 7 });
    const revertedValue = expected, correction = await append(" fixed"), corrected = expected;
    await primary.press("ArrowLeft"); await primary.press("ArrowRight"); await ready();
    await page.evaluate(() => window.hostReferenceProbe.arm({ kind: "input", text: "q" }));
    let pointBegan;
    const pointHistory = await typeHostSuffix(primary, "q", () => { pointBegan = performance.now(); return primary.press("q"); });
    const point = await page.evaluate(() => window.hostReferenceProbe.read());
    point.completeActionProxyMs = performance.now() - pointBegan; expected += "q";
    Object.assign(activeCase, { point, pointHistory });
    assert.equal(pointHistory.groups, 1); assert.equal(point.records.length, 1); assert.equal(point.exports, 0);
    await exact(); bounds(await state()); const correctedWithPoint = expected;
    await page.evaluate(() => window.hostFixture.finishSave()); await settle("v3", true); await exact(remote, true);
    assert.equal((await state()).bindings.comparison.baseline.version, "reference:conflict-v2");
    if (screenshot) await screenshot("old-receipt");

    activeCase.stage = "shared undo to saved capture and peer redo";
    await moveHistory("undo", 1, corrected);
    await moveHistory("undo", correction.groups, revertedValue);
    await moveHistory("undo", 1, captured);
    const savedByUndo = await state(); assert.equal(savedByUndo.source.dirty, false);
    assert.deepEqual(selections(savedByUndo).views.secondary, peerBeforeHunk);
    await moveHistory("redo", 1, revertedValue);
    await moveHistory("redo", correction.groups, corrected);
    await moveHistory("redo", 1, correctedWithPoint); assert.equal((await state()).source.dirty, true);
    assert.deepEqual(identities(await state()), ids);

    activeCase.stage = "latest save survives explicit retained-view remount";
    await click("Save source"); const latestSave = await pending("v3"), beforeRemount = await ready();
    await page.evaluate(() => window.hostFixture.unmount()); await page.evaluate(() => window.hostFixture.mount());
    const remounted = await ready(); await exact();
    assert.deepEqual(identities(remounted), ids); assert.deepEqual(selections(remounted), selections(beforeRemount));
    assert.equal(remounted.source.revision, beforeRemount.source.revision); assert.deepEqual(remounted.pendingSaves, [latestSave]);
    await page.evaluate(() => window.hostFixture.finishSave()); await settle("v4", false);

    activeCase.stage = "canonical reply retains newer typing and shared saved history";
    const canonical = expected, spaces = await append("  "), withSpaces = expected;
    await click("Save source"); await pending("v4"); const late = await append(" later"), later = expected;
    await page.evaluate(() => window.hostFixture.finishSave()); await settle("v5", true);
    await moveHistory("undo", late.groups, withSpaces); assert.equal((await state()).source.dirty, true);
    await moveHistory("undo", spaces.groups, canonical); assert.equal((await state()).source.dirty, false);
    await moveHistory("redo", spaces.groups, withSpaces); await moveHistory("redo", late.groups, later);
    await click("Save source"); await pending("v5");
    await page.evaluate(() => window.hostFixture.finishSave()); await settle("v6", false);
    await click("Capture reference refresh"); await click("Finish reference refresh");
    const final = await ready(); await exact(); await exact(expected, true);
    assert.equal(final.bindings.comparison.baseline.version, "reference:saved-v6");
    assert.equal(final.bindings.comparison.hunks, 0); assert.deepEqual(identities(final), ids);
    assert.equal(final.activity.writes, 5); assert.equal(final.activity.completedRuns, 1); assert.equal(final.activity.acknowledgements, 1);
    assert.ok(final.activity.background > initial.activity.background);
    assert.equal(final.pendingCommands, 0); assert.equal(final.saveConflict, null); assert.equal(final.layout.modal.kind, "none");
    if (screenshot) await screenshot("saved");
    const browserInputs = await page.evaluate(() => window.packagedReactInputAudit.stop());
    assert.equal(browserInputs.length, typing.reduce((count, entry) => count + entry.history.events.length, 0) + pointHistory.events.length);
    const expectedInputs = [...typing.flatMap(entry => entry.history.events), ...pointHistory.events];
    assert.deepEqual(browserInputs.map(record => record.inputType), expectedInputs.map(record => record.type));
    assert.ok(browserInputs.every(record => record.trusted && record.view === "Primary source"));
    activeCase.stage = "explicit host disposal";
    await page.evaluate(() => { window.hostReferenceProbe.abort(); return window.hostFixture.dispose(); });
    const disposed = await state();
    assert.equal(disposed.disposed, true); assert.equal(disposed.bindings.activeViews, 0);
    for (const key of ["leases", "views", "subscriptions"]) assert.equal(disposed.diagnostics[key], 0);
    assert.equal(disposed.hostSubscriptions, 0); assert.equal(disposed.pendingCommands, 0);
    assert.deepEqual(disposed.pendingSaves, []); assert.deepEqual(disposed.pendingRuns, []);
    return { point, pointHistory, browserInputs, selectionNavigation, typing, captures, checkpoints, request,
        run: { sourceLength: run.source.length, configuration: run.configuration, settings: run.settings },
        final, disposed, workflowAutomationProxyMs: performance.now() - started };
}

// Reuses the existing React application and local service ports; no editor implementation lives here.
export async function runPackagedReactPilot(browser, baseUrl, { directory, packageSha256, benchmark = false }) {
    const source = await sourceIdentity(), warmup = benchmark ? 3 : 0, measured = benchmark ? 10 : 1, cases = [], errors = [], completedSamples = [];
    let page, activeCase; await mkdir(directory, { recursive: true });
    try {
        for (const corpus of ["normal", "lines-100000"]) {
            const original = corpus === "normal" ? normal : Array.from({ length: 100000 }, (_, index) => `const value${String(index).padStart(6, "0")} = 123;`).join("\n");
            const samples = [], warmupSamples = [];
            for (let iteration = 0; iteration < warmup + measured; iteration++) {
                activeCase = { corpus, iteration, stage: "mount" }; const setup = performance.now();
                page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(30000);
                page.on("pageerror", error => errors.push(error.message)); page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
                await page.goto(new URL("/hosts/react/?editor=candidate", baseUrl).href);
                await page.waitForFunction(() => window.hostFixture?.ready && window.hostFixture.snapshot().bindings.activeViews === 2);
                assert.equal(await page.evaluate(() => window.hostFixture.mode), "react");
                await page.evaluate(installHostReferenceProbe);
                await page.evaluate(auditBrowserInputs);
                const setupProxyMs = performance.now() - setup;
                const sample = await workflow(page, original, activeCase, benchmark ? undefined : stage => page.screenshot({ path: `${directory}/react-${browser.browserType().name()}-${corpus}-${stage}.png` }));
                Object.assign(sample, { iteration, setupProxyMs }); completedSamples.push({ corpus, sample: iteration < warmup ? "warmup" : "measured", ...sample }); assert.deepEqual(errors, []);
                (iteration < warmup ? warmupSamples : samples).push(sample); await page.close(); page = undefined;
                console.log(JSON.stringify({ host: "restored-react", corpus, iteration, sample: iteration < warmup ? "warmup" : iteration - warmup + 1, semanticChecks: "passed" }));
            }
            const measure = get => ({ ...distribution(samples.map(get)), max: Math.max(...samples.map(get)) });
            const targets = { inputHandlerMs: 16, readinessMs: corpus === "normal" ? 100 : 250, pointActionMs: corpus === "normal" ? 200 : 500 };
            const pointHandler = measure(sample => sample.point.records[0].inputHandlerMs), pointReady = measure(sample => sample.point.browserToFullReviewReadyProxyMs), pointAction = measure(sample => sample.point.completeActionProxyMs);
            cases.push({ corpus, length: original.length, warmup, measured, diagnosticOnly: !benchmark,
                inputHandlerMs: pointHandler, inputToFullReviewReadyProxyMs: pointReady, completePointActionProxyMs: pointAction,
                workflowAutomationProxyMs: measure(sample => sample.workflowAutomationProxyMs), targets,
                assessment: { handlerMet: pointHandler.p95 <= targets.inputHandlerMs, readinessMet: pointReady.p95 <= targets.readinessMs, pointActionMet: pointAction.p95 <= targets.pointActionMs }, warmupSamples, samples });
        }
        assert.equal((await sourceIdentity()).sha256, source.sha256);
        await writeFile(`${directory}/react-${benchmark ? "bench-" : ""}${browser.browserType().name()}.json`, JSON.stringify({ source, packageSha256, benchmark, environment: { ...environment(), browser: browser.version() }, cases, errors,
            boundaries: "Restored compiled assets and the existing development React host under Strict Mode. Initial mount/setup is separate; workflow starts at association/proposal request and ends after explicit disposal. Actual typing, deferred save/failure/conflict/canonical replies, shared history, Run, configuration, remount and references use original host ports. Point q alone has handler/readiness/action targets, with the shared all-pane/caret/scans/diff/reference/two-frame probe. Handler elapsed is not CPU; workflow includes transport, controls, exact-source oracles and local settlement, with no imposed service delay. Fresh page per workflow; warmups/raw samples retained. Semantic screenshots are outside point clocks and included in semantic workflow; repeated workflows omit screenshots. No native IME/OSclipboard/AT/display, startup tail, browser heap-retention or production qualification." }, null, 2));
    } catch (error) {
        const failureId = Date.now();
        await writeFile(`${directory}/react-failure-${failureId}.json`, JSON.stringify({ source, packageSha256, activeCase, cases, completedSamples, errors, failure: String(error.stack ?? error),
            state: page ? await page.evaluate(() => window.hostFixture?.snapshot()).catch(() => null) : null,
            browserInputs: page ? await page.evaluate(() => window.packagedReactInputAudit?.stop()).catch(() => null) : null }, null, 2));
        if (page) await page.screenshot({ path: `${directory}/react-failure-${failureId}.png` }).catch(() => {});
        throw error;
    } finally { await page?.close(); }
}
