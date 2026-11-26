import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { DocumentSnapshot } from "../src/index.ts";
import { attachEditorLanguage, type TextEditor } from "../src/browser/index.ts";
import { HostProjectTools } from "./fixtures/hosts/project.ts";
import { latch, waitForState } from "./helpers/latch.ts";
import { editorState } from "./helpers/editor-state.ts";
import { clientFixture, settled } from "./helpers/lsp-client.ts";

function fixture(t: TestContext) {
    let companion: DocumentSnapshot;
    const f = clientFixture(t, undefined, async uri =>
        uri === companion.language?.uri ? { document: companion } : undefined);
    const { workspace, provider, source, other } = f;
    companion = workspace.document(other.documentId);
    const tab = workspace.tabs.open({ kind: "text", documentId: source.documentId }, "source");
    const view = workspace.createDocumentView(source.documentId);
    const editor = { workspace, tab: workspace.tabs.capture(tab), view, ...editorState(), signal: new AbortController().signal,
        activity: () => ({ disposed: false, input: "idle" }), viewport: { revealOffset() {} }, focus() {},
        element: Object.assign(new EventTarget(), { isConnected: true, ownerDocument: { defaultView: globalThis } }) } as unknown as TextEditor;
    const host = new HostProjectTools({ workspace, canCapture: () => true, present: () => editor }, undefined, provider);
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
    const { workspace, provider, peer, document, editor, companion, dispose } = fixture(t);
    const original = document();
    const at = { line: 0, character: 0 };
    const edits = [{ range: { start: at, end: at }, newText: "// note\n" }];
    peer.onRequest("textDocument/codeAction", () => [{ title: "Annotate", command: "fixture.command" }]);
    peer.onRequest("workspace/executeCommand", async () => {
        const reply = await peer.sendRequest<{ applied: boolean }>("workspace/applyEdit", {
            edit: { changes: { [original.language!.uri]: edits, [companion.language!.uri]: edits } }
        });
        assert.equal(reply.applied, true);
        return "Annotated companion.";
    });
    const language = attachEditorLanguage(editor, provider, { codeActions: { reviewCommandEdit: () => true } });
    try {
        const list = await language.codeActions.request();
        assert.equal(list.status, "done");
        const result = await list.value[0]!.select();
        const after = workspace.document(companion.id);
        assert.equal(after.buffer.slice(0, 8), "// note\n");
        assert.equal(document().buffer.slice(0, 8), "// note\n");
        assert.equal(result.status, "done");
        assert.deepEqual(result.value.map(change => change.document).sort(), [original.id, companion.id].sort());
        assert.ok(workspace.undo({ documentId: companion.id, expectedRevision: after.revision }).applied);
        assert.equal(workspace.document(companion.id).buffer, companion.buffer);
        assert.equal(document().buffer, original.buffer);
    } finally {
        language.dispose();
        dispose();
    }
    await settled();
    assert.equal(workspace.diagnostics().leases, 0);
});

test("an advertised direct command leaves a pending action preview usable when it makes no edits", async t => {
    const f = fixture(t);
    const at = { line: 0, character: 0 };
    const uri = f.document().language!.uri;
    f.peer.onRequest("textDocument/codeAction", () => [{ title: "Insert", edit: {
        changes: { [uri]: [{ range: { start: at, end: at }, newText: "inserted " }] }
    } }]);
    const language = attachEditorLanguage(f.editor, f.provider, { commands: {}, codeActions: {} });
    try {
        const list = await language.codeActions.request();
        assert.equal(list.status, "done");
        const review = await list.value[0]!.select({ review: true });
        assert.equal(review.status, "done");
        const preview = review.value;
        assert.deepEqual(await language.commands.run("fixture.command"), { status: "done", value: [] });
        assert.equal(language.codeActions.getSnapshot().preview, preview);
        assert.equal((await preview.apply()).status, "done");
        assert.equal(f.document().buffer.slice(0, 9), "inserted ");
        assert.equal(preview.readEdits(0, 1), undefined);
    } finally {
        language.dispose();
        f.dispose();
    }
});

test("closing the editor refuses a server edit while host approval is still unanswered", { timeout: 3000 }, async t => {
    const f = fixture(t);
    const asked = latch<void>(), approval = latch<boolean>(), answered = latch<boolean>();
    const original = f.document();
    const at = { line: 0, character: 0 };
    const edit = { changes: { [original.language!.uri]: [{ range: { start: at, end: at }, newText: "late " }] } };
    f.peer.onRequest("textDocument/codeAction", () => [{ title: "Apply", command: "fixture.command" }]);
    f.peer.onRequest("workspace/executeCommand", async () => {
        const reply = await f.peer.sendRequest<{ applied: boolean }>("workspace/applyEdit", { edit });
        answered.resolve(reply.applied);
        return null;
    });
    const language = attachEditorLanguage(f.editor, f.provider, { codeActions: { reviewCommandEdit: () => {
        asked.resolve();
        return approval.promise;
    } } });
    try {
        const choices = await language.codeActions.request();
        assert.equal(choices.status, "done");
        const applying = choices.value[0]!.select();
        await asked.promise;
        language.dispose();
        assert.equal((await applying).status, "stale");
        assert.equal(await answered.promise, false);
        approval.resolve(true);
        await settled();
        assert.equal(f.document(), original);
    } finally {
        approval.resolve(false);
        language.dispose();
        f.dispose();
    }
});

const registration = { id: "review", method: "workspace/executeCommand", registerOptions: { commands: ["fixture.review"] } };
type CommandFixture = ReturnType<typeof fixture>;
const interruptions = {
    selection: (f: CommandFixture) => f.view.setSelection(f.document().revision, { anchor: 3, head: 3 }),
    authority: (f: CommandFixture) => f.workspace.setCapabilities(f.other.id, { edit: [], save: true }),
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
        const f = fixture(t);
        const { codeActions: actions, dispose } = attachEditorLanguage(f.editor, f.provider, { codeActions: {
            documents: () => [f.document(), f.companion],
            reviewCommandEdit: f.host.reviewActionEdit,
        } });
        const stop = f.host.observeActions(f.editor, actions);
        const origin = f.document();
        const at = { line: 0, character: 0 };
        const insert = (text: string) => [{ range: { start: at, end: at }, newText: text }];
        const sourceUri = origin.language!.uri;
        const otherUri = f.companion.language!.uri;
        t.after(() => {
            dispose();
            stop();
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
        const actionsAtCaret = await actions.request();
        assert.equal(actionsAtCaret.status, "done");
        const preview = await actionsAtCaret.value[0]!.select({ review: true });
        assert.equal(preview.status, "done");
        assert.ok(preview.value.canApply);
        const applying = preview.value.apply();
        assert.equal(actions.getSnapshot().status, "executing");
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
        assert.notEqual((await applying).status, "done");
        if (cause !== "disconnect") assert.equal(decision?.applied, false);
        assert.equal(f.workspace.document(f.companion.id).buffer, f.companion.buffer);
        const undo = () => f.workspace.undo({ documentId: origin.id, expectedRevision: f.document().revision });
        if (cause === "typing") assert.ok(undo().applied);
        assert.equal(f.document().buffer, committed.buffer);
        assert.ok(undo().applied);
        assert.equal(f.document().buffer, origin.buffer);
    });
}
