import test from "node:test";
import assert from "node:assert/strict";
import { TextBuffer, Workspace, WorkspaceCommands } from "../src/index.ts";
import type { SaveResponse, SaveSubmission, TextTransaction } from "../src/index.ts";

function fixture() {
    const workspace = new Workspace(), source = workspace.createTextResource({ scope: "review", resource: "source", variant: "working" }, "Source", { value: "base", serverVersion: "v0" });
    const edit = (text: string) => { const current = workspace.document(source.documentId); return workspace.edit({ documentId: current.id, expectedRevision: current.revision,
        origin: "human", edits: [{ from: 0, to: current.buffer.length, insert: text }] }); };
    return { workspace, source, edit, commands: new WorkspaceCommands(workspace) };
}

test("successive edits publish one revision, map other views and undo together", () => {
    const { workspace, source } = fixture(), id = source.documentId;
    const view = workspace.createDocumentView(id, { anchor: 4, head: 4 });
    const options = { origin: "host", source: "peer", history: "record" } as const;
    const changes: number[] = [];
    const stop = workspace.onDocumentChange(id, change => changes.push(change.revision));
    let captured: TextTransaction | undefined;
    const result = workspace.transact(id, 0, tx => {
        captured = tx;
        tx.edit([{ from: 0, to: 0, insert: "!" }]);
        assert.equal(tx.buffer.slice(0, 2), "!b");
        tx.edit([{ from: 2, to: 4, insert: "XY" }]);
        assert.equal(workspace.document(id).text(), "base");
    }, options);
    assert.deepEqual(result, { applied: true, revision: 1 });
    assert.deepEqual(changes, [1]);
    const change = workspace.document(id).change!;
    assert.equal(change.source, "peer"); assert.equal(workspace.document(id).text(), "!bXYe");
    assert.equal(TextBuffer.from("base").apply(change.edits).buffer.text(), "!bXYe");
    assert.equal(view.getSnapshot().selection.head, 5);
    assert.throws(() => captured!.edit([]), /no longer open/);
    assert.equal(workspace.observeHistory(id).getSnapshot().undoDepth, 1);
    assert.equal(workspace.undo({ documentId: id, expectedRevision: 1 }).applied, true);
    assert.equal(workspace.document(id).text(), "base"); assert.equal(view.getSnapshot().selection.head, 4);
    assert.equal(workspace.redo({ documentId: id, expectedRevision: 2 }).applied, true);
    assert.equal(workspace.document(id).text(), "!bXYe");
    assert.deepEqual(workspace.transact(id, 0, () => assert.fail("stale callback ran"), options), { applied: false, reason: "stale-revision" });
    stop(); view.dispose();
});

test("an invalid second step, async callback or reentrant write cannot partially commit a transaction", async () => {
    const { workspace, source, edit } = fixture(), id = source.documentId, before = workspace.document(id);
    const options = { origin: "host", history: "reset" } as const;
    const insert = [{ from: 0, to: 0, insert: "first" }];
    let notifications = 0;
    const stop = workspace.subscribe(() => { notifications++; });
    assert.throws(() => workspace.transact(id, 0, tx => {
        tx.edit(insert);
        assert.throws(() => tx.edit([{ from: 1000, to: 1000, insert: "x" }]), RangeError);
    }, options), /failed text transaction/);
    assert.throws(() => workspace.transact(id, 0, tx => { tx.edit(insert); edit("outside"); }, options), /Reentrant/);
    assert.throws(() => workspace.transact(id, 0, async tx => { tx.edit(insert); await Promise.resolve(); tx.edit(insert); }, options), /synchronous/);
    await Promise.resolve();
    assert.equal(workspace.document(id), before); assert.equal(notifications, 0);
    assert.deepEqual(workspace.observeHistory(id).getSnapshot(), { undoDepth: 0, redoDepth: 0 }); stop();
});

test("whole-text writes retain unchanged ranges, report no-ops and guard the captured revision", () => {
    const { workspace, source } = fixture();
    const id = source.documentId, options = { origin: "host", history: "record", source: "draft" } as const;
    const view = workspace.createDocumentView(id, { anchor: 4, head: 4 });
    const changed = workspace.replaceText(id, "new base", options);
    assert.deepEqual(changed, { applied: true, changed: true, revision: 1 });
    assert.equal(view.getSnapshot().selection.head, 8);
    const current = workspace.document(id);
    assert.deepEqual(current.change?.edits, [{ from: 0, to: 0, insert: "new " }]);
    assert.equal(current.change?.source, "draft");
    assert.deepEqual(workspace.replaceText(id, TextBuffer.from("new base"), options), { applied: true, changed: false, revision: 1 });
    assert.equal(workspace.document(id), current);
    assert.deepEqual(workspace.replaceText(id, "stale", { ...options, expectedRevision: 0 }), { applied: false, reason: "stale-revision" });
    assert.equal(workspace.undo({ documentId: id, expectedRevision: 1 }).applied, true);
    assert.equal(workspace.document(id).text(), "base"); assert.equal(view.getSnapshot().selection.head, 4);
    workspace.replaceText(id, "base", { ...options, history: "reset" });
    assert.equal(workspace.observeHistory(id).getSnapshot().redoDepth, 0);
    view.dispose();
});

test("adopting a saved buffer publishes the revision, authority and mapped view together", () => {
    const { workspace, source, edit } = fixture();
    edit("head\n  child\nend");
    const view = workspace.createDocumentView(source.documentId, { anchor: 13, head: 16 });
    view.folding.setRanges(view.folding.getSnapshot(), [{ id: "h", from: 0, to: 12, collapsed: true }]);
    const old = workspace.document(source.documentId);
    const saved = old.buffer.replace(0, 0, "note\n");
    const observed: unknown[] = [];
    const stop = workspace.onDocumentChange(source.documentId, change => observed.push({
        edits: change.edits, source: change.source, saved: source.metadata.getSnapshot().serverVersion,
        dirty: source.metadata.getSnapshot().dirty, selection: view.getSnapshot().selection,
        folded: view.folding.getSnapshot().index.collapsedCount
    }));
    const adopted = workspace.adoptSaved(source.id, { text: saved, serverVersion: "v2", history: "record", source: "review" });
    stop();
    assert.deepEqual(adopted, { applied: true, revision: 2 });
    assert.deepEqual(observed, [{ edits: [{ from: 0, to: 0, insert: "note\n" }], source: "review", saved: "v2",
        dirty: false, selection: { anchor: 18, head: 21, anchorAffinity: "after", headAffinity: "before" }, folded: 1 }]);
    assert.equal(workspace.document(source.documentId).buffer, saved);
    // An equal adoption advances the authority revision and preserves existing undo entries.
    workspace.adoptSaved(source.id, { text: TextBuffer.from("note\nhead\n  child\nend"), serverVersion: "v3", history: "record" });
    assert.equal(workspace.undo({ documentId: source.documentId, expectedRevision: 3 }).applied, true);
    assert.equal(workspace.document(source.documentId).buffer, old.buffer);
    assert.equal(source.metadata.getSnapshot().dirty, true);
    assert.equal(workspace.redo({ documentId: source.documentId, expectedRevision: 4 }).applied, true);
    assert.equal(source.metadata.getSnapshot().dirty, false);
    workspace.adoptSaved(source.id, { text: saved, serverVersion: "v4", history: "reset" });
    assert.equal(workspace.observeHistory(source.documentId).getSnapshot().undoDepth, 0);
    assert.equal(saved.readMetrics().textExports, 0); view.dispose();
});

test("saved text respects outstanding saves, reload reservations and dirty read-only work", () => {
    const { workspace, source, edit } = fixture();
    const next = { text: "replacement", serverVersion: "v2", history: "reset" as const };
    edit("local");
    const state = source.getSnapshot(), ticket = workspace.captureSave(source);
    assert.equal(workspace.adoptSaved(source.id, next).applied, false); ticket.finish();
    const lease = workspace.acquire(source.id, { preventReload: true });
    assert.equal(workspace.adoptSaved(source.id, next).applied, false); lease.release();
    assert.equal(source.getSnapshot().revision, state.revision);
    workspace.setCapabilities(source.id, { edit: [], save: false, run: false });
    assert.deepEqual(workspace.adoptSaved(source.id, next), { applied: false, reason: "read-only" });
    assert.equal(workspace.document(source.documentId).buffer.slice(0, 5), "local");
});

test("reviewed retry preserves the old baseline until a receipt, then keeps later typing and canonical dirty semantics", async () => {
    const { workspace, source, edit, commands } = fixture(); edit("merged  ");
    const failed = await commands.save(workspace.captureSave(source), { save: async submission => { assert.equal(submission.expectedServerVersion, "v0"); return { kind: "conflict", serverVersion: "v1" }; } });
    assert.equal(failed.kind, "conflict"); assert.equal(source.metadata.getSnapshot().serverVersion, "v0");
    const revision = source.getSnapshot().revision;
    let resolve!: (value: SaveResponse<string>) => void, submission: SaveSubmission<string> | undefined;
    const saving = commands.save(workspace.captureSave(source, { target: workspace.captureResource(source.id), expectedRevision: revision, expectedServerVersion: "v1" }), { save: value => { submission = value; return new Promise(done => { resolve = done; }); } });
    await Promise.resolve(); assert.equal(submission!.expectedServerVersion, "v1"); assert.equal(submission!.value, "merged  ");
    assert.equal(source.metadata.getSnapshot().serverVersion, "v0");
    edit("merged   later"); resolve({ kind: "saved", serverVersion: "v2", canonical: "merged" });
    const result = await saving; assert.equal(result.kind, "saved");
    if (result.kind === "saved") { assert.equal(result.receipt.canonicalApplied, false); assert.equal(result.receipt.submission.revision, revision); }
    assert.equal(workspace.document(source.documentId).text(), "merged   later"); assert.equal(source.metadata.getSnapshot().dirty, true);
    workspace.undo({ documentId: source.documentId, expectedRevision: source.getSnapshot().revision });
    assert.equal(workspace.document(source.documentId).text(), "merged  "); assert.equal(source.metadata.getSnapshot().dirty, true);
    edit("merged"); assert.equal(source.metadata.getSnapshot().dirty, false); assert.equal(source.metadata.getSnapshot().serverVersion, "v2");
    assert.equal(workspace.ownership(source.id).leases, 0);
});

test("another remote change rejects a reviewed retry without adopting either remote version", async () => {
    const { workspace, source, edit, commands } = fixture(); edit("local");
    const reviewed = { target: workspace.captureResource(source.id), expectedRevision: source.getSnapshot().revision, expectedServerVersion: "v1" };
    const result = await commands.save(workspace.captureSave(source, reviewed), { save: async submission => { assert.equal(submission.expectedServerVersion, "v1"); return { kind: "conflict", serverVersion: "v2" }; } });
    assert.deepEqual(result, { kind: "conflict", serverVersion: "v2" }); assert.equal(source.metadata.getSnapshot().serverVersion, "v0");
    assert.equal(workspace.document(source.documentId).text(), "local");
    edit("base"); assert.equal(source.metadata.getSnapshot().dirty, false); assert.equal(workspace.ownership(source.id).leases, 0);
});

test("stale or malformed review and reserved saves reject before acquiring ownership or changing snapshots", () => {
    const { workspace, source, edit } = fixture(); edit("local"); const revision = source.getSnapshot().revision;
    const before = source.getSnapshot(), history = workspace.observeHistory(source.documentId).getSnapshot();
    for (const review of [{ target: workspace.captureResource(source.id), expectedRevision: revision - 1, expectedServerVersion: "v1" }, { target: workspace.captureResource(source.id), expectedRevision: -1, expectedServerVersion: "v1" } ]) {
        assert.throws(() => workspace.captureSave(source, review));
        assert.equal(source.getSnapshot(), before); assert.equal(workspace.observeHistory(source.documentId).getSnapshot(), history);
        assert.equal(workspace.ownership(source.id).leases, 0);
    }
    const pending = workspace.captureSave(source);
    assert.throws(() => workspace.captureSave(source, { target: workspace.captureResource(source.id), expectedRevision: revision, expectedServerVersion: "v1" }));
    assert.equal(workspace.ownership(source.id).leases, 1); pending.finish(); assert.equal(workspace.ownership(source.id).leases, 0);
});

test("a review version is copied at capture and an intervening local receipt expires that review", () => {
    const { workspace, source, edit } = fixture(); edit("local");
    const review = { target: workspace.captureResource(source.id), expectedRevision: source.getSnapshot().revision, expectedServerVersion: "reviewed-v1" };
    const ticket = workspace.captureSave(source, review); review.expectedServerVersion = "mutated";
    assert.equal(ticket.start().expectedServerVersion, "reviewed-v1"); ticket.conflict(); ticket.finish();
    const stale = workspace.captureSave(source, { target: workspace.captureResource(source.id), expectedRevision: source.getSnapshot().revision, expectedServerVersion: "reviewed-v1" });
    const other = workspace.captureSave(source); other.start(); other.accept({ serverVersion: "other-receipt" }); other.finish();
    assert.throws(() => stale.start(), /baseline changed/); stale.finish();
    assert.equal(source.metadata.getSnapshot().serverVersion, "other-receipt"); assert.equal(workspace.ownership(source.id).leases, 0);
});


test("typed resources use the reviewed precondition without acquiring a text document", async () => {
    const workspace = new Workspace(), commands = new WorkspaceCommands(workspace);
    const form = workspace.createResource({ scope: "review", resource: "form", variant: "working" }, "Form", { value: { path: "base.csv" }, serverVersion: "v0" });
    workspace.updateResource(form, { expectedRevision: 0, origin: "human", value: { path: "merged.csv" } });
    const result = await commands.save(workspace.captureSave(form, { target: workspace.captureResource(form.id), expectedRevision: 1, expectedServerVersion: "v1" }), { save: async submission => {
        assert.equal(submission.expectedServerVersion, "v1");
        workspace.updateResource(form, { expectedRevision: 1, origin: "human", value: { path: "later.csv" } });
        return { kind: "saved", serverVersion: "v2" };
    } });
    assert.equal(result.kind, "saved"); const final = form.getSnapshot(); assert.equal(final.state, "ready");
    if (final.state === "ready") assert.deepEqual(final.value(), { path: "later.csv" });
    assert.equal(final.metadata.dirty, true); assert.equal(workspace.diagnostics().documents, 0); assert.equal(workspace.ownership(form.id).leases, 0);
});

test("reviewed preconditions cannot transfer to an equal-revision resource in this or another workspace", () => {
    const { workspace, source } = fixture(), other = workspace.createTextResource({ scope: "review", resource: "other", variant: "working" }, "Other", { value: "other", serverVersion: "v0" });
    const foreign = fixture();
    for (const target of [workspace.captureResource(other.id), foreign.workspace.captureResource(foreign.source.id)]) {
        assert.throws(() => workspace.captureSave(source, { target, expectedRevision: 0, expectedServerVersion: "v1" }), /another resource or workspace/);
        assert.equal(workspace.ownership(source.id).leases, 0); assert.equal(source.getSnapshot().revision, 0);
    }
});
