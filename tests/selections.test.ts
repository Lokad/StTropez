import test from "node:test";
import { nextSeed } from "../fixtures/workloads.ts";
import assert from "node:assert/strict";
import { Workspace, TextBuffer, PositionMap, createSelectionSet, mapSelectionSet, planSelectionEdits } from "../src/index.ts";
import type { Selection, SelectionSet } from "../src/index.ts";

const endpoints = (set: SelectionSet) => set.ranges.map(range => [range.anchor, range.head]);

test("selection sets normalize overlaps, occupied carets and primary direction without merging adjacent ranges", () => {
    const raw = [{ anchor: 12, head: 9 }, { anchor: 2, head: 2 }, { anchor: 4, head: 1 },
        { anchor: 12, head: 15 }, { anchor: 20, head: 20 }, { anchor: 20, head: 20 }];
    const set = createSelectionSet(25, raw, 2);
    assert.deepEqual(endpoints(set), [[4, 1], [12, 9], [12, 15], [20, 20]]); assert.equal(set.primary, 0);
    assert.equal(set.ranges[0]!.anchorAffinity, "before"); assert.equal(set.ranges[0]!.headAffinity, "after");
    raw[2]!.anchor = 25; assert.equal(set.ranges[0]!.anchor, 4);
    assert.ok(Object.isFrozen(set)); assert.ok(Object.isFrozen(set.ranges)); assert.ok(set.ranges.every(Object.isFrozen));
    assert.strictEqual(createSelectionSet(25, set.ranges, set.primary), set);
    assert.strictEqual(createSelectionSet(30, set.ranges, set.primary), set);
    assert.throws(() => createSelectionSet(19, set.ranges, set.primary), RangeError);
    assert.throws(() => createSelectionSet(NaN, set.ranges, set.primary), RangeError);
    assert.equal(createSelectionSet(25, set.ranges, 1).primary, 1);
    const frozenInput = Object.freeze([Object.freeze({ anchor: 4, head: 1 }), Object.freeze({ anchor: 0, head: 0 })]);
    assert.deepEqual(endpoints(createSelectionSet(5, frozenInput)), [[0, 0], [4, 1]]);
    assert.deepEqual(endpoints(createSelectionSet(5, [{ anchor: 1, head: 1 }, { anchor: 1, head: 3 }], 0)), [[1, 3]]);
    assert.deepEqual(endpoints(createSelectionSet(5, [{ anchor: 0, head: 2 }, { anchor: 2, head: 4 }])), [[0, 2], [2, 4]]);
    for (const run of [() => createSelectionSet(-1, [{ anchor: 0, head: 0 }]), () => createSelectionSet(2, []),
        () => createSelectionSet(2, [{ anchor: 3, head: 0 }]), () => createSelectionSet(2, [{ anchor: 0, head: 0 }], 1)]) assert.throws(run, RangeError);
});

test("mapping coalesces deleted carets while retaining primary identity and individual affinities", () => {
    const before = createSelectionSet(12, [{ anchor: 3, head: 3 }, { anchor: 4, head: 4 },
        { anchor: 8, head: 10, anchorAffinity: "before", headAffinity: "before" }], 1);
    const map = new PositionMap(12, [{ from: 2, to: 5, insert: "X" }, { from: 8, to: 8, insert: "!" }]);
    const after = mapSelectionSet(map, before);
    assert.deepEqual(endpoints(after), [[3, 3], [6, 9]]); assert.equal(after.primary, 0);
    assert.equal(after.ranges[1]!.anchorAffinity, "before"); assert.equal(after.ranges[1]!.headAffinity, "before");
    assert.strictEqual(mapSelectionSet(new PositionMap(12, []), before), before);
    assert.deepEqual(endpoints(before), [[3, 3], [4, 4], [8, 10]]);
    // Different affinities inside one replacement can reverse the output order.
    const opposite = createSelectionSet(10, [
        { anchor: 3, head: 2, anchorAffinity: "after", headAffinity: "after" },
        { anchor: 4, head: 5, anchorAffinity: "before", headAffinity: "before" },
    ]);
    const replacement = new PositionMap(10, [{ from: 1, to: 7, insert: "abc" }]);
    const reordered = mapSelectionSet(replacement, opposite);
    assert.deepEqual(endpoints(reordered), [[1, 1], [4, 4]]); assert.equal(reordered.primary, 1);
    // Host mappings need only the existing point/range contract, and may use their receiver.
    const custom = { oldLength: replacement.oldLength, newLength: replacement.newLength,
        map(offset: number, affinity?: "before" | "after") { assert.equal(this.oldLength, 10); return replacement.map(offset, affinity); },
        mapRange: replacement.mapRange.bind(replacement), invert: replacement.invert.bind(replacement) };
    assert.deepEqual(mapSelectionSet(custom, opposite), reordered);
});

test("selection replacement plans preserve original coordinates, per-range text and resulting primary carets", () => {
    const buffer = TextBuffer.from("a😀bcdef"), set = createSelectionSet(buffer.length, [{ anchor: 7, head: 5 }, { anchor: 1, head: 3 }], 0);
    const plan = planSelectionEdits(buffer.length, set, ["XY", "!"]);
    assert.deepEqual(plan.edits, [{ from: 1, to: 3, insert: "XY" }, { from: 5, to: 7, insert: "!" }]);
    const result = buffer.apply(plan.edits).buffer;
    assert.equal(result.slice(0, result.length), "aXYbc!f"); assert.deepEqual(endpoints(plan.selectionSet), [[3, 3], [6, 6]]); assert.equal(plan.selectionSet.primary, 1);
    const adjacent = planSelectionEdits(4, createSelectionSet(4, [{ anchor: 0, head: 2 }, { anchor: 2, head: 4 }], 1), "");
    assert.deepEqual(endpoints(adjacent.selectionSet), [[0, 0]]); assert.equal(adjacent.selectionSet.primary, 0);
    assert.ok(Object.isFrozen(plan)); assert.ok(Object.isFrozen(plan.edits)); assert.ok(plan.edits.every(Object.isFrozen));
    assert.throws(() => planSelectionEdits(8, set, ["one"]), TypeError);
    assert.throws(() => planSelectionEdits(8, { ranges: [{ anchor: 7, head: 7 }, { anchor: 1, head: 1 }], primary: 0 }, "x"), RangeError);
    assert.equal(buffer.readMetrics().textExports, 0);
});

test("atomic multi-range typing groups shared undo and maps independent retained views without exporting", () => {
    const workspace = new Workspace(), source = workspace.createTextResource({ scope: "multi", resource: "source", variant: "working" }, "Source", { value: "alpha beta gamma" });
    const document = () => workspace.document(source.documentId), primary = workspace.createDocumentView(source.documentId,
        createSelectionSet(16, [{ anchor: 0, head: 5 }, { anchor: 16, head: 11 }], 1));
    const secondary = workspace.createDocumentView(source.documentId, createSelectionSet(16, [{ anchor: 6, head: 10 }, { anchor: 5, head: 5 }], 0));
    const before = primary.getSnapshot().selectionSet, otherBefore = secondary.getSnapshot().selectionSet;
    const deliveries: { state: ReturnType<typeof primary.getSnapshot>; revision: number; length: number }[] = [];
    const stop = primary.subscribe(() => { deliveries.push({ state: primary.getSnapshot(), revision: document().revision, length: document().buffer.length }); });
    const edit = (insert: string) => { const current = document(), plan = planSelectionEdits(current.buffer.length, primary.getSnapshot().selectionSet, insert);
        return workspace.edit({ documentId: source.documentId, expectedRevision: current.revision, origin: "human", view: primary, ...plan, history: { kind: "typing", group: "continuous" } }); };
    assert.equal(edit("X").applied, true); assert.deepEqual(endpoints(secondary.getSnapshot().selectionSet), [[1, 1], [2, 6]]);
    assert.equal(edit("Y").applied, true); assert.equal(deliveries.length, 2);
    assert.equal(document().buffer.slice(0, document().buffer.length), "XY beta XY"); assert.deepEqual(endpoints(primary.getSnapshot().selectionSet), [[2, 2], [10, 10]]);
    assert.equal(primary.getSnapshot().selectionSet.primary, 1); assert.equal(workspace.observeHistory(source.documentId).getSnapshot().undoDepth, 1);
    assert.equal(source.metadata.getSnapshot().dirty, true);
    assert.equal(workspace.undo({ documentId: source.documentId, expectedRevision: document().revision }).applied, true);
    assert.equal(document().buffer.slice(0, 16), "alpha beta gamma"); assert.deepEqual(primary.getSnapshot().selectionSet, before); assert.deepEqual(secondary.getSnapshot().selectionSet, otherBefore);
    assert.equal(source.metadata.getSnapshot().dirty, false);
    assert.equal(workspace.redo({ documentId: source.documentId, expectedRevision: document().revision }).applied, true);
    assert.deepEqual(endpoints(primary.getSnapshot().selectionSet), [[2, 2], [10, 10]]);
    assert.equal(primary.setSelections(0, [{ anchor: 0, head: 0 }]), false);
    for (const { state, revision, length } of deliveries) {
        assert.equal(state.revision, revision); assert.strictEqual(state.selection, state.selectionSet.ranges[state.selectionSet.primary]);
        assert.ok(state.selectionSet.ranges.every(range => range.head <= length));
    }
    const releasedRevision = document().revision; assert.equal(document().buffer.readMetrics().textExports, 0);
    stop(); primary.dispose(); secondary.dispose(); workspace.releaseResource(source.id, true);
    assert.equal(primary.setSelections(releasedRevision, [{ anchor: 0, head: 0 }]), false);
});

test("invalid, stale and unauthorized multi-range results cannot partially publish a document batch", () => {
    const workspace = new Workspace(), first = workspace.createTextResource({ scope: "multi", resource: "a", variant: "working" }, "A", { value: "abcd" }),
        second = workspace.createTextResource({ scope: "multi", resource: "b", variant: "working" }, "B", { value: "wxyz" });
    const a = workspace.createDocumentView(first.documentId), b = workspace.createDocumentView(second.documentId), snapshot = workspace.getSnapshot(), view = a.getSnapshot();
    const request = { documentId: first.documentId, expectedRevision: 0, origin: "human" as const, view: a, edits: [{ from: 0, to: 1, insert: "A" }] };
    assert.throws(() => workspace.editDocuments([request, { ...request, documentId: second.documentId, view: b, selectionSet: { ranges: [{ anchor: 8, head: 8 }], primary: 0 } }]), RangeError);
    assert.strictEqual(workspace.getSnapshot(), snapshot); assert.strictEqual(a.getSnapshot(), view);
    assert.equal(workspace.observeHistory(first.documentId).getSnapshot().undoDepth, 0);
    assert.throws(() => workspace.edit({ ...request, view: b, selectionSet: createSelectionSet(4, [{ anchor: 1, head: 1 }]) }));
    assert.throws(() => workspace.edit({ ...request, selection: { anchor: 0, head: 0 }, selectionSet: createSelectionSet(4, [{ anchor: 1, head: 1 }]) }));
    assert.deepEqual(workspace.edit({ ...request, expectedRevision: 1 }), { applied: false, reason: "stale-revision" });
    workspace.setCapabilities(first.id, { edit: ["host"], save: true, run: true });
    const locked = workspace.getSnapshot(); assert.deepEqual(workspace.edit(request), { applied: false, reason: "read-only" }); assert.strictEqual(workspace.getSnapshot(), locked);
    a.dispose(); b.dispose(); workspace.releaseResource(first.id, true); workspace.releaseResource(second.id, true);
});

test("selection-only changes seal their own typing group even when another batch participant changes text", () => {
    const workspace = new Workspace(), a = workspace.createTextResource({ scope: "multi", resource: "a", variant: "working" }, "A", { value: "abcd" }),
        b = workspace.createTextResource({ scope: "multi", resource: "b", variant: "working" }, "B", { value: "other" });
    const view = workspace.createDocumentView(a.documentId, createSelectionSet(4, [{ anchor: 0, head: 0 }, { anchor: 4, head: 4 }], 1));
    const type = (insert: string) => { const current = workspace.document(a.documentId), plan = planSelectionEdits(current.buffer.length, view.getSnapshot().selectionSet, insert);
        workspace.edit({ documentId: a.documentId, expectedRevision: current.revision, origin: "human", view, ...plan, history: { kind: "typing", group: "same" } }); };
    type("X"); const unchanged = view.getSnapshot();
    assert.equal(view.setSelections(1, unchanged.selectionSet.ranges, unchanged.selectionSet.primary), true); assert.strictEqual(view.getSnapshot(), unchanged);
    const selections = createSelectionSet(6, [{ anchor: 1, head: 1 }, { anchor: 3, head: 3 }, { anchor: 6, head: 6 }], 2);
    workspace.editDocuments([{ documentId: a.documentId, expectedRevision: 1, origin: "human", view, selectionSet: selections, edits: [] },
        { documentId: b.documentId, expectedRevision: 0, origin: "human", edits: [{ from: 0, to: 0, insert: "!" }] }]);
    type("Y"); assert.equal(workspace.observeHistory(a.documentId).getSnapshot().undoDepth, 2);
    workspace.undo({ documentId: a.documentId, expectedRevision: 2 }); assert.deepEqual(view.getSnapshot().selectionSet, selections);
    view.setSelection(workspace.document(a.documentId).revision, view.getSnapshot().selection);
    assert.equal(view.getSnapshot().selectionSet.ranges.length, 1);
    view.dispose(); workspace.releaseResource(a.id, true); workspace.releaseResource(b.id, true);
});

test("history bounds include captured selection ranges independently of changed text units", () => {
    const workspace = new Workspace({ history: { maxSelectionRanges: 4 } }), source = workspace.createTextResource({ scope: "multi", resource: "limited", variant: "working" }, "Source", { value: "abc" });
    const view = workspace.createDocumentView(source.documentId, createSelectionSet(3, [{ anchor: 0, head: 0 }, { anchor: 3, head: 3 }]));
    const type = () => { const current = workspace.document(source.documentId), plan = planSelectionEdits(current.buffer.length, view.getSnapshot().selectionSet, "x");
        workspace.edit({ documentId: source.documentId, expectedRevision: current.revision, origin: "human", view, ...plan }); };
    type(); assert.equal(workspace.observeHistory(source.documentId).getSnapshot().undoDepth, 1);
    view.setSelections(1, [{ anchor: 0, head: 0 }, { anchor: 2, head: 2 }, { anchor: 5, head: 5 }]);
    type(); assert.equal(workspace.observeHistory(source.documentId).getSnapshot().undoDepth, 0);
    assert.throws(() => new Workspace({ history: { maxSelectionRanges: -1 } }), RangeError);
    view.dispose(); workspace.releaseResource(source.id, true);
    const bounded = new Workspace({ history: { maxSelectionRanges: 6 } }), other = bounded.createTextResource({ scope: "multi", resource: "trim", variant: "working" }, "Source", { value: "abc" });
    const retained = bounded.createDocumentView(other.documentId, createSelectionSet(3, [{ anchor: 0, head: 0 }, { anchor: 3, head: 3 }]));
    const append = (text: string) => { const d = bounded.document(other.documentId), plan = planSelectionEdits(d.buffer.length, retained.getSnapshot().selectionSet, text);
        bounded.edit({ documentId: other.documentId, expectedRevision: d.revision, origin: "human", view: retained, ...plan }); };
    append("X"); retained.setSelection(1, retained.getSnapshot().selection); append("Y");
    assert.equal(bounded.observeHistory(other.documentId).getSnapshot().undoDepth, 2);
    append("Z"); assert.equal(bounded.observeHistory(other.documentId).getSnapshot().undoDepth, 2);
    bounded.undo({ documentId: other.documentId, expectedRevision: 3 }); bounded.undo({ documentId: other.documentId, expectedRevision: 4 });
    assert.equal(bounded.document(other.documentId).buffer.slice(0, 5), "XabcX");
    retained.dispose(); bounded.releaseResource(other.id, true);
});

test("seeded selection replacements and shared history match an independent string oracle", () => {
    const workspace = new Workspace(), source = workspace.createTextResource({ scope: "multi", resource: "oracle", variant: "working" }, "Source", { value: "a😀\r\nβcdef".repeat(4) });
    const view = workspace.createDocumentView(source.documentId), states: { before: string; after: string; beforeSet: SelectionSet; afterSet: SelectionSet }[] = [];
    let text = "a😀\r\nβcdef".repeat(4), seed = 0x517ab;
    const next = () => (seed = nextSeed(seed));
    for (let step = 0; step < 40; step++) {
        const ranges: Selection[] = Array.from({ length: 1 + next() % 5 }, () => { const anchor = next() % (text.length + 1), head = Math.min(text.length, anchor + next() % 4);
            return next() % 2 ? { anchor, head } : { anchor: head, head: anchor }; });
        const current = workspace.document(source.documentId); view.setSelections(current.revision, ranges, next() % ranges.length);
        const beforeSet = view.getSnapshot().selectionSet, insert = String.fromCharCode(0xe000 + step), plan = planSelectionEdits(text.length, beforeSet, insert);
        let expected = text; for (const range of [...beforeSet.ranges].reverse()) { const from = Math.min(range.anchor, range.head), to = Math.max(range.anchor, range.head); expected = expected.slice(0, from) + insert + expected.slice(to); }
        assert.equal(workspace.edit({ documentId: source.documentId, expectedRevision: current.revision, origin: "human", view, ...plan }).applied, true);
        assert.equal(workspace.document(source.documentId).buffer.slice(0, expected.length), expected);
        const afterSet = view.getSnapshot().selectionSet; states.push({ before: text, after: expected, beforeSet, afterSet }); text = expected;
    }
    for (const state of [...states].reverse()) {
        workspace.undo({ documentId: source.documentId, expectedRevision: workspace.document(source.documentId).revision });
        assert.equal(workspace.document(source.documentId).buffer.slice(0, state.before.length), state.before); assert.deepEqual(view.getSnapshot().selectionSet, state.beforeSet);
    }
    for (const state of states) {
        workspace.redo({ documentId: source.documentId, expectedRevision: workspace.document(source.documentId).revision });
        assert.equal(workspace.document(source.documentId).buffer.slice(0, state.after.length), state.after); assert.deepEqual(view.getSnapshot().selectionSet, state.afterSet);
    }
    assert.equal(workspace.document(source.documentId).buffer.readMetrics().textExports, 0);
    view.dispose(); workspace.releaseResource(source.id, true);
});
