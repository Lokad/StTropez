import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { resolveBidi } from "../src/index.ts";
import { openHarness } from "./browser-harness.mjs";
import { distribution, environment, sourceIdentity } from "./measurement.mjs";

/** @typedef {ReturnType<Window["editingFixture"]["snapshot"]>} EditorState */
/** @typedef {{handlerMs: number, keyToFrameReadyProxyMs: number, visualMoves: number, revisionDelta: number,
 * document: NonNullable<EditorState["document"]>, inputUnits: number, partialRows: number,
 * selection: EditorState["primary"]["selection"], deltaX: number}} BidiObservation */
/** @typedef {typeof globalThis & {bidiMeasurement: Promise<BidiObservation>}} MeasurementGlobal */

const source = await sourceIdentity(), kernel = [];
for (const [name, text] of /** @type {const} */ ([["ltr-512", "alpha_beta 123 ".repeat(40).slice(0, 512)], ["mixed-512", "abc אבג (12) \u2067العربية\u2069 👩‍💻 ".repeat(20).slice(0, 512)],
    ["depth-overflow", "\u2067".repeat(160) + "אבג 123" + "\u2069".repeat(160)], ["long-paragraph", "abc אבג (12) \u2067العربية\u2069 ".repeat(5000)]])) {
    const samples = []; let resolved;
    for (let trial = 0; trial < 23; trial++) {
        const start = performance.now(); resolved = resolveBidi(text); const totalMs = performance.now() - start;
        assert.equal(resolved.levels.length, text.length); assert.ok(resolved.levels.every(level => level === null || level >= 0 && level <= 126));
        const starts = []; let offset = 0; for (const char of text) { if (resolved.levels[offset] !== null) starts.push(offset); offset += char.length; }
        assert.deepEqual([...resolved.order].sort((a, b) => a - b), starts); assert.equal(resolved.paragraphs.length, 1);
        if (trial >= 3) samples.push(totalMs);
    }
    assert.ok(resolved, "Bidi summary requires a completed resolution.");
    kernel.push({ name, units: text.length, warmup: 3, measured: samples.length, orderCount: resolved.order.length, totalMs: distribution(samples) });
}
const harness = await openHarness();
try {
    await harness.page.goto("/editing/");
    const ready = () => harness.page.waitForFunction(() => { const s = window.editingFixture?.snapshot(); return s && !s.primary.viewport.pending && s.primary.viewport.revision === s.document?.revision; });
    await ready(); const cases = [];
    for (const config of [{ name: "ltr", text: "alpha_beta 123 gamma", direction: "ltr", head: 4, width: 686 },
        { name: "mixed", text: "abc אבג xyz (العربية 123)", direction: "ltr", head: 4, width: 686 },
        { name: "rtl", text: "abc אבג xyz (العربية 123)", direction: "rtl", head: 4, width: 686 },
        { name: "offscreen-single-rtl", text: "prefix ".repeat(12) + "א suffix", direction: "ltr", head: 84, width: 160 }]) {
        await harness.page.evaluate(c => { const root = document.querySelector("#primary .st-viewport"); if (!(root instanceof HTMLElement)) throw new Error("Bidi setup requires its primary viewport."); root.style.setProperty("--st-text-direction", c.direction); root.style.width = `${c.width}px`; window.editingFixture.setText(c.text); }, config); await ready();
        const samples = [];
        for (let trial = 0; trial < 23; trial++) {
            const key = trial % 2 ? "ArrowRight" : "ArrowLeft";
            await harness.page.evaluate(head => { window.editingFixture.select("primary", { anchor: head, head, anchorAffinity: "after", headAffinity: "after" }); window.editingFixture.focus("primary"); }, config.head); await ready();
            await harness.page.evaluate(key => {
                const input = document.querySelector("#primary textarea"), before = window.editingFixture.snapshot();
                const root = document.querySelector("#primary .st-viewport"), initial = window.editingFixture.coords(before.primary.selection.head, before.primary.selection.headAffinity);
                const captured = before.document;
                if (!(input instanceof HTMLTextAreaElement) || !root || !initial || !captured) throw new Error("Visual movement requires its captured document, input and caret geometry.");
                const initialX = initial.left - root.getBoundingClientRect().left + before.primary.viewport.scrollLeft;
                /** @type {MeasurementGlobal} */ (globalThis).bidiMeasurement = new Promise((resolve, reject) => {
                    /** @type {number | undefined} */ let start;
                    /** @type {number | undefined} */ let handlerMs;
                    const clean = () => { input.removeEventListener("keydown", began, true); input.removeEventListener("keydown", ended); };
                    /** @param {string} message */
                    const fail = message => { clearTimeout(timeout); clean(); reject(new Error(message)); };
                    const timeout = setTimeout(() => { clean(); reject(new Error("Visual movement measurement timed out.")); }, 5000);
                    /** @param {KeyboardEvent} event */
                    const began = event => {
                        if (event.key !== key) return; start = performance.now();
                        const check = () => {
                            const s = window.editingFixture.snapshot();
                            if (!s.document || start === undefined || handlerMs === undefined) { fail("Visual movement lost its document or keydown clocks."); return; }
                            if (s.primary.viewport.pending || s.primary.viewport.revision !== s.document.revision) { requestAnimationFrame(check); return; }
                            const point = window.editingFixture.coords(s.primary.selection.head, s.primary.selection.headAffinity);
                            if (!point) { fail("Visual movement lost its current caret geometry."); return; }
                            clearTimeout(timeout); clean(); resolve({ handlerMs, keyToFrameReadyProxyMs: performance.now() - start, visualMoves: s.primary.visualMoves - before.primary.visualMoves,
                                revisionDelta: s.document.revision - captured.revision, document: s.document, inputUnits: s.primary.inputUnits, partialRows: s.primary.viewport.partialRows,
                                selection: s.primary.selection, deltaX: point.left - root.getBoundingClientRect().left + s.primary.viewport.scrollLeft - initialX });
                        }; requestAnimationFrame(check);
                    };
                    /** @param {KeyboardEvent} event */
                    const ended = event => { if (event.key === key && start !== undefined) handlerMs = performance.now() - start; };
                    input.addEventListener("keydown", began, { capture: true }); input.addEventListener("keydown", ended);
                });
            }, key);
            await harness.page.keyboard.press(key); const sample = await harness.page.evaluate(() => /** @type {MeasurementGlobal} */ (globalThis).bidiMeasurement);
            assert.equal(sample.visualMoves, 1); assert.equal(sample.revisionDelta, 0); assert.equal(sample.document.exports, 0); assert.equal(sample.document.length, config.text.length);
            assert.equal(sample.partialRows, 0); assert.ok(sample.inputUnits <= 2600); assert.ok(sample.deltaX * (key === "ArrowLeft" ? -1 : 1) > .25);
            assert.ok(Number.isFinite(sample.handlerMs)); assert.equal(await harness.page.locator("textarea.st-textarea-baseline").count(), 0);
            if (trial >= 3) samples.push({ key, ...sample });
        }
        cases.push({ name: config.name, direction: config.direction, units: config.text.length, width: config.width, warmup: 3, measured: samples.length,
            handlerMs: distribution(samples.map(s => s.handlerMs)), keyToFrameReadyProxyMs: distribution(samples.map(s => s.keyToFrameReadyProxyMs)), samples });
    }
    assert.deepEqual(harness.errors, []); assert.equal((await sourceIdentity()).sha256, source.sha256);
    const display = await harness.page.locator("#primary .st-viewport").evaluate(e => { const s = getComputedStyle(e); return { devicePixelRatio, font: s.font, ligatures: s.fontVariantLigatures, kerning: s.fontKerning, tabSize: s.tabSize }; });
    await mkdir("artifacts/bench/bidi", { recursive: true }); await writeFile("artifacts/bench/bidi/latest.json", JSON.stringify({ schemaVersion: 1, created: new Date().toISOString(), source,
        environment: { ...environment(), browser: harness.browser.version(), buildMode: harness.buildMode, display }, kernel, cases, errors: harness.errors,
        note: "Original Unicode 18 resolution through L2 and actual visual keys on complete bounded rows. The synchronous kernel uses paragraph-proportional work/memory; its long-paragraph case is not a cooperatively scheduled browser layout index. Command handlerMs is elapsed time from keydown capture to the target bubble listener, including the adapter's synchronous geometry/selection/context work and intervening listeners. It is separate from the adapter's own lastKeydownMs; neither this span nor the kernel clock measures process CPU time. Frame-ready includes animation-frame scheduling, not physical input/display latency. Two views remain mounted, only the captured primary selection moves, no model text changes or exports occur. Global contextual-line shaping/origins, native devices and production budgets remain unqualified." }, null, 2));
    console.log(JSON.stringify({ kernel: kernel.map(c => ({ name: c.name, units: c.units, p95: c.totalMs.p95 })), browser: cases.map(c => ({ name: c.name, handlerP95: c.handlerMs.p95, proxyP95: c.keyToFrameReadyProxyMs.p95 })) }, null, 2));
} finally { await harness.close(); }
