import { editorState } from "./helpers/editor-state.ts";
import test from "node:test";
import { nextSeed } from "../fixtures/workloads.ts";
import assert from "node:assert/strict";
import { TextBuffer, Workspace } from "../src/index.ts";
import { LiteralSearch } from "../src/core/search.ts";
import { unchangedPositionEdges } from "../src/core/positions.ts";
import { FindIndex } from "../src/core/find-index.ts";
import { LiteralFindRepair } from "../src/browser/find-index.ts";
import { findForView } from "../src/browser/find.ts";
import type { FindHost } from "../src/browser/find.ts";

const options = { matchCase: true, wholeWord: false };
function scan(buffer: TextBuffer, query: string, settings = options) {
    const cursor = new LiteralSearch(buffer, query, { ...settings, lineEndings: "equivalent" }), index = new FindIndex(); let reads = 0;
    for (;;) { const step = cursor.next(); reads += step.readUnits; step.matches.forEach(m => index.append(m)); if (step.done) break; }
    cursor.dispose(); return { index, reads };
}
function finish(repair: LiteralFindRepair, units = 4096, matches = 64) {
    let reads = 0;
    for (let turns = 0;; turns++) { assert.ok(turns < 100000); const step = repair.next(units, matches); reads += step.readUnits; if (step.done) break; }
    repair.dispose(); return reads;
}
const all = (index: FindIndex) => Array.from({ length: index.count }, (_, i) => index.at(i));

test("find index slices keep captured pages immutable through shifts, appends and repeated joins", () => {
    const original = new FindIndex(); for (let i = 0; i < 5000; i++) original.append({ from: i * 4, to: i * 4 + 2 });
    const captured = all(original), ranges = original.matchesIn(0, 800); let index = original;
    for (let turn = 0; turn < 40; turn++) {
        const next = new FindIndex(); next.appendRange(index, 0, 2049); next.appendRange(index, 2049, index.count, 1);
        next.append({ from: 30000 + turn * 4, to: 30002 + turn * 4 }); index = next;
    }
    original.append({ from: 40000, to: 40002 });
    assert.deepEqual(all(original).slice(0, 5000), captured); assert.equal(index.count, 5040);
    assert.deepEqual(index.at(2048), captured[2048]); assert.deepEqual(index.at(2049), { from: 8236, to: 8238 });
    assert.equal(index.lowerBound(8236), 2049); assert.equal(index.lowerBound(8237), 2050);
    assert.equal(index.at(5039).from, 30156); assert.deepEqual(ranges, captured.slice(0, 200));
    assert.ok(Object.isFrozen(ranges) && ranges.every(Object.isFrozen)); assert.throws(() => index.at(index.count), RangeError);
});

test("range queries include crossing matches and UTF-16 point boundaries across shared pages", () => {
    const index = new FindIndex(), expected: { from: number; to: number }[] = [];
    for (let i = 0; i < 5000; i++) {
        const from = i * 5;
        for (const match of [{ from, to: from }, { from, to: from + 4 }]) { expected.push(match); index.append(match); }
    }
    const shifted = new FindIndex(); shifted.appendRange(index, 0, index.count, 3);
    const values = expected.map(m => ({ from: m.from + 3, to: m.to + 3 }));
    for (let from = 0; from <= 25004; from += 7) for (const width of [0, 1, 13]) {
        const to = from + width;
        assert.deepEqual(shifted.matchesIn(from, to), values.filter(m => m.from === m.to
            ? m.from >= from && (from === to ? m.from === to : m.from < to)
            : from < to && m.from < to && m.to > from));
    }
    const unicode = scan(TextBuffer.from("a𐐀𐐨z"), "𐐀", { matchCase: false, wholeWord: false }).index;
    assert.deepEqual(unicode.matchesIn(2, 4), [{ from: 1, to: 3 }, { from: 3, to: 5 }]);
    assert.deepEqual(unicode.matchesIn(3, 3), []);
    for (const [from, to] of [[-1, 0], [2, 1], [0, Infinity], [0.5, 1]]) assert.throws(() => index.matchesIn(from!, to!), RangeError);
});

test("local literal repair reuses a large suffix but repeated-pattern phase changes scan to the end", t => {
    const text = "const sample = 1;\n".repeat(20000), before = TextBuffer.from(text), base = scan(before, "sample"), from = text.length / 2 + 6;
    const buffer = before.replace(from, from + 6, "other"), repair = new LiteralFindRepair(buffer, "sample", options, base.index, before.length,
        { prefix: from, suffix: before.length - from - 6 });
    const retainedPrefixMatches = repair.index.count; assert.ok(retainedPrefixMatches > 9000); const reads = finish(repair);
    assert.deepEqual(all(repair.index), all(scan(buffer, "sample").index)); assert.ok(reads < 4096); assert.ok(base.reads >= before.length);
    const repeated = TextBuffer.from("a".repeat(20000)), old = scan(repeated, "aa").index, changed = repeated.replace(10000, 10000, "a");
    const parity = new LiteralFindRepair(changed, "aa", options, old, repeated.length, { prefix: 10000, suffix: 10000 });
    const fallbackReads = finish(parity); assert.ok(fallbackReads >= 10000);
    assert.deepEqual(all(parity.index), all(scan(changed, "aa").index));
    t.diagnostic(JSON.stringify({ sourceUnits: before.length, fullReadUnits: base.reads, repairReadUnits: reads, retainedPrefixMatches, repeatedFallbackReadUnits: fallbackReads }));
});

test("literal repair agrees with fresh search across batches, raw surrogate seams, case and word boundaries", () => {
    let seed = 0x51a710;
    const random = (n: number) => { seed = nextSeed(seed); return (seed >>> 8) % n; };
    const alphabet = ["a", "b", " ", "K", "k", "𐐀", "𐐨", "\ud801", "\udc00", "\n", "\u0301", "\u200c", "_", "\r"];
    const text = (n: number) => Array.from({ length: n }, () => alphabet[random(alphabet.length)]!).join("");
    const workspace = new Workspace(), documentId = workspace.createDocument({ scope: "find", resource: "differential", variant: "working" }, "Source", "");
    for (let trial = 0; trial < 2000; trial++) {
        const original = text(20 + random(100));
        workspace.edit({ documentId, expectedRevision: workspace.document(documentId).revision, origin: "human", edits: [{ from: 0, to: workspace.document(documentId).buffer.length, insert: original }] });
        const before = workspace.document(documentId), query = trial % 3 ? text(1 + random(4)) : original.slice(random(original.length - 3), original.length).slice(0, 3);
        const settings = { wholeWord: !!(trial & 1), matchCase: !!(trial & 2) }, old = scan(before.buffer, query, settings).index;
        const a = random(Math.floor(original.length / 2)), b = a + random(Math.floor(original.length / 2) - a + 1);
        const c = Math.floor(original.length / 2) + 1 + random(original.length - Math.floor(original.length / 2)), d = c + random(original.length - c + 1);
        workspace.edit({ documentId, expectedRevision: before.revision, origin: "human", edits: [{ from: a, to: b, insert: text(random(8)) }, { from: c, to: d, insert: text(random(8)) }] });
        const current = workspace.document(documentId);
        if (current.revision === before.revision) continue;
        const proof = unchangedPositionEdges(current.change!.mapping)!;
        const repair = new LiteralFindRepair(current.buffer, query, settings, old, before.buffer.length, proof);
        finish(repair, 1 + random(19), 1 + random(4));
        assert.deepEqual(all(repair.index), all(scan(current.buffer, query, settings).index), `batch ${trial}`);
        workspace.undo({ documentId, expectedRevision: current.revision });
        const undone = workspace.document(documentId), inverse = new LiteralFindRepair(undone.buffer, query, settings, repair.index, current.buffer.length, unchangedPositionEdges(undone.change!.mapping)!);
        finish(inverse, 1 + random(19), 1 + random(4)); assert.deepEqual(all(inverse.index), all(old), `undo ${trial}`);
    }
});

test("caseless repair cannot expose a clipped surrogate as a new literal match", () => {
    const before = TextBuffer.from("xx𐐀xxxx"), buffer = before.replace(7, 7, "!"), settings = { matchCase: false, wholeWord: false };
    const repair = new LiteralFindRepair(buffer, "\udc00", settings, scan(before, "\udc00", settings).index, before.length, { prefix: 7, suffix: 1 });
    finish(repair, 1, 1); assert.deepEqual(all(repair.index), all(scan(buffer, "\udc00", settings).index));
});

function fixture(text: string, clock: Pick<Performance, "now"> = performance) {
    const errors: unknown[] = [], workspace = new Workspace({ onListenerError: error => errors.push(error) });
    const documentId = workspace.createDocument({ scope: "find", resource: "retention", variant: "working" }, "Source", text);
    const tab = workspace.tabs.open({ kind: "text", documentId }, "left"), view = workspace.createDocumentView(documentId), tasks = new Map<number, () => void>(); let serial = 0;
    const owner = Object.assign(new EventTarget(), { defaultView: { performance: clock,
        setTimeout: (work: () => void) => { tasks.set(++serial, work); return serial; }, clearTimeout: (id: number) => tasks.delete(id) } });
    const editor = { view, element: { ownerDocument: owner }, ...editorState(), activity: () => ({ composing: false, disposed: false }), viewport: { revealRange: () => {} }, focus: () => {} } satisfies FindHost;
    const find = findForView(workspace, workspace.tabs.capture(tab), editor), document = () => workspace.document(documentId);
    const step = () => { const entry = tasks.entries().next().value; assert.ok(entry); tasks.delete(entry[0]); entry[1](); };
    const drain = () => { for (let turns = 0; tasks.size; turns++) { assert.ok(turns < 1000); step(); } assert.deepEqual(errors, []); };
    const edit = (from: number, to: number, insert: string) => { assert.equal(workspace.edit({ documentId, expectedRevision: document().revision, origin: "human", edits: [{ from, to, insert }], history: { kind: "replace" } }).applied, true); };
    const select = (anchor: number, head = anchor) => view.setSelection(document().revision, { anchor, head });
    const dispose = () => { find.dispose(); view.dispose(); workspace.tabs.close(tab); assert.equal(tasks.size, 0); assert.equal(workspace.diagnostics().leases, 0); assert.equal(workspace.diagnostics().subscriptions, 0); };
    return { workspace, documentId, view, find, document, tasks, step, drain, edit, select, dispose };
}

test("Replace reveals an unseen match first and Undo restores a previewed match as the selection", () => {
    const f = fixture("before\na cat\nafter");
    try {
        const original = f.document();
        f.find.setQuery("cat"); f.drain();
        assert.ok(f.find.replaceCurrent("dog"));
        assert.equal(f.document(), original);
        assert.equal(f.view.getSnapshot().selection.anchor, 9);
        assert.equal(f.view.getSnapshot().selection.head, 12);
        assert.ok(f.find.replaceCurrent("dog")); f.drain();
        assert.equal(f.document().text(), "before\na dog\nafter");

        f.select(0);
        f.find.setQuery("dog", { preview: true }); f.drain();
        assert.equal(f.view.getSnapshot().selection.head, 0);
        assert.ok(f.find.replaceCurrent("mouse")); f.drain();
        assert.ok(f.workspace.undo({ documentId: f.documentId, expectedRevision: f.document().revision }).applied);
        const { anchor, head } = f.view.getSnapshot().selection;
        assert.equal(f.document().buffer.slice(anchor, head), "dog");
    } finally { f.dispose(); }
});

test("multiline Find repairs mixed endings and replaces a manually selected overlap in its original coordinates", () => {
    const f = fixture("a\r\na\r\na\r\na");
    try {
        f.find.setQuery("a\na"); f.drain(); assert.equal(f.find.getSnapshot().count, 2);
        f.select(3, 7); assert.equal(f.find.replaceCurrent("b"), true); f.drain();
        assert.equal(f.document().text(), "a\r\nb\r\na"); assert.equal(f.find.getSnapshot().count, 0);
        f.edit(3, 4, "a"); f.drain();
        assert.deepEqual(f.find.matchesIn(0, f.document().buffer.length), [{ from: 0, to: 4 }]);
        f.edit(1, 2, ""); f.drain();
        assert.deepEqual(f.find.matchesIn(0, f.document().buffer.length), [{ from: 0, to: 3 }]);
    } finally { f.dispose(); }
});

test("preview keeps the selection, replacement advances, and edits cancel a pending preview", () => {
    const f = fixture("a cat, a cat, a cat");
    try {
        f.select(8);
        const selected = f.view.getSnapshot().selectionSet;
        f.find.setQuery("cat", { preview: true }); f.drain();
        assert.equal(f.find.getSnapshot().current, 1); assert.equal(f.view.getSnapshot().selectionSet, selected);
        f.find.setFlags({ wholeWord: true }); f.drain();
        assert.equal(f.find.getSnapshot().current, 1); assert.equal(f.view.getSnapshot().selectionSet, selected);
        assert.equal(f.find.replaceCurrent("dog"), true); f.drain();
        assert.equal(f.document().text(), "a cat, a dog, a cat");
        assert.equal(f.find.getSnapshot().current, 1); assert.equal(f.find.getSnapshot().wrappedTo, null);
        assert.equal(f.find.next(), true); assert.equal(f.find.getSnapshot().wrappedTo, "start");
        assert.equal(f.find.next(-1), true); assert.equal(f.find.getSnapshot().wrappedTo, "end");
        f.find.setQuery("dog", { preview: true }); f.edit(0, 0, "a "); f.drain();
        assert.equal(f.find.getSnapshot().count, 1); assert.equal(f.find.getSnapshot().current, null);
        f.find.setQuery("cat", { preview: true }); f.select(0); f.drain();
        assert.equal(f.find.getSnapshot().current, null); assert.equal(f.find.getSnapshot().wrappedTo, null);
        assert.equal(f.find.acceptPreview(), false);
        f.find.setQuery("dog", { preview: true }); f.drain(); f.select(1);
        assert.equal(f.find.acceptPreview(), false, "dismissing an old preview preserves a newer selection");
        f.find.setQuery("dog", { preview: true });
        assert.equal(f.find.acceptPreview(), false, "closing before discovery cannot schedule a later selection");
        f.drain(); assert.equal(f.find.acceptPreview(), true); assert.equal(f.find.acceptPreview(), false);
        const { anchor, head } = f.view.getSnapshot().selection;
        assert.equal(f.document().buffer.slice(anchor, head), "dog");
    } finally { f.dispose(); }
});

test("refining a query follows the last Find selection at the same start", () => {
    const f = fixture("quantities, quantity, quantity");
    const query = (value: string) => f.find.setQuery(value, { preview: true });
    const range = () => [f.view.getSnapshot().selection.anchor, f.view.getSnapshot().selection.head];
    try {
        f.select(11); query("quan"); f.drain(); f.find.next();
        assert.deepEqual(range(), [12, 16]);
        query("quant"); query("quanti"); query("quantity"); f.drain();
        assert.deepEqual(range(), [12, 20]); assert.equal(f.find.getSnapshot().current, 0);
        assert.equal(f.find.next(), true); assert.deepEqual(range(), [22, 30]);
        query("quan"); f.drain(); assert.deepEqual(range(), [22, 26]);
        query("quantities"); f.drain();
        assert.deepEqual(range(), [22, 26]); assert.equal(f.find.getSnapshot().current, 0);
        assert.equal(f.find.acceptPreview(), true); assert.deepEqual(range(), [0, 10]);
        query("quan"); f.select(12, 16); f.drain();
        assert.deepEqual(range(), [12, 16]); assert.equal(f.find.getSnapshot().current, 1);
        assert.equal(f.find.acceptPreview(), false);
        f.select(13); assert.equal(f.find.getSnapshot().current, 1);
        f.select(11); assert.equal(f.find.getSnapshot().current, null);
        f.select(12, 16);
        query("quantity"); f.drain(); assert.deepEqual(range(), [12, 16]);
    } finally { f.dispose(); }
});

test("deferred Find follows the latest direction until the selection, query or visible folds change", () => {
    const f = fixture("cat\ndog\ncat");
    try {
        f.find.setQuery("cat");
        assert.equal(f.find.next(1, { whenReady: true }), true);
        assert.equal(f.find.next(-1, { whenReady: true }), true);
        f.drain(); assert.equal(f.find.getSnapshot().current, 1);
        f.find.setQuery("dog"); f.find.next(1, { whenReady: true });
        f.select(2); f.drain(); assert.equal(f.view.getSnapshot().selection.head, 2);
        f.find.setQuery("cat"); f.find.next(1, { whenReady: true });
        f.find.setQuery("dog"); f.drain(); assert.equal(f.find.getSnapshot().current, null);
        const folds = f.view.folding;
        f.select(0); f.find.setQuery("dog"); f.find.next(1, { whenReady: true });
        folds.setRanges(folds.getSnapshot(), [{ id: "block", from: 0, to: 8, collapsed: false }]);
        f.drain(); assert.equal(f.view.getSnapshot().selection.anchor, 4, "new expanded fold metadata preserves a pending command");
        for (const preview of [true, false]) {
            f.select(0); f.find.setQuery("dog", { preview });
            if (!preview) f.find.next(1, { whenReady: true });
            folds.setCollapsed(folds.getSnapshot(), ["block"], true);
            folds.setCollapsed(folds.getSnapshot(), ["block"], false);
            f.drain(); assert.equal(f.find.getSnapshot().current, null); assert.equal(f.view.getSnapshot().selection.head, 0);
        }
        assert.equal(f.find.next(), true); assert.equal(f.view.getSnapshot().selection.head, 7);
        f.select(0, 3); f.find.setQuery("cat"); f.drain();
        assert.equal(f.find.replaceCurrent("kitten"), true);
        folds.setCollapsed(folds.getSnapshot(), ["block"], true);
        f.drain(); assert.equal(f.view.getSnapshot().selection.head, 6, "a fold keeps the caret after the replacement");
    } finally { f.dispose(); }
});

test("literal tasks bound advances and elapsed work, publish once and preserve repair and cancellation", () => {
    const original = LiteralSearch.prototype.next;
    for (const cost of [0, 1]) {
        let time = 0; const calls: { units: number; matches: number; read: number }[] = [];
        LiteralSearch.prototype.next = function(units = 32768, matches = 8192) {
            const result = original.call(this, units, matches); time += cost; calls.push({ units, matches, read: result.readUnits }); return result;
        };
        const f = fixture("cat ".repeat(100000), { now: () => time }); let publications = 0;
        const stop = f.find.subscribe(() => publications++);
        try {
            f.find.setFlags({ wholeWord: true }); f.find.setQuery("cat"); const before = publications; f.step();
            assert.equal(calls.length, cost ? 4 : 32); assert.ok(calls.every(call => call.units === 4096 && call.matches === 1024 && call.read <= 4096));
            assert.equal(publications, before + 1); assert.equal(f.find.getSnapshot().status, "searching"); assert.equal(f.tasks.size, 1);
            assert.equal(f.find.getDiagnostics().maxScanStepMs, cost);
            const obsolete = [...f.tasks.values()][0]!, advanced = calls.length;
            f.find.setQuery("dog"); const replacement = [...f.tasks]; obsolete();
            assert.deepEqual([...f.tasks], replacement); assert.equal(calls.length, advanced); assert.equal(f.find.getSnapshot().count, 0);
            f.find.setQuery("cat"); f.drain(); assert.equal(f.find.getSnapshot().count, 100000);
            calls.length = 0; f.edit(40000, 40003, "dog"); assert.equal(f.find.getSnapshot().retained, true);
            f.step(); assert.equal(calls[0]!.units, 4096); assert.equal(calls[0]!.matches, 64);
            f.drain(); assert.equal(f.find.getSnapshot().count, 99999); assert.equal(f.find.getSnapshot().status, "ready");
            assert.equal(f.document().buffer.readMetrics().textExports, 0);
        } finally { stop(); f.dispose(); LiteralSearch.prototype.next = original; }
    }
});

test("confirmed matches remain navigable and replaceable during repair without wrapping over unknown matches", () => {
    const f = fixture("cat ".repeat(20000));
    try {
        f.find.setQuery("cat"); f.drain(); const previous = f.find.matchesIn(0, f.document().buffer.length);
        f.edit(40000, 40003, "dog"); const state = f.find.getSnapshot();
        assert.equal(state.status, "searching"); assert.equal(state.retained, true); assert.ok(state.count > 9000); assert.deepEqual(f.find.matchesIn(0, 400), previous.filter(m => m.from < 400));
        f.select(0); assert.equal(f.find.next(-1), false); assert.equal(f.find.next(), true); assert.equal(f.view.getSnapshot().selection.anchor, 0); assert.equal(f.view.getSnapshot().selection.head, 3);
        f.select(60000); assert.equal(f.find.next(-1), false); assert.equal(f.find.next(), false);
        const revision = f.document().revision; f.find.replaceAll("wrong"); assert.equal(f.document().revision, revision);
        f.select(4, 7); assert.equal(f.find.replaceCurrent("kitten"), true); assert.equal(f.find.getSnapshot().retained, true);
        f.drain(); assert.equal(f.find.getSnapshot().count, 19998); assert.equal(f.find.getSnapshot().status, "ready");
        assert.deepEqual(f.find.matchesIn(0, f.document().buffer.length), all(scan(f.document().buffer, "cat").index));
        f.workspace.undo({ documentId: f.documentId, expectedRevision: f.document().revision }); f.drain(); assert.equal(f.find.getSnapshot().count, 19999);
        f.workspace.undo({ documentId: f.documentId, expectedRevision: f.document().revision }); f.drain(); assert.equal(f.find.getSnapshot().count, 20000);
        f.workspace.redo({ documentId: f.documentId, expectedRevision: f.document().revision }); f.drain(); assert.equal(f.find.getSnapshot().count, 19999);
        f.edit(60000, 60003, "dog"); f.select(4, 7);
        const history = f.workspace.observeHistory(f.documentId).getSnapshot();
        assert.equal(f.find.replaceCurrent("cat"), true);
        assert.equal(f.find.getSnapshot().status, "searching"); assert.equal(f.find.getSnapshot().retained, true);
        f.drain(); assert.equal(f.find.getSnapshot().status, "ready"); assert.equal(f.find.getSnapshot().count, 19998);
        assert.equal(f.find.getSnapshot().reason, "replaced");
        assert.deepEqual(f.workspace.observeHistory(f.documentId).getSnapshot(), history);
    } finally { f.dispose(); }
});

test("an edit inside a long row keeps later literal matches usable without navigating across unverified text", async () => {
    const source = "cat\r\npadding\r\ncat" + ".".repeat(6000) + "\r\ncat cat", f = fixture(source);
    try {
        f.find.setQuery("cat"); f.drain();
        const edited = source.indexOf("cat", 3), replacement = "dog cat cat cat";
        f.edit(edited, edited + 3, replacement);
        await Promise.resolve(); // The bounded first advance cannot reach the next row.
        const last = f.document().buffer.length, suffix = last - 7;
        assert.equal(f.find.getSnapshot().status, "searching");
        assert.deepEqual(f.find.matchesIn(0, last), [{ from: 0, to: 3 }, { from: suffix, to: suffix + 3 }, { from: last - 3, to: last }]);
        f.select(edited, edited + 3); assert.equal(f.find.replaceCurrent("wrong"), false);
        f.find.replaceAll("wrong"); assert.equal(f.document().buffer.slice(edited, edited + 3), "dog");
        f.select(3); assert.equal(f.find.next(), false);
        f.select(suffix); assert.equal(f.find.next(-1), false); assert.equal(f.find.next(), true);
        assert.equal(f.find.getSnapshot().current, 1);
        f.drain(); assert.equal(f.find.getSnapshot().count, 6); assert.equal(f.find.getSnapshot().current, 4);
        assert.equal(f.find.replaceCurrent("last"), true); f.drain();
        assert.equal(f.document().buffer.slice(suffix, f.document().buffer.length), "last cat");
    } finally { f.dispose(); }
});

test("rapid edits accumulate safe bounds and undo to the completed capture reuses it immediately", () => {
    const f = fixture("K k cat\n".repeat(2000));
    try {
        f.find.setFlags({ matchCase: false, wholeWord: true }); f.find.setQuery("k"); f.drain();
        const original = f.document().buffer, ranges = f.find.matchesIn(0, f.document().buffer.length);
        f.edit(8000, 8001, "x"); f.workspace.undo({ documentId: f.documentId, expectedRevision: f.document().revision });
        assert.equal(f.document().buffer, original); assert.equal(f.find.getSnapshot().status, "ready"); assert.deepEqual(f.find.matchesIn(0, f.document().buffer.length), ranges);
        f.edit(12000, 12000, "long "); f.edit(2000, 2001, "k_"); f.edit(14000, 14002, "K "); f.drain();
        const expected = scan(f.document().buffer, "k", { wholeWord: true, matchCase: false }).index;
        assert.equal(f.find.getSnapshot().count, expected.count); assert.deepEqual(f.find.matchesIn(0, f.document().buffer.length), all(expected));
        f.edit(10000, 10000, "k "); f.find.setQuery("cat"); assert.equal(f.find.getSnapshot().retained, false); assert.equal(f.find.getSnapshot().count, 0); f.drain();
        assert.equal(f.find.getSnapshot().count, scan(f.document().buffer, "cat", { wholeWord: true, matchCase: false }).index.count);
        f.edit(10000, 10000, "cat "); f.find.cancel(); f.edit(10000, 10000, "cat "); f.drain(); assert.equal(f.find.getSnapshot().status, "cancelled"); assert.equal(f.find.getSnapshot().count, 0);
    } finally { f.dispose(); }
});

test("range captures reject old queries, revisions and disposed views while returned matches stay immutable", () => {
    const f = fixture("cat dog ".repeat(400));
    try {
        f.find.setQuery("cat"); f.drain();
        const initial = f.find.getSnapshot(), captured = f.find.matchesIn(3192, 3200, initial);
        assert.deepEqual(captured, [{ from: 3192, to: 3195 }]); assert.ok(Object.isFrozen(captured) && captured.every(Object.isFrozen));
        f.find.setFlags({ matchCase: true }); f.select(3192); f.find.next();
        assert.equal(f.find.getSnapshot().matchesVersion, initial.matchesVersion);
        assert.deepEqual(f.find.matchesIn(3192, 3200, initial), captured);
        f.find.setQuery("dog"); f.drain();
        const changed = f.find.getSnapshot(); assert.equal(changed.count, initial.count);
        assert.ok(changed.matchesVersion > initial.matchesVersion); assert.deepEqual(f.find.matchesIn(3192, 3200, initial), []);
        assert.deepEqual(f.find.matchesIn(3192, 3200, changed), [{ from: 3196, to: 3199 }]);
        f.edit(0, 8, ""); assert.deepEqual(f.find.matchesIn(3192, 3200, changed), []); f.drain();
        assert.deepEqual(f.find.matchesIn(3184, 3192), [{ from: 3188, to: 3191 }]);
        assert.deepEqual(captured, [{ from: 3192, to: 3195 }]);
        assert.throws(() => f.find.matchesIn(0, 3200), RangeError);
        f.find.cancel(); assert.deepEqual(f.find.matchesIn(0, 10), []);
        f.find.dispose(); assert.deepEqual(f.find.matchesIn(0, 3200, initial), []);
    } finally { f.dispose(); }
});
