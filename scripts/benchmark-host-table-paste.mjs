import assert from "node:assert/strict";
import { createReportWriter } from "./benchmark-report.mjs";
import { performance } from "node:perf_hooks";
import { openHarness } from "./browser-harness.mjs";
import { distribution, environment, sourceIdentity, timingSummary } from "./measurement.mjs";
import { corpus } from "../fixtures/workloads.ts";
import { installHostReferenceProbe } from "./host-reference-probe.mjs";

const source = await sourceIdentity(), writer = await createReportWriter("artifacts/bench/host-table-paste", "full");
const harness = await openHarness(), page = harness.page;
const report = { schemaVersion: 1, created: new Date().toISOString(), source, environment: { ...environment(), browser: harness.browser.version(), viewport: { width: 1440, height: 900 } },
    status: "running", active: null, cases: [],
    scope: "One fixed table-paste experiment: both hosts, normal/100k sources, HTML/TSV, two raw warmups and ten measured workflows per group. Normal tables have two rows; large tables have1500. One captured caret, independent source/review views, immutable reference, actual worker reply before the point and20Hz background host traffic. No prior experiment rerun.",
    clocks: "captureHandlerMs covers only the host capture listener; it excludes candidate cleanup and conversion. dispatchMs wraps complete synchronous synthetic paste dispatch, including all listeners. maxTurnMs covers entire scheduled conversion callbacks, including final assembly, commit/publication and scheduling. commitMs measures the atomic model call including synchronous subscribers; conversionToCommitMs starts after clipboard capture and stops at commit. eventToReviewReadyMs requires exact revision, completed conversion, immutable reference identity, shared live-owner working/reference settlement (complete selections/folds, pending input/commands, caret/scans/drag, comparison alignment/scroll), source revision/reference label and two RAFs; later language replies are excluded. completeActionProxyMs includes automation payload transfer and the same readiness. workflowMs includes setup, fold-free controls, oracles, shared undo and disposal. No OS clipboard, native IME, CPU or physical-display qualification. Historical reports retain their original readiness definition.",
    retention: "All raw warmups and observations are retained. Failed partial workflows and the last active identity are saved without automatic retries." };
const save = () => writer.write(report);
const click = name => page.getByRole("button", { name, exact: true }).click();
const ready = () => page.waitForFunction(() => { const s = window.hostFixture.snapshot();
    return !s.bindings.tablePaste.pending && globalThis.hostReferenceProbe.isReady(s);
});
const exact = text => page.evaluate(text => { const f = window.hostFixture; if (f.snapshot().source.length !== text.length) return false;
    for (let from = 0; from < text.length; from += 32768) if (f.range(from, Math.min(text.length, from + 32768)) !== text.slice(from, from + 32768)) return false; return true;
}, text);
async function point(payload, expected) {
    const started = performance.now();
    const sample = await page.evaluate(({ payload, expected }) => new Promise((resolve, reject) => {
        const f = window.hostFixture, before = f.snapshot(), input = document.querySelector('textarea[aria-label="Primary source"]'), data = new DataTransfer();
        data.setData("text/plain", payload.plain); if (payload.html) data.setData("text/html", payload.html);
        let frames = 0, finished = false, dispatchMs = 0;
        const fail = message => { if (finished) return; finished = true; clearTimeout(timeout); reject(new Error(message)); };
        const timeout = setTimeout(() => fail("Table paste did not reach complete review readiness."), 20000);
        const check = () => {
            if (finished) return; const s = f.snapshot(), c = s.bindings.comparison, t = s.bindings.tablePaste;
            if (t.status === "failed" || t.status === "cancelled") { fail(t.message); return; }
            let full;
            try { full = globalThis.hostReferenceProbe.isReady(s); }
            catch (error) { fail(String(error?.message ?? error)); return; }
            full &&= !t.pending && t.status === "applied"
                && c.baseline.version === before.bindings.comparison.baseline.version && c.referenceViewport.revision === before.bindings.comparison.referenceViewport.revision;
            if (!full) { frames = 0; requestAnimationFrame(check); return; }
            const p = s.bindings.views.find(v => v.id === "primary");
            if (s.source.revision !== before.source.revision + 1 || s.source.length !== expected.length || p.selection.anchor !== expected.head || p.selection.head !== expected.head || p.selectionSet.ranges.length !== 1
                || t.rows !== expected.rows || t.columns !== 2 || s.source.exports !== 0 || s.history.undoDepth !== before.history.undoDepth + 1) { fail("Table paste lost exact source, selections, history or capture identity."); return; }
            if (++frames < 2) { requestAnimationFrame(check); return; }
            finished = true; clearTimeout(timeout); resolve({ captureHandlerMs: t.lastCaptureHandlerMs, dispatchMs, maxTurnMs: t.maxTurnMs, commitMs: t.commitMs, conversionToCommitMs: t.conversionToCommitMs,
                eventToReviewReadyMs: performance.now() - eventStart, revision: s.source.revision, head: p.selection.head, rows: s.bindings.views.map(v => v.metrics.viewport.rows),
                comparisonRows: c.workingViewport.rows + c.referenceViewport.rows, maxReadUnits: Math.max(...s.bindings.views.map(v => v.metrics.viewport.readUnits), c.workingViewport.readUnits, c.referenceViewport.readUnits),
                inputUnits: p.metrics.inputUnits, work: t.work, exports: s.source.exports, background: s.activity.background, focused: document.activeElement === input });
        };
        const eventStart = performance.now(); input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })); dispatchMs = performance.now() - eventStart; requestAnimationFrame(check);
    }), { payload, expected });
    sample.completeActionProxyMs = performance.now() - started;
    assert.equal(sample.focused, true); assert.ok(sample.inputUnits <= 2600); assert.ok(sample.rows.every(n => n < 100)); assert.ok(sample.comparisonRows < 100); assert.ok(sample.maxReadUnits < 20000); return sample;
}
try {
    await save();
    for (const host of ["plain", "react"]) for (const id of ["normal", "lines-100000"]) for (const format of ["html", "tsv"]) {
        const original = corpus(id), count = id === "normal" ? 2 : 1500, rows = Array.from({ length: count }, (_, i) => [`item ${i}`, `東京 ${i}`]);
        const quote = text => '"' + text.replaceAll('"', '""') + '"', csv = rows.map(row => row.map(quote).join(",")).join("\r\n");
        const payload = { plain: rows.map(row => row.join("\t")).join("\r\n"), html: format === "html" ? "<table>" + rows.map(row => "<tr>" + row.map(cell => "<td>" + cell + "</td>").join("") + "</tr>").join("") + "</table>" : "" };
        const group = { host, corpus: id, format, sourceUnits: original.length, tableRows: count, plainUnits: payload.plain.length, htmlUnits: payload.html.length, warmup: 2, measured: 10, raw: [], distributions: null }; report.cases.push(group);
        for (let iteration = 0; iteration < 12; iteration++) {
            const began = performance.now(), raw = { iteration, warmup: iteration < 2, status: "running", paste: null }; group.raw.push(raw); report.active = { host, corpus: id, format, iteration };
            await page.goto(new URL(`/hosts/${host}/?editor=candidate`, page.url()).href);
            await page.evaluate(installHostReferenceProbe);
            await page.evaluate(text => { const f = window.hostFixture; f.editSource(f.snapshot().source.revision, [{ from: 0, to: f.snapshot().source.length, insert: text }]); }, original);
            await click("Open source review"); await ready(); await click("Capture review acceptance"); await click("Finish review acceptance"); await ready();
            await page.getByRole("checkbox", { name: "Paste tables as CSV", exact: true }).check(); const input = page.getByRole("textbox", { name: "Primary source", exact: true }); await input.focus();
            await page.evaluate(() => { const f = window.hostFixture; f.selectSource("primary", f.snapshot().source.revision, { anchor: 0, head: 0 }); f.requestProvider(); });
            await page.waitForFunction(() => window.hostFixture.snapshot().bindings.language.sessions.find(s => s.id === "primary").provider.received > 0); await ready(); await input.scrollIntoViewIfNeeded(); await input.focus();
            raw.paste = await point(payload, { length: original.length + csv.length, head: csv.length, rows: count }); assert.equal(await exact(csv + original), true);
            await page.getByRole("textbox", { name: "Secondary source", exact: true }).press("Control+z"); await ready(); assert.equal(await exact(original), true);
            await page.evaluate(() => window.hostFixture.dispose()); const released = await page.evaluate(() => { const s = window.hostFixture.snapshot(); return { views: s.diagnostics.views, leases: s.diagnostics.leases, subscriptions: s.diagnostics.subscriptions, host: s.hostSubscriptions, pasteSessions: s.bindings.tablePaste.sessions }; });
            assert.deepEqual(released, { views: 0, leases: 0, subscriptions: 0, host: 0, pasteSessions: 0 }); assert.deepEqual(harness.errors, []);
            Object.assign(raw, { status: "passed", workflowMs: performance.now() - began, released }); await save();
        }
        const observed = group.raw.filter(s => !s.warmup);
        group.distributions = Object.fromEntries(["captureHandlerMs", "dispatchMs", "maxTurnMs", "commitMs", "conversionToCommitMs", "eventToReviewReadyMs", "completeActionProxyMs"].map(key => [key, distribution(observed.map(s => s.paste[key]))]));
        group.distributions.workflowMs = distribution(observed.map(s => s.workflowMs));
    }
    assert.equal((await sourceIdentity()).sha256, source.sha256, "Source changed during measurement.");
    report.status = "passed"; report.active = null; report.finished = new Date().toISOString(); await save();
    console.log(JSON.stringify(report.cases.map(g => ({ host: g.host, corpus: g.corpus, format: g.format, dispatchMs: timingSummary(g.distributions.dispatchMs), callbackMs: timingSummary(g.distributions.maxTurnMs),
        readyMs: timingSummary(g.distributions.eventToReviewReadyMs), actionMs: timingSummary(g.distributions.completeActionProxyMs) }))));
} catch (error) { report.status = "failed"; report.failure = String(error.stack ?? error); report.finished = new Date().toISOString(); await save(); throw error; }
finally { await harness.close(); }
