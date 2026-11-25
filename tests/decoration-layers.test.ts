import assert from "node:assert/strict";
import test from "node:test";
import { Workspace } from "../src/index.ts";
import { createDecorationLayers } from "../src/browser/decoration-layers.ts";

test("point labels at replacement boundaries survive clipping and later edits", () => {
    const workspace = new Workspace();
    const id = workspace.createDocument({ scope: "test", resource: "labels", variant: "text" }, "Labels", "0123456789".repeat(4));
    const layers = createDecorationLayers(() => workspace.document(id), () => {}, () => true);
    workspace.onDocumentChange(id, change => { layers.advance(change); });
    const labels = layers.handle.add({ order: 1 });
    const points = [2, 4, 6, 8, 11].map(from => ({ from, to: from, className: "note", afterLine: String(from) }));
    assert.ok(labels.set(0, points));
    function check(expected: [string, number][]) {
        const { revision, buffer } = workspace.document(id), to = buffer.length;
        // The ending fragment also paints the labels whose anchors are offscreen to its left.
        for (const from of [0, 20]) {
            const fragment = { documentId: id, revision, line: 0, lineStart: 0, from, to, text: buffer.slice(from, to) };
            assert.deepEqual(layers.present(fragment, false, true).map(r => [r.afterLine, r.from]), expected);
        }
    }
    assert.ok(workspace.edit({ documentId: id, expectedRevision: 0, origin: "human", edits: [{ from: 2, to: 8, insert: "XY" }] }).applied);
    check([["2", 4], ["8", 4], ["11", 7]]);
    // This batch rebuilds the index. It deletes one more point while inserting at the surviving boundary.
    const edits = [{ from: 4, to: 4, insert: "!" }, { from: 6, to: 8, insert: "" },
        ...[10, 12, 14, 16].map(from => ({ from, to: from, insert: "." }))];
    assert.ok(workspace.edit({ documentId: id, expectedRevision: 1, origin: "human", edits }).applied);
    check([["2", 5], ["8", 5]]);
});
