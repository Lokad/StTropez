import test from "node:test";
import assert from "node:assert/strict";
import { TextBuffer } from "../src/index.ts";
import { ProviderProject } from "../fixtures/language/project.ts";
import { ProjectChangeCursor } from "../examples/shared/language/project-change.ts";
import { navigationLimits } from "../fixtures/language/navigation.ts";
function fixture() {
    const project = new ProviderProject(7), send = (operation: string, fields: Record<string, unknown> = {}) => project.handle({ version: 1, epoch: 7, sequence: project.snapshot().sequence + 1, operation, ...fields });
    send("project-hello");
    const chunk = (document: string, revision: number, text: string, size = 3) => { for (let from = 0; from < text.length; from += size) send("project-chunk", { document, revision, from, text: text.slice(from, from + size) }); };
    const open = (document: string, text: string, revision = 0) => { send("project-open", { document, revision, length: text.length }); chunk(document, revision, text); send("project-commit", { document, revision }); };
    return { project, send, open, chunk };
}
function delta(before: TextBuffer, after: TextBuffer, budget = 2) {
    const cursor = new ProjectChangeCursor(before, after);
    try { for (;;) { const step = cursor.next(budget); assert.ok(step.steps <= budget); if (step.done) return step.result!; } } finally { cursor.dispose(); }
}
test("provider document snapshots/changes commit atomically with exact raw BOM/CRLF and split supplementary units", () => {
    const f = fixture(), original = "\ufeffconst café = '😀';\r\ncafé;"; f.open("source", original);
    const previous = f.project.buffer("source")!; f.send("project-change", { document: "source", previousRevision: 0, revision: 3, from: 6, to: 11, units: 7, length: original.length + 2 });
    f.chunk("source", 3, "𐐀value", 1); assert.equal(f.project.buffer("source"), previous); assert.equal(f.project.snapshot().documents[0]!.revision, 0);
    f.send("project-commit", { document: "source", revision: 3 }); assert.equal(f.project.buffer("source")!.slice(0, original.length + 2), original.slice(0, 6) + "𐐀value" + original.slice(11));
    assert.equal(f.project.snapshot().documents[0]!.revision, 3); assert.equal(f.project.buffer("source")!.readMetrics().textExports, 0);
});
test("wrong protocol epochs/sequence/revisions and malformed/incomplete transfers cannot mutate committed state", () => {
    const f = fixture(); f.open("source", "const x = 1;\r\nx"); const before = f.project.snapshot(), buffer = f.project.buffer("source");
    for (const fields of [{ version: 2 }, { epoch: 8 }, { sequence: before.sequence }, { sequence: before.sequence + 2 }]) assert.throws(() => f.send("project-close", { document: "source", revision: 0, ...fields }));
    for (const fields of [{ previousRevision: 1 }, { revision: 0 }, { from: -1 }, { units: -1 }, { length: 999 }]) assert.throws(() => f.send("project-change", { document: "source", previousRevision: 0, revision: 1, from: 0, to: 0, units: 1, length: buffer!.length + 1, ...fields }));
    assert.deepEqual(f.project.snapshot(), before); assert.equal(f.project.buffer("source"), buffer);
    f.send("project-change", { document: "source", previousRevision: 0, revision: 1, from: 0, to: 0, units: 1, length: buffer!.length + 1 });
    const staged = f.project.snapshot(); for (const message of [
        ["project-chunk", { document: "source", revision: 1, from: 1, text: "x" }], ["project-chunk", { document: "source", revision: 0, from: 0, text: "x" }],
        ["project-chunk", { document: "source", revision: 1, from: 0, text: "x".repeat(16385) }], ["project-commit", { document: "source", revision: 1 }], ["project-close", { document: "source", revision: 0 }]
    ] as const) assert.throws(() => f.send(message[0], message[1]));
    assert.equal(f.project.buffer("source"), buffer); assert.deepEqual(f.project.snapshot(), staged);
});
test("queries require fully synchronized versions and reject changes while a captured query is active", () => {
    const f = fixture(), text = "const café = 1;\r\ncafé"; f.open("source", text); f.open("other", "café", 2);
    const input = { operation: "navigation-start", id: 3, kind: "references", symbol: "café", includeDeclaration: true, delay: 0, documents: [{ document: "source", revision: 0, length: text.length }, { document: "other", revision: 2, length: 5 }] };
    assert.throws(() => f.send("project-query", { input: { ...input, documents: [{ document: "source", revision: 1, length: text.length }] } }), /synchronized/);
    f.send("project-query", { input }); assert.throws(() => f.send("project-close", { document: "other", revision: 2 }), /Complete/);
    let reply; do { reply = f.send("project-query-next", { request: 3 }); } while (reply.operation !== "project-query-result");
    assert.equal((reply.result as { locations: unknown[] }).locations.length, 3); f.send("project-close", { document: "other", revision: 2 }); assert.equal(f.project.snapshot().documents.length, 1);
    assert.throws(() => f.send("project-close", { document: "other", revision: 2 })); assert.equal(f.project.buffer("source")!.readMetrics().textExports, 0);
});
test("shared-edge planning transfers only a small edit in a 100k-line buffer and handles version-only undo", () => {
    const before = TextBuffer.from("const value = 1;\r\n".repeat(100000)), after = before.replace(123456, 123456, "😀\r\n");
    assert.deepEqual(delta(before, after), { from: 123456, to: 123456, insertFrom: 123456, insertTo: 123460 });
    assert.deepEqual(delta(after, before), { from: 123456, to: 123460, insertFrom: 123456, insertTo: 123456 });
    assert.deepEqual(delta(before, before), { from: before.length, to: before.length, insertFrom: before.length, insertTo: before.length });
    assert.deepEqual(delta(TextBuffer.from("abc"), TextBuffer.from("abc")), { from: 0, to: 3, insertFrom: 0, insertTo: 3 });
    const cursor = new ProjectChangeCursor(before, after); cursor.dispose(); assert.throws(() => cursor.next(), /disposed/); assert.equal(before.readMetrics().textExports, 0); assert.equal(after.readMetrics().textExports, 0);
});
test("generated raw incremental edits, batched changes and older immutable versions remain exactly equivalent", () => {
    const f = fixture(); let buffer = TextBuffer.from("\ufeffhead\r\n😀 café\ntail"); f.open("source", buffer.slice(0, buffer.length)); const history = [buffer]; let seed = 17;
    const next = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; }, alphabet = ["\r\n", "😀", "\ud800", "東京", "é", "", "x"];
    for (let revision = 1; revision <= 80; revision++) {
        const from = next(buffer.length + 1), to = from + next(buffer.length - from + 1);
        const after = revision % 7 === 0 ? history[next(history.length)]! : buffer.apply([{ from, to, insert: alphabet[next(alphabet.length)]! }, ...(to < buffer.length ? [{ from: buffer.length, to: buffer.length, insert: "\r\n" }] : [])]).buffer;
        const change = delta(buffer, after, 1), insert = after.slice(change.insertFrom, change.insertTo);
        f.send("project-change", { document: "source", previousRevision: revision - 1, revision, from: change.from, to: change.to, units: insert.length, length: after.length }); f.chunk("source", revision, insert, 1 + next(7)); f.send("project-commit", { document: "source", revision });
        assert.equal(f.project.buffer("source")!.slice(0, after.length), after.slice(0, after.length)); assert.equal(f.project.buffer("source")!.lineCount, after.lineCount); history.push(after); buffer = after;
    }
});
test("project limits reject extra documents and oversized snapshots before retaining a staged transfer", () => {
    const f = fixture(); assert.throws(() => f.send("project-open", { document: "big", revision: 0, length: navigationLimits.sourceUnits + 1 })); assert.equal(f.project.snapshot().staging, false);
    for (let i = 0; i < navigationLimits.documents; i++) f.open(String(i), ""); assert.throws(() => f.open("extra", "")); assert.equal(f.project.snapshot().documents.length, 100);
    assert.throws(() => f.send("project-hello"));
});
