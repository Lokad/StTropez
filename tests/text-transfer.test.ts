import assert from "node:assert/strict";
import test from "node:test";
import { Workspace } from "../src/index.ts";
import { applyTextDrop, captureTextTransfer } from "../src/browser/text-transfer.ts";

function fixture(value: string, other = "target") {
    const workspace = new Workspace(), source = workspace.createTextResource({ scope: "transfer", resource: "source", variant: "working" }, "Source", { value });
    const destination = workspace.createTextResource({ scope: "transfer", resource: "target", variant: "working" }, "Target", { value: other });
    const sourceTab = workspace.tabs.open({ kind: "text", documentId: source.documentId }), targetTab = workspace.tabs.open({ kind: "text", documentId: destination.documentId });
    const sourceView = workspace.createDocumentView(source.documentId), targetView = workspace.createDocumentView(destination.documentId);
    return { workspace, source, destination, sourceTab, targetTab, sourceView, targetView,
        text: (id = source.documentId) => { const b = workspace.document(id).buffer; return b.slice(0, b.length); },
        capture: () => captureTextTransfer(workspace, workspace.tabs.capture(sourceTab), sourceView)! };
}

test("same-document movement preserves raw fragments and restores the complete initiating set", () => {
    const f = fixture("ab\r\ncd😀ef"); f.sourceView.setSelections(0, [{ anchor: 2, head: 0 }, { anchor: 4, head: 4 }, { anchor: 6, head: 8 }], 2);
    const before = f.sourceView.getSnapshot().selectionSet, transfer = f.capture(); assert.equal(transfer.text, "ab\n😀");
    const result = applyTextDrop({ workspace: f.workspace, tab: f.workspace.tabs.capture(f.sourceTab), view: f.sourceView, expectedRevision: 0, offset: 10, source: transfer });
    assert.equal(result.applied, true); assert.equal(f.text(), "\r\ncdefab\n😀");
    assert.equal(f.workspace.undo({ documentId: f.source.documentId, expectedRevision: 1 }).applied, true);
    assert.equal(f.text(), "ab\r\ncd😀ef"); assert.deepEqual(f.sourceView.getSnapshot().selectionSet, before);
    assert.equal(f.workspace.redo({ documentId: f.source.documentId, expectedRevision: 2 }).applied, true); assert.equal(f.text(), "\r\ncdefab\n😀");
});

test("cross-document move is atomic and has one linked undo unit, including both view sets", () => {
    const f = fixture("first second", "tail"); f.sourceView.setSelections(0, [{ anchor: 0, head: 5 }, { anchor: 6, head: 12 }], 1);
    f.targetView.setSelections(0, [{ anchor: 1, head: 0 }, { anchor: 4, head: 4 }]);
    const before = [f.sourceView.getSnapshot().selectionSet, f.targetView.getSnapshot().selectionSet], seen: string[][] = [];
    const off = f.workspace.observeDocument(f.source.documentId).subscribe(() => seen.push([f.text(), f.text(f.destination.documentId)]));
    const result = applyTextDrop({ workspace: f.workspace, tab: f.workspace.tabs.capture(f.targetTab), view: f.targetView, expectedRevision: 0, offset: 2, source: f.capture() });
    off(); assert.equal(result.applied, true); assert.deepEqual(seen, [[" ", "tafirst\nsecondil"]]);
    assert.equal(f.workspace.observeHistory(f.source.documentId).getSnapshot().undoDepth, 1); assert.equal(f.workspace.observeHistory(f.destination.documentId).getSnapshot().undoDepth, 1);
    assert.equal(f.workspace.undo({ documentId: f.destination.documentId, expectedRevision: 1 }).applied, true);
    assert.equal(f.text(), "first second"); assert.equal(f.text(f.destination.documentId), "tail");
    assert.deepEqual([f.sourceView.getSnapshot().selectionSet, f.targetView.getSnapshot().selectionSet], before);
    assert.equal(f.workspace.redo({ documentId: f.source.documentId, expectedRevision: 2 }).applied, true); assert.equal(f.text(), " ");
});

test("copy and own-source no-op do not delete source text or create spurious history", () => {
    const f = fixture("abcd"); f.sourceView.setSelection(0, { anchor: 1, head: 3 }); const source = f.capture(), set = f.sourceView.getSnapshot().selectionSet;
    const request = { workspace: f.workspace, tab: f.workspace.tabs.capture(f.sourceTab), view: f.sourceView, expectedRevision: 0, offset: 2, source };
    assert.deepEqual(applyTextDrop(request), { applied: true, operation: "noop", revision: 0, offset: null });
    assert.equal(f.workspace.observeHistory(f.source.documentId).getSnapshot().undoDepth, 0); assert.equal(f.sourceView.getSnapshot().selectionSet, set);
    assert.equal(applyTextDrop({ ...request, copy: true }).applied, true); assert.equal(f.text(), "abbccd");
});

test("stale source sets/revisions and stale destination revisions cannot partially move text", () => {
    for (const changed of ["set", "source", "target"]) {
        const f = fixture("abcd"); f.sourceView.setSelection(0, { anchor: 1, head: 3 }); const source = f.capture();
        if (changed === "set") f.sourceView.setSelections(0, [{ anchor: 1, head: 3 }, { anchor: 4, head: 4 }]);
        else { const id = changed === "source" ? f.source.documentId : f.destination.documentId;
            f.workspace.edit({ documentId: id, expectedRevision: 0, origin: "host", edits: [{ from: 0, to: 0, insert: "!" }] }); }
        const before = [f.text(), f.text(f.destination.documentId)];
        assert.equal(applyTextDrop({ workspace: f.workspace, tab: f.workspace.tabs.capture(f.targetTab), view: f.targetView, expectedRevision: 0, offset: 2, source }).applied, false);
        assert.deepEqual([f.text(), f.text(f.destination.documentId)], before);
    }
});

test("a readonly source copies, while loss of source or destination permission refuses atomically", () => {
    const readonly = fixture("abcd"); readonly.sourceView.setSelection(0, { anchor: 1, head: 3 });
    readonly.workspace.setCapabilities(readonly.source.id, { edit: [], save: false });
    const source = readonly.capture(); assert.equal(source.moveAllowed, false);
    const copied = applyTextDrop({ workspace: readonly.workspace, tab: readonly.workspace.tabs.capture(readonly.targetTab), view: readonly.targetView, expectedRevision: 0, offset: 0, source });
    assert.deepEqual(copied, { applied: true, operation: "copy", revision: 1, offset: 2 }); assert.equal(readonly.text(), "abcd"); assert.equal(readonly.text(readonly.destination.documentId), "bctarget");
    for (const lost of ["source", "destination"] as const) {
        const f = fixture("abcd"); f.sourceView.setSelection(0, { anchor: 1, head: 3 }); const capture = f.capture();
        f.workspace.setCapabilities(f[lost].id, { edit: [], save: false });
        const result = applyTextDrop({ workspace: f.workspace, tab: f.workspace.tabs.capture(f.targetTab), view: f.targetView, expectedRevision: 0, offset: 1, source: capture });
        assert.equal(result.applied, false); assert.equal(f.text(), "abcd"); assert.equal(f.text(f.destination.documentId), "target");
        assert.equal(f.workspace.observeHistory(f.source.documentId).getSnapshot().undoDepth, 0);
    }
});

test("replacement, closure or disposed source ownership cannot retarget a captured transfer", () => {
    for (const changed of ["source-tab", "target-tab", "source-close", "source-view"] as const) {
        const f = fixture("abcd"); f.sourceView.setSelection(0, { anchor: 1, head: 3 }); const source = f.capture(), tab = f.workspace.tabs.capture(f.targetTab);
        if (changed === "source-tab") f.workspace.tabs.replace(f.sourceTab, { kind: "text", documentId: f.destination.documentId });
        if (changed === "target-tab") f.workspace.tabs.replace(f.targetTab, { kind: "text", documentId: f.source.documentId });
        if (changed === "source-close") f.workspace.tabs.close(f.sourceTab);
        if (changed === "source-view") f.sourceView.dispose();
        assert.equal(applyTextDrop({ workspace: f.workspace, tab, view: f.targetView, expectedRevision: 0, offset: 1, source }).applied, false);
        assert.equal(f.text(), "abcd"); assert.equal(f.text(f.destination.documentId), "target");
    }
});

test("a move between views retains source history ownership and explicitly positions only the captured target view", () => {
    const f = fixture("abcdef"), dropView = f.workspace.createDocumentView(f.source.documentId);
    f.sourceView.setSelections(0, [{ anchor: 0, head: 0 }, { anchor: 1, head: 3 }], 0);
    const before = f.sourceView.getSnapshot().selectionSet;
    const result = applyTextDrop({ workspace: f.workspace, tab: f.workspace.tabs.capture(f.sourceTab), view: dropView, expectedRevision: 0, offset: 6, source: f.capture() });
    assert.equal(result.applied, true); assert.equal(f.text(), "adefbc"); assert.equal(dropView.getSnapshot().selection.head, 6);
    assert.equal(dropView.getSnapshot().selection.anchor, 4);
    assert.equal(f.workspace.undo({ documentId: f.source.documentId, expectedRevision: 1 }).applied, true);
    assert.equal(f.text(), "abcdef"); assert.deepEqual(f.sourceView.getSnapshot().selectionSet, before);
});

test("external text inserts at the captured drop position instead of replacing the current selection", () => {
    const f = fixture("source"); f.targetView.setSelection(0, { anchor: 6, head: 0 }); const before = f.targetView.getSnapshot().selectionSet, text = "<$&>\r\n😀";
    const result = applyTextDrop({ workspace: f.workspace, tab: f.workspace.tabs.capture(f.targetTab), view: f.targetView, expectedRevision: 0, offset: 3, text });
    assert.equal(result.applied, true); assert.equal(f.text(f.destination.documentId), "tar" + text + "get");
    assert.equal(f.targetView.getSnapshot().selection.anchor, 3); assert.equal(f.targetView.getSnapshot().selection.head, 3 + text.length);
    assert.equal(f.workspace.undo({ documentId: f.destination.documentId, expectedRevision: 1 }).applied, true); assert.deepEqual(f.targetView.getSnapshot().selectionSet, before);
});

test("workspace identity prevents cross-workspace deletion, and internal payloads do not retarget to supplied plain text", () => {
    const from = fixture("abcd"), to = fixture("z"); from.sourceView.setSelection(0, { anchor: 1, head: 3 });
    const result = applyTextDrop({ workspace: to.workspace, tab: to.workspace.tabs.capture(to.sourceTab), view: to.sourceView,
        expectedRevision: 0, offset: 1, source: from.capture(), text: "unrelated" });
    assert.deepEqual(result, { applied: true, operation: "copy", revision: 1, offset: 3 });
    assert.equal(from.text(), "abcd"); assert.equal(to.text(), "zbc");
    assert.equal(from.workspace.observeHistory(from.source.documentId).getSnapshot().undoDepth, 0);
});

test("a source document mismatch is rejected independently of a matching revision and view set", () => {
    const f = fixture("abcd"); f.sourceView.setSelection(0, { anchor: 1, head: 3 });
    const source = { ...f.capture(), documentId: f.destination.documentId };
    const result = applyTextDrop({ workspace: f.workspace, tab: f.workspace.tabs.capture(f.targetTab), view: f.targetView, expectedRevision: 0, offset: 1, source });
    assert.deepEqual(result, { applied: false, reason: "stale-drag-source" }); assert.equal(f.text(), "abcd"); assert.equal(f.text(f.destination.documentId), "target");
});
