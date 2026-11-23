import { test } from "node:test";
import assert from "node:assert/strict";
import { Workspace, applyTextEdits } from "../src/index.ts";
import type { DocumentChange } from "../src/index.ts";

function fixture() {
    const workspace = new Workspace();
    const documentId = workspace.createDocument({ scope: "demo", resource: "sample", variant: "working" }, "Sample", "abc");
    const tabId = workspace.tabs.open({ kind: "text", documentId }, "left");
    return { workspace, documentId, tabId };
}

test("language changes publish a new document identity without replaying an edit", () => {
    const { workspace, documentId } = fixture(), changes: DocumentChange[] = [];
    const resource = workspace.resourceForDocument(documentId), view = workspace.createDocumentView(documentId);
    const stop = workspace.onDocumentChange(documentId, change => changes.push(change));
    assert.ok(workspace.edit({ documentId, expectedRevision: 0, edits: [{ from: 0, to: 0, insert: "!" }], origin: "human" }).applied);
    const before = workspace.document(documentId), history = workspace.observeHistory(documentId).getSnapshot(), selection = view.getSnapshot();
    const metadata = resource.metadata.getSnapshot();
    const pair = { uri: "project:source%2Fone", languageId: "generic" };
    workspace.setDocumentLanguage(documentId, pair);
    const linked = workspace.document(documentId);
    assert.equal(before.language, null);
    assert.equal(resource.metadata.getSnapshot(), metadata);
    assert.deepEqual(linked.language, pair); assert.ok(Object.isFrozen(linked.language));
    workspace.setDocumentLanguage(documentId, { ...pair }); pair.uri = "project:two";
    assert.equal(workspace.document(documentId), linked);
    assert.equal(linked.language!.uri, "project:source%2Fone");
    workspace.setDocumentLanguage(documentId, null);
    const excluded = workspace.document(documentId);
    assert.equal(excluded.language, null); assert.equal(excluded.change, before.change);
    assert.equal(excluded.buffer, before.buffer); assert.equal(excluded.revision, before.revision);
    assert.equal(view.getSnapshot(), selection); assert.equal(workspace.observeHistory(documentId).getSnapshot(), history);
    assert.deepEqual(changes, [before.change]);
    const late: DocumentChange[] = [], detach = workspace.onDocumentChange(documentId, change => late.push(change));
    workspace.createNotificationScope().batch(() => {
        workspace.setDocumentLanguage(documentId, pair);
        workspace.edit({ documentId, expectedRevision: before.revision, edits: [{ from: 0, to: 0, insert: "?" }], origin: "human" });
        workspace.setDocumentLanguage(documentId, null);
    });
    assert.deepEqual(late, [workspace.document(documentId).change]); assert.deepEqual(changes, [before.change, ...late]);
    detach(); stop(); view.dispose();
});

test("edits, grouped history and batches publish immutable changes in previous coordinates", () => {
    const { workspace, documentId } = fixture(), changes: DocumentChange[] = [];
    const stop = workspace.onDocumentChange(documentId, change => changes.push(change));
    const base = workspace.document(documentId), edits = [{ from: 0, to: 1, insert: "AA" }, { from: 3, to: 3, insert: "!" }];
    const write = (revision: number, batch: typeof edits) => workspace.edit({ documentId, expectedRevision: revision,
        origin: "host", source: "peer", edits: batch, history: { kind: "replace", group: "batch" } });
    workspace.createNotificationScope().batch(() => {
        write(0, edits); edits[0]!.insert = "XXX"; write(1, [{ from: 1, to: 3, insert: "b" }]);
        assert.equal(changes.length, 0);
    });
    workspace.undo({ documentId, expectedRevision: 2, source: "undo-button" });
    workspace.redo({ documentId, expectedRevision: 3 });
    assert.deepEqual(changes.map(c => [c.previousRevision, c.revision, c.source, c.kind]),
        [[0, 1, "peer", "replace"], [1, 2, "peer", "replace"], [2, 3, "undo-button", "undo"], [3, 4, undefined, "redo"]]);
    assert.deepEqual(changes[0]!.edits, [{ from: 0, to: 1, insert: "AA" }, { from: 3, to: 3, insert: "!" }]);
    let text = base.text();
    assert.deepEqual(changes.map(c => {
        assert.equal(c.edits, c.edits); assert.ok(Object.isFrozen(c.edits) && c.edits.every(Object.isFrozen));
        return text = applyTextEdits(text, c.edits);
    }), ["AAbc!", "Abc!", "abc", "Abc!"]);
    assert.equal(changes[3], workspace.document(documentId).change);
    stop();
});

test("a branching follow-up loop stops without discarding independent notifications or later edits", async () => {
    const errors: unknown[] = [];
    const workspace = new Workspace({ onListenerError: error => { errors.push(error); throw new Error("reporter failed"); } });
    const id = workspace.createDocument({ scope: "demo", resource: "loop", variant: "working" }, "Loop", "");
    const append = (source: string) => workspace.edit({ documentId: id, expectedRevision: workspace.document(id).revision,
        edits: [{ from: 0, to: 0, insert: "x" }], origin: "host", source });
    let writes = 0, independent = 0;
    workspace.onDocumentChange(id, (change, after) => {
        const echo = () => { if (++writes <= 512) append("echo"); };
        if (change.source === "start") {
            after(echo);
            for (let i = 0; i < 300; i++) after(() => { independent++; });
        } else if (change.source === "echo") {
            after(echo); after(echo);
        } else after(() => { independent++; });
    });
    append("start"); await Promise.resolve();
    assert.equal(writes, 256); assert.equal(independent, 300);
    assert.equal(errors.length, 1); assert.ok(errors[0] instanceof RangeError);
    append("later"); await Promise.resolve();
    assert.equal(independent, 301); assert.equal(errors.length, 1);
});

test("follow-up writes run after listeners in order and expire with their subscription", async () => {
    const { workspace, documentId } = fixture(), order: string[] = [];
    const append = (source: string, revision: number) => workspace.edit({ documentId, expectedRevision: revision, origin: "host",
        source, edits: [{ from: 0, to: 0, insert: source }] });
    const first = workspace.onDocumentChange(documentId, (change, after) => {
        order.push("first " + change.source);
        if (change.source === "start") after(() => { append("next", change.revision); });
    });
    const cancelled = workspace.onDocumentChange(documentId, (_change, after) => after(() => { order.push("cancelled"); }));
    const last = workspace.onDocumentChange(documentId, (change, after) => {
        order.push("last " + change.source); cancelled();
        if (change.source === "start") after(() => { order.push("last follow-up"); });
    });
    assert.deepEqual(append("start", 0), { applied: true, revision: 1 });
    assert.deepEqual(order, ["first start", "last start"]);
    await Promise.resolve();
    assert.deepEqual(order, ["first start", "last start", "first next", "last next", "last follow-up"]);
    assert.equal(workspace.document(documentId).revision, 2);
    first(); last(); assert.equal(workspace.diagnostics().subscriptions, 0);
});

test("delayed actions follow a moved tab and expire after replacement or close", async () => {
    const { workspace, documentId, tabId } = fixture();
    const view = workspace.createDocumentView(documentId);
    const target = workspace.tabs.capture(tabId);
    const before = workspace.tabs.getSnapshot();
    let observed = workspace.tabs.resolve(target);
    const stop = workspace.tabs.subscribe(() => { observed = workspace.tabs.resolve(target); });
    workspace.tabs.move(tabId, "right");
    await Promise.resolve();
    assert.equal(workspace.tabs.resolve(target)?.paneId, "right");
    assert.equal(workspace.ownsDocumentView(view, target), true);
    assert.equal(observed, workspace.tabs.resolve(target)); assert.equal(before[0]!.paneId, "left");
    const moved = workspace.tabs.getSnapshot();
    assert.throws(() => workspace.tabs.replace(tabId, { kind: "text", documentId: "missing" as typeof documentId }));
    assert.equal(workspace.tabs.getSnapshot(), moved); assert.equal(workspace.tabs.resolve(target), moved[0]);
    workspace.tabs.replace(tabId, { kind: "panel", resourceId: workspace.resourceForDocument(documentId).id, panelType: "configuration" });
    assert.equal(workspace.tabs.resolve(target), undefined); assert.equal(observed, undefined);
    const replacement = workspace.tabs.capture(tabId);
    assert.equal(workspace.ownsDocumentView(view), true);
    assert.equal(workspace.ownsDocumentView(view, target), false);
    assert.equal(workspace.ownsDocumentView(view, replacement), false);
    workspace.tabs.close(tabId);
    const reopened = workspace.tabs.capture(workspace.tabs.open({ kind: "text", documentId }, "right"));
    assert.equal(workspace.tabs.resolve(replacement), undefined);
    assert.equal(workspace.ownsDocumentView(view, reopened), true);
    view.dispose();
    assert.equal(workspace.ownsDocumentView(view, reopened), false);
    assert.throws(() => workspace.tabs.capture(tabId), /Unknown tab/); stop();
});

test("tab replacement follows resource visibility without reviving captured generations", () => {
    const { workspace, documentId, tabId } = fixture(), before = workspace.tabs.getSnapshot(), original = workspace.tabs.capture(tabId);
    const internal = workspace.createResource({ scope: "test", resource: "preview", variant: "internal" }, "Preview", { value: 0 }, undefined, { visibility: "internal" });
    let observed = workspace.tabs.getSnapshot();
    const stop = workspace.tabs.subscribe(() => { observed = workspace.tabs.getSnapshot(); });
    workspace.tabs.replace(tabId, { kind: "panel", resourceId: internal.id, panelType: "preview" });
    assert.equal(workspace.tabs.resolve(original), undefined); assert.deepEqual(observed, []);
    const privateTarget = workspace.tabs.capture(tabId), privateSnapshot = workspace.tabs.resolve(privateTarget)!;
    assert.equal(privateSnapshot.visibility, "internal"); assert.equal(privateSnapshot.generation, original.generation + 1);
    workspace.tabs.move(tabId, "right"); assert.equal(workspace.tabs.resolve(privateTarget)?.paneId, "right"); assert.deepEqual(observed, []);
    workspace.tabs.replace(tabId, { kind: "text", documentId });
    const visible = workspace.tabs.getSnapshot();
    assert.equal(workspace.tabs.resolve(privateTarget), undefined); assert.equal(observed, visible); assert.equal(visible.length, 1);
    assert.equal(visible[0]!.visibility, "workspace"); assert.equal(visible[0]!.generation, original.generation + 2);
    assert.equal(before[0]!.visibility, "workspace"); assert.equal(privateSnapshot.visibility, "internal");
    stop(); workspace.tabs.close(tabId); workspace.releaseResource(internal.id); workspace.releaseDocument(documentId);
});

test("repeated tab captures and resolution do not scan the tab inventory", t => {
    const workspace = new Workspace(), documentId = workspace.createDocument({ scope: "tabs", resource: "shared", variant: "working" }, "Document", "x");
    const tabs = Array.from({ length: 1000 }, () => workspace.tabs.open({ kind: "text", documentId }, "main"));
    const id = tabs.at(-1)!, target = workspace.tabs.capture(id), snapshot = workspace.tabs.getSnapshot().at(-1);
    const find = Array.prototype.find; let visits = 0, valid = true;
    Array.prototype.find = function<T>(this: T[], predicate: (value: T, index: number, values: T[]) => unknown, thisArg?: unknown) {
        return find.call(this, (value, index, values) => { visits++; return predicate.call(thisArg, value, index, values); });
    };
    try {
        for (let i = 0; i < 100; i++) valid &&= workspace.tabs.capture(id).generation === target.generation && workspace.tabs.resolve(target) === snapshot;
    } finally { Array.prototype.find = find; }
    t.diagnostic(JSON.stringify({ captures: 100, resolutions: 100, predicateVisits: visits }));
    assert.equal(valid, true); assert.equal(visits, 0);
});

test("guards cannot target a different workspace with identical local IDs", () => {
    const first = fixture();
    const second = fixture();
    const local = first.workspace.createDocumentView(first.documentId), foreign = second.workspace.createDocumentView(second.documentId);
    const target = first.workspace.tabs.capture(first.tabId);
    assert.equal(local.id, foreign.id);
    assert.equal(first.workspace.ownsDocumentView(local, target), true);
    assert.equal(second.workspace.tabs.resolve(target), undefined);
    assert.equal(first.workspace.ownsDocumentView(foreign, target), false);
    assert.equal(second.workspace.ownsDocumentView(foreign, target), false);
    local.dispose(); foreign.dispose();
});

test("late agent edits cannot overwrite a newer human revision", () => {
    const { workspace, documentId } = fixture();
    workspace.edit({ documentId, expectedRevision: 0, origin: "human", edits: [{ from: 1, to: 2, insert: "B" }] });
    assert.deepEqual(workspace.edit({ documentId, expectedRevision: 0, origin: "agent", edits: [{ from: 0, to: 3, insert: "old" }] }),
        { applied: false, reason: "stale-revision" });
    assert.equal(workspace.document(documentId).text(), "aBc");
});

test("all surfaces share one document while ownership prevents premature release", () => {
    const { workspace, documentId, tabId } = fixture();
    const panel = workspace.tabs.open({ kind: "panel", resourceId: workspace.resourceForDocument(documentId).id, panelType: "configuration" }, "right");
    workspace.tabs.close(tabId);
    assert.throws(() => workspace.releaseDocument(documentId));
    workspace.tabs.close(panel);
    assert.equal(workspace.document(documentId).text(), "abc");
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
    assert.equal(observed, workspace.getSnapshot()); assert.equal(observed.documents[0]?.text(), "Abc");
    assert.equal(before.documents[0]?.text(), "abc");
    assert.ok(Object.isFrozen(workspace.getSnapshot().documents));
    unsubscribe(); stopDocument();
    workspace.tabs.move(workspace.tabs.getSnapshot()[0]!.id, "other");
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
        for (const value of [after, after.resources, after.documents]) assert.ok(Object.isFrozen(value));
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
