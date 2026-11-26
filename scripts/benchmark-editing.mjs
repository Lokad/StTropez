import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { openHarness } from "./browser-harness.mjs";
import { distribution, environment, sourceIdentity } from "./measurement.mjs";
import { corpusIds } from "../tests/fixtures/workloads.ts";

/** @typedef {ReturnType<Window["editingFixture"]["snapshot"]>} EditingState */
/** @typedef {{beforeInputToFrameProxyMs: number, inputHandlerMs: number, inputEvents: number,
 * revisionDelta: number, length: number, primary: EditingState["primary"], secondary: EditingState["secondary"]}} InputObservation */
/** @typedef {typeof globalThis & {editingMeasurement: Promise<InputObservation>}} MeasurementGlobal */

const source = await sourceIdentity(),
    harness = await openHarness();
try {
    await harness.page.goto("/editing/");
    const ready = () =>
        harness.page.waitForFunction(() => {
            const state = window.editingFixture?.snapshot();
            return (
                state &&
                state.primary.viewport.revision === state.document?.revision &&
                state.secondary.viewport.revision === state.document?.revision &&
                !state.primary.viewport.pending &&
                !state.secondary.viewport.pending
            );
        });
    await ready();
    assert.equal(await harness.page.locator("textarea.st-input-context").count(), 2);
    const cases = [];
    for (const corpus of corpusIds)
        for (const position of ["start", "middle", "end"]) {
            await harness.page.evaluate((corpus) => window.editingFixture.load(corpus), corpus);
            await ready();
            const documentState = (await harness.page.evaluate(() => window.editingFixture.snapshot())).document;
            assert.ok(documentState, "Editing measurement requires a document.");
            const length = documentState.length;
            const offset = position === "start" ? 0 : position === "middle" ? Math.floor(length / 2) : length;
            await harness.page.evaluate((offset) => {
                window.editingFixture.select("primary", { anchor: offset, head: offset });
                window.editingFixture.focus("primary");
            }, offset);
            await ready();
            const samples = [];
            for (let index = 0; index < 23; index++) {
                await harness.page.evaluate(() => {
                    const input = document.querySelector("#primary textarea"),
                        before = window.editingFixture.snapshot();
                    if (!input || !before.document)
                        throw new Error("Editing measurement requires its input and document.");
                    const beforeDocument = before.document;
                    const offset = before.primary.selection.head;
                    /** @type {MeasurementGlobal} */ (globalThis).editingMeasurement = new Promise(
                        (resolve, reject) => {
                            /** @type {number} */ let start;
                            let readyFrames = 0;
                            const timeout = setTimeout(
                                () => reject(new Error("Candidate input measurement did not complete.")),
                                5000
                            );
                            input.addEventListener(
                                "beforeinput",
                                () => {
                                    start = performance.now();
                                },
                                { capture: true, once: true }
                            );
                            input.addEventListener(
                                "input",
                                () => {
                                    const check = () => {
                                        const state = window.editingFixture.snapshot();
                                        if (!state.document) {
                                            clearTimeout(timeout);
                                            reject(new Error("Editing document detached during input."));
                                            return;
                                        }
                                        if (
                                            state.primary.viewport.revision !== state.document.revision ||
                                            state.secondary.viewport.revision !== state.document.revision ||
                                            state.primary.viewport.pending ||
                                            state.secondary.viewport.pending
                                        ) {
                                            readyFrames = 0;
                                            requestAnimationFrame(check);
                                            return;
                                        }
                                        const expected = offset + 1;
                                        if (
                                            state.document.revision !== beforeDocument.revision + 1 ||
                                            state.primary.selection.anchor !== expected ||
                                            state.primary.selection.head !== expected ||
                                            window.editingFixture.range(expected - 1, expected) !== "z"
                                        ) {
                                            clearTimeout(timeout);
                                            reject(
                                                new Error("Input readiness had incorrect text, revision or selection.")
                                            );
                                            return;
                                        }
                                        const rendered = Array.from(
                                            document.querySelectorAll("#primary .st-viewport-row")
                                        ).some((row) => {
                                            const from = Number(row.getAttribute("data-from"));
                                            return (
                                                from <= offset &&
                                                offset < Number(row.getAttribute("data-to")) &&
                                                row.textContent?.[offset - from] === "z"
                                            );
                                        });
                                        readyFrames = rendered ? readyFrames + 1 : 0;
                                        if (readyFrames < 2) {
                                            requestAnimationFrame(check);
                                            return;
                                        }
                                        clearTimeout(timeout);
                                        resolve({
                                            beforeInputToFrameProxyMs: performance.now() - start,
                                            inputHandlerMs: state.primary.lastInputMs,
                                            inputEvents: state.primary.inputEvents - before.primary.inputEvents,
                                            revisionDelta: state.document.revision - beforeDocument.revision,
                                            length: state.document.length,
                                            primary: state.primary,
                                            secondary: state.secondary
                                        });
                                    };
                                    requestAnimationFrame(check);
                                },
                                { once: true }
                            );
                        }
                    );
                });
                const actionStart = performance.now();
                await harness.page.keyboard.type("z");
                const observation = await harness.page.evaluate(
                    () => /** @type {MeasurementGlobal} */ (globalThis).editingMeasurement
                );
                const completeActionProxyMs = performance.now() - actionStart;
                const sample = Object.assign(observation, { completeActionProxyMs });
                assert.equal(sample.inputEvents, 1);
                assert.equal(sample.revisionDelta, 1);
                assert.equal(sample.length, length + index + 1);
                assert.equal(
                    await harness.page.evaluate(
                        (offset) => window.editingFixture.range(offset, offset + 1),
                        offset + index
                    ),
                    "z"
                );
                assert.ok(Number.isFinite(sample.inputHandlerMs));
                assert.ok(Number.isFinite(sample.beforeInputToFrameProxyMs));
                for (const view of [sample.primary, sample.secondary]) {
                    assert.ok(view.inputUnits <= 2600);
                    assert.equal(view.conflicts, 0);
                    assert.ok(view.viewport.rows <= Math.ceil(view.viewport.height / view.viewport.lineHeight) + 10);
                    assert.ok(
                        view.viewport.readUnits <=
                            view.viewport.rows *
                                (Math.max(512, Math.ceil(view.viewport.width / view.viewport.columnWidth)) + 80)
                    );
                }
                if (index >= 3) samples.push(sample);
            }
            cases.push({
                corpus,
                position,
                initialLength: length,
                warmup: 3,
                measured: 20,
                inputHandlerMs: distribution(samples.map((sample) => sample.inputHandlerMs)),
                beforeInputToFrameProxyMs: distribution(samples.map((sample) => sample.beforeInputToFrameProxyMs)),
                completeActionProxyMs: distribution(samples.map((sample) => sample.completeActionProxyMs)),
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
    assert.equal((await sourceIdentity()).sha256, source.sha256);
    const report = {
        schemaVersion: 4,
        created: new Date().toISOString(),
        source,
        environment: { ...environment(), browser: harness.browser.version(), buildMode: harness.buildMode, display },
        runtime: "bounded-text-editor",
        activeViews: 2,
        features: { visibleLineTokens: true, find: "idle", provider: "connected; no pending requests" },
        cases,
        errors: harness.errors,
        note: "Input-handler time covers synchronous work in the editor's input listener. The frame proxy starts at beforeinput capture. Two consecutive animation frames must show the inserted character in the primary DOM row, the expected text and caret in the model, and both viewports at the committed revision. Complete-action time starts before the automation key call and includes transport through the same readiness check. Physical presentation requires a separate measurement."
    };
    await mkdir("artifacts/bench/editing", { recursive: true });
    await writeFile("artifacts/bench/editing/latest.json", JSON.stringify(report, null, 2));
    console.log(
        JSON.stringify(
            cases.map((item) => ({
                corpus: item.corpus,
                position: item.position,
                inputP95: item.inputHandlerMs.p95,
                frameProxyP95: item.beforeInputToFrameProxyMs.p95,
                completeActionP95: item.completeActionProxyMs.p95,
                maxInputUnits: Math.max(...item.samples.map((sample) => sample.primary.inputUnits))
            })),
            null,
            2
        )
    );
} finally {
    await harness.close();
}
