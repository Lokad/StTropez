import assert from "node:assert/strict";
import test from "node:test";
import { attachEditorLanguage } from "../src/browser/index.ts";
import { controllerEditor } from "./helpers/editor-state.ts";
import { latch } from "./helpers/latch.ts";
import { clientFixture, settled } from "./helpers/lsp-client.ts";

test("moving inside a completion word retires queued acceptance and overlapping requests", { timeout: 5000 }, async t => {
    const f = clientFixture(t);
    const { editor, dispose } = controllerEditor(f.workspace, f.source.documentId);
    t.after(dispose);
    const { view, commands } = editor;
    const { completion } = attachEditorLanguage(editor, f.provider, { completion: { automatic: false } });
    const positions: number[] = [];
    const leftReply = latch<void>();
    const oldResolution = latch<void>();
    f.peer.onRequest("textDocument/completion", async (params: { position: { character: number } }) => {
        const caret = params.position.character;
        positions.push(caret);
        const request = positions.length;
        if (request === 2) await leftReply.promise;
        return [{ label: "alpha" + request }];
    });
    f.peer.onRequest("completionItem/resolve", async (item: { label: string }) => {
        if (item.label === "alpha1") await oldResolution.promise;
        return item;
    });
    const select = (at: number) => view.setSelection(f.document().revision, { anchor: at, head: at });
    for (const [direction, delta] of [["left", -1], ["right", 1]] as const) {
        commands.register({ id: "move-" + direction, label: direction,
            run: () => select(view.getSnapshot().selection.head + delta) });
    }
    const press = (direction: "left" | "right") => assert.ok(commands.run("completion.move-" + direction));
    await f.provider.connect();
    select(3);
    assert.equal((await completion.request()).status, "done");
    await settled();
    const original = completion.getSnapshot().completionAt(0)!;
    assert.ok(original.accept("replace"));
    assert.equal(completion.getSnapshot().status, "accepting");

    press("left");
    assert.equal(original.accept("replace"), false);
    await settled();
    const waiting = completion.getSnapshot();
    assert.equal(waiting.anchor?.to, 2);
    assert.deepEqual(waiting.choices, ["alpha1"]);
    assert.equal(waiting.completionAt(0), undefined);
    press("right");
    await settled();
    leftReply.resolve();
    oldResolution.resolve();
    await settled();
    assert.deepEqual(positions, [3, 2, 3]);
    assert.equal(f.document().buffer.text(), "alpha beta");
    const fresh = completion.getSnapshot();
    assert.deepEqual(fresh.choices, ["alpha3"]);
    assert.ok(fresh.completionAt(0)?.accept("insert"));
    assert.equal(f.document().buffer.text(), "alpha3ha beta");
    assert.equal(original.select(), false);

    select(4);
    await completion.request();
    press("right");
    await settled();
    select(4); // A programmatic selection inside the same word still dismisses.
    assert.deepEqual(completion.getSnapshot().choices, []);

    select(8);
    await completion.request();
    const count = positions.length;
    press("right"); // Cross the space after the identifier.
    await settled();
    assert.deepEqual(completion.getSnapshot().choices, []);
    assert.equal(positions.length, count);
});

test("completion distinguishes preparation failures from malformed replies and accepts a fresh request", async t => {
    const f = clientFixture(t);
    const { editor, dispose } = controllerEditor(f.workspace, f.source.documentId);
    t.after(dispose);
    let preparationError: Error | undefined;
    const { completion } = attachEditorLanguage(editor, f.provider, { completion: {
        prepareCompletion: async () => { if (preparationError) throw preparationError; },
    } });
    await f.provider.connect();
    f.peer.onRequest("textDocument/completion", () => [null]);
    for (preparationError of [new TypeError(), new RangeError(), undefined]) {
        assert.equal((await completion.request()).status, "failed");
        const state = completion.getSnapshot();
        assert.equal(state.status, preparationError ? "failed" : "malformed");
        assert.deepEqual(state.choices, []);
    }
    f.peer.onRequest("textDocument/completion", () => [{ label: "fresh" }]);
    f.peer.onRequest("completionItem/resolve", (item: object) => item);
    const retired = completion.request();
    assert.equal((await completion.request()).status, "done");
    assert.equal((await retired).status, "stale");
    await settled();
    assert.ok(completion.getSnapshot().completionAt(0)?.accept("replace"));
    assert.equal(f.document().buffer.text(), "fresh beta");
});
