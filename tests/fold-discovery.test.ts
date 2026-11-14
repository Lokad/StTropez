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
    const discovered = finish(discoverIndentationFolds(b, policy));
    const invalidPrior = [{ ...ranges[0]!, id: "x".repeat(257) }];
    assert.throws(() => createFoldRegions(b, reconcileFoldRanges(b, discovered, invalidPrior)), /identit/);
    assert.throws(() => createFoldRegions(b, reconcileFoldRanges(b, discovered, ranges.map(r => ({ ...r, id: "duplicate" })))), /identit/);
    const invalidState = ranges.map(r => ({ ...r, collapsed: "invalid" })) as unknown as typeof ranges;
    assert.throws(() => createFoldRegions(b, reconcileFoldRanges(b, discovered, ranges), invalidState), /boolean/);
    assert.throws(() => createFoldRegions(b, ranges.map(({ collapsed: _collapsed, ...r }) => r), invalidState), /boolean/);
    const lineAt = TextBuffer.prototype.lineAt; let reads = 0;
    try {
        TextBuffer.prototype.lineAt = function(offset) { reads++; return lineAt.call(this, offset); };
        const discovered = finish(discoverIndentationFolds(b, policy)), planned = reconcileFoldRanges(b, discovered, ranges);
        // Planning cannot capture stale collapse state: the latest view choice wins at installation.
        const previous = createFoldRegions(b, ranges.map(r => ({ ...r, collapsed: true })));
        reads = 0; const installed = createFoldRegions(b, planned, previous);
        assert.equal(reads, 0); assert.equal(installed, previous);
        assert.equal(createFoldRegions(b, installed, previous), previous); assert.equal(reads, 0);
        reads = 0; const fresh = finish(discoverIndentationFolds(b, policy));
        createFoldRegions(b, reconcileFoldRanges(b, fresh, [])); assert.equal(reads, 0, "discovery carries known rows through installation");
        // Public records, including frozen copies, cannot assert trusted line coordinates.
        const foreign = discovered.map(r => Object.freeze({ ...r, lineFrom: 999, lineTo: 1000 })); reads = 0;
        assert.deepEqual(createFoldRegions(b, reconcileFoldRanges(b, foreign, [])), createFoldRegions(b, reconcileFoldRanges(b, fresh, [])));
        assert.equal(reads, foreign.length * 2);
        const other = TextBuffer.from("\n" + b.slice(0, b.length)); reads = 0;
        createFoldRegions(other, planned); assert.equal(reads, planned.length * 2, "row proofs belong to one immutable buffer");
    } finally { TextBuffer.prototype.lineAt = lineAt; }
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
