import test from "node:test";
import assert from "node:assert/strict";
import { Workspace } from "../src/index.ts";
import type { TextEditor } from "../src/browser/index.ts";
import { HostTablePaste } from "../examples/shared/table-paste.ts";
import { captureInsertion } from "../src/browser/captured-insertion.ts";

function fixture() {
    const workspace = new Workspace(), source = workspace.createTextResource({ scope: "table", resource: "source", variant: "working" }, "Source", { value: "abc\r\nxyz" });
    const view = workspace.createDocumentView(source.id), peer = workspace.createDocumentView(source.id);
    const timers = new Map<number, () => void>(); let serial = 0, composing = false;
    const owner = { defaultView: { performance, setTimeout: (work: () => void) => { timers.set(++serial, work); return serial; }, clearTimeout: (id: number) => timers.delete(id) }, activeElement: null };
    const editor = { workspace, view, signal: new AbortController().signal,
        element: { ownerDocument: owner }, registerPasteHandler: () => () => {},
        captureInsertion: () => captureInsertion(editor, () => !composing,
            (plan, revision) => workspace.edit({ documentId: source.id, expectedRevision: revision, edits: plan.edits, selectionSet: plan.selectionSet, origin: "human", view, history: { kind: "paste" } }).status === "done", () => {}),
        focus: () => { throw new Error("Table paste must not focus a later editor."); } } as unknown as TextEditor;
    const tools = new HostTablePaste(), detach = tools.attach("primary", editor); tools.setEnabled(true);
    const text = () => { const b = workspace.document(source.id).buffer; return b.slice(0, b.length); };
    const paste = (plain: string) => tools.insertTable("primary", plain);
    const turn = () => { const entry = timers.entries().next().value; if (entry) { timers.delete(entry[0]); entry[1](); } };
    const drain = () => { let steps = 0; while (timers.size) { turn(); if (++steps > 1000) throw new Error("Conversion did not finish."); } };
    return { workspace, source, view, peer, tools, paste, drain, turn, timers, text, detach, setComposing: (value: boolean) => { composing = value; },
        finish: () => { detach(); view.dispose(); peer.dispose(); workspace.releaseResource(source.id, true); assert.equal(timers.size, 0); assert.deepEqual({ views: workspace.diagnostics().views, leases: workspace.diagnostics().leases, subscriptions: workspace.diagnostics().subscriptions }, { views: 0, leases: 0, subscriptions: 0 }); } };
}
test("captured table paste replaces every range in one shared undo transaction without taking focus", () => {
    const f = fixture(); try {
        f.view.setSelections(0, [{ anchor: 1, head: 0 }, { anchor: 8, head: 7 }], 1); const selected = f.view.getSnapshot().selectionSet, leases = f.workspace.diagnostics().leases;
        f.paste('A\tB\r\n1\t"2"'); assert.equal(f.text(), "abc\r\nxyz"); assert.equal(f.workspace.diagnostics().leases, leases + 1); f.drain();
        assert.equal(f.tools.state.getSnapshot().status, "applied"); assert.equal(f.text(), '"A","B"\r\n"1","2"bc\r\nxy"A","B"\r\n"1","2"');
        assert.equal(f.workspace.observeHistory(f.source.id).getSnapshot().undoDepth, 1); assert.equal(f.view.getSnapshot().selectionSet.ranges.length, 2);
        assert.equal(f.workspace.diagnostics().leases, leases); assert.equal(f.workspace.diagnostics().subscriptions, 0);
        f.workspace.undo({ documentId: f.source.id, expectedRevision: 1 }); assert.equal(f.text(), "abc\r\nxyz"); assert.deepEqual(f.view.getSnapshot().selectionSet, selected);
        f.workspace.redo({ documentId: f.source.id, expectedRevision: 2 }); assert.equal(f.view.getSnapshot().selectionSet.ranges.length, 2);
    } finally { f.finish(); }
});
test("revoking edit permission cancels a pending conversion even after permission returns", async () => {
    const f = fixture();
    try {
        f.paste("x".repeat(20000) + "\tend");
        f.turn();
        assert.equal(f.tools.state.getSnapshot().status, "converting");
        const original = f.source.metadata.getSnapshot().capabilities;
        f.workspace.setCapabilities(f.source.id, { edit: ["host"], save: true });
        f.workspace.setCapabilities(f.source.id, original);
        await Promise.resolve();
        f.drain();
        assert.equal(f.text(), "abc\r\nxyz");
        assert.equal(f.tools.state.getSnapshot().status, "cancelled");
        assert.equal(f.workspace.observeHistory(f.source.id).getSnapshot().undoDepth, 0);
        f.paste("fresh\tvalue");
        f.drain();
        assert.equal(f.tools.state.getSnapshot().status, "applied");
    } finally { f.finish(); }
});

test("edits, away-and-back selections, new paste, fold changes and detach expire captured targets", async () => {
    for (const kind of ["edit", "selection", "fold", "detach"] as const) {
        const f = fixture(); try {
            f.paste("old\tvalue");
            if (kind === "edit") f.workspace.edit({ documentId: f.source.id, expectedRevision: 0, origin: "host", edits: [{ from: 8, to: 8, insert: "!" }] });
            if (kind === "selection") { f.view.setSelection(0, { anchor: 1, head: 1 }); f.view.setSelection(0, { anchor: 0, head: 0 }); }
            if (kind === "fold") f.view.folding.setRanges(f.view.folding.getSnapshot(), [{ id: "body", from: 0, to: 8, collapsed: true }]);
            if (kind === "detach") f.detach();
            await Promise.resolve(); f.drain(); assert.equal(f.text(), kind === "edit" ? "abc\r\nxyz!" : "abc\r\nxyz"); assert.equal(f.tools.state.getSnapshot().status, "cancelled");
        } finally { f.finish(); }
    }
    const f = fixture(); try { f.paste('old\tvalue'); f.paste('new\tvalue'); await Promise.resolve(); f.drain(); assert.equal(f.text(), '"new","value"abc\r\nxyz'); } finally { f.finish(); }
});
test("invalid/empty tables, composition and explicit cancellation preserve text and history", () => {
    const f = fixture(); try {
        f.paste("a\tb\nc"); f.drain(); assert.equal(f.tools.state.getSnapshot().status, "failed"); assert.equal(f.text(), "abc\r\nxyz");
        f.paste(""); f.drain(); assert.equal(f.text(), "abc\r\nxyz"); assert.equal(f.workspace.observeHistory(f.source.id).getSnapshot().undoDepth, 0);
        f.setComposing(true); f.paste("a\tb"); f.drain(); assert.equal(f.tools.state.getSnapshot().status, "failed"); f.setComposing(false);
        f.paste("a\tb"); f.tools.cancel(); f.drain(); assert.equal(f.text(), "abc\r\nxyz");
    } finally { f.finish(); }
});

test("aggregate multi-range expansion is refused before publishing any source or selection change", () => {
    const f = fixture(); try {
        f.view.setSelections(0, Array.from({ length: 9 }, (_, head) => ({ anchor: head, head })), 3); const selections = f.view.getSnapshot().selectionSet;
        f.paste("x".repeat(500_000)); f.drain(); assert.equal(f.tools.state.getSnapshot().status, "failed"); assert.match(f.tools.state.getSnapshot().message, /aggregate/);
        assert.equal(f.text(), "abc\r\nxyz"); assert.equal(f.view.getSnapshot().selectionSet, selections); assert.equal(f.workspace.observeHistory(f.source.id).getSnapshot().undoDepth, 0);
    } finally { f.finish(); }
});
