import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createDocumentColorController, createDocumentLinkController, type TextEditor } from "../src/browser/index.ts";
import { editorState } from "./helpers/editor-state.ts";
import { latch } from "./helpers/latch.ts";
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
    await provider.connect();
    return {
        ...f, editor,
        select: () => view.setSelection(f.document().revision, { anchor: 1, head: 1 }),
        replace: () => {
            lifetime.abort();
            view.dispose();
            workspace.tabs.replace(tab, { kind: "text", documentId: f.other.documentId });
        },
    };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const sourceChanges = {
    selection: (f: Fixture) => f.select(),
    typing: (f: Fixture) => f.edit(),
    "tab replacement": (f: Fixture) => f.replace(),
};

const colorChanges = {
    ...sourceChanges,
    "edit authority": (f: Fixture) => f.workspace.acquireEditLease(f.source.id, "test", "host").release(),
};
for (const [cause, interrupt] of Object.entries(colorChanges)) {
    test(`a delayed color presentation loses its edit target after ${cause}`, async t => {
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

        const held = latch<typeof presentation>();
        f.peer.onRequest("textDocument/colorPresentation", () => held.promise);
        const pending = reference.preview(red);
        await settled();
        assert.equal(f.sent("textDocument/colorPresentation").length, 2);
        interrupt(f);
        await settled();
        const source = f.document();
        const other = f.workspace.document(f.other.documentId);
        assert.equal(f.sent("$/cancelRequest").length, 1);
        held.resolve(presentation);
        await pending;
        await settled();
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
    test(`a delayed link reply leaves no destination after ${cause}`, async t => {
        const f = await fixture(t);
        const links = createDocumentLinkController(f.editor, f.provider, {
            documents: () => [f.workspace.document(f.other.documentId)],
        });
        const answer = [{ range, target: "generic:other" }];
        const held = latch<typeof answer>();
        f.peer.onRequest("textDocument/documentLink", () => held.promise);
        const pending = links.request();
        await settled();
        assert.equal(f.sent("textDocument/documentLink").length, 1);
        interrupt(f);
        await settled();
        assert.equal(f.sent("$/cancelRequest").length, 1);
        held.resolve(answer);
        await pending;
        await settled();
        assert.deepEqual(links.getSnapshot().links, []);
        assert.equal(links.linkAt(1), undefined);
    });
}
