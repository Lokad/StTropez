import test from "node:test";
import { nextSeed } from "./fixtures/workloads.ts";
import assert from "node:assert/strict";
import { FoldIndex } from "../src/core/folding.ts";
import { TextBuffer, Workspace, createFoldRegions, planLanguageEdit, resolveLanguageConfiguration } from "../src/index.ts";
import { mapFoldRegions, revealSelectionFolds } from "../src/core/folding.ts";

test("nested collapsed rows keep independent child state and index visible rows without losing raw lines", () => {
    const buffer = TextBuffer.from("header\r\nchild\nbody\nend\nnext\nlast"), ranges = createFoldRegions(buffer, [
        { id: "outer", from: 0, to: buffer.offsetAt(4), collapsed: true }, { id: "inner", from: buffer.offsetAt(1), to: buffer.offsetAt(3), collapsed: true },
    ]);
    const index = new FoldIndex(buffer.lineCount, ranges);
    assert.equal(index.regions, ranges); assert.equal(index.headerAt(1), ranges[1]);
    assert.throws(() => new FoldIndex(2, ranges), /row interval/);
    const construct = (values: typeof ranges) => new FoldIndex(buffer.lineCount, createFoldRegions(buffer, values));
    const foreign = ranges.map(r => ({ ...r })), copied = construct(foreign);
    foreign[0]!.collapsed = false; assert.equal(copied.regions[0]!.collapsed, true);
    assert.throws(() => new FoldIndex(buffer.lineCount, Object.freeze([Object.freeze({ ...ranges[0]!, lineTo: 999 })])), /row interval/);
    const crossing = Object.freeze(ranges.map((r, i) => Object.freeze(i ? { ...r, to: buffer.length, lineTo: buffer.lineCount } : { ...r })));
    assert.throws(() => construct(crossing), /nest or remain disjoint/);
    assert.equal(index.visibleLineCount, 3); assert.deepEqual([0, 1, 2].map(row => index.lineAt(row)), [0, 4, 5]);
    assert.deepEqual([0, 1, 2, 3, 4, 5].map(line => index.rowAt(line)), [0, 0, 0, 0, 1, 2]);
    assert.equal(index.hiddenBy(2)?.id, "outer"); assert.equal(index.headerAt(1)?.id, "inner");
    const expanded = construct(ranges.map(r => ({ ...r, collapsed: r.id === "inner" })));
    assert.deepEqual(Array.from({ length: expanded.visibleLineCount }, (_, row) => expanded.lineAt(row)), [0, 1, 3, 4, 5]);
    assert.equal(expanded.hiddenBy(2)?.id, "inner"); assert.ok(Object.isFrozen(index)); assert.ok(Object.isFrozen(index.regions[0]));
    assert.equal(index.sameProjection(expanded), false);
    assert.equal(new FoldIndex(buffer.lineCount).sameProjection(construct(ranges.map(r => ({ ...r, collapsed: false })))), true);
    assert.equal(index.sameProjection(construct(ranges.map(r => ({ ...r, group: "new metadata", collapsed: r.id === "outer" })))), true);
    assert.throws(() => index.lineAt(3), RangeError);
    const sparse = TextBuffer.from("\n".repeat(100000));
    const huge = new FoldIndex(sparse.lineCount, createFoldRegions(sparse, [{ id: "many", from: 1, to: 100000, collapsed: true }]));
    assert.equal(huge.visibleLineCount, 3); assert.equal(huge.lineAt(2), 100000); assert.equal(huge.rowAt(99999), 1);
});

function fixture() {
    const model = new Workspace(), source = model.createTextResource({ scope: "fold", resource: "source", variant: "working" }, "Source", { value: "header\r\nbody one\r\nbody two\r\nend" });
    const view = model.createDocumentView(source.id), peer = model.createDocumentView(source.id);
    const text = () => { const b = model.document(source.id).buffer; return b.slice(0, b.length); };
    return { model, source, view, peer, text, finish: () => { view.dispose(); peer.dispose(); model.releaseResource(source.id, true); assert.equal(model.diagnostics().views, 0); assert.equal(model.diagnostics().leases, 0); assert.equal(model.diagnostics().subscriptions, 0); } };
}

test("composed host edits replay folded moves in order and preserve later fold choices", () => {
    const workspace = new Workspace();
    const source = workspace.createTextResource({ scope: "fold", resource: "group", variant: "text" }, "Outline", {
        value: "a\n  A\nb\n  B\nc\n  C\ntail"
    });
    const id = source.id;
    const view = workspace.createDocumentView(id);
    const document = () => workspace.document(id);
    const snapshot = () => view.folding.getSnapshot();
    const state = () => snapshot().regions.map(r => [r.id, r.lineFrom, r.collapsed]);
    const history = { kind: "refactor", group: "reorder" } as const;
    try {
        const { buffer } = document();
        view.folding.setRanges(snapshot(), ["a", "b", "c"].map((id, i) => ({
            id, from: buffer.offsetAt(2 * i), to: buffer.offsetAt(2 * i + 2), collapsed: true
        })));
        // A named host action can combine ordinary edits and several line moves into one Undo.
        const append = () => {
            const { revision, buffer } = document();
            assert.ok(workspace.edit({ documentId: id, expectedRevision: revision, origin: "host", history, view,
                edits: [{ from: buffer.length, to: buffer.length, insert: "!" }] }).status === "done");
        };
        append();
        for (let i = 0; i < 2; i++) {
            const { revision, buffer } = document();
            const proposal = planLanguageEdit(buffer, view.getSnapshot().selectionSet, "move-line-down",
                resolveLanguageConfiguration(), snapshot().index);
            const plan = structuredClone(proposal);
            assert.ok(workspace.edit({ documentId: id, expectedRevision: revision, origin: "host", history, view,
                edits: plan.edits, selectionSet: plan.selectionSet }).status === "done");
        }
        append();
        view.folding.setCollapsed(snapshot(), "b", false);
        const moved = [["b", 0, false], ["c", 2, true], ["a", 4, true]];
        assert.deepEqual(state(), moved);
        assert.equal(workspace.observeHistory(id).getSnapshot().undoDepth, 1);
        assert.ok(workspace.undo({ documentId: id, expectedRevision: document().revision }).status === "done");
        assert.equal(document().buffer.text(), buffer.text());
        assert.deepEqual(state(), [["a", 0, true], ["b", 2, false], ["c", 4, true]]);
        assert.ok(workspace.redo({ documentId: id, expectedRevision: document().revision }).status === "done");
        assert.equal(document().buffer.text(), "b\n  B\nc\n  C\na\n  A\ntail!!");
        assert.deepEqual(state(), moved);

        // A synchronous transaction can stage the same kind of move before a second edit.
        assert.ok(workspace.undo({ documentId: id, expectedRevision: document().revision }).status === "done");
        view.folding.setCollapsed(snapshot(), "b", true);
        const proposal = planLanguageEdit(buffer, view.getSnapshot().selectionSet, "move-line-down",
            resolveLanguageConfiguration(), snapshot().index);
        const move = proposal.edits;
        workspace.transact(id, document().revision, tx => {
            tx.edit(move);
            tx.edit([{ from: tx.buffer.length, to: tx.buffer.length, insert: "!" }]);
        }, { origin: "host", history: "record", kind: "refactor" });
        const swapped = [["b", 0, true], ["a", 2, true], ["c", 4, true]];
        assert.deepEqual(state(), swapped);
        assert.ok(workspace.undo({ documentId: id, expectedRevision: document().revision }).status === "done");
        assert.deepEqual(state(), [["a", 0, true], ["b", 2, true], ["c", 4, true]]);
        assert.ok(workspace.redo({ documentId: id, expectedRevision: document().revision }).status === "done");
        assert.deepEqual(state(), swapped);
    } finally {
        view.dispose();
        workspace.releaseResource(source.id, true);
    }
});

test("copied line moves carry each view's folds through undo and redo", () => {
    const workspace = new Workspace();
    const source = workspace.createTextResource({ scope: "fold", resource: "move", variant: "text" }, "Move", {
        value: "a\r\n  A\nb\n  B\r\nc\n  C\r\nd\r\n  D"
    });
    const documentId = source.id;
    const main = workspace.createDocumentView(documentId);
    const peer = workspace.createDocumentView(documentId);
    const original = workspace.document(documentId);
    const ids = ["a", "b", "c", "d"];
    const heads = [0, original.buffer.offsetAt(4)];
    const ranges = ids.map((id, i) => ({
        id, from: original.buffer.offsetAt(2 * i), to: i === 3 ? original.buffer.length : original.buffer.offsetAt(2 * i + 2)
    }));
    const states = () => [main, peer].map(view => view.folding.getSnapshot().regions.map(r => [r.id, r.lineFrom, r.collapsed]));
    try {
        for (const view of [main, peer]) {
            view.folding.setRanges(view.folding.getSnapshot(), ranges.map(r => ({ ...r, collapsed: view === main || r.id === "c" })));
        }
        main.setSelections(original.revision, heads.map(head => ({ head, anchor: head })), 0);
        const before = states();
        const proposal = planLanguageEdit(original.buffer, main.getSnapshot().selectionSet, "move-line-down",
            resolveLanguageConfiguration(), main.folding.getSnapshot().index);
        const plan = structuredClone(proposal);
        const apply = (edits: typeof plan.edits) => workspace.edit({ documentId, view: main, origin: "host",
            expectedRevision: workspace.document(documentId).revision, edits, selectionSet: plan.selectionSet });
        const history = () => ({ documentId, expectedRevision: workspace.document(documentId).revision });
        assert.ok(apply(plan.edits).status === "done");
        const after = states();
        assert.deepEqual(after, [main, peer].map(view => ["b", "a", "d", "c"].map((id, i) => [id, 2 * i, view === main || id === "c"])));
        assert.ok(workspace.undo(history()).status === "done");
        assert.deepEqual(states(), before);
        assert.ok(workspace.redo(history()).status === "done");
        assert.deepEqual(states(), after);
        assert.ok(workspace.undo(history()).status === "done");
        // An ordinary cut and paste has no move intent. Retaining the marker while changing
        // the transferred text must not attach the discarded block's fold to different text.
        const plain = plan.edits.map(({ from, to, insert }) => ({ from, to, insert }));
        assert.ok(apply(plain).status === "done");
        const ordinary = states();
        assert.notDeepEqual(ordinary, after);
        assert.ok(workspace.undo(history()).status === "done");
        assert.ok(apply(plan.edits.map(edit => ({ ...edit, insert: edit.insert.replace("B", "X") }))).status === "done");
        assert.deepEqual(states(), ordinary);
    } finally {
        main.dispose();
        peer.dispose();
        workspace.releaseResource(source.id, true);
    }
});

test("shifted headers and hidden rows keep their revision and per-view collapse state through Undo", () => {
    const f = fixture(), id = f.source.id;
    try {
        const buffer = f.model.document(id).buffer, header = buffer.offsetAt(1);
        const range = { id: "body", group: "outline", from: header, to: buffer.offsetAt(3) };
        for (const view of [f.view, f.peer]) view.folding.setRanges(view.folding.getSnapshot(), [{ ...range, collapsed: view === f.view }]);
        const original = f.view.folding.getSnapshot();
        const insert = (text: string) => f.model.edit({ documentId: id, expectedRevision: f.model.document(id).revision,
            origin: "human", edits: [{ from: 0, to: 0, insert: text }] });
        insert("🌲\r\n");
        const first = f.view.folding.getSnapshot();
        const captured = first.index.headerAt(2)!;
        assert.deepEqual(captured, { ...range, from: header + 4, to: range.to + 4, lineFrom: 2, lineTo: 4, collapsed: true });
        assert.equal(first.index.hiddenBy(3), captured);
        assert.equal(first.index.rowAt(3), 2); assert.equal(first.index.lineAt(3), 4);
        assert.equal(f.peer.folding.getSnapshot().index.hiddenBy(3), undefined);
        insert("x");
        const second = f.view.folding.getSnapshot();
        assert.equal(second.index.headerAt(2)!.from, header + 5); assert.ok(first.index.sameProjection(second.index));
        assert.equal(second.index.sameProjection(original.index), false);
        assert.equal(f.view.folding.reveal(second, 0, header), true); assert.equal(f.view.folding.getSnapshot(), second);
        f.model.undo({ documentId: id, expectedRevision: 2 });
        assert.deepEqual(f.view.folding.getSnapshot().index.headerAt(2), captured);
        f.model.redo({ documentId: id, expectedRevision: 3 });
        const current = f.view.folding.getSnapshot();
        assert.equal(f.view.folding.reveal(current, f.model.document(id).buffer.offsetAt(3)), true);
        assert.equal(f.view.folding.getSnapshot().index.collapsedCount, 0);
        assert.equal(first.regions[0], captured); assert.equal(first.index.collapsedRegions().next().value, captured);
        assert.equal(original.regions[0]!.from, header); assert.equal(second.index.hiddenBy(3), second.regions[0]);
    } finally { f.finish(); }
});
test("fold commands capture view/revision/generation and keep source, history and other views independent", () => {
    const f = fixture(); try {
        const folds = f.view.folding, before = folds.getSnapshot(), document = f.model.document(f.source.id), history = f.model.observeHistory(f.source.id).getSnapshot();
        assert.equal(folds.setRanges(before, [{ id: "block", from: 0, to: document.buffer.offsetAt(3), collapsed: true }]), true);
        assert.equal(folds.setCollapsed(before, "block", false), false); assert.equal(folds.getSnapshot().index.visibleLineCount, 2); assert.equal(f.peer.folding.getSnapshot().regions.length, 0);
        assert.equal(f.model.document(f.source.id), document); assert.equal(f.source.getSnapshot().metadata.dirty, false); assert.deepEqual(f.model.observeHistory(f.source.id).getSnapshot(), history);
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

test("a complete selection through EOF keeps the block folded in either direction", () => {
    const f = fixture();
    try {
        const folds = f.view.folding, end = f.model.document(f.source.id).buffer.length;
        folds.setRanges(folds.getSnapshot(), [{ id: "block", from: 0, to: end, collapsed: true }]);
        for (const range of [{ anchor: 0, head: end }, { anchor: end, head: 0 }]) {
            f.view.setSelection(0, range);
            assert.equal(folds.getSnapshot().index.collapsedCount, 1);
        }
        for (const anchor of [1, end]) {
            folds.setCollapsed(folds.getSnapshot(), "block", true);
            f.view.setSelection(0, { anchor, head: end });
            assert.equal(folds.getSnapshot().index.collapsedCount, 0);
        }
    } finally { f.finish(); }
});

test("a group collapse publishes both visible carets and folds together or leaves both alone", () => {
    const f = fixture();
    try {
        const folds = f.view.folding, buffer = f.model.document(f.source.id).buffer;
        const second = buffer.offsetAt(2);
        folds.setRanges(folds.getSnapshot(), [{ id: "first", from: 0, to: second }, { id: "second", from: second, to: buffer.length }]);
        f.view.setSelections(0, [{ anchor: 9, head: 9 }, { anchor: buffer.length, head: buffer.length }], 1);
        const before = folds.getSnapshot(), viewBefore = f.view.getSnapshot(), peerBefore = f.peer.getSnapshot();
        const observations: { heads: number[]; count: number }[] = [];
        const observe = () => observations.push({ heads: f.view.getSnapshot().selectionSet.ranges.map(r => r.head), count: folds.getSnapshot().index.collapsedCount });
        const stopView = f.view.subscribe(observe), stopFolds = folds.subscribe(observe);
        try {
            const options = { moveHiddenCarets: true };
            assert.equal(folds.setCollapsed(before, ["first", "unknown"], true, options), false);
            assert.equal(folds.setCollapsed(before, [], true, options), false);
            assert.equal(folds.getSnapshot(), before); assert.equal(f.view.getSnapshot(), viewBefore);
            assert.equal(folds.setCollapsed(before, ["second", "first"], true, options), true);
            assert.deepEqual(observations, [{ heads: [6, second + "body two".length], count: 2 }]);
            assert.equal(f.view.getSnapshot().selectionSet.primary, 1);
            assert.equal(folds.setCollapsed(before, ["first", "second"], false), false);
            assert.equal(f.peer.getSnapshot(), peerBefore);
        } finally { stopView(); stopFolds(); }
    } finally { f.finish(); }
});

test("fold anchors map through interior edits, shared undo/redo and no-op selection requests", () => {
    const f = fixture(); try {
        const folds = f.view.folding, before = f.model.document(f.source.id).buffer;
        folds.setRanges(folds.getSnapshot(), [{ id: "block", from: 0, to: before.offsetAt(3), collapsed: true }]);
        f.model.edit({ documentId: f.source.id, expectedRevision: 0, origin: "host", edits: [{ from: before.offsetAt(1) + 2, to: before.offsetAt(1) + 2, insert: "new\r\n" }] });
        let state = folds.getSnapshot(); assert.equal(state.revision, 1); assert.equal(state.regions[0]!.collapsed, true); assert.equal(state.regions[0]!.lineTo, 4);
        f.model.undo({ documentId: f.source.id, expectedRevision: 1 }); state = folds.getSnapshot(); assert.equal(state.regions[0]!.to, before.offsetAt(3)); assert.equal(state.regions[0]!.collapsed, true);
        f.model.redo({ documentId: f.source.id, expectedRevision: 2 }); assert.equal(folds.getSnapshot().regions[0]!.lineTo, 4);
        const doc = f.model.document(f.source.id), history = f.model.observeHistory(f.source.id).getSnapshot();
        f.model.edit({ documentId: f.source.id, expectedRevision: doc.revision, origin: "human", edits: [], view: f.view, selection: { anchor: doc.buffer.offsetAt(2), head: doc.buffer.offsetAt(2) } });
        assert.equal(folds.getSnapshot().regions[0]!.collapsed, false); assert.equal(f.model.document(f.source.id).revision, doc.revision); assert.deepEqual(f.model.observeHistory(f.source.id).getSnapshot(), history);
    } finally { f.finish(); }
});

for (const origin of ["edit", "proposal", "canonical"] as const) test(`${origin} and replay publish mapped views, folds and history together`, () => {
    const errors: unknown[] = [], model = new Workspace({ onListenerError: error => errors.push(error) });
    const original = "head\none\ntwo\nend", updated = "head\none\nnew\ntwo\nend";
    const source = model.createTextResource({ scope: "fold", resource: origin, variant: "working" }, "Source", { value: original });
    const view = model.createDocumentView(source.id), peer = model.createDocumentView(source.id);
    view.setSelection(0, { anchor: 9, head: 9 }); peer.setSelection(0, { anchor: original.length, head: original.length });
    for (const target of [view, peer]) target.folding.setRanges(target.folding.getSnapshot(), [{ id: "block", from: 0, to: 13, collapsed: true }]);
    const ticket = origin === "canonical" ? model.captureSave(source) : undefined; ticket?.start();
    let notifications = 0, expectedRevision = 1;
    const inspect = () => {
        notifications++;
        const document = model.document(source.id), undone = expectedRevision === 2;
        assert.equal(document.revision, expectedRevision); assert.equal(document.text(), undone ? original : updated);
        assert.deepEqual(model.observeHistory(source.id).getSnapshot(), { undoDepth: undone ? 0 : 1, redoDepth: undone ? 1 : 0 });
        for (const target of [view, peer]) {
            assert.equal(target.getSnapshot().revision, expectedRevision); assert.equal(target.folding.getSnapshot().revision, expectedRevision);
            assert.equal(target.folding.getSnapshot().index.lineCount, document.buffer.lineCount);
            assert.equal(target.folding.getSnapshot().regions[0]!.to, undone ? 13 : 17);
        }
        assert.equal(view.getSnapshot().selection.head, undone ? 9 : 13); assert.equal(peer.getSnapshot().selection.head, document.buffer.length);
        assert.equal(view.folding.getSnapshot().regions[0]!.collapsed, false); assert.equal(peer.folding.getSnapshot().regions[0]!.collapsed, true);
        assert.equal(source.metadata.getSnapshot().dirty, origin === "canonical" ? undone : !undone);
    };
    const subscriptions = [source, model.observeDocument(source.id), model.observeHistory(source.id), view, view.folding, peer, peer.folding]
        .map(observable => observable.subscribe(inspect));
    try {
        const edits = [{ from: 9, to: 9, insert: "new\n" }];
        if (ticket) assert.equal(ticket.accept({ serverVersion: "saved", canonical: updated }).canonicalApplied, true);
        else if (origin === "proposal") assert.equal(model.edit({ documentId: source.id, expectedRevision: source.getSnapshot().revision, origin: "agent", history: { kind: "proposal" }, edits }).status, "done");
        else assert.equal(model.edit({ documentId: source.id, expectedRevision: 0, origin: "host", edits }).status, "done");
        expectedRevision = 2; assert.equal(model.undo({ documentId: source.id, expectedRevision: 1 }).status, "done");
        expectedRevision = 3; assert.equal(model.redo({ documentId: source.id, expectedRevision: 2 }).status, "done");
        assert.equal(notifications, 3); assert.deepEqual(errors, []);
    } finally {
        subscriptions.forEach(unsubscribe => unsubscribe()); ticket?.finish(); view.dispose(); peer.dispose();
        model.releaseResource(source.id, true);
        assert.equal(model.diagnostics().views, 0); assert.equal(model.diagnostics().leases, 0);
    }
});

test("boundary newline removal cannot publish crossing folds or interrupt an atomic text transaction", () => {
    const f = fixture(); try {
        const b = f.model.document(f.source.id).buffer;
        f.view.folding.setRanges(f.view.folding.getSnapshot(), [{ id: "left", from: 0, to: b.offsetAt(2), collapsed: true }, { id: "right", from: b.offsetAt(2), to: b.length, collapsed: true }]);
        const at = b.offsetAt(2); assert.equal(f.model.edit({ documentId: f.source.id, expectedRevision: 0, origin: "host", edits: [{ from: at - 2, to: at, insert: "" }] }).status, "done");
        assert.equal(f.text(), "header\r\nbody onebody two\r\nend"); assert.equal(f.view.getSnapshot().revision, 1); assert.equal(f.view.folding.getSnapshot().revision, 1);
        assert.equal(f.view.folding.getSnapshot().regions.length, 1); assert.equal(f.view.folding.getSnapshot().regions[0]!.collapsed, false);
        f.model.undo({ documentId: f.source.id, expectedRevision: 1 }); assert.equal(f.text(), "header\r\nbody one\r\nbody two\r\nend");
    } finally { f.finish(); }
});

test("mapped sparse folds agree with a naive row oracle across bounded structural edits and undo", () => {
    const model = new Workspace(), source = model.createTextResource({ scope: "fold", resource: "structural", variant: "working" }, "Source", { value: "header\r\nbody\n".repeat(60) + "end" });
    const view = model.createDocumentView(source.id); let seed = 5321;
    const next = (limit: number) => { seed = nextSeed(seed); return seed % limit; };
    const verify = () => {
        const document = model.document(source.id), snapshot = view.folding.getSnapshot(), index = snapshot.index;
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
    };
    try {
        for (let step = 0; step < 160; step++) {
            const before = model.document(source.id), b = before.buffer;
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
            model.edit({ documentId: source.id, expectedRevision: before.revision, origin: "host", edits: [{ from, to, insert }] }); verify();
            if (model.document(source.id).revision !== before.revision) {
                const after = model.document(source.id);
                // A fresh array exercises full remapping without the retained range metadata.
                const expected = revealSelectionFolds(after.buffer, mapFoldRegions(after.buffer, after.change!.mapping, [...prior], before.buffer), view.getSnapshot().selectionSet);
                assert.deepEqual(view.folding.getSnapshot().regions, expected, `full row-resolution oracle at step ${step}`);
            }
            if (step % 7 === 0 && model.document(source.id).revision !== before.revision) {
                model.undo({ documentId: source.id, expectedRevision: model.document(source.id).revision }); verify();
                const current = model.document(source.id).buffer; assert.equal(current.length, b.length); assert.equal(current.slice(0, current.length), b.slice(0, b.length));
            }
        }
    } finally { view.dispose(); model.releaseResource(source.id, true); }
});

test("fold updates reuse unchanged metadata and bound line lookups to changed endpoints", () => {
    const model = new Workspace(), source = model.createTextResource({ scope: "fold", resource: "reuse", variant: "working" }, "Source", { value: "header\nbody\n".repeat(2000) + "tail" });
    const view = model.createDocumentView(source.id), peer = model.createDocumentView(source.id);
    const lineAt = TextBuffer.prototype.lineAt; let reads = 0;
    const edit = (from: number, to: number, insert: string, grouped = false) => {
        const before = model.document(source.id); reads = 0;
        model.edit({ documentId: source.id, expectedRevision: before.revision, origin: "human", view,
            edits: [{ from, to, insert }], selection: { anchor: from + insert.length, head: from + insert.length },
            ...(grouped ? { history: { kind: "typing" as const, group: "fold-edges" } } : {}) });
        assert.ok(reads < 20, `line lookups must not scale with 2000 untouched regions: ${reads}`);
    };
    try {
        const original = model.document(source.id).buffer;
        const ranges = Array.from({ length: 2000 }, (_, i) => ({ id: `fold-${i}`, from: original.offsetAt(i * 2), to: original.offsetAt(i * 2 + 2), collapsed: true }));
        view.folding.setRanges(view.folding.getSnapshot(), ranges); peer.folding.setRanges(peer.folding.getSnapshot(), ranges);
        const first = view.folding.getSnapshot();
        TextBuffer.prototype.lineAt = function(offset) { reads++; return lineAt.call(this, offset); };
        edit(original.length, original.length, "x", true); edit(original.length + 1, original.length + 1, "y", true);
        assert.equal(view.folding.getSnapshot().regions, first.regions); assert.equal(view.folding.getSnapshot().index, first.index);
        reads = 0; model.undo({ documentId: source.id, expectedRevision: 2 }); assert.ok(reads < 20);
        assert.equal(view.folding.getSnapshot().regions, first.regions); assert.equal(model.document(source.id).buffer, original);
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
