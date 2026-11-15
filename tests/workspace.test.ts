import { test } from "node:test";
import assert from "node:assert/strict";
import { Workspace, applyTextEdits } from "../src/index.ts";

function fixture() {
    const workspace = new Workspace();
    const documentId = workspace.createDocument({ scope: "demo", resource: "sample", variant: "working" }, "Sample", "abc");
    const tabId = workspace.open({ kind: "text", documentId }, "left");
    return { workspace, documentId, tabId };
}

test("delayed actions follow a moved tab and expire after replacement or close", async () => {
    const { workspace, documentId, tabId } = fixture();
    const target = workspace.captureTab(tabId);
    workspace.move(tabId, "right");
    await Promise.resolve();
    assert.equal(workspace.resolveTab(target)?.paneId, "right");
    workspace.replace(tabId, { kind: "panel", resourceId: workspace.resourceForDocument(documentId).id, panelType: "configuration" });
    assert.equal(workspace.resolveTab(target), undefined);
    const replacement = workspace.captureTab(tabId);
    workspace.close(tabId);
    workspace.open({ kind: "text", documentId }, "right");
    assert.equal(workspace.resolveTab(replacement), undefined);
});

test("guards cannot target a different workspace with identical local IDs", () => {
    const first = fixture();
    const second = fixture();
    assert.equal(second.workspace.resolveTab(first.workspace.captureTab(first.tabId)), undefined);
});

test("late agent edits cannot overwrite a newer human revision", () => {
    const { workspace, documentId } = fixture();
    workspace.edit({ documentId, expectedRevision: 0, origin: "human", edits: [{ from: 1, to: 2, insert: "B" }] });
    assert.deepEqual(workspace.edit({ documentId, expectedRevision: 0, origin: "agent", edits: [{ from: 0, to: 3, insert: "old" }] }),
        { applied: false, reason: "stale-revision" });
    assert.equal(workspace.document(documentId).text, "aBc");
});

test("all surfaces share one document while ownership prevents premature release", () => {
    const { workspace, documentId, tabId } = fixture();
    const panel = workspace.open({ kind: "panel", resourceId: workspace.resourceForDocument(documentId).id, panelType: "configuration" }, "right");
    workspace.close(tabId);
    assert.throws(() => workspace.releaseDocument(documentId));
    workspace.close(panel);
    assert.equal(workspace.document(documentId).text, "abc");
    workspace.releaseDocument(documentId);
    assert.throws(() => workspace.document(documentId));
});

test("snapshots are immutable, stable between changes and notify subscribers once", () => {
    const { workspace, documentId } = fixture();
    const before = workspace.getSnapshot();
    assert.equal(workspace.getSnapshot(), before);
    let calls = 0;
    const unsubscribe = workspace.subscribe(() => { calls++; });
    let observed = before;
    const stopDocument = workspace.observeDocument(documentId).subscribe(() => { observed = workspace.getSnapshot(); });
    workspace.edit({ documentId, expectedRevision: 0, origin: "host", edits: [{ from: 0, to: 1, insert: "A" }] });
    assert.equal(calls, 1);
    assert.equal(observed, workspace.getSnapshot()); assert.equal(observed.documents[0]?.text, "Abc");
    assert.equal(before.documents[0]?.text, "abc");
    assert.ok(Object.isFrozen(workspace.getSnapshot().documents));
    unsubscribe(); stopDocument();
    workspace.move(workspace.getSnapshot().tabs[0]!.id, "other");
    assert.equal(calls, 1);
});

test("scoped publication defers inventory traversal until the coarse snapshot is requested", t => {
    const workspace = new Workspace(), forms = Array.from({ length: 1000 }, (_, i) => workspace.createResource(
        { scope: "test", resource: String(i), variant: "form" }, "Form", { value: { field: "before" } }));
    const before = workspace.getSnapshot(); let after = before, notifications = 0;
    const stop = workspace.subscribe(() => { notifications++; });
    // Count synchronous collection visits, not elapsed time on a shared machine.
    const visits = (work: () => void) => {
        const values = Map.prototype.values; let count = 0;
        Map.prototype.values = function () {
            const iterator = values.call(this), next = iterator.next.bind(iterator);
            iterator.next = (...args) => { const item = next(...args); if (!item.done) count++; return item; };
            return iterator;
        };
        try { work(); return count; } finally { Map.prototype.values = values; }
    };
    try {
        let applied = false;
        const publication = visits(() => { applied = workspace.updateResource(forms[0]!, { expectedRevision: 0, value: { field: "after" }, origin: "human" }).applied; });
        const capture = visits(() => { after = workspace.getSnapshot(); }), repeated = visits(() => { workspace.getSnapshot(); });
        t.diagnostic(JSON.stringify({ publication, capture, repeated }));
        assert.equal(applied, true); assert.equal(notifications, 1);
        // Delivery visits one callback. It must not also traverse the resource inventory.
        assert.ok(publication <= 1, `Publication visited ${publication} collection values`);
        assert.ok(capture <= forms.length); assert.equal(repeated, 0); assert.equal(after.resources.length, forms.length);
        assert.equal(after.revision, before.revision + 1); assert.equal(after, workspace.getSnapshot());
        assert.equal(before.resources[0]!.dirty, false); assert.equal(after.resources[0]!.dirty, true);
        assert.equal(after.resources[1], before.resources[1]);
        for (const value of [after, after.resources, after.documents, after.tabs]) assert.ok(Object.isFrozen(value));
        workspace.releaseResource(forms[0]!.id, true);
        assert.equal(notifications, 2); assert.equal(workspace.getSnapshot().resources.length, forms.length - 1);
        assert.equal(after.resources.length, forms.length); assert.equal(after.resources[0]!.state, "ready");
    } finally { stop(); }
});

test("invalid edit batches leave the document untouched", () => {
    const { workspace, documentId } = fixture();
    assert.throws(() => workspace.edit({ documentId, expectedRevision: 0, origin: "host", edits: [
        { from: 0, to: 2, insert: "x" }, { from: 1, to: 3, insert: "y" },
    ] }));
    assert.equal(workspace.document(documentId).revision, 0);
    assert.equal(applyTextEdits("a😀b", [{ from: 1, to: 3, insert: "z" }]), "azb");
});
