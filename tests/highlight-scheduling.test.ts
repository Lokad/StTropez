import assert from "node:assert/strict";
import test from "node:test";
import { createLspHighlightController } from "../src/browser/lsp-highlights.ts";
import type { EditingCandidate } from "../src/browser/editing-candidate.ts";
import { clientFixture } from "./helpers/lsp-client.ts";

test("occurrences coalesce refreshes and bound busy retries from the actual debounce turn", { timeout: 10000 }, async t => {
    for (const delay of [undefined, 37]) {
        const f = clientFixture(t), tab = f.workspace.open({ kind: "text", documentId: f.source.documentId }, "source"), view = f.workspace.createDocumentView(f.source.documentId);
        f.peer.onRequest("textDocument/documentHighlight", () => [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } }]);
        await f.provider.connect();
        const tasks = new Map<number, { run: () => void; delay: number }>(); let serial = 0, time = 0, busy = true;
        const input = new EventTarget(), owner = { activeElement: input, defaultView: { performance: { now: () => time },
            setTimeout: (run: () => void, delay: number) => { tasks.set(++serial, { run, delay }); return serial; },
            clearTimeout: (id: number) => { tasks.delete(id); } } };
        Object.assign(input, { getRootNode: () => owner });
        const editor = { view, input, element: Object.assign(new EventTarget(), { ownerDocument: owner }),
            activity: () => ({ disposed: false, composing: false, pendingCommand: busy }) } as unknown as EditingCandidate;
        const fire = (delay: number, elapsed = delay) => {
            assert.equal(tasks.size, 1); const [id, task] = tasks.entries().next().value!;
            assert.equal(task.delay, delay); assert.ok(elapsed >= delay); tasks.delete(id); time += elapsed; task.run();
        };
        const controller = createLspHighlightController(f.workspace, tab, editor, { provider: f.provider, ...(delay === undefined ? {} : { delayMs: delay }) });
        let stopReady = () => {};
        try {
            controller.refresh(); controller.refresh(); assert.equal(tasks.size, 1);
            // A delayed event loop must not consume the busy deadline before its first turn.
            fire(delay ?? 150, 10000); assert.equal(f.sent("textDocument/documentHighlight").length, 0);
            fire(16, 4984); assert.equal(tasks.size, 1);
            fire(16); assert.equal(tasks.size, 0); assert.equal(controller.state.getSnapshot().status, "idle");
            assert.equal(f.sent("textDocument/documentHighlight").length, 0);
            const published = new Promise<void>(resolve => { stopReady = controller.state.subscribe(() => {
                if (controller.state.getSnapshot().status === "ready") resolve();
            }); });
            busy = false; controller.refresh(); fire(delay ?? 150); await published; stopReady();
            assert.equal(f.sent("textDocument/documentHighlight").length, 1);
            assert.equal(controller.state.getSnapshot().status, "ready");
            assert.deepEqual(controller.state.getSnapshot().items, [{ from: 0, to: 5, kind: "text" }]);
            controller.refresh(); assert.equal(tasks.size, 1);
        } finally { stopReady(); controller.dispose(); view.dispose(); f.workspace.close(tab); await f.provider.flush(); }
        assert.equal(tasks.size, 0); assert.equal(f.workspace.diagnostics().leases, 0);
    }
});
