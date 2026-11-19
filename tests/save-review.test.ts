import test from "node:test";
import assert from "node:assert/strict";
import { createAgentReview, Workspace, WorkspaceCommands } from "../src/index.ts";
import type { SaveResponse, SaveSubmission } from "../src/index.ts";

function fixture() {
    const workspace = new Workspace(), source = workspace.createTextResource({ scope: "review", resource: "source", variant: "working" }, "Source", { value: "base", serverVersion: "v0" });
    const edit = (text: string) => { const current = workspace.document(source.documentId); return workspace.edit({ documentId: current.id, expectedRevision: current.revision,
        origin: "human", edits: [{ from: 0, to: current.buffer.length, insert: text }] }); };
    return { workspace, source, edit, commands: new WorkspaceCommands(workspace) };
}

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

test("reviewed writes retain proposal identity and independently retryable acknowledgement receipts", async () => {
    const { workspace, source, edit, commands } = fixture(); createAgentReview(workspace, source).associate("agent");
    const request = createAgentReview(workspace, source).beginRequest(null);
    assert.equal(request.accept({ id: request.input.id, revision: 1, edits: [{ from: 0, to: 4, insert: "proposal" }] }).applied, true); request.finish();
    edit("corrected"); const proposal = createAgentReview(workspace, source).getSnapshot().proposal!.target;
    const result = await commands.save(createAgentReview(workspace, source).captureSave({ target: workspace.captureResource(source.id), expectedRevision: source.getSnapshot().revision, expectedServerVersion: "v1" }), { save: async submission => { assert.deepEqual(submission.proposal, proposal); return { kind: "saved", serverVersion: "v2" }; } });
    assert.equal(result.kind, "saved"); assert.equal(createAgentReview(workspace, source).getSnapshot().acknowledgements.length, 1);
    const acknowledgement = createAgentReview(workspace, source).getSnapshot().acknowledgements[0]!;
    await createAgentReview(workspace, source).acknowledge(acknowledgement.id, { acknowledge: async () => {} });
    assert.equal(workspace.ownership(source.id).leases, 0); assert.equal(workspace.document(source.documentId).text(), "corrected");
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
