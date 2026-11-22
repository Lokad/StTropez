import { editorState } from "./helpers/editor-state.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { createLspHighlightController } from "../src/browser/lsp-highlights.ts";
import type { TextEditor } from "../src/browser/text-editor.ts";
import { clientFixture, settled } from "./helpers/lsp-client.ts";
import { latch } from "./helpers/latch.ts";

test("occurrences coalesce refreshes and bound busy retries from the actual debounce turn", { timeout: 10000 }, async t => {
    for (const delay of [undefined, 37]) {
        const f = clientFixture(t), tab = f.workspace.tabs.open({ kind: "text", documentId: f.source.documentId }, "source"), view = f.workspace.createDocumentView(f.source.documentId);
        f.peer.onRequest("textDocument/documentHighlight", () => [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } }]);
        await f.provider.connect();
        const tasks = new Map<number, { run: () => void; delay: number }>(); let serial = 0, time = 0, busy = true;
        const owner = { defaultView: { performance: { now: () => time },
            setTimeout: (run: () => void, delay: number) => { tasks.set(++serial, { run, delay }); return serial; },
            clearTimeout: (id: number) => { tasks.delete(id); } } };
        const editor = { signal: new AbortController().signal, workspace: f.workspace, tab: f.workspace.tabs.capture(tab), view, ...editorState({ focused: true }), element: Object.assign(new EventTarget(), { ownerDocument: owner }),
            activity: () => ({ disposed: false, composing: false, pendingCommand: busy }) } as unknown as TextEditor;
        const fire = (delay: number, elapsed = delay) => {
            assert.equal(tasks.size, 1); const [id, task] = tasks.entries().next().value!;
            assert.equal(task.delay, delay); assert.ok(elapsed >= delay); tasks.delete(id); time += elapsed; task.run();
        };
        const controller = createLspHighlightController(editor, { provider: f.provider, ...(delay === undefined ? {} : { delayMs: delay }) });
        let stopReady = () => {};
        try {
            controller.refresh(); controller.refresh(); assert.equal(tasks.size, 1);
            // A delayed event loop must not consume the busy deadline before its first turn.
            fire(delay ?? 150, 10000); assert.equal(f.sent("textDocument/documentHighlight").length, 0);
            fire(16, 4984); assert.equal(tasks.size, 1);
            fire(16); assert.equal(tasks.size, 0); assert.equal(controller.getSnapshot().status, "idle");
            assert.equal(f.sent("textDocument/documentHighlight").length, 0);
            const published = new Promise<void>(resolve => { stopReady = controller.subscribe(() => {
                if (controller.getSnapshot().status === "ready") resolve();
            }); });
            busy = false; controller.refresh(); fire(delay ?? 150); await published; stopReady();
            assert.equal(f.sent("textDocument/documentHighlight").length, 1);
            assert.equal(controller.getSnapshot().status, "ready");
            assert.deepEqual(controller.getSnapshot().items, [{ from: 0, to: 5, kind: "text" }]);
            const painted = controller.getSnapshot().items, move = (head: number) => view.setSelection(f.document().revision, { anchor: head, head });
            move(2); move(4);
            assert.equal(controller.getSnapshot().items, painted);
            assert.equal(controller.getSnapshot().caret, 4);
            assert.deepEqual(controller.intersect(0, 5), painted);
            assert.equal(tasks.size, 0);
            move(5); assert.equal(controller.getSnapshot().items.length, 0);
            const reply = latch<unknown>(), entered = latch<void>();
            f.peer.onRequest("textDocument/documentHighlight", () => { entered.resolve(); return reply.promise; });
            move(7); fire(delay ?? 150); await entered.promise;
            assert.equal(controller.getSnapshot().status, "pending"); assert.deepEqual(controller.intersect(0, 10), []);
            f.edit(); reply.resolve([{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 10 } } }]);
            await settled(); assert.equal(controller.getSnapshot().items.length, 0);
            controller.refresh(); assert.equal(tasks.size, 1);
        } finally { stopReady(); controller.dispose(); view.dispose(); f.workspace.tabs.close(tab); await f.provider.flush(); }
        assert.equal(tasks.size, 0); assert.equal(f.workspace.diagnostics().leases, 0);
    }
});
