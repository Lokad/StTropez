import assert from "node:assert/strict";
import test from "node:test";
import { Workspace } from "../src/index.ts";
import { createNavigationHistory, type TextEditor, type ViewState } from "../src/browser/index.ts";

function pane(workspace: Workspace, name: string, head: number, top: number) {
    const id = workspace.createDocument({ scope: "history", resource: name, variant: "working" }, name, "abcdefghijkl");
    const view = workspace.createDocumentView(id, { anchor: head, head });
    const mount = new AbortController();
    let scrollTop = top;
    let composing = false;
    function captureView(): ViewState {
        const { selection, selectionSet } = view.getSnapshot();
        return { ...selection, selectionSet, scrollLeft: 7, scrollTop };
    }
    const editor = {
        workspace, view, signal: mount.signal, element: { isConnected: true },
        activity: () => ({ input: composing ? "composing" : "idle" }), captureView,
        restoreView(state: ViewState) {
            scrollTop = state.scrollTop;
            const set = state.selectionSet!;
            return view.setSelections(view.getSnapshot().revision, set.ranges, set.primary);
        },
    } as unknown as TextEditor;
    return { editor, view, mount, captureView, scrollTo(top: number) { scrollTop = top; }, setComposing(value: boolean) { composing = value; } };
}

test("Back and Forward restore the departure selection and scroll through intervening edits", () => {
    const workspace = new Workspace();
    const history = createNavigationHistory(workspace);
    const first = pane(workspace, "first", 2, 60);
    const middle = pane(workspace, "middle", 5, 300);
    const last = pane(workspace, "last", 8, 900);
    first.view.setSelections(0, [{ anchor: 3, head: 1 }, { anchor: 7, head: 8 }], 1);
    const start = first.captureView();
    const present = (view: TextEditor["view"]) => [first, middle, last].find(pane => pane.view === view)!.editor;
    assert.ok(history.capture(first.editor)!.visit(() => true));
    first.view.setSelection(0, { anchor: 4, head: 4 });
    first.scrollTo(0);
    assert.ok(history.capture(middle.editor)!.visit(() => true));

    // The user moved after the second jump. Save where Back actually leaves them.
    last.view.setSelection(0, { anchor: 11, head: 8 });
    assert.equal(history.back(last.editor, present), "restored");
    last.view.setSelection(0, { anchor: 0, head: 0 });
    last.scrollTo(0);
    assert.equal(history.back(middle.editor, present), "restored");
    assert.deepEqual(first.captureView(), start);
    assert.deepEqual(history.getSnapshot(), { back: 0, forward: 2 });
    assert.ok(workspace.edit({ documentId: last.view.documentId, expectedRevision: 0, origin: "host",
        edits: [{ from: 0, to: 0, insert: "abc" }] }).applied);
    assert.equal(history.forward(first.editor, present), "restored");
    assert.equal(history.forward(middle.editor, present), "restored");
    assert.partialDeepStrictEqual(last.view.getSnapshot().selection, { anchor: 14, head: 11 });
    assert.equal(last.captureView().scrollTop, 900);
    assert.deepEqual(history.getSnapshot(), { back: 2, forward: 0 });
    history.dispose();
    for (const pane of [first, middle, last]) pane.view.dispose();
    assert.equal(workspace.diagnostics().subscriptions, 0);
});

test("unavailable panes and failed jumps preserve Forward until a successful new visit", () => {
    const workspace = new Workspace();
    const history = createNavigationHistory(workspace);
    const first = pane(workspace, "first", 1, 0);
    const second = pane(workspace, "second", 7, 120);
    const origin = history.capture(first.editor)!;
    assert.ok(origin.visit(() => true));
    assert.equal(history.back(second.editor, () => first.editor), "restored");
    const counts = history.getSnapshot();
    assert.equal(history.forward(first.editor, () => undefined), "busy");
    second.setComposing(true);
    assert.equal(history.forward(first.editor, () => second.editor), "busy");
    assert.equal(origin.visit(() => false), false);
    assert.equal(history.getSnapshot(), counts);
    second.setComposing(false);
    assert.ok(origin.visit(() => true));
    assert.equal(history.forward(second.editor, () => first.editor), "empty");
    first.mount.abort();
    assert.equal(origin.visit(() => assert.fail("disposed mount opened a destination")), false);
    first.view.dispose();
    assert.equal(history.back(second.editor, () => assert.fail("expired view was presented")), "empty");
    history.dispose();
    second.view.dispose();
    assert.equal(workspace.diagnostics().subscriptions, 0);
});
