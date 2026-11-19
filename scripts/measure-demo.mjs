import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import { distribution, environment } from "./measurement.mjs";

// Appended to the copied development host only. Public editor/workspace handles supply
// observations and deterministic selection setup; measured edits still use actual keyboard input.
export const demoMeasurementHook = `
const sttropezDemoMeasurement = Object.freeze({
    snapshot() {
        if (!project || !active || !editor) return null;
        const doc = project.workspace.document(active.resource.documentId), language = project.language.state.getSnapshot();
        const review = comparison?.controller.getSnapshot();
        return { sample: project.sample.id, name: active.name, revision: doc.revision, length: doc.buffer.length, lines: doc.buffer.lineCount,
            selection: active.view.getSnapshot().selection, editor: editor.snapshot(), viewport: editor.viewport.snapshot(),
            reference: comparison?.referenceViewport()?.snapshot(), review: review && { status: review.status, hunks: review.hunks.length },
            comparison: comparison?.snapshot(), output: { status: presentation.status, units: presentation.javascript.length,
                viewport: output?.snapshot(), domUnits: document.querySelector(".demo-output")?.textContent?.length ?? 0 },
            presentation: { styledRows: editor.element.querySelectorAll(".st-viewport-row:has([class*=demo-token-])").length },
            language: { status: language.status, checking: language.checking, diagnostics: language.diagnostics.length },
            saving: project.saving, dirty: project.dirty(), message: project.message };
    },
    place(position: "start" | "middle" | "end") {
        if (!project || !active || !editor || comparison) throw new Error("Expected an ordinary source view.");
        const doc = project.workspace.document(active.resource.documentId);
        const offset = position === "start" ? 0 : position === "middle" ? Math.floor(doc.buffer.length / 2) : doc.buffer.length;
        active.view.setSelection(doc.revision, { anchor: offset, head: offset }); editor.viewport.revealOffset(offset); editor.focus();
    },
    range(from: number, to: number) {
        if (to - from > 256) throw new Error("Measurement reads must stay bounded.");
        if (!project || !active) throw new Error("Expected an active source document.");
        return project.workspace.document(active.resource.documentId).buffer.slice(from, to);
    }
});
Object.assign(globalThis, { sttropezDemoMeasurement });
export type DemoMeasurementHook = typeof sttropezDemoMeasurement;
`;

/** @typedef {NonNullable<ReturnType<typeof globalThis.sttropezDemoMeasurement.snapshot>>} DemoState */
/** @typedef {{beforeInputToFrameProxyMs: number, inputHandlerMs: number, beforeInputHandlerMs: number, inputEvents: number, commits: number, state: DemoState}} InputFrame */
/** @typedef {{beforeInputToFeedbackProxyMs: number, compilerReadyProxyMs: number | undefined, outputViewportReadyProxyMs: number, providerConnectedProxyMs: number | undefined, providerDiagnosticsReadyProxyMs: number | undefined, outputUnits: number}} Feedback */
/** @typedef {{frame?: Promise<InputFrame>, feedback?: Promise<Feedback>}} InputWork */
/** @typedef {{supported: readonly string[], events: {name: string, interactionId: number, durationMs: number, inputDelayMs: number, processingMs: number, presentationProxyMs: number}[], longTasks: {at: number, durationMs: number}[], frameGaps: {count: number, over50Ms: number, maximumMs: number}}} HostPerformance */
/** @typedef {{observation: {beforeInputAt: number | undefined, events: number, peakNativeUnits: number}, finish: () => void}} BulkObservation */
/** @typedef {{units: number, completeActionProxyMs: number, beforeInputAt: number | undefined, events: number, peakNativeUnits: number, beforeInputToFrameProxyMs: number, beforeInputHandlerMs: number, nativeInputEvents: number, commits: number}} BulkInput */
/** @typedef {Awaited<ReturnType<typeof input>>} InputSample */
/** @typedef {{position: string, afterFeedback: InputSample, samples: InputSample[], inputHandlerMs?: ReturnType<typeof distribution>, beforeInputToFrameProxyMs?: ReturnType<typeof distribution>, completeActionProxyMs?: ReturnType<typeof distribution>}} TypingRecord */

/** @param {import("@playwright/test").Page} page */
const snapshot = async page => {
    const state = await page.evaluate(() => globalThis.sttropezDemoMeasurement.snapshot());
    assert.ok(state, "Expected an active demo editor."); return state;
};
// An in-page timer cannot bound a gesture that blocks that page's main thread.
/** @template T
 * @param {() => Promise<T>} run
 * @param {() => Promise<void>} abortBrowser
 */
async function localInteraction(run, abortBrowser) {
    /** @type {ReturnType<typeof setTimeout> | undefined} */ let timer;
    /** @type {Error | undefined} */ let expired;
    try {
        return await Promise.race([run(), /** @type {Promise<never>} */ (new Promise((_, reject) => {
            timer = setTimeout(() => {
                expired = new Error("Complete local interaction exceeded the existing 5s readiness deadline."); reject(expired);
                void abortBrowser(); // Only the campaign-owned headless browser, even if its renderer is blocked.
            }, 5000);
        }))]);
    } catch (error) { throw expired ?? error; }
    finally { clearTimeout(timer); }
}
/** @param {import("@playwright/test").Page} page */
async function ready(page) {
    await page.evaluate(() => /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
        let frames = 0; const timer = setTimeout(() => reject(new Error("Demo editor did not settle within 5s.")), 5000);
        function check() {
            const s = globalThis.sttropezDemoMeasurement.snapshot();
            if (s && s.viewport.revision === s.revision && !s.viewport.pending && !s.editor.pendingCaret && !s.editor.pendingCommand
                && !s.editor.pendingInput && s.viewport.selection?.head === s.selection.head && s.viewport.selection?.anchor === s.selection.anchor
                && (!s.reference || !s.reference.pending) && !s.output.viewport?.pending) frames++; else frames = 0;
            if (frames < 2) { requestAnimationFrame(check); return; } clearTimeout(timer); resolve();
        } requestAnimationFrame(check);
    })));
}
/** @param {DemoState} s */
function bounded(s) {
    assert.ok(s.editor.inputUnits <= 2600); assert.equal(s.editor.conflicts, 0);
    for (const view of [s.viewport, s.reference, s.output.viewport].filter(Boolean)) {
        assert.ok(view);
        assert.ok(view.rows <= Math.ceil(view.height / view.lineHeight) + 10);
        assert.ok(view.readUnits <= view.rows * (Math.max(512, Math.ceil(view.width / view.columnWidth)) + 80));
    }
    if (s.output.viewport) assert.ok(s.output.domUnits <= s.output.viewport.textUnits + 64, "Generated output DOM escaped the bounded viewport.");
}

/** @param {import("@playwright/test").Page} page
 * @param {() => Promise<void>} abortBrowser
 * @param {boolean} [feedback]
 */
async function input(page, abortBrowser, feedback = false) {
    await page.evaluate(feedback => {
        const hook = globalThis.sttropezDemoMeasurement, observed = hook.snapshot(), input = document.querySelector("#editor textarea.st-input-context");
        if (!observed || !input) throw new Error("Expected the demo source input.");
        const before = observed;
        /** @type {InputWork} */ const work = {}; globalThis.demoInputMeasurement = work;
        work.frame = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Integrated typing did not settle within 5s.")), 5000);
            /** @type {number} */ let start;
            let frames = 0;
            input.addEventListener("beforeinput", () => { start = performance.now(); }, { capture: true, once: true });
            input.addEventListener("input", () => {
                const revision = before.revision + 1, expected = before.selection.head + 1;
                if (feedback) work.feedback = new Promise((resolve, reject) => {
                    const limit = setTimeout(() => reject(new Error("Integrated language feedback did not settle within 30s.")), 30000);
                    /** @type {number | undefined} */ let compilerReadyProxyMs;
                    /** @type {number | undefined} */ let outputViewportReadyProxyMs;
                    /** @type {number | undefined} */ let providerConnectedProxyMs;
                    /** @type {number | undefined} */ let providerDiagnosticsReadyProxyMs;
                    function checkFeedback() {
                        const s = hook.snapshot();
                        if (!s) { clearTimeout(limit); reject(new Error("Demo editor detached during feedback.")); return; }
                        if (s.output.status === "ready") compilerReadyProxyMs ??= performance.now() - start;
                        if (s.output.status === "ready" && s.output.viewport && !s.output.viewport.pending) outputViewportReadyProxyMs ??= performance.now() - start;
                        if (s.language.status === "ready") providerConnectedProxyMs ??= performance.now() - start;
                        if (s.language.status === "ready" && !s.language.checking) providerDiagnosticsReadyProxyMs ??= performance.now() - start;
                        if (s.revision === revision && outputViewportReadyProxyMs !== undefined && s.language.status === "ready" && !s.language.checking) {
                            clearTimeout(limit); resolve({ beforeInputToFeedbackProxyMs: performance.now() - start,
                                compilerReadyProxyMs, outputViewportReadyProxyMs, providerConnectedProxyMs, providerDiagnosticsReadyProxyMs, outputUnits: s.output.units });
                        } else requestAnimationFrame(checkFeedback);
                    } requestAnimationFrame(checkFeedback);
                });
                function check() {
                    const s = hook.snapshot();
                    if (!s) { clearTimeout(timer); reject(new Error("Demo editor detached during typing.")); return; }
                    if (before.presentation.styledRows > 0 && s.viewport.revision === revision && s.presentation.styledRows === 0
                        || before.output.viewport && !s.output.viewport) {
                        clearTimeout(timer); reject(new Error("Editing blanked existing syntax colors or generated output while services were pending.")); return;
                    }
                    if (s.viewport.revision !== revision || s.viewport.pending || s.output.viewport?.pending || s.editor.pendingInput || s.editor.pendingCaret || s.editor.pendingCommand) {
                        frames = 0; requestAnimationFrame(check); return;
                    }
                    if (s.revision !== revision || s.length !== before.length + 1 || s.selection.anchor !== expected || s.selection.head !== expected
                        || s.viewport.selection?.anchor !== expected || s.viewport.selection?.head !== expected || hook.range(expected - 1, expected) !== " ") {
                        clearTimeout(timer); reject(new Error("Integrated typing changed the wrong text, revision or selection.")); return;
                    }
                    if (++frames < 2) { requestAnimationFrame(check); return; } clearTimeout(timer);
                    resolve({ beforeInputToFrameProxyMs: performance.now() - start, inputHandlerMs: s.editor.lastInputMs, beforeInputHandlerMs: s.editor.lastBeforeInputMs,
                        inputEvents: s.editor.inputEvents - before.editor.inputEvents, commits: s.editor.commits - before.editor.commits, state: s });
                } requestAnimationFrame(check);
            }, { capture: true, once: true });
        });
    }, feedback);
    const at = performance.now();
    const frame = await localInteraction(async () => { await page.keyboard.type(" "); return page.evaluate(() => globalThis.demoInputMeasurement.frame); }, abortBrowser);
    const completeActionProxyMs = performance.now() - at;
    assert.ok(frame, "Expected the input frame observation.");
    /** @type {InputFrame & {completeActionProxyMs: number, feedback?: Feedback}} */
    const sample = Object.assign(frame, { completeActionProxyMs });
    assert.equal(sample.inputEvents, 1); assert.equal(sample.commits, 1); bounded(sample.state);
    if (feedback) {
        const observation = await page.evaluate(() => globalThis.demoInputMeasurement.feedback);
        assert.ok(observation, "Expected language feedback."); sample.feedback = observation;
    }
    return sample;
}

/** Bounded integrated campaign, with semantic checks; no retries or physical-latency claim.
 * @param {import("@playwright/test").Browser} browser
 * @param {string} url
 * @param {{sourceSha256: string, packageSha256: string}} identity
 * @param {() => Promise<void>} abortBrowser
 */
export async function measureDemo(browser, url, identity, abortBrowser) {
    /** @type {{corpus: string, phase: string}[]} */ const cases = [];
    /** @type {string[]} */ const errors = [];
    const corpora = process.argv.find(arg => arg.startsWith("--corpora="))?.slice("--corpora=".length).split(",") ?? ["pricing", "semantic", "large"];
    assert.ok(corpora.length && corpora.every(name => ["pricing", "semantic", "large"].includes(name)), "Unknown demo measurement corpus.");
    const started = new Date().toISOString();
    const report = { schemaVersion: 2, created: started, ...identity, corpora, environment: { ...environment(), browser: browser.version(), viewport: { width: 1440, height: 900 } },
        hookSha256: createHash("sha256").update(demoMeasurementHook).digest("hex"), cases, errors,
        note: "Actual keyboard edits in the restored-package demo. A test-only host hook observes public snapshots and sets up selections. Handler spans exclude other capture listeners, native work and later rendering/services; they are not complete interaction or process CPU time. Local frame readiness requires exact text/revision/selection, retained existing presentation and two matching animation frames, not physical presentation or fresh compiler output. All mounted text panes have bounded DOM/read checks. Automation proxies include IPC, polling and settlement. Compiler, provider connection and current diagnostics are separate feedback observations from beforeinput. Whole-host Event Timing entries include input/processing/quantized presentation observations when reported at the 16ms threshold; they are not a complete distribution or a page INP score. Long tasks and animation-frame gaps cover the full host journey and include shared-machine scheduling. Eight warm samples per position do not establish stable tails. CDP heap describes only the main target, without forced GC; worker/provider heaps and total resident memory are unmeasured. Completed samples and partial workflows are retained on failure without retries. No native IME, OS clipboard or physical display qualification follows." };
    try {
    for (const corpus of corpora) {
        console.log(JSON.stringify({ corpus, phase: "startup" }));
        /** @type {{corpus: string, phase: string, bulkInput?: BulkInput, completionVisibleProxyMs?: number, completionAppliedProxyMs?: number}} */
        const activeCase = { corpus, phase: "startup" }; cases.push(activeCase);
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await context.newPage();
        await page.addInitScript(() => {
            /** @type {HostPerformance} */
            const observations = { supported: PerformanceObserver.supportedEntryTypes, events: [], longTasks: [], frameGaps: { count: 0, over50Ms: 0, maximumMs: 0 } };
            globalThis.demoHostPerformance = observations;
            const supported = PerformanceObserver.supportedEntryTypes;
            if (supported.includes("event")) new PerformanceObserver(list => {
                for (const entry of /** @type {PerformanceEventTiming[]} */ (list.getEntries())) if (entry.interactionId) observations.events.push({ name: entry.name, interactionId: entry.interactionId,
                    durationMs: entry.duration, inputDelayMs: entry.processingStart - entry.startTime,
                    processingMs: entry.processingEnd - entry.processingStart, presentationProxyMs: Math.max(0, entry.startTime + entry.duration - entry.processingEnd) });
            }).observe(/** @type {PerformanceObserverInit & {durationThreshold: number}} */ ({ type: "event", buffered: true, durationThreshold: 16 }));
            if (supported.includes("longtask")) new PerformanceObserver(list => observations.longTasks.push(...list.getEntries().map(entry => ({ at: entry.startTime, durationMs: entry.duration })))).observe({ type: "longtask", buffered: true });
            /** @type {number | undefined} */ let previous;
            /** @param {number} now */
            function frame(now) { if (previous !== undefined) { const gap = now - previous, state = observations.frameGaps;
                state.count++; state.maximumMs = Math.max(state.maximumMs, gap); if (gap > 50) state.over50Ms++; }
                previous = now; requestAnimationFrame(frame); }
            requestAnimationFrame(frame);
        });
        /** @type {string[]} */ const workers = [];
        page.on("worker", worker => workers.push(new URL(worker.url()).pathname)); page.on("pageerror", error => errors.push(error.message));
        page.on("dialog", dialog => dialog.accept());
        const session = await context.newCDPSession(page); let heap, phaseError;
        try {
            const launch = performance.now(); await page.goto(url); await page.waitForFunction(() => !!globalThis.sttropezDemoMeasurement?.snapshot());
            let sampleAt = launch;
            if (corpus === "large") { sampleAt = performance.now(); await page.locator("#sample").selectOption("large");
                await page.waitForFunction(() => globalThis.sttropezDemoMeasurement.snapshot()?.sample === "large"); }
            if (corpus === "semantic") {
                const source = page.getByRole("textbox", { name: "main.ts", exact: true }); await source.press("Control+a");
                const text = Array.from({ length: 2000 }, (_, i) => `/** Format item ${i}. */\nexport function item${i}(value: number): string {\n    const result = value + ${i};\n    return "Item ${i}: " + result;\n}\n`).join("");
                const before = await snapshot(page); activeCase.phase = "bulk-insertion";
                await source.evaluate(input => {
                    if (!(input instanceof HTMLTextAreaElement)) throw new Error("Expected the demo source input.");
                    const listeners = new AbortController();
                    /** @type {BulkObservation["observation"]} */ const observation = { beforeInputAt: undefined, events: 0, peakNativeUnits: input.value.length };
                    globalThis.demoBulkObservation = { observation, finish: () => listeners.abort() };
                    for (const type of ["beforeinput", "input"]) input.addEventListener(type, () => {
                        observation.beforeInputAt ??= performance.now(); observation.events++;
                        observation.peakNativeUnits = Math.max(observation.peakNativeUnits, input.value.length);
                    }, { capture: true, signal: listeners.signal });
                });
                sampleAt = performance.now(); await localInteraction(async () => { await page.keyboard.insertText(text); await ready(page); }, abortBrowser);
                const state = await snapshot(page), observations = await page.evaluate(() => {
                    const { observation, finish } = globalThis.demoBulkObservation; finish();
                    if (observation.beforeInputAt === undefined) throw new Error("Expected a native bulk input event.");
                    return { ...observation, beforeInputToFrameProxyMs: performance.now() - observation.beforeInputAt };
                });
                activeCase.bulkInput = { units: text.length, completeActionProxyMs: performance.now() - sampleAt,
                    ...observations, beforeInputHandlerMs: state.editor.lastBeforeInputMs,
                    nativeInputEvents: state.editor.inputEvents - before.editor.inputEvents, commits: state.editor.commits - before.editor.commits };
                assert.equal(state.length, text.length); assert.equal(state.revision, before.revision + 1);
                assert.equal(state.selection.anchor, text.length); assert.equal(state.selection.head, text.length);
                assert.equal(activeCase.bulkInput.commits, 1); assert.ok(observations.peakNativeUnits <= 2560); bounded(state);
            }
            await ready(page); const firstEditorProxyMs = performance.now() - sampleAt, initial = await snapshot(page);
            if (corpus === "large") assert.equal(initial.lines, 100000);
            await page.evaluate(() => globalThis.sttropezDemoMeasurement.place("start")); await ready(page);
            const firstEdit = await input(page, abortBrowser, true), firstFeedbackState = await snapshot(page);
            heap = { afterFirstFeedback: await session.send("Runtime.getHeapUsage") };
            /** @type {TypingRecord[]} */ const typing = [];
            Object.assign(activeCase, { phase: "typing", initial: { length: initial.length, lines: initial.lines, language: initial.language, output: initial.output },
                firstEditorProxyMs, firstEdit, firstFeedbackState, mainTargetHeap: heap, typing, workers });
            for (const position of /** @type {const} */ (["start", "middle", "end"])) {
                await page.evaluate(position => globalThis.sttropezDemoMeasurement.place(position), position); await ready(page);
                const afterFeedback = await input(page, abortBrowser);
                /** @type {InputSample[]} */ const samples = [];
                const record = { position, afterFeedback, samples }; typing.push(record);
                for (let i = 0; i < 8; i++) samples.push(await input(page, abortBrowser, i === 7));
                Object.assign(record, { inputHandlerMs: distribution(samples.map(s => s.inputHandlerMs)),
                    beforeInputToFrameProxyMs: distribution(samples.map(s => s.beforeInputToFrameProxyMs)), completeActionProxyMs: distribution(samples.map(s => s.completeActionProxyMs)) });
            }
            activeCase.phase = "completion";
            await page.evaluate(() => globalThis.sttropezDemoMeasurement.place("end")); await ready(page);
            await page.keyboard.type("\nMath.ma"); await page.keyboard.press("Escape");
            await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30000 });
            const completionAt = performance.now(); await page.keyboard.press("Control+Space");
            const maximum = page.getByRole("option", { name: "max", exact: true }); await expect(maximum).toBeVisible();
            const completionVisibleProxyMs = performance.now() - completionAt; await maximum.click();
            activeCase.completionVisibleProxyMs = completionVisibleProxyMs;
            await page.waitForFunction(() => { const h = globalThis.sttropezDemoMeasurement, s = h.snapshot();
                return s && h.range(Math.max(0, s.length - 32), s.length).includes("Math.max"); }, undefined, { timeout: 5000 });
            await ready(page); const completionAppliedProxyMs = performance.now() - completionAt;
            activeCase.completionAppliedProxyMs = completionAppliedProxyMs;
            await page.keyboard.type("(1, 2);"); await ready(page);
            /** @type {{key: string, completeActionProxyMs: number, state: DemoState}[]} */ const navigation = [];
            Object.assign(activeCase, { phase: "navigation", navigation });
            for (const key of ["Control+Home", "PageDown", "Control+End"]) {
                const at = performance.now(); await page.keyboard.press(key); await ready(page); const s = await snapshot(page);
                if (key === "Control+Home") assert.equal(s.selection.head, 0);
                if (key === "Control+End") assert.equal(s.selection.head, s.length);
                if (key === "PageDown") assert.ok(s.selection.head > 0);
                bounded(s); navigation.push({ key, completeActionProxyMs: performance.now() - at, state: s });
            }
            activeCase.phase = "comparison";
            const compareAt = performance.now(); await page.getByRole("button", { name: "Compare", exact: true }).click();
            await expect(page.locator(".st-comparison")).toHaveAttribute("data-status", "ready"); await ready(page);
            const compareReadyProxyMs = performance.now() - compareAt, review = await snapshot(page); bounded(review); assert.ok(review.review && review.review.hunks > 0);
            Object.assign(activeCase, { phase: "save", compareReadyProxyMs, review });
            const saveAt = performance.now(); await page.getByRole("textbox", { name: "Comparison working source", exact: true }).press("Control+s");
            await expect(page.locator("#status")).toContainText("Saved in this browser"); const saveAckProxyMs = performance.now() - saveAt;
            await expect(page.locator(".st-comparison-controls output")).toHaveText("No changes"); await ready(page);
            const saveAndReviewProxyMs = performance.now() - saveAt, saved = await snapshot(page); assert.equal(saved.dirty, false); bounded(saved);
            Object.assign(heap, { afterSaveAndReview: await session.send("Runtime.getHeapUsage") });
            Object.assign(activeCase, { phase: "complete", saveAckProxyMs, saveAndReviewProxyMs,
                wholeHost: await page.evaluate(() => globalThis.demoHostPerformance),
                resources: await page.evaluate(() => /** @type {PerformanceResourceTiming[]} */ (performance.getEntriesByType("resource")).map(e => ({ name: new URL(e.name).pathname, duration: e.duration, encodedBodySize: e.encodedBodySize }))) });
            assert.ok(firstEdit.feedback);
            console.log(JSON.stringify({ corpus, firstEditorProxyMs, bulkInput: activeCase.bulkInput, firstEditFrameMs: firstEdit.beforeInputToFrameProxyMs, feedbackMs: firstEdit.feedback.beforeInputToFeedbackProxyMs,
                typing: typing.map(t => { assert.ok(t.inputHandlerMs && t.beforeInputToFrameProxyMs && t.completeActionProxyMs);
                    return { position: t.position, handlerP95: t.inputHandlerMs.p95, frameP95: t.beforeInputToFrameProxyMs.p95, automationP95: t.completeActionProxyMs.p95 }; }),
                completionVisibleProxyMs, completionAppliedProxyMs, compareReadyProxyMs, saveAckProxyMs, saveAndReviewProxyMs }));
        } catch (error) { phaseError = error; throw error; }
        finally {
            let cleanupError;
            try { await session.detach(); } catch (error) { cleanupError = error; }
            try { await context.close(); } catch (error) { cleanupError ??= error; }
            if (!phaseError && cleanupError) throw cleanupError;
        }
    }
    assert.deepEqual(errors, []);
    await mkdir("artifacts/bench/demo", { recursive: true }); await writeFile("artifacts/bench/demo/latest.json", JSON.stringify({ ...report, status: "complete" }, null, 2) + "\n");
    return { report: "artifacts/bench/demo/latest.json", cases: cases.length, errors };
    } catch (error) {
        await mkdir("artifacts/bench/demo", { recursive: true });
        await writeFile(`artifacts/bench/demo/failure-${started.replaceAll(/[:.]/g, "-")}.json`, JSON.stringify({ ...report, status: "failed", error: String(error), stack: error instanceof Error ? error.stack : undefined }, null, 2) + "\n");
        throw error;
    }
}
