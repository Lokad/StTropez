import test from "node:test";
import assert from "node:assert/strict";
import { TextDocument } from "vscode-languageserver-protocol/node.js";
import type { CompletionList, PublishDiagnosticsParams, WorkspaceEdit } from "vscode-languageserver-protocol/node.js";
import { TextBuffer } from "../src/core/text-buffer.ts";
import type { LspDocumentCapture } from "../src/protocol/index.ts";

const { LspLineIndex, decodeLspCompletions, decodeLspDiagnostics, decodeLspHover, decodeLspLocations, decodeLspWorkspaceEdit, lspRangeOffsets, RpcError } = await import(process.env.STTROPEZ_PROTOCOL_TEST_MODULE ?? "../src/protocol/index.ts") as typeof import("../src/protocol/index.ts");
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

test("hover accepts standard content shapes and optional ranges as bounded literal text", async () => {
    const { capture, expire } = await captured("const 😀\r\n");
    for (const contents of ["plain", { kind: "plaintext", value: "plain" }, { kind: "markdown", value: "<img src=x> **plain**" }, [{ language: "fixture", value: "code" }, "detail"]]) {
        const decoded = decodeLspHover({ contents }, capture)!; assert.equal(decoded.range, null); assert.equal(typeof decoded.text, "string"); assert.equal(Object.isFrozen(decoded), true);
    }
    assert.deepEqual(decodeLspHover({ contents: "info", range: range(0, 0, 5) }, capture), { text: "info", range: { from: 0, to: 5 } });
    assert.equal(decodeLspHover(null, capture), null); assert.equal(decodeLspHover({ contents: [] }, capture), null);
    for (const bad of [{}, { contents: ["valid", { value: "missing language" }] }, { contents: [{ kind: "plaintext", value: "not a MarkedString" }] }, { contents: "valid", range: range(0, 0, 999) }, { contents: "x".repeat(8193) }, { contents: Array(65).fill("x") }]) assert.throws(() => decodeLspHover(bad, capture));
    expire(); assert.throws(() => decodeLspHover({ contents: "late" }, capture), error => error instanceof RpcError && error.code === -32801);
});

test("definition links/references resolve exact host URI captures and reject whole malformed/stale batches", async () => {
    const origin = await captured("use 😀\r\n"), destination = await captured("// 😀\r\nconst target = 1;\r\n");
    const target = { ...destination.capture, document: Object.freeze({ ...destination.capture.document, uri: "custom+host:project/%E2%88%86 target", documentId: "destination", resourceId: "target" }) };
    const resolve = (uri: string) => uri === target.document.uri ? target : undefined;
    const location = { uri: target.document.uri, range: range(1, 6, 12) }, link = { targetUri: target.document.uri, targetRange: range(1, 0, 17), targetSelectionRange: range(1, 6, 12), originSelectionRange: range(0, 0, 3) };
    assert.equal(decodeLspLocations(location, "definition", origin.capture, resolve)[0]!.target, target);
    const linked = decodeLspLocations([link], "definition", origin.capture, resolve)[0]!; assert.equal(target.index.buffer.slice(linked.from, linked.to), "target"); assert.deepEqual(linked.originRange, { from: 0, to: 3 }); assert.equal(Object.isFrozen(linked), true);
    assert.equal(decodeLspLocations([location], "references", origin.capture, resolve).length, 1); assert.deepEqual(decodeLspLocations(null, "definition", origin.capture, resolve), []);
    for (const bad of [[location, { ...location, uri: "custom+host:unknown" }], [location, { ...location, range: range(1, 0, 999) }], [link, location], [{ ...link, targetSelectionRange: range(1, 0, 18) }], [{ ...link, originSelectionRange: range(0, 0, 999) }], link, Array(1025).fill(location)]) assert.throws(() => decodeLspLocations(bad, "definition", origin.capture, resolve));
    assert.throws(() => decodeLspLocations([link], "references", origin.capture, resolve)); assert.throws(() => decodeLspLocations(location, "references", origin.capture, resolve));
    destination.expire(); assert.throws(() => decodeLspLocations([location], "definition", origin.capture, resolve), error => error instanceof RpcError && error.code === -32801);
    origin.expire(); assert.throws(() => decodeLspLocations([], "references", origin.capture, resolve), error => error instanceof RpcError && error.code === -32801);
});

test("workspace edits normalize versioned or unversioned batches without changing raw text or equal-position insertion order", async () => {
    const a = await captured("😀\r\nabc\rdef\n"), b = await captured("other");
    const target = { ...b.capture, document: { ...b.capture.document, uri: "custom+host:%2F opaque", documentId: "other" } };
    const resolve = (uri: string) => uri === a.capture.document.uri ? a.capture : uri === target.document.uri ? target : undefined;
    const response: WorkspaceEdit = { documentChanges: [{ textDocument: { uri: a.capture.document.uri, version: 3 }, edits: [
        { range: range(2, 0, 3), newText: "D\r\n" }, { range: range(1, 0, 0), newText: "first" }, { range: range(1, 0, 0), newText: "second" }, { range: range(1, 0, 3), newText: "A" }] },
        { textDocument: { uri: target.document.uri, version: null }, edits: [{ range: range(0, 0, 5), newText: "new" }] }] };
    const plan = decodeLspWorkspaceEdit(response, resolve); assert.equal(plan.documents[0]!.target.document.revision, 70); assert.equal(plan.documents[0]!.target.version, 3);
    const result = a.capture.document.buffer.apply(plan.documents[0]!.edits).buffer;
    assert.equal(result.slice(0, result.length), "😀\r\nfirstsecondA\rD\r\n\n"); assert.equal(plan.isCurrent(), true); assert.equal(Object.isFrozen(plan.documents[0]!.edits), true);
    const changes: WorkspaceEdit = { changes: { [target.document.uri]: [{ range: range(0, 0, 5), newText: "literal ${1} 😀\r" }] } };
    assert.equal(decodeLspWorkspaceEdit(changes, resolve).documents[0]!.edits[0]!.insert, "literal ${1} 😀\r");
    assert.equal(decodeLspWorkspaceEdit({ ...changes, documentChanges: [] }, resolve).documents.length, 0); assert.equal(decodeLspWorkspaceEdit({}, resolve).documents.length, 0);
    b.expire(); assert.equal(plan.isCurrent(), false); assert.throws(() => decodeLspWorkspaceEdit(response, resolve), error => error instanceof RpcError && error.code === -32801);
});

test("workspace edits reject the complete malformed, stale, aliased, annotated or oversized batch", async () => {
    const { capture } = await captured("abc\r\ndef"), uri = capture.document.uri, valid = { range: range(0, 0, 1), newText: "x" }, entry = { textDocument: { uri, version: 3 }, edits: [valid] };
    const resolve = (value: string) => value === uri || value === "alias" ? { ...capture, document: { ...capture.document, uri: value } } : undefined;
    for (const value of [null, { changes: null }, { documentChanges: [entry, { ...entry, textDocument: { uri: "unknown", version: 3 } }] },
        { documentChanges: [entry, { ...entry, textDocument: { uri: "alias", version: 3 } }] }, { documentChanges: [{ ...entry, textDocument: { uri, version: 70 } }] },
        { documentChanges: [{ ...entry, textDocument: { uri } }] }, { documentChanges: [entry, { kind: "create", uri: "new" }] }, { changeAnnotations: {}, documentChanges: [entry] },
        { changes: { [uri]: [valid, { ...valid, annotationId: "confirmation" }] } }, { changes: { [uri]: [valid, { range: range(0, 0, 2), newText: "overlap" }] } },
        { changes: { [uri]: [valid, { range: range(1, 0, 999), newText: "invalid final" }] } }, { changes: { [uri]: Array(1025).fill({ range: range(0, 0, 0), newText: "" }) } },
        { changes: { [uri]: [{ ...valid, newText: "x".repeat(16385) }] } }, { changes: { [uri]: Array(5).fill({ range: range(0, 0, 0), newText: "x".repeat(16384) }) } }]) assert.throws(() => decodeLspWorkspaceEdit(value, resolve));
    assert.equal(capture.document.buffer.slice(0, capture.document.buffer.length), "abc\r\ndef");
});
