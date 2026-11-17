import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { openHarness } from "./browser-harness.mjs";
import { distribution, environment, sourceIdentity } from "./measurement.mjs";
import { installHostReferenceProbe } from "./host-reference-probe.mjs";

const source = await sourceIdentity(), smoke = process.env.STTROPEZ_NAVIGATION_SMOKE === "1";
const warmup = smoke ? 0 : 3, measured = smoke ? 1 : 10, cases = [], displays = [];
const harness = await openHarness(), page = harness.page;
const click = name => page.getByRole("button", { name, exact: true }).click();
const ready = () => page.evaluate(() => globalThis.hostReferenceProbe.waitReady());
async function select(offset) {
    assert.equal(await page.evaluate(offset => {
        const f = window.hostFixture; return f.selectSource("primary", f.snapshot().source.revision, { anchor: offset, head: offset });
    }, offset), true);
    await ready();
}
async function command(key, expected) {
    const before = await page.evaluate(() => window.hostFixture.snapshot());
    await page.evaluate(({ key, expected }) => {
        const f = window.hostFixture, prior = f.snapshot(), input = document.querySelector('textarea[aria-label="Primary source"]');
        globalThis.hostNavigationMeasurement = new Promise((resolve, reject) => {
            let frames = 0, start, frame, finished = false;
            const cleanup = () => { finished = true; clearTimeout(timeout); cancelAnimationFrame(frame); input.removeEventListener("keydown", onKey, true); };
            const fail = message => { if (finished) return; cleanup(); reject(new Error(message)); };
            const timeout = setTimeout(() => fail(`Navigation readiness timed out: ${key}`), 20000);
            const check = () => {
                if (finished) return;
                const s = f.snapshot(), c = s.bindings.comparison, p = s.bindings.views.find(v => v.id === "primary");
                let full;
                try { full = globalThis.hostReferenceProbe.isReady(s); }
                catch (error) { fail(String(error?.message ?? error)); return; }
                if (!full) { frames = 0; frame = requestAnimationFrame(check); return; }
                if (s.source.revision !== prior.source.revision + expected.revisionDelta || s.source.length !== expected.length
                    || p.selection.anchor !== expected.anchor || p.selection.head !== expected.head) {
                    fail(`Incorrect navigation result: ${JSON.stringify({ key, expected, revision: s.source.revision, prior: prior.source.revision, length: s.source.length, selection: p.selection })}`); return;
                }
                if (++frames < 2) { frame = requestAnimationFrame(check); return; }
                cleanup();
                resolve({ keydownHandlerMs: p.metrics.lastKeydownMs, keyToReviewReadyProxyMs: performance.now() - start,
                    selection: p.selection, revision: s.source.revision, length: s.source.length, exports: s.source.exports,
                    history: s.history, inputUnits: p.metrics.inputUnits, rows: s.bindings.views.map(v => v.metrics.viewport.rows),
                    maxViewReadUnits: Math.max(...s.bindings.views.map(v => v.metrics.viewport.readUnits), c.workingViewport.readUnits, c.referenceViewport.readUnits),
                    viewport: { width: p.metrics.viewport.width, height: p.metrics.viewport.height, lineHeight: p.metrics.viewport.lineHeight, columnWidth: p.metrics.viewport.columnWidth },
                    comparisonRows: c.workingViewport.rows + c.referenceViewport.rows, wordScanSteps: p.metrics.wordScanSteps,
                    maxWordScanStepMs: p.metrics.maxWordScanStepMs, graphemeScanSteps: p.metrics.graphemeScanSteps,
                    maxGraphemeScanStepMs: p.metrics.maxGraphemeScanStepMs, diffWork: c.work, background: s.activity.background,
                    focused: document.activeElement === input });
            };
            const onKey = event => {
                if (event.key !== key) return;
                input.removeEventListener("keydown", onKey, true); start = performance.now(); frame = requestAnimationFrame(check);
            };
            input.addEventListener("keydown", onKey, { capture: true });
        });
    }, { key: key.split("+").at(-1), expected });
    const began = performance.now(); await page.keyboard.press(key);
    const sample = await page.evaluate(() => globalThis.hostNavigationMeasurement);
    sample.completeActionProxyMs = performance.now() - began;
    assert.equal(sample.exports, 0); assert.equal(sample.focused, true); assert.ok(sample.inputUnits <= 2600);
    assert.ok(sample.rows.every(rows => rows < 100)); assert.ok(sample.comparisonRows < 100); assert.ok(sample.maxViewReadUnits < 20000);
    const prior = before.bindings.views.find(v => v.id === "primary").metrics;
    return { ...sample, scanCountersBefore: { wordScanSteps: prior.wordScanSteps, graphemeScanSteps: prior.graphemeScanSteps,
        maxWordScanStepMs: prior.maxWordScanStepMs, maxGraphemeScanStepMs: prior.maxGraphemeScanStepMs },
        changedUnits: Math.abs(before.source.length - expected.length), historyBefore: before.history };
}
try {
    for (const host of ["plain", "react"]) for (const corpus of ["unicode-crlf", "lines-100000", "unique-lines-100000", "single-line"]) {
        const line = corpus === "unicode-crlf" ? "const café = 'e\u0301 👩‍💻 東京';" : "const sample = 1234567;";
        const eol = corpus === "unicode-crlf" ? "\r\n" : "\n", count = corpus === "unicode-crlf" ? 60 : 100000;
        const original = corpus === "single-line" ? "x".repeat(2400000) : corpus === "unique-lines-100000"
            ? Array.from({ length: count }, (_, i) => `const value${String(i).padStart(6, "0")} = 123;`).join(eol)
            : Array(count).fill(line).join(eol);
        const text = original + "\nreview-tail", results = new Map();
        const add = (position, name, sample, iteration) => {
            if (iteration < warmup) return;
            const id = `${position}:${name}`, item = results.get(id) ?? { host, editor: "candidate", corpus, position, command: name, length: text.length, warmup, measured, samples: [] };
            item.samples.push(sample); results.set(id, item);
        };
        for (let iteration = 0; iteration < warmup + measured; iteration++) {
            await page.goto(new URL(`/hosts/${host}/?editor=candidate`, page.url()).href);
            await page.waitForFunction(() => window.hostFixture?.snapshot().bindings.activeViews === 2);
            await page.evaluate(installHostReferenceProbe);
            await page.evaluate(text => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: 0, to: s.source.length, insert: text }]); }, original);
            await click("Open source review"); await ready();
            await click("Capture review acceptance"); await click("Finish review acceptance"); await ready();
            await page.evaluate(() => { const f = window.hostFixture, s = f.snapshot(); f.editSource(s.source.revision, [{ from: s.source.length, to: s.source.length, insert: "\nreview-tail" }]); });
            await ready(); // Reference index is warm; cold identical-reference edits are a separate condition.
            if (iteration === 0) displays.push({ host, corpus, ...await page.locator(".st-viewport").first().evaluate(node => {
                const style = getComputedStyle(node); return { font: style.font, tabSize: style.tabSize, width: node.clientWidth, height: node.clientHeight, devicePixelRatio };
            }) });
            const input = page.getByRole("textbox", { name: "Primary source", exact: true }); await input.focus();
            const initial = await page.evaluate(() => window.hostFixture.snapshot());
            for (const position of ["beginning", "middle", "end"]) {
                const row = position === "beginning" ? 0 : position === "middle" ? Math.floor(count / 2) : count - 1;
                const lineUnits = (corpus === "unique-lines-100000" ? 24 : line.length) + eol.length;
                const from = corpus === "single-line" ? 0 : row * lineUnits;
                const base = corpus === "single-line" ? position === "beginning" ? 1 : position === "middle" ? 1200000 : 2399999 : from + 7;
                const wordStart = corpus === "single-line" ? 0 : from + 6;
                const wordNext = corpus === "single-line" ? original.length + 1 : from + (corpus === "unicode-crlf" ? 11 : corpus === "unique-lines-100000" ? 18 : 13);
                for (const [name, key, head] of [["word-forward", "Control+ArrowRight", wordNext], ["word-backward", "Control+ArrowLeft", wordStart]]) {
                    await select(base); add(position, name, await command(key, { revisionDelta: 0, length: text.length, anchor: head, head }), iteration);
                }
                await select(base);
                add(position, "select-line-start", await command("Shift+Home", { revisionDelta: 0, length: text.length, anchor: base, head: from }), iteration);
                const removed = base - from, changed = text.slice(0, from) + text.slice(base);
                const deletion = await command("Backspace", { revisionDelta: 1, length: changed.length, anchor: from, head: from });
                assert.equal(deletion.history.undoDepth, deletion.historyBefore.undoDepth + 1);
                assert.equal(await page.evaluate(expected => window.hostFixture.range(0, expected.length) === expected, changed), true);
                add(position, "delete-selection", deletion, iteration);
                add(position, "undo", await command("Control+z", { revisionDelta: 1, length: text.length, anchor: base, head: from }), iteration);
                assert.equal(await page.evaluate(expected => window.hostFixture.range(0, expected.length) === expected, text), true);
                add(position, "redo", await command("Control+Shift+z", { revisionDelta: 1, length: text.length - removed, anchor: from, head: from }), iteration);
                await command("Control+z", { revisionDelta: 1, length: text.length, anchor: base, head: from });
                assert.equal(await page.evaluate(expected => window.hostFixture.range(0, expected.length) === expected, text), true);
                const grapheme = corpus === "unicode-crlf" ? from + line.indexOf("e\u0301") : base;
                await select(grapheme);
                const head = grapheme + (corpus === "unicode-crlf" ? 2 : 1);
                add(position, "grapheme-forward", await command("ArrowRight", { revisionDelta: 0, length: text.length, anchor: head, head }), iteration);
                if (corpus !== "single-line") {
                    await select(base);
                    const viewport = await page.evaluate(() => window.hostFixture.snapshot().bindings.views.find(v => v.id === "primary").metrics.viewport);
                    const nextRow = Math.min(count, row + Math.max(1, Math.floor(viewport.height / viewport.lineHeight) - 1)), pageHead = nextRow * lineUnits + 7;
                    // The added reference-difference tail begins after a one-unit LF, even in the CRLF corpus.
                    const head = nextRow === count ? original.length + 1 + 7 : pageHead;
                    add(position, "page-down", await command("PageDown", { revisionDelta: 0, length: text.length, anchor: head, head }), iteration);
                }
            }
            assert.equal(await page.evaluate(expected => window.hostFixture.referenceRange(0, expected.length) === expected, original), true);
            assert.ok((await page.evaluate(() => window.hostFixture.snapshot())).activity.background > initial.activity.background);
            await page.evaluate(() => window.hostFixture.dispose());
            assert.equal((await page.evaluate(() => window.hostFixture.snapshot())).diagnostics.views, 0);
        }
        for (const item of results.values()) {
            assert.equal(item.samples.length, measured);
            const small = corpus === "unicode-crlf", bulk = item.samples.some(s => s.changedUnits > 4096);
            cases.push({ ...item, bulk, keydownHandlerMs: distribution(item.samples.map(s => s.keydownHandlerMs)),
                keyToReviewReadyProxyMs: distribution(item.samples.map(s => s.keyToReviewReadyProxyMs)),
                completeActionProxyMs: distribution(item.samples.map(s => s.completeActionProxyMs)),
                targets: { handlerMs: 16, readinessMs: bulk ? null : small ? 100 : 250, completeActionMs: bulk ? null : small ? 200 : 500 } });
        }
        console.log(JSON.stringify({ host, corpus, conditions: results.size, measured, semanticChecks: "passed" }));
    }
    assert.deepEqual(harness.errors, []); assert.equal((await sourceIdentity()).sha256, source.sha256);
    for (const c of cases) c.targetAssessment = { handlerMet: c.keydownHandlerMs.p95 <= c.targets.handlerMs,
        readinessMet: c.bulk ? null : c.keyToReviewReadyProxyMs.p95 <= c.targets.readinessMs, completeActionMet: c.bulk ? null : c.completeActionProxyMs.p95 <= c.targets.completeActionMs };
    const report = { schemaVersion: 1, created: new Date().toISOString(), source, smoke,
        environment: { ...environment(), browser: harness.browser.version(), viewport: page.viewportSize(), displays }, cases, errors: harness.errors,
        boundaries: "Candidate source commands in both hosts with two source panes, editable comparison, immutable reference and 20Hz host traffic. Three positions per corpus. Each measured command starts at input-capture keydown and waits for exact text length/revision/model selection, shared live-owner working/reference settlement (complete selections/folds, pending input/commands, scans/caret/drag, comparison alignment/scroll), source revision/reference label and two consecutive frames. Synchronous keydown handler elapsed time, readiness and whole keyboard-action automation are separate. Full-text/reference oracles and explicit selection setup are outside timers. Warm comparison indexes; cold first edits, sustained input, physical presentation and native devices are unqualified. No imposed service delay. Long single-line word/grapheme jobs and their provisional target misses remain in the results. Historical reports retain their original readiness definition." };
    await mkdir("artifacts/bench/host-navigation", { recursive: true });
    await writeFile(`artifacts/bench/host-navigation/${smoke ? "smoke" : "latest"}.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ conditions: cases.length, targetMisses: cases.filter(c => Object.values(c.targetAssessment).some(v => v === false))
        .map(c => ({ host: c.host, corpus: c.corpus, position: c.position, command: c.command, handlerP95: c.keydownHandlerMs.p95,
            readinessP95: c.keyToReviewReadyProxyMs.p95, actionP95: c.completeActionProxyMs.p95 })) }, null, 2));
} finally { await harness.close(); }
