import assert from "node:assert/strict";
import test from "node:test";
import { Workspace } from "../src/index.ts";
import type { DocumentSnapshot } from "../src/index.ts";
import { DemoDiagnosticState } from "../examples/demo/diagnostic-state.ts";
import type { DemoDiagnostic } from "../examples/demo/diagnostic-state.ts";

function problem(document: DocumentSnapshot, from: number, to: number, related: DemoDiagnostic["related"] = []): DemoDiagnostic {
    const at = (offset: number) => { const line = document.buffer.lineAt(offset); return Object.freeze({ line, character: offset - document.buffer.offsetAt(line) }); };
    return Object.freeze({ documentId: document.id, name: document.title, revision: document.revision, from, to,
        range: Object.freeze({ start: at(from), end: at(to) }), placement: "placed", message: "Example error", source: "test", severity: 1, related: Object.freeze(related) });
}

test("retained diagnostics map UTF-16 ranges and related locations without mutating accepted snapshots", () => {
    const workspace = new Workspace(), state = new DemoDiagnosticState();
    const id = workspace.createDocument({ scope: "diagnostics", resource: "main", variant: "working" }, "main", "// 😀\r\nwrong\r\nend");
    const other = workspace.createDocument({ scope: "diagnostics", resource: "other", variant: "working" }, "other", "const name = 1;");
    const original = workspace.document(id), linked = workspace.document(other), target = Object.freeze({ documentId: other, revision: 0, from: 6, to: 10 });
    const item = problem(original, 7, 12, [{ name: "other", message: "Declared here", line: 0, character: 6, target }]);
    state.update([original, linked]); assert.equal(state.accept([original, linked], [item]), true);
    const accepted = state.diagnostics;
    workspace.edit({ documentId: id, expectedRevision: 0, edits: [{ from: 0, to: 7, insert: "" }], origin: "host" });
    const current = workspace.document(id); state.update([current, linked]);
    assert.deepEqual(state.diagnostics[0], { ...item, revision: 1, from: 0, to: 5, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } });
    assert.equal(accepted[0], item); assert.equal(item.from, 7);
    workspace.edit({ documentId: other, expectedRevision: 0, edits: [{ from: 0, to: 0, insert: "// 😀\n" }], origin: "host" });
    const nextLinked = workspace.document(other); state.update([current, nextLinked]);
    assert.deepEqual(state.diagnostics[0]!.related[0], { ...item.related[0], line: 1, character: 6, target: { ...target, revision: 1, from: 12, to: 16 } });
    workspace.undo({ documentId: other, expectedRevision: 1 }); state.update([current, workspace.document(other)]);
    assert.deepEqual(state.diagnostics[0]!.related[0]!.target, { ...target, revision: 2 });
    workspace.edit({ documentId: id, expectedRevision: 1, edits: [{ from: 0, to: 5, insert: "fixed" }], origin: "host" });
    state.update([workspace.document(id), workspace.document(other)]); assert.deepEqual(state.diagnostics, []);
    assert.equal(state.accept([original, linked], [item]), false, "an old project cannot restore discarded diagnostics");
});

test("an EOF diagnostic follows unrelated edits and disappears when its source is deleted", () => {
    const workspace = new Workspace();
    const state = new DemoDiagnosticState();
    const id = workspace.createDocument({ scope: "diagnostics", resource: "main", variant: "working" },
        "main", "ok\r\nif (ready) {");
    const original = workspace.document(id);
    const eof = (document: DocumentSnapshot) => problem(document, document.buffer.length, document.buffer.length);
    state.update([original]);
    assert.ok(state.accept([original], [eof(original)]));
    workspace.edit({ documentId: id, expectedRevision: original.revision, origin: "human",
        edits: [{ from: 0, to: 0, insert: "// 😀\r\n" }] });
    const shifted = workspace.document(id);
    state.update([shifted]);
    assert.deepEqual(state.diagnostics, [eof(shifted)]);

    workspace.edit({ documentId: id, expectedRevision: shifted.revision, origin: "human",
        edits: [{ from: shifted.buffer.offsetAt(2), to: shifted.buffer.length, insert: "" }] });
    const fixed = workspace.document(id);
    state.update([fixed]);
    assert.deepEqual(state.diagnostics, []);
    assert.equal(state.accept([shifted], [eof(shifted)]), false);
    workspace.undo({ documentId: id, expectedRevision: fixed.revision });
    const restored = workspace.document(id);
    state.update([restored]);
    assert.deepEqual(state.diagnostics, []);
    assert.ok(state.accept([restored], [eof(restored)]));
    assert.deepEqual(state.diagnostics, [eof(restored)]);
});

test("syntax reuse follows document identity and revision, including empty results and linked targets", () => {
    const workspace = new Workspace(), state = new DemoDiagnosticState();
    const first = workspace.createDocument({ scope: "diagnostics", resource: "first", variant: "working" }, "first", "one");
    const second = workspace.createDocument({ scope: "diagnostics", resource: "second", variant: "working" }, "second", "two");
    const a = workspace.document(first), b = workspace.document(second); state.update([a, b]);
    state.acceptSyntax(a, []); state.acceptSyntax(b, [problem(b, 0, 3)]); const reused = state.syntax(b);
    assert.deepEqual(state.syntax(a), []); assert.equal(state.update([a, b]), false);
    workspace.edit({ documentId: first, expectedRevision: 0, edits: [{ from: 0, to: 0, insert: "x" }], origin: "host" });
    const changed = workspace.document(first); state.update([changed, b]);
    assert.equal(state.syntax(changed), undefined); assert.equal(state.syntax(b), reused);
    state.acceptSyntax(a, []); assert.equal(state.syntax(changed), undefined, "late syntax is not reusable");
    const foreign = new Workspace(), foreignId = foreign.createDocument(a.key, "same IDs", "one");
    const replacement = foreign.document(foreignId); assert.equal(replacement.id, a.id);
    state.update([replacement, b]); assert.equal(state.syntax(replacement), undefined);
    const linked = problem(b, 0, 3, [{ name: "first", message: "related", line: 0, character: 0,
        target: { documentId: first, revision: replacement.revision, from: 0, to: 1 } }]);
    state.acceptSyntax(b, [linked]); state.update([b]); assert.equal(state.syntax(b), undefined);
    state.acceptSyntax(b, []); state.clear(); assert.equal(state.syntax(b), undefined); assert.deepEqual(state.diagnostics, []);
});

test("missing lineage drops only affected diagnostic placements and retains unrelated syntax", () => {
    const workspace = new Workspace(), state = new DemoDiagnosticState();
    const id = workspace.createDocument({ scope: "diagnostics", resource: "main", variant: "working" }, "main", "wrong");
    const other = workspace.createDocument({ scope: "diagnostics", resource: "other", variant: "working" }, "other", "also wrong");
    const a = workspace.document(id), b = workspace.document(other), unaffected = problem(b, 5, 10);
    state.update([a, b]); state.accept([a, b], [problem(a, 0, 5), unaffected]); state.acceptSyntax(b, []);
    for (let step = 0; step < 2; step++) workspace.edit({ documentId: id, expectedRevision: step, edits: [{ from: 0, to: 0, insert: "x" }], origin: "host" });
    state.update([workspace.document(id), b]); assert.deepEqual(state.diagnostics, [unaffected]); assert.deepEqual(state.syntax(b), []);
    assert.equal(Object.isFrozen(state.diagnostics), true);
});
