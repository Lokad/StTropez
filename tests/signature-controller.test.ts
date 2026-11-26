import assert from "node:assert/strict";
import test from "node:test";
import { attachEditorLanguage, type TextEditor } from "../src/browser/index.ts";
import { createCommandRegistry } from "../src/browser/command-registry.ts";
import { dispatchTypedText } from "../src/browser/input-events.ts";
import { clientFixture, settled } from "./helpers/lsp-client.ts";
import { editorState } from "./helpers/editor-state.ts";

test("typing keeps a chosen overload across provider reordering until the call needs a different parameter", { timeout: 5000 }, async t => {
    const f = clientFixture(t);
    const { workspace, provider } = f;
    const view = workspace.createDocumentView(f.source.documentId);
    const timers = new Map<number, { run: () => void; ms: number }>();
    let serial = 0;
    const clock = { performance, clearTimeout: (id: number) => timers.delete(id), setTimeout(run: () => void, ms: number) {
        timers.set(++serial, { run, ms });
        return serial;
    } };
    const root = Object.assign(new EventTarget(), { isConnected: true, ownerDocument: { defaultView: clock } });
    const lifetime = new AbortController();
    const registry = createCommandRegistry(false, () => true, () => () => true, (): TextEditor => editor);
    const editor = {
        ...editorState({ focused: true }), workspace, view, element: root, signal: lifetime.signal, commands: registry.commands,
        activity: () => ({ input: "idle" }), viewport: { revealOffset() {} },
        onEditIntent(listen: (kind: "beforeinput") => void, signal: AbortSignal) {
            root.addEventListener("beforeinput", () => listen("beforeinput"), { signal });
        },
    } as unknown as TextEditor;
    const attachment = attachEditorLanguage(editor, provider, { signature: {} });
    t.after(() => { lifetime.abort(); registry.dispose(); view.dispose(); });
    const { signature } = attachment;
    const first = { label: "call(key, fallback)", parameters: [{ label: "key" }, { label: "fallback" }] };
    const second = { label: "call(keys)", parameters: [{ label: "keys" }] };
    let reply = { signatures: [first, second], activeParameter: 0, activeSignature: 0 };
    f.peer.onRequest("textDocument/signatureHelp", () => reply);
    await provider.connect();
    assert.equal((await signature.request()).status, "done");
    assert.ok(registry.commands.run("signature.next"));
    assert.equal(signature.getSnapshot().signature?.label, second.label);

    async function type(text: string) {
        const before = view.getSnapshot();
        root.dispatchEvent(new Event("beforeinput"));
        const offset = before.selection.head;
        assert.ok(workspace.edit({ documentId: view.documentId, expectedRevision: before.revision, origin: "human", view,
            history: { kind: "typing" }, edits: [{ from: offset, to: offset, insert: text }],
            selection: { head: offset + text.length, anchor: offset + text.length } }).applied);
        dispatchTypedText(editor.element, before, view.getSnapshot(), text);
        await settled();
        const refresh = [...timers].find(([, entry]) => entry.ms === 50);
        assert.ok(refresh);
        timers.delete(refresh[0]);
        const ready = new Promise<void>(resolve => {
            const stop = signature.subscribe(() => {
                if (signature.getSnapshot().status === "ready") { stop(); resolve(); }
            });
        });
        refresh[1].run();
        await ready;
    }
    reply = { ...reply, signatures: [second, first], activeSignature: 1 };
    await type("x");
    assert.equal(signature.getSnapshot().signature?.label, second.label);
    assert.equal(signature.getSnapshot().activeSignature, 0);
    reply = { ...reply, activeParameter: 1 };
    await type(",");
    assert.equal(signature.getSnapshot().signature?.label, first.label);
    assert.equal(signature.getSnapshot().signature?.activeParameter, 1);
});
