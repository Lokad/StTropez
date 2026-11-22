import test from "node:test";
import assert from "node:assert/strict";
import { HostController } from "../examples/hosts/controller.ts";

const settled = () => new Promise<void>(resolve => setImmediate(resolve));
const value = (host: HostController) => host.workspace.document(host.source.documentId).buffer.slice(0, host.debug().source.length);
function edit(host: HostController, text: string): void {
    const current = host.debug().source;
    assert.equal(host.workspace.edit({ documentId: host.source.documentId, expectedRevision: current.revision, origin: "human",
        edits: [{ from: 0, to: current.length, insert: text }] }).applied, true);
}

test("a failed host save retains corrections and baseline; retry keeps later edits", async () => {
    const host = new HostController();
    try {
        host.previewProposalText("proposal"); host.applyProposal();
        edit(host, "corrected"); const reference = host.savedComparisonReference(), retainedLeases = host.debug().diagnostics.leases;
        assert.equal(retainedLeases, 0);
        host.save(); await settled(); edit(host, "corrected later");
        const before = host.debug(); assert.equal(before.diagnostics.leases, retainedLeases + 1);
        host.failSave(); await settled(); const failed = host.debug();
        assert.equal(value(host), "corrected later"); assert.equal(failed.source.revision, before.source.revision);
        assert.deepEqual(failed.history, before.history);
        assert.deepEqual(failed.server, before.server); assert.equal(host.savedComparisonReference(), reference);
        assert.equal(failed.source.saveStatus, "failed"); assert.equal(failed.source.serverVersion, "v0"); assert.equal(failed.source.dirty, true);
        assert.equal(failed.activity.writes, 0); assert.equal(failed.activity.errors, 1); assert.equal(failed.pendingCommands, 0);
        assert.equal(failed.diagnostics.leases, retainedLeases);
        assert.equal(failed.layout.modal.kind, "error");
        const retryRevision = failed.source.revision; host.save(); await settled();
        assert.deepEqual(host.debug().pendingSaves, [{ revision: retryRevision, length: "corrected later".length, expectedServerVersion: "v0" }]);
        edit(host, "corrected later newest"); host.move(); host.finishSave(); await settled();
        const saved = host.debug(); assert.equal(value(host), "corrected later newest");
        assert.equal(saved.layout.modal.kind, "none");
        assert.equal(saved.activity.lastSavedRevision, retryRevision); assert.equal(saved.source.serverVersion, "v1");
        assert.equal(saved.source.dirty, true); assert.equal(saved.activity.writes, 1);
        assert.equal(host.savedComparisonReference().buffer.slice(0, "corrected later".length), "corrected later");
        host.workspace.undo({ documentId: host.source.documentId, expectedRevision: saved.source.revision });
        assert.equal(value(host), "corrected later"); assert.equal(host.debug().source.dirty, false);
        host.workspace.redo({ documentId: host.source.documentId, expectedRevision: host.debug().source.revision });
        assert.equal(value(host), "corrected later newest"); assert.equal(host.debug().source.dirty, true);
        assert.equal(host.debug().diagnostics.leases, 0);
        assert.equal(host.debug().activity.writes, 1); assert.equal(value(host), "corrected later newest");
    } finally { await host.dispose(); }
    assert.equal(host.debug().diagnostics.leases, 0); assert.equal(host.debug().pendingCommands, 0);
});

test("a rejected save advances queued captures without rebasing their content and disposal settles a late failure", async () => {
    const host = new HostController();
    try {
        edit(host, "first"); host.save(); await settled();
        edit(host, "second"); const secondRevision = host.debug().source.revision; host.save();
        edit(host, "third"); const thirdRevision = host.debug().source.revision; host.save(); edit(host, "third later");
        host.failSave(); await settled();
        assert.deepEqual(host.debug().pendingSaves, [{ revision: secondRevision, length: 6, expectedServerVersion: "v0" }]);
        assert.equal(value(host), "third later"); assert.equal(host.debug().activity.writes, 0);
        host.replacePrimary(); host.reportError(new Error("An unrelated operation failed."));
        const otherError = host.layout.getSnapshot().modal;
        host.finishSave(); await settled(); assert.equal(host.layout.getSnapshot().modal, otherError);
        assert.deepEqual(host.debug().pendingSaves, [{ revision: thirdRevision, length: 5, expectedServerVersion: "v1" }]);
        assert.equal(host.debug().activity.lastSavedRevision, secondRevision); assert.equal(value(host), "third later");
        assert.equal(host.savedComparisonReference().buffer.slice(0, 6), "second");
        host.failSave(); await host.dispose(); const stopped = host.debug();
        assert.equal(stopped.pendingCommands, 0); assert.equal(stopped.pendingSaves.length, 0); assert.equal(stopped.diagnostics.leases, 0);
        assert.equal(stopped.source.dirty, true); assert.equal(stopped.activity.writes, 1); assert.equal(value(host), "third later");
        host.failSave(); host.finishSave(); await settled(); assert.deepEqual(host.debug(), stopped);
    } finally { await host.dispose(); }
});
