import test from "node:test";
import assert from "node:assert/strict";
import { TextDocument } from "vscode-languageserver-protocol/node.js";
import type { CompletionList, PublishDiagnosticsParams } from "vscode-languageserver-protocol/node.js";
import { TextBuffer } from "../src/core/text-buffer.ts";
import type { LspDocumentCapture } from "../src/protocol/index.ts";

const { LspLineIndex, decodeLspCompletions, decodeLspDiagnostics, lspRangeOffsets, RpcError } = await import(process.env.STTROPEZ_PROTOCOL_TEST_MODULE ?? "../src/protocol/index.ts") as typeof import("../src/protocol/index.ts");
async function captured(text = "// header\r\nconst saMORE = 1; // TODO\rb\n") {
    const buffer = TextBuffer.from(text), index = await LspLineIndex.create(buffer, async () => {}); let active = true;
    const capture: LspDocumentCapture = Object.freeze({ document: Object.freeze({ uri: "host+fixture:source", languageId: "fixture", resourceId: "resource", documentId: "working", revision: 70, buffer }), index, version: 3, epoch: 2, registrationGeneration: 4, isCurrent: () => active });
    return { capture, expire: () => { active = false; } };
}
const range = (line: number, start: number, end: number) => ({ start: { line, character: start }, end: { line, character: end } });

test("completion insert/replace plans and additional edits preserve raw text and the resulting caret", async () => {
    const { capture } = await captured(), point = capture.index.offsetAt({ line: 1, character: 8 });
    const response: CompletionList = { isIncomplete: false, items: [{ label: "sample", textEdit: { newText: "sample", insert: range(1, 6, 8), replace: range(1, 6, 12) },
        additionalTextEdits: [{ range: range(0, 0, 0), newText: "// import 😀\r\n" }] }, { label: "another", textEdit: { newText: "another", range: range(1, 6, 12) } }] };
    const decoded = decodeLspCompletions(response, capture, point), original = capture.document.buffer.slice(0, capture.document.buffer.length);
    for (const [mode, word] of [["insert", "sampleMORE"], ["replace", "sample"]] as const) {
        const plan = decoded.items[0]![mode], reference = TextDocument.create(capture.document.uri, "fixture", 3, original);
        const expected = TextDocument.applyEdits(reference, [...response.items[0]!.additionalTextEdits!, { range: mode === "insert" ? range(1, 6, 8) : range(1, 6, 12), newText: "sample" }]);
        const after = capture.document.buffer.apply(plan.edits).buffer; assert.equal(after.slice(0, after.length), expected);
        assert.equal(after.slice(plan.head - 6, plan.head), "sample"); assert.ok(expected.includes(`const ${word} = 1;`));
    }
    assert.equal(Object.isFrozen(decoded.items[0]!.replace.edits[0]), true); assert.equal(decoded.items.length, 2); assert.equal(capture.document.buffer.readMetrics().textExports, 0);
});

test("completion defaults, word fallback and whole-list validation refuse unsupported or malformed final items", async () => {
    const { capture } = await captured("const saMORE\r\n"), fallback = { from: 6, to: 8, replaceTo: 12 };
    const response: CompletionList = { isIncomplete: true, itemDefaults: { editRange: { insert: range(0, 6, 8), replace: range(0, 6, 12) }, insertTextFormat: 1, insertTextMode: 1 }, items: [{ label: "label", textEditText: "sample" }] };
    assert.equal(decodeLspCompletions(response, capture, 8).items[0]!.replace.edits[0]!.insert, "sample");
    assert.equal(decodeLspCompletions([{ label: "sample" }], capture, 8, fallback).items[0]!.replace.edits[0]!.to, 12);
    assert.equal(decodeLspCompletions([{ label: "label", insertText: "insert", textEditText: "ignored" }], capture, 8, fallback).items[0]!.insert.edits[0]!.insert, "insert");
    assert.equal(decodeLspCompletions({ ...response, items: [{ label: "label", insertText: "ignored" }] }, capture, 8).items[0]!.insert.edits[0]!.insert, "label");
    assert.deepEqual(decodeLspCompletions(null, capture, 8), { incomplete: false, items: [] });
    for (const bad of [{ label: "snippet", insertTextFormat: 2 }, { label: "command", command: { title: "run", command: "host/run" } },
        { label: "overlap", textEdit: { newText: "x", range: range(0, 6, 12) }, additionalTextEdits: [{ range: range(0, 7, 8), newText: "bad" }] },
        { label: "clamped", textEdit: { newText: "x", range: range(0, 6, 999) } }, { label: "reversed", textEdit: { newText: "x", insert: range(0, 6, 10), replace: range(0, 6, 8) } },
        { label: "duplicate insert", textEdit: { newText: "x", range: range(0, 8, 8) }, additionalTextEdits: [{ range: range(0, 8, 8), newText: "bad" }] }]) {
        assert.throws(() => decodeLspCompletions([{ label: "valid" }, bad], capture, 8, fallback));
    }
    assert.throws(() => decodeLspCompletions({ ...response, items: Array.from({ length: 257 }, () => ({ label: "x" })) }, capture, 8));
    assert.throws(() => decodeLspCompletions({ ...response, itemDefaults: { ...response.itemDefaults, unknownBehavior: true } }, capture, 8));
    assert.throws(() => decodeLspCompletions({ isIncomplete: false, items: [], itemDefaults: { editRange: range(0, 0, 999) } }, capture, 8));
    assert.equal(decodeLspCompletions(response, capture, 8, () => { throw new Error("Unused word fallback must not reject explicit ranges"); }).items.length, 1);
});

test("versioned diagnostics validate all anchors before publication; unversioned messages claim no source positions", async () => {
    const { capture, expire } = await captured(), response: PublishDiagnosticsParams = { uri: capture.document.uri, version: 3,
        diagnostics: [{ range: range(1, 21, 25), message: "<img src=x onerror=unsafe()> TODO", severity: 2, source: "fixture" }] };
    const decoded = decodeLspDiagnostics(response, capture); assert.equal(decoded.revision, 70); assert.equal(decoded.items[0]!.from, capture.index.offsetAt({ line: 1, character: 21 }));
    assert.equal(Object.isFrozen(decoded.items[0]), true); assert.deepEqual(decodeLspDiagnostics({ ...response, diagnostics: [] }, capture).items, []);
    const { version: _version, ...unversioned } = response; const uncertain = decodeLspDiagnostics(unversioned, capture); assert.equal(uncertain.revision, null); assert.equal(uncertain.items[0]!.from, null);
    for (const invalid of [{ ...response, version: null }, { ...response, uri: "host+fixture:other" }, { ...response, diagnostics: [...response.diagnostics, { range: range(1, 0, 999), message: "invalid tail" }] }]) assert.throws(() => decodeLspDiagnostics(invalid, capture));
    assert.throws(() => decodeLspDiagnostics({ ...response, version: 2 }, capture), error => error instanceof RpcError && error.code === -32801);
    expire(); assert.throws(() => decodeLspDiagnostics(response, capture), error => error instanceof RpcError && error.code === -32801); assert.throws(() => decodeLspCompletions([], capture, 8), /expired/);
});

test("strict LSP ranges refuse out-of-document clamping and preserve surrogate/newline boundaries", async () => {
    const { capture } = await captured("😀\r\na\rb\n");
    assert.deepEqual(lspRangeOffsets(capture.index, range(0, 1, 2)), { from: 1, to: 2 });
    assert.deepEqual(lspRangeOffsets(capture.index, { start: { line: 1, character: 1 }, end: { line: 2, character: 1 } }), { from: 5, to: 7 });
    for (const bad of [range(0, 0, 3), range(100, 0, 0), range(0, 2, 1), range(0, -1, 0), { start: { line: 0, character: .5 }, end: { line: 0, character: 1 } }]) assert.throws(() => lspRangeOffsets(capture.index, bad));
});
