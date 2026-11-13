import assert from "node:assert/strict";
import test from "node:test";
import { Workspace } from "../src/index.ts";
import type { DocumentSnapshot } from "../src/index.ts";
import { DemoSyntaxColors } from "../examples/demo/syntax-colors.ts";
import { analyzeTypeScript } from "../examples/demo/syntax.ts";

const presented = (capture: DocumentSnapshot, from = 0, to = capture.buffer.length) => ({ documentId: capture.id, revision: capture.revision,
    line: capture.buffer.lineAt(from), lineStart: capture.buffer.offsetAt(capture.buffer.lineAt(from)), from, to, text: capture.buffer.slice(from, to) });

test("provisional syntax survives UTF-16 line deletion and exact undo/redo without crossing document identity", () => {
    const workspace = new Workspace(), text = "// café 😀\r\nconst total = 42;\n// last\n";
    const id = workspace.createDocument({ scope: "colors", resource: "source", variant: "working" }, "source", text);
    const colors = new DemoSyntaxColors(), initial = workspace.document(id), spans = analyzeTypeScript(text).spans;
    colors.update(initial); colors.accept(initial, spans);
    const before = colors.decorate(presented(initial));
    const from = text.indexOf("const");
    workspace.edit({ documentId: id, expectedRevision: initial.revision, edits: [{ from: 0, to: from, insert: "" }], origin: "host" });
    const deleted = workspace.document(id); colors.update(deleted);
    const after = colors.decorate(presented(deleted));
    assert.deepEqual(after, before.filter(range => range.from >= from).map(range => ({ ...range, from: range.from - from, to: range.to - from })));
    workspace.undo({ documentId: id, expectedRevision: deleted.revision });
    const undone = workspace.document(id); assert.equal(undone.buffer, initial.buffer); colors.update(undone);
    assert.deepEqual(colors.decorate(presented(undone)), before);
    workspace.redo({ documentId: id, expectedRevision: undone.revision });
    const redone = workspace.document(id); colors.update(redone);
    assert.deepEqual(colors.decorate(presented(redone)), after);
    const other = workspace.createDocument({ scope: "colors", resource: "other", variant: "working" }, "other", text);
    colors.update(workspace.document(other));
    assert.deepEqual(colors.decorate(presented(workspace.document(other))), []);
    assert.deepEqual(colors.decorate(presented(redone)), []);
    const foreign = new Workspace(), reused = foreign.createDocument(initial.key, "same local IDs", text), current = foreign.document(reused);
    assert.equal(current.id, initial.id); assert.equal(current.revision, initial.revision); assert.notEqual(current.key, initial.key);
    colors.accept(initial, spans); colors.update(current);
    assert.deepEqual(colors.decorate(presented(current)), [], "equal workspace-local IDs must not reuse another workspace's colors");
});

test("100k-token colors update lazily and skip collapsed deleted spans in a bounded row query", () => {
    const workspace = new Workspace(), text = "// x\n".repeat(100_000);
    const id = workspace.createDocument({ scope: "colors", resource: "large", variant: "working" }, "large", text);
    const colors = new DemoSyntaxColors(), initial = workspace.document(id), raw = new Uint32Array(300_000);
    for (let i = 0; i < 100_000; i++) raw.set([i * 5, 4, 1], i * 3);
    let reads = 0;
    const spans = new Proxy(raw, { get(target, key) { if (typeof key === "string" && /^\d+$/.test(key)) reads++; return Reflect.get(target, key, target); } });
    colors.update(initial); colors.accept(initial, spans);
    workspace.edit({ documentId: id, expectedRevision: initial.revision, edits: [{ from: 125_000, to: 375_000, insert: "" }], origin: "host" });
    const current = workspace.document(id); colors.update(current);
    assert.equal(reads, 0, "the edit must not traverse the token array");
    assert.deepEqual(colors.decorate(presented(current, 125_000, 125_020)), Array.from({ length: 4 }, (_, i) => ({
        from: 125_000 + i * 5, to: 125_004 + i * 5, className: "demo-token-comment" })));
    assert.ok(reads < 200, `visible query read ${reads} token entries`);
});

test("fresh compiler classifications replace provisional colors after a multiline lexical change", () => {
    const workspace = new Workspace(), text = "const message = `Hello\nworld`;\nconst total = 42;";
    const id = workspace.createDocument({ scope: "colors", resource: "multiline", variant: "working" }, "multiline", text);
    const colors = new DemoSyntaxColors(), initial = workspace.document(id);
    colors.update(initial); colors.accept(initial, analyzeTypeScript(text).spans);
    workspace.edit({ documentId: id, expectedRevision: initial.revision, edits: [{ from: 0, to: 0, insert: "/* open\n" }], origin: "host" });
    const current = workspace.document(id); colors.update(current);
    assert.ok(colors.decorate(presented(current)).some(range => range.className === "demo-token-keyword"));
    colors.accept(current, analyzeTypeScript(current.text).spans);
    const fresh = colors.decorate(presented(current));
    assert.ok(fresh.length > 0); assert.ok(fresh.every(range => range.className === "demo-token-comment"));
    colors.clear(); assert.deepEqual(colors.decorate(presented(current)), []);
});
