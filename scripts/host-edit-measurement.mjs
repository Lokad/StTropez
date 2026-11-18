import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { distribution } from "./measurement.mjs";
import { typeHostSuffix } from "./host-typing.mjs";

/**
 * @typedef {import('./host-reference-probe.mjs').ObservationResult} ObservationResult
 * @typedef {ObservationResult & {completeActionProxyMs: number, history: Awaited<ReturnType<typeof typeHostSuffix>> | null}} MeasuredEdit
 * @typedef {{kind: ObservationResult['kind'], records: {beforeinputAt?: number, keydownHandlerMs?: number, inputHandlerMs?: number,
 * workingRenderProxyMs: number | null, supersededBeforeObservedWorkingReady: boolean}[], inputEvents: {inputHandlerMs: number}[],
 * commandToFullReviewReadyProxyMs: number | null, browserToFullReviewReadyProxyMs: number,
 * lastInputToFullReviewReadyProxyMs: number | null, completeActionProxyMs: number}} EditSummaryInput
 */

/**
 * Node-side driver; browser handler/readiness clocks remain in the captured shared probe.
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} input
 * @param {string} text
 * @param {string} mode
 * @param {(result: MeasuredEdit) => void} observed
 */
export async function measureHostEdit(page, input, text, mode, observed) {
    await page.evaluate(({ text, mode }) => window.hostReferenceProbe.arm({ kind: mode === "cold-newline" ? "command" : "input", text }), { text, mode });
    /** @type {number | undefined} */ let started;
    let history;
    if (mode === "cold-newline") { started = performance.now(); await input.press("Enter"); }
    else history = await typeHostSuffix(input, text, () => { started = performance.now(); return page.keyboard.type(text, { delay: mode === "sustained" ? 8 : 0 }); });
    const sample = await page.evaluate(() => window.hostReferenceProbe.read());
    assert.ok(started !== undefined);
    const result = { ...sample, completeActionProxyMs: performance.now() - started, history: history ?? null }; observed(result);
    assert.equal(result.records.length, result.transactions); assert.equal(result.generations.length, result.transactions);
    if (mode === "cold-newline") assert.equal(result.transactions, 1);
    assert.equal(result.insertedUnits, text.length);
    assert.ok(result.rows.every(n => n < 100)); assert.ok(result.readUnits.every(n => n < 20000));
    assert.ok(result.inputUnits.every(n => n <= 2600)); assert.ok(result.comparisonInputUnits <= 2600);
    const last = result.records.at(-1), generation = result.generations.at(-1); assert.ok(last && generation && result.finalDiffProgress);
    assert.equal(result.exports, 0); assert.equal(last.supersededBeforeObservedWorkingReady, false);
    assert.equal(generation.status, "ready");
    assert.equal(generation.steps, result.finalDiffBatch.steps);
    assert.equal(generation.totalStepMs, result.finalDiffBatch.totalStepMs);
    assert.equal(generation.work, result.finalDiffProgress.work);
    assert.ok(result.observedDiffBatchMs >= result.finalDiffBatch.totalStepMs);
    return result;
}

/**
 * Native event samples include dispatches that make no additional model commit.
 * @param {Pick<EditSummaryInput, 'kind' | 'records' | 'inputEvents'>} sample
 * @returns {{keydownHandlerMs?: number, inputHandlerMs?: number}[]}
 */
export const hostEditEventSamples = sample => sample.kind === "command" ? sample.records : sample.inputEvents;

/** @param {number | null | undefined} value */
function measured(value) { assert.ok(value !== null && value !== undefined, "Missing applicable measurement."); return value; }

/**
 * Keep command and native-input fields separate; inapplicable clocks are explicitly null.
 * @param {EditSummaryInput[]} samples
 */
export function summarizeHostEdits(samples) {
    const command = samples[0]?.kind === "command";
    assert.ok(samples.length && samples.every(sample => sample.kind === (command ? "command" : "input")), "Do not pool command and native-input clocks.");
    const handlers = samples.flatMap(sample => hostEditEventSamples(sample).map(record => measured(command ? record.keydownHandlerMs : record.inputHandlerMs)));
    const working = samples.flatMap(sample => sample.records.flatMap(record => record.workingRenderProxyMs === null ? [] : [record.workingRenderProxyMs]));
    const cadence = command ? [] : samples.flatMap(sample => sample.records.slice(1).map((record, i) => measured(record.beforeinputAt) - measured(sample.records[i]?.beforeinputAt)));
    return {
        handlerKind: command ? "keydown" : "input",
        keydownHandlerMs: command ? distribution(handlers) : null, keydownHandlerMaxMs: command ? Math.max(...handlers) : null,
        inputHandlerMs: command ? null : distribution(handlers), inputHandlerMaxMs: command ? null : Math.max(...handlers),
        observedWorkingRenderProxyMs: distribution(working), actualInputGapMs: cadence.length ? distribution(cadence) : null,
        commandToFullReviewReadyProxyMs: command ? distribution(samples.map(sample => measured(sample.commandToFullReviewReadyProxyMs))) : null,
        inputToFullReviewReadyProxyMs: command ? null : distribution(samples.map(sample => sample.browserToFullReviewReadyProxyMs)),
        lastInputToFullReviewReadyProxyMs: command ? null : distribution(samples.map(sample => measured(sample.lastInputToFullReviewReadyProxyMs))),
        completeActionProxyMs: distribution(samples.map(sample => sample.completeActionProxyMs)),
        supersededBeforeObservedWorkingReady: samples.reduce((count, sample) => count + sample.records.filter(record => record.supersededBeforeObservedWorkingReady).length, 0),
    };
}
