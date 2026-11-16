import assert from "node:assert/strict";
import { openHarness } from "./browser-harness.mjs";
import { environment, sourceIdentity, timingSummary } from "./measurement.mjs";
import { installHostReferenceProbe } from "./host-reference-probe.mjs";
import { measureHostEdit, summarizeHostEdits } from "./host-edit-measurement.mjs";
import { createReportWriter } from "./benchmark-report.mjs";

const source = await sourceIdentity(), smoke = process.env.STTROPEZ_INPUT_SMOKE === "1", warmup = smoke ? 0 : 3, measured = smoke ? 1 : 10;
const writer = await createReportWriter("artifacts/bench/host-input", smoke ? "smoke" : "full");
const harness = await openHarness(), page = harness.page, cases = [], displays = [], completed = new Map(), warmupCases = new Map();
let activeCase, activeSample;
const click = name => page.getByRole("button", { name, exact: true }).click();
const ready = () => page.evaluate(() => globalThis.hostReferenceProbe.waitReady());
async function prepare(original, offset, input) {
    await page.evaluate(original => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: original }]); }, original);
    await click("Capture review acceptance"); await click("Finish review acceptance"); await ready();
    assert.equal(await page.evaluate(offset => { const f = window.hostFixture; return f.selectSource("primary", f.snapshot().source.revision, { anchor: offset, head: offset }); }, offset), true);
    // Put the requested caret in view outside the typing clock, without changing the document.
    await input.press(offset === original.length ? "ArrowLeft" : "ArrowRight");
    await input.press(offset === original.length ? "ArrowRight" : "ArrowLeft"); await ready();
    const s = await page.evaluate(() => window.hostFixture.snapshot()), c = s.bindings.comparison, p = s.bindings.views.find(v => v.id === "primary");
    assert.equal(c.referenceIsWorkingBuffer, true); assert.equal(c.progress.work, 0); assert.equal(c.progress.readUnits, 0); assert.equal(c.hunks, 0);
    assert.equal(p.selection.anchor, offset); assert.equal(p.selection.head, offset); assert.equal(s.source.exports, 0);
    return s;
}
try {
    await writer.write({ status: "running", source, smoke, cases: [], warmupCases: [] });
    for (const host of ["plain", "react"]) for (const corpus of ["unicode-crlf", "lines-100000", "unique-lines-100000", "single-line"]) {
        const line = corpus === "unicode-crlf" ? "const café = 'e\u0301 👩‍💻 東京';" : corpus === "unique-lines-100000" ? "const value000000 = 123;" : "const sample = 1234567;";
        const eol = corpus === "unicode-crlf" ? "\r\n" : "\n", count = corpus === "unicode-crlf" ? 60 : 100000;
        const original = corpus === "single-line" ? "x".repeat(2400000) : corpus === "unique-lines-100000"
            ? Array.from({ length: count }, (_, i) => `const value${String(i).padStart(6, "0")} = 123;`).join(eol) : Array(count).fill(line).join(eol);
        const results = new Map();
        for (let iteration = 0; iteration < warmup + measured; iteration++) {
            await page.goto(new URL(`/hosts/${host}/?editor=candidate`, page.url()).href);
            await page.waitForFunction(() => window.hostFixture?.snapshot().bindings.activeViews === 2);
            await page.evaluate(installHostReferenceProbe); await click("Open source review"); await ready();
            const input = page.getByRole("textbox", { name: "Primary source", exact: true });
            for (const pattern of corpus === "single-line" ? ["mixed", "repeated"] : ["mixed"])
            for (const position of ["beginning", "middle", "end"]) for (const mode of pattern === "repeated" ? ["cold-character", "sustained"] : ["cold-character", "cold-newline", "sustained"]) {
                const offset = position === "beginning" ? 0 : position === "end" ? original.length : corpus === "single-line" ? 1200000 : Math.floor(count / 2) * (line.length + eol.length) + 7;
                activeCase = { host, corpus, pattern, position, mode, iteration, stage: "setup" }; activeSample = undefined;
                const before = await prepare(original, offset, input), character = pattern === "repeated" ? "x" : "z", burst = pattern === "repeated" ? "x".repeat(32) : "abcdefghijklmnopqrstuvwxyzabcdef";
                const text = mode === "cold-character" ? character : mode === "cold-newline" ? eol : burst;
                if (iteration === 0 && position === "beginning" && mode === "cold-character") displays.push({ host, corpus, pattern, ...await input.evaluate(node => {
                    const root = node.closest(".st-viewport"), style = getComputedStyle(root); return { font: style.font, width: root.clientWidth, height: root.clientHeight, devicePixelRatio }; }) });
                activeCase.stage = "edit";
                const sample = await measureHostEdit(page, input, text, mode, observed => { activeSample = observed; }), expected = original.slice(0, offset) + text + original.slice(offset);
                assert.equal(sample.revision, before.source.revision + sample.transactions);
                assert.equal(await page.evaluate(text => window.hostFixture.range(0, text.length) === text, expected), true);
                assert.equal(await page.evaluate(text => window.hostFixture.referenceRange(0, text.length) === text, original), true);
                const groups = sample.history?.groups ?? sample.historyAfter.undoDepth - sample.historyBefore.undoDepth;
                assert.ok(groups >= 1 && groups <= sample.transactions);
                for (let i = 0; i < groups; i++) await input.press("Control+z"); await ready();
                assert.equal(await page.evaluate(text => window.hostFixture.range(0, text.length) === text && window.hostFixture.snapshot().source.length === text.length, original), true);
                for (let i = 0; i < groups; i++) await input.press("Control+Shift+z"); await ready();
                assert.equal(await page.evaluate(text => window.hostFixture.range(0, text.length) === text && window.hostFixture.snapshot().source.length === text.length, expected), true);
                {
                    const id = `${pattern}:${position}:${mode}`, fullId = `${host}:${corpus}:${id}`, target = iteration < warmup ? warmupCases : completed, item = target.get(fullId) ?? { host, editor: "candidate", corpus, pattern, position, mode, length: original.length, offset, text,
                        warmup, measured, requestedKeyDelayMs: mode === "sustained" ? 8 : 0, samples: [] };
                    item.samples.push(sample); target.set(fullId, item); if (iteration >= warmup) results.set(id, item);
                }
            }
            await page.evaluate(() => window.hostFixture.dispose());
            assert.equal((await page.evaluate(() => window.hostFixture.snapshot())).diagnostics.views, 0);
        }
        for (const item of results.values()) {
            assert.equal(item.samples.length, measured);
            const large = original.length > 100000;
            const result = { ...item, ...summarizeHostEdits(item.samples) };
            result.targets = { handlerMs: 16, reviewReadyMs: large ? 250 : 100, completePointActionMs: item.mode === "sustained" ? null : large ? 500 : 200 };
            result.assessment = { handlerMet: (result.keydownHandlerMs ?? result.inputHandlerMs).p95 <= result.targets.handlerMs,
                reviewReadinessMet: (result.commandToFullReviewReadyProxyMs ?? result.lastInputToFullReviewReadyProxyMs).p95 <= result.targets.reviewReadyMs,
                completeActionMet: item.mode === "sustained" ? null : result.completeActionProxyMs.p95 <= result.targets.completePointActionMs };
            cases.push(result);
        }
        await writer.write({ status: "running", source, smoke, cases: [...completed.values()], warmupCases: [...warmupCases.values()] });
        console.log(JSON.stringify({ host, corpus, conditions: results.size, measured, semanticChecks: "passed" }));
    }
    assert.deepEqual(harness.errors, []); assert.equal((await sourceIdentity()).sha256, source.sha256);
    const report = { schemaVersion: 3, status: "passed", created: new Date().toISOString(), source, smoke, environment: { ...environment(), browser: harness.browser.version(), displays }, cases, warmupCases: [...warmupCases.values()], errors: harness.errors,
        boundaries: "Fresh identical working/reference buffer and zero diff work/read units before each measured character, Enter or 32-character typing burst. Three source positions, both candidate hosts, two source panes plus editable comparison/immutable reference and 20Hz traffic. Explicit caret placement/reveal, reference acceptance, full-text/reference oracles and shared undo/redo are outside timers. Handled Enter starts at trusted keydown and records keydown-handler time, contextual LF/CRLF text and one model transaction independently of raw units. Native insertText starts at beforeinput; the adapter input-handler span excludes beforeinput and observation cost. Input-to-full-review readiness, last-input settlement and whole keyboard-action automation are separate. Working-render event timestamps during bursts include exact model/rendered selection/revision in all three working panes, but may precede caret or comparison settlement; those clocks do not substitute for full review readiness. Missing intermediate working-ready observations remain counted as superseded, not displayed. Full final readiness includes pending input/commands/caret/scans, completed comparison/reference and two consecutive frames. Requested keyboard delay and observed gaps remain in results; burst totals include cadence. Instrumented render/history observers add work. No network delay, physical-presentation or native-device qualification." };
    await writer.write(report); console.log(JSON.stringify({ report: writer.file, latest: writer.latest }));
    console.log(JSON.stringify({ conditions: cases.length, misses: cases.filter(c => Object.values(c.assessment).some(v => v === false)).map(c => ({ host: c.host, corpus: c.corpus,
        pattern: c.pattern, position: c.position, mode: c.mode, handlerKind: c.handlerKind, handlerMs: timingSummary(c.keydownHandlerMs ?? c.inputHandlerMs), readinessMs: timingSummary(c.commandToFullReviewReadyProxyMs ?? c.lastInputToFullReviewReadyProxyMs), actionMs: timingSummary(c.completeActionProxyMs) })) }, null, 2));
} catch (error) {
    await writer.write({ status: "failed", source, smoke, cases: [...completed.values()], warmupCases: [...warmupCases.values()], activeCase, activeSample,
        observation: await page.evaluate(() => globalThis.hostReferenceProbe?.snapshot()).catch(() => null), error: String(error), stack: error.stack, errors: harness.errors });
    console.error(JSON.stringify({ failedReport: writer.file })); throw error;
} finally { await harness.close(); }
