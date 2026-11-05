import { mkdir, writeFile } from "node:fs/promises";
import { cpus, platform, arch } from "node:os";
import { execFileSync } from "node:child_process";
import { openHarness } from "./browser-harness.mjs";

function percentile(samples, fraction) {
    const sorted = [...samples].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}
const harness = await openHarness();
try {
    const scenarios = [];
    for (const lines of [100, 10_000, 100_000]) {
        await harness.page.evaluate(lines => window.sttropez.loadSynthetic(lines), lines);
        const input = harness.page.getByRole("textbox", { name: "Transform source" });
        await input.focus();
        await input.press("Control+Home");
        const samples = [];
        // Warm up the browser, then retain each raw sample. The metric is a frame scheduling proxy.
        for (let index = 0; index < 25; index++) {
            const count = await harness.page.evaluate(() => window.sttropez.frameSamples().length);
            await input.pressSequentially("x");
            await harness.page.waitForFunction(count => window.sttropez.frameSamples().length > count, count);
            if (index >= 5) samples.push(await harness.page.evaluate(() => window.sttropez.frameSamples().at(-1)));
        }
        const state = await harness.page.evaluate(() => window.sttropez.snapshot());
        if (state.documents[0]?.length !== lines * "const sample = 123456789;\n".length + 25) {
            throw new Error("Benchmark did not perform the expected document edits.");
        }
        scenarios.push({ lines, samples, p50: percentile(samples, .5), p95: percentile(samples, .95) });
    }
    let commit = "uncommitted";
    try { commit = execFileSync("git", ["rev-parse", "--verify", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* New repositories have no commit. */ }
    const report = { schemaVersion: 1, created: new Date().toISOString(), commit,
        runtime: "native-textarea-baseline", metric: "input-capture-to-second-animation-frame-ms",
        note: "Frame scheduling proxy, not physical presentation latency. Includes active playground subscribers. No production performance claim.",
        environment: { browser: harness.browser.version(), node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model, viewport: { width: 1440, height: 900 } },
        scenarios, errors: harness.errors };
    await mkdir("artifacts/bench", { recursive: true });
    await writeFile("artifacts/bench/latest.json", JSON.stringify(report, null, 2));
    if (harness.errors.length) throw new Error(harness.errors.join("\n"));
    console.log(JSON.stringify(scenarios.map(({ lines, p50, p95 }) => ({ lines, p50, p95 })), null, 2));
} finally { await harness.close(); }
