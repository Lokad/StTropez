import test from "node:test";
import assert from "node:assert/strict";
import { TextBuffer, Workspace, createFoldRegions, discoverIndentationFolds, reconcileFoldRanges } from "../src/index.ts";

function finish<T>(iterator: Generator<void, T>): T { let next; do { next = iterator.next(); } while (!next.done); return next.value; }
const policy = { tabSize: 4, markers: [{ start: "#region", end: "#endregion", group: "regions" }] };
test("off-side discovery handles nested indentation, tab stops, interior blanks and closed markers", () => {
    const b = TextBuffer.from("#region task\r\nroot\r\n\tchild\r\n\t  leaf\r\n\r\n\tsibling\r\n\r\n#endregion\r\n\r\n#regional\r\n#region unclosed\r\n");
    const ranges = createFoldRegions(b, reconcileFoldRanges(b, finish(discoverIndentationFolds(b, policy)), []));
    assert.deepEqual(ranges.map(r => [r.lineFrom, r.lineTo, r.group]), [[0, 8, "regions"], [1, 6, "indentation"], [2, 4, "indentation"]]);
    assert.equal(b.readMetrics().textExports, 0);
    assert.deepEqual(finish(discoverIndentationFolds(b, { ...policy, indentation: false })).map(r => r.group), ["regions"]);
    assert.throws(() => finish(discoverIndentationFolds(b, { tabSize: 0 })), /tab size/);
});
test("rediscovery follows mapped headers, keeps view choices through edit/undo and rejects crossing discoveries", () => {
    const workspace = new Workspace(), resource = workspace.createTextResource({ scope: "fold", resource: "discover", variant: "working" }, "Outline", { value: "root\n  child\n    leaf\n  sibling\nend" });
    const a = workspace.createDocumentView(resource.documentId), b = workspace.createDocumentView(resource.documentId);
    const discover = () => { const doc = workspace.document(resource.documentId); for (const view of [a, b]) view.folding.setRanges(view.folding.getSnapshot(), reconcileFoldRanges(doc.buffer, finish(discoverIndentationFolds(doc.buffer)), view.folding.getSnapshot().regions)); };
    try {
        discover(); const original = a.folding.getSnapshot().regions[1]!;
        a.folding.setCollapsed(a.folding.getSnapshot(), original.id, true);
        workspace.edit({ documentId: resource.documentId, expectedRevision: 0, edits: [{ from: 0, to: 0, insert: "preface\n" }], origin: "host" }); discover();
        assert.equal(a.folding.getSnapshot().regions[1]!.id, original.id); assert.equal(a.folding.getSnapshot().regions[1]!.collapsed, true);
        assert.equal(b.folding.getSnapshot().regions[1]!.collapsed, false);
        workspace.undo({ documentId: resource.documentId, expectedRevision: 1 }); discover();
        assert.equal(a.folding.getSnapshot().regions[1]!.lineFrom, 1); assert.equal(a.folding.getSnapshot().regions[1]!.collapsed, true);
        const buffer = workspace.document(resource.documentId).buffer;
        const ranges = reconcileFoldRanges(buffer, [{ from: 0, to: buffer.offsetAt(3) }, { from: buffer.offsetAt(1), to: buffer.length }, { from: 0, to: buffer.offsetAt(2) }], []);
        assert.equal(ranges.length, 1); assert.equal(ranges[0]!.to, buffer.offsetAt(3));
    } finally { a.dispose(); b.dispose(); workspace.releaseResource(resource.id, true); }
});
test("large off-side discovery yields without exporting the document, including long indentation", () => {
    const buffer = TextBuffer.from("root\n" + "  leaf\n".repeat(100000) + "end"), iterator = discoverIndentationFolds(buffer);
    let yields = 0, next; do { next = iterator.next(); if (!next.done) yields++; } while (!next.done);
    assert.ok(yields >= 781); assert.equal(next.value.length, 1); assert.equal(buffer.readMetrics().textExports, 0);
    const long = discoverIndentationFolds(TextBuffer.from("root\n" + " ".repeat(20000) + "leaf"));
    assert.equal(long.next().done, false); assert.equal(finish(long).length, 1);
});

test("expanded discovery metadata does not split an otherwise continuous typing undo group", () => {
    const workspace = new Workspace(), resource = workspace.createTextResource({ scope: "fold", resource: "history", variant: "working" }, "Outline", { value: "root\n  child" });
    const view = workspace.createDocumentView(resource.documentId);
    const type = (insert: string) => { const doc = workspace.document(resource.documentId); workspace.edit({ documentId: doc.id, expectedRevision: doc.revision,
        edits: [{ from: doc.buffer.length, to: doc.buffer.length, insert }], origin: "human", view,
        selection: { anchor: doc.buffer.length + insert.length, head: doc.buffer.length + insert.length }, history: { kind: "typing", group: "continuous" } }); };
    try {
        type("a"); const doc = workspace.document(resource.documentId);
        view.folding.setRanges(view.folding.getSnapshot(), reconcileFoldRanges(doc.buffer, finish(discoverIndentationFolds(doc.buffer)), []));
        type("b"); workspace.undo({ documentId: resource.documentId, expectedRevision: 2 });
        const buffer = workspace.document(resource.documentId).buffer; assert.equal(buffer.slice(0, buffer.length), "root\n  child");
    } finally { view.dispose(); workspace.releaseResource(resource.id, true); }
});
