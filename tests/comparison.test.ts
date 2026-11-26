import assert from "node:assert/strict";
import test from "node:test";
import { compareText } from "../src/core/comparison.ts";
import { TextBuffer, Workspace } from "../src/index.ts";
import { mapComparisonHunks } from "../src/core/comparison-presentation.ts";
import type { ComparisonController } from "../src/index.ts";
function fixture(suffix = "") {
    const workspace = new Workspace(), resource = workspace.createTextResource({ scope: "test", resource: "working", variant: "source" }, "Working", { value: "first\nworking\nlast\n" + suffix, serverVersion: "saved-1" });
    const tab = workspace.tabs.open({ kind: "text", documentId: resource.documentId }, "main");
    const reference = Object.freeze({ buffer: TextBuffer.from("first\nbaseline\nlast\n" + suffix), version: "reference-1" });
    const comparison = compareText(workspace, tab, reference);
    const edit = (insert: string) => workspace.edit({ documentId: resource.documentId, expectedRevision: workspace.document(resource.documentId).revision,
        origin: "human", edits: [{ from: workspace.document(resource.documentId).buffer.length, to: workspace.document(resource.documentId).buffer.length, insert }] });
    return { workspace, resource, tab, reference, comparison, edit };
}
function ready(controller: ComparisonController) { let state = controller.getSnapshot(); for (let i = 0; state.status === "running" && i < 10000; i++) state = controller.advance(512); assert.equal(state.status, "ready"); return state; }

test("a comparison of two documents follows reference edits and rejects an older reversion", () => {
    const workspace = new Workspace();
    const working = workspace.createDocument({ scope: "test", resource: "work", variant: "text" }, "Working", "a\nb\n");
    const reference = workspace.createDocument({ scope: "test", resource: "base", variant: "text" }, "Reference", "a\nc\n");
    const comparison = compareText(workspace, working, reference);
    assert.equal(ready(comparison).hunks.length, 1);
    const revert = comparison.beginReversion();
    assert.equal(revert.capture.tab, undefined);
    assert.throws(() => comparison.beginRefresh(), /followed reference/);
    assert.throws(() => comparison.beginAcceptance(), /followed reference/);
    workspace.edit({ documentId: reference, expectedRevision: 0, origin: "host", edits: [{ from: 2, to: 3, insert: "b" }] });
    const next = ready(comparison);
    assert.equal(next.baseline?.buffer, workspace.document(reference).buffer);
    assert.equal(next.baseline.epoch, 1);
    assert.equal(next.hunks.length, 0);
    assert.equal(revert.complete(), false);
    assert.equal(workspace.document(working).revision, 0);
    comparison.dispose();
    assert.deepEqual([workspace.diagnostics().tabs, workspace.diagnostics().leases, workspace.diagnostics().subscriptions], [0, 0, 0]);
});

test("invalid comparison budgets preserve live work and the shared minimum can finish it", () => {
    const workspace = new Workspace(), prefix = "same\r\n".repeat(1000), reference = TextBuffer.from(prefix + "baseline\n");
    const resource = workspace.createTextResource({ scope: "test", resource: "budget", variant: "working" }, "Working", { value: prefix + "working\n" });
    const tab = workspace.tabs.open({ kind: "text", documentId: resource.documentId }, "main"), comparison = compareText(workspace, tab, { buffer: reference, version: "one" });
    let notifications = 0; const unsubscribe = comparison.subscribe(() => notifications++);
    const rejectInvalid = () => {
        const before = comparison.getSnapshot(), count = notifications;
        for (const budget of [-1, 0, 255, 256.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
            assert.throws(() => comparison.advance(budget), RangeError);
            assert.equal(comparison.getSnapshot(), before); assert.equal(notifications, count);
        }
    };
    rejectInvalid(); let state = comparison.advance(256); assert.equal(state.status, "running"); rejectInvalid();
    let calls = 1;
    while (state.status === "running" && calls++ < 1000) {
        const work = state.progress!.work; state = comparison.advance(256);
        assert.ok(state.progress!.work - work <= 1024, "one checkpoint may overshoot the requested work budget");
    }
    assert.equal(state.status, "ready"); assert.equal(state.hunks.length, 1); rejectInvalid();
    assert.equal(comparison.hunkAt(0)!.revert(), true);
    assert.equal(workspace.document(resource.documentId).buffer.equals(reference), true);
    unsubscribe(); comparison.dispose(); assert.equal(workspace.diagnostics().leases, 0);
});

test("captured whole-review reversion preserves distant changes and complete shared history", () => {
    const workspace = new Workspace(), text = "first\r\n" + "unchanged value\r\n".repeat(10_000) + "last 😀\r", reference = TextBuffer.from(text);
    const resource = workspace.createTextResourceFromBuffer({ scope: "review", resource: "source", variant: "working" }, "Working", { buffer: reference, serverVersion: "saved-1" });
    const tab = workspace.tabs.open({ kind: "text", documentId: resource.documentId }, "main"), comparison = compareText(workspace, tab, { buffer: reference, version: "review-1" }), peer = workspace.createDocumentView(resource.documentId);
    workspace.edit({ documentId: resource.documentId, expectedRevision: 0, origin: "human", edits: [{ from: 0, to: 5, insert: "different" }, { from: text.length - 8, to: text.length, insert: "tail" }] });
    ready(comparison); const buffer = workspace.document(resource.documentId).buffer;
    comparison.view.setSelections(1, [{ anchor: 8, head: 0 }, { anchor: 70_000, head: 70_003 }, { anchor: buffer.length, head: buffer.length }], 2);
    peer.setSelection(1, { anchor: 123456, head: 123460 }); const before = comparison.view.getSnapshot().selectionSet, peerBefore = peer.getSnapshot().selectionSet, history = workspace.observeHistory(resource.documentId).getSnapshot();
    const ticket = comparison.beginReversion(); workspace.tabs.move(tab, "other"); assert.equal(ticket.isCurrent(), true); assert.equal(ticket.complete(), true);
    assert.equal(workspace.document(resource.documentId).buffer.equals(reference), true); assert.equal(workspace.observeHistory(resource.documentId).getSnapshot().undoDepth, history.undoDepth + 1);

    assert.equal(resource.metadata.getSnapshot().serverVersion, "saved-1"); assert.equal(resource.metadata.getSnapshot().dirty, false);
    assert.equal(workspace.undo({ documentId: resource.documentId, expectedRevision: 2 }).applied, true);
    assert.equal(workspace.document(resource.documentId).buffer, buffer); assert.deepEqual(comparison.view.getSnapshot().selectionSet, before); assert.deepEqual(peer.getSnapshot().selectionSet, peerBefore);
    assert.equal(workspace.redo({ documentId: resource.documentId, expectedRevision: 3 }).applied, true); assert.equal(workspace.document(resource.documentId).buffer.equals(reference), true);
    assert.equal(ticket.complete(), false); peer.dispose(); comparison.dispose(); assert.equal(workspace.diagnostics().leases, 0);
});

test("delayed whole-review reversion rejects newer typing, selection, reference intent and saved version", () => {
    for (const change of ["typing", "selection", "refresh-intent", "accept-intent", "reference", "save", "new-reversion", "replace", "close", "view", "dispose"] as const) {
        const f = fixture(); ready(f.comparison); const ticket = f.comparison.beginReversion();
        if (change === "typing") f.edit("later");
        if (change === "selection") f.comparison.view.setSelection(0, { anchor: 1, head: 2 });
        if (change === "refresh-intent") f.comparison.beginRefresh().cancel();
        if (change === "accept-intent") f.comparison.beginAcceptance().cancel();
        if (change === "reference") f.comparison.beginRefresh().complete({ buffer: TextBuffer.from("other"), version: "other" });
        if (change === "save") { const save = f.workspace.captureSave(f.resource); save.start(); save.accept({ serverVersion: "saved-2" }); save.finish(); }
        if (change === "new-reversion") f.comparison.beginReversion().cancel();
        if (change === "replace") f.workspace.tabs.replace(f.tab, { kind: "text", documentId: f.resource.documentId });
        if (change === "close") f.workspace.tabs.close(f.tab);
        if (change === "view") f.comparison.view.dispose();
        if (change === "dispose") f.comparison.dispose();
        const before = f.workspace.document(f.resource.documentId), history = f.workspace.observeHistory(f.resource.documentId).getSnapshot();
        assert.equal(ticket.complete(), false, change); assert.equal(f.workspace.document(f.resource.documentId), before, change); assert.deepEqual(f.workspace.observeHistory(f.resource.documentId).getSnapshot(), history, change);
        f.comparison.dispose(); assert.equal(f.workspace.diagnostics().leases, 0, change);
    }
});

test("restoring permission cannot revive an old discard confirmation", () => {
    const f = fixture();
    ready(f.comparison);
    const ticket = f.comparison.beginReversion();
    const original = f.resource.metadata.getSnapshot().capabilities;
    f.workspace.setCapabilities(f.resource.id, { edit: ["host"], save: true });
    f.workspace.setCapabilities(f.resource.id, original);
    const before = f.workspace.document(f.resource.documentId);
    assert.equal(ticket.complete(), false);
    assert.equal(f.workspace.document(f.resource.documentId), before);
    f.comparison.dispose();
    assert.equal(f.workspace.diagnostics().leases, 0);
});

test("cancelled and empty whole-review reversions are inert and release explicit ownership", () => {
    const f = fixture(); assert.throws(() => f.comparison.beginReversion(), /unavailable/); ready(f.comparison);
    const cancelled = f.comparison.beginReversion(); cancelled.cancel(); cancelled.finish(); assert.equal(cancelled.complete(), false);
    const acceptance = f.comparison.beginAcceptance(); acceptance.complete({ buffer: acceptance.capture.working.buffer, version: "same" }); ready(f.comparison);
    const before = f.workspace.document(f.resource.documentId), history = f.workspace.observeHistory(f.resource.documentId).getSnapshot();
    assert.equal(f.comparison.beginReversion().complete(), true); assert.equal(f.workspace.document(f.resource.documentId), before); assert.deepEqual(f.workspace.observeHistory(f.resource.documentId).getSnapshot(), history);
    const pending = f.comparison.beginReversion(); f.comparison.dispose(); assert.equal(pending.complete(), false); assert.equal(f.workspace.diagnostics().leases, 0); assert.equal(f.workspace.diagnostics().subscriptions, 0);
});


test("comparison hunk reversion is revision-guarded, undoable and shared across views", () => {
    const { workspace, resource, reference, comparison, edit } = fixture(), sibling = workspace.createDocumentView(resource.documentId);
    const state = ready(comparison); assert.equal(state.hunks.length, 1); const hunk = comparison.hunkAt(0)!;
    comparison.view.setSelection(0, { anchor: 2, head: 4 });
    assert.equal(hunk.revert(), true);
    assert.equal(workspace.document(resource.documentId).buffer.equals(reference.buffer), true);
    assert.equal(sibling.getSnapshot().revision, 1);
    assert.equal(hunk.revert(), false);
    assert.equal(workspace.undo({ documentId: resource.documentId, expectedRevision: 1 }).applied, true);
    assert.deepEqual(comparison.view.getSnapshot().selection, { anchor: 2, head: 4, anchorAffinity: "after", headAffinity: "before" });
    ready(comparison); const stale = comparison.hunkAt(0)!; edit("later"); assert.equal(stale.revert(), false);
    assert.equal(reference.buffer.slice(0, reference.buffer.length), "first\nbaseline\nlast\n");
    sibling.dispose(); comparison.dispose(); assert.equal(workspace.diagnostics().leases, 0);
});

test("running comparisons map retained review hunks through consecutive edits without enabling stale actions", () => {
    const f = fixture("common tail\n".repeat(64));
    try {
        const exact = ready(f.comparison), hunk = f.comparison.hunkAt(0)!, original = exact.hunks, originalJson = JSON.stringify(original);
        let before = f.workspace.document(f.resource.documentId), prior = original;
        for (const edit of [{ from: 0, to: 0, insert: "prefix\n" }, { from: 14, to: 14, insert: "x" }, { from: 2, to: 7, insert: "\n" }]) {
            f.workspace.edit({ documentId: before.id, expectedRevision: before.revision, origin: "host", edits: [edit] });
            const running = f.comparison.getSnapshot(), after = f.workspace.document(before.id), map = after.change!.mapping;
            assert.equal(running.status, "running"); assert.equal(running.hunks.length, 1);
            const from = map.map(prior[0]!.working.from, "before").offset, to = map.map(prior[0]!.working.to, "after").offset;
            assert.deepEqual(running.hunks[0]!.working, { from, to, lineFrom: after.buffer.lineAt(from), lineTo: from === to ? after.buffer.lineAt(from) : after.buffer.lineAt(to - 1) + 1 });
            assert.equal(running.hunks[0]!.baseline, original[0]!.baseline);
            assert.equal(hunk.revert(), false); assert.equal(f.comparison.hunkAt(0), undefined);
            assert.throws(() => f.comparison.beginReversion(), /unavailable/);
            assert.ok(Object.isFrozen(running.hunks)); assert.ok(Object.isFrozen(running.hunks[0]!.working));
            prior = running.hunks; before = after;
        }
        const progress = f.comparison.advance(256); assert.equal(progress.status, "running"); assert.equal(progress.hunks, prior);
        assert.equal(JSON.stringify(original), originalJson);
        const final = ready(f.comparison); assert.notEqual(final.hunks, prior);
        const refresh = f.comparison.beginRefresh(); refresh.complete({ buffer: TextBuffer.from("replacement\n"), version: "other" });
        assert.deepEqual(f.comparison.getSnapshot().hunks, [], "old-baseline differences must never decorate a replacement reference");
    } finally { f.comparison.dispose(); assert.equal(f.workspace.diagnostics().subscriptions, 0); }
});

test("provisional hunk mapping preserves row coordinates and merges collapsed change boundaries", () => {
    const before = TextBuffer.from("a\nb\nc\nd\ne\n"), base = (from: number, to: number) => Object.freeze({ from, to, lineFrom: before.lineAt(from), lineTo: before.lineAt(to - 1) + 1 });
    const hunks = Object.freeze([0, 4, 8].map(at => Object.freeze({ baseline: base(at, at + 1), working: base(at, at + 1), whitespaceOnly: true })));
    for (const edits of [[{ from: 1, to: 1, insert: "\n" }], [{ from: 0, to: 1, insert: "\n" }], [{ from: 4, to: 8, insert: "" }],
        [{ from: 0, to: before.length, insert: "" }], [{ from: 1, to: 2, insert: "" }, { from: 3, to: 4, insert: "" }]]) {
        const change = before.apply(edits), mapped = mapComparisonHunks(before, before, change.buffer, change.mapping, hunks);
        let end = -1, lastLine = -1;
        for (const h of mapped) {
            assert.ok(h.working.from > end); end = h.working.to;
            assert.ok(h.working.lineFrom >= lastLine); lastLine = Math.max(h.working.lineFrom + 1, h.working.lineTo);
            assert.equal(h.working.lineFrom, change.buffer.lineAt(h.working.from));
            assert.equal(h.working.lineTo, change.buffer.lineAt(h.working.from === h.working.to ? h.working.to : h.working.to - 1) + (h.working.from === h.working.to ? 0 : 1));
        }
        if (edits[0]!.to === before.length) { assert.equal(mapped.length, 1); assert.equal(mapped[0]!.baseline.from, 0); assert.equal(mapped[0]!.baseline.to, 9); }
        if (edits.length === 2) { assert.equal(mapped.length, 2); assert.equal(mapped[0]!.working.from, 0); assert.equal(mapped[0]!.working.to, 3); }
    }
    const deletionPoint = Object.freeze({ baseline: base(4, 5), working: Object.freeze({ from: 4, to: 4, lineFrom: 2, lineTo: 2 }), whitespaceOnly: false });
    const joined = before.apply([{ from: 1, to: 4, insert: "" }]);
    const result = mapComparisonHunks(before, before, joined.buffer, joined.mapping, Object.freeze([hunks[0]!, deletionPoint]));
    assert.deepEqual(result[0]!.working, { from: 0, to: 1, lineFrom: 0, lineTo: 1 }, "a merged deletion marker must retain the preceding nonempty row");
    for (let from = 0; from <= before.length; from++) for (let to = from; to <= before.length; to++) for (const insert of ["", "\n", "x\r\ny"]) {
        const change = before.apply([{ from, to, insert }]);
        for (const ranges of [hunks, Object.freeze([hunks[0]!, deletionPoint, hunks[2]!]),
            Object.freeze(hunks.map(h => Object.freeze({ ...h, baseline: Object.freeze({ ...h.baseline, to: h.baseline.from, lineTo: h.baseline.lineFrom }) })))]) {
            const projected = mapComparisonHunks(before, before, change.buffer, change.mapping, ranges);
            for (const h of projected) for (const [buffer, r] of [[before, h.baseline], [change.buffer, h.working]] as const) {
                const context = JSON.stringify({ from, to, insert, r, side: buffer === before ? "baseline" : "working" });
                assert.equal(r.lineFrom, buffer.lineAt(r.from), context); assert.equal(r.lineTo, r.from === r.to ? r.lineFrom : buffer.lineAt(r.to - 1) + 1, context);
            }
        }
    }
});

test("comparison observes its document, policy and tab rather than unrelated workspace edits", () => {
    class ObservedWorkspace extends Workspace { reads = 0; override document(...args: Parameters<Workspace["document"]>) { this.reads++; return super.document(...args); } }
    const workspace = new ObservedWorkspace(), source = workspace.createTextResource({ scope: "review", resource: "own", variant: "source" }, "Own", { value: "working" });
    const other = workspace.createDocument({ scope: "review", resource: "other", variant: "source" }, "Other", "other");
    const tab = workspace.tabs.open({ kind: "text", documentId: source.documentId }, "main"), controller = compareText(workspace, tab, { buffer: TextBuffer.from("base"), version: "one" });
    try {
        const captured = ready(controller), hunk = controller.hunkAt(0)!; workspace.reads = 0;
        workspace.edit({ documentId: other, expectedRevision: 0, origin: "host", edits: [{ from: 0, to: 0, insert: "x" }] });
        assert.equal(workspace.reads, 0); assert.equal(controller.getSnapshot(), captured);
        workspace.setCapabilities(source.id, { edit: [], save: true }); assert.equal(hunk.revert(), false);
        workspace.tabs.close(tab); assert.equal(controller.getSnapshot().status, "expired");
    } finally { controller.dispose(); assert.equal(workspace.diagnostics().subscriptions, 0); }
});

test("refresh and acceptance preserve later typing, saved identity, history and explicit versions", () => {
    const { workspace, resource, comparison, edit } = fixture(); edit("before capture\n");
    const ticket = comparison.beginAcceptance(), captured = ticket.capture.working.buffer, history = workspace.observeHistory(resource.documentId).getSnapshot();
    edit("after capture\n"); const working = workspace.document(resource.documentId), view = comparison.view;
    assert.equal(ticket.complete({ buffer: captured, version: "reviewed-2" }), true);
    assert.equal(comparison.getSnapshot().baseline!.buffer, captured); assert.equal(comparison.getSnapshot().baseline!.version, "reviewed-2");
    assert.equal(workspace.document(resource.documentId), working); assert.equal(comparison.view, view);
    assert.equal(resource.metadata.getSnapshot().serverVersion, "saved-1"); assert.equal(resource.metadata.getSnapshot().dirty, true);
    assert.equal(workspace.observeHistory(resource.documentId).getSnapshot().undoDepth, history.undoDepth + 1);
    const refresh = comparison.beginRefresh(); edit("during refresh\n"); const later = workspace.document(resource.documentId);
    assert.equal(refresh.complete({ buffer: TextBuffer.from("new reference\r\n"), version: "reference-3" }), true);
    assert.equal(workspace.document(resource.documentId), later); assert.equal(ready(comparison).hunks.length > 0, true);
    assert.equal(ticket.complete({ buffer: captured, version: "duplicate" }), false);
    comparison.dispose(); assert.equal(workspace.diagnostics().leases, 0);
});

test("same-lane and cross-lane races reject stale tickets, permission changes reject acceptance", () => {
    const { workspace, resource, comparison } = fixture();
    const old = comparison.beginRefresh(), fresh = comparison.beginRefresh(), acceptance = comparison.beginAcceptance();
    assert.equal(old.isCurrent(), false); assert.equal(old.complete({ buffer: TextBuffer.from("old"), version: "old" }), false);
    assert.equal(fresh.complete({ buffer: TextBuffer.from("fresh"), version: "fresh" }), true);
    assert.equal(acceptance.complete({ buffer: acceptance.capture.working.buffer, version: "stale" }), false);
    const denied = comparison.beginAcceptance(); workspace.setCapabilities(resource.id, { edit: [], save: true });
    assert.equal(denied.complete({ buffer: denied.capture.working.buffer, version: "denied" }), false);
    assert.throws(() => comparison.beginAcceptance(), /unavailable/);
    const allowedRefresh = comparison.beginRefresh(); allowedRefresh.cancel(); allowedRefresh.finish(); assert.equal(allowedRefresh.isCurrent(), false);
    comparison.dispose(); assert.equal(workspace.diagnostics().leases, 0);
});

test("captured presentation survives moves, expires on replacement, and disposal releases tickets", () => {
    const { workspace, resource, tab, comparison } = fixture(), ticket = comparison.beginAcceptance();
    workspace.tabs.move(tab, "other"); assert.equal(ticket.isCurrent(), true);
    const other = workspace.createDocument({ scope: "test", resource: "other", variant: "source" }, "Other", "other");
    workspace.tabs.replace(tab, { kind: "text", documentId: other });
    assert.equal(comparison.getSnapshot().status, "expired"); assert.equal(comparison.getSnapshot().baseline, null);
    assert.equal(ticket.complete({ buffer: ticket.capture.working.buffer, version: "late" }), false);
    comparison.dispose(); comparison.dispose(); assert.equal(workspace.diagnostics().leases, 0);
    workspace.releaseResource(resource.id); assert.equal(workspace.document(other).buffer.slice(0, 5), "other");
});

test("supplied views remain owned by the host and buffer resources retain their identity", () => {
    const { workspace, resource, tab, reference, comparison } = fixture(); comparison.dispose();
    const view = workspace.createDocumentView(resource.documentId), controller = compareText(workspace, tab, reference, { view });
    controller.dispose(); assert.equal(workspace.ownsDocumentView(view), true); view.dispose();
    const buffer = TextBuffer.from("a\r\nb\n").replace(1, 1, "\t"), display = workspace.createTextResourceFromBuffer({ scope: "test", resource: "reference", variant: "display" }, "Reference", { buffer, serverVersion: "v1" }, { edit: [], save: false });
    assert.equal(workspace.document(display.documentId).buffer, buffer);
    for (const origin of ["human", "agent", "host"] as const) assert.equal(workspace.edit({ documentId: display.documentId, expectedRevision: 0, origin, edits: [{ from: 0, to: 0, insert: "bad" }] }).applied, false);
    workspace.releaseResource(display.id); assert.equal(workspace.diagnostics().leases, 0);
});

test("disposal cancels unfinished tickets and repeated long-line work without retaining workspace ownership", () => {
    const { workspace, resource, comparison } = fixture();
    workspace.edit({ documentId: resource.documentId, expectedRevision: 0, origin: "human", edits: [{ from: 0, to: 0, insert: "x".repeat(100000) }] });
    assert.equal(comparison.advance(512).status, "running");
    const refresh = comparison.beginRefresh(), acceptance = comparison.beginAcceptance();
    comparison.dispose(); assert.equal(workspace.diagnostics().leases, 0); assert.equal(workspace.diagnostics().subscriptions, 0);
    assert.equal(refresh.complete({ buffer: TextBuffer.from("late"), version: "late" }), false);
    assert.equal(acceptance.complete({ buffer: acceptance.capture.working.buffer, version: "late" }), false);
    assert.equal(comparison.advance().status, "disposed"); assert.equal(comparison.getSnapshot().working, null);
});

test("saving a captured revision changes the saved version independently of reference acceptance", () => {
    const { workspace, resource, comparison, edit } = fixture(); edit("captured\n");
    const acceptance = comparison.beginAcceptance(), save = workspace.captureSave(resource); save.start(); edit("later\n");
    save.accept({ serverVersion: "saved-2" }); save.finish();
    assert.equal(comparison.getSnapshot().baseline!.version, "reference-1");
    assert.equal(acceptance.capture.serverVersion, "saved-1");
    assert.equal(acceptance.complete({ buffer: acceptance.capture.working.buffer, version: "reference-2" }), true);
    assert.equal(resource.metadata.getSnapshot().serverVersion, "saved-2"); assert.equal(resource.metadata.getSnapshot().dirty, true);
    const revision = workspace.document(resource.documentId).revision;
    assert.equal(workspace.undo({ documentId: resource.documentId, expectedRevision: revision }).applied, true);
    assert.equal(resource.metadata.getSnapshot().dirty, false);
    assert.equal(comparison.getSnapshot().baseline!.version, "reference-2"); comparison.dispose();
});

test("notification commands reject reentrancy and a disposed supplied view expires cooperative work", () => {
    const { workspace, resource, tab, reference, comparison } = fixture();
    let refusal: unknown;
    const unsubscribe = comparison.subscribe(() => { try { comparison.beginRefresh(); } catch (error) { refusal = error; } });
    ready(comparison); assert.match(String(refusal), /Reentrant/); unsubscribe(); comparison.dispose();
    const view = workspace.createDocumentView(resource.documentId), controller = compareText(workspace, tab, reference, { view });
    view.dispose(); assert.equal(controller.advance().status, "expired"); assert.equal(controller.getSnapshot().baseline, null);
    controller.dispose(); assert.equal(workspace.diagnostics().leases, 0);
});
