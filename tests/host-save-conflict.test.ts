import test from "node:test";
import assert from "node:assert/strict";
import { HostController } from "../examples/hosts/controller.ts";
const settled = () => new Promise<void>(resolve => setImmediate(resolve));
function edit(host: HostController, text: string): void {
    const current = host.workspace.document(host.source.documentId);
    assert.equal(host.workspace.edit({ documentId: current.id, expectedRevision: current.revision, origin: "human", edits: [{ from: 0, to: current.buffer.length, insert: text }] }).applied, true);
}
async function conflict(host: HostController): Promise<void> {
    edit(host, "local"); host.save(); await settled(); host.externalWrite("remote one"); host.finishSave(); await settled();
    assert.equal(host.debug().source.saveStatus, "conflict"); assert.equal(host.debug().source.serverVersion, "v0");
}

test("host conflict review captures remote data while later edits and another external writer remain independent", async () => {
    const host = new HostController();
    try {
        await conflict(host); host.reviewSaveConflict(); host.externalWrite("remote two"); edit(host, "local while reading"); host.move();
        assert.equal(host.finishConflictReview(), true); assert.equal(host.comparisonReference.getSnapshot().baseline.buffer.slice(0, 10), "remote one");
        host.saveReviewedSource(); await settled(); assert.equal(host.debug().pendingSaves[0]!.expectedServerVersion, "v1");
        host.finishSave(); await settled(); assert.equal(host.debug().source.serverVersion, "v0"); assert.equal(host.debug().saveConflict!.observedVersion, "v2");
        assert.equal(host.debug().activity.writes, 0); host.reviewSaveConflict(); assert.equal(host.finishConflictReview(), true);
        edit(host, "merged"); host.saveReviewedSource(); await settled(); edit(host, "merged later"); host.finishSave(); await settled();
        assert.equal(host.workspace.document(host.source.documentId).text, "merged later");
        assert.equal(host.debug().saveConflict, null); assert.equal(host.debug().source.serverVersion, "v3"); assert.equal(host.debug().source.dirty, true);
        host.workspace.undo({ documentId: host.source.documentId, expectedRevision: host.debug().source.revision });
        assert.equal(host.workspace.document(host.source.documentId).text, "merged"); assert.equal(host.debug().source.dirty, false);
        assert.equal(host.comparisonReference.getSnapshot().baseline.version, "reference:conflict-v2");
    } finally { await host.dispose(); }
    assert.equal(host.debug().diagnostics.leases, 0);
});

test("replaced presentations and changed reference versions cannot authorize a later reviewed save", async () => {
    const host = new HostController();
    try {
        await conflict(host); host.reviewSaveConflict(); host.replacePrimary(); assert.equal(host.finishConflictReview(), false);
        assert.equal(host.debug().saveConflict!.review, "expired"); host.reopenPrimary(); host.saveReviewedSource(); await settled();
        assert.equal(host.debug().pendingSaves.length, 0); assert.equal(host.debug().source.serverVersion, "v0");
        host.reviewSaveConflict(); assert.equal(host.finishConflictReview(), true); assert.equal(host.canSaveReviewedSource(), true);
        host.retainComparisonReference(host.savedComparisonReference()); assert.equal(host.canSaveReviewedSource(), false);
        host.saveReviewedSource(); assert.equal(host.debug().pendingSaves.length, 0); assert.equal(host.debug().saveConflict!.review, "expired");
    } finally { await host.dispose(); }
});

test("superseded remote reads cannot publish over a newer review, and disposal settles pending read ownership", async () => {
    const host = new HostController(); await conflict(host);
    host.reviewSaveConflict(); host.externalWrite("remote two"); host.reviewSaveConflict();
    assert.equal(host.debug().pendingConflictReads, 2); assert.equal(host.finishConflictReview(), false);
    assert.equal(host.debug().saveConflict!.review, "loading"); assert.equal(host.finishConflictReview(), true);
    assert.equal(host.debug().saveConflict!.reviewVersion, "v2"); assert.equal(host.debug().diagnostics.leases, 0);
    host.reviewSaveConflict(); host.reviewSaveConflict(); await host.dispose();
    const stopped = host.debug(); assert.equal(stopped.pendingConflictReads, 0); assert.equal(stopped.diagnostics.leases, 0);
    assert.equal(host.finishConflictReview(), false); await settled(); assert.deepEqual(host.debug(), stopped);
});
