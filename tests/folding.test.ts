import test from "node:test";
import assert from "node:assert/strict";
import { FoldIndex, TextBuffer, Workspace, createFoldRegions } from "../src/index.ts";
import { mapFoldRegions, revealSelectionFolds } from "../src/core/folding.ts";

test("nested collapsed rows keep independent child state and index visible rows without losing raw lines", () => {
    const buffer = TextBuffer.from("header\r\nchild\nbody\nend\nnext\nlast"), ranges = createFoldRegions(buffer, [
        { id: "outer", from: 0, to: buffer.offsetAt(4), collapsed: true }, { id: "inner", from: buffer.offsetAt(1), to: buffer.offsetAt(3), collapsed: true },
    ]);
    const index = new FoldIndex(buffer.lineCount, ranges);
    assert.equal(index.regions, ranges); assert.equal(index.headerAt(1), ranges[1]);
    assert.throws(() => new FoldIndex(2, ranges), /row interval/);
    const foreign = ranges.map(r => ({ ...r })), copied = new FoldIndex(buffer.lineCount, foreign);
    foreign[0]!.collapsed = false; assert.equal(copied.regions[0]!.collapsed, true);
    assert.throws(() => new FoldIndex(buffer.lineCount, Object.freeze([Object.freeze({ ...ranges[0]!, lineTo: 999 })])), /row interval/);
    assert.equal(index.visibleLineCount, 3); assert.deepEqual([0, 1, 2].map(row => index.lineAt(row)), [0, 4, 5]);
    assert.deepEqual([0, 1, 2, 3, 4, 5].map(line => index.rowAt(line)), [0, 0, 0, 0, 1, 2]);
    assert.equal(index.hiddenBy(2)?.id, "outer"); assert.equal(index.headerAt(1)?.id, "inner");
    const expanded = new FoldIndex(buffer.lineCount, ranges.map(r => ({ ...r, collapsed: r.id === "inner" })));
    assert.deepEqual(Array.from({ length: expanded.visibleLineCount }, (_, row) => expanded.lineAt(row)), [0, 1, 3, 4, 5]);
    assert.equal(expanded.hiddenBy(2)?.id, "inner"); assert.ok(Object.isFrozen(index)); assert.ok(Object.isFrozen(index.regions[0]));
    assert.equal(index.sameProjection(expanded), false);
    assert.equal(new FoldIndex(buffer.lineCount, []).sameProjection(new FoldIndex(buffer.lineCount, ranges.map(r => ({ ...r, collapsed: false })))), true);
    assert.equal(index.sameProjection(new FoldIndex(buffer.lineCount, ranges.map(r => ({ ...r, group: "new metadata", collapsed: r.id === "outer" })))), true);
    assert.equal(buffer.readMetrics().textExports, 0); assert.throws(() => index.lineAt(3), RangeError);
    const huge = new FoldIndex(100001, [{ id: "many", from: 1, to: 100000, lineFrom: 1, lineTo: 100000, collapsed: true }]);
    assert.equal(huge.visibleLineCount, 3); assert.equal(huge.lineAt(2), 100000); assert.equal(huge.rowAt(99999), 1);
});

function fixture() {
    const model = new Workspace(), source = model.createTextResource({ scope: "fold", resource: "source", variant: "working" }, "Source", { value: "header\r\nbody one\r\nbody two\r\nend" });
    const view = model.createDocumentView(source.documentId), peer = model.createDocumentView(source.documentId);
    const text = () => { const b = model.document(source.documentId).buffer; return b.slice(0, b.length); };
    return { model, source, view, peer, text, finish: () => { view.dispose(); peer.dispose(); model.releaseResource(source.id, true); assert.equal(model.diagnostics().views, 0); assert.equal(model.diagnostics().leases, 0); assert.equal(model.diagnostics().subscriptions, 0); } };
}
test("fold commands capture view/revision/generation and keep source, history and other views independent", () => {
    const f = fixture(); try {
        const folds = f.view.folding, before = folds.getSnapshot(), document = f.model.document(f.source.documentId), history = f.model.observeHistory(f.source.documentId).getSnapshot();
        assert.equal(folds.setRanges(before, [{ id: "block", from: 0, to: document.buffer.offsetAt(3), collapsed: true }]), true);
        assert.equal(folds.setCollapsed(before, "block", false), false); assert.equal(folds.getSnapshot().index.visibleLineCount, 2); assert.equal(f.peer.folding.getSnapshot().regions.length, 0);
        assert.equal(f.model.document(f.source.documentId), document); assert.equal(f.source.getSnapshot().metadata.dirty, false); assert.deepEqual(f.model.observeHistory(f.source.documentId).getSnapshot(), history);
        const current = folds.getSnapshot(); assert.equal(folds.setRanges(current, [{ id: "block", from: 0, to: document.buffer.offsetAt(3) }]), true); assert.equal(folds.getSnapshot(), current);
        assert.throws(() => folds.setRanges(current, [{ id: "a", from: 0, to: document.buffer.offsetAt(2) }, { id: "b", from: document.buffer.offsetAt(1), to: document.buffer.length }]), /nest/);
        assert.equal(folds.getSnapshot(), current); assert.ok(Object.isFrozen(current.regions)); assert.ok(Object.isFrozen(current.regions[0]));
        f.view.setSelections(0, [{ anchor: 0, head: 0 }, { anchor: document.buffer.offsetAt(2), head: document.buffer.offsetAt(2) }], 1);
        assert.equal(folds.getSnapshot().regions[0]!.collapsed, false); assert.equal(f.view.getSnapshot().selectionSet.ranges.length, 2);
        folds.setCollapsed(folds.getSnapshot(), "block", true);
        f.view.setSelections(0, f.view.getSnapshot().selectionSet.ranges, 1); assert.equal(folds.getSnapshot().regions[0]!.collapsed, false, "an explicit unchanged hidden selection reveals its row");
        f.view.dispose(); assert.equal(folds.setCollapsed(folds.getSnapshot(), "block", true), false);
    } finally { f.finish(); }
});

test("fold anchors map through interior edits, shared undo/redo and no-op selection requests without exporting text", () => {
    const f = fixture(); try {
        const folds = f.view.folding, before = f.model.document(f.source.documentId).buffer;
        folds.setRanges(folds.getSnapshot(), [{ id: "block", from: 0, to: before.offsetAt(3), collapsed: true }]);
        f.model.edit({ documentId: f.source.documentId, expectedRevision: 0, origin: "host", edits: [{ from: before.offsetAt(1) + 2, to: before.offsetAt(1) + 2, insert: "new\r\n" }] });
        let state = folds.getSnapshot(); assert.equal(state.revision, 1); assert.equal(state.regions[0]!.collapsed, true); assert.equal(state.regions[0]!.lineTo, 4);
        f.model.undo({ documentId: f.source.documentId, expectedRevision: 1 }); state = folds.getSnapshot(); assert.equal(state.regions[0]!.to, before.offsetAt(3)); assert.equal(state.regions[0]!.collapsed, true);
        f.model.redo({ documentId: f.source.documentId, expectedRevision: 2 }); assert.equal(folds.getSnapshot().regions[0]!.lineTo, 4);
        const doc = f.model.document(f.source.documentId), history = f.model.observeHistory(f.source.documentId).getSnapshot();
        f.model.edit({ documentId: f.source.documentId, expectedRevision: doc.revision, origin: "human", edits: [], view: f.view, selection: { anchor: doc.buffer.offsetAt(2), head: doc.buffer.offsetAt(2) } });
        assert.equal(folds.getSnapshot().regions[0]!.collapsed, false); assert.equal(f.model.document(f.source.documentId).revision, doc.revision); assert.deepEqual(f.model.observeHistory(f.source.documentId).getSnapshot(), history);
        assert.equal(doc.buffer.readMetrics().textExports, 0);
    } finally { f.finish(); }
});

test("boundary newline removal cannot publish crossing folds or interrupt an atomic text transaction", () => {
    const f = fixture(); try {
        const b = f.model.document(f.source.documentId).buffer;
        f.view.folding.setRanges(f.view.folding.getSnapshot(), [{ id: "left", from: 0, to: b.offsetAt(2), collapsed: true }, { id: "right", from: b.offsetAt(2), to: b.length, collapsed: true }]);
        const at = b.offsetAt(2); assert.equal(f.model.edit({ documentId: f.source.documentId, expectedRevision: 0, origin: "host", edits: [{ from: at - 2, to: at, insert: "" }] }).applied, true);
        assert.equal(f.text(), "header\r\nbody onebody two\r\nend"); assert.equal(f.view.getSnapshot().revision, 1); assert.equal(f.view.folding.getSnapshot().revision, 1);
        assert.equal(f.view.folding.getSnapshot().regions.length, 1); assert.equal(f.view.folding.getSnapshot().regions[0]!.collapsed, false);
        f.model.undo({ documentId: f.source.documentId, expectedRevision: 1 }); assert.equal(f.text(), "header\r\nbody one\r\nbody two\r\nend");
    } finally { f.finish(); }
});

test("mapped sparse folds agree with a naive row oracle across bounded structural edits and undo", () => {
    const model = new Workspace(), source = model.createTextResource({ scope: "fold", resource: "structural", variant: "working" }, "Source", { value: "header\r\nbody\n".repeat(60) + "end" });
    const view = model.createDocumentView(source.documentId); let seed = 5321;
    const next = (limit: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
    const verify = () => {
        const document = model.document(source.documentId), snapshot = view.folding.getSnapshot(), index = snapshot.index;
        assert.equal(snapshot.revision, document.revision);
        for (const r of snapshot.regions) {
            assert.equal(r.lineFrom, document.buffer.lineAt(r.from)); assert.equal(r.lineTo, document.buffer.lineAt(r.to - 1) + 1);
        }
        const visible: number[] = [];
        for (let line = 0; line < document.buffer.lineCount; line++) {
            const owner = snapshot.regions.find(r => r.collapsed && r.lineFrom < line && r.lineTo > line);
            assert.equal(index.hiddenBy(line)?.id, owner?.id);
            if (!owner) visible.push(line);
            assert.equal(index.rowAt(line), visible.length - 1);
        }
        assert.equal(index.visibleLineCount, visible.length);
        assert.deepEqual(visible.map((_, row) => index.lineAt(row)), visible);
        assert.equal(document.buffer.readMetrics().textExports, 0);
    };
    try {
        for (let step = 0; step < 160; step++) {
            const before = model.document(source.documentId), b = before.buffer;
            if (step % 10 === 0) {
                const ranges = [];
                for (let line = 0; line + 8 < b.lineCount; line += 10) {
                    ranges.push({ id: `outer-${line}`, from: b.offsetAt(line), to: b.offsetAt(line + 8), collapsed: next(2) === 0 });
                    ranges.push({ id: `inner-${line}`, from: b.offsetAt(line + 2), to: b.offsetAt(line + 5), collapsed: next(2) === 0 });
                }
                view.folding.setRanges(view.folding.getSnapshot(), ranges);
            }
            const from = next(b.length + 1), to = Math.min(b.length, from + next(21)), insert = ["", "x", "\r\n", "a\nb\r\nc"][next(4)]!;
            const prior = view.folding.getSnapshot().regions;
            model.edit({ documentId: source.documentId, expectedRevision: before.revision, origin: "host", edits: [{ from, to, insert }] }); verify();
            if (model.document(source.documentId).revision !== before.revision) {
                const after = model.document(source.documentId);
                const expected = revealSelectionFolds(after.buffer, mapFoldRegions(after.buffer, after.change!.mapping, prior), view.getSnapshot().selectionSet);
                assert.deepEqual(view.folding.getSnapshot().regions, expected, `full row-resolution oracle at step ${step}`);
            }
            if (step % 7 === 0 && model.document(source.documentId).revision !== before.revision) {
                model.undo({ documentId: source.documentId, expectedRevision: model.document(source.documentId).revision }); verify();
                const current = model.document(source.documentId).buffer; assert.equal(current.length, b.length); assert.equal(current.slice(0, current.length), b.slice(0, b.length));
            }
        }
    } finally { view.dispose(); model.releaseResource(source.id, true); }
});

test("fold updates reuse unchanged metadata and bound line lookups to changed endpoints", () => {
    const model = new Workspace(), source = model.createTextResource({ scope: "fold", resource: "reuse", variant: "working" }, "Source", { value: "header\nbody\n".repeat(2000) + "tail" });
    const view = model.createDocumentView(source.documentId), peer = model.createDocumentView(source.documentId);
    const lineAt = TextBuffer.prototype.lineAt; let reads = 0;
    const edit = (from: number, to: number, insert: string, grouped = false) => {
        const before = model.document(source.documentId); reads = 0;
        model.edit({ documentId: source.documentId, expectedRevision: before.revision, origin: "human", view,
            edits: [{ from, to, insert }], selection: { anchor: from + insert.length, head: from + insert.length },
            ...(grouped ? { history: { kind: "typing" as const, group: "fold-edges" } } : {}) });
        assert.ok(reads < 20, `line lookups must not scale with 2000 untouched regions: ${reads}`);
    };
    try {
        const original = model.document(source.documentId).buffer;
        const ranges = Array.from({ length: 2000 }, (_, i) => ({ id: `fold-${i}`, from: original.offsetAt(i * 2), to: original.offsetAt(i * 2 + 2), collapsed: true }));
        view.folding.setRanges(view.folding.getSnapshot(), ranges); peer.folding.setRanges(peer.folding.getSnapshot(), ranges);
        const first = view.folding.getSnapshot();
        TextBuffer.prototype.lineAt = function(offset) { reads++; return lineAt.call(this, offset); };
        edit(original.length, original.length, "x", true); edit(original.length + 1, original.length + 1, "y", true);
        assert.equal(view.folding.getSnapshot().regions, first.regions); assert.equal(view.folding.getSnapshot().index, first.index);
        reads = 0; model.undo({ documentId: source.documentId, expectedRevision: 2 }); assert.ok(reads < 20);
        assert.equal(view.folding.getSnapshot().regions, first.regions); assert.equal(model.document(source.documentId).buffer, original);
        edit(original.length, original.length, "\n"); assert.equal(view.folding.getSnapshot().regions, first.regions);
        assert.equal(view.folding.getSnapshot().index.regions, first.regions); assert.equal(view.folding.getSnapshot().index.lineCount, original.lineCount + 1);
        // Same-length replacements change row metadata even when every suffix offset stays fixed.
        edit(0, 1, "\n"); const shifted = view.folding.getSnapshot().regions;
        assert.equal(shifted[1]!.from, first.regions[1]!.from); assert.equal(shifted[1]!.lineFrom, first.regions[1]!.lineFrom + 1);
        assert.equal(peer.folding.getSnapshot().regions[1]!.collapsed, true);
        edit(0, 1, "h"); assert.equal(view.folding.getSnapshot().regions[1]!.lineFrom, first.regions[1]!.lineFrom);
        edit(0, 0, "prefix\n"); assert.equal(view.folding.getSnapshot().regions[1]!.lineFrom, first.regions[1]!.lineFrom + 1);
        assert.equal(view.folding.getSnapshot().index.regions, view.folding.getSnapshot().regions);
    } finally { TextBuffer.prototype.lineAt = lineAt; view.dispose(); peer.dispose(); model.releaseResource(source.id, true); }
});
