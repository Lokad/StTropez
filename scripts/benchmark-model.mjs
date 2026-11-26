import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { Workspace, TextBuffer, planLanguageEdit, resolveLanguageConfiguration } from "../src/index.ts";
import { createSelectionSet } from "../src/core/selections.ts";
import { corpus, corpusIds, editLog, workloadSeed, workspaceWorkload } from "../tests/fixtures/workloads.ts";
import { distribution, environment, sourceIdentity } from "./measurement.mjs";

function measureCommentPlanning() {
    const row = "//x\n", rows = 128_000, text = row.repeat(rows);
    const bytes = Buffer.byteLength(text);
    assert.equal(bytes, 512_000);
    const buffer = TextBuffer.from(text), middle = buffer.offsetAt(rows / 2);
    const config = resolveLanguageConfiguration({ lineComment: "//" }), budgetMs = 40;
    return ["caret", "select-all"].map(selection => {
        const caret = selection === "caret", from = caret ? middle : 0;
        const ranges = createSelectionSet(buffer.length, [{ anchor: from, head: caret ? from : buffer.length }]);
        const elapsed = [], cpu = [];
        for (let sample = 0; sample < 6; sample++) {
            const before = process.threadCpuUsage(), start = performance.now();
            const plan = planLanguageEdit(buffer, ranges, "remove-line-comment", config);
            const ms = performance.now() - start, usage = process.threadCpuUsage(before);
            assert.equal(plan.edits.length, caret ? 1 : rows);
            assert.deepEqual(plan.edits[0], { from, to: from + 2, insert: "" });
            if (sample) { elapsed.push(ms); cpu.push((usage.user + usage.system) / 1000); }
        }
        const plannerElapsedMs = distribution(elapsed), withinBudget = plannerElapsedMs.max <= budgetMs;
        if (caret) assert.ok(withinBudget, "Removing one line comment exceeded the synchronous planning budget.");
        return { command: "remove-line-comment", bytes, rows, selection, budgetMs, withinBudget,
            plannerElapsedMs, plannerThreadCpuMs: distribution(cpu) };
    });
}

export async function benchmarkModel() {
    const scenarios = [];
    for (const id of corpusIds) {
        const workspace = new Workspace();
        let oracle = corpus(id);
        const documentId = workspace.createDocument({ scope: "bench", resource: id, variant: "working" }, id, oracle);
        const samples = [], roots = [];
        let notifications = 0;
        workspace.subscribe(() => notifications++);
        workspace.observeDocument(documentId).subscribe(() => {
            const buffer = workspace.document(documentId).buffer;
            buffer.slice(buffer.offsetAt(0), Math.min(buffer.length, 24)); buffer.lineAt(Math.floor(buffer.length / 2));
        });
        const edits = editLog(oracle.length, 65);
        let expectedRevision = 0;
        for (const [index, edit] of edits.entries()) {
            const next = oracle.slice(0, edit.from) + edit.insert + oracle.slice(edit.to);
            const before = workspace.document(documentId).buffer;
            const start = performance.now();
            const result = workspace.edit({ documentId, expectedRevision, origin: "human", edits: [edit] });
            const elapsed = performance.now() - start;
            assert.equal(result.applied, true);
            if (next !== oracle) {
                expectedRevision++; roots.push(before);
            }
            assert.equal(workspace.document(documentId).text(), next);
            assert.equal(workspace.document(documentId).revision, expectedRevision);
            oracle = next;
            if (index >= 5) samples.push(elapsed);
        }
        assert.equal(notifications, expectedRevision);
        const final = workspace.document(documentId).buffer, undo = [], redo = [];
        assert.ok(final instanceof TextBuffer);
        assert.equal(workspace.observeHistory(documentId).getSnapshot().undoDepth, roots.length);
        const retention = TextBuffer.retained([...roots, final]);
        for (let index = roots.length - 1; index >= 0; index--) {
            const revision = workspace.document(documentId).revision, start = performance.now();
            const result = workspace.undo({ documentId, expectedRevision: revision });
            const elapsed = performance.now() - start;
            assert.equal(result.applied, true); assert.equal(workspace.document(documentId).buffer, roots[index]);
            if (index < roots.length - 5) undo.push(elapsed);
        }
        assert.equal(workspace.resource(documentId).metadata.getSnapshot().dirty, false);
        for (let index = 0; index < roots.length; index++) {
            const revision = workspace.document(documentId).revision, start = performance.now();
            const result = workspace.redo({ documentId, expectedRevision: revision });
            const elapsed = performance.now() - start;
            assert.equal(result.applied, true); assert.equal(workspace.document(documentId).buffer, roots[index + 1] ?? final);
            if (index >= 5) redo.push(elapsed);
        }
        assert.equal(workspace.document(documentId).text(), oracle);
        assert.equal(notifications, expectedRevision * 3);
        scenarios.push({ corpus: id, initialLength: corpus(id).length, finalLength: oracle.length,
            revisions: expectedRevision, finalRevision: workspace.document(documentId).revision, notifications, routineWholeTextExports: 0, retention,
            modelTransactionMs: distribution(samples), undoMs: distribution(undo), redoMs: distribution(redo) });
    }
    const propagation = [];
    for (const resources of workspaceWorkload.resources) {
        for (const views of workspaceWorkload.activeViews) {
            const workspace = new Workspace();
            const source = workspace.createTextResource({ scope: "bench", resource: "source", variant: "working" }, "Source", { value: "baseline" });
            const others = Array.from({ length: resources - 1 }, (_, index) => workspace.createTextResource(
                { scope: "bench", resource: `document-${index}`, variant: "working" }, "Document", { value: "unchanged" }));
            /** @param {string} value */
            const write = value => workspace.edit({ documentId: source.id,
                expectedRevision: workspace.document(source.id).revision, origin: "human",
                edits: [{ from: 0, to: workspace.document(source.id).buffer.length, insert: value }] });
            write("dirty");
            const metadata = source.metadata.getSnapshot(), snapshots = others.map(other => other.getSnapshot());
            let unrelatedCalls = 0, metadataCalls = 0, viewCalls = 0, selectionCalls = 0, coarseCalls = 0;
            others.forEach(other => other.subscribe(() => unrelatedCalls++));
            source.metadata.subscribe(() => metadataCalls++);
            for (let index = 0; index < views; index++) {
                workspace.observeDocument(source.id).subscribe(() => viewCalls++);
                workspace.createDocumentView(source.id).subscribe(() => selectionCalls++);
            }
            workspace.subscribe(() => coarseCalls++);
            const samples = [];
            for (let index = 0; index < 65; index++) {
                const start = performance.now();
                const result = write(`edit-${index}`);
                const elapsed = performance.now() - start;
                assert.equal(result.applied, true);
                if (index >= 5) samples.push(elapsed);
            }
            assert.equal(viewCalls, views * 65); assert.equal(coarseCalls, 65);
            assert.equal(selectionCalls, views * 65);
            assert.equal(unrelatedCalls, 0); assert.equal(metadataCalls, 0);
            assert.equal(source.metadata.getSnapshot(), metadata);
            others.forEach((other, index) => assert.equal(other.getSnapshot(), snapshots[index]));
            propagation.push({ resources, views, warmup: 5, measured: 60, viewCalls, selectionCalls, coarseCalls, unrelatedCalls, metadataCalls,
                transactionAndDeliveryMs: distribution(samples) });
        }
    }
    return { schemaVersion: 3, created: new Date().toISOString(), runtime: "piece-tree-workspace-with-bounded-history",
        note: "Headless transactions include history and bounded range/line reads during delivery. Undo/redo verify exact retained roots and undo-to-saved state. Oracle exports/validation are outside timing. No renderer or production latency guarantee.",
        seed: workloadSeed, warmup: 5, measured: 60, source: await sourceIdentity(), environment: environment(), scenarios, propagation,
        commentPlanning: measureCommentPlanning() };
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/benchmark-model.mjs")) {
    const report = await benchmarkModel();
    await mkdir("artifacts/bench", { recursive: true });
    await writeFile("artifacts/bench/model.json", JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report.scenarios.map(({ corpus, modelTransactionMs: { p50, p95 } }) => ({ corpus, p50, p95 })), null, 2));
}
