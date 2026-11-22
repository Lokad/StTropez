import test from "node:test";
import assert from "node:assert/strict";
import type { DocumentSnapshot } from "../src/index.ts";
import type { TextEditor } from "../src/browser/index.ts";
import { createLspCommandRunner } from "../src/protocol/index.ts";
import { HostProjectTools } from "../examples/hosts/project.ts";
import { editorState } from "./helpers/editor-state.ts";
import { clientFixture, settled } from "./helpers/lsp-client.ts";

test("a command acknowledges a batch with a newly resolved companion and undoes both files together", async t => {
    let companion: DocumentSnapshot;
    const { workspace, provider, source, other, document } = clientFixture(t, undefined, async uri =>
        uri === companion.language?.uri ? { document: companion } : undefined);
    companion = workspace.document(other.documentId);
    const tab = workspace.tabs.open({ kind: "text", documentId: source.documentId }, "source");
    const view = workspace.createDocumentView(source.documentId);
    const editor = { workspace, tab: workspace.tabs.capture(tab), view, ...editorState(), activity: () => ({ disposed: false }),
        element: Object.assign(new EventTarget(), { isConnected: true, ownerDocument: { defaultView: globalThis } }) } as unknown as TextEditor;
    const host = new HostProjectTools({ workspace, canCapture: () => true, present: () => editor }, undefined, provider, () => "apply");
    const stop = host.attach("source", tab, editor), session = provider.createScope(), runner = createLspCommandRunner(session);
    try {
        await session.ensureConnected();
        const original = document();
        const at = { line: 0, character: 0 }, edits = [{ range: { start: at, end: at }, newText: "// note\n" }];
        const command = host.beginAction({ editor, documents: [original], edit: null,
            isCurrent: () => true, subscribe: () => () => {}, cancel: () => {},
            execute: scope => runner.runAuthorized({ command: "host.annotate", title: "Annotate companion", arguments: [] }, scope, {
                kind: "host", run: async (_invocation, context) => {
                    const result = await context.applyEdit({ edit: { changes: {
                        [original.language!.uri]: edits, [companion.language!.uri]: edits
                    } } });
                    assert.equal(result.applied, true, result.failureReason ?? "The command edit was refused.");
                    return "Annotated companion.";
                }
            }) });
        assert.ok(command);
        const result = await command.result;
        const after = workspace.document(companion.id);
        assert.equal(after.buffer.slice(0, 8), "// note\n");
        assert.equal(document().buffer.slice(0, 8), "// note\n");
        assert.equal(result.success, true, result.reason);
        assert.equal(result.applied, true);
        assert.deepEqual(result.changes.map(change => change.document).sort(), [original.id, companion.id].sort());
        assert.ok(workspace.undo({ documentId: companion.id, expectedRevision: after.revision }).applied);
        assert.equal(workspace.document(companion.id).buffer, companion.buffer);
        assert.equal(document().buffer, original.buffer);
    } finally {
        runner.dispose(); session.dispose(); stop(); host.dispose(); view.dispose();
    }
    await settled();
    assert.equal(workspace.diagnostics().leases, 0);
});
