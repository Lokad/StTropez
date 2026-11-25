import { editorState } from "./helpers/editor-state.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { createFoldingController } from "../src/browser/folding-controller.ts";
import { createCommandRegistry } from "../src/browser/command-registry.ts";
import { attachEditorLanguage } from "../src/browser/index.ts";
import { createDecorationLayers } from "../src/browser/decoration-layers.ts";
import type { TextEditor } from "../src/browser/text-editor.ts";
import { clientFixture } from "./helpers/lsp-client.ts";

for (const kind of ["folding", "highlights"] as const) test(`${kind} commands reject listener reentry while internal revision refresh remains available`, async t => {
    const f = clientFixture(t), tab = f.workspace.tabs.open({ kind: "text", documentId: f.source.documentId }, "source"), view = f.workspace.createDocumentView(f.source.documentId);
    const tasks = new Map<number, () => void>(); let serial = 0;
    const owner = { defaultView: { performance, setTimeout: (work: () => void) => { tasks.set(++serial, work); return serial; }, clearTimeout: (id: number) => tasks.delete(id) } };
    const registry = createCommandRegistry(false, () => true, () => () => true, () => editor);
    if (kind === "folding") {
        const before = f.workspace.document(view.documentId);
        f.workspace.edit({ documentId: before.id, expectedRevision: before.revision, edits: [{ from: 0, to: 0, insert: "head\nbody\n" }], origin: "host" });
        view.folding.setRanges(view.folding.getSnapshot(), [{ id: "block", from: 0, to: 10 }]);
    }
    const layers = createDecorationLayers(f.document, () => {}, () => true);
    const lifetime = new AbortController();
    const editor = { decorations: layers.handle, commands: registry.commands, keymap: registry.keymap, signal: lifetime.signal, workspace: f.workspace, tab: f.workspace.tabs.capture(tab), view, element: Object.assign(new EventTarget(), { ownerDocument: owner }), ...editorState(),
        activity: () => ({ disposed: false, composing: false }), viewport: { revealRange: () => {} }, focus: () => {} } as unknown as TextEditor;
    const controller = kind === "folding" ? createFoldingController(editor, () => [])
        : attachEditorLanguage(editor, f.provider, { occurrences: {} }).occurrences;
    const commands = [controller.refresh, controller.dispose];
    if (kind === "folding") commands.push(() => { editor.commands.run("fold.collapse-all"); });
    let attempted = false, rejected = 0, closed = 0;
    const unexpected: unknown[] = [];
    const stop = controller.subscribe(() => {
        if (controller.getSnapshot().status === "disposed") closed++;
        if (attempted) return; attempted = true;
        for (const command of commands) try { command(); } catch (error) {
            if (error instanceof Error && /Reentrant mutation/.test(error.message)) rejected++; else unexpected.push(error);
        }
    });
    try {
        controller.refresh(); assert.equal(rejected, commands.length); assert.deepEqual(unexpected, []);
        const before = controller.getSnapshot(); assert.notEqual(before.status, "disposed");
        f.edit(); assert.notEqual(controller.getSnapshot(), before);
        assert.notEqual(controller.getSnapshot().status, "disposed");
    } finally { lifetime.abort(); stop(); layers.dispose(); view.dispose(); f.workspace.tabs.close(tab); }
    assert.equal(controller.getSnapshot().status, "disposed");
    assert.equal(closed, 1);
    assert.throws(() => controller.subscribe(() => {}), /disposed/);
    await Promise.resolve(); // The provider releases the document lease after observer delivery.
    assert.equal(tasks.size, 0); assert.equal(f.workspace.diagnostics().leases, 0);
});
