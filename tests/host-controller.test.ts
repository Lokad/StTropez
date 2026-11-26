import type { ResourceId } from "../src/index.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { HostController } from "./fixtures/hosts/controller.ts";
import { formSavePanelModel } from "./fixtures/hosts/configuration-panel.ts";
import { runPanelModel } from "./fixtures/hosts/transfer-panel.ts";

const settled = () => new Promise<void>(done => setImmediate(done));

test("input recovery validates unknown details and retains old attempts without applying them", async () => {
    const host = new HostController(), documentId = host.source.documentId, initial = host.recovery.getSnapshot();
    const detail = { documentId, expectedRevision: 0, reason: "stale-revision", attemptedText: "unapplied", contextFrom: 0,
        attemptedEdit: { from: 0, to: 0, insert: "unapplied" } };
    try {
        for (const value of [null, "text", { ...detail, documentId: "foreign" }, { ...detail, expectedRevision: -1 }, { ...detail, expectedRevision: 0.5 },
            { ...detail, reason: null }, { ...detail, attemptedText: 1 }, { ...detail, contextFrom: -1 }, { ...detail, contextFrom: NaN },
            { ...detail, attemptedEdit: null }, { ...detail, attemptedEdit: { from: 2, to: 1, insert: "x" } }, { ...detail, attemptedEdit: { from: 0, to: 0, insert: 1 } }]) {
            host.captureInputConflict(documentId, value); assert.equal(host.recovery.getSnapshot(), initial);
        }
        host.workspace.edit({ documentId, expectedRevision: 0, edits: [{ from: 0, to: 0, insert: "current " }], origin: "human" });
        const before = host.workspace.document(documentId), history = host.workspace.observeHistory(documentId).getSnapshot();
        host.captureInputConflict(documentId, detail); const retained = host.recovery.getSnapshot();
        detail.attemptedText = "changed outside"; detail.attemptedEdit.insert = "changed outside";
        assert.equal(retained.items[0]!.attemptedText, "unapplied"); assert.equal(retained.items[0]!.attemptedEdit!.insert, "unapplied");
        assert.ok(Object.isFrozen(retained.items[0])); assert.ok(Object.isFrozen(retained.items[0]!.attemptedEdit));
        assert.equal(host.workspace.document(documentId), before); assert.equal(host.workspace.observeHistory(documentId).getSnapshot(), history);
        await host.dispose(); host.captureInputConflict(documentId, detail); assert.equal(host.recovery.getSnapshot(), retained);
    } finally { await host.dispose(); }
});

test("form presentation caches immutable captures, rejects old request callbacks and releases observers", async () => {
    const host = new HostController(), save = host.configurationSave, store = save.presentation;
    const baseline = host.debug().diagnostics.subscriptions, ownerBaseline = save.debug().subscriptions;
    let notified = store.getSnapshot(), notifications = 0;
    const stop = store.subscribe(() => { notified = store.getSnapshot(); notifications++; });
    const model = () => formSavePanelModel(save, store.getSnapshot());
    try {
        assert.equal(store.getSnapshot(), notified); assert.ok(Object.isFrozen(notified));
        assert.equal(host.debug().diagnostics.subscriptions, baseline + 1); assert.equal(save.debug().subscriptions, ownerBaseline + 1);
        host.setPath("first.csv"); assert.ok(notifications > 0); assert.equal(notified, store.getSnapshot());
        assert.equal(notified.resource, host.connection.getSnapshot()); assert.equal(notified.canSave, true);
        save.save(); await settled(); const first = model(), captured = store.getSnapshot(); assert.ok(captured.capture);
        assert.ok(Object.isFrozen(captured.capture)); assert.equal(store.getSnapshot(), captured);
        first.actions[1].invoke(); assert.equal(notified.capture, null); assert.equal(model().actions[1].disabled, true); await settled();
        host.setPath("second.csv"); save.save(); await settled(); const second = store.getSnapshot(); assert.ok(second.capture);
        first.actions[1].invoke(); first.actions[2].invoke(); assert.equal(store.getSnapshot(), second);
        assert.equal(save.capture()?.value.path, "second.csv"); model().actions[2].invoke(); assert.equal(notified.capture, null); await settled();
        assert.equal(host.connection.getSnapshot().metadata.saveStatus, "failed");
        save.save(); await settled(); const pending = model(); save.dispose();
        assert.equal(notified.disposed, true); assert.equal(notified.capture, null); assert.equal(notified.canSave, false);
        pending.actions[1].invoke(); pending.actions[2].invoke(); await settled();
        assert.equal(store.getSnapshot().resource, host.connection.getSnapshot());
        stop(); const before = notifications; save.externalWrite(); assert.equal(notifications, before);
        assert.equal(host.debug().diagnostics.subscriptions, baseline); assert.equal(save.debug().subscriptions, ownerBaseline);
    } finally { stop(); await host.dispose(); }
});

test("host errors retain their original cause without mutating the error or document", async () => {
    const host = new HostController(), cause = { status: 503 }, error = new Error("Service unavailable", { cause });
    const document = host.workspace.document(host.source.documentId), handles = [host.layout, host.activity, host.settings];
    try {
        host.reportError(error);
        assert.equal(host.lastError, error); assert.equal((host.lastError as Error).cause, cause);
        assert.equal(Object.isFrozen(error), false); assert.equal(Object.isFrozen(cause), false);
        assert.deepEqual(host.debug().lastError, { name: error.name, message: error.message, stack: error.stack });
        assert.deepEqual(host.layout.getSnapshot().modal, { kind: "error", message: "The host operation failed. Your document is retained." });
        assert.equal(host.activity.getSnapshot().errors, 1); host.clearError(); assert.equal(host.lastError, error);
        const opaque = { circular: undefined as unknown }; opaque.circular = opaque;
        host.reportError(opaque); assert.equal(host.lastError, opaque); assert.equal(Object.isFrozen(opaque), false);
        assert.equal(host.debug().lastError, null); assert.equal(host.activity.getSnapshot().errors, 2);
        assert.equal(host.workspace.document(host.source.documentId), document);
        assert.deepEqual([host.layout, host.activity, host.settings], handles);
        await host.dispose(); host.reportError(new Error("Late failure"));
        assert.equal(host.lastError, opaque); assert.equal(host.activity.getSnapshot().errors, 2);
    } finally { await host.dispose(); }
});

test("clean deferred loads release after switchback without disturbing captured source work", async () => {
    const host = new HostController();
    try {
        sourceEdit(host, " unsaved café😀\r\n"); host.save(); const run = host.run(); await settled();
        const before = host.debug(), source = host.workspace.document(host.source.documentId), capture = host.runCapture(0), history = before.history;
        for (let i = 0; i < 6; i++) {
            host.beginDeferredLoad(); assert.equal(host.debug().loadPending, true);
            if (i % 2 === 0) { host.reopenPrimary(); host.finishLoad(); } else { host.finishLoad(); host.reopenPrimary(); }
            const after = host.debug(); assert.equal(after.loadPending, false);
            assert.deepEqual(after.diagnostics, before.diagnostics); assert.deepEqual(after.pendingSaves, before.pendingSaves);
            assert.equal(host.workspace.document(host.source.documentId), source); assert.deepEqual(after.history, history); assert.deepEqual(host.runCapture(0), capture);
        }
        host.finishSave(); host.finishRun(); await run; await settled(); assert.equal(host.debug().diagnostics.leases, 0);
    } finally { await host.dispose(); }
});
function transfer(host: HostController) { const s = host.transfer.resource.getSnapshot(); assert.equal(s.state, "ready"); if (s.state !== "ready") throw new Error("Missing transfer"); return s; }

test("loaded drafts remain reachable until explicit discard and clean loads respect operation ownership", async () => {
    const host = new HostController();
    const loaded = () => {
        const documentId = host.panes.primary.getSnapshot().documentId;
        assert.ok(documentId);
        return host.workspace.resourceForDocument(documentId);
    };
    try {
        const before = host.debug().diagnostics; host.beginDeferredLoad(); host.finishLoad(); const clean = loaded(), lease = host.workspace.acquire(clean.id);
        host.replacePrimary(); assert.equal(clean.getSnapshot().state, "ready"); lease.release(); host.collectLoadedDocument(); assert.equal(clean.getSnapshot().state, "released");
        host.reopenPrimary(); assert.deepEqual(host.debug().diagnostics, before);
        host.beginDeferredLoad(); host.finishLoad(); const draft = loaded(), d = host.workspace.document(draft.documentId);
        host.workspace.edit({ documentId: d.id, expectedRevision: d.revision, origin: "human", edits: [{ from: d.buffer.length, to: d.buffer.length, insert: " unsaved café😀\r\n" }] });
        const snapshot = host.workspace.document(d.id); host.reopenPrimary(); assert.equal(host.hasPendingRecoveryWork(), true);
        host.beginDeferredLoad(); assert.equal(host.debug().loadPending, false); assert.equal(host.workspace.document(d.id), snapshot);
        host.reopenLoaded(); assert.equal(loaded(), draft); assert.equal(host.workspace.document(d.id), snapshot);
        host.openClosePrompt(); host.confirmClose(); host.reopenLoaded(); assert.equal(loaded(), draft);
        const pending = host.workspace.acquire(draft.id); host.discardLoadedSource(); assert.equal(draft.getSnapshot().state, "ready");
        host.workspace.edit({ documentId: d.id, expectedRevision: snapshot.revision, origin: "host", edits: [{ from: 0, to: 0, insert: "later correction " }] });
        pending.release(); host.collectLoadedDocument(); assert.equal(draft.getSnapshot().state, "ready"); assert.equal(host.hasPendingRecoveryWork(), true);
        host.reopenLoaded(); assert.match(host.workspace.document(d.id).text(), /^later correction /);
        const stop = host.registerDetachedDocumentCleanup(id => { const current = host.workspace.document(id); host.workspace.edit({ documentId: id, expectedRevision: current.revision, origin: "host", edits: [{ from: 0, to: 0, insert: "cleanup correction " }] }); });
        try { host.discardLoadedSource(); assert.equal(draft.getSnapshot().state, "ready"); assert.match(host.workspace.document(d.id).text(), /^cleanup correction /); }
        finally { stop(); }
        host.discardLoadedSource(); assert.equal(draft.getSnapshot().state, "released"); assert.equal(host.hasPendingRecoveryWork(), false);
        assert.deepEqual(host.debug().diagnostics, before); assert.equal(host.workspace.document(host.source.documentId).text(), "start");
        host.openClosePrompt(); host.confirmClose(); host.beginDeferredLoad(); assert.equal(host.debug().loadPending, true); host.finishLoad();
        host.openClosePrompt(); host.confirmClose(); host.reopenPrimary(); assert.deepEqual(host.debug().diagnostics, before);
        host.beginDeferredLoad(); host.reopenPrimary(); await host.dispose(); assert.equal(host.debug().loadPending, false); assert.equal(host.debug().diagnostics.leases, 0);
        host.finishLoad(); assert.deepEqual(host.debug().diagnostics, before);
    } finally { await host.dispose(); }
});

test("independent transfer Save retains invalid input, opaque fields, later edits and reviewed conflict", async () => {
    const h = new HostController(), t = h.transfer, save = t.save;
    try {
        t.update("batchSize", "1e"); save.save(); await h.run(); await settled(); assert.equal(transfer(h).value().batchSize, "1e"); assert.equal(h.debug().activity.pendingRuns, 0); assert.equal(save.capture(), null);
        h.workspace.updateResource(t.resource, { expectedRevision: transfer(h).revision, origin: "human", value: { ...transfer(h).value(), batchSize: "2000", destination: " captured.csv ", opaque: { separator: "Δ", zero: -0 } } });
        save.save(); await settled(); const captured = save.capture()!; assert.equal(captured.resourceId, t.resource.id);
        t.update("destination", "later.csv"); sourceEdit(h, " correction"); h.setPath("connection.csv"); const before = h.debug(); save.finish(); await settled();
        assert.equal(transfer(h).value().destination, "later.csv"); assert.equal(transfer(h).metadata.serverVersion, "transfer-v1"); assert.equal(transfer(h).metadata.dirty, true); assert.deepEqual(h.debug().source, before.source); assert.deepEqual(h.debug().configuration, before.configuration);
        save.save(); await settled(); save.fail(); await settled(); assert.equal(transfer(h).metadata.saveStatus, "failed");
        save.externalWrite(); save.save(); await settled(); save.finish(); await settled(); assert.equal(save.canSave(), false); save.review(); assert.equal(save.state.getSnapshot().conflict?.value?.destination, "remote-target.csv");
        t.update("destination", " merged.csv "); save.saveReviewed(); await settled(); save.finish(); await settled(); assert.equal(transfer(h).value().destination, "merged.csv"); assert.equal(transfer(h).metadata.dirty, false); assert.deepEqual(transfer(h).value().opaque, captured.value.opaque);
        assert.equal(h.debug().activity.pendingRuns, 0); assert.equal(h.source.metadata.getSnapshot().dirty, true); assert.equal(configuration(h).metadata.dirty, true);
    } finally { await h.dispose(); }
});

test("immutable Run/log resources link captured inputs and keep older progress/results separate", async () => {
    const h = new HostController(), outputs = h.runResources;
    const stop = outputs.state.subscribe(() => { const state = outputs.state.getSnapshot();
        assert.equal(state.selected, state.inspection?.id ?? null);
        if (state.inspection) { assert.ok(Object.isFrozen(state.inspection)); assert.ok(Object.isFrozen(state.inspection.links)); }
    });
    try {
        const beforeRun = h.debug().diagnostics;
        const first = h.run(); await settled(); const id = h.runResources.state.getSnapshot().runs[0]!.id, input = h.runResources.capture(id)!;
        const sourceId: import("../src/index.ts").ResourceId = input.source.id; assert.equal(sourceId, h.source.id); assert.equal(input.configuration.id, h.connection.id); assert.equal(input.transfer.id, h.transfer.resource.id); assert.equal(input.source.value, "start");
        assert.ok(Object.isFrozen(input) && Object.isFrozen(input.transfer) && Object.isFrozen(input.transfer.value));
        const initialLog = h.runResources.state.getSnapshot().runs[0]!.logs[0]!;
        h.runResources.open(initialLog);
        const oldLog = h.runResources.inspect();
        assert.equal(h.debug().diagnostics.resources, beforeRun.resources);
        sourceEdit(h, " later"); h.setPath("later-connection.csv"); h.transfer.update("destination", "later-target.csv"); const second = h.run(); await settled(); const latest = h.debug().activity.lastRun;
        const secondId = h.runResources.state.getSnapshot().runs[1]!.id; h.runResources.open(secondId); const selection = h.runResources.state.getSnapshot().selected, before = h.debug();
        const capturedInspection = outputs.state.getSnapshot();
        h.runResources.advance(id); h.runResources.advance(id); assert.equal(h.runResources.state.getSnapshot().runs[0]!.progress, 60); assert.deepEqual(h.debug().source, before.source); assert.deepEqual(h.debug().configuration, before.configuration); assert.deepEqual(h.debug().transfer, before.transfer);
        assert.equal(outputs.state.getSnapshot().inspection, capturedInspection.inspection); assert.equal(capturedInspection.runs[0]!.progress, 0);
        h.finishRun(); await first; assert.equal(h.runResources.state.getSnapshot().runs[0]!.status, "completed"); assert.equal(h.debug().activity.pendingRuns, 1); assert.equal(h.runResources.state.getSnapshot().selected, selection); assert.deepEqual(h.debug().activity.lastRun, latest);
        h.failRun(); await second; assert.equal(h.runResources.state.getSnapshot().runs[1]!.status, "failed");
        assert.equal(h.runResources.capture(id), input); h.runResources.open(initialLog); assert.deepEqual(h.runResources.inspect(), oldLog); assert.equal(h.runResources.inspect()?.links[0]?.id, id);
        const logModel = runPanelModel(outputs, outputs.state.getSnapshot()); outputs.open(secondId); logModel.inspection.links()[0]!.invoke();
        assert.equal(outputs.state.getSnapshot().selected, id); assert.equal(h.runResources.inspect()?.preview, "start");
        h.runResources.open(h.source.id); const sourceSnapshot = outputs.state.getSnapshot(), sourceModel = runPanelModel(outputs, sourceSnapshot);
        sourceEdit(h, " newer"); assert.equal(outputs.state.getSnapshot(), sourceSnapshot);
        outputs.open(secondId); sourceModel.inspection.refresh.invoke(); assert.equal(outputs.state.getSnapshot().selected, h.source.id);
        assert.equal(h.runResources.inspect()?.preview, "start later newer"); assert.equal(sourceSnapshot.inspection?.preview, "start later");
        sourceModel.rows.items()[0]!.inspect.invoke(); assert.equal(outputs.state.getSnapshot().selected, id);
    } finally { stop(); await h.dispose(); assert.equal(h.debug().diagnostics.leases, 0); }
});

test("disposal interrupts Run resources and pending transfer Save without completing or losing inputs", async () => {
    const h = new HostController(); h.transfer.update("destination", "unsaved.csv"); h.transfer.save.save(); const run = h.run(); await settled();
    const id = h.runResources.state.getSnapshot().runs[0]!.id; await h.dispose(); await run; const stopped = h.debug(); assert.equal(stopped.runResources.runs[0]!.status, "interrupted"); assert.equal(stopped.activity.completedRuns, 0); assert.equal(stopped.diagnostics.leases, 0);
    assert.equal(transfer(h).value().destination, "unsaved.csv"); h.runResources.advance(id); h.transfer.save.finish(); h.transfer.save.save(); h.runResources.open(id); await settled(); assert.deepEqual(h.debug(), stopped);
});
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
        save.finish(); await settled(); assert.equal(configuration(h).value().path, "later.csv"); assert.equal(configuration(h).metadata.dirty, true); assert.equal(configuration(h).metadata.serverVersion, "configuration-v1");
        assert.deepEqual(configuration(h).value().opaque, capture.value.opaque); assert.equal(h.workspace.document(h.source.documentId), source); assert.deepEqual(h.workspace.observeHistory(h.source.documentId).getSnapshot(), history);
        save.save(); await settled(); assert.equal(save.capture()?.expectedServerVersion, "configuration-v1"); save.fail(); await settled(); assert.equal(configuration(h).metadata.saveStatus, "failed");
        h.setPath(" retry.csv "); save.save(); await settled(); save.finish(); await settled(); assert.equal(configuration(h).value().path, "retry.csv"); assert.equal(configuration(h).metadata.dirty, false);
        assert.deepEqual(configuration(h).value().opaque, capture.value.opaque); assert.equal(h.runCapture(0)?.configuration.path, "later.csv"); assert.equal(h.debug().activity.completedRuns, 0);
        h.finishSave(); h.finishRun(); await run; await settled(); assert.equal(h.source.metadata.getSnapshot().dirty, true); assert.equal(h.debug().diagnostics.leases, 0);
    } finally { await h.dispose(); }
});

test("configuration review uses an explicit precondition and retains corrections after a second conflict", async () => {
    const h = new HostController(), save = h.configurationSave;
    try {
        h.setPath("local.csv"); save.externalWrite("remote-one.csv"); save.save(); await settled(); save.finish(); await settled();
        assert.equal(configuration(h).value().path, "local.csv"); assert.equal(save.canSave(), false); assert.equal(save.canSaveReviewed(), false);
        save.review(); const firstReview = formSavePanelModel(save, save.presentation.getSnapshot());
        assert.equal(save.state.getSnapshot().conflict?.value?.path, "remote-one.csv"); h.setPath("merged.csv"); save.externalWrite("remote-two.csv");
        save.saveReviewed(); await settled(); assert.equal(save.capture()?.expectedServerVersion, "configuration-v1"); save.finish(); await settled(); assert.equal(configuration(h).metadata.serverVersion, null);
        save.review(); assert.equal(save.state.getSnapshot().conflict?.value?.path, "remote-two.csv");
        const secondReview = save.presentation.getSnapshot(); firstReview.actions[5].invoke(); assert.equal(save.presentation.getSnapshot(), secondReview);
        formSavePanelModel(save, secondReview).actions[5].invoke(); await settled(); save.fail(); await settled(); assert.equal(save.canSaveReviewed(), true);
        h.setPath("final.csv"); save.saveReviewed(); await settled(); assert.equal(save.capture()?.expectedServerVersion, "configuration-v2"); h.setPath("newer.csv"); save.finish(); await settled();
        assert.equal(configuration(h).value().path, "newer.csv"); assert.equal(configuration(h).metadata.dirty, true); assert.equal(configuration(h).metadata.serverVersion, "configuration-v3");
        save.save(); await settled(); save.finish(); await settled(); assert.equal(configuration(h).metadata.dirty, false); assert.equal(configuration(h).metadata.serverVersion, "configuration-v4");
        assert.equal(h.workspace.document(h.source.documentId).text(), "start"); assert.equal(h.workspace.observeHistory(h.source.documentId).getSnapshot().undoDepth, 0);
    } finally { await h.dispose(); }
});

test("invalid configuration remains editable and blocks its Save and Run while source can save", async () => {
    const h = new HostController();
    try {
        h.setPath("   "); h.configurationSave.save(); await h.run(); await settled();
        assert.equal(configuration(h).value().path, "   "); assert.equal(h.configurationSave.capture(), null); assert.equal(h.debug().activity.pendingRuns, 0);
        sourceEdit(h, " correction"); h.save(); await settled(); assert.equal(h.debug().pendingSaves.length, 1); h.finishSave(); await settled(); assert.equal(h.source.metadata.getSnapshot().dirty, false);
    } finally { await h.dispose(); }
});

for (const started of [false, true]) test(`configuration disposal ${started ? "during request" : "before queued request"} settles without losing unsaved inputs`, async () => {
    const h = new HostController(); h.setPath("unsaved.csv"); h.configurationSave.save(); if (started) { await settled(); assert.ok(h.configurationSave.capture()); }
    await h.dispose(); const stopped = h.debug(); assert.equal(stopped.diagnostics.leases, 0); assert.equal(stopped.pendingCommands, 0); assert.equal(configuration(h).value().path, "unsaved.csv");
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

test("host disposal retains an applied proposal as an ordinary unsaved document", async () => {
    const host = new HostController(); host.previewProposalText("unsaved proposal"); host.applyProposal();
    await host.dispose();
    assert.equal(host.debug().diagnostics.leases, 0);
    assert.equal(host.source.getSnapshot().state, "ready");
    assert.equal(host.workspace.document(host.source.documentId).text(), "unsaved proposal"); assert.equal(host.debug().source.dirty, true);
});

test("parallel Run captures, denied submission and older results keep independent counts and targets", async () => {
    const denied = new Set<ResourceId>();
    const host = new HostController(id => !denied.has(id));
    try {
        const first = host.run(); host.setPath("second.csv");
        host.workspace.edit({ documentId: host.source.documentId, expectedRevision: 0, origin: "human", edits: [{ from: 0, to: 5, insert: "second source" }] });
        const second = host.run();
        assert.equal(host.debug().activity.pendingRuns, 2);
        assert.deepEqual(host.runCapture(0), { source: "start", configuration: { path: "source.csv", format: "csv" }, settings: { mode: "preview" } });
        assert.deepEqual(host.runCapture(1), { source: "second source", configuration: { path: "second.csv", format: "csv" }, settings: { mode: "preview" } });
        denied.add(host.source.id);
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
