import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { TextBuffer, WordCursor } from "../src/index.ts";
import { openHarness } from "./browser-harness.mjs";
import { distribution, environment, sourceIdentity } from "./measurement.mjs";

const source = await sourceIdentity(), kernel = [];
for (const content of ["word", "whitespace"]) for (const direction of [-1, 1]) {
    const buffer = TextBuffer.from(content === "word" ? "x".repeat(1_000_000) : " ".repeat(1_000_000)), samples = [];
    for (let trial = 0; trial < 23; trial++) {
        const cursor = new WordCursor(buffer, direction < 0 ? buffer.length : 0, direction), advances = [], began = performance.now();
        let step, previous = 0, maxAdvanceUnits = 0;
        do {
            const start = performance.now(); step = cursor.next(4096); advances.push(performance.now() - start);
            maxAdvanceUnits = Math.max(maxAdvanceUnits, step.workUnits - previous); previous = step.workUnits;
        } while (step.status === "running");
        const totalMs = performance.now() - began;
        assert.equal(step.offset, direction < 0 ? 0 : buffer.length); assert.ok(maxAdvanceUnits <= 4352);
        assert.equal(buffer.readMetrics().textExports, 0); cursor.dispose();
        if (trial >= 3) samples.push({ totalMs, advances, maxAdvanceUnits, workUnits: step.workUnits, readUnits: step.readUnits });
    }
    kernel.push({ content, direction, length: buffer.length, warmup: 3, measured: samples.length,
        totalMs: distribution(samples.map(s => s.totalMs)), advanceMs: distribution(samples.flatMap(s => s.advances)), samples });
}
const harness = await openHarness();
try {
    await harness.page.goto("/editing/");
    const ready = () => harness.page.waitForFunction(() => { const s = window.editingFixture?.snapshot(); return s && !s.primary.pendingWord && !s.primary.viewport.pending && !s.secondary.viewport.pending && s.primary.viewport.revision === s.document?.revision; });
    await ready(); const cases = [];
    for (const name of ["word-forward", "word-backward", "delete-forward", "delete-backward", "page-many-lines", "page-unicode-crlf"]) {
        const samples = [];
        for (let trial = 0; trial < 13; trial++) {
            const config = await harness.page.evaluate(name => {
                const isPage = name.startsWith("page"), backward = name.endsWith("backward");
                const line = name === "page-unicode-crlf" ? "prefix\t東京 é 👩‍💻 0123456789" : "0123456789abcdef";
                const eol = name === "page-unicode-crlf" ? "\r\n" : "\n", lineCount = name === "page-many-lines" ? 100_000 : 60;
                const text = isPage ? Array.from({ length: lineCount }, () => line).join(eol) : "x".repeat(1_000_000) + "  tail";
                const head = isPage ? (line.length + eol.length) * Math.floor(lineCount / 2) + 8 : backward ? 1_000_000 : 0;
                window.editingFixture.setText(text); window.editingFixture.select("primary", { anchor: head, head }); window.editingFixture.focus("primary");
                return { key: isPage ? "PageDown" : `Control+${name.startsWith("delete") ? backward ? "Backspace" : "Delete" : backward ? "ArrowLeft" : "ArrowRight"}`,
                    expected: isPage ? null : backward ? 0 : 1_000_002, lineUnits: line.length + eol.length, head };
            }, name); await ready();
            const before = await harness.page.evaluate(() => window.editingFixture.snapshot());
            const expected = config.expected ?? config.head + config.lineUnits * Math.max(1, Math.floor(before.primary.viewport.height / before.primary.viewport.lineHeight) - 1);
            await harness.page.evaluate(key => {
                const input = document.querySelector("#primary textarea");
                globalThis.navigationMeasurement = new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => reject(new Error("Navigation measurement timed out.")), 15000);
                    const onKey = event => {
                        if (event.key !== key) return;
                        input.removeEventListener("keydown", onKey, true);
                        const start = performance.now();
                        const check = () => {
                            const s = window.editingFixture.snapshot();
                            if (s.primary.pendingWord || s.primary.viewport.pending || s.secondary.viewport.pending || s.primary.viewport.revision !== s.document.revision) { requestAnimationFrame(check); return; }
                            clearTimeout(timeout); resolve({ keyToFrameReadyProxyMs: performance.now() - start, state: s });
                        }; requestAnimationFrame(check);
                    };
                    input.addEventListener("keydown", onKey, { capture: true });
                });
            }, config.key.split("+").at(-1));
            await harness.page.keyboard.press(config.key);
            const sample = await harness.page.evaluate(() => globalThis.navigationMeasurement), state = sample.state;
            assert.equal(state.primary.selection.head, name.startsWith("delete") ? 0 : expected);
            assert.equal(state.document.revision - before.document.revision, name.startsWith("delete") ? 1 : 0);
            assert.equal(state.document.length, name === "delete-forward" ? 4 : name === "delete-backward" ? 6 : before.document.length);
            assert.equal(state.document.exports, 0); assert.equal(state.primary.conflicts, 0); assert.ok(state.primary.inputUnits <= 2600);
            assert.equal(await harness.page.locator("textarea.st-textarea-baseline").count(), 0);
            if (name.startsWith("delete")) assert.equal(await harness.page.evaluate(length => window.editingFixture.range(0, length), state.document.length), name === "delete-forward" ? "tail" : "  tail");
            if (!name.startsWith("page")) { assert.ok(state.primary.wordScanSteps > 1); assert.ok(Number.isFinite(state.primary.maxWordScanStepMs)); }
            if (trial >= 3) samples.push({ keyToFrameReadyProxyMs: sample.keyToFrameReadyProxyMs, document: state.document, primary: state.primary, history: state.history });
        }
        cases.push({ name, warmup: 3, measured: samples.length, keyToFrameReadyProxyMs: distribution(samples.map(s => s.keyToFrameReadyProxyMs)), samples });
    }
    assert.deepEqual(harness.errors, []); assert.equal((await sourceIdentity()).sha256, source.sha256);
    const display = await harness.page.locator("#primary .st-viewport").evaluate(e => { const s = getComputedStyle(e); return { width: e.clientWidth, height: e.clientHeight, devicePixelRatio, font: s.font, tabSize: s.tabSize }; });
    await mkdir("artifacts/bench/navigation", { recursive: true });
    await writeFile("artifacts/bench/navigation/latest.json", JSON.stringify({ schemaVersion: 1, created: new Date().toISOString(), source,
        environment: { ...environment(), browser: harness.browser.version(), buildMode: harness.buildMode, display }, kernel, cases, errors: harness.errors,
        note: "Stepped headless code-word scans and actual candidate keyboard commands. Each browser sample begins at a captured model selection and checks the full model result, revision, bounded native input and zero exports. Key-to-frame-ready is an animation-frame scheduling proxy, including yielding/polling and both views; it is not physical input or display latency. Kernel advances exclude browser events/rendering and are not a per-turn browser latency guarantee. Full bidi/contextual-line geometry, native devices, retained memory and production budgets remain unqualified." }, null, 2));
    console.log(JSON.stringify({ kernel: kernel.map(c => ({ content: c.content, direction: c.direction, totalP95: c.totalMs.p95, advanceP95: c.advanceMs.p95 })),
        browser: cases.map(c => ({ name: c.name, proxyP95: c.keyToFrameReadyProxyMs.p95 })) }, null, 2));
} finally { await harness.close(); }
