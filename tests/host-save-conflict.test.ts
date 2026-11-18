import test from "node:test";
import assert from "node:assert/strict";
import { HostController } from "../examples/hosts/controller.ts";
import { saveConflictPanelModel } from "../examples/hosts/operation-panels.ts";
const settled = () => new Promise<void>(resolve => setImmediate(resolve));
function edit(host: HostController, text: string): void {
    const current = host.workspace.document(host.source.documentId);
    assert.equal(host.workspace.edit({ documentId: current.id, expectedRevision: current.revision, origin: "human", edits: [{ from: 0, to: current.buffer.length, insert: text }] }).applied, true);
}
async function conflict(host: HostController): Promise<void> {
    edit(host, "local"); host.save(); await settled(); host.externalWrite("remote one"); host.finishSave(); await settled();
    assert.equal(host.debug().source.saveStatus, "conflict"); assert.equal(host.debug().source.serverVersion, "v0");
}

test("conflict presentation observes authority and keeps old controls out of newer reviews", async () => {
    const host = new HostController(), store = host.saveConflictPresentation, before = host.debug();
    let notified = store.getSnapshot(); const stop = store.subscribe(() => { notified = store.getSnapshot(); });
    const model = () => saveConflictPanelModel(host, store.getSnapshot());
    try {
        assert.equal(store.getSnapshot(), notified); assert.ok(Object.isFrozen(notified));
        assert.equal(host.debug().diagnostics.subscriptions, before.diagnostics.subscriptions + 2);
        assert.equal(host.debug().hostSubscriptions, before.hostSubscriptions + 2);
        const empty = model(); await conflict(host); empty.actions[0].invoke(); assert.equal(host.debug().pendingConflictReads, 0);
        model().actions[0].invoke(); const loading = model(); loading.actions[1].invoke(); const first = model();
        assert.equal(notified.canSaveReviewed, true); assert.equal(notified.conflict?.reviewVersion, "v1");
        host.externalWrite("remote two"); first.actions[0].invoke(); loading.actions[1].invoke(); assert.equal(host.debug().pendingConflictReads, 1);
        model().actions[1].invoke(); const second = model(), current = store.getSnapshot(); assert.equal(current.conflict?.reviewVersion, "v2");
        first.actions[0].invoke(); first.actions[2].invoke(); await settled(); assert.equal(host.debug().pendingConflictReads, 0); assert.equal(host.debug().pendingSaves.length, 0);
        edit(host, "current correction"); assert.equal(store.getSnapshot(), current);
        const capabilities = host.source.metadata.getSnapshot().capabilities;
        host.workspace.setCapabilities(host.source.id, { ...capabilities, save: false }); assert.equal(notified.canSaveReviewed, false);
        host.workspace.setCapabilities(host.source.id, capabilities); assert.equal(notified.canSaveReviewed, true);
        const layout = host.layout.getSnapshot();
        host.workspace.replace(host.viewTab("primary"), { kind: "panel", resourceId: host.connection.id, panelType: "configuration" });
        assert.equal(host.layout.getSnapshot(), layout); assert.equal(notified.canSaveReviewed, false);
        host.reopenPrimary(); model().actions[0].invoke(); model().actions[1].invoke(); const latest = model();
        second.actions[2].invoke(); await settled(); assert.equal(host.debug().pendingSaves.length, 0);
        const release = host.registerInputCaptureGuard(() => false);
        try { latest.actions[2].invoke(); await settled(); assert.equal(host.debug().pendingSaves.length, 0); } finally { release(); }
        latest.actions[2].invoke(); await settled(); assert.equal(host.debug().pendingSaves[0]?.expectedServerVersion, "v2"); assert.equal(notified.canSaveReviewed, false);
        host.finishSave(); await settled(); assert.equal(notified.conflict, null);
        await host.dispose(); assert.equal(notified.disposed, true); const disposed = host.debug();
        first.actions[2].invoke(); second.actions[1].invoke(); assert.deepEqual(host.debug(), disposed);
        stop(); assert.equal(host.debug().diagnostics.subscriptions, 0); assert.equal(host.debug().hostSubscriptions, 0);
    } finally { stop(); await host.dispose(); }
});

test("host conflict review captures remote data while later edits and another external writer remain independent", async () => {
    const host = new HostController();
    try {
        await conflict(host); host.reviewSaveConflict(); host.externalWrite("remote two"); edit(host, "local while reading"); host.move();
        assert.equal(host.finishConflictReview(), true); assert.equal(host.comparisonReference.getSnapshot().baseline.buffer.slice(0, 10), "remote one");
        host.saveReviewedSource(); await settled(); assert.equal(host.debug().pendingSaves[0]!.expectedServerVersion, "v1");
        host.finishSave(); await settled(); assert.equal(host.debug().source.serverVersion, "v0"); assert.equal(host.debug().saveConflict!.observedVersion, "v2");
        assert.equal(host.debug().activity.writes, 0); host.reviewSaveConflict(); assert.equal(host.finishConflictReview(), true);
        edit(host, "merged"); host.saveReviewedSource(); await settled(); edit(host, "merged later"); host.finishSave(); await settled();
        assert.equal(host.workspace.document(host.source.documentId).text(), "merged later");
        assert.equal(host.debug().saveConflict, null); assert.equal(host.debug().source.serverVersion, "v3"); assert.equal(host.debug().source.dirty, true);
        host.workspace.undo({ documentId: host.source.documentId, expectedRevision: host.debug().source.revision });
        assert.equal(host.workspace.document(host.source.documentId).text(), "merged"); assert.equal(host.debug().source.dirty, false);
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

for (const action of ["loading", "completed", "cancelled", "failed", "reference"] as const)
    test(`a newer version choice or reference publication expires an older remote conflict review: ${action}`, async () => {
        const host = new HostController();
        try {
            await conflict(host); host.variants.keepDraft(); host.reviewSaveConflict();
            if (action === "reference") host.retainComparisonReference(host.savedComparisonReference());
            else {
                assert.equal(host.variants.review("draft"), true);
                if (action === "completed") assert.equal(host.variants.finishNext(), true);
                if (action === "cancelled") host.variants.cancel();
                if (action === "failed") host.variants.failNext();
            }
            const reference = host.comparisonReference.getSnapshot(), history = host.debug().history;
            edit(host, "later human correction"); const laterHistory = host.debug().history;
            assert.equal(host.finishConflictReview(), false, action);
            assert.equal(host.comparisonReference.getSnapshot(), reference, action);
            assert.equal(host.canSaveReviewedSource(), false); assert.equal(host.debug().saveConflict!.review, "expired");
            assert.equal(host.workspace.document(host.source.documentId).text(), "later human correction");
            assert.deepEqual(host.debug().history, laterHistory); assert.notDeepEqual(laterHistory, history);
            if (action === "loading") assert.equal(host.variants.finishNext(), true);
            assert.equal(host.debug().diagnostics.leases, 0);
        } finally { await host.dispose(); }
    });

test("a newer remote review expires an older version load before either response publishes", async () => {
    const host = new HostController();
    try {
        await conflict(host); host.variants.keepDraft(); assert.equal(host.variants.review("draft"), true);
        host.reviewSaveConflict(); const reference = host.comparisonReference.getSnapshot(), history = host.debug().history;
        assert.equal(host.variants.finishNext(), false); assert.equal(host.comparisonReference.getSnapshot(), reference);
        assert.equal(host.finishConflictReview(), true); assert.equal(host.canSaveReviewedSource(), true);
        assert.equal(host.comparisonReference.getSnapshot().baseline.version, "reference:conflict-v1");
        assert.equal(host.workspace.document(host.source.documentId).text(), "local"); assert.deepEqual(host.debug().history, history);
        assert.equal(host.debug().diagnostics.leases, 0);
        assert.equal(host.variants.review("draft"), true); assert.equal(host.canSaveReviewedSource(), false);
        host.variants.cancel(); host.saveReviewedSource(); await settled();
        assert.equal(host.canSaveReviewedSource(), false); assert.equal(host.debug().pendingSaves.length, 0);
        host.reviewSaveConflict(); assert.equal(host.finishConflictReview(), true); assert.equal(host.canSaveReviewedSource(), true);
    } finally { await host.dispose(); }
});

for (const kind of ["remote", "variant"] as const) for (const reopen of [false, true])
    test(`dismissed review loads cannot publish or reopen the comparison, including after reopening: ${kind}/${reopen ? "reopened" : "closed"}`, async () => {
        const host = new HostController();
        try {
            await conflict(host); host.variants.keepDraft(); host.openReview();
            if (kind === "remote") host.reviewSaveConflict(); else assert.equal(host.variants.review("draft"), true);
            host.closeReview(); if (reopen) host.openReview();
            const reference = host.comparisonReference.getSnapshot(), navigation = host.layout.getSnapshot().navigation;
            edit(host, "human after dismissal"); const history = host.debug().history;
            assert.equal(kind === "remote" ? host.finishConflictReview() : host.variants.finishNext(), false, `${kind}/${reopen}`);
            assert.equal(host.comparisonReference.getSnapshot(), reference); assert.equal(host.layout.getSnapshot().navigation, navigation);
            assert.equal(host.workspace.document(host.source.documentId).text(), "human after dismissal"); assert.deepEqual(host.debug().history, history);
            assert.equal(host.canSaveReviewedSource(), false); assert.equal(host.debug().diagnostics.leases, 0);
            host.reviewSaveConflict(); assert.equal(host.finishConflictReview(), true); assert.equal(host.canSaveReviewedSource(), true);
            host.closeReview(); assert.equal(host.canSaveReviewedSource(), true);
        } finally { await host.dispose(); }
    });
