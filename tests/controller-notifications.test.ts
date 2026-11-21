import test from "node:test";
import assert from "node:assert/strict";
import { createFoldingController } from "../src/browser/folding-controller.ts";
import { createLspHighlightController } from "../src/browser/lsp-highlights.ts";
import type { TextEditor } from "../src/browser/text-editor.ts";
import { clientFixture } from "./helpers/lsp-client.ts";

for (const kind of ["folding", "highlights"] as const) test(`${kind} commands reject listener reentry while internal revision refresh remains available`, t => {
    const f = clientFixture(t), tab = f.workspace.tabs.open({ kind: "text", documentId: f.source.documentId }, "source"), view = f.workspace.createDocumentView(f.source.documentId);
    const tasks = new Map<number, () => void>(); let serial = 0;
    const owner = { defaultView: { performance, setTimeout: (work: () => void) => { tasks.set(++serial, work); return serial; }, clearTimeout: (id: number) => tasks.delete(id) } };
    const editor = { signal: new AbortController().signal, workspace: f.workspace, tab: f.workspace.tabs.capture(tab), view, element: Object.assign(new EventTarget(), { ownerDocument: owner }), input: Object.assign(new EventTarget(), { getRootNode: () => owner }),
        activity: () => ({ disposed: false, composing: false }), viewport: { revealOffset: () => {} }, focus: () => {} } as unknown as TextEditor;
    const controller = kind === "folding" ? createFoldingController(editor, () => [])
        : createLspHighlightController(editor, { provider: f.provider });
    const commands = [controller.refresh, controller.dispose];
    if ("runCommand" in controller) commands.push(() => { controller.runCommand("collapse"); });
    let attempted = false, rejected = 0; const unexpected: unknown[] = [];
    const stop = controller.subscribe(() => {
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
    } finally { stop(); controller.dispose(); view.dispose(); f.workspace.tabs.close(tab); }
    assert.equal(tasks.size, 0); assert.equal(f.workspace.diagnostics().leases, 0);
});
