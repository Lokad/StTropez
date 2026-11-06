import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const report = JSON.parse(await readFile(process.argv[2] ?? "artifacts/bench/storage/latest.json", "utf8"));
assert.equal(report.schemaVersion, 1);
assert.equal(report.cases.length, report.rounds * report.corpusIds.length * report.actions.length * report.candidates.length);
const median = values => {
    assert.ok(values.length > 0 && values.every(Number.isFinite));
    const sorted = values.toSorted((a, b) => a - b), middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const rows = [];
for (const corpus of report.corpusIds) for (const action of report.actions) for (const candidate of report.candidates) {
    const cases = report.cases.filter(item => item.corpus === corpus && item.action === action && item.candidate === candidate);
    assert.equal(cases.length, report.rounds);
    assert.equal(new Set(cases.map(item => item.round)).size, report.rounds);
    cases.forEach(item => assert.equal(item.mixedEditLookupSliceMs.samples.length, 90));
    const value = select => median(cases.map(select));
    rows.push({ corpus, action, candidate, mixedP95Ms: value(item => item.mixedEditLookupSliceMs.p95),
        editP95Ms: value(item => item.editMs.p95), lookupP95Ms: value(item => item.coldLookupAfterEditMs.p95),
        snapshotP95Ms: value(item => item.retainSnapshotMs.p95), sliceP95Ms: value(item => item.sliceMs.p95),
        startupMs: value(item => item.constructionAndFirstLookupMs), exportAndChecksumMs: value(item => item.exportAndUtf16ChecksumMs),
        additionalHistoryMiB: value(item => item.memory.historyDelta / 1_048_576),
        additionalCurrentMiB: value(item => item.memory.currentDelta / 1_048_576) });
}
console.log(JSON.stringify({ source: report.source.sha256, environment: report.environment, rounds: report.rounds,
    note: "Median of per-round p95 values; not a pooled percentile. Startup, export and heap values are medians of round samples.", rows }, null, 2));
