import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { openHarness } from "./browser-harness.mjs";
import { distribution, environment, sourceIdentity } from "./measurement.mjs";
import { typeHostSuffix } from "./host-typing.mjs";

const source = await sourceIdentity(), smoke = process.env.STTROPEZ_INPUT_SMOKE === "1", warmup = smoke ? 0 : 3, measured = smoke ? 1 : 10;
const harness = await openHarness(), page = harness.page, cases = [], displays = [];
const click = name => page.getByRole("button", { name, exact: true }).click();
async function ready() {
    await page.waitForFunction(() => {
        const s = window.hostFixture?.snapshot(), c = s?.bindings.comparison, same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
        return s?.bindings.activeViews === 2 && s.bindings.views.every(v => v.metrics && !v.metrics.pendingCaret && !v.metrics.pendingDragScroll && !v.metrics.pendingWord && !v.metrics.pendingGrapheme
            && !v.metrics.viewport.pending && v.metrics.viewport.revision === s.source.revision && same(v.metrics.viewport.selection, v.selection))
            && c?.status === "ready" && !c.input.pendingCaret && !c.input.pendingDragScroll && !c.input.pendingWord && !c.input.pendingGrapheme && !c.workingViewport.pending
            && c.workingRevision === s.source.revision && c.workingViewport.revision === s.source.revision && same(c.workingViewport.selection, c.selection)
            && c.referenceViewport && !c.referenceViewport.pending;
    });
}
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
async function measure(input, text, mode) {
    await page.evaluate(({ text, mode }) => {
        const f = window.hostFixture, before = f.snapshot(), prior = before.bindings.views.find(v => v.id === "primary"), offset = prior.selection.head;
        const input = document.querySelector('textarea[aria-label="Primary source"]'), listeners = new AbortController(), records = [], signal = listeners.signal;
        const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
        const rendered = s => {
            const c = s.bindings.comparison;
            return s.bindings.views.every(v => !v.metrics.pendingWord && !v.metrics.pendingGrapheme && !v.metrics.viewport.pending
                && v.metrics.viewport.revision === s.source.revision && same(v.metrics.viewport.selection, v.selection))
                && c && !c.input.pendingWord && !c.input.pendingGrapheme && !c.workingViewport.pending
                && c.workingViewport.revision === s.source.revision && same(c.workingViewport.selection, c.selection);
        };
        const full = s => rendered(s) && s.bindings.views.every(v => !v.metrics.pendingCaret && !v.metrics.pendingDragScroll)
            && s.bindings.comparison.status === "ready" && !s.bindings.comparison.input.pendingCaret && !s.bindings.comparison.input.pendingDragScroll
            && s.bindings.comparison.workingRevision === s.source.revision && s.bindings.comparison.referenceViewport
            && !s.bindings.comparison.referenceViewport.pending;
        let frame, frames = 0, started, pendingStart, finished = false;
        globalThis.hostInputMeasurement = new Promise((resolve, reject) => {
            const cleanup = () => { finished = true; listeners.abort(); cancelAnimationFrame(frame); clearTimeout(timeout); };
            const fail = message => { cleanup(); reject(new Error(message)); };
            const timeout = setTimeout(() => fail(`Host ${mode} input readiness timed out.`), 20000);
            const workingRendered = () => {
                if (!records.length || finished) return;
                const s = f.snapshot(); if (!rendered(s)) return;
                const record = records.find(r => r.revision === s.source.revision);
                if (record && record.workingRenderedAt === undefined) {
                    record.workingRenderedAt = performance.now(); record.comparisonStatusAtRender = s.bindings.comparison.status;
                    record.caretPendingAtRender = s.bindings.views.some(v => v.metrics.pendingCaret) || s.bindings.comparison.input.pendingCaret;
                }
            };
            const roots = document.querySelectorAll(".st-editing-candidate");
            if (roots.length !== 3) { fail("Expected three bounded working views."); return; }
            roots.forEach(root => root.addEventListener("sttropez-render", workingRendered, { signal }));
            input.addEventListener("beforeinput", () => { pendingStart = performance.now(); started ??= pendingStart; }, { capture: true, signal });
            input.addEventListener("blur", () => fail("Typing lost source focus."), { signal });
            input.addEventListener("input", event => {
                const s = f.snapshot(), p = s.bindings.views.find(v => v.id === "primary"), count = records.length + 1;
                if (pendingStart === undefined || count > text.length || !["insertText", "insertLineBreak"].includes(event.inputType)
                    || s.source.id !== before.source.id || p.viewId !== prior.viewId || s.source.revision !== before.source.revision + count
                    || s.source.length !== before.source.length + count || p.selection.anchor !== offset + count || p.selection.head !== offset + count
                    || f.range(offset, offset + count) !== text.slice(0, count) || p.metrics.inputEvents !== prior.metrics.inputEvents + count
                    || p.metrics.commits !== prior.metrics.commits + count || p.metrics.inputUnits > 2600) { fail("Incorrect incremental typing result."); return; }
                records.push({ revision: s.source.revision, beforeinputAt: pendingStart, inputFinishedAt: performance.now(), inputHandlerMs: p.metrics.lastInputMs,
                    type: event.inputType, length: s.source.length, head: p.selection.head }); pendingStart = undefined;
            }, { signal });
            const check = () => {
                if (finished) return;
                const s = f.snapshot();
                if (records.length !== text.length || !full(s)) { frames = 0; frame = requestAnimationFrame(check); return; }
                workingRendered(); if (++frames < 2) { frame = requestAnimationFrame(check); return; }
                const now = performance.now(), c = s.bindings.comparison;
                if (s.source.exports !== 0 || s.bindings.mounts !== before.bindings.mounts || document.activeElement !== input) { fail("Typing exported text, remounted a source or lost focus."); return; }
                const rows = [...s.bindings.views.map(v => v.metrics.viewport.rows), c.workingViewport.rows, c.referenceViewport.rows];
                const readUnits = [...s.bindings.views.map(v => v.metrics.viewport.readUnits), c.workingViewport.readUnits, c.referenceViewport.readUnits];
                cleanup(); resolve({ inputToFullReviewReadyProxyMs: now - started, lastInputToFullReviewReadyProxyMs: now - records.at(-1).beforeinputAt,
                    lastInputFinishedToFullReviewReadyProxyMs: now - records.at(-1).inputFinishedAt, inputDispatchSpanMs: records.at(-1).beforeinputAt - started,
                    records: records.map(r => ({ ...r, workingRenderProxyMs: r.workingRenderedAt === undefined ? null : r.workingRenderedAt - r.beforeinputAt,
                        supersededBeforeObservedWorkingReady: r.workingRenderedAt === undefined })),
                    diffWork: c.work, diffProgress: c.progress, exports: s.source.exports, rows, readUnits,
                    historyBefore: before.history, historyAfter: s.history, backgroundUpdates: s.activity.background - before.activity.background,
                    beforeRevision: before.source.revision, revision: s.source.revision, inputUnits: s.bindings.views.map(v => v.metrics.inputUnits), comparisonInputUnits: c.input.inputUnits });
            }; frame = requestAnimationFrame(check);
        });
    }, { text, mode });
    let started, history;
    if (mode === "cold-newline") { started = performance.now(); await input.press("Enter"); }
    else history = await typeHostSuffix(input, text, () => { started = performance.now(); return page.keyboard.type(text, { delay: mode === "sustained" ? 8 : 0 }); });
    const result = await page.evaluate(() => globalThis.hostInputMeasurement);
    result.completeActionProxyMs = performance.now() - started; result.history = history ?? null;
    assert.ok(result.rows.every(n => n < 100)); assert.ok(result.readUnits.every(n => n < 20000));
    assert.ok(result.inputUnits.every(n => n <= 2600)); assert.ok(result.comparisonInputUnits <= 2600);
    assert.equal(result.records.length, text.length); assert.equal(result.records.at(-1).supersededBeforeObservedWorkingReady, false);
    return result;
}
try {
    for (const host of ["plain", "react"]) for (const corpus of ["unicode-crlf", "lines-100000", "unique-lines-100000", "single-line"]) {
        const line = corpus === "unicode-crlf" ? "const café = 'e\u0301 👩‍💻 東京';" : corpus === "unique-lines-100000" ? "const value000000 = 123;" : "const sample = 1234567;";
        const eol = corpus === "unicode-crlf" ? "\r\n" : "\n", count = corpus === "unicode-crlf" ? 60 : 100000;
        const original = corpus === "single-line" ? "x".repeat(2400000) : corpus === "unique-lines-100000"
            ? Array.from({ length: count }, (_, i) => `const value${String(i).padStart(6, "0")} = 123;`).join(eol) : Array(count).fill(line).join(eol);
        const results = new Map();
        for (let iteration = 0; iteration < warmup + measured; iteration++) {
            await page.goto(new URL(`/hosts/${host}/?editor=candidate`, page.url()).href);
            await page.waitForFunction(() => window.hostFixture?.snapshot().bindings.activeViews === 2);
            await click("Open source review"); await ready();
            const input = page.getByRole("textbox", { name: "Primary source", exact: true });
            for (const pattern of corpus === "single-line" ? ["mixed", "repeated"] : ["mixed"])
            for (const position of ["beginning", "middle", "end"]) for (const mode of pattern === "repeated" ? ["cold-character", "sustained"] : ["cold-character", "cold-newline", "sustained"]) {
                const offset = position === "beginning" ? 0 : position === "end" ? original.length : corpus === "single-line" ? 1200000 : Math.floor(count / 2) * (line.length + eol.length) + 7;
                const before = await prepare(original, offset, input), character = pattern === "repeated" ? "x" : "z", burst = pattern === "repeated" ? "x".repeat(32) : "abcdefghijklmnopqrstuvwxyzabcdef";
                const text = mode === "cold-character" ? character : mode === "cold-newline" ? "\n" : burst;
                if (iteration === 0 && position === "beginning" && mode === "cold-character") displays.push({ host, corpus, pattern, ...await input.evaluate(node => {
                    const root = node.closest(".st-viewport"), style = getComputedStyle(root); return { font: style.font, width: root.clientWidth, height: root.clientHeight, devicePixelRatio }; }) });
                const sample = await measure(input, text, mode), expected = original.slice(0, offset) + text + original.slice(offset);
                assert.equal(sample.revision, before.source.revision + text.length);
                assert.equal(await page.evaluate(text => window.hostFixture.range(0, text.length) === text, expected), true);
                assert.equal(await page.evaluate(text => window.hostFixture.referenceRange(0, text.length) === text, original), true);
                const groups = sample.history?.groups ?? sample.historyAfter.undoDepth - sample.historyBefore.undoDepth;
                assert.ok(groups >= 1 && groups <= text.length);
                for (let i = 0; i < groups; i++) await input.press("Control+z"); await ready();
                assert.equal(await page.evaluate(text => window.hostFixture.range(0, text.length) === text && window.hostFixture.snapshot().source.length === text.length, original), true);
                for (let i = 0; i < groups; i++) await input.press("Control+Shift+z"); await ready();
                assert.equal(await page.evaluate(text => window.hostFixture.range(0, text.length) === text && window.hostFixture.snapshot().source.length === text.length, expected), true);
                if (iteration >= warmup) {
                    const id = `${pattern}:${position}:${mode}`, item = results.get(id) ?? { host, editor: "candidate", corpus, pattern, position, mode, length: original.length, offset, text,
                        warmup, measured, requestedKeyDelayMs: mode === "sustained" ? 8 : 0, samples: [] };
                    item.samples.push(sample); results.set(id, item);
                }
            }
            await page.evaluate(() => window.hostFixture.dispose());
            assert.equal((await page.evaluate(() => window.hostFixture.snapshot())).diagnostics.views, 0);
        }
        for (const item of results.values()) {
            assert.equal(item.samples.length, measured);
            const large = original.length > 100000;
            const working = item.samples.flatMap(s => s.records.filter(r => r.workingRenderProxyMs !== null).map(r => r.workingRenderProxyMs));
            const handlers = item.samples.flatMap(s => s.records.map(r => r.inputHandlerMs));
            const cadence = item.samples.flatMap(s => s.records.slice(1).map((r, i) => r.beforeinputAt - s.records[i].beforeinputAt));
            const result = { ...item, inputHandlerMs: distribution(handlers), inputHandlerMaxMs: Math.max(...handlers), observedWorkingRenderProxyMs: distribution(working),
                inputToFullReviewReadyProxyMs: distribution(item.samples.map(s => s.inputToFullReviewReadyProxyMs)),
                lastInputToFullReviewReadyProxyMs: distribution(item.samples.map(s => s.lastInputToFullReviewReadyProxyMs)),
                completeActionProxyMs: distribution(item.samples.map(s => s.completeActionProxyMs)), actualInputGapMs: cadence.length ? distribution(cadence) : null,
                supersededBeforeObservedWorkingReady: item.samples.reduce((n, s) => n + s.records.filter(r => r.supersededBeforeObservedWorkingReady).length, 0) };
            result.targets = { inputHandlerMs: 16, lastInputReviewReadyMs: large ? 250 : 100, completePointActionMs: item.mode === "sustained" ? null : large ? 500 : 200 };
            result.assessment = { handlerMet: result.inputHandlerMs.p95 <= 16, reviewReadinessMet: result.lastInputToFullReviewReadyProxyMs.p95 <= result.targets.lastInputReviewReadyMs,
                completeActionMet: item.mode === "sustained" ? null : result.completeActionProxyMs.p95 <= result.targets.completePointActionMs };
            cases.push(result);
        }
        console.log(JSON.stringify({ host, corpus, conditions: results.size, measured, semanticChecks: "passed" }));
    }
    assert.deepEqual(harness.errors, []); assert.equal((await sourceIdentity()).sha256, source.sha256);
    const report = { schemaVersion: 2, created: new Date().toISOString(), source, smoke, environment: { ...environment(), browser: harness.browser.version(), displays }, cases, errors: harness.errors,
        boundaries: "Fresh identical working/reference buffer and zero diff work/read units before each measured character, Enter or 32-character typing burst. Three source positions, both candidate hosts, two source panes plus editable comparison/immutable reference and 20Hz traffic. Explicit caret placement/reveal, reference acceptance, full-text/reference oracles and shared undo/redo are outside timers. Input-event handler durations exclude beforeinput capture; that capture is included in the full clock beginning at beforeinput. Input-to-full-review readiness, last-input settlement and whole keyboard-action automation are separate. Working-render event timestamps during bursts include exact model/rendered selection/revision in all three working panes, but may precede caret or comparison settlement; those clocks do not substitute for full review readiness. Missing intermediate working-ready observations remain counted as superseded, not displayed. Full final readiness includes pending caret/scans, completed comparison/reference and two consecutive frames. Requested keyboard delay and observed gaps remain in results; burst totals include cadence. Instrumented render/history observers add work. No network delay, physical-presentation or native-device qualification." };
    await mkdir("artifacts/bench/host-input", { recursive: true });
    await writeFile(`artifacts/bench/host-input/${smoke ? "smoke" : "latest"}.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ conditions: cases.length, misses: cases.filter(c => Object.values(c.assessment).some(v => v === false)).map(c => ({ host: c.host, corpus: c.corpus,
        pattern: c.pattern, position: c.position, mode: c.mode, handlerP95: c.inputHandlerMs.p95, reviewReadyP95: c.lastInputToFullReviewReadyProxyMs.p95, actionP95: c.completeActionProxyMs.p95 })) }, null, 2));
} finally { await harness.close(); }
