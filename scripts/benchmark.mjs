import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { openHarness } from "./browser-harness.mjs";
import { corpus, corpusIds, workloadSeed } from "../fixtures/workloads.ts";
import { distribution, environment, sourceIdentity } from "./measurement.mjs";
import { benchmarkModel } from "./benchmark-model.mjs";

// Keep model and browser runs sequential to avoid cross-contaminating timing.
const model = await benchmarkModel();
await mkdir("artifacts/bench", { recursive: true });
await writeFile("artifacts/bench/model.json", JSON.stringify(model, null, 2));
const harness = await openHarness();
try {
    const startup = [await harness.page.evaluate(() => window.sttropez.readyAt)];
    for (let run = 0; run < 2; run++) {
        await harness.page.reload();
        await harness.page.waitForFunction(() => window.sttropez?.ready === true);
        startup.push(await harness.page.evaluate(() => window.sttropez.readyAt));
    }
    const cdp = await harness.page.context().newCDPSession(harness.page);
    await cdp.send("Performance.enable");
    const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]));
    const scenarios = [];
    for (const id of corpusIds) {
        for (const position of ["start", "middle", "end"]) {
            await harness.page.evaluate(id => window.sttropez.loadCorpus(id), id);
            const input = harness.page.getByRole("textbox", { name: "Transform source" });
            await input.focus();
            const original = corpus(id);
            // Native rendering uses LF coordinates; range transactions preserve untouched model CRLF.
            const normalized = original.replaceAll("\r\n", "\n");
            const offset = position === "start" ? 0 : position === "end" ? normalized.length : Math.floor(normalized.length / 2);
            await input.evaluate((input, offset) => input.setSelectionRange(offset, offset), offset);
            const frameSamples = [], handlerSamples = [];
            let before;
            for (let index = 0; index < 25; index++) {
                if (index === 5) before = await metrics();
                const previous = await harness.page.evaluate(() => window.sttropez.sampleCount());
                await input.pressSequentially("z");
                await harness.page.waitForFunction(previous => window.sttropez.sampleCount() > previous, previous);
                if (index >= 5) {
                    frameSamples.push(await harness.page.evaluate(() => window.sttropez.frameSamples().at(-1)));
                    handlerSamples.push(await harness.page.evaluate(() => window.sttropez.handlerSamples().at(-1)));
                }
            }
            const after = await metrics();
            const layoutTotal = (after.LayoutDuration - before.LayoutDuration) * 1_000;
            const styleTotal = (after.RecalcStyleDuration - before.RecalcStyleDuration) * 1_000;
            assert.ok(Number.isFinite(layoutTotal) && layoutTotal >= 0, "Missing/invalid layout counter.");
            assert.ok(Number.isFinite(styleTotal) && styleTotal >= 0, "Missing/invalid style counter.");
            assert.equal(await input.inputValue(), normalized.slice(0, offset) + "z".repeat(25) + normalized.slice(offset));
            assert.equal((await harness.page.evaluate(() => window.sttropez.snapshot())).documents[0].length, original.length + 25);
            scenarios.push({ corpus: id, position, length: original.length, nativeLength: normalized.length, warmup: 5, measured: 20,
                inputHandlerMs: distribution(handlerSamples), secondFrameProxyMs: distribution(frameSamples),
                browserWork: { unit: "ms", measuredInputs: 20,
                    layoutTotal, styleTotal,
                    note: "CDP cumulative counter deltas, includes native input and intervening harness work; not per-event percentiles or paint latency." } });
        }
    }
    const font = await harness.page.getByRole("textbox", { name: "Transform source", exact: true }).evaluate(element => { const style = getComputedStyle(element);
        return { font: style.font, tabSize: style.tabSize, wrapping: element.wrap, devicePixelRatio }; });
    const report = { schemaVersion: 2, created: new Date().toISOString(), source: await sourceIdentity(), seed: workloadSeed,
        runtime: "native-textarea-with-piece-tree-history", buildMode: "development-bundle", activeTextViews: 2, environment: { ...environment(), browser: harness.browser.version(), viewport: { width: 1440, height: 900 }, font },
        startupNavigationToReadyMs: distribution(startup),
        notes: ["Input-handler capture-to-bubble includes model/subscribers, excludes native work before dispatch.",
            "Second-animation-frame metric is a scheduling proxy, not paint or physical presentation latency.",
            "Startup includes navigation, parse and mount; three runs are diagnostic, not a cold-cache percentile claim.",
            "Paint attribution is collected separately with npm run bench:trace. No production performance guarantee."],
        scenarios, errors: harness.errors };
    assert.deepEqual(harness.errors, []);
    await writeFile("artifacts/bench/latest.json", JSON.stringify(report, null, 2));
    console.log(JSON.stringify(scenarios.map(({ corpus, position, inputHandlerMs, secondFrameProxyMs }) =>
        ({ corpus, position, handlerP95: inputHandlerMs.p95, frameProxyP95: secondFrameProxyMs.p95 })), null, 2));
} finally { await harness.close(); }
