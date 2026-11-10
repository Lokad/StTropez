import test from "node:test";
import assert from "node:assert/strict";
import { HostController } from "../examples/hosts/controller.ts";

const settled = () => new Promise<void>(done => setImmediate(done));
function configuration(host: HostController) { const s = host.connection.getSnapshot(); assert.equal(s.state, "ready"); if (s.state !== "ready") throw new Error("Missing configuration"); return s; }
function sourceEdit(host: HostController, insert: string) { const d = host.workspace.document(host.source.documentId); host.workspace.edit({ documentId: d.id, expectedRevision: d.revision, origin: "human", edits: [{ from: d.buffer.length, to: d.buffer.length, insert }] }); }

test("configuration Save captures independently through later edits, source Save, Run and failure/retry", async () => {
    const h = new HostController(), save = h.configurationSave;
    try {
        h.workspace.updateResource(h.connection, { expectedRevision: 0, origin: "human", value: { path: " captured.csv ", format: "csv", opaque: { columns: ["id", "Δ"], zero: -0 } } });
        save.save(); await settled(); const capture = save.capture()!;
        assert.equal(capture.resourceId, h.connection.id); assert.equal(capture.expectedServerVersion, null); assert.equal(capture.value.path, " captured.csv ");
        h.setPath("later.csv"); sourceEdit(h, " first"); h.save(); await settled(); sourceEdit(h, " later"); const run = h.run(); await settled();
        assert.equal(h.runCapture(0)?.configuration.path, "later.csv"); assert.equal(h.debug().pendingSaves.length, 1);
        const history = h.workspace.observeHistory(h.source.documentId).getSnapshot(), source = h.workspace.document(h.source.documentId);
        save.finish(); await settled(); assert.equal(configuration(h).value.path, "later.csv"); assert.equal(configuration(h).metadata.dirty, true); assert.equal(configuration(h).metadata.serverVersion, "configuration-v1");
        assert.deepEqual(configuration(h).value.opaque, capture.value.opaque); assert.equal(h.workspace.document(h.source.documentId), source); assert.deepEqual(h.workspace.observeHistory(h.source.documentId).getSnapshot(), history);
        save.save(); await settled(); assert.equal(save.capture()?.expectedServerVersion, "configuration-v1"); save.fail(); await settled(); assert.equal(configuration(h).metadata.saveStatus, "failed");
        h.setPath(" retry.csv "); save.save(); await settled(); save.finish(); await settled(); assert.equal(configuration(h).value.path, "retry.csv"); assert.equal(configuration(h).metadata.dirty, false);
        assert.deepEqual(configuration(h).value.opaque, capture.value.opaque); assert.equal(h.runCapture(0)?.configuration.path, "later.csv"); assert.equal(h.debug().activity.completedRuns, 0);
        h.finishSave(); h.finishRun(); await run; await settled(); assert.equal(h.source.metadata.getSnapshot().dirty, true); assert.equal(h.debug().diagnostics.leases, 0);
    } finally { await h.dispose(); }
});

test("configuration review uses an explicit precondition and retains corrections after a second conflict", async () => {
    const h = new HostController(), save = h.configurationSave;
    try {
        h.setPath("local.csv"); save.externalWrite("remote-one.csv"); save.save(); await settled(); save.finish(); await settled();
        assert.equal(configuration(h).value.path, "local.csv"); assert.equal(save.canSave(), false); assert.equal(save.canSaveReviewed(), false);
        save.review(); assert.equal(save.state.getSnapshot().conflict?.value?.path, "remote-one.csv"); h.setPath("merged.csv"); save.externalWrite("remote-two.csv");
        save.saveReviewed(); await settled(); assert.equal(save.capture()?.expectedServerVersion, "configuration-v1"); save.finish(); await settled(); assert.equal(configuration(h).metadata.serverVersion, null);
        save.review(); assert.equal(save.state.getSnapshot().conflict?.value?.path, "remote-two.csv"); save.saveReviewed(); await settled(); save.fail(); await settled(); assert.equal(save.canSaveReviewed(), true);
        h.setPath("final.csv"); save.saveReviewed(); await settled(); assert.equal(save.capture()?.expectedServerVersion, "configuration-v2"); h.setPath("newer.csv"); save.finish(); await settled();
        assert.equal(configuration(h).value.path, "newer.csv"); assert.equal(configuration(h).metadata.dirty, true); assert.equal(configuration(h).metadata.serverVersion, "configuration-v3");
        save.save(); await settled(); save.finish(); await settled(); assert.equal(configuration(h).metadata.dirty, false); assert.equal(configuration(h).metadata.serverVersion, "configuration-v4");
        assert.equal(h.workspace.document(h.source.documentId).text, "start"); assert.equal(h.workspace.observeHistory(h.source.documentId).getSnapshot().undoDepth, 0);
    } finally { await h.dispose(); }
});

test("invalid configuration remains editable and blocks its Save and Run while source can save", async () => {
    const h = new HostController();
    try {
        h.setPath("   "); h.configurationSave.save(); await h.run(); await settled();
        assert.equal(configuration(h).value.path, "   "); assert.equal(h.configurationSave.capture(), null); assert.equal(h.debug().activity.pendingRuns, 0);
        sourceEdit(h, " correction"); h.save(); await settled(); assert.equal(h.debug().pendingSaves.length, 1); h.finishSave(); await settled(); assert.equal(h.source.metadata.getSnapshot().dirty, false);
    } finally { await h.dispose(); }
});

for (const started of [false, true]) test(`configuration disposal ${started ? "during request" : "before queued request"} settles without losing unsaved inputs`, async () => {
    const h = new HostController(); h.setPath("unsaved.csv"); h.configurationSave.save(); if (started) { await settled(); assert.ok(h.configurationSave.capture()); }
    await h.dispose(); const stopped = h.debug(); assert.equal(stopped.diagnostics.leases, 0); assert.equal(stopped.pendingCommands, 0); assert.equal(configuration(h).value.path, "unsaved.csv");
    h.configurationSave.finish(); h.configurationSave.fail(); h.configurationSave.save(); await settled(); assert.deepEqual(h.debug(), stopped);
});

test("host disposal waits for accepted queued state and in-flight command settlement", async () => {
    const host = new HostController(); host.demonstrateOrdering();
    assert.equal(host.settings.getSnapshot().mode, "preview");
    await host.dispose();
    assert.equal(host.settings.getSnapshot().mode, "inspect");
    const stopped = host.debug(); assert.equal(stopped.pendingCommands, 0); assert.equal(stopped.diagnostics.leases, 0);
    assert.equal(stopped.activity.lastRun, null); assert.equal(stopped.disposed, true);
    await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(host.debug(), stopped);
    host.demonstrateOrdering(); host.startBackground(); await host.dispose(); assert.deepEqual(host.debug(), stopped);
});

test("host disposal releases an unacknowledged proposal while retaining the unsaved document", async () => {
    const host = new HostController(); host.associate(); host.requestAgent(); host.deliverProposalText("unsaved proposal");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(host.debug().review.proposal?.target.revision, 1);
    await host.dispose();
    assert.equal(host.debug().diagnostics.leases, 0); assert.equal(host.debug().review.association, null);
    assert.equal(host.source.getSnapshot().state, "ready");
    assert.equal(host.workspace.document(host.source.documentId).text, "unsaved proposal"); assert.equal(host.debug().source.dirty, true);
});

test("parallel Run captures, denied submission and older results keep independent counts and targets", async () => {
    const host = new HostController();
    try {
        const first = host.run(); host.setPath("second.csv");
        host.workspace.edit({ documentId: host.source.documentId, expectedRevision: 0, origin: "human", edits: [{ from: 0, to: 5, insert: "second source" }] });
        const second = host.run();
        assert.equal(host.debug().activity.pendingRuns, 2);
        assert.deepEqual(host.runCapture(0), { source: "start", configuration: { path: "source.csv", format: "csv" }, settings: { mode: "preview" } });
        assert.deepEqual(host.runCapture(1), { source: "second source", configuration: { path: "second.csv", format: "csv" }, settings: { mode: "preview" } });
        host.workspace.setCapabilities(host.source.id, { edit: ["human", "host", "agent"], save: true, run: false });
        await host.run(); assert.equal(host.debug().activity.pendingRuns, 2); assert.equal(host.debug().activity.errors, 1);
        const latest = host.debug().activity.lastRun;
        host.finishRun(); await first;
        assert.equal(host.debug().activity.pendingRuns, 1); assert.equal(host.debug().activity.completedRuns, 1);
        assert.deepEqual(host.debug().activity.lastRun, latest);
        host.failRun(); await second;
        assert.equal(host.debug().activity.pendingRuns, 0); assert.equal(host.debug().activity.completedRuns, 1);
        assert.equal(host.debug().activity.errors, 2); assert.equal(host.debug().pendingCommands, 0); assert.equal(host.debug().diagnostics.leases, 0);
    } finally { await host.dispose(); }
});
