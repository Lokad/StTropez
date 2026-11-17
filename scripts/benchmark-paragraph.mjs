import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { BidiCursor, TextBuffer } from "../src/index.ts";
import { openHarness } from "./browser-harness.mjs";
import { distribution, environment, sourceIdentity } from "./measurement.mjs";

const source = await sourceIdentity(), kernel = [];
for (const [name, text] of [["million-ltr-tail", "a".repeat(1_000_000) + " אבג"], ["mixed", "abc אבג (12) \u2067العربية\u2069 👩‍💻 ".repeat(4000)],
    ["brackets", "a (אבג [12]) ".repeat(8000)], ["many-paragraphs", "abc אבג\r\n".repeat(12000)]]) {
    const buffer = TextBuffer.from(text), samples = []; let retained;
    globalThis.gc?.(); const heapBefore = process.memoryUsage().heapUsed;
    for (let trial = 0; trial < 23; trial++) {
        const reads = buffer.readMetrics().sliceUnits, cursor = new BidiCursor(buffer); assert.equal(buffer.readMetrics().sliceUnits, reads);
        const began = performance.now(), advanceMs = []; let step, previous = 0, maximumWork = 0;
        do {
            const start = performance.now(); step = cursor.next(4096); advanceMs.push(performance.now() - start);
            maximumWork = Math.max(maximumWork, step.workUnits - previous); previous = step.workUnits;
        } while (step.status === "running");
        const totalMs = performance.now() - began; assert.equal(step.status, "ready"); assert.ok(step.result); retained = step.result;
        assert.equal(step.scannedUnits, text.length); assert.equal(buffer.readMetrics().sliceUnits - reads, step.readUnits); assert.equal(buffer.readMetrics().textExports, 0); assert.ok(maximumWork <= 4352);
        for (let i = 0; i < retained.visualLength; i += Math.max(1, Math.floor(retained.visualLength / 17))) assert.equal(retained.indexOf(retained.offsetAt(i)), i);
        assert.equal(retained.levelAt(0), 0); assert.ok(Object.isFrozen(retained)); cursor.dispose(); assert.equal(retained.levelAt(0), 0);
        if (trial >= 3) samples.push({ totalMs, advanceMs, advances: advanceMs.length, maximumWork, workUnits: step.workUnits, readUnits: step.readUnits });
    }
    globalThis.gc?.(); const heapAfter = process.memoryUsage().heapUsed;
    kernel.push({ name, units: text.length, warmup: 3, measured: samples.length, visualLength: retained.visualLength, paragraphCount: retained.paragraphCount,
        totalMs: distribution(samples.map(s => s.totalMs)), advanceMs: distribution(samples.flatMap(s => s.advanceMs)), heap: { exposedGc: typeof globalThis.gc === "function", before: heapBefore, after: heapAfter, delta: heapAfter - heapBefore }, samples });
}
const harness = await openHarness();
try {
    await harness.page.goto("/editing/");
    const ready = () => harness.page.waitForFunction(() => { const s = window.editingFixture?.snapshot(); return s && !s.primary.viewport.pending && !s.secondary.viewport.pending && s.primary.viewport.revision === s.document?.revision; });
    await ready(); const cases = [];
    for (const name of ["million-ltr-tail", "mixed"]) {
        const samples = [];
        for (let trial = 0; trial < 13; trial++) {
            await harness.page.evaluate(name => { window.editingFixture.setText(name === "million-ltr-tail" ? "a".repeat(1_000_000) + " אבג" : "abc אבג (12) \u2067العربية\u2069 👩‍💻 ".repeat(4000)); }, name); await ready();
            await harness.page.evaluate(() => {
                const before = window.editingFixture.snapshot();
                globalThis.paragraphMeasurement = new Promise((resolve, reject) => {
                    const start = performance.now(); let frames = 0, runningFrames = 0;
                    const timeout = setTimeout(() => reject(new Error("Paragraph measurement timed out.")), 30000);
                    if (!window.editingFixture.analyzeParagraph(0, before.document.length, before.document.revision)) throw new Error("Paragraph request was rejected.");
                    const check = () => {
                        frames++; const s = window.editingFixture.snapshot();
                        if (s.paragraph.status === "running") { runningFrames++; requestAnimationFrame(check); return; }
                        clearTimeout(timeout); if (s.paragraph.status !== "ready") { reject(new Error(`Paragraph ended ${s.paragraph.status}.`)); return; }
                        resolve({ readyProxyMs: performance.now() - start, frames, runningFrames, paragraph: s.paragraph, document: s.document,
                            revisionDelta: s.document.revision - before.document.revision, primary: s.primary, secondary: s.secondary,
                            level: window.editingFixture.paragraphLevel(before.document.length > 500000 ? 1_000_001 : 4) });
                    }; requestAnimationFrame(check);
                });
            });
            const sample = await harness.page.evaluate(() => globalThis.paragraphMeasurement);
            assert.equal(sample.revisionDelta, 0); assert.equal(sample.document.exports, 0); assert.equal(sample.level, 1); assert.ok(sample.runningFrames > 0);
            assert.equal(sample.paragraph.progress.scannedUnits, sample.document.length); assert.deepEqual(sample.paragraph.range, { from: 0, to: sample.document.length }); assert.equal(sample.paragraph.pending, false);
            assert.ok(sample.paragraph.turns > 1); assert.ok(sample.primary.inputUnits <= 2600); assert.equal(await harness.page.locator("textarea.st-textarea-baseline").count(), 0);
            for (const view of [sample.primary, sample.secondary]) assert.ok(view.viewport.textUnits <= view.viewport.rows * (Math.max(512, Math.ceil(view.viewport.width / view.viewport.columnWidth)) + 80));
            if (trial >= 3) samples.push(sample);
        }
        cases.push({ name, warmup: 3, measured: samples.length, readyProxyMs: distribution(samples.map(s => s.readyProxyMs)), maximumTurnMs: distribution(samples.map(s => s.paragraph.maxStepMs)), samples });
    }
    assert.deepEqual(harness.errors, []); assert.equal((await sourceIdentity()).sha256, source.sha256);
    await mkdir("artifacts/bench/paragraph", { recursive: true }); await writeFile("artifacts/bench/paragraph/latest.json", JSON.stringify({ schemaVersion: 1, created: new Date().toISOString(), source,
        environment: { ...environment(), browser: harness.browser.version(), buildMode: harness.buildMode }, kernel, cases, errors: harness.errors,
        note: "Full captured-range bidi indexing over immutable buffers. Every data-sized pass and publication expansion uses work checkpoints; no full metadata-array materialization is requested. Reported advance/turn maxima can include allocation and GC overshoot; work budgets are not hard realtime limits. Heap delta is a post-GC process observation retaining the final index and raw samples, not an isolated byte count or production retention budget. Browser readiness includes timers, animation frames and polling; frames run while analysis is pending. Reads cover the full requested range in bounded slices. Source text and bounded editor DOM remain unchanged. Exact global font shaping/window origins and native-device input remain unqualified." }, null, 2));
    console.log(JSON.stringify({ kernel: kernel.map(c => ({ name: c.name, p95: c.totalMs.p95, advanceP95: c.advanceMs.p95, maxAdvance: Math.max(...c.advanceMs.samples) })),
        browser: cases.map(c => ({ name: c.name, readyProxyP95: c.readyProxyMs.p95, maximumTurnP95: c.maximumTurnMs.p95 })) }, null, 2));
} finally { await harness.close(); }
