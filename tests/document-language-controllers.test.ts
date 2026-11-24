import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
    createCodeActionController, createDocumentColorController, createDocumentLinkController, createRenameController,
    type TextEditor,
} from "../src/browser/index.ts";
import { editorState } from "./helpers/editor-state.ts";
import { latch, waitForState } from "./helpers/latch.ts";
import { clientFixture, settled } from "./helpers/lsp-client.ts";

const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } };

async function fixture(t: TestContext) {
    const f = clientFixture(t);
    const { workspace, provider } = f;
    const scope = provider.createScope();
    scope.attachDocument(f.source.documentId);
    const tab = workspace.tabs.open({ kind: "text", documentId: f.source.documentId }, "source");
    const view = workspace.createDocumentView(f.source.documentId);
    const lifetime = new AbortController();
    const editor = {
        ...editorState(), workspace, view, tab: workspace.tabs.capture(tab), signal: lifetime.signal,
        element: { isConnected: true, ownerDocument: { defaultView: { setTimeout, clearTimeout } } },
        activity: () => ({ composing: false, pendingInput: false, pendingCommand: false }),
    } as unknown as TextEditor;
    t.after(() => {
        lifetime.abort();
        view.dispose();
        workspace.tabs.close(tab);
        scope.dispose();
    });
    f.peer.onRequest("test/barrier", () => null);
    await provider.connect();
    return {
        ...f, editor,
        flush: () => scope.request("test/barrier").result,
        select: () => view.setSelection(f.document().revision, { anchor: 1, head: 1 }),
        replace: () => {
            lifetime.abort();
            view.dispose();
            workspace.tabs.replace(tab, { kind: "text", documentId: f.other.documentId });
        },
    };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function holdReply(f: Fixture, method: string, reply: unknown) {
    const received = latch<void>();
    const release = latch<void>();
    f.peer.onRequest(method, async () => {
        received.resolve();
        await release.promise;
        return reply;
    });
    return { received: received.promise, send: () => release.resolve() };
}

const sourceChanges = {
    selection: (f: Fixture) => f.select(),
    typing: (f: Fixture) => f.edit(),
    "tab replacement": (f: Fixture) => f.replace(),
};

for (const [cause, interrupt] of Object.entries(sourceChanges)) {
    test(`a delayed code action cannot edit its former source after ${cause}`, { timeout: 5000 }, async t => {
        const f = await fixture(t);
        const actions = createCodeActionController(f.editor, f.provider);
        const lazy = { title: "Replace word", data: { id: 1 } };
        const resolved = { ...lazy, edit: { changes: { "generic:source": [{ range, newText: "late" }] } } };
        f.peer.onRequest("textDocument/codeAction", () => [lazy]);
        const held = holdReply(f, "codeAction/resolve", resolved);
        actions.request();
        await waitForState(actions, snapshot => snapshot.status !== "pending");
        const choice = actions.getSnapshot().choices[0];
        assert.ok(choice?.needsResolve);
        choice.select(() => true);
        await held.received;
        interrupt(f);
        if (cause === "typing") {
            const { id, revision } = f.document();
            assert.ok(f.workspace.undo({ documentId: id, expectedRevision: revision }).applied);
        }
        await settled();
        const source = f.document();
        assert.equal(f.sent("$/cancelRequest").length, 1);
        held.send();
        await f.flush();
        assert.equal(actions.getSnapshot().preview, null);
        assert.equal(f.document(), source);
    });

    test(`a delayed rename cannot offer an edit after ${cause}`, { timeout: 5000 }, async t => {
        const f = await fixture(t);
        const rename = createRenameController(f.editor, f.provider);
        const edit = { changes: { "generic:source": [{ range, newText: "replacement" }] } };
        const held = holdReply(f, "textDocument/rename", edit);
        rename.request("replacement");
        await held.received;
        interrupt(f);
        await settled();
        assert.equal(f.sent("$/cancelRequest").length, 1);
        const source = f.document();
        held.send();
        await f.flush();
        assert.equal(rename.getSnapshot().preview, null);
        assert.equal(f.document(), source);
    });
}

const colorChanges = {
    ...sourceChanges,
    "edit authority": (f: Fixture) => f.workspace.acquireEditLease(f.source.id, "test", "host").release(),
};
for (const [cause, interrupt] of Object.entries(colorChanges)) {
    test(`a delayed color presentation loses its edit target after ${cause}`, { timeout: 5000 }, async t => {
        const f = await fixture(t);
        const colors = createDocumentColorController(f.editor, f.provider);
        const red = { red: 1, green: 0, blue: 0, alpha: 1 };
        const presentation = [{ label: "red", textEdit: { range, newText: "#f00" } }];
        f.peer.onRequest("textDocument/documentColor", () => [{ range, color: red }]);
        f.peer.onRequest("textDocument/colorPresentation", () => presentation);
        await colors.request();
        const reference = colors.getSnapshot().colors[0];
        assert.ok(reference);
        await reference.preview(red);
        const oldReview = colors.getSnapshot().review;
        assert.ok(oldReview?.canApply);

        const held = holdReply(f, "textDocument/colorPresentation", presentation);
        const pending = reference.preview(red);
        await held.received;
        interrupt(f);
        await settled();
        const source = f.document();
        const other = f.workspace.document(f.other.documentId);
        assert.equal(f.sent("$/cancelRequest").length, 1);
        held.send();
        await pending;
        await f.flush();
        assert.equal(colors.getSnapshot().review, null);
        assert.deepEqual(oldReview.apply(), { applied: false, reason: "expired" });
        assert.equal(f.document(), source);
        assert.equal(f.workspace.document(other.id), other);
    });
}

const linkChanges = {
    ...sourceChanges,
    "target edit": (f: Fixture) => {
        const target = f.workspace.document(f.other.documentId);
        f.workspace.edit({ documentId: target.id, expectedRevision: target.revision, origin: "host",
            edits: [{ from: 0, to: 0, insert: "new " }] });
    },
    "target edit authority": (f: Fixture) => f.workspace.acquireEditLease(f.other.id, "test", "host").release(),
};
for (const [cause, interrupt] of Object.entries(linkChanges)) {
    test(`a delayed link reply leaves no destination after ${cause}`, { timeout: 5000 }, async t => {
        const f = await fixture(t);
        const links = createDocumentLinkController(f.editor, f.provider, {
            documents: () => [f.workspace.document(f.other.documentId)],
        });
        const answer = [{ range, target: "generic:other" }];
        const held = holdReply(f, "textDocument/documentLink", answer);
        const pending = links.request();
        await held.received;
        interrupt(f);
        await settled();
        assert.equal(f.sent("$/cancelRequest").length, 1);
        held.send();
        await pending;
        await f.flush();
        assert.deepEqual(links.getSnapshot().links, []);
        assert.equal(links.linkAt(1), undefined);
    });
}
