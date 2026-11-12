import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import { distribution, environment } from "./measurement.mjs";

// Appended to the copied development host only. Public editor/workspace handles supply
// observations and deterministic selection setup; measured edits still use actual keyboard input.
export const demoMeasurementHook = `
Object.assign(globalThis, { sttropezDemoMeasurement: Object.freeze({
    snapshot() {
        if (!project || !active || !editor) return null;
        const doc = project.workspace.document(active.resource.documentId), language = project.language.state.getSnapshot();
        const review = comparison?.controller.getSnapshot();
        return { sample: project.sample.id, name: active.name, revision: doc.revision, length: doc.buffer.length, lines: doc.buffer.lineCount,
            selection: active.view.getSnapshot().selection, editor: editor.snapshot(), viewport: editor.viewport.snapshot(),
            reference: comparison?.referenceViewport()?.snapshot(), review: review && { status: review.status, hunks: review.hunks.length },
            comparison: comparison?.snapshot(), output: { status: presentation.status, units: presentation.javascript.length },
            language: { status: language.status, checking: language.checking, diagnostics: language.diagnostics.length },
            saving: project.saving, dirty: project.dirty(), message: project.message };
    },
    place(position) {
        if (!project || !active || !editor || comparison) throw new Error("Expected an ordinary source view.");
        const doc = project.workspace.document(active.resource.documentId);
        const offset = position === "start" ? 0 : position === "middle" ? Math.floor(doc.buffer.length / 2) : doc.buffer.length;
        active.view.setSelection(doc.revision, { anchor: offset, head: offset }); editor.viewport.revealOffset(offset); editor.focus();
    },
    range(from, to) {
        if (to - from > 256) throw new Error("Measurement reads must stay bounded.");
        return project.workspace.document(active.resource.documentId).buffer.slice(from, to);
    }
}) });
`;

const snapshot = page => page.evaluate(() => globalThis.sttropezDemoMeasurement.snapshot());
async function ready(page) {
    await page.evaluate(() => new Promise((resolve, reject) => {
        let frames = 0; const timer = setTimeout(() => reject(new Error("Demo editor did not settle within 5s.")), 5000);
        function check() {
            const s = globalThis.sttropezDemoMeasurement.snapshot();
            if (s && s.viewport.revision === s.revision && !s.viewport.pending && !s.editor.pendingCaret && !s.editor.pendingCommand
                && !s.editor.pendingInput && s.viewport.selection?.head === s.selection.head && s.viewport.selection?.anchor === s.selection.anchor
                && (!s.reference || !s.reference.pending)) frames++; else frames = 0;
            if (frames < 2) { requestAnimationFrame(check); return; } clearTimeout(timer); resolve();
        } requestAnimationFrame(check);
    }));
}
function bounded(s) {
    assert.ok(s.editor.inputUnits <= 2600); assert.equal(s.editor.conflicts, 0);
    for (const view of [s.viewport, s.reference].filter(Boolean)) {
        assert.ok(view.rows <= Math.ceil(view.height / view.lineHeight) + 10);
        assert.ok(view.readUnits <= view.rows * (Math.max(512, Math.ceil(view.width / view.columnWidth)) + 80));
    }
}

async function input(page, feedback = false) {
    await page.evaluate(feedback => {
        const hook = globalThis.sttropezDemoMeasurement, before = hook.snapshot(), input = document.querySelector("#editor textarea.st-input-context");
        const work = {}; globalThis.demoInputMeasurement = work;
        work.frame = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Integrated typing did not settle within 5s.")), 5000); let start, frames = 0;
            input.addEventListener("beforeinput", () => { start = performance.now(); }, { capture: true, once: true });
            input.addEventListener("input", () => {
                const revision = before.revision + 1, expected = before.selection.head + 1;
                if (feedback) work.feedback = new Promise((resolve, reject) => {
                    const limit = setTimeout(() => reject(new Error("Integrated language feedback did not settle within 30s.")), 30000);
                    let compilerReadyProxyMs, providerConnectedProxyMs, providerDiagnosticsReadyProxyMs;
                    function checkFeedback() {
                        const s = hook.snapshot();
                        if (s.output.status === "ready") compilerReadyProxyMs ??= performance.now() - start;
                        if (s.language.status === "ready") providerConnectedProxyMs ??= performance.now() - start;
                        if (s.language.status === "ready" && !s.language.checking) providerDiagnosticsReadyProxyMs ??= performance.now() - start;
                        if (s.revision === revision && s.output.status === "ready" && s.language.status === "ready" && !s.language.checking) {
                            clearTimeout(limit); resolve({ beforeInputToFeedbackProxyMs: performance.now() - start,
                                compilerReadyProxyMs, providerConnectedProxyMs, providerDiagnosticsReadyProxyMs, outputUnits: s.output.units });
                        } else requestAnimationFrame(checkFeedback);
                    } requestAnimationFrame(checkFeedback);
                });
                function check() {
                    const s = hook.snapshot();
                    if (s.viewport.revision !== revision || s.viewport.pending || s.editor.pendingInput || s.editor.pendingCaret || s.editor.pendingCommand) {
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
    const at = performance.now(); await page.keyboard.type(" ");
    const sample = await page.evaluate(() => globalThis.demoInputMeasurement.frame); sample.completeActionProxyMs = performance.now() - at;
    assert.equal(sample.inputEvents, 1); assert.equal(sample.commits, 1); bounded(sample.state);
    if (feedback) sample.feedback = await page.evaluate(() => globalThis.demoInputMeasurement.feedback);
    return sample;
}

/** Bounded integrated campaign, with semantic checks; no retries or physical-latency claim. */
export async function measureDemo(browser, url, identity) {
    const cases = [], errors = [];
    const started = new Date().toISOString();
    const report = { schemaVersion: 1, created: started, ...identity, environment: { ...environment(), browser: browser.version(), viewport: { width: 1440, height: 900 } },
        hookSha256: createHash("sha256").update(demoMeasurementHook).digest("hex"), cases, errors,
        note: "Actual keyboard edits in the restored-package demo. A test-only host hook observes public snapshots and sets up selections. Handler spans exclude other capture listeners, native work and later rendering/services; they are not complete interaction or process CPU time. Frame readiness requires exact text/revision/selection and two matching animation frames, not physical presentation. Automation proxies include IPC, polling and settlement. Compiler, provider connection and current diagnostics are separate feedback observations from beforeinput. Eight warm samples per position and shared Windows load do not establish stable tails. CDP heap describes only the main target, without forced GC; worker/provider heaps and total resident memory are unmeasured. Completed samples and partial workflows are retained on failure without retries. No native IME, OS clipboard or physical display qualification follows." };
    try {
    for (const corpus of ["pricing", "large"]) {
        const activeCase = { corpus, phase: "startup" }; cases.push(activeCase);
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await context.newPage();
        const workers = []; page.on("worker", worker => workers.push(new URL(worker.url()).pathname)); page.on("pageerror", error => errors.push(error.message));
        page.on("dialog", dialog => dialog.accept());
        const session = await context.newCDPSession(page); let heap;
        try {
            const launch = performance.now(); await page.goto(url); await page.waitForFunction(() => !!globalThis.sttropezDemoMeasurement?.snapshot());
            let sampleAt = launch;
            if (corpus === "large") { sampleAt = performance.now(); await page.locator("#sample").selectOption("large");
                await page.waitForFunction(() => globalThis.sttropezDemoMeasurement.snapshot()?.sample === "large"); }
            await ready(page); const firstEditorProxyMs = performance.now() - sampleAt, initial = await snapshot(page);
            if (corpus === "large") assert.equal(initial.lines, 100000);
            await page.evaluate(() => globalThis.sttropezDemoMeasurement.place("start")); await ready(page);
            const firstEdit = await input(page, true), firstFeedbackState = await snapshot(page);
            heap = { afterFirstFeedback: await session.send("Runtime.getHeapUsage") };
            const typing = [];
            Object.assign(activeCase, { phase: "typing", initial: { length: initial.length, lines: initial.lines, language: initial.language, output: initial.output },
                firstEditorProxyMs, firstEdit, firstFeedbackState, mainTargetHeap: heap, typing, workers });
            for (const position of ["start", "middle", "end"]) {
                await page.evaluate(position => globalThis.sttropezDemoMeasurement.place(position), position); await ready(page);
                const afterFeedback = await input(page), samples = [];
                const record = { position, afterFeedback, samples }; typing.push(record);
                for (let i = 0; i < 8; i++) samples.push(await input(page, i === 7));
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
                return h.range(Math.max(0, s.length - 32), s.length).includes("Math.max"); }, undefined, { timeout: 5000 });
            await ready(page); const completionAppliedProxyMs = performance.now() - completionAt;
            activeCase.completionAppliedProxyMs = completionAppliedProxyMs;
            await page.keyboard.type("(1, 2);"); await ready(page);
            const navigation = []; Object.assign(activeCase, { phase: "navigation", navigation });
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
            const compareReadyProxyMs = performance.now() - compareAt, review = await snapshot(page); bounded(review); assert.ok(review.review.hunks > 0);
            Object.assign(activeCase, { phase: "save", compareReadyProxyMs, review });
            const saveAt = performance.now(); await page.getByRole("textbox", { name: "Comparison working source", exact: true }).press("Control+s");
            await expect(page.locator("#status")).toContainText("Saved in this browser"); const saveAckProxyMs = performance.now() - saveAt;
            await expect(page.locator(".st-comparison-controls output")).toHaveText("No changes"); await ready(page);
            const saveAndReviewProxyMs = performance.now() - saveAt, saved = await snapshot(page); assert.equal(saved.dirty, false); bounded(saved);
            heap.afterSaveAndReview = await session.send("Runtime.getHeapUsage");
            Object.assign(activeCase, { phase: "complete", saveAckProxyMs, saveAndReviewProxyMs,
                resources: await page.evaluate(() => performance.getEntriesByType("resource").map(e => ({ name: new URL(e.name).pathname, duration: e.duration, encodedBodySize: e.encodedBodySize }))) });
            console.log(JSON.stringify({ corpus, firstEditorProxyMs, firstEditFrameMs: firstEdit.beforeInputToFrameProxyMs, feedbackMs: firstEdit.feedback.beforeInputToFeedbackProxyMs,
                typing: typing.map(t => ({ position: t.position, handlerP95: t.inputHandlerMs.p95, frameP95: t.beforeInputToFrameProxyMs.p95, automationP95: t.completeActionProxyMs.p95 })),
                completionVisibleProxyMs, completionAppliedProxyMs, compareReadyProxyMs, saveAckProxyMs, saveAndReviewProxyMs }));
        } finally { await session.detach(); await context.close(); }
    }
    assert.deepEqual(errors, []);
    await mkdir("artifacts/bench/demo", { recursive: true }); await writeFile("artifacts/bench/demo/latest.json", JSON.stringify({ ...report, status: "complete" }, null, 2) + "\n");
    return { report: "artifacts/bench/demo/latest.json", cases: cases.length, errors };
    } catch (error) {
        await mkdir("artifacts/bench/demo", { recursive: true });
        await writeFile(`artifacts/bench/demo/failure-${started.replaceAll(/[:.]/g, "-")}.json`, JSON.stringify({ ...report, status: "failed", error: String(error), stack: error.stack }, null, 2) + "\n");
        throw error;
    }
}
