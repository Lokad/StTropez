import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { openHarness } from "./browser-harness.mjs";
import { sourceIdentity, environment, distribution as measuredDistribution } from "./measurement.mjs";
import { createHostScene } from "./host-scene.mjs";
/** @typedef {ReturnType<Window["hostFixture"]["snapshot"]>} HostState */
/** @typedef {{commandToReviewReadyProxyMs: number, handlerMs: number, callbackMaximumMs: number,
 * wordScanSteps: number, maxWordScanStepMs: number, graphemeScanSteps: number, maxGraphemeScanStepMs: number,
 * selection: HostState["bindings"]["views"][number]["selection"],
 * referenceVersion: NonNullable<NonNullable<HostState["bindings"]["comparison"]>["baseline"]>["version"],
 * exports: number, backgroundUpdates: number}} WordObservation */
/** @typedef {typeof globalThis & {wordSelectionProbe: {promise: Promise<WordObservation>}}} MeasurementGlobal */
/** @typedef {{iteration: number, selected: WordObservation & {completeCommandActionProxyMs: number},
 * point: Awaited<ReturnType<Window["hostReferenceProbe"]["read"]>> & {completeActionProxyMs: number},
 * workflowActionProxyMs: number, setupSaveExports: number, selectionExportDelta: number, backgroundUpdates: number}} Sample */
const source = await sourceIdentity(), smoke = process.env.STTROPEZ_WORD_SELECTION_SMOKE === "1", inspect = process.env.STTROPEZ_WORD_SELECTION_INSPECT === "1", warmup = smoke ? 0 : 3, measured = smoke ? 1 : 10;
assert.ok(!inspect || smoke, "Screenshots are a separate smoke inspection, never a tail campaign.");
const directory = "artifacts/bench/host-word-selection", cases = [], displays = [], h = await openHarness(), page = h.page, scene = createHostScene(page);
let activeCase;
/** @type {{host: string, corpus: string, stage: string, path: string, sha256: string}[]} */ const images = [];
/** @param {readonly number[]} values */
const distribution = values => ({ ...measuredDistribution(values), max: Math.max(...values) });
const snapshot = scene.snapshot, input = () => page.getByRole("textbox", { name: "Primary source", exact: true }), root = () => page.locator('.st-editor:has(> textarea[aria-label="Primary source"])');
/** @param {string} name */
const click = name => page.getByRole("button", { name, exact: true }).click();
const ready = scene.ready, exact = scene.exactText, dispose = scene.dispose;
/** @param {string} host @param {string} corpus @param {string} stage */
async function picture(host, corpus, stage) {
    const path = directory + "/inspect/" + host + "-" + corpus + "-" + stage + ".png";
    await mkdir(directory + "/inspect", { recursive: true });
    await page.screenshot({ path, fullPage: true });
    await writeFile(path.replace(".png", ".json"), JSON.stringify({
        source: source.sha256, state: await snapshot(), physicalDisplayQualified: false
    }, null, 2));
    images.push({
        host, corpus, stage, path, sha256: createHash("sha256").update(await readFile(path)).digest("hex")
    });
}
try {
    for (const host of ["plain", "react"])
        for (const corpus of ["unicode-crlf", "lines-100000", "single-line"])
            for (const position of ["beginning", "middle", "end"]) {
                /** @type {Sample[]} */ const samples = [];
                const line = "const sample = '😀 é';", count = corpus === "unicode-crlf" ? 60 : 100000, original = corpus === "single-line" ? "x".repeat(2400000) : Array(count).fill(line).join("\r\n"), row = position === "beginning" ? 0 : position === "middle" ? Math.floor(count / 2) : count - 1;
                const from = corpus === "single-line" ? 0 : row * (line.length + 2) + 6, to = corpus === "single-line" ? original.length : from + 6, offset = corpus === "single-line" ? position === "beginning" ? 8 : position === "middle" ? 1200000 : original.length - 8 : from + 2;
                for (let iteration = 0; iteration < warmup + measured; iteration++) {
                    activeCase = {
                        host, corpus, position, iteration, stage: "setup"
                    };
                    await dispose();
                    await scene.mount(host);
                    await page.evaluate(text => {
                        const f = window.hostFixture, s = f.snapshot();
                        f.editSource(s.source.revision, [{
                                from: 0, to: s.source.length, insert: text
                            }]);
                        f.selectSource("secondary", f.snapshot().source.revision, { anchor: 4, head: 1 });
                    }, original);
                    await click("Open source review");
                    await ready();
                    await click("Save source");
                    await page.waitForFunction(() => window.hostFixture.snapshot().pendingSaves.length === 1);
                    await page.evaluate(() => window.hostFixture.finishSave());
                    await page.waitForFunction(() => window.hostFixture.snapshot().pendingCommands === 0 && window.hostFixture.snapshot().source.serverVersion === "v1");
                    await click("Capture reference refresh");
                    await click("Finish reference refresh");
                    await ready();
                    await input().focus();
                    await page.evaluate(offset => {
                        const f = window.hostFixture;
                        f.selectSource("primary", f.snapshot().source.revision, { anchor: offset, head: offset });
                    }, offset);
                    await input().press("ArrowRight");
                    await input().press("ArrowLeft");
                    await ready();
                    await root().scrollIntoViewIfNeeded();
                    if (iteration === 0)
                        displays.push({
                            host, corpus, position, ...await root().evaluate(node => {
                                const s = getComputedStyle(node);
                                return {
                                    fontFamily: s.fontFamily, fontSize: s.fontSize, lineHeight: s.lineHeight, width: node.clientWidth, height: node.clientHeight, devicePixelRatio
                                };
                            })
                        });
                    const point = await root().evaluate((element, offset) => {
                        const row = [...element.querySelectorAll(".st-viewport-row")].find(r => Number(r.getAttribute("data-from")) <= offset && Number(r.getAttribute("data-to")) > offset);
                        if (!row)
                            throw new Error("Missing captured word row.");
                        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
                        /** @type {Text[]} */ const nodes = [];
                        let n;
                        while (n = walker.nextNode())
                            nodes.push(/** @type {Text} */ (n));
                        /** @param {number} at */
                        const locate = at => {
                            for (const node of nodes) {
                                if (at <= node.length)
                                    return { node, at };
                                at -= node.length;
                            }
                            throw new Error("Missing native word character.");
                        };
                        const a = locate(offset - Number(row.getAttribute("data-from"))), b = locate(offset - Number(row.getAttribute("data-from")) + 1), r = document.createRange();
                        r.setStart(a.node, a.at);
                        r.setEnd(b.node, b.at);
                        const box = r.getBoundingClientRect();
                        return { x: box.left + box.width * .25, y: box.top + box.height * .5 };
                    }, offset);
                    const before = await snapshot();
                    assert.equal(before.source.exports, 1);
                    assert.equal(before.source.dirty, false);
                    await root().evaluate((element, { from, to }) => {
                        const f = window.hostFixture, before = f.snapshot(), prior = before.bindings.views.find(v => v.id === "primary"), listeners = new AbortController();
                        const priorMetrics = prior?.metrics, secondaryBefore = before.bindings.views.find(v => v.id === "secondary"), reviewBefore = before.bindings.comparison;
                        if (!prior || !priorMetrics || !secondaryBefore || !reviewBefore)
                            throw new Error("Word selection requires its captured candidate views.");
                        /** @type {Promise<WordObservation>} */ const promise = new Promise((accept, reject) => {
                            element.addEventListener("dblclick", event => {
                                const started = performance.now();
                                (async () => {
                                    await window.hostReferenceProbe.waitReady();
                                    const s = f.snapshot(), p = s.bindings.views.find(v => v.id === "primary"), c = s.bindings.comparison, secondary = s.bindings.views.find(v => v.id === "secondary");
                                    /** @param {unknown} a @param {unknown} b */
                                    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
                                    if (!p?.metrics || !c?.baseline || !secondary)
                                        throw new Error("Word selection requires its current candidate views.");
                                    if (!(event instanceof MouseEvent) || !event.isTrusted || event.detail !== 2 || s.source.id !== before.source.id || s.source.revision !== before.source.revision || p.viewId !== prior.viewId || p.selection.anchor !== from || p.selection.head !== to || p.metrics.wordSelectionEvents !== priorMetrics.wordSelectionEvents + 1 || !same(s.history, before.history) || s.source.exports !== before.source.exports || !same(secondary.selection, secondaryBefore.selection) || !same(c.selection, reviewBefore.selection) || c.baseline.version !== "reference:saved-v1" || element.querySelector("textarea") !== document.activeElement)
                                        throw new Error("Incorrect captured word-selection result.");
                                    if (!s.bindings.views.every(v => v.metrics && v.metrics.viewport.rows < 100 && v.metrics.viewport.readUnits < 20000 && v.metrics.inputUnits <= 2600) || c.input.inputUnits > 2600)
                                        throw new Error("Unbounded word-selection context/view.");
                                    accept({
                                        commandToReviewReadyProxyMs: performance.now() - started, handlerMs: p.metrics.lastWordSelectionMs, callbackMaximumMs: p.metrics.maxWordSelectionTurnMs, wordScanSteps: p.metrics.wordScanSteps, maxWordScanStepMs: p.metrics.maxWordScanStepMs, graphemeScanSteps: p.metrics.graphemeScanSteps, maxGraphemeScanStepMs: p.metrics.maxGraphemeScanStepMs, selection: p.selection, referenceVersion: c.baseline.version, exports: s.source.exports, backgroundUpdates: s.activity.background - before.activity.background
                                    });
                                })().catch(reject).finally(() => listeners.abort());
                            }, {
                                capture: true, once: true, signal: listeners.signal
                            });
                        });
                        promise.catch(() => {
                        }); /** @type {MeasurementGlobal} */
                        (globalThis).wordSelectionProbe = { promise };
                    }, { from, to });
                    activeCase.stage = "selection";
                    const workflowStart = performance.now();
                    await page.mouse.dblclick(point.x, point.y);
                    const selectionObservation = await page.evaluate(() => /** @type {MeasurementGlobal} */ (globalThis).wordSelectionProbe.promise), completeCommandActionProxyMs = performance.now() - workflowStart;
                    const selected = Object.assign(selectionObservation, { completeCommandActionProxyMs });
                    assert.equal(await exact(original), true);
                    assert.ok(selected.wordScanSteps > 0);
                    if (corpus === "single-line")
                        assert.ok(selected.wordScanSteps > 2);
                    const visible = inspect && iteration === 0 && (corpus === "unicode-crlf" && position === "beginning" || corpus === "single-line" && position === "middle");
                    if (visible)
                        await picture(host, corpus, "selected");
                    activeCase.stage = "typing";
                    await page.evaluate(() => window.hostReferenceProbe.arm({
                        kind: "input", text: "q", replaceSelection: true
                    }));
                    const pointStart = performance.now();
                    await page.keyboard.type("q");
                    const inputObservation = await page.evaluate(() => window.hostReferenceProbe.read());
                    const completeActionProxyMs = performance.now() - pointStart, workflowActionProxyMs = performance.now() - workflowStart, pointResult = Object.assign(inputObservation, { completeActionProxyMs });
                    const expected = original.slice(0, from) + "q" + original.slice(to), after = await snapshot();
                    assert.equal(await exact(expected), true);
                    assert.deepEqual(pointResult.replacement, { from, to });
                    assert.equal(pointResult.primarySelection.head, from + 1);
                    assert.equal(pointResult.primarySelection.anchor, from + 1);
                    assert.equal(after.history.undoDepth, before.history.undoDepth + 1);
                    assert.equal(after.source.exports, 0);
                    assert.equal(after.source.serverVersion, "v1");
                    assert.equal(pointResult.referenceVersion, "reference:saved-v1");
                    assert.equal(await scene.exactText(original, "reference"), true);
                    assert.ok(after.activity.background > before.activity.background);
                    if (visible)
                        await picture(host, corpus, "typed");
                    activeCase.stage = "history";
                    await input().press("Control+z");
                    await ready();
                    assert.equal(await exact(original), true);
                    assert.equal((await snapshot()).source.dirty, false);
                    await input().press("Control+Shift+z");
                    await ready();
                    assert.equal(await exact(expected), true);
                    assert.equal((await snapshot()).source.dirty, true);
                    if (iteration >= warmup)
                        samples.push({
                            iteration, selected, point: pointResult, workflowActionProxyMs, setupSaveExports: before.source.exports, selectionExportDelta: selected.exports - before.source.exports, backgroundUpdates: after.activity.background - before.activity.background
                        });
                    await dispose();
                }
                const summary = {
                    host, editor: "candidate", corpus, position, length: original.length, expectedSelection: { anchor: from, head: to }, warmup, measured, samples,
                    commandHandlerMs: distribution(samples.map(s => s.selected.handlerMs)), commandToReviewReadyProxyMs: distribution(samples.map(s => s.selected.commandToReviewReadyProxyMs)),
                    completeCommandActionProxyMs: distribution(samples.map(s => s.selected.completeCommandActionProxyMs)), wordSelectionTurnMaximumMs: distribution(samples.map(s => s.selected.callbackMaximumMs)),
                    wordScanMaximumMs: distribution(samples.map(s => s.selected.maxWordScanStepMs)),
                    inputHandlerMs: distribution(samples.map(s => {
                        const ms = s.point.records[0]?.inputHandlerMs;
                        assert.ok(ms !== undefined && ms !== null, "Word replacement requires its input-handler clock.");
                        return ms;
                    })),
                    pointInputToReviewReadyProxyMs: distribution(samples.map(s => {
                        const ms = s.point.lastInputToFullReviewReadyProxyMs;
                        assert.ok(ms !== null, "Word replacement requires its readiness clock.");
                        return ms;
                    })),
                    completePointActionProxyMs: distribution(samples.map(s => s.point.completeActionProxyMs)), workflowActionProxyMs: distribution(samples.map(s => s.workflowActionProxyMs))
                };
                const large = corpus !== "unicode-crlf", targets = {
                    handlerMs: 16, readyMs: large ? 250 : 100, actionMs: large ? 500 : 200
                };
                const item = {
                    ...summary, targets, assessment: {
                        commandHandlerMet: summary.commandHandlerMs.p95 <= 16, commandTurnMet: summary.wordSelectionTurnMaximumMs.p95 <= 16,
                        commandReadyMet: summary.commandToReviewReadyProxyMs.p95 <= targets.readyMs, commandActionMet: summary.completeCommandActionProxyMs.p95 <= targets.actionMs,
                        inputHandlerMet: summary.inputHandlerMs.p95 <= 16, inputReadyMet: summary.pointInputToReviewReadyProxyMs.p95 <= targets.readyMs, inputActionMet: summary.completePointActionProxyMs.p95 <= targets.actionMs
                    }
                };
                cases.push(item);
                console.log(JSON.stringify({
                    host, corpus, position, measured, commandReadyP95: item.commandToReviewReadyProxyMs.p95, handlerP95: item.commandHandlerMs.p95, selectionTurnMaximumP95: item.wordSelectionTurnMaximumMs.p95, scanLoopMaximumP95: item.wordScanMaximumMs.p95, pointReadyP95: item.pointInputToReviewReadyProxyMs.p95, workflowP95: item.workflowActionProxyMs.p95, assessment: item.assessment
                }));
            }
    assert.equal(cases.length, 18);
    assert.deepEqual(h.errors, []);
    assert.equal((await sourceIdentity()).sha256, source.sha256);
    await mkdir(directory, { recursive: true });
    await writeFile(directory + "/" + (smoke ? "smoke" : "latest") + ".json", JSON.stringify({
        schemaVersion: 1, source, smoke, inspect, created: new Date().toISOString(), environment: {
            ...environment(), browser: h.browser.version(), buildMode: h.buildMode, displays
        }, cases, images, errors: h.errors,
        boundaries: "Both candidate hosts,normalUnicodeCRLF/100k and2.4MASCII word,beginning/middle/end. Initialsave/reference/setup excluded. Actualtrusted dblclick capture starts selection clock;current exact lexical range/model/history/independentselections/context/viewport/reference/allpanes/scans/caret/drag+2frames readiness. Command synchronous handler includes first cooperative turns/subscribers;later turns separate. Per-workflow complete selection handler/word+grapheme continuation callback maximum includes guards/transitions/projection/subscribers/scheduling and is separate from narrower scan-loop maxima;neither is per-callbackp95/processCPU. Complete command action includes two-click automation/transport;workflow alsoincludes q arming/verification/control transport. q handler/beforeinput/full-review and completepointaction clocks separate. Explicit setupsave1export,selection0extraexports,ordinaryqbuffer0exports;undo-to-saved/redo/background/disposal asserted. Screenshots only in separate smoke inspection,never full timing. No nativeIME/OSclipboard/contextual longline orphysicaldisplay qualification."
    }, null, 2));
}
catch (error) {
    await mkdir(directory, { recursive: true });
    await writeFile(directory + "/failure-" + Date.now() + ".json", JSON.stringify({
        source, smoke, inspect, activeCase, error: String(error), stack: error instanceof Error ? error.stack : undefined, completed: cases, state: scene.mounted ? await snapshot().catch(() => null) : null, errors: h.errors
    }, null, 2));
    throw error;
}
finally {
    await dispose().catch(() => {
    });
    await h.close();
}
