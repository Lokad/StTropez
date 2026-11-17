import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { openHarness } from "./browser-harness.mjs";
import { environment, sourceIdentity } from "./measurement.mjs";

// A separate diagnostic run: tracing overhead must not contaminate baseline samples.
const harness = await openHarness();
try {
    await harness.page.goto("/workspace/");
    await harness.page.waitForFunction(() => window.sttropez?.ready === true);
    await harness.page.evaluate(() => window.sttropez.loadCorpus("lines-100000"));
    const input = harness.page.getByRole("textbox", { name: "Transform source" });
    await input.focus();
    await input.press("Control+Home");
    const cdp = await harness.page.context().newCDPSession(harness.page);
    const completed = new Promise(resolve => cdp.once("Tracing.tracingComplete", resolve));
    await cdp.send("Tracing.start", { categories: "devtools.timeline", transferMode: "ReturnAsStream" });
    const count = await harness.page.evaluate(() => window.sttropez.sampleCount());
    await input.pressSequentially("xxxxx");
    await harness.page.waitForFunction(count => window.sttropez.sampleCount() >= count + 5, count);
    await cdp.send("Tracing.end");
    const { stream } = await completed;
    const chunks = [];
    try {
        for (;;) {
            const chunk = await cdp.send("IO.read", { handle: stream });
            chunks.push(Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8"));
            if (chunk.eof) break;
        }
    } finally { await cdp.send("IO.close", { handle: stream }); }
    const trace = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const phases = {};
    for (const name of ["Layout", "Paint", "PrePaint", "UpdateLayoutTree", "EventDispatch"]) {
        phases[name] = trace.traceEvents.filter(event => event.name === name && event.ph === "X")
            .map(({ ts, dur, pid, tid }) => ({ timestampUs: ts, durationUs: dur, process: pid, thread: tid }));
    }
    assert.ok(phases.Layout.length && phases.Paint.length, "Trace did not exercise layout and paint.");
    assert.equal((await input.inputValue()).startsWith("xxxxx"), true);
    assert.deepEqual(harness.errors, []);
    await mkdir("artifacts/bench", { recursive: true });
    // Keep only timings by default; the raw trace can contain source text and URLs.
    await writeFile("artifacts/bench/phases.json", JSON.stringify({ schemaVersion: 1, source: await sourceIdentity(),
        created: new Date().toISOString(), environment: { ...environment(), browser: harness.browser.version(), buildMode: harness.buildMode },
        corpus: "lines-100000", measuredInputs: 5, phases,
        note: "Diagnostic trace durations include tracing overhead. Events may nest; do not add phases or infer physical display latency. No content/raw trace exported." }, null, 2));
    console.log("Layout and paint attribution recorded in artifacts/bench/phases.json");
} finally { await harness.close(); }
