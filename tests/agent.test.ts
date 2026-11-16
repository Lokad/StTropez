import { test } from "node:test";
import assert from "node:assert/strict";
import { Workspace, WorkspaceCommands } from "../src/index.ts";
import type { AcknowledgementSubmission, SaveResponse, SaveSubmission } from "../src/index.ts";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(yes => { resolve = yes; });
    return { promise, resolve };
}
function fixture() {
    const errors: unknown[] = [], workspace = new Workspace({ onListenerError: error => errors.push(error) });
    const source = workspace.createTextResource({ scope: "fixture", resource: "source", variant: "working" }, "Source", { value: "start", serverVersion: "v0" });
    const form = workspace.createResource({ scope: "fixture", resource: "form", variant: "working" }, "Form", { value: { path: "source.csv" } });
    const tab = workspace.open({ kind: "text", documentId: source.documentId }, "left");
    const association = workspace.associateAgent(source.id, "session-one");
    const review = workspace.agentState(source.id), commands = new WorkspaceCommands(workspace, error => errors.push(error));
    const edit = (text: string, origin: "human" | "agent" | "host" = "human") => workspace.edit({ documentId: source.documentId,
        expectedRevision: workspace.document(source.documentId).revision, origin, edits: [{ from: 0, to: workspace.document(source.documentId).text().length, insert: text }] });
    const offer = (text: string, version: number) => workspace.offerAgentProposal(workspace.captureProposal(source.id), { id: "proposal", revision: version,
            edits: [{ from: 0, to: workspace.document(source.documentId).text().length, insert: text }] });
    return { workspace, source, form, tab, association, review, commands, errors, edit, offer };
}

test("an exclusive request captures immutable inputs, enforces every origin, and publishes lock/review state together", () => {
    const { workspace, source, review, edit, errors } = fixture();
    const observations: string[] = [];
    const observe = () => {
        const locked = source.metadata.getSnapshot().editLock !== null;
        observations.push(`${locked}:${review.getSnapshot().request !== null}`);
        assert.equal(locked, review.getSnapshot().request !== null);
    };
    const stops = [source.metadata.subscribe(observe), review.subscribe(observe), workspace.subscribe(observe)];
    const context = { configuration: { revision: 3, path: "before.csv" } };
    const request = workspace.beginAgentRequest(source, context);
    context.configuration.path = "after.csv";
    assert.equal(request.input.context.configuration.path, "before.csv");
    assert.equal(request.input.source.value, "start");
    for (const origin of ["human", "agent", "host"] as const) assert.deepEqual(edit("blocked", origin), { applied: false, reason: "edit-locked" });
    assert.throws(() => workspace.captureSave(source));
    assert.throws(() => workspace.beginLoad(source));
    assert.equal(request.accept({ id: "proposal", revision: 1, edits: [{ from: 0, to: 5, insert: "proposed" }] }).applied, true);
    assert.equal(request.isCancelled(), false); assert.equal(request.isCurrent(), false);
    assert.equal(workspace.document(source.documentId).text(), "proposed");
    assert.equal(review.getSnapshot().proposal?.target.revision, 1);
    assert.deepEqual(observations, ["true:true", "false:false"]); assert.equal(errors.length, 0);
    stops.forEach(stop => stop()); request.finish();
    assert.equal(review.getSnapshot().lastResult, "proposed");
});

test("interrupt/detach preserve human edits and reject old replies after move, close, replace and reopen", () => {
    const { workspace, source, form, tab, review, edit } = fixture();
    const first = workspace.beginAgentRequest(source, {});
    workspace.move(tab, "right"); workspace.interruptAgent(source.id);
    assert.equal(first.isCancelled(), true); assert.equal(source.metadata.getSnapshot().editLock, null);
    edit("human correction"); workspace.replace(tab, { kind: "panel", resourceId: form.id, panelType: "form" });
    workspace.close(tab); assert.throws(() => workspace.releaseResource(source.id, true));
    const reopened = workspace.open({ kind: "text", documentId: source.documentId }, "left");
    const next = workspace.beginAgentRequest(source, {});
    assert.equal(first.accept({ id: "old", revision: 1, edits: [{ from: 0, to: 5, insert: "late" }] }).applied, false);
    assert.equal(review.getSnapshot().request?.id, next.input.id);
    workspace.detachAgent(source.id); workspace.associateAgent(source.id, "session-two"); edit("retained");
    assert.equal(next.accept({ id: "obsolete", revision: 1, edits: [] }).applied, false);
    assert.equal(workspace.document(source.documentId).text(), "retained"); assert.equal(review.getSnapshot().association?.id, "session-two");
    workspace.close(reopened); assert.equal(workspace.ownership(source.id).leases, 0);
});

test("proposal/correction/save/failed acknowledgement/retry/next request uses the exact saved receipt without repeating the save", async () => {
    const { workspace, source, review, commands, edit, errors } = fixture();
    const request = workspace.beginAgentRequest(source, { setting: "first" });
    request.accept({ id: "proposal", revision: 1, edits: [{ from: 0, to: 5, insert: "agent text" }] });
    edit("human corrected text");
    assert.throws(() => workspace.beginAgentRequest(source, {}));
    let writes = 0;
    const save = await commands.save(source, { save: async submission => {
        writes++; assert.equal(submission.value, "human corrected text"); assert.equal(submission.proposal?.revision, 1);
        return { kind: "saved", serverVersion: "v1", canonical: "human corrected text" };
    } });
    assert.ok(save.kind === "saved"); const acknowledgementId = save.receipt.acknowledgementId!;
    assert.equal(source.metadata.getSnapshot().dirty, false);
    workspace.undo({ documentId: source.documentId, expectedRevision: workspace.document(source.documentId).revision });
    assert.equal(workspace.document(source.documentId).text(), "agent text"); assert.equal(source.metadata.getSnapshot().dirty, true);
    workspace.redo({ documentId: source.documentId, expectedRevision: workspace.document(source.documentId).revision });
    assert.equal(workspace.document(source.documentId).text(), "human corrected text"); assert.equal(source.metadata.getSnapshot().dirty, false);
    const payloads: AcknowledgementSubmission[] = [];
    const failed = await commands.acknowledge(source.id, acknowledgementId, { acknowledge: async submission => {
        payloads.push(submission); throw new Error("Synthetic acknowledgement failure");
    } });
    assert.equal(failed.kind, "failed"); assert.equal(review.getSnapshot().acknowledgements[0]?.status, "failed");
    assert.equal(review.getSnapshot().proposal?.target.revision, 1); assert.throws(() => workspace.beginAgentRequest(source, {}));
    edit("human corrected text plus later typing");
    const acknowledged = await commands.acknowledge(source.id, acknowledgementId, { acknowledge: async submission => { payloads.push(submission); } });
    assert.deepEqual(acknowledged, { kind: "acknowledged", retired: true });
    assert.equal(payloads[0], payloads[1]); assert.equal(payloads[1]!.receipt.submission.value, "human corrected text");
    assert.equal(payloads[1]!.receipt.serverVersion, "v1"); assert.equal(writes, 1); assert.equal(errors.length, 1);
    const next = workspace.beginAgentRequest(source, { setting: "next" });
    assert.equal(next.input.source.value, "human corrected text plus later typing"); assert.equal(next.input.source.serverVersion, "v1");
    assert.equal(review.getSnapshot().proposal, null); next.fail(); assert.equal(workspace.ownership(source.id).leases, 0);
});

test("two deferred saves and acknowledgements cannot retire a newer proposal or overwrite later corrections", async () => {
    const { workspace, source, association, review, commands, offer, edit } = fixture();
    offer("proposal one", 1); edit("correction one");
    const responses = [deferred<SaveResponse<string>>(), deferred<SaveResponse<string>>()], calls: SaveSubmission<string>[] = [];
    const port = { save: (submission: SaveSubmission<string>) => { calls.push(submission); return responses[calls.length - 1]!.promise; } };
    const first = commands.save(source, port);
    offer("proposal two", 2); edit("correction two"); const second = commands.save(source, port);
    edit("later human text"); await Promise.resolve();
    responses[0]!.resolve({ kind: "saved", serverVersion: "v1", canonical: "CANONICAL ONE" }); const firstResult = await first;
    assert.ok(firstResult.kind === "saved"); await Promise.resolve();
    assert.equal(calls[1]?.value, "correction two"); assert.equal(calls[1]?.expectedServerVersion, "v1");
    const oldAck = await commands.acknowledge(source.id, firstResult.receipt.acknowledgementId!, { acknowledge: async () => {} });
    assert.deepEqual(oldAck, { kind: "acknowledged", retired: false }); assert.equal(review.getSnapshot().proposal?.target.revision, 2);
    responses[1]!.resolve({ kind: "saved", serverVersion: "v2" }); const secondResult = await second;
    assert.ok(secondResult.kind === "saved");
    assert.equal(secondResult.receipt.submission.proposal?.association, association);
    await commands.acknowledge(source.id, secondResult.receipt.acknowledgementId!, { acknowledge: async () => {} });
    assert.equal(review.getSnapshot().proposal, null); assert.equal(workspace.document(source.documentId).text(), "later human text");
    assert.equal(source.metadata.getSnapshot().dirty, true); assert.equal(workspace.ownership(source.id).leases, 0);
});

test("acknowledgements retain ownership, survive detach and cannot retire a new association's proposal", async () => {
    const { workspace, source, tab, commands, review, offer } = fixture();
    offer("old", 1);
    const saved = await commands.save(source, { save: async () => ({ kind: "saved", serverVersion: "v1" }) });
    assert.ok(saved.kind === "saved");
    workspace.detachAgent(source.id); workspace.associateAgent(source.id, "new-session");
    workspace.offerAgentProposal(workspace.captureProposal(source.id),
        { id: "proposal", revision: 1, edits: [{ from: 0, to: 3, insert: "new" }] });
    workspace.close(tab); assert.throws(() => workspace.releaseResource(source.id, true));
    const result = await commands.acknowledge(source.id, saved.receipt.acknowledgementId!, { acknowledge: async submission => {
        assert.equal(submission.proposal.association.id, "session-one");
    } });
    assert.deepEqual(result, { kind: "acknowledged", retired: false }); assert.equal(review.getSnapshot().proposal?.target.association.id, "new-session");
    workspace.detachAgent(source.id); workspace.releaseResource(source.id, true);
    assert.equal(review.getSnapshot().association, null);
});

test("proposal revision checks, malformed ranges and permission changes preserve state and unlock failed requests", () => {
    const { workspace, source, review, offer, errors } = fixture();
    offer("new", 2); const before = source.getSnapshot(), proposal = review.getSnapshot();
    assert.deepEqual(offer("older", 1), { applied: false, reason: "stale-proposal" });
    assert.throws(() => workspace.offerAgentProposal(workspace.captureProposal(source.id), { id: "proposal", revision: 3, edits: [{ from: 99, to: 100, insert: "x" }] }));
    assert.equal(source.getSnapshot(), before); assert.equal(review.getSnapshot(), proposal);
    workspace.detachAgent(source.id); workspace.associateAgent(source.id, "session-next");
    const request = workspace.beginAgentRequest(source, {});
    workspace.setCapabilities(source.id, { edit: [], save: false, run: false });
    assert.deepEqual(request.accept({ id: "revoked", revision: 1, edits: [] }), { applied: false, reason: "read-only" });
    assert.equal(source.metadata.getSnapshot().editLock, null); assert.equal(review.getSnapshot().request, null);
    workspace.setCapabilities(source.id, { edit: ["agent", "human", "host"], save: true, run: true });
    const malformed = workspace.beginAgentRequest(source, {});
    assert.throws(() => malformed.accept({ id: "bad", revision: 1, edits: [{ from: -1, to: 1, insert: "bad" }] }));
    assert.equal(review.getSnapshot().lastResult, "failed"); assert.equal(source.metadata.getSnapshot().editLock, null);
    assert.equal(workspace.document(source.documentId).text(), "new"); assert.equal(workspace.ownership(source.id).leases, 0); assert.equal(errors.length, 0);
});

test("edit-lease identity, origin and revision are all required and releasing a lease never restores revoked permissions", () => {
    const { workspace, source } = fixture();
    const lease = workspace.acquireEditLease(source.id, "tool", "agent");
    const request = { documentId: source.documentId, expectedRevision: 0, origin: "agent" as const, edits: [{ from: 0, to: 5, insert: "leased" }], lease };
    assert.equal(workspace.edit(request).applied, true);
    assert.deepEqual(workspace.edit(request), { applied: false, reason: "stale-revision" });
    assert.deepEqual(workspace.edit({ ...request, expectedRevision: 1, origin: "host" }), { applied: false, reason: "edit-locked" });
    const clone = Object.freeze({ ...lease });
    assert.deepEqual(workspace.edit({ ...request, expectedRevision: 1, lease: clone }), { applied: false, reason: "edit-locked" });
    workspace.setCapabilities(source.id, { edit: [], save: false, run: false });
    lease.release(); lease.release();
    assert.equal(lease.active(), false); assert.equal(source.metadata.getSnapshot().capabilities.edit.length, 0);
    assert.equal(workspace.ownership(source.id).leases, 0);
});

test("a delayed review guard cannot resurrect a retired proposal when the text revision is unchanged", async () => {
    const { workspace, source, commands, review } = fixture();
    const old = workspace.captureProposal(source.id);
    workspace.offerAgentProposal(old, { id: "no-text-change", revision: 1, edits: [] });
    const delayed = workspace.captureProposal(source.id), revision = workspace.document(source.documentId).revision;
    const saved = await commands.save(source, { save: async () => ({ kind: "saved", serverVersion: "v1" }) });
    assert.ok(saved.kind === "saved");
    await commands.acknowledge(source.id, saved.receipt.acknowledgementId!, { acknowledge: async () => {} });
    assert.equal(workspace.document(source.documentId).revision, revision);
    assert.equal(review.getSnapshot().proposal, null);
    assert.deepEqual(workspace.offerAgentProposal(delayed, { id: "no-text-change", revision: 2, edits: [] }), { applied: false, reason: "stale-proposal" });
    assert.deepEqual(workspace.offerAgentProposal(old, { id: "no-text-change", revision: 1, edits: [] }), { applied: false, reason: "stale-proposal" });
    assert.equal(review.getSnapshot().proposal, null);
});
