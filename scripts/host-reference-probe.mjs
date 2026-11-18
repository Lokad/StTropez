/**
 * @typedef {ReturnType<Window['hostFixture']['snapshot']>} HostState
 * @typedef {NonNullable<HostState['bindings']['comparison']>} Review
 * @typedef {'reference' | 'input' | 'command'} ObservationKind
 * @typedef {{kind: ObservationKind, operation?: 'identity' | 'independent', text?: string, replaceSelection?: boolean, caretOffset?: number}} ObservationOptions
 * @typedef {{revision: number, trusted: boolean, workingRenderedAt?: number, comparisonStatusAtRender?: Review['status'], caretPendingAtRender?: boolean}
 * & ({beforeinputAt: number, inputFinishedAt: number, inputHandlerMs: number, data: string,
 * keydownAt?: never, keydownFinishedAt?: never, keydownHandlerMs?: never, key?: never}
 * | {keydownAt: number, keydownFinishedAt: number, keydownHandlerMs: number, key: string,
 * beforeinputAt?: never, inputFinishedAt?: never, inputHandlerMs?: never, data?: never})} InputRecord
 * @typedef {{revision: number, beforeinputAt: number, inputFinishedAt: number, inputHandlerMs: number,
 * data: string | null, inputType: string, trusted: boolean, committed: boolean}} NativeInputRecord
 * @typedef {{generation: number, revision: number | undefined, steps: number, advances: number, totalStepMs: number,
 * maxStepMs: number, work: number, readUnits: number, observations: number, status?: Review['status']}} Generation
 * @typedef {'rendered' | 'scans' | 'caret' | 'drag' | 'input' | 'comparison' | 'reference'} Phase
 * @typedef {Partial<Record<`${Phase}At` | 'modelObservedAt', number>>} Phases
 * @typedef {{kind: ObservationKind, expectedText: string, caretOffset: number, start: number | undefined,
 * pendingStart: number | undefined, finished: boolean, failure: string | undefined, nativeInputUnits: number,
 * transactions: number, records: InputRecord[], inputEvents: NativeInputRecord[], phases: Phases, generations: Generation[], state: HostState}} Observation
 * @typedef {{kind: ObservationKind, transactions: number, insertedUnits: number, browserToFullReviewReadyProxyMs: number,
 * commandToFullReviewReadyProxyMs: number | null, lastInputToFullReviewReadyProxyMs: number | null,
 * lastInputFinishedToFullReviewReadyProxyMs: number | null, clickDispatchObservationMs: number | null,
 * phasesFromStartMs: Record<string, number>, phasesFromLastInputMs: Record<string, number> | null, inputDispatchSpanMs: number | null,
 * records: (InputRecord & {workingRenderProxyMs: number | null, supersededBeforeObservedWorkingReady: boolean})[],
 * inputEvents: NativeInputRecord[],
 * generations: (Generation & {supersededWhileObservedRunning: boolean})[], observedDiffBatchMs: number, observedDiffWork: number,
 * finalDiffBatch: Review['work'], finalDiffProgress: Review['progress'], referenceIsWorkingBuffer: boolean,
 * referenceVersion: NonNullable<Review['baseline']>['version'], referenceEpoch: number, referenceLabel: string | null,
 * hunks: Review['hunks'], revision: number, exports: number, rows: number[], readUnits: number[], inputUnits: number[],
 * comparisonInputUnits: number, backgroundUpdates: number, historyBefore: HostState['history'], historyAfter: HostState['history'],
 * replacement: {from: number, to: number} | null, primarySelection: HostState['bindings']['views'][number]['selection'],
 * secondarySelection: HostState['bindings']['views'][number]['selection']}} ObservationResult
 * @typedef {{isSourceReady(state?: HostState): boolean, waitSourceReady(): Promise<HostState>, isReady(state?: HostState): boolean,
 * waitReady(): Promise<HostState>, arm(options: ObservationOptions): void, read(): Promise<ObservationResult>,
 * snapshot(): Observation | undefined, abort(): void}} HostReferenceProbe
 */

/** Browser-side observations for the paired reference experiment. This function has no module captures. */
export function installHostReferenceProbe() {
    const fixture = window.hostFixture;
    /** @param {unknown} a @param {unknown} b */
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    /** @type {{promise: Promise<ObservationResult>, abort(): void, snapshot(): Observation} | undefined} */
    let active;
    const referenceLabel = () => [...document.querySelectorAll('.st-comparison[aria-label="Source review"] .st-comparison-panes h3')]
        .find(heading => heading.textContent?.startsWith("Baseline · "))?.textContent ?? null;
    // Share the browser fixtures' live-owner checks, including complete selections, folds,
    // both reference/working inputs, alignment and scroll. The remaining checks own this scene.
    const isSourceReady = (state = fixture.snapshot()) => fixture.settled === true && state.bindings.activeViews === 2
        && state.bindings.views.length === 2
        && state.bindings.views.every(v => v.metrics === null || v.metrics?.viewport.revision === state.source.revision)
        && (!state.bindings.comparison || state.bindings.comparison.status === "ready"
            && state.bindings.comparison.workingRevision === state.source.revision
            && referenceLabel() === `Baseline · ${state.bindings.comparison.baseline?.version}`);
    // Full candidate-review measurements require both candidate metrics and an actual review.
    const isReady = (state = fixture.snapshot()) => isSourceReady(state)
        && state.bindings.views.every(v => v.metrics != null) && state.bindings.comparison != null;
    // These phase observations retain their narrower clocks; only isReady gates completion.
    /** @param {HostState} state @returns {Record<Phase, boolean>} */
    const facts = state => {
        const c = state.bindings.comparison, views = state.bindings.views;
        const rendered = views.every(v => v.metrics && !v.metrics.viewport.pending && v.metrics.viewport.revision === state.source.revision
            && same(v.metrics.viewport.selection, v.selection)) && c && !c.workingViewport.pending
            && c.workingViewport.revision === state.source.revision && same(c.workingViewport.selection, c.selection);
        const scans = views.every(v => v.metrics && !v.metrics.pendingWord && !v.metrics.pendingGrapheme) && c && !c.input.pendingWord && !c.input.pendingGrapheme;
        const caret = views.every(v => v.metrics && !v.metrics.pendingCaret) && c && !c.input.pendingCaret;
        const drag = views.every(v => v.metrics && !v.metrics.pendingDragScroll) && c && !c.input.pendingDragScroll;
        const input = views.every(v => v.metrics && !v.metrics.pendingInput && !v.metrics.pendingCommand) && c && !c.input.pendingInput && !c.input.pendingCommand;
        const comparison = c?.status === "ready" && c.workingRevision === state.source.revision;
        const reference = c?.referenceViewport && !c.referenceViewport.pending && referenceLabel() === `Baseline · ${c.baseline?.version}`;
        return { rendered: !!rendered, scans: !!scans, caret: !!caret, drag: !!drag, input: !!input, comparison: !!comparison, reference: !!reference };
    };
    /** @param {(state: HostState) => boolean} predicate @param {string} scene @returns {Promise<HostState>} */
    function waitForReady(predicate, scene) {
        return new Promise((resolve, reject) => {
            let frames = 0, frame = 0;
            const timer = setTimeout(() => { cancelAnimationFrame(frame); reject(new Error(`Host ${scene} setup readiness timed out.`)); }, 20000);
            const check = () => { let state;
                try { state = fixture.snapshot(); frames = predicate(state) ? frames + 1 : 0; }
                catch (error) { clearTimeout(timer); reject(error); return; }
                if (frames < 2) { frame = requestAnimationFrame(check); return; }
                clearTimeout(timer); resolve(state);
            }; frame = requestAnimationFrame(check);
        });
    }
    const waitReady = () => waitForReady(isReady, "reference");
    const waitSourceReady = () => waitForReady(isSourceReady, "source");
    /** @param {ObservationOptions} options */
    function arm({ kind, operation, text = "", replaceSelection = false, caretOffset = text.length }) {
        active?.abort();
        const before = fixture.snapshot(), prior = before.bindings.views.find(v => v.id === "primary"), initial = before.bindings.comparison;
        const node = /** @type {HTMLTextAreaElement | null} */ (document.querySelector('textarea[aria-label="Primary source"]')), listeners = new AbortController();
        /** @type {(() => void)[]} */ const stops = [];
        /** @type {InputRecord[]} */ const records = [];
        /** @type {NativeInputRecord[]} */ const inputEvents = [];
        /** @type {Map<number, Generation>} */ const generations = new Map();
        /** @type {Phases} */ const phases = {};
        /** @type {number | undefined} */ let start;
        /** @type {number | undefined} */ let pendingStart;
        let inputText = "";
        /** @type {number | undefined} */ let dispatchEnd;
        /** @type {string | undefined} */ let failure;
        /** @type {(value: ObservationResult) => void} */ let resolve;
        /** @type {(error: Error) => void} */ let reject;
        let frame = 0, frames = 0, insertedUnits = 0, finished = false;
        const transactions = () => kind === "reference" ? 0 : kind === "command" ? 1 : records.length;
        /** @type {Promise<ObservationResult>} */
        const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
        // A later Playwright call awaits this promise; keep a timeout rejection handled in the meantime.
        promise.catch(() => {});
        const cleanup = () => { finished = true; listeners.abort(); stops.forEach(stop => stop()); cancelAnimationFrame(frame); clearTimeout(timer); };
        /** @param {string} message */
        const fail = message => { if (finished) return; failure = message; cleanup(); reject(new Error(message)); };
        /** @param {HostState} state */
        const ready = state => { try { return isReady(state); } catch (error) { fail(error instanceof Error ? error.message : String(error)); return false; } };
        const timer = setTimeout(() => fail(`Host reference ${kind} readiness timed out.`), 20000);
        active = { promise, abort: () => fail("Host reference observation superseded before completion."), snapshot: () => ({
            kind, expectedText: text, caretOffset, start, pendingStart, finished, failure, nativeInputUnits: insertedUnits, transactions: transactions(),
            records: records.map(record => ({ ...record })), inputEvents: inputEvents.map(record => ({ ...record })),
            phases: { ...phases }, generations: [...generations.values()].map(entry => ({ ...entry })),
            state: fixture.snapshot() }) };
        if (!["reference", "input", "command"].includes(kind) || kind !== "reference" && (!text.length || !Number.isSafeInteger(caretOffset) || caretOffset < 0 || caretOffset > text.length)) {
            fail("Invalid captured input observation."); return;
        }
        if (!prior?.metrics || !initial?.baseline) { fail("Reference experiment requires three ready bounded working views."); return; }
        const priorMetrics = prior.metrics, initialEpoch = initial.baseline.epoch, initialGeneration = initial.generation;
        const offset = replaceSelection ? Math.min(prior.selection.anchor, prior.selection.head) : prior.selection.head;
        const replacedUnits = replaceSelection ? Math.abs(prior.selection.anchor - prior.selection.head) : 0;
        /** @param {HostState} state */
        const model = state => state.source.revision === before.source.revision + transactions() && (kind === "reference"
            ? state.bindings.comparison?.baseline?.epoch === initialEpoch + 1
            : kind === "command" ? records.length === 1 && state.bindings.views.find(v => v.id === "primary")?.metrics?.commits === priorMetrics.commits + 1
            : insertedUnits === text.length && pendingStart === undefined);
        /** @param {HostState} state */
        function observeGeneration(state) {
            const c = state.bindings.comparison;
            if (!c || c.generation <= initialGeneration) return;
            /** @type {Generation} */
            const entry = generations.get(c.generation) ?? { generation: c.generation, revision: c.workingRevision,
                steps: 0, advances: 0, totalStepMs: 0, maxStepMs: 0, work: 0, readUnits: 0, observations: 0 };
            entry.status = c.status; entry.observations++;
            // Scheduler counters still describe the old generation until the new job's first batch.
            if (c.work.generation === c.generation) for (const key of /** @type {const} */ (["steps", "advances", "totalStepMs", "maxStepMs"]))
                entry[key] = Math.max(entry[key], c.work[key]);
            if (c.progress) for (const key of /** @type {const} */ (["work", "readUnits"])) entry[key] = Math.max(entry[key], c.progress[key]);
            generations.set(c.generation, entry);
        }
        /** @param {HostState} state @param {Record<Phase, boolean>} current */
        function observeWorking(state, current) {
            if (!current.rendered || !current.scans || !state.bindings.comparison) return;
            const record = records.find(r => r.revision === state.source.revision);
            if (record && record.workingRenderedAt === undefined) {
                record.workingRenderedAt = performance.now(); record.comparisonStatusAtRender = state.bindings.comparison.status;
                record.caretPendingAtRender = !current.caret;
            }
        }
        function observe() {
            if (finished || start === undefined) return;
            const state = fixture.snapshot(), current = facts(state); observeGeneration(state); observeWorking(state, current);
            if (!model(state)) return;
            const now = performance.now(); phases.modelObservedAt ??= now;
            for (const key of /** @type {const} */ (["rendered", "scans", "caret", "drag", "input", "comparison", "reference"])) if (current[key]) phases[`${key}At`] ??= now;
        }
        // The immutable reference has its own candidate surface; observe the three working inputs here.
        const roots = [...document.querySelectorAll(".st-editor")].filter(root => root.querySelector("textarea")?.readOnly === false);
        if (roots.length !== 3 || !ready(before) || !node) { fail("Reference experiment requires three ready bounded working views."); return; }
        for (const id of /** @type {const} */ (["primary", "secondary", "comparison"])) stops.push(fixture.onSourceRender(id, observe));
        if (kind === "reference") {
            const label = operation === "identity" ? "Finish review acceptance" : "Finish reference refresh";
            const button = [...document.querySelectorAll("button")].find(b => b.textContent === label);
            if (!button) { fail("Missing captured reference completion command."); return; }
            button.addEventListener("click", () => { start = performance.now(); }, { capture: true, once: true, signal: listeners.signal });
            // React delegates at its root; document bubbling observes both hosts after their handlers.
            document.addEventListener("click", event => { if (event.target === button) { dispatchEnd = performance.now(); observe(); } }, { signal: listeners.signal });
        } else {
            if ((!replaceSelection && prior.selection.anchor !== offset) || node.ownerDocument.activeElement !== node) { fail("Input experiment requires its captured source selection and focus."); return; }
            node.addEventListener("blur", () => fail("Reference experiment input lost focus."), { signal: listeners.signal });
            if (kind === "command") {
                node.addEventListener("keydown", event => {
                    if (event.key !== "Enter" || !event.isTrusted || start !== undefined) { fail("Expected one trusted Enter command."); return; }
                    start = performance.now(); observeGeneration(fixture.snapshot());
                }, { capture: true, signal: listeners.signal });
                node.addEventListener("keydown", event => {
                    if (finished) return;
                    const state = fixture.snapshot(), view = state.bindings.views.find(v => v.id === "primary");
                    if (start === undefined || !view?.metrics || !event.defaultPrevented || view.metrics.keydownEvents !== priorMetrics.keydownEvents + 1) { fail("Enter was not handled by the captured editor."); return; }
                    records.push({ revision: before.source.revision + 1, keydownAt: start, keydownFinishedAt: performance.now(), keydownHandlerMs: view.metrics.lastKeydownMs,
                        key: event.key, trusted: event.isTrusted }); observe();
                }, { signal: listeners.signal });
                for (const type of ["beforeinput", "input"]) node.addEventListener(type, () => fail("Handled Enter unexpectedly used native input."), { signal: listeners.signal });
            } else {
                node.addEventListener("beforeinput", event => {
                    pendingStart = performance.now(); start ??= pendingStart; observeGeneration(fixture.snapshot());
                    inputText = event.data ?? "";
                    if (event.inputType !== "insertText") fail(`Expected native insertText; received ${event.inputType}.`);
                }, { capture: true, signal: listeners.signal });
                node.addEventListener("input", () => observeGeneration(fixture.snapshot()), { capture: true, signal: listeners.signal });
                node.addEventListener("input", event => {
                    const input = /** @type {InputEvent} */ (event);
                    const state = fixture.snapshot(), view = state.bindings.views.find(v => v.id === "primary");
                    const committed = state.source.revision === before.source.revision + records.length + 1;
                    const count = records.length + (committed ? 1 : 0), origin = pendingStart ?? records.at(-1)?.beforeinputAt;
                    // A browser can fragment one payload into several input events. Count
                    // model commits independently and validate their complete captured text.
                    const units = state.source.length - before.source.length + replacedUnits;
                    // WebKit labels newline fragments insertParagraph even though the
                    // captured intention was one multiline insertText (also for a leading LF).
                    const fragment = input.inputType === "insertText" || input.inputType === "insertParagraph" && inputText.includes("\n");
                    if (!view?.metrics || origin === undefined || units > text.length || !fragment
                        || (committed ? pendingStart === undefined || units <= insertedUnits : pendingStart !== undefined || !records.length || units !== insertedUnits)
                        || state.source.id !== before.source.id || view.viewId !== prior.viewId || state.source.revision !== before.source.revision + count
                        || view.selection.anchor !== offset + units || view.selection.head !== offset + units
                        || fixture.range(offset, offset + units) !== text.slice(0, units) || view.metrics.inputEvents !== priorMetrics.inputEvents + inputEvents.length + 1
                        || view.metrics.commits !== priorMetrics.commits + count || view.metrics.inputUnits > 2600) { fail("Incorrect reference experiment input result."); return; }
                    const sample = { revision: state.source.revision, beforeinputAt: origin, inputFinishedAt: performance.now(),
                        inputHandlerMs: view.metrics.lastInputMs, data: input.data, inputType: input.inputType, trusted: event.isTrusted };
                    inputEvents.push({ ...sample, committed });
                    if (committed) {
                        records.push({ ...sample, data: text.slice(insertedUnits, units) });
                        insertedUnits = units; pendingStart = undefined;
                    }
                    observe();
                }, { signal: listeners.signal });
            }
        }
        const check = () => {
            if (finished) return; observe(); const state = fixture.snapshot(), c = state.bindings.comparison;
            frames = start !== undefined && model(state) && ready(state) ? frames + 1 : 0;
            if (finished) return;
            if (frames < 2) { frame = requestAnimationFrame(check); return; }
            const primary = state.bindings.views.find(v => v.id === "primary"), secondary = state.bindings.views.find(v => v.id === "secondary");
            const metrics = state.bindings.views.map(v => v.metrics), lastRecord = records.at(-1), lastInputFinishedAt = inputEvents.at(-1)?.inputFinishedAt;
            if (start === undefined || !c?.baseline || !c.referenceViewport || !primary?.metrics || !secondary?.metrics || !metrics.every(metric => metric !== null)
                || kind === "input" && lastInputFinishedAt === undefined) { fail("Reference observation lost its captured review metrics."); return; }
            const startedAt = start;
            if (state.source.id !== before.source.id || state.bindings.mounts !== before.bindings.mounts || c.viewId !== initial.viewId
                || kind !== "reference" && (document.activeElement !== node || state.source.exports !== 0)
                || kind === "reference" && (state.source.length !== before.source.length || !same(state.history, before.history) || dispatchEnd === undefined)) {
                fail("Reference observation changed ownership, history, export count or focus."); return;
            }
            if (kind === "command") {
                const view = primary, viewMetrics = primary.metrics;
                if (view.viewId !== prior.viewId || state.source.length !== before.source.length - replacedUnits + text.length
                    || fixture.range(offset, offset + text.length) !== text || view.selection.anchor !== offset + caretOffset || view.selection.head !== offset + caretOffset
                    || viewMetrics.inputEvents !== priorMetrics.inputEvents || viewMetrics.beforeInputEvents !== priorMetrics.beforeInputEvents
                    || viewMetrics.inputUnits > 2600) { fail("Incorrect handled Enter text, selection or event counters."); return; }
            } else if (kind === "input" && (primary.viewId !== prior.viewId
                || state.source.length !== before.source.length - replacedUnits + text.length || fixture.range(offset, offset + text.length) !== text
                || primary.selection.anchor !== offset + text.length || primary.selection.head !== offset + text.length
                || primary.metrics.inputEvents !== priorMetrics.inputEvents + inputEvents.length || primary.metrics.commits !== priorMetrics.commits + records.length)) {
                fail("Native input changed after its captured commit."); return;
            }
            const now = performance.now(), lastStart = lastRecord?.beforeinputAt ?? startedAt;
            const observed = [...generations.values()].map(entry => ({ ...entry,
                supersededWhileObservedRunning: entry.generation !== c.generation && entry.status === "running" }));
            if (observed.length !== (kind === "reference" ? 1 : transactions()) || c.work.generation !== c.generation) { fail("Missing or misattributed comparison generation observations."); return; }
            const rows = [...metrics.map(metric => metric.viewport.rows), c.workingViewport.rows, c.referenceViewport.rows];
            const readUnits = [...metrics.map(metric => metric.viewport.readUnits), c.workingViewport.readUnits, c.referenceViewport.readUnits];
            cleanup(); resolve({ kind, transactions: transactions(), insertedUnits: kind === "reference" ? 0 : text.length,
                browserToFullReviewReadyProxyMs: now - startedAt, commandToFullReviewReadyProxyMs: kind === "command" ? now - startedAt : null,
                lastInputToFullReviewReadyProxyMs: kind === "input" ? now - lastStart : null,
                lastInputFinishedToFullReviewReadyProxyMs: kind === "input" && lastInputFinishedAt !== undefined ? now - lastInputFinishedAt : null,
                clickDispatchObservationMs: dispatchEnd === undefined ? null : dispatchEnd - startedAt,
                phasesFromStartMs: Object.fromEntries(Object.entries(phases).map(([key, at]) => [key, at - startedAt])),
                phasesFromLastInputMs: kind === "input" ? Object.fromEntries(Object.entries(phases).map(([key, at]) => [key, at - lastStart])) : null,
                inputDispatchSpanMs: kind === "input" ? lastStart - startedAt : null,
                records: records.map(record => ({ ...record, workingRenderProxyMs: record.workingRenderedAt === undefined ? null : record.workingRenderedAt - (record.beforeinputAt ?? record.keydownAt),
                    supersededBeforeObservedWorkingReady: record.workingRenderedAt === undefined })),
                inputEvents: inputEvents.map(record => ({ ...record })),
                generations: observed, observedDiffBatchMs: observed.reduce((n, entry) => n + entry.totalStepMs, 0),
                observedDiffWork: observed.reduce((n, entry) => n + entry.work, 0), finalDiffBatch: c.work, finalDiffProgress: c.progress,
                referenceIsWorkingBuffer: c.referenceIsWorkingBuffer, referenceVersion: c.baseline.version, referenceEpoch: c.baseline.epoch,
                referenceLabel: referenceLabel(), hunks: c.hunks, revision: state.source.revision, exports: state.source.exports,
                rows, readUnits, inputUnits: metrics.map(metric => metric.inputUnits), comparisonInputUnits: c.input.inputUnits,
                backgroundUpdates: state.activity.background - before.activity.background, historyBefore: before.history, historyAfter: state.history,
                replacement: replaceSelection ? { from: offset, to: offset + replacedUnits } : null,
                primarySelection: primary.selection, secondarySelection: secondary.selection });
        }; frame = requestAnimationFrame(check);
    }
    window.hostReferenceProbe = Object.freeze({ isSourceReady, waitSourceReady, isReady, waitReady, arm,
        read: () => { if (!active) throw new Error("No host reference observation is armed."); return active.promise; },
        snapshot: () => active?.snapshot(), abort: () => active?.abort() });
}
