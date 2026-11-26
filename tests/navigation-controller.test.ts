import assert from "node:assert/strict";
import test from "node:test";
import { attachEditorLanguage } from "../src/browser/index.ts";
import { controllerEditor } from "./helpers/editor-state.ts";
import { latch } from "./helpers/latch.ts";
import { clientFixture, settled } from "./helpers/lsp-client.ts";

test("definition and reference choices expire with their request, authority and originating view", { timeout: 5000 }, async t => {
    const f = clientFixture(t);
    const mount = () => {
        const { editor, dispose } = controllerEditor(f.workspace, f.source.documentId);
        const { navigation } = attachEditorLanguage(editor, f.provider, { navigation: { resultLifetime: "view" } });
        return { editor, navigation, dispose };
    };
    const first = mount();
    t.after(first.dispose);
    await f.provider.connect();
    const location = { uri: "generic:source", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } };
    f.peer.onRequest("textDocument/definition", () => [null]);
    assert.equal((await first.navigation.request()).status, "failed");
    assert.equal(first.navigation.getSnapshot().result, null);

    f.peer.onRequest("textDocument/definition", () => [location]);
    const found = await first.navigation.request();
    assert.equal(found.status, "done");
    const target = found.value.locationAt(0)!;
    assert.ok(target.open(at => assert.deepEqual([at.document.documentId, at.from, at.to], [f.source.documentId, 0, 5])));
    f.workspace.setCapabilities(f.source.id, { edit: ["host"], save: true });
    assert.equal(target.open(() => assert.fail("Expired navigation target opened")), false);
    await settled();
    assert.equal(first.navigation.getSnapshot().status, "expired");

    const reply = latch<void>();
    f.peer.onRequest("textDocument/references", async () => { await reply.promise; return [location]; });
    const pending = first.navigation.request("references");
    await settled();
    assert.equal(f.sent("textDocument/references").length, 1);
    first.editor.view.setSelection(f.document().revision, { anchor: 2, head: 2 });
    assert.equal((await pending).status, "stale");
    assert.ok(f.sent("$/cancelRequest").length);
    first.dispose();
    const replacement = mount();
    t.after(replacement.dispose);
    f.peer.onRequest("textDocument/references", () => [location]);
    assert.equal((await replacement.navigation.request("references")).status, "done");
    const current = replacement.navigation.getSnapshot();
    reply.resolve();
    await settled();
    assert.equal(replacement.navigation.getSnapshot(), current);
    assert.equal(first.navigation.getSnapshot().result, null);
    assert.equal(target.open(() => assert.fail("Expired navigation target opened")), false);
});
