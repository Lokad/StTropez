import { editorState } from "./helpers/editor-state.ts";
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHoverController } from "../src/browser/index.ts";
import type { TextEditor } from "../src/browser/index.ts";
import { latch } from "./helpers/latch.ts";
import { clientFixture, settled } from "./helpers/lsp-client.ts";

async function fixture(t: TestContext, text: string) {
    const f = clientFixture(t), { workspace, provider } = f, documentId = f.source.documentId;
    workspace.edit({ documentId, expectedRevision: f.document().revision, origin: "human", edits: [{ from: 0, to: f.document().buffer.length, insert: text }] });
    const tab = workspace.tabs.open({ kind: "text", documentId }, "left"), view = workspace.createDocumentView(documentId);
    const timers = new Map<number, () => void>(); let serial = 0;
    const owner = { defaultView: { setTimeout: (work: () => void) => { timers.set(++serial, work); return serial; }, clearTimeout: (id: number) => timers.delete(id) } };
    const editor = { workspace, tab: workspace.tabs.capture(tab), view, signal: new AbortController().signal,
        element: { ownerDocument: owner, isConnected: true }, ...editorState(),
        activity: () => ({ composing: false, disposed: false }), focus: () => { throw new Error("Hover moved focus."); } } as unknown as TextEditor;
    const scope = provider.createScope(); scope.attachDocument(documentId); await provider.connect(); await settled();
    const hover = createHoverController(editor, provider), leases = workspace.diagnostics().leases;
    const request = (offset: number) => hover.request({ revision: f.document().revision, offset });
    function hold() {
        const entered = latch<void>(), answer = latch<unknown>();
        f.peer.onRequest("textDocument/hover", () => { entered.resolve(); return answer.promise; });
        return { entered: entered.promise, reply: answer.resolve };
    }
    const finish = async () => {
        hover.dispose(); scope.dispose(); view.dispose(); workspace.tabs.close(tab); await settled();
        assert.equal(timers.size, 0); assert.equal(workspace.diagnostics().leases, 0);
        assert.equal(provider.snapshot().scopes, 0);
    };
    return { ...f, hover, request, hold, view, tab, timers, leases, finish };
}
test("hover releases the read lease after a reply with no range and expires on disconnect", async t => {
    const f = await fixture(t, "const value"), before = f.document();
    try {
        const wire = f.hold(); assert.equal(f.request(2), true); await wire.entered;
        wire.reply({ contents: { kind: "plaintext", value: "<img> literal" } }); await settled();
        assert.equal(f.hover.getSnapshot().status, "ready"); assert.equal(f.hover.getSnapshot().range, null);
        assert.equal(f.hover.getSnapshot().text, "<img> literal"); assert.equal(f.workspace.diagnostics().leases, f.leases);
        f.provider.disconnect(); await settled(); assert.equal(f.hover.getSnapshot().status, "expired");
        assert.equal(f.document(), before);
    } finally { await f.finish(); }
});
test("deferred hover invalidation preserves a newer request after editing and releases obsolete leases", async t => {
    const f = await fixture(t, "const café");
    try {
        const first = f.hold(); f.request(1); await first.entered;
        f.edit(); const second = f.hold(); assert.equal(f.request(2), true); await second.entered;
        assert.equal(f.hover.getDiagnostics().pending, true); assert.equal(f.workspace.diagnostics().leases, f.leases + 1);
        assert.equal(f.sent("$/cancelRequest").length, 1); first.reply({ contents: "obsolete" }); await settled();
        assert.equal(f.hover.getSnapshot().status, "pending");
        second.reply({ contents: "current" }); await settled(); assert.equal(f.hover.getSnapshot().text, "current");
        const selection = f.hold(); f.request(2); await selection.entered;
        f.view.setSelection(f.document().revision, { anchor: 8, head: 8 }); await settled();
        assert.equal(f.hover.getSnapshot().status, "expired"); assert.equal(f.workspace.diagnostics().leases, f.leases);
        selection.reply({ contents: "wrong selection" });
        const tab = f.hold(); f.request(8); await tab.entered;
        f.workspace.tabs.replace(f.tab, { kind: "panel", resourceId: f.source.id, panelType: "configuration" }); await settled();
        assert.equal(f.hover.getSnapshot().status, "expired"); assert.equal(f.request(8), false);
        assert.equal(f.sent("$/cancelRequest").length, 3); tab.reply({ contents: "old tab" }); await settled();
    } finally { await f.finish(); }
});

test("a hover deadline releases its capture and cancels the held provider request", async t => {
    const f = await fixture(t, "const value");
    try {
        const held = f.hold();
        assert.ok(f.request(2));
        await held.entered;
        const [timeout] = f.timers.values();
        assert.ok(timeout);
        timeout();
        assert.equal(f.hover.getSnapshot().status, "failed");
        assert.equal(f.workspace.diagnostics().leases, f.leases);
        assert.equal(f.hover.getDiagnostics().pending, false);
        assert.equal(f.sent("$/cancelRequest").length, 1);
        held.reply({ contents: "Too late" });
        await settled();
        assert.equal(f.hover.getSnapshot().status, "failed");
    } finally { await f.finish(); }
});
test("folding cancels a held hover and reveals the range on selection", async t => {
    const f = await fixture(t, "const alpha\r\nconst beta\r\nend");
    try {
        const folds = f.view.folding, doc = f.document(), offset = doc.buffer.offsetAt(1) + 2;
        folds.setRanges(folds.getSnapshot(), [{ id: "body", from: 0, to: doc.buffer.offsetAt(2) }]);
        const first = f.hold(); f.request(2); await first.entered;
        folds.setCollapsed(folds.getSnapshot(), "body", true); await settled();
        assert.equal(f.hover.getSnapshot().status, "expired"); assert.equal(f.workspace.diagnostics().leases, f.leases);
        assert.equal(f.sent("$/cancelRequest").length, 1); assert.equal(f.request(offset), false);
        f.view.setSelection(doc.revision, { anchor: offset, head: offset });
        assert.equal(folds.getSnapshot().regions[0]!.collapsed, false);
        const second = f.hold(); assert.equal(f.request(offset), true); await second.entered;
        first.reply({ contents: "folded" }); await settled(); assert.equal(f.hover.getSnapshot().status, "pending");
        second.reply({ contents: "revealed" }); await settled(); assert.equal(f.hover.getSnapshot().text, "revealed");
    } finally { await f.finish(); }
});
