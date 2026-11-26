import { bufferReads } from "./buffer-reads.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Workspace, anchoredRange } from "../src/index.ts";
import { applyTextEdits } from "../src/core/changes.ts";
import { HostSaveQueue } from "./fixtures/save-queue.ts";
import type { DocumentId, EditKind, HistoryOptions, Selection } from "../src/index.ts";
import { corpus, editLog } from "./fixtures/workloads.ts";
import { TextHistory } from "../src/core/history.ts";

function fixture(text = "abc", history?: HistoryOptions) {
    const errors: unknown[] = [], workspace = new Workspace({ onListenerError: error => errors.push(error), ...(history ? { history } : {}) });
    const source = workspace.createTextResource({ scope: "history", resource: "source", variant: "working" }, "Source", { value: text, serverVersion: "v0" });
    const document = () => workspace.document(source.documentId), state = workspace.observeHistory(source.documentId);
    const replace = (value: string, kind: EditKind = "replace", group?: string) => workspace.edit({ documentId: source.documentId, expectedRevision: document().revision,
        origin: kind === "proposal" ? "agent" : "human", history: { kind, ...(group ? { group } : {}) }, edits: [{ from: 0, to: document().buffer.length, insert: value }] });
    const undo = () => workspace.undo({ documentId: source.documentId, expectedRevision: document().revision });
    const redo = () => workspace.redo({ documentId: source.documentId, expectedRevision: document().revision });
    return { workspace, source, document, state, replace, undo, redo, errors };
}

test("a guarded draft restore maps live views and clears linked undo and redo atomically", () => {
    const { workspace, source, document, replace, undo, redo } = fixture("saved");
    replace("draft");
    const draft = document();
    const view = workspace.createDocumentView(draft.id, { anchor: 1, head: 4 });
    const peer = workspace.createDocument({ scope: "history", resource: "peer", variant: "working" }, "Peer", "peer");
    const unrelated = workspace.createDocument({ scope: "history", resource: "other", variant: "working" }, "Other", "");
    const prefix = (documentId: DocumentId, text: string) => ({
        documentId, expectedRevision: workspace.document(documentId).revision,
        origin: "host" as const, edits: [{ from: 0, to: 0, insert: text }]
    });
    workspace.edit(prefix(unrelated, "keep"));
    workspace.editDocuments([prefix(draft.id, "old "), prefix(peer, "+")]);
    workspace.editDocuments([prefix(draft.id, "?"), prefix(peer, "?")]);
    assert.ok(undo().applied);
    const rejected = document(), peerBefore = workspace.document(peer);
    assert.equal(rejected.text(), "old draft");
    const peerHistory = workspace.observeHistory(peer);
    assert.deepEqual(peerHistory.getSnapshot(), { undoDepth: 1, redoDepth: 1 });
    const observed: string[] = [];
    const stop = peerHistory.subscribe(() => observed.push(document().text()));
    const result = workspace.edit({ documentId: draft.id, expectedRevision: rejected.revision, origin: "host",
        edits: [{ from: 0, to: 4, insert: "" }], history: { kind: "replace", reset: true } });
    stop();
    assert.deepEqual(result, { applied: true, revision: rejected.revision + 1 });
    assert.deepEqual(observed, [draft.text()]);
    assert.deepEqual([view.getSnapshot().selection.anchor, view.getSnapshot().selection.head], [1, 4]);
    assert.equal(view.getSnapshot().revision, document().revision);
    assert.equal(workspace.document(peer), peerBefore);
    assert.deepEqual(peerHistory.getSnapshot(), { undoDepth: 0, redoDepth: 0 });
    assert.deepEqual(undo(), { applied: false, reason: "history-empty" });
    assert.deepEqual(redo(), { applied: false, reason: "history-empty" });
    assert.equal(workspace.observeHistory(unrelated).getSnapshot().undoDepth, 1);
    assert.equal(source.metadata.getSnapshot().dirty, true);
    assert.equal(source.metadata.getSnapshot().serverVersion, "v0");
    replace("saved");
    assert.equal(source.metadata.getSnapshot().dirty, false);
    assert.ok(undo().applied);
    assert.equal(document().text(), draft.text());
    view.dispose();
});

test("a history-only reset checks every target before clearing stacks and preserves the revision", () => {
    const { workspace, source, document, state, replace, undo } = fixture();
    replace("draft"); replace("later"); assert.ok(undo().applied);
    const request = { documentId: source.documentId, expectedRevision: document().revision, origin: "host" as const,
        edits: [], history: { kind: "replace" as const, reset: true } };
    const history = state.getSnapshot();
    assert.deepEqual(history, { undoDepth: 1, redoDepth: 1 });
    const permissions = source.metadata.getSnapshot().capabilities;
    workspace.setCapabilities(source.id, { ...permissions, edit: ["human"] });
    assert.deepEqual(workspace.edit(request), { applied: false, reason: "read-only" });
    workspace.setCapabilities(source.id, permissions);
    assert.deepEqual(workspace.edit({ ...request, expectedRevision: request.expectedRevision - 1 }), { applied: false, reason: "stale-revision" });
    const peer = workspace.createDocument({ scope: "history", resource: "peer", variant: "working" }, "Peer", "");
    assert.deepEqual(workspace.editDocuments([request, { ...request, documentId: peer, expectedRevision: 1 }]), { applied: false, reason: "stale-revision" });
    assert.throws(() => workspace.editDocuments([request, { ...request, documentId: peer, history: { kind: "replace" } }]), /one origin and history policy/);
    assert.throws(() => workspace.edit({ ...request, history: { ...request.history, group: "typing" } }), /undo group/);
    assert.equal(state.getSnapshot(), history);
    const before = document();
    let notifications = 0;
    const stop = state.subscribe(() => notifications++);
    assert.deepEqual(workspace.edit({ ...request, edits: [{ from: 0, to: 5, insert: "draft" }] }), { applied: true, revision: before.revision });
    assert.equal(document(), before);
    assert.deepEqual(state.getSnapshot(), { undoDepth: 0, redoDepth: 0 });
    assert.ok(workspace.edit(request).applied);
    assert.equal(notifications, 1);
    assert.equal(source.metadata.getSnapshot().dirty, true);
    stop();
});

test("packed bulk changes preserve initiating selection, independent views and exact saved roots through undo/redo", () => {
    const { workspace, source, document, undo, redo, state } = fixture("const sample = 1234567;\n".repeat(1000));
    const before = document().buffer, first = workspace.createDocumentView(source.documentId, { anchor: 1, head: 1 });
    const second = workspace.createDocumentView(source.documentId, { anchor: 2 * 24 + 11, head: 998 * 24 + 12 });
    const edits = Array.from({ length: 1000 }, (_, line) => ({ from: line * 24, to: line * 24 + 5, insert: "let" }));
    assert.equal(workspace.edit({ documentId: source.documentId, expectedRevision: 0, origin: "human", edits, view: first, history: { kind: "replace" } }).applied, true);
    const after = document().buffer; assert.equal(first.getSnapshot().selection.head, 3);
    assert.equal(second.getSnapshot().selection.anchor, 2 * 22 + 9); assert.equal(second.getSnapshot().selection.head, 998 * 22 + 10);
    assert.equal(source.metadata.getSnapshot().dirty, true); assert.equal(state.getSnapshot().undoDepth, 1);
    assert.equal(undo().applied, true); assert.equal(document().buffer, before); assert.equal(first.getSnapshot().selection.head, 1);
    assert.equal(second.getSnapshot().selection.anchor, 2 * 24 + 11); assert.equal(second.getSnapshot().selection.head, 998 * 24 + 12);
    assert.equal(source.metadata.getSnapshot().dirty, false);
    assert.equal(redo().applied, true); assert.equal(document().buffer, after); assert.equal(first.getSnapshot().selection.head, 3);
    assert.equal(bufferReads(before).textExports, 0); assert.equal(bufferReads(after).textExports, 0); first.dispose(); second.dispose();
});

test("workspace snapshots export text only through explicit captured readers", () => {
    const { workspace, source, document, errors } = fixture(corpus("lines-10000"));
    const first = document(), firstResource = source.getSnapshot(), saved = first.buffer, seen = [];
    assert.ok(firstResource.state === "ready");
    const readText = first.text, readValue = firstResource.value;
    let anchor = anchoredRange(saved.length, 100, 130);
    const unsubscribe = workspace.observeDocument(source.documentId).subscribe(() => {
        const current = document(); anchor = current.change!.mapping.mapRange(anchor)!;
        seen.push(current.buffer.slice(current.buffer.offsetAt(100), current.buffer.offsetAt(100) + 12));
    });
    workspace.edit({ documentId: source.documentId, expectedRevision: 0, origin: "human", edits: [{ from: 0, to: 0, insert: "😀" }] });
    assert.deepEqual([anchor.from, anchor.to], [102, 132]);
    const current = document(); assert.notEqual(current.buffer, saved); assert.equal(current.buffer.length, saved.length + 2);
    workspace.setCapabilities(source.id, { edit: ["human"], save: true });
    for (const snapshot of [first, firstResource, current, source.getSnapshot(), workspace.getSnapshot()]) {
        const spread = { ...snapshot }, assigned = Object.assign({}, snapshot);
        assert.deepEqual(Object.keys(spread), Object.keys(assigned)); JSON.stringify(spread); JSON.stringify(snapshot);
    }
    assert.equal(document(), current); assert.equal(bufferReads(saved).textExports, 0); assert.equal(bufferReads(current.buffer).textExports, 0);
    assert.equal(seen.length, 1); assert.ok(Object.isFrozen(current)); assert.equal(errors.length, 0);
    assert.ok(Object.isFrozen(source.getSnapshot())); assert.ok(Object.isFrozen(source.metadata.getSnapshot()));
    assert.equal(source.getSnapshot().metadata, source.metadata.getSnapshot());
    assert.equal(readText().length, saved.length); assert.equal(readValue(), readText());
    assert.equal(bufferReads(saved).textExports, 1); assert.equal(bufferReads(current.buffer).textExports, 0);
    const currentResource = source.getSnapshot(); assert.ok(currentResource.state === "ready");
    assert.equal(current.text().slice(0, 2), "😀"); assert.equal(currentResource.value(), current.text());
    assert.equal(bufferReads(current.buffer).textExports, 1);
    unsubscribe(); workspace.releaseResource(source.id, true);
    assert.equal(readValue(), readText()); assert.equal(currentResource.value(), current.text());
    assert.equal(bufferReads(saved).textExports, 1); assert.equal(bufferReads(current.buffer).textExports, 1);
});

test("explicit consecutive groups, origins, standalone intents and saved boundaries keep exact undo-to-saved states", async () => {
    const { workspace, source, document, state, replace, undo, redo } = fixture();
    replace("abcd", "typing", "typing-one"); replace("abcde", "typing", "typing-one");
    assert.equal(state.getSnapshot().undoDepth, 1);
    const commands = new HostSaveQueue(workspace);
    const saved = await commands.save(workspace.captureSave(source), { save: async () => ({ kind: "saved", serverVersion: "v1" }) }); assert.equal(saved.kind, "saved");
    replace("abcdef", "typing", "typing-one"); assert.equal(state.getSnapshot().undoDepth, 2);
    const beforeUndo = document().revision; assert.equal(undo().applied, true);
    assert.equal(document().text(), "abcde"); assert.equal(source.metadata.getSnapshot().dirty, false); assert.ok(document().revision > beforeUndo);
    undo(); assert.equal(document().text(), "abc"); assert.equal(source.metadata.getSnapshot().dirty, true);
    redo(); assert.equal(document().text(), "abcde"); assert.equal(source.metadata.getSnapshot().dirty, false);
    for (const kind of ["paste", "composition", "form", "refactor", "proposal", "live"] as const) {
        replace(`${document().text()}:${kind}`, kind); const after = document().text();
        undo(); assert.ok(!document().text().endsWith(`:${kind}`)); redo(); assert.equal(document().text(), after);
    }
});

test("two view selections map independently and survive tab close/reopen and history traversal", () => {
    const { workspace, source, document } = fixture("a😀bcdef");
    const primary = workspace.createDocumentView(source.documentId, { anchor: 3, head: 3 });
    const secondary = workspace.createDocumentView(source.documentId, { anchor: 7, head: 4 });
    const tab = workspace.tabs.open({ kind: "text", documentId: source.documentId });
    const after: Selection = { anchor: 5, head: 5 };
    workspace.edit({ documentId: source.documentId, expectedRevision: 0, origin: "human", history: { kind: "typing", group: "one" }, view: primary,
        selection: after, edits: [{ from: 3, to: 3, insert: "XY" }] });
    assert.deepEqual([primary.getSnapshot().selection.anchor, primary.getSnapshot().selection.head], [5, 5]);
    assert.deepEqual([secondary.getSnapshot().selection.anchor, secondary.getSnapshot().selection.head], [9, 6]);
    workspace.tabs.close(tab); assert.throws(() => workspace.releaseResource(source.id, true));
    const reopened = workspace.tabs.open({ kind: "text", documentId: source.documentId });
    workspace.undo({ documentId: source.documentId, expectedRevision: document().revision });
    assert.equal(document().text(), "a😀bcdef"); assert.deepEqual([primary.getSnapshot().selection.anchor, primary.getSnapshot().selection.head], [3, 3]);
    assert.deepEqual([secondary.getSnapshot().selection.anchor, secondary.getSnapshot().selection.head], [7, 4]);
    workspace.redo({ documentId: source.documentId, expectedRevision: document().revision });
    assert.equal(primary.getSnapshot().selection.head, 5); assert.equal(secondary.getSnapshot().selection.anchor, 9);
    secondary.setSelections(document().revision, [{ anchor: 1, head: 0 }, { anchor: 10, head: 10 }], 1);
    const moved = secondary.getSnapshot().selectionSet;
    workspace.undo({ documentId: source.documentId, expectedRevision: document().revision });
    const undone = secondary.getSnapshot().selectionSet;
    assert.equal(undone.primary, 1);
    assert.deepEqual(undone.ranges.map(({ anchor, head }) => [anchor, head]), [[1, 0], [8, 8]]);
    workspace.redo({ documentId: source.documentId, expectedRevision: document().revision });
    assert.deepEqual(secondary.getSnapshot().selectionSet, moved);
    assert.equal(primary.setSelection(0, { anchor: 0, head: 0 }), false);
    assert.throws(() => primary.setSelection(document().revision, { anchor: -1, head: 0 }));
    const releasedRevision = document().revision;
    workspace.tabs.close(reopened); primary.dispose(); secondary.dispose(); primary.dispose(); workspace.releaseResource(source.id, true);
    assert.equal(primary.setSelection(releasedRevision, { anchor: 0, head: 0 }), false);
});

test("undo restores selections inside a host replacement only to the views that owned them", () => {
    const { workspace, source } = fixture("header\r\nline: abcdef\r\nfooter");
    const documentId = source.documentId, keep = workspace.createDocumentView(documentId), closed = workspace.createDocumentView(documentId);
    keep.setSelections(0, [{ anchor: 19, head: 16 }, { anchor: 2, head: 2 }], 0);
    closed.setSelection(0, { anchor: 15, head: 15 });
    const before = keep.getSnapshot().selectionSet;
    const original = workspace.document(documentId).buffer;
    workspace.edit({ documentId, expectedRevision: 0, origin: "host",
        edits: [{ from: 0, to: original.length, insert: "header\r\nline: Z\r\nfooter" }] });
    const after = keep.getSnapshot().selectionSet;
    const mapped = keep.getSnapshot().selection;
    assert.notEqual(mapped.head, before.ranges[before.primary]!.head);
    closed.dispose();
    const replacement = workspace.createDocumentView(documentId, { anchor: 3, head: 3 });
    workspace.undo({ documentId, expectedRevision: 1 });
    assert.deepEqual(keep.getSnapshot().selectionSet, before);
    assert.equal(replacement.getSnapshot().selection.head, 3);
    workspace.redo({ documentId, expectedRevision: 2 });
    assert.deepEqual(keep.getSnapshot().selectionSet, after);
    assert.equal(replacement.getSnapshot().selection.head, 3);
    keep.dispose(); replacement.dispose();
});

test("typing grouping is local to its document while unrelated live traffic and saves continue", async () => {
    const { workspace, source, document, replace, state, undo } = fixture();
    const other = workspace.createTextResource({ scope: "history", resource: "background", variant: "working" }, "Background", { value: "0" });
    const commands = new HostSaveQueue(workspace);
    for (let index = 1; index <= 3; index++) {
        replace(`abc${"x".repeat(index)}`, "typing", "continuous");
        workspace.edit({ documentId: other.documentId, expectedRevision: workspace.document(other.documentId).revision,
            origin: "host", history: { kind: "live" }, edits: [{ from: 0, to: 1, insert: String(index) }] });
        await commands.save(workspace.captureSave(other), { save: async () => ({ kind: "saved", serverVersion: `v${index}` }) });
    }
    assert.equal(state.getSnapshot().undoDepth, 1); assert.equal(workspace.observeHistory(other.documentId).getSnapshot().undoDepth, 3);
    undo(); assert.equal(document().text(), "abc"); assert.equal(source.metadata.getSnapshot().dirty, false);
    assert.equal(workspace.document(other.documentId).text(), "3");
});

test("default history retains 150 word groups and an earlier edit in another document", () => {
    const { workspace, document, replace, undo } = fixture("first");
    assert.ok(replace("first edit").applied);
    const other = workspace.createDocument({ scope: "history", resource: "words", variant: "working" }, "Words", "");
    const words = Array.from({ length: 150 }, (_, index) => "word" + index + " ");
    const target = () => ({ documentId: other, expectedRevision: workspace.document(other).revision });

    for (const word of words) {
        for (const insert of word) {
            const at = workspace.document(other).buffer.length;
            assert.ok(workspace.edit({
                ...target(), origin: "human", history: { kind: "typing", group: word },
                edits: [{ from: at, to: at, insert }],
            }).applied);
        }
    }
    let expected = words.join("");
    assert.equal(workspace.document(other).text(), expected);
    for (const word of [...words].reverse()) {
        assert.ok(workspace.undo(target()).applied);
        expected = expected.slice(0, -word.length);
        assert.equal(workspace.document(other).text(), expected);
    }
    assert.equal(workspace.undo(target()).applied, false);
    assert.ok(workspace.redo(target()).applied);
    assert.equal(document().text(), "first edit");
    assert.ok(undo().applied);
    assert.equal(document().text(), "first");
    assert.equal(workspace.document(other).text(), words[0]);
});

test("multi-document edits preflight every target, publish coherently, and undo/redo one shared unit", () => {
    const { workspace, source, document, errors } = fixture();
    const other = workspace.createTextResource({ scope: "history", resource: "other", variant: "working" }, "Other", { value: "xyz" });
    const requests = () => [source, other].map(handle => ({ documentId: handle.documentId, expectedRevision: workspace.document(handle.documentId).revision,
        origin: "host" as const, history: { kind: "refactor" as const }, edits: [{ from: 1, to: 2, insert: "!" }] }));
    const original = workspace.getSnapshot(), malformed = requests(); malformed[1]!.edits[0]!.to = 99;
    assert.throws(() => workspace.editDocuments(malformed)); assert.equal(workspace.getSnapshot(), original);
    const stale = requests(); stale[1]!.expectedRevision = 99; assert.deepEqual(workspace.editDocuments(stale), { applied: false, reason: "stale-revision" });
    assert.equal(workspace.getSnapshot(), original);
    let notifications = 0;
    const unsubscribe = workspace.observeDocument(source.documentId).subscribe(() => {
        notifications++; assert.equal(document().text(), "a!c"); assert.equal(workspace.document(other.documentId).text(), "x!z");
        assert.equal(workspace.observeHistory(other.documentId).getSnapshot().undoDepth, 1);
    });
    assert.equal(workspace.editDocuments(requests()).applied, true); unsubscribe(); assert.equal(notifications, 1);
    assert.equal(document().change!.transactionId, workspace.document(other.documentId).change!.transactionId);
    workspace.setCapabilities(other.id, { edit: [], save: true }); const locked = workspace.getSnapshot();
    assert.deepEqual(workspace.undo({ documentId: source.documentId, expectedRevision: 1 }), { applied: false, reason: "read-only" }); assert.equal(workspace.getSnapshot(), locked);
    workspace.setCapabilities(other.id, { edit: ["human", "host"], save: true });
    assert.equal(workspace.undo({ documentId: source.documentId, expectedRevision: 1 }).applied, true);
    assert.equal(document().text(), "abc"); assert.equal(workspace.document(other.documentId).text(), "xyz");
    assert.equal(source.metadata.getSnapshot().dirty, false); assert.equal(other.metadata.getSnapshot().dirty, false);
    workspace.redo({ documentId: other.documentId, expectedRevision: 2 });
    assert.equal(document().text(), "a!c"); assert.equal(workspace.document(other.documentId).text(), "x!z"); assert.equal(errors.length, 0);
});

test("later edits block linked undo; branching invalidates dependent redo and release clears linked history", () => {
    const { workspace, source, document, replace } = fixture();
    const other = workspace.createTextResource({ scope: "history", resource: "other", variant: "working" }, "Other", { value: "xyz" });
    workspace.editDocuments([source, other].map(handle => ({ documentId: handle.documentId, expectedRevision: 0, origin: "host", edits: [{ from: 0, to: 0, insert: "!" }] })));
    replace("later");
    assert.deepEqual(workspace.undo({ documentId: other.documentId, expectedRevision: 1 }), { applied: false, reason: "history-blocked" });
    workspace.undo({ documentId: source.documentId, expectedRevision: document().revision });
    workspace.undo({ documentId: other.documentId, expectedRevision: 1 });
    replace("branch");
    assert.equal(workspace.observeHistory(other.documentId).getSnapshot().redoDepth, 0);
    assert.deepEqual(workspace.redo({ documentId: other.documentId, expectedRevision: workspace.document(other.documentId).revision }), { applied: false, reason: "history-empty" });
    workspace.editDocuments([source, other].map(handle => ({ documentId: handle.documentId, expectedRevision: workspace.document(handle.documentId).revision,
        origin: "host", edits: [{ from: 0, to: 0, insert: "?" }] })));
    workspace.releaseResource(other.id, true); assert.deepEqual(workspace.observeHistory(source.documentId).getSnapshot(), { undoDepth: 0, redoDepth: 0 });
});

test("undo and redo map a later view through a long group of separated edits", () => {
    const workspace = new Workspace();
    const id = workspace.createDocument({ scope: "history", resource: "group", variant: "working" }, "Group", "abc".repeat(1_101));
    const request = { documentId: id, origin: "human", history: { kind: "typing", group: "one" } } as const;
    workspace.editDocuments([{ ...request, expectedRevision: 0, text: "ABC".repeat(1_101) }]);
    for (let i = 0; i < 1_101; i++) {
        const at = i * 4 + 1;
        workspace.edit({ ...request, expectedRevision: i + 1, edits: [{ from: at, to: at + 1, insert: "BB" }] });
    }
    assert.equal(workspace.observeHistory(id).getSnapshot().undoDepth, 1);
    const view = workspace.createDocumentView(id, { anchor: 4 * 999, head: 4 * 503 });
    assert.ok(workspace.undo({ documentId: id, expectedRevision: 1_102 }).applied);
    assert.deepEqual(view.getSnapshot().selection, { anchor: 3 * 999, head: 3 * 503, anchorAffinity: "before", headAffinity: "after" });
    assert.ok(workspace.redo({ documentId: id, expectedRevision: 1_103 }).applied);
    assert.deepEqual(view.getSnapshot().selection, { anchor: 4 * 999, head: 4 * 503, anchorAffinity: "before", headAffinity: "after" });
    view.dispose();
});

test("history bounds count groups, changes and changed units without flattening, including grouped rollover and oversized edits", () => {
    const { workspace, document, state, replace, undo, redo } = fixture("", { maxGroups: 3, maxChanges: 3, maxChangedUnits: 30 });
    for (let index = 1; index <= 10; index++) {
        replace("x".repeat(index), "typing", "same"); const stats = workspace.diagnostics().history;
        assert.ok(stats.groups <= 3 && stats.changes <= 3 && stats.changedUnits <= 30);
    }
    assert.ok(state.getSnapshot().undoDepth <= 3); assert.ok(state.getSnapshot().undoDepth > 0);
    for (let index = 0; index < 10; index++) { if (!undo().applied) break; }
    assert.ok(state.getSnapshot().redoDepth <= 3);
    while (redo().applied) { /* bounded */ }
    replace("oversized".repeat(100)); assert.equal(state.getSnapshot().undoDepth, 0); assert.equal(undo().applied, false);
    assert.equal(bufferReads(document().buffer).textExports, 0);
    assert.throws(() => fixture("", { maxChanges: -1 }), RangeError);
    const independent = workspace.createDocument({ scope: "history", resource: "independent", variant: "working" }, "Independent", "a");
    workspace.edit({ documentId: independent, expectedRevision: 0, origin: "human", edits: [{ from: 0, to: 1, insert: "b" }] });
    replace("another oversized".repeat(100));
    assert.equal(workspace.observeHistory(independent).getSnapshot().undoDepth, 1);
});

test("workspace history snapshots follow changed stack depths rather than all open documents", t => {
    const workspace = new Workspace(), ids = Array.from({ length: 1000 }, (_, i) => workspace.createDocument(
        { scope: "many", resource: String(i), variant: "working" }, "Document", "x"));
    const id = ids[0]!, peer = ids[1]!, view = workspace.createDocumentView(id);
    const untouched = workspace.observeHistory(ids[999]!).getSnapshot(), snapshots = TextHistory.prototype.snapshot;
    let calls: string[] = [];
    const results: { action: string; calls: string[]; expected: string[] }[] = [];
    TextHistory.prototype.snapshot = function (target) { calls.push(target); return snapshots.call(this, target); };
    const capture = (action: string, work: () => void, expected: string[]) => {
        calls = []; work(); results.push({ action, calls: [...calls].sort(), expected: [...expected].sort() });
    };
    const edit = () => workspace.edit({ documentId: id, expectedRevision: workspace.document(id).revision,
        origin: "human", history: { kind: "typing", group: "continuous" }, edits: [{ from: 0, to: 0, insert: "a" }] });
    try {
        capture("first edit", () => { assert.equal(edit().applied, true); }, [id]);
        capture("group extension", () => { assert.equal(edit().applied, true); }, []);
        capture("selection only", () => { workspace.edit({ documentId: id, expectedRevision: workspace.document(id).revision,
            origin: "human", edits: [], view, selection: { anchor: 1, head: 1 } }); }, []);
        capture("undo", () => { assert.equal(workspace.undo({ documentId: id, expectedRevision: workspace.document(id).revision }).applied, true); }, [id]);
        capture("redo", () => { assert.equal(workspace.redo({ documentId: id, expectedRevision: workspace.document(id).revision }).applied, true); }, [id]);
        capture("no-op", () => { workspace.edit({ documentId: id, expectedRevision: workspace.document(id).revision, origin: "human", edits: [] }); }, []);
        for (const canonical of [undefined, "canonical"]) capture(canonical ? "canonical save" : "ordinary save", () => {
            const ticket = workspace.captureSave(workspace.resourceForDocument(id)); ticket.start();
            ticket.accept({ serverVersion: "saved", ...(canonical === undefined ? {} : { canonical }) }); ticket.finish();
        }, canonical ? [id] : []);
        capture("shared edit", () => { assert.equal(workspace.editDocuments([id, peer].map(documentId => ({ documentId,
            expectedRevision: workspace.document(documentId).revision, origin: "host" as const, edits: [{ from: 0, to: 0, insert: "!" }] }))).applied, true); }, [id, peer]);
        assert.equal(workspace.observeHistory(ids[999]!).getSnapshot(), untouched);
    } finally { TextHistory.prototype.snapshot = snapshots; view.dispose(); }
    t.diagnostic(JSON.stringify(results.map(({ action, calls }) => ({ action, snapshots: calls.length }))));
    for (const result of results) assert.deepEqual(result.calls, result.expected, result.action);
});

test("history publishes transitive redo clearing and oversized linked boundaries and keeps unrelated history", () => {
    const errors: unknown[] = [], workspace = new Workspace({ history: { maxGroups: 3, maxChangedUnits: 16 }, onListenerError: error => errors.push(error) });
    const [a, b, c, d] = ["a", "b", "c", "d"].map(resource => workspace.createDocument({ scope: "linked", resource, variant: "working" }, resource, "")) as [DocumentId, DocumentId, DocumentId, DocumentId];
    const edit = (ids: DocumentId[], insert = "x") => assert.equal(workspace.editDocuments(ids.map(documentId => ({ documentId,
        expectedRevision: workspace.document(documentId).revision, origin: "human" as const, edits: [{ from: 0, to: 0, insert }] }))).applied, true);
    const state = (id: DocumentId) => workspace.observeHistory(id).getSnapshot();
    const undo = (documentId: DocumentId) => assert.equal(workspace.undo({ documentId, expectedRevision: workspace.document(documentId).revision }).applied, true);
    edit([a, b]); edit([b, c]); edit([d]); undo(c); undo(a);
    assert.deepEqual([state(a).redoDepth, state(b).redoDepth, state(c).redoDepth], [1, 2, 1]);
    const unrelated = state(d), notifications = new Map<DocumentId, number>();
    const stops = [a, b, c, d].map(id => workspace.observeHistory(id).subscribe(() => notifications.set(id, (notifications.get(id) ?? 0) + 1)));
    let documentCalls = 0;
    const stopDocument = workspace.observeDocument(a).subscribe(() => {
        documentCalls++; assert.deepEqual([state(b).redoDepth, state(c).redoDepth], [0, 0]);
    });
    edit([a]); stopDocument(); assert.equal(documentCalls, 1);
    assert.deepEqual([...notifications.keys()].sort(), [a, b, c].sort()); assert.equal(state(d), unrelated);
    edit([a, b]); notifications.clear(); edit([b, c]);
    assert.equal(state(d), unrelated); assert.equal(notifications.has(d), false);
    edit([d]); const independent = state(d); notifications.clear();
    edit([a], "!".repeat(100));
    assert.deepEqual(state(a), { undoDepth: 0, redoDepth: 0 });
    assert.deepEqual(state(b), { undoDepth: 1, redoDepth: 0 }); assert.equal(state(c).undoDepth, 1);
    assert.deepEqual([...notifications.keys()].sort(), [a, b].sort());
    undo(c); assert.equal(state(b).redoDepth, 1);
    assert.equal(state(d), independent); assert.equal(notifications.has(d), false); assert.deepEqual(errors, []);
    stops.forEach(stop => stop());
});

test("no-op/malformed/stale edits publish no history or text and reject foreign view identities", () => {
    const { workspace, source, document, state, replace } = fixture(), foreign = fixture().workspace;
    const before = workspace.getSnapshot(), oldHistory = state.getSnapshot(); replace("abc");
    assert.equal(workspace.getSnapshot(), before); assert.equal(state.getSnapshot(), oldHistory);
    const localView = workspace.createDocumentView(source.documentId), oldView = localView.getSnapshot();
    workspace.edit({ documentId: source.documentId, expectedRevision: 0, origin: "human", edits: [], view: localView, selection: { anchor: 0, head: 0 } });
    assert.equal(localView.getSnapshot(), oldView); assert.equal(workspace.getSnapshot(), before);
    workspace.edit({ documentId: source.documentId, expectedRevision: 0, origin: "human", edits: [], view: localView, selection: { anchor: 1, head: 1 } });
    assert.equal(localView.getSnapshot().selection.head, 1); assert.equal(workspace.getSnapshot(), before); localView.dispose();
    workspace.edit({ documentId: source.documentId, expectedRevision: 0, origin: "human", edits: [{ from: 0, to: 1, insert: "" }, { from: 1, to: 1, insert: "a" }] });
    assert.equal(workspace.getSnapshot(), before); assert.equal(state.getSnapshot(), oldHistory);
    assert.deepEqual(workspace.undo({ documentId: source.documentId, expectedRevision: 9 }), { applied: false, reason: "stale-revision" });
    const foreignId = foreign.getSnapshot().documents[0]!.id, view = foreign.createDocumentView(foreignId);
    assert.throws(() => workspace.edit({ documentId: source.documentId, expectedRevision: 0, origin: "human", view, edits: [{ from: 0, to: 0, insert: "bad" }] }));
    assert.equal(workspace.getSnapshot(), before); assert.equal(document().revision, 0); view.dispose();
});

test("canonical saves and deferred receipts remain exact through undo and redo, with reload as a history boundary", async () => {
    const { workspace, source, document, replace, undo, redo, state } = fixture();
    replace("local"); const commands = new HostSaveQueue(workspace);
    const saved = await commands.save(workspace.captureSave(source), { save: async () => ({ kind: "saved", serverVersion: "v1", canonical: "LOCAL" }) });
    assert.ok(saved.kind === "saved" && saved.receipt.canonicalApplied); undo(); assert.equal(document().text(), "local"); assert.equal(source.metadata.getSnapshot().dirty, true);
    redo(); assert.equal(document().text(), "LOCAL"); assert.equal(source.metadata.getSnapshot().dirty, false);
    replace("next"); const ticket = workspace.captureSave(source); ticket.start(); undo();
    ticket.accept({ serverVersion: "v2" }); ticket.finish(); assert.equal(document().text(), "LOCAL"); assert.equal(source.metadata.getSnapshot().dirty, true);
    redo(); assert.equal(document().text(), "next"); assert.equal(source.metadata.getSnapshot().dirty, false);
    const view = workspace.createDocumentView(source.documentId, { anchor: 4, head: 4 });
    const loadedRevision = document().revision;
    const load = workspace.beginLoad(source); assert.equal(view.setSelection(loadedRevision, { anchor: 0, head: 0 }), false);
    load.accept({ value: "reloaded", serverVersion: "v3" });
    assert.equal(document().text(), "reloaded"); assert.equal(state.getSnapshot().undoDepth, 0); assert.equal(view.getSnapshot().selection.head, 0); view.dispose();
});

test("seeded Unicode edits and random undo/redo match a string history oracle without revision reuse", () => {
    const { workspace, source, document, undo, redo } = fixture(corpus("unicode"));
    const past: string[] = [], future: string[] = []; let text = document().text(), revision = document().revision;
    const log = editLog(text.length, 80);
    for (const [index, edit] of log.entries()) {
        const next = applyTextEdits(text, [edit]); if (next !== text) { past.push(text); text = next; future.length = 0; }
        workspace.edit({ documentId: source.documentId, expectedRevision: revision, origin: "human", edits: [edit] });
        if (next !== document().text()) assert.fail("Edit oracle mismatch"); revision = document().revision;
        if (index % 7 === 0 && past.length) {
            future.push(text); text = past.pop()!; undo(); assert.ok(document().revision > revision); revision = document().revision;
            assert.equal(document().text(), text); past.push(text); text = future.pop()!; redo(); revision = document().revision;
        }
        assert.equal(document().text(), text);
    }
    while (past.length) { future.push(text); text = past.pop()!; assert.equal(undo().applied, true); assert.equal(document().text(), text); }
    while (future.length) { past.push(text); text = future.pop()!; assert.equal(redo().applied, true); assert.equal(document().text(), text); }
    assert.equal(document().text(), text);
    assert.equal(workspace.undo({ documentId: "missing" as DocumentId, expectedRevision: 0 }).applied, false);
});
