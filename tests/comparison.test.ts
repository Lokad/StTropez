import assert from "node:assert/strict";
import test from "node:test";
import { createComparisonController, TextBuffer, Workspace } from "../src/index.ts";
import type { ComparisonController } from "../src/index.ts";
function fixture() {
    const workspace = new Workspace(), resource = workspace.createTextResource({ scope: "test", resource: "working", variant: "source" }, "Working", { value: "first\nworking\nlast\n", serverVersion: "saved-1" });
    const tab = workspace.open({ kind: "text", documentId: resource.documentId }, "main");
    const reference = Object.freeze({ buffer: TextBuffer.from("first\nbaseline\nlast\n"), version: "reference-1" });
    const comparison = createComparisonController(workspace, tab, reference);
    const edit = (insert: string) => workspace.edit({ documentId: resource.documentId, expectedRevision: workspace.document(resource.documentId).revision,
        origin: "human", edits: [{ from: workspace.document(resource.documentId).buffer.length, to: workspace.document(resource.documentId).buffer.length, insert }] });
    return { workspace, resource, tab, reference, comparison, edit };
}
function ready(controller: ComparisonController) { let state = controller.getSnapshot(); for (let i = 0; state.status === "running" && i < 10000; i++) state = controller.advance(512); assert.equal(state.status, "ready"); return state; }

test("captured whole-review reversion preserves sparse 100k raw text and complete shared history", () => {
    const workspace = new Workspace(), text = "first\r\n" + "unchanged value\r\n".repeat(100000) + "last 😀\r", reference = TextBuffer.from(text);
    const resource = workspace.createTextResourceFromBuffer({ scope: "review", resource: "source", variant: "working" }, "Working", { buffer: reference, serverVersion: "saved-1" });
    const tab = workspace.open({ kind: "text", documentId: resource.documentId }, "main"), comparison = createComparisonController(workspace, tab, { buffer: reference, version: "review-1" }), peer = workspace.createDocumentView(resource.documentId);
    workspace.edit({ documentId: resource.documentId, expectedRevision: 0, origin: "human", edits: [{ from: 0, to: 5, insert: "different" }, { from: text.length - 8, to: text.length, insert: "tail" }] });
    ready(comparison); const buffer = workspace.document(resource.documentId).buffer;
    comparison.view.setSelections(1, [{ anchor: 8, head: 0 }, { anchor: 700000, head: 700003 }, { anchor: buffer.length, head: buffer.length }], 2);
    peer.setSelection(1, { anchor: 123456, head: 123460 }); const before = comparison.view.getSnapshot().selectionSet, peerBefore = peer.getSnapshot().selectionSet, history = workspace.observeHistory(resource.documentId).getSnapshot();
    const ticket = comparison.beginReversion(); workspace.move(tab, "other"); assert.equal(ticket.isCurrent(), true); assert.equal(ticket.complete(), true);
    assert.equal(workspace.document(resource.documentId).buffer.equals(reference), true); assert.equal(workspace.observeHistory(resource.documentId).getSnapshot().undoDepth, history.undoDepth + 1);
    assert.equal(workspace.document(resource.documentId).buffer.readMetrics().textExports, 0); assert.equal(buffer.readMetrics().textExports, 0);
    assert.equal(resource.metadata.getSnapshot().serverVersion, "saved-1"); assert.equal(resource.metadata.getSnapshot().dirty, false);
    assert.equal(workspace.undo({ documentId: resource.documentId, expectedRevision: 2 }).applied, true);
    assert.equal(workspace.document(resource.documentId).buffer, buffer); assert.deepEqual(comparison.view.getSnapshot().selectionSet, before); assert.deepEqual(peer.getSnapshot().selectionSet, peerBefore);
    assert.equal(workspace.redo({ documentId: resource.documentId, expectedRevision: 3 }).applied, true); assert.equal(workspace.document(resource.documentId).buffer.equals(reference), true);
    assert.equal(ticket.complete(), false); peer.dispose(); comparison.dispose(); assert.equal(workspace.diagnostics().leases, 0);
});

test("delayed whole-review reversion rejects newer typing, selection, reference intent and saved version", () => {
    for (const change of ["typing", "selection", "refresh-intent", "accept-intent", "reference", "save", "new-reversion", "replace", "close", "view", "dispose"] as const) {
        const f = fixture(); ready(f.comparison); const ticket = f.comparison.beginReversion();
        if (change === "typing") f.edit("later");
        if (change === "selection") f.comparison.view.setSelection(0, { anchor: 1, head: 2 });
        if (change === "refresh-intent") f.comparison.beginRefresh().cancel();
        if (change === "accept-intent") f.comparison.beginAcceptance().cancel();
        if (change === "reference") f.comparison.beginRefresh().complete({ buffer: TextBuffer.from("other"), version: "other" });
        if (change === "save") { const save = f.workspace.captureSave(f.resource); save.start(); save.accept({ serverVersion: "saved-2" }); save.finish(); }
        if (change === "new-reversion") f.comparison.beginReversion().cancel();
        if (change === "replace") f.workspace.replace(f.tab, { kind: "text", documentId: f.resource.documentId });
        if (change === "close") f.workspace.close(f.tab);
        if (change === "view") f.comparison.view.dispose();
        if (change === "dispose") f.comparison.dispose();
        const before = f.workspace.document(f.resource.documentId), history = f.workspace.observeHistory(f.resource.documentId).getSnapshot();
        assert.equal(ticket.complete(), false, change); assert.equal(f.workspace.document(f.resource.documentId), before, change); assert.deepEqual(f.workspace.observeHistory(f.resource.documentId).getSnapshot(), history, change);
        f.comparison.dispose(); assert.equal(f.workspace.diagnostics().leases, 0, change);
    }
});

test("permission, lease and takeover cycles cannot revive an old discard confirmation", () => {
    for (const change of ["permissions", "lease", "takeover"] as const) {
        const f = fixture(); ready(f.comparison); const ticket = f.comparison.beginReversion();
        if (change === "permissions") { f.workspace.setCapabilities(f.resource.id, { edit: ["host"], save: true, run: true }); f.workspace.setCapabilities(f.resource.id, { edit: ["human", "host", "agent"], save: true, run: true }); }
        if (change === "lease") { const lease = f.workspace.acquireEditLease(f.resource.id, "other", "host"); lease.release(); }
        if (change === "takeover") { f.workspace.associateAgent(f.resource.id, "one"); f.workspace.detachAgent(f.resource.id); f.workspace.associateAgent(f.resource.id, "two"); }
        const before = f.workspace.document(f.resource.documentId); assert.equal(ticket.complete(), false, change); assert.equal(f.workspace.document(f.resource.documentId), before);
        f.comparison.dispose(); f.workspace.detachAgent(f.resource.id); assert.equal(f.workspace.diagnostics().leases, 0);
    }
});

test("cancelled and empty whole-review reversions are inert and release explicit ownership", () => {
    const f = fixture(); assert.throws(() => f.comparison.beginReversion(), /unavailable/); ready(f.comparison);
    const cancelled = f.comparison.beginReversion(); cancelled.cancel(); cancelled.finish(); assert.equal(cancelled.complete(), false);
    const acceptance = f.comparison.beginAcceptance(); acceptance.complete({ buffer: acceptance.capture.working.buffer, version: "same" }); ready(f.comparison);
    const before = f.workspace.document(f.resource.documentId), history = f.workspace.observeHistory(f.resource.documentId).getSnapshot();
    assert.equal(f.comparison.beginReversion().complete(), true); assert.equal(f.workspace.document(f.resource.documentId), before); assert.deepEqual(f.workspace.observeHistory(f.resource.documentId).getSnapshot(), history);
    const pending = f.comparison.beginReversion(); f.comparison.dispose(); assert.equal(pending.complete(), false); assert.equal(f.workspace.diagnostics().leases, 0); assert.equal(f.workspace.diagnostics().subscriptions, 0);
});

test("acknowledgement progress does not expire discard ownership but proposal retirement does", () => {
    const f = fixture(); f.workspace.associateAgent(f.resource.id, "agent");
    const request = f.workspace.beginAgentRequest(f.resource, {}), length = f.workspace.document(f.resource.documentId).buffer.length;
    assert.equal(request.accept({ id: "proposal", revision: 1, edits: [{ from: length, to: length, insert: "proposal" }] }).applied, true); request.finish();
    const save = f.workspace.captureSave(f.resource); save.start(); const receipt = save.accept({ serverVersion: "saved-2" }); save.finish(); ready(f.comparison);
    const ticket = f.comparison.beginReversion(), ack = f.workspace.beginAcknowledgement(f.resource.id, receipt.acknowledgementId!);
    ack.fail(); ack.finish(); assert.equal(ticket.isCurrent(), true); assert.equal(ticket.complete(), true); ready(f.comparison);
    const retired = f.comparison.beginReversion(), retry = f.workspace.beginAcknowledgement(f.resource.id, receipt.acknowledgementId!); assert.equal(retry.accept().accepted, true); retry.finish();
    assert.equal(retired.complete(), false); assert.equal(f.resource.metadata.getSnapshot().serverVersion, "saved-2"); f.comparison.dispose(); f.workspace.detachAgent(f.resource.id); assert.equal(f.workspace.diagnostics().leases, 0);
});

test("comparison hunk reversion is revision-guarded, undoable and shared across views", () => {
    const { workspace, resource, reference, comparison, edit } = fixture(), sibling = workspace.createDocumentView(resource.documentId);
    const state = ready(comparison); assert.equal(state.hunks.length, 1);
    comparison.view.setSelection(0, { anchor: 2, head: 4 });
    assert.equal(comparison.revert(state.generation, 0), true);
    assert.equal(workspace.document(resource.documentId).buffer.equals(reference.buffer), true);
    assert.equal(sibling.getSnapshot().revision, 1);
    assert.equal(comparison.revert(state.generation, 0), false);
    assert.equal(workspace.undo({ documentId: resource.documentId, expectedRevision: 1 }).applied, true);
    assert.deepEqual(comparison.view.getSnapshot().selection, { anchor: 2, head: 4, anchorAffinity: "after", headAffinity: "before" });
    const stale = ready(comparison); edit("later"); assert.equal(comparison.revert(stale.generation, 0), false);
    assert.equal(reference.buffer.slice(0, reference.buffer.length), "first\nbaseline\nlast\n");
    sibling.dispose(); comparison.dispose(); assert.equal(workspace.diagnostics().leases, 0);
});

test("refresh and acceptance preserve later typing, saved identity, history and explicit versions", () => {
    const { workspace, resource, comparison, edit } = fixture(); edit("before capture\n");
    const ticket = comparison.beginAcceptance(), captured = ticket.capture.working.buffer, history = workspace.observeHistory(resource.documentId).getSnapshot();
    edit("after capture\n"); const working = workspace.document(resource.documentId), view = comparison.view;
    assert.equal(ticket.complete({ buffer: captured, version: "reviewed-2" }), true);
    assert.equal(comparison.getSnapshot().baseline!.buffer, captured); assert.equal(comparison.getSnapshot().baseline!.version, "reviewed-2");
    assert.equal(workspace.document(resource.documentId), working); assert.equal(comparison.view, view);
    assert.equal(resource.metadata.getSnapshot().serverVersion, "saved-1"); assert.equal(resource.metadata.getSnapshot().dirty, true);
    assert.equal(workspace.observeHistory(resource.documentId).getSnapshot().undoDepth, history.undoDepth + 1);
    const refresh = comparison.beginRefresh(); edit("during refresh\n"); const later = workspace.document(resource.documentId);
    assert.equal(refresh.complete({ buffer: TextBuffer.from("new reference\r\n"), version: "reference-3" }), true);
    assert.equal(workspace.document(resource.documentId), later); assert.equal(ready(comparison).hunks.length > 0, true);
    assert.equal(ticket.complete({ buffer: captured, version: "duplicate" }), false);
    comparison.dispose(); assert.equal(workspace.diagnostics().leases, 0);
});

test("same-lane and cross-lane races reject stale tickets, permission changes reject acceptance", () => {
    const { workspace, resource, comparison } = fixture();
    const old = comparison.beginRefresh(), fresh = comparison.beginRefresh(), acceptance = comparison.beginAcceptance();
    assert.equal(old.isCurrent(), false); assert.equal(old.complete({ buffer: TextBuffer.from("old"), version: "old" }), false);
    assert.equal(fresh.complete({ buffer: TextBuffer.from("fresh"), version: "fresh" }), true);
    assert.equal(acceptance.complete({ buffer: acceptance.capture.working.buffer, version: "stale" }), false);
    const denied = comparison.beginAcceptance(); workspace.setCapabilities(resource.id, { edit: [], save: true, run: false });
    assert.equal(denied.complete({ buffer: denied.capture.working.buffer, version: "denied" }), false);
    assert.throws(() => comparison.beginAcceptance(), /unavailable/);
    const allowedRefresh = comparison.beginRefresh(); allowedRefresh.cancel(); allowedRefresh.finish(); assert.equal(allowedRefresh.isCurrent(), false);
    comparison.dispose(); assert.equal(workspace.diagnostics().leases, 0);
});

test("captured presentation survives moves, expires on replacement, and disposal releases tickets", () => {
    const { workspace, resource, tab, comparison } = fixture(), ticket = comparison.beginAcceptance();
    workspace.move(tab, "other"); assert.equal(ticket.isCurrent(), true);
    const other = workspace.createDocument({ scope: "test", resource: "other", variant: "source" }, "Other", "other");
    workspace.replace(tab, { kind: "text", documentId: other });
    assert.equal(comparison.getSnapshot().status, "expired"); assert.equal(comparison.getSnapshot().baseline, null);
    assert.equal(ticket.complete({ buffer: ticket.capture.working.buffer, version: "late" }), false);
    comparison.dispose(); comparison.dispose(); assert.equal(workspace.diagnostics().leases, 0);
    workspace.releaseResource(resource.id); assert.equal(workspace.document(other).buffer.slice(0, 5), "other");
});

test("supplied views remain owned by the host, buffer resources retain exact data without exporting", () => {
    const { workspace, resource, tab, reference, comparison } = fixture(); comparison.dispose();
    const view = workspace.createDocumentView(resource.documentId), controller = createComparisonController(workspace, tab, reference, { view });
    controller.dispose(); assert.equal(workspace.ownsDocumentView(view), true); view.dispose();
    const buffer = TextBuffer.from("a\r\nb\n").replace(1, 1, "\t"), display = workspace.createTextResourceFromBuffer({ scope: "test", resource: "reference", variant: "display" }, "Reference", { buffer, serverVersion: "v1" }, { edit: [], save: false, run: false });
    assert.equal(workspace.document(display.documentId).buffer, buffer); assert.equal(buffer.readMetrics().textExports, 0);
    for (const origin of ["human", "agent", "host"] as const) assert.equal(workspace.edit({ documentId: display.documentId, expectedRevision: 0, origin, edits: [{ from: 0, to: 0, insert: "bad" }] }).applied, false);
    workspace.releaseResource(display.id); assert.equal(workspace.diagnostics().leases, 0);
});

test("disposal cancels unfinished tickets and repeated long-line work without retaining workspace ownership", () => {
    const { workspace, resource, comparison } = fixture();
    workspace.edit({ documentId: resource.documentId, expectedRevision: 0, origin: "human", edits: [{ from: 0, to: 0, insert: "x".repeat(100000) }] });
    assert.equal(comparison.advance(512).status, "running");
    const refresh = comparison.beginRefresh(), acceptance = comparison.beginAcceptance();
    comparison.dispose(); assert.equal(workspace.diagnostics().leases, 0); assert.equal(workspace.diagnostics().subscriptions, 0);
    assert.equal(refresh.complete({ buffer: TextBuffer.from("late"), version: "late" }), false);
    assert.equal(acceptance.complete({ buffer: acceptance.capture.working.buffer, version: "late" }), false);
    assert.equal(comparison.advance().status, "disposed"); assert.equal(comparison.getSnapshot().working, null);
});

test("saving a captured revision changes the saved version independently of reference acceptance", () => {
    const { workspace, resource, comparison, edit } = fixture(); edit("captured\n");
    const acceptance = comparison.beginAcceptance(), save = workspace.captureSave(resource); save.start(); edit("later\n");
    save.accept({ serverVersion: "saved-2" }); save.finish();
    assert.equal(comparison.getSnapshot().baseline!.version, "reference-1");
    assert.equal(acceptance.capture.serverVersion, "saved-1");
    assert.equal(acceptance.complete({ buffer: acceptance.capture.working.buffer, version: "reference-2" }), true);
    assert.equal(resource.metadata.getSnapshot().serverVersion, "saved-2"); assert.equal(resource.metadata.getSnapshot().dirty, true);
    const revision = workspace.document(resource.documentId).revision;
    assert.equal(workspace.undo({ documentId: resource.documentId, expectedRevision: revision }).applied, true);
    assert.equal(resource.metadata.getSnapshot().dirty, false);
    assert.equal(comparison.getSnapshot().baseline!.version, "reference-2"); comparison.dispose();
});

test("notification commands reject reentrancy and a disposed supplied view expires cooperative work", () => {
    const { workspace, resource, tab, reference, comparison } = fixture();
    let refusal: unknown;
    const unsubscribe = comparison.subscribe(() => { try { comparison.beginRefresh(); } catch (error) { refusal = error; } });
    ready(comparison); assert.match(String(refusal), /Reentrant/); unsubscribe(); comparison.dispose();
    const view = workspace.createDocumentView(resource.documentId), controller = createComparisonController(workspace, tab, reference, { view });
    view.dispose(); assert.equal(controller.advance().status, "expired"); assert.equal(controller.getSnapshot().baseline, null);
    controller.dispose(); assert.equal(workspace.diagnostics().leases, 0);
});
