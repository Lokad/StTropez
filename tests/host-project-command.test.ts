import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { DocumentSnapshot } from "../src/index.ts";
import { attachEditorLanguage, type TextEditor } from "../src/browser/index.ts";
import { createLspCommandRunner } from "../src/protocol/index.ts";
import { HostProjectTools, type ProjectActionEditPolicy } from "../examples/hosts/project.ts";
import { waitForState } from "./helpers/latch.ts";
import { editorState } from "./helpers/editor-state.ts";
import { clientFixture, settled } from "./helpers/lsp-client.ts";

function fixture(t: TestContext, policy: ProjectActionEditPolicy) {
    let companion: DocumentSnapshot;
    const f = clientFixture(t, undefined, async uri =>
        uri === companion.language?.uri ? { document: companion } : undefined);
    const { workspace, provider, source, other } = f;
    companion = workspace.document(other.documentId);
    const tab = workspace.tabs.open({ kind: "text", documentId: source.documentId }, "source");
    const view = workspace.createDocumentView(source.documentId);
    const editor = { workspace, tab: workspace.tabs.capture(tab), view, ...editorState(), signal: new AbortController().signal,
        activity: () => ({ disposed: false }),
        element: Object.assign(new EventTarget(), { isConnected: true, ownerDocument: { defaultView: globalThis } }) } as unknown as TextEditor;
    const host = new HostProjectTools({ workspace, canCapture: () => true, present: () => editor }, undefined, provider, policy);
    let detach = host.attach("source", tab, editor);
    return { ...f, editor, view, host, companion,
        remount() {
            detach();
            detach = host.attach("source", tab, editor);
        },
        dispose() {
            detach();
            host.dispose();
            view.dispose();
            workspace.tabs.close(tab);
        },
    };
}

test("a command acknowledges a batch with a newly resolved companion and undoes both files together", async t => {
    const { workspace, provider, document, editor, host, companion, dispose } = fixture(t, () => "apply");
    const session = provider.createScope(), runner = createLspCommandRunner(session);
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
        runner.dispose(); session.dispose(); dispose();
    }
    await settled();
    assert.equal(workspace.diagnostics().leases, 0);
});

const registration = { id: "review", method: "workspace/executeCommand", registerOptions: { commands: ["fixture.review"] } };
type CommandFixture = ReturnType<typeof fixture>;
const interruptions = {
    selection: (f: CommandFixture) => f.view.setSelection(f.document().revision, { anchor: 3, head: 3 }),
    authority: (f: CommandFixture) => f.workspace.acquireEditLease(f.other.id, "review", "host").release(),
    typing: (f: CommandFixture) => f.edit(),
    remount: (f: CommandFixture) => f.remount(),
    withdrawal: (f: CommandFixture) => f.peer.sendRequest("client/unregisterCapability", {
        unregisterations: [{ id: registration.id, method: registration.method }],
    }),
    disconnect: (f: CommandFixture) => f.provider.disconnect(),
    dismissal: (_f: CommandFixture, cancel: () => void) => cancel(),
};

for (const [cause, interrupt] of Object.entries(interruptions)) {
    test(`an expired command review preserves the initial undo after ${cause}`, { timeout: 5000 }, async t => {
        const f = fixture(t, () => "review");
        const { codeActions: actions, dispose } = attachEditorLanguage(f.editor, f.provider, { codeActions: {
            documents: () => [f.document(), f.companion],
            runCommand: command => f.host.beginAction({ ...command, editor: f.editor }),
        } });
        const origin = f.document();
        const at = { line: 0, character: 0 };
        const insert = (text: string) => [{ range: { start: at, end: at }, newText: text }];
        const sourceUri = origin.language!.uri;
        const otherUri = f.companion.language!.uri;
        t.after(() => {
            dispose();
            f.dispose();
        });
        await f.provider.connect();
        await f.peer.sendRequest("client/registerCapability", { registrations: [registration] });
        f.peer.onRequest("textDocument/codeAction", () => [{
            title: "Annotate", edit: { changes: { [sourceUri]: insert("first ") } },
            command: { title: "Review companion", command: "fixture.review" },
        }]);
        let decision: { applied: boolean } | undefined;
        f.peer.onRequest("workspace/executeCommand", async () => {
            decision = await f.peer.sendRequest<{ applied: boolean }>("workspace/applyEdit", {
                edit: { changes: { [otherUri]: insert("late ") } },
            });
            return null;
        });
        actions.request();
        await waitForState(actions, state => state.status !== "pending");
        const preview = actions.getSnapshot().preview;
        assert.ok(preview?.canApply, actions.getSnapshot().message);
        assert.equal(preview.confirm().status, "executing");
        await waitForState(f.host.state, state => state.review !== null || !state.pending);
        const review = f.host.state.getSnapshot().review;
        assert.ok(review?.canApply, f.host.state.getSnapshot().message);
        const committed = f.document();
        assert.equal(committed.buffer.slice(0, 6), "first ");

        await interrupt(f, actions.cancel);
        await settled();
        assert.equal(f.host.state.getSnapshot().review, null);
        review.apply();
        await settled();
        if (cause !== "disconnect") assert.equal(decision?.applied, false);
        assert.equal(f.workspace.document(f.companion.id).buffer, f.companion.buffer);
        const undo = () => f.workspace.undo({ documentId: origin.id, expectedRevision: f.document().revision });
        if (cause === "typing") assert.ok(undo().applied);
        assert.equal(f.document().buffer, committed.buffer);
        assert.ok(undo().applied);
        assert.equal(f.document().buffer, origin.buffer);
    });
}
