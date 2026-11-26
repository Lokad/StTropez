import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { Workspace } from "../src/index.ts";
import { captureViewRequest } from "../src/browser/index.ts";

function fixture(t: TestContext) {
    const workspace = new Workspace(), source = workspace.createTextResource({ scope: "capture", resource: "source", variant: "working" }, "Source", { value: "alpha\nbeta\ngamma" });
    const tab = workspace.tabs.open({ kind: "text", documentId: source.documentId }, "left"), view = workspace.createDocumentView(source.documentId);
    t.after(async () => {
        await Promise.resolve(); view.dispose(); workspace.tabs.close(tab); workspace.releaseResource(source.id, true);
        assert.deepEqual({ leases: workspace.diagnostics().leases, subscriptions: workspace.diagnostics().subscriptions }, { leases: 0, subscriptions: 0 });
    });
    const mount = new AbortController();
    return { workspace, source, tab, view, mount, editor: { workspace, view, tab: workspace.tabs.capture(tab), signal: mount.signal } };
}

test("read captures survive expanded fold metadata and defer abort handlers beyond observer delivery", async t => {
    const f = fixture(t); f.workspace.setCapabilities(f.source.id, { edit: ["host"], save: true });
    const captured = captureViewRequest(f.editor); assert.ok(captured);
    assert.equal(captureViewRequest(f.editor, { editOrigin: "human" }), undefined);
    assert.ok(Object.isFrozen(captured)); assert.equal(captured.document.id, f.source.documentId);
    f.view.folding.setRanges(f.view.folding.getSnapshot(), [{ id: "body", from: 0, to: captured.document.buffer.length, collapsed: false }]);
    assert.notEqual(f.view.folding.getSnapshot().generation, captured.folding.generation); assert.equal(captured.isCurrent(), true);
    f.workspace.setCapabilities(f.source.id, { edit: ["host"], save: false }); assert.equal(captured.isCurrent(), true);
    let aborted = 0;
    captured.signal.addEventListener("abort", () => {
        aborted++;
        assert.ok(f.workspace.edit({ documentId: f.source.documentId, expectedRevision: 0, origin: "host", edits: [{ from: 0, to: 0, insert: "!" }] }).applied);
    }, { once: true });
    f.workspace.setCapabilities(f.source.id, { edit: [], save: false });
    assert.equal(captured.isCurrent(), false); assert.equal(aborted, 0);
    f.workspace.setCapabilities(f.source.id, { edit: ["host"], save: false });
    assert.equal(captured.isCurrent(), false);
    await Promise.resolve(); assert.equal(aborted, 1); assert.equal(captured.signal.aborted, true);
    assert.equal(f.workspace.document(f.source.documentId).buffer.slice(0, 1), "!");
});

test("a capture commits once, retains its source during the operation and cleans up thrown operations", t => {
    const f = fixture(t), before = f.workspace.diagnostics();
    const captured = captureViewRequest(f.editor, { editOrigin: "human" }); assert.ok(captured);
    assert.equal(captured.commit(() => {
        assert.equal(captured.isCurrent(), false); assert.equal(captured.signal.aborted, false);
        assert.equal(f.workspace.diagnostics().subscriptions, before.subscriptions);
        assert.equal(f.workspace.diagnostics().leases, before.leases + 1);
        assert.equal(captured.commit(() => { throw new Error("Reentered operation"); }), false);
        return f.workspace.edit({ documentId: f.source.documentId, expectedRevision: captured.document.revision, origin: "human", edits: [{ from: 0, to: 5, insert: "changed" }] }).applied;
    }), true);
    assert.equal(captured.signal.aborted, true); assert.equal(f.workspace.diagnostics().leases, before.leases);
    assert.equal(captured.commit(() => { throw new Error("Repeated operation"); }), false);
    const failure = captureViewRequest(f.editor); assert.ok(failure);
    assert.throws(() => failure.commit(() => { throw new Error("Host operation failed"); }), /Host operation failed/);
    assert.equal(failure.signal.aborted, true); assert.equal(failure.isCurrent(), false);
    assert.equal(f.workspace.diagnostics().leases, before.leases); assert.equal(f.workspace.diagnostics().subscriptions, before.subscriptions);
});

test("disposing a mount expires its request when the next editor reuses the same view", async t => {
    const f = fixture(t), other = fixture(t);
    const before = f.workspace.diagnostics().leases;
    assert.equal(captureViewRequest({ ...f.editor, view: other.view }), undefined);
    const first = captureViewRequest(f.editor)!;
    f.mount.abort();
    assert.equal(first.signal.aborted, true);
    assert.equal(f.workspace.diagnostics().leases, before);
    const replacement = { ...f.editor, signal: new AbortController().signal };
    let available = true;
    const current = captureViewRequest(replacement, { available: () => available })!;
    assert.equal(first.commit(() => { throw new Error("Expired mount ran"); }), false);
    assert.equal(current.isCurrent(), true);
    available = false;
    assert.equal(current.isCurrent(), false);
    available = true;
    assert.equal(current.isCurrent(), false);
    await Promise.resolve();
    assert.equal(current.signal.aborted, true);
});
