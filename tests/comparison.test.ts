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
