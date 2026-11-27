import { bufferReads } from "./buffer-reads.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { reconcileFoldRanges } from "../src/core/fold-discovery.ts";
import { createFoldRegions } from "../src/core/folding.ts";
import { planLanguageEdit, resolveLanguageConfiguration } from "../src/core/language-edits.ts";
import { TextBuffer, Workspace, discoverIndentationFolds } from "../src/index.ts";
import type { IndentationFoldingCursor } from "../src/index.ts";

function finish(cursor: IndentationFoldingCursor) {
    try { let next; do { next = cursor.next(); } while (next.status === "running"); assert.ok(next.result); return next.result; }
    finally { cursor.dispose(); }
}
const policy = { tabSize: 4, markers: [{ start: "#region", end: "#endregion", group: "regions" }] };
test("off-side discovery handles nested indentation, tab stops, interior blanks and closed markers", () => {
    const b = TextBuffer.from("#region task\r\nroot\r\n\tchild\r\n\t  leaf\r\n\r\n\tsibling\r\n\r\n#endregion\r\n\r\n#regional\r\n#region unclosed\r\n");
    const ranges = createFoldRegions(b, reconcileFoldRanges(b, finish(discoverIndentationFolds(b, policy)), []));
    assert.deepEqual(ranges.map(r => [r.lineFrom, r.lineTo, r.group]), [[0, 8, "regions"], [1, 6, "indentation"], [2, 4, "indentation"]]);
    assert.equal(bufferReads(b).textExports, 0);
    const headings: number[] = [];
    const classified = finish(discoverIndentationFolds(b, { ...policy, group(line, source) {
        assert.equal(source, b);
        headings.push(line);
        return line === 1 ? "section" : undefined;
    } }));
    assert.deepEqual(headings.sort(), [1, 2]);
    assert.deepEqual(classified.map(r => r.group).sort(), ["indentation", "regions", "section"]);
    assert.deepEqual(finish(discoverIndentationFolds(b, { ...policy, indentation: false })).map(r => r.group), ["regions"]);
    assert.throws(() => finish(discoverIndentationFolds(b, { tabSize: 0 })), /tab size/);
    const discovered = finish(discoverIndentationFolds(b, policy));
    const invalidPrior = [{ ...ranges[0]!, id: "x".repeat(257) }];
    assert.throws(() => createFoldRegions(b, reconcileFoldRanges(b, discovered, invalidPrior)), /identit/);
    assert.throws(() => createFoldRegions(b, reconcileFoldRanges(b, discovered, ranges.map(r => ({ ...r, id: "duplicate" })))), /identit/);
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
    const a = workspace.createDocumentView(resource.id), b = workspace.createDocumentView(resource.id);
    const discover = () => { const doc = workspace.document(resource.id); for (const view of [a, b]) view.folding.setRanges(view.folding.getSnapshot(), reconcileFoldRanges(doc.buffer, finish(discoverIndentationFolds(doc.buffer)), view.folding.getSnapshot().regions)); };
    try {
        discover(); const original = a.folding.getSnapshot().regions[1]!;
        a.folding.setCollapsed(a.folding.getSnapshot(), original.id, true);
        workspace.edit({ documentId: resource.id, expectedRevision: 0, edits: [{ from: 0, to: 0, insert: "preface\n" }], origin: "host" }); discover();
        assert.equal(a.folding.getSnapshot().regions[1]!.id, original.id); assert.equal(a.folding.getSnapshot().regions[1]!.collapsed, true);
        assert.equal(b.folding.getSnapshot().regions[1]!.collapsed, false);
        workspace.undo({ documentId: resource.id, expectedRevision: 1 }); discover();
        assert.equal(a.folding.getSnapshot().regions[1]!.lineFrom, 1); assert.equal(a.folding.getSnapshot().regions[1]!.collapsed, true);
        const buffer = workspace.document(resource.id).buffer;
        const ranges = reconcileFoldRanges(buffer, [{ from: 0, to: buffer.offsetAt(3) }, { from: buffer.offsetAt(1), to: buffer.length }, { from: 0, to: buffer.offsetAt(2) }], []);
        assert.equal(ranges.length, 1); assert.equal(ranges[0]!.to, buffer.offsetAt(3));
    } finally { a.dispose(); b.dispose(); workspace.releaseResource(resource.id, true); }
});
test("rediscovery keeps the moved block collapsed through repeated moves, Undo and Redo", () => {
    const original = "steps\n  prepare\n    check\n    build\n  publish\n    report\nend\n";
    const workspace = new Workspace();
    const id = workspace.createDocument({ scope: "test", resource: "outline", variant: "text" }, "Outline", original);
    const view = workspace.createDocumentView(id);
    const document = () => workspace.document(id);
    const folds = view.folding;
    function discover() {
        const { buffer } = document();
        const current = folds.getSnapshot();
        const ranges = finish(discoverIndentationFolds(buffer));
        assert.ok(folds.setRanges(current, reconcileFoldRanges(buffer, ranges, current.regions)));
    }
    function move(command: "move-line-up" | "move-line-down") {
        const { revision, buffer } = document();
        const plan = planLanguageEdit(buffer, view.getSnapshot().selectionSet, command,
            resolveLanguageConfiguration(), folds.getSnapshot().index);
        assert.ok(workspace.edit({ documentId: id, view, expectedRevision: revision, origin: "human",
            edits: plan.edits, selectionSet: plan.selectionSet }).status === "done");
    }
    discover();
    const header = folds.getSnapshot().index.headerAt(1)!;
    const peer = workspace.createDocumentView(id);
    const publish = folds.getSnapshot().index.headerAt(4)!;
    peer.folding.setRanges(peer.folding.getSnapshot(), [{ ...publish, collapsed: true }]);
    view.setSelection(0, { anchor: header.from, head: header.from });
    folds.setCollapsed(folds.getSnapshot(), header.id, true);
    function check(line: number) {
        discover();
        const live = folds.getSnapshot().index.headerAt(line);
        assert.deepEqual([live?.id, live?.lineTo, live?.collapsed], [header.id, line + 3, true]);
    }
    move("move-line-down");
    check(2);
    assert.equal(peer.folding.getSnapshot().regions.length, 0);
    assert.ok(workspace.undo({ documentId: id, expectedRevision: document().revision }).status === "done");
    check(1);
    assert.deepEqual(peer.folding.getSnapshot().regions, [{ ...publish, collapsed: true }]);
    for (const [key, line] of [["move-line-down", 2], ["move-line-down", 3], ["move-line-up", 2], ["move-line-up", 1]] as const) {
        move(key);
        check(line);
    }
    assert.equal(document().text(), original);
    assert.ok(workspace.undo({ documentId: id, expectedRevision: document().revision }).status === "done");
    check(2);
    assert.ok(workspace.redo({ documentId: id, expectedRevision: document().revision }).status === "done");
    check(1);
    assert.equal(document().text(), original);
    move("move-line-down");
    for (const at of [document().buffer.length, 0]) {
        assert.equal(workspace.edit({ documentId: id, expectedRevision: document().revision, origin: "host",
            edits: [{ from: at, to: at, insert: "x" }] }).status, "done");
        check(2);
    }
    move("move-line-up");
    check(1);
    assert.equal(document().text(), "x" + original + "x");
    peer.dispose();
    view.dispose();
});

test("large off-side discovery yields without exporting the document, including long indentation", () => {
    const buffer = TextBuffer.from("root\n" + "  leaf\n".repeat(10_000) + "end"), iterator = discoverIndentationFolds(buffer);
    let yields = 0, next; do { next = iterator.next(256); if (next.status === "running") { yields++; assert.equal(next.result, null); } } while (next.status === "running");
    assert.ok(yields > 100); assert.equal(next.result!.length, 1); assert.equal(next.readUnits, bufferReads(buffer).sliceUnits);
    assert.equal(bufferReads(buffer).textExports, 0); iterator.dispose();
    const long = discoverIndentationFolds(TextBuffer.from("root\n" + " ".repeat(20000) + "leaf"));
    assert.equal(long.next().status, "running"); assert.equal(finish(long).length, 1);
});

test("dedent and EOF stacks charge work and publish complete immutable folds only after draining", () => {
    for (const tail of ["", "tail"]) {
        const buffer = TextBuffer.from(Array.from({ length: 600 }, (_, i) => " ".repeat(i) + "x\n").join("") + tail);
        const cursor = discoverIndentationFolds(buffer); let previous = cursor.snapshot(), drainTurns = 0;
        assert.equal(previous.workUnits, 0); assert.equal(bufferReads(buffer).sliceUnits, 0);
        while (previous.status === "running") {
            const next = cursor.next(256); assert.ok(Object.isFrozen(next));
            assert.equal(next.readUnits, bufferReads(buffer).sliceUnits);
            assert.ok(next.workUnits >= previous.workUnits); assert.ok(next.bulkWorkUnits >= previous.bulkWorkUnits);
            assert.ok(next.workUnits - previous.workUnits - (next.bulkWorkUnits - previous.bulkWorkUnits) <= 256 + 4096);
            if (next.status === "running") assert.equal(next.result, null);
            if (next.phase === (tail ? "scan" : "finish") && previous.phase === next.phase && next.readUnits === previous.readUnits
                && next.workUnits > previous.workUnits && next.bulkWorkUnits === previous.bulkWorkUnits) drainTurns++;
            previous = next;
        }
        assert.ok(drainTurns >= 2, "Stack completion must yield even without reading more text");
        assert.equal(previous.result!.length, 599); assert.ok(Object.isFrozen(previous.result)); assert.ok(previous.result!.every(Object.isFrozen));
        assert.equal(previous.result![0]!.from, buffer.offsetAt(598)); assert.equal(previous.result!.at(-1)!.from, 0);
        cursor.dispose(); assert.equal(cursor.snapshot().result, null); assert.equal(previous.result!.length, 599);
    }
});

test("marker validation and lookup cooperate and cancelled or failed discovery stays unpublished", () => {
    const markers = Array.from({ length: 300 }, (_, i) => ({ start: `#start-${i}`, end: `#end-${i}`, group: `group-${i}` }));
    const buffer = TextBuffer.from("#start-299\nbody\n#end-299\n"), options = { markers, indentation: false };
    for (const advance of [false, true]) {
        const cursor = discoverIndentationFolds(buffer, options);
        if (advance) { const next = cursor.next(256); assert.equal(next.status, "running"); assert.equal(next.phase, "validate"); }
        const reads = bufferReads(buffer); cursor.dispose();
        assert.equal(cursor.next().status, "disposed"); assert.equal(cursor.snapshot().result, null); assert.deepEqual(bufferReads(buffer), reads);
    }
    const cursor = discoverIndentationFolds(buffer, options); let previous = cursor.snapshot(), lookupTurns = 0;
    while (previous.status === "running") {
        const next = cursor.next(256);
        if (next.phase === "scan" && previous.phase === "scan" && next.readUnits === previous.readUnits && next.workUnits > previous.workUnits) lookupTurns++;
        previous = next;
    }
    assert.ok(lookupTurns >= 2); assert.deepEqual(previous.result, [{ from: 0, to: buffer.length, group: "group-299" }]); cursor.dispose();
    const invalid = discoverIndentationFolds(buffer, { markers: [{ start: "bad\n", end: "end", group: "bad" }] });
    assert.equal(invalid.snapshot().status, "running"); assert.throws(() => invalid.next(), /Invalid fold markers/);
    assert.equal(invalid.snapshot().status, "failed"); assert.equal(invalid.snapshot().result, null); assert.match(invalid.snapshot().failure!, /Invalid fold markers/); invalid.dispose();
});

test("expanded discovery metadata does not split an otherwise continuous typing undo group", () => {
    const workspace = new Workspace(), resource = workspace.createTextResource({ scope: "fold", resource: "history", variant: "working" }, "Outline", { value: "root\n  child" });
    const view = workspace.createDocumentView(resource.id);
    const type = (insert: string) => { const doc = workspace.document(resource.id); workspace.edit({ documentId: doc.id, expectedRevision: doc.revision,
        edits: [{ from: doc.buffer.length, to: doc.buffer.length, insert }], origin: "human", view,
        selection: { anchor: doc.buffer.length + insert.length, head: doc.buffer.length + insert.length }, history: { kind: "typing", group: "continuous" } }); };
    try {
        type("a"); const doc = workspace.document(resource.id);
        view.folding.setRanges(view.folding.getSnapshot(), reconcileFoldRanges(doc.buffer, finish(discoverIndentationFolds(doc.buffer)), []));
        type("b"); workspace.undo({ documentId: resource.id, expectedRevision: 2 });
        const buffer = workspace.document(resource.id).buffer; assert.equal(buffer.slice(0, buffer.length), "root\n  child");
    } finally { view.dispose(); workspace.releaseResource(resource.id, true); }
});
