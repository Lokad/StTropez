/** Browser-side observations for the paired reference experiment. This function has no module captures. */
export function installHostReferenceProbe() {
    const fixture = window.hostFixture, same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
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
    const facts = state => {
        const c = state.bindings.comparison, views = state.bindings.views;
        const rendered = views.every(v => v.metrics && !v.metrics.viewport.pending && v.metrics.viewport.revision === state.source.revision
            && same(v.metrics.viewport.selection, v.selection)) && c && !c.workingViewport.pending
            && c.workingViewport.revision === state.source.revision && same(c.workingViewport.selection, c.selection);
        const scans = views.every(v => !v.metrics.pendingWord && !v.metrics.pendingGrapheme) && c && !c.input.pendingWord && !c.input.pendingGrapheme;
        const caret = views.every(v => !v.metrics.pendingCaret) && c && !c.input.pendingCaret;
        const drag = views.every(v => !v.metrics.pendingDragScroll) && c && !c.input.pendingDragScroll;
        const input = views.every(v => !v.metrics.pendingInput && !v.metrics.pendingCommand) && c && !c.input.pendingInput && !c.input.pendingCommand;
        const comparison = c?.status === "ready" && c.workingRevision === state.source.revision;
        const reference = c?.referenceViewport && !c.referenceViewport.pending && referenceLabel() === `Baseline · ${c.baseline?.version}`;
        return { rendered: !!rendered, scans: !!scans, caret: !!caret, drag: !!drag, input: !!input, comparison: !!comparison, reference: !!reference };
    };
    function waitForReady(predicate, scene) {
        return new Promise((resolve, reject) => {
            let frames = 0, frame;
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
    function arm({ kind, operation, text = "", replaceSelection = false, caretOffset = text.length }) {
        active?.abort();
        const before = fixture.snapshot(), prior = before.bindings.views.find(v => v.id === "primary"), initial = before.bindings.comparison;
        const node = document.querySelector('textarea[aria-label="Primary source"]'), listeners = new AbortController(), stops = [], records = [], generations = new Map(), phases = {};
        const offset = replaceSelection ? Math.min(prior.selection.anchor, prior.selection.head) : prior.selection.head;
        const replacedUnits = replaceSelection ? Math.abs(prior.selection.anchor - prior.selection.head) : 0;
        let start, pendingStart, dispatchEnd, frame, frames = 0, insertedUnits = 0, finished = false, failure, resolve, reject;
        const transactions = () => kind === "reference" ? 0 : kind === "command" ? 1 : records.length;
        const model = state => state.source.revision === before.source.revision + transactions() && (kind === "reference"
            ? state.bindings.comparison.baseline?.epoch === initial.baseline.epoch + 1
            : kind === "command" ? records.length === 1 && state.bindings.views.find(v => v.id === "primary").metrics.commits === prior.metrics.commits + 1
            : insertedUnits === text.length);
        const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
        // A later Playwright call awaits this promise; keep a timeout rejection handled in the meantime.
        promise.catch(() => {});
        const cleanup = () => { finished = true; listeners.abort(); stops.forEach(stop => stop()); cancelAnimationFrame(frame); clearTimeout(timer); };
        const fail = message => { if (finished) return; failure = message; cleanup(); reject(new Error(message)); };
        const ready = state => { try { return isReady(state); } catch (error) { fail(String(error?.message ?? error)); return false; } };
        const timer = setTimeout(() => fail(`Host reference ${kind} readiness timed out.`), 20000);
        active = { promise, abort: () => fail("Host reference observation superseded before completion."), snapshot: () => ({
            kind, expectedText: text, caretOffset, start, pendingStart, finished, failure, nativeInputUnits: insertedUnits, transactions: transactions(),
            records: records.map(record => ({ ...record })), phases: { ...phases }, generations: [...generations.values()].map(entry => ({ ...entry })),
            state: fixture.snapshot() }) };
        if (!["reference", "input", "command"].includes(kind) || kind !== "reference" && (!text.length || !Number.isSafeInteger(caretOffset) || caretOffset < 0 || caretOffset > text.length)) {
            fail("Invalid captured input observation."); return;
        }
        function observeGeneration(state) {
            const c = state.bindings.comparison;
            if (!c || c.generation <= initial.generation) return;
            const entry = generations.get(c.generation) ?? { generation: c.generation, revision: c.workingRevision,
                steps: 0, advances: 0, totalStepMs: 0, maxStepMs: 0, work: 0, readUnits: 0, observations: 0 };
            entry.status = c.status; entry.observations++;
            // Scheduler counters still describe the old generation until the new job's first batch.
            if (c.work.generation === c.generation) for (const key of ["steps", "advances", "totalStepMs", "maxStepMs"])
                entry[key] = Math.max(entry[key], c.work[key]);
            if (c.progress) for (const key of ["work", "readUnits"]) entry[key] = Math.max(entry[key], c.progress[key]);
            generations.set(c.generation, entry);
        }
        function observeWorking(state, current) {
            if (!current.rendered || !current.scans) return;
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
            for (const key of ["rendered", "scans", "caret", "drag", "input", "comparison", "reference"]) if (current[key]) phases[`${key}At`] ??= now;
        }
        // The immutable reference has its own candidate surface; observe the three working inputs here.
        const roots = [...document.querySelectorAll(".st-editor")].filter(root => root.querySelector("textarea")?.readOnly === false);
        if (roots.length !== 3 || !ready(before) || !node) { fail("Reference experiment requires three ready bounded working views."); return; }
        for (const id of ["primary", "secondary", "comparison"]) stops.push(fixture.onSourceRender(id, observe));
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
                    if (!event.defaultPrevented || view.metrics.keydownEvents !== prior.metrics.keydownEvents + 1) { fail("Enter was not handled by the captured editor."); return; }
                    records.push({ revision: before.source.revision + 1, keydownAt: start, keydownFinishedAt: performance.now(), keydownHandlerMs: view.metrics.lastKeydownMs,
                        key: event.key, trusted: event.isTrusted }); observe();
                }, { signal: listeners.signal });
                for (const type of ["beforeinput", "input"]) node.addEventListener(type, () => fail("Handled Enter unexpectedly used native input."), { signal: listeners.signal });
            } else {
                node.addEventListener("beforeinput", event => {
                    pendingStart = performance.now(); start ??= pendingStart; observeGeneration(fixture.snapshot());
                    if (event.inputType !== "insertText") fail(`Expected native insertText; received ${event.inputType}.`);
                }, { capture: true, signal: listeners.signal });
                node.addEventListener("input", () => observeGeneration(fixture.snapshot()), { capture: true, signal: listeners.signal });
                node.addEventListener("input", event => {
                    const state = fixture.snapshot(), view = state.bindings.views.find(v => v.id === "primary"), count = records.length + 1;
                    const units = insertedUnits + (event.data?.length ?? 0);
                    if (pendingStart === undefined || !event.data?.length || units > text.length || event.inputType !== "insertText"
                        || state.source.id !== before.source.id || view.viewId !== prior.viewId || state.source.revision !== before.source.revision + count
                        || state.source.length !== before.source.length - replacedUnits + units || view.selection.anchor !== offset + units || view.selection.head !== offset + units
                        || fixture.range(offset, offset + units) !== text.slice(0, units) || view.metrics.inputEvents !== prior.metrics.inputEvents + count
                        || view.metrics.commits !== prior.metrics.commits + count || view.metrics.inputUnits > 2600) { fail("Incorrect reference experiment input result."); return; }
                    records.push({ revision: state.source.revision, beforeinputAt: pendingStart, inputFinishedAt: performance.now(), inputHandlerMs: view.metrics.lastInputMs,
                        data: event.data, trusted: event.isTrusted });
                    insertedUnits = units; pendingStart = undefined; observe();
                }, { signal: listeners.signal });
            }
        }
        const check = () => {
            if (finished) return; observe(); const state = fixture.snapshot(), c = state.bindings.comparison;
            frames = start !== undefined && model(state) && ready(state) ? frames + 1 : 0;
            if (finished) return;
            if (frames < 2) { frame = requestAnimationFrame(check); return; }
            if (state.source.id !== before.source.id || state.bindings.mounts !== before.bindings.mounts || c.viewId !== initial.viewId
                || kind !== "reference" && (document.activeElement !== node || state.source.exports !== 0)
                || kind === "reference" && (state.source.length !== before.source.length || !same(state.history, before.history) || dispatchEnd === undefined)) {
                fail("Reference observation changed ownership, history, export count or focus."); return;
            }
            if (kind === "command") {
                const view = state.bindings.views.find(v => v.id === "primary");
                if (view.viewId !== prior.viewId || state.source.length !== before.source.length - replacedUnits + text.length
                    || fixture.range(offset, offset + text.length) !== text || view.selection.anchor !== offset + caretOffset || view.selection.head !== offset + caretOffset
                    || view.metrics.inputEvents !== prior.metrics.inputEvents || view.metrics.beforeInputEvents !== prior.metrics.beforeInputEvents
                    || view.metrics.inputUnits > 2600) { fail("Incorrect handled Enter text, selection or event counters."); return; }
            }
            const now = performance.now(), lastStart = records.at(-1)?.beforeinputAt ?? start;
            const observed = [...generations.values()].map(entry => ({ ...entry,
                supersededWhileObservedRunning: entry.generation !== c.generation && entry.status === "running" }));
            if (observed.length !== (kind === "reference" ? 1 : transactions()) || c.work.generation !== c.generation) { fail("Missing or misattributed comparison generation observations."); return; }
            const rows = [...state.bindings.views.map(v => v.metrics.viewport.rows), c.workingViewport.rows, c.referenceViewport.rows];
            const readUnits = [...state.bindings.views.map(v => v.metrics.viewport.readUnits), c.workingViewport.readUnits, c.referenceViewport.readUnits];
            cleanup(); resolve({ kind, transactions: transactions(), insertedUnits: kind === "reference" ? 0 : text.length,
                browserToFullReviewReadyProxyMs: now - start, commandToFullReviewReadyProxyMs: kind === "command" ? now - start : null,
                lastInputToFullReviewReadyProxyMs: kind === "input" ? now - lastStart : null,
                lastInputFinishedToFullReviewReadyProxyMs: kind === "input" ? now - records.at(-1).inputFinishedAt : null,
                clickDispatchObservationMs: dispatchEnd === undefined ? null : dispatchEnd - start,
                phasesFromStartMs: Object.fromEntries(Object.entries(phases).map(([key, at]) => [key, at - start])),
                phasesFromLastInputMs: kind === "input" ? Object.fromEntries(Object.entries(phases).map(([key, at]) => [key, at - lastStart])) : null,
                inputDispatchSpanMs: kind === "input" ? lastStart - start : null,
                records: records.map(record => ({ ...record, workingRenderProxyMs: record.workingRenderedAt === undefined ? null : record.workingRenderedAt - (record.beforeinputAt ?? record.keydownAt),
                    supersededBeforeObservedWorkingReady: record.workingRenderedAt === undefined })),
                generations: observed, observedDiffBatchMs: observed.reduce((n, entry) => n + entry.totalStepMs, 0),
                observedDiffWork: observed.reduce((n, entry) => n + entry.work, 0), finalDiffBatch: c.work, finalDiffProgress: c.progress,
                referenceIsWorkingBuffer: c.referenceIsWorkingBuffer, referenceVersion: c.baseline.version, referenceEpoch: c.baseline.epoch,
                referenceLabel: referenceLabel(), hunks: c.hunks, revision: state.source.revision, exports: state.source.exports,
                rows, readUnits, inputUnits: state.bindings.views.map(v => v.metrics.inputUnits), comparisonInputUnits: c.input.inputUnits,
                backgroundUpdates: state.activity.background - before.activity.background, historyBefore: before.history, historyAfter: state.history,
                replacement: replaceSelection ? { from: offset, to: offset + replacedUnits } : null,
                primarySelection: state.bindings.views.find(v => v.id === "primary").selection, secondarySelection: state.bindings.views.find(v => v.id === "secondary").selection });
        }; frame = requestAnimationFrame(check);
    }
    globalThis.hostReferenceProbe = Object.freeze({ isSourceReady, waitSourceReady, isReady, waitReady, arm, read: () => active.promise, snapshot: () => active?.snapshot(), abort: () => active?.abort() });
}
