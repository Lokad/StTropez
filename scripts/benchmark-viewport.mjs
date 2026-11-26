import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { openHarness } from "./browser-harness.mjs";
import { distribution, environment, sourceIdentity } from "./measurement.mjs";
import { corpusIds } from "../tests/fixtures/workloads.ts";

/** @typedef {ReturnType<Window["viewportFixture"]["snapshot"]>} ViewportState */
/** @typedef {{modelMs: number, frameReadyProxyMs: number, primary: ViewportState["primary"],
 * secondary: ViewportState["secondary"], length: number}} ViewportSample */

const harness = await openHarness();
try {
    await harness.page.goto("/viewport/");
    const ready = () =>
        harness.page.waitForFunction(() => {
            const state = window.viewportFixture?.snapshot();
            return (
                state &&
                state.primary.revision === state.document?.revision &&
                !state.primary.pending &&
                !state.secondary.pending
            );
        });
    await ready();
    assert.equal(
        await harness.page.locator("textarea").count(),
        0,
        "Native fallback satisfied the viewport measurement."
    );
    const cases = [];
    for (const corpus of corpusIds)
        for (const position of ["start", "middle", "end"]) {
            await harness.page.evaluate((corpus) => window.viewportFixture.load(corpus), corpus);
            await ready();
            const documentState = (await harness.page.evaluate(() => window.viewportFixture.snapshot())).document;
            assert.ok(documentState, "Viewport measurement requires a document.");
            const length = documentState.length;
            const offset = position === "start" ? 0 : position === "middle" ? Math.floor(length / 2) : length;
            await harness.page.evaluate((offset) => window.viewportFixture.reveal("primary", offset), offset);
            await ready();
            const samples = [];
            for (let index = 0; index < 23; index++) {
                const sample = await harness.page.evaluate(
                    (offset) =>
                        /** @type {Promise<ViewportSample>} */ (
                            new Promise((resolve, reject) => {
                                const before = window.viewportFixture.snapshot();
                                if (!before.document) throw new Error("Viewport measurement requires a document.");
                                const start = performance.now();
                                const result = window.viewportFixture.edit(before.document.revision, [
                                    { from: offset, to: offset, insert: "z" }
                                ]);
                                if (result.status !== "done") throw new Error("Viewport edit failed.");
                                const committed = performance.now();
                                const check = () => {
                                    const state = window.viewportFixture.snapshot();
                                    if (!state.document) {
                                        reject(new Error("Viewport document detached during measurement."));
                                        return;
                                    }
                                    if (
                                        state.primary.revision !== result.value ||
                                        state.secondary.revision !== result.value ||
                                        state.primary.pending ||
                                        state.secondary.pending
                                    ) {
                                        requestAnimationFrame(check);
                                        return;
                                    }
                                    resolve({
                                        modelMs: committed - start,
                                        frameReadyProxyMs: performance.now() - start,
                                        primary: state.primary,
                                        secondary: state.secondary,
                                        length: state.document.length
                                    });
                                };
                                requestAnimationFrame(check);
                            })
                        ),
                    offset + index
                );
                assert.equal(sample.length, length + index + 1);
                for (const view of [sample.primary, sample.secondary]) {
                    assert.ok(view.rows <= Math.ceil(view.height / view.lineHeight) + 10);
                    assert.ok(
                        view.readUnits <= view.rows * (Math.max(512, Math.ceil(view.width / view.columnWidth)) + 80)
                    );
                    assert.ok(Number.isFinite(view.lastRenderMs));
                }
                assert.equal(
                    await harness.page.evaluate(() =>
                        [...document.querySelectorAll(".st-viewport-row")].every(
                            (row) =>
                                row instanceof HTMLElement &&
                                row.textContent ===
                                    window.viewportFixture
                                        .range(Number(row.dataset.from), Number(row.dataset.to))
                                        .replaceAll("\r", "␍")
                        )
                    ),
                    true
                );
                if (index >= 3) samples.push(sample);
            }
            cases.push({
                corpus,
                position,
                initialLength: length,
                warmup: 3,
                measured: 20,
                modelMs: distribution(samples.map((sample) => sample.modelMs)),
                frameReadyProxyMs: distribution(samples.map((sample) => sample.frameReadyProxyMs)),
                primaryRenderMs: distribution(samples.map((sample) => sample.primary.lastRenderMs)),
                secondaryRenderMs: distribution(samples.map((sample) => sample.secondary.lastRenderMs)),
                samples
            });
        }
    assert.deepEqual(harness.errors, []);
    const display = await harness.page.locator("#primary .st-viewport").evaluate((element) => {
        const style = getComputedStyle(element);
        return {
            viewport: { width: innerWidth, height: innerHeight },
            devicePixelRatio,
            font: {
                family: style.fontFamily,
                size: style.fontSize,
                lineHeight: style.lineHeight,
                weight: style.fontWeight,
                style: style.fontStyle,
                ligatures: style.fontVariantLigatures,
                kerning: style.fontKerning,
                letterSpacing: style.letterSpacing
            },
            tabSize: style.tabSize
        };
    });
    const report = {
        schemaVersion: 2,
        created: new Date().toISOString(),
        source: await sourceIdentity(),
        environment: { ...environment(), browser: harness.browser.version(), buildMode: harness.buildMode, display },
        runtime: "bounded-read-only-viewport",
        activeViews: 2,
        cases,
        errors: harness.errors,
        note: "Programmatic range edits and a read-only DOM projection. Render timing covers geometry reads, indexed ranges and DOM writes; the frame-ready metric is an animation-frame scheduling proxy. No typing/input/IME or production-latency claim. UTF-16 fixed-pitch horizontal estimation remains unqualified for long shaped lines."
    };
    await mkdir("artifacts/bench/viewport", { recursive: true });
    await writeFile("artifacts/bench/viewport/latest.json", JSON.stringify(report, null, 2));
    console.log(
        JSON.stringify(
            cases.map((item) => ({
                corpus: item.corpus,
                position: item.position,
                renderP95: item.primaryRenderMs.p95,
                frameProxyP95: item.frameReadyProxyMs.p95,
                maxRows: Math.max(...item.samples.map((sample) => sample.primary.rows)),
                maxReadUnits: Math.max(...item.samples.map((sample) => sample.primary.readUnits))
            })),
            null,
            2
        )
    );
} finally {
    await harness.close();
}
