/** Browser-side observations for the paired reference experiment. This function has no module captures. */
export function installHostReferenceProbe() {
    const fixture = window.hostFixture, same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    let active;
    const referenceLabel = () => [...document.querySelectorAll('.st-comparison[aria-label="Source review"] .st-comparison-panes h3')]
        .find(heading => heading.textContent?.startsWith("Baseline · "))?.textContent ?? null;
    const facts = state => {
        const c = state.bindings.comparison, views = state.bindings.views;
        const rendered = views.every(v => v.metrics && !v.metrics.viewport.pending && v.metrics.viewport.revision === state.source.revision
            && same(v.metrics.viewport.selection, v.selection)) && c && !c.workingViewport.pending
            && c.workingViewport.revision === state.source.revision && same(c.workingViewport.selection, c.selection);
        const scans = views.every(v => !v.metrics.pendingWord && !v.metrics.pendingGrapheme) && c && !c.input.pendingWord && !c.input.pendingGrapheme;
        const caret = views.every(v => !v.metrics.pendingCaret) && c && !c.input.pendingCaret;
        const drag = views.every(v => !v.metrics.pendingDragScroll) && c && !c.input.pendingDragScroll;
        const comparison = c?.status === "ready" && c.workingRevision === state.source.revision;
        const reference = c?.referenceViewport && !c.referenceViewport.pending && referenceLabel() === `Baseline · ${c.baseline?.version}`;
        return { rendered: !!rendered, scans: !!scans, caret: !!caret, drag: !!drag, comparison: !!comparison, reference: !!reference,
            full: !!(state.bindings.activeViews === 2 && rendered && scans && caret && drag && comparison && reference) };
    };
    function waitReady() {
        return new Promise((resolve, reject) => {
            let frames = 0, frame;
            const timer = setTimeout(() => { cancelAnimationFrame(frame); reject(new Error("Host reference setup readiness timed out.")); }, 20000);
            const check = () => { const state = fixture.snapshot(); frames = facts(state).full ? frames + 1 : 0;
                if (frames < 2) { frame = requestAnimationFrame(check); return; }
                clearTimeout(timer); resolve(state);
            }; frame = requestAnimationFrame(check);
        });
    }
    function arm({ kind, operation, text = "", replaceSelection = false }) {
        active?.abort();
        const before = fixture.snapshot(), prior = before.bindings.views.find(v => v.id === "primary"), initial = before.bindings.comparison;
        const node = document.querySelector('textarea[aria-label="Primary source"]'), listeners = new AbortController(), records = [], generations = new Map(), phases = {};
        const offset = replaceSelection ? Math.min(prior.selection.anchor, prior.selection.head) : prior.selection.head;
        const replacedUnits = replaceSelection ? Math.abs(prior.selection.anchor - prior.selection.head) : 0;
        const expectedRevision = before.source.revision + (kind === "input" ? text.length : 0);
        let start, pendingStart, dispatchEnd, frame, frames = 0, finished = false, resolve, reject;
        const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
        // A later Playwright call awaits this promise; keep a timeout rejection handled in the meantime.
        promise.catch(() => {});
        const cleanup = () => { finished = true; listeners.abort(); cancelAnimationFrame(frame); clearTimeout(timer); };
        const fail = message => { if (finished) return; cleanup(); reject(new Error(message)); };
        const timer = setTimeout(() => fail(`Host reference ${kind} readiness timed out.`), 20000);
        active = { promise, abort: () => fail("Host reference observation superseded before completion.") };
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
            const c = state.bindings.comparison;
            const model = state.source.revision === expectedRevision && (kind === "reference"
                ? c.baseline?.epoch === initial.baseline.epoch + 1 : records.length === text.length);
            if (!model) return;
            const now = performance.now(); phases.modelObservedAt ??= now;
            for (const key of ["rendered", "scans", "caret", "drag", "comparison", "reference"]) if (current[key]) phases[`${key}At`] ??= now;
        }
        const roots = document.querySelectorAll(".st-editing-candidate");
        if (roots.length !== 3 || !facts(before).full || !node) { fail("Reference experiment requires three ready bounded working views."); return; }
        roots.forEach(root => root.addEventListener("sttropez-render", observe, { signal: listeners.signal }));
        if (kind === "reference") {
            const label = operation === "identity" ? "Finish review acceptance" : "Finish reference refresh";
            const button = [...document.querySelectorAll("button")].find(b => b.textContent === label);
            if (!button) { fail("Missing captured reference completion command."); return; }
            button.addEventListener("click", () => { start = performance.now(); }, { capture: true, once: true, signal: listeners.signal });
            // React delegates at its root; document bubbling observes both hosts after their handlers.
            document.addEventListener("click", event => { if (event.target === button) { dispatchEnd = performance.now(); observe(); } }, { signal: listeners.signal });
        } else {
            if ((!replaceSelection && prior.selection.anchor !== offset) || node.ownerDocument.activeElement !== node) { fail("Input experiment requires its captured source selection and focus."); return; }
            node.addEventListener("beforeinput", () => { pendingStart = performance.now(); start ??= pendingStart; observeGeneration(fixture.snapshot()); }, { capture: true, signal: listeners.signal });
            node.addEventListener("input", () => observeGeneration(fixture.snapshot()), { capture: true, signal: listeners.signal });
            node.addEventListener("blur", () => fail("Reference experiment input lost focus."), { signal: listeners.signal });
            node.addEventListener("input", event => {
                const state = fixture.snapshot(), view = state.bindings.views.find(v => v.id === "primary"), count = records.length + 1;
                if (pendingStart === undefined || count > text.length || !["insertText", "insertLineBreak"].includes(event.inputType)
                    || state.source.id !== before.source.id || view.viewId !== prior.viewId || state.source.revision !== before.source.revision + count
                    || state.source.length !== before.source.length - replacedUnits + count || view.selection.anchor !== offset + count || view.selection.head !== offset + count
                    || fixture.range(offset, offset + count) !== text.slice(0, count) || view.metrics.inputEvents !== prior.metrics.inputEvents + count
                    || view.metrics.commits !== prior.metrics.commits + count || view.metrics.inputUnits > 2600) { fail("Incorrect reference experiment input result."); return; }
                records.push({ revision: state.source.revision, beforeinputAt: pendingStart, inputFinishedAt: performance.now(), inputHandlerMs: view.metrics.lastInputMs });
                pendingStart = undefined; observe();
            }, { signal: listeners.signal });
        }
        const check = () => {
            if (finished) return; observe(); const state = fixture.snapshot(), c = state.bindings.comparison;
            const model = state.source.revision === expectedRevision && (kind === "reference" ? c.baseline?.epoch === initial.baseline.epoch + 1 : records.length === text.length);
            frames = start !== undefined && model && facts(state).full ? frames + 1 : 0;
            if (frames < 2) { frame = requestAnimationFrame(check); return; }
            if (state.source.id !== before.source.id || state.bindings.mounts !== before.bindings.mounts || c.viewId !== initial.viewId
                || kind === "input" && (document.activeElement !== node || state.source.exports !== 0)
                || kind === "reference" && (state.source.length !== before.source.length || !same(state.history, before.history) || dispatchEnd === undefined)) {
                fail("Reference observation changed ownership, history, export count or focus."); return;
            }
            const now = performance.now(), lastStart = records.at(-1)?.beforeinputAt ?? start;
            const observed = [...generations.values()].map(entry => ({ ...entry,
                supersededWhileObservedRunning: entry.generation !== c.generation && entry.status === "running" }));
            if (observed.length !== (kind === "input" ? text.length : 1) || c.work.generation !== c.generation) { fail("Missing or misattributed comparison generation observations."); return; }
            const rows = [...state.bindings.views.map(v => v.metrics.viewport.rows), c.workingViewport.rows, c.referenceViewport.rows];
            const readUnits = [...state.bindings.views.map(v => v.metrics.viewport.readUnits), c.workingViewport.readUnits, c.referenceViewport.readUnits];
            cleanup(); resolve({ browserToFullReviewReadyProxyMs: now - start, lastInputToFullReviewReadyProxyMs: kind === "input" ? now - lastStart : null,
                clickDispatchObservationMs: dispatchEnd === undefined ? null : dispatchEnd - start,
                phasesFromStartMs: Object.fromEntries(Object.entries(phases).map(([key, at]) => [key, at - start])),
                phasesFromLastInputMs: kind === "input" ? Object.fromEntries(Object.entries(phases).map(([key, at]) => [key, at - lastStart])) : null,
                inputDispatchSpanMs: kind === "input" ? lastStart - start : null,
                records: records.map(record => ({ ...record, workingRenderProxyMs: record.workingRenderedAt === undefined ? null : record.workingRenderedAt - record.beforeinputAt,
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
    globalThis.hostReferenceProbe = Object.freeze({ waitReady, arm, read: () => active.promise, abort: () => active?.abort() });
}
