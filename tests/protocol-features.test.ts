import test from "node:test";
import assert from "node:assert/strict";
import { TextDocument } from "vscode-languageserver-protocol/node.js";
import type { ApplyWorkspaceEditParams, CodeAction, Command, CompletionList, PublishDiagnosticsParams, WorkspaceEdit } from "vscode-languageserver-protocol/node.js";
import { TextBuffer } from "../src/core/text-buffer.ts";
import type { JsonValue, LspDocumentCapture, RpcTransport } from "../src/protocol/index.ts";

const { LspLineIndex, UnsupportedLspSnippetError, decodeLspCompletions, decodeLspResolvedCompletion, rebaseLspCompletion, lspCompletionPlan, decodeLspDiagnostics, decodeLspHover, decodeLspLocations, decodeLspWorkspaceEdit, decodeLspApplyEdit, decodeLspCodeActions, decodeLspResolvedCodeAction, lspRangeOffsets, RpcError } = await import(process.env.STTROPEZ_PROTOCOL_TEST_MODULE ?? "../src/protocol/index.ts") as typeof import("../src/protocol/index.ts");
const { JsonRpcConnection, decodeLspSignatureHelp, decodeLspDocumentLinks, decodeLspResolvedDocumentLink, decodeLspColor, decodeLspDocumentColors, decodeLspColorPresentations } = await import(process.env.STTROPEZ_PROTOCOL_TEST_MODULE ?? "../src/protocol/index.ts") as typeof import("../src/protocol/index.ts");
async function captured(text = "// header\r\nconst saMORE = 1; // TODO\rb\n") {
    const buffer = TextBuffer.from(text), index = await LspLineIndex.create(buffer, async () => {}); let active = true;
    const capture: LspDocumentCapture = Object.freeze({ document: Object.freeze({ uri: "host+fixture:source", languageId: "fixture", resourceId: "resource", documentId: "working", revision: 70, buffer }), index, version: 3, epoch: 2, registrationGeneration: 4, isCurrent: () => active });
    return { capture, expire: () => { active = false; } };
}

function rpcIncoming(t: test.TestContext) {
    let receive!: (message: string) => void;
    const port: RpcTransport = { send: () => {}, subscribe: listener => { receive = listener.message; return () => {}; }, dispose: () => {} };
    const rpc = new JsonRpcConnection(port, { schedule: () => () => {} }); t.after(() => rpc.dispose());
    return async (json: string) => { const call = rpc.request("fixture/data"); receive(`{"jsonrpc":"2.0","id":${call.id},"result":${json}}`); return call.result; };
}
test("opaque captures reuse bounded RPC-owned JSON without trusting host freezes or weakening snapshot limits", async t => {
    const { capture } = await captured("text"), incoming = rpcIncoming(t);
    const read = (data: unknown) => decodeLspDiagnostics({ uri: capture.document.uri, version: capture.version,
        diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: "message", data }] }, capture).items[0]!.data;
    const wire = await incoming('{"nested":[{"value":1}],"__proto__":{"safe":true}}') as { nested: { value: number }[] };
    assert.equal(read(wire), wire); assert.equal(Object.isFrozen(wire.nested[0]), true); assert.ok(Object.hasOwn(wire, "__proto__"));
    assert.throws(() => { wire.nested[0]!.value = 2; }, TypeError);
    const host = { nested: [{ value: 1 }] }, snapshot = read(host) as typeof host; host.nested[0]!.value = 2;
    assert.notEqual(snapshot, host); assert.equal(snapshot.nested[0]!.value, 1); assert.equal(read(snapshot), snapshot);
    const frozen = Object.freeze({ nested: { value: 1 } }); assert.notEqual(read(frozen), frozen);
    const bounded = await incoming(JSON.stringify(Array(99_999).fill(0))); assert.equal(read(bounded), bounded);
    const wide = await incoming(JSON.stringify({ large: Array(100_000).fill(0), small: { value: 1 } })) as { large: JsonValue; small: JsonValue };
    assert.throws(() => read(wide), TypeError); assert.throws(() => read(wide.large), TypeError); assert.equal(read(wide.small), wide.small);
    let deep: JsonValue = "leaf"; for (let i = 0; i < 63; i++) deep = [deep]; deep = await incoming(JSON.stringify(deep));
    assert.equal(read(deep), deep); assert.doesNotThrow(() => read([deep])); assert.throws(() => read([[deep]]), TypeError);
    const signed = await incoming('{"value":-0}') as { value: number }, normalized = read(signed) as typeof signed;
    assert.equal(Object.is(signed.value, -0), true); assert.equal(Object.is(normalized.value, 0), true); assert.notEqual(normalized, signed);
    const cyclic: { self?: unknown } = {}; cyclic.self = cyclic; assert.throws(() => read(cyclic), TypeError);
    let calls = 0; const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => { calls++; return 1; } });
    const array = Object.defineProperty([0], "0", { enumerable: true, get: () => { calls++; return 1; } });
    assert.throws(() => read(accessor), TypeError); assert.throws(() => read(array), TypeError); assert.equal(calls, 0);
    assert.throws(() => read(Array(1)), TypeError); assert.throws(() => read({ value: NaN }), TypeError);
});
test("signature help validates the complete literal result and normalizes active signatures and parameters", async () => {
    const { capture, expire } = await captured("😀 call("), value = { activeSignature: 1, activeParameter: 1, signatures: [
        { label: "call(x: number, y: number)", parameters: [{ label: "x: number" }, { label: [16, 25], documentation: { kind: "markdown", value: "<b>literal</b>" } }] },
        { label: "call(value: string)", activeParameter: 0, parameters: [{ label: [5, 18] }] }] };
    const result = decodeLspSignatureHelp(value, capture)!; assert.equal(result.activeSignature, 1); assert.equal(result.signatures[0]!.activeParameter, 1); assert.equal(result.signatures[1]!.activeParameter, 0);
    assert.equal(result.signatures[0]!.parameters[1]!.documentation, "<b>literal</b>"); assert.ok(Object.isFrozen(result.signatures[0]!.parameters)); assert.ok(Object.isFrozen(result.wire));
    assert.deepEqual(result.signatures[0]!.parameters[1]!.content, [{ kind: "markdown", value: "<b>literal</b>" }]);
    assert.equal(decodeLspSignatureHelp({ ...value, activeSignature: 999, activeParameter: 999 }, capture)!.activeSignature, 0);
    assert.equal(decodeLspSignatureHelp({ signatures: [{ label: "empty()" }] }, capture)!.signatures[0]!.activeParameter, null); assert.equal(decodeLspSignatureHelp(null, capture), null);
    for (const invalid of [{ signatures: null }, { ...value, activeParameter: -1 }, { signatures: [{ label: "call(x)", parameters: [{ label: "missing" }] }] },
        { signatures: [{ label: "call(x)", parameters: [{ label: [0, 99] }] }] }, { signatures: [...value.signatures, { label: 7 }] }, { signatures: Array(33).fill(value.signatures[0]) }]) assert.throws(() => decodeLspSignatureHelp(invalid, capture));
    expire(); assert.throws(() => decodeLspSignatureHelp(value, capture), error => error instanceof RpcError && error.code === -32801);
});
test("document links retain opaque host URIs and resolve only the captured target and tooltip", async () => {
    const { capture, expire } = await captured('import "module";'), wire = { range: range(0, 8, 14), data: { token: 3 }, tooltip: "<b>literal</b>" };
    const links = decodeLspDocumentLinks([wire, { ...wire, target: "host+opaque:%2F resource" }], capture, true); assert.equal(links[0]!.target, null); assert.equal(links[1]!.target, "host+opaque:%2F resource"); assert.ok(Object.isFrozen(links[0]!.resolve));
    const resolved = decodeLspResolvedDocumentLink({ ...wire, target: "custom:unknown", tooltip: "Resolved literal" }, links[0]!, capture); assert.equal(resolved.target, "custom:unknown"); assert.equal(resolved.resolve, null);
    for (const invalid of [{ ...wire, target: "" }, { ...wire, range: range(0, 8, 99) }, { ...wire, tooltip: 7 }, { ...wire, data: "x".repeat(8193) }]) assert.throws(() => decodeLspDocumentLinks([wire, invalid], capture, true));
    assert.throws(() => decodeLspResolvedDocumentLink({ ...wire, target: "custom:x", data: { token: 4 } }, links[0]!, capture));
    assert.throws(() => decodeLspResolvedDocumentLink({ ...wire, range: range(0, 0, 2), target: "custom:x" }, links[0]!, capture));
    assert.deepEqual(decodeLspDocumentLinks(null, capture), []); expire(); assert.throws(() => decodeLspResolvedDocumentLink({ ...wire, target: "custom:x" }, links[0]!, capture), error => error instanceof RpcError && error.code === -32801);
});
test("document colors and presentations validate channels, fallback text and every additional edit before publication", async () => {
    const { capture, expire } = await captured("const c = #fff;"), color = { red: 1, green: 0, blue: .5, alpha: .25 };
    const colors = decodeLspDocumentColors([{ range: range(0, 10, 14), color }], capture), reference = colors[0]!; assert.ok(Object.isFrozen(reference.color)); assert.deepEqual(decodeLspColor(color), color);
    const presentations = decodeLspColorPresentations([{ label: "#123" }, { label: "Explicit", textEdit: { range: range(0, 10, 14), newText: "rgba(1,2,3,.5)" }, additionalTextEdits: [{ range: range(0, 0, 0), newText: "// color\r\n" }] }], reference, capture);
    const after = capture.document.buffer.apply(presentations[1]!.edits).buffer; assert.equal(after.slice(0, after.length), "// color\r\nconst c = rgba(1,2,3,.5);"); assert.equal(presentations[0]!.edits[0]!.insert, "#123");
    for (const invalid of [{ ...color, alpha: NaN }, { ...color, red: 2 }, { ...color, blue: "0" }, {}]) assert.throws(() => decodeLspDocumentColors([{ range: range(0, 10, 14), color: invalid }], capture));
    for (const invalid of [{ label: "bad", additionalTextEdits: [{ range: range(0, 11, 12), newText: "overlap" }] }, { label: "bad", textEdit: { range: range(0, 10, 99), newText: "bad" } }, { label: "x".repeat(4097) }]) assert.throws(() => decodeLspColorPresentations([{ label: "valid" }, invalid], reference, capture));
    assert.deepEqual(decodeLspColorPresentations([], reference, capture), []); expire(); assert.throws(() => decodeLspDocumentColors([], capture), error => error instanceof RpcError && error.code === -32801);
});
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
    assert.deepEqual(decodeLspCompletions(null, capture, 8), { incomplete: false, items: [], omitted: [] });
    for (const bad of [{ label: "invalid format", insertTextFormat: 3 }, { label: "command", command: { title: "run", command: "host/run" } },
        { label: "overlap", textEdit: { newText: "x", range: range(0, 6, 12) }, additionalTextEdits: [{ range: range(0, 7, 8), newText: "bad" }] },
        { label: "clamped", textEdit: { newText: "x", range: range(0, 6, 999) } }, { label: "reversed", textEdit: { newText: "x", insert: range(0, 6, 10), replace: range(0, 6, 8) } },
        { label: "duplicate insert", textEdit: { newText: "x", range: range(0, 8, 8) }, additionalTextEdits: [{ range: range(0, 8, 8), newText: "bad" }] }]) {
        assert.throws(() => decodeLspCompletions([{ label: "valid" }, bad], capture, 8, fallback));
    }
    assert.equal(decodeLspCompletions({ ...response, items: Array.from({ length: 257 }, () => ({ label: "x" })) }, capture, 8).items.length, 257);
    assert.throws(() => decodeLspCompletions({ ...response, itemDefaults: { ...response.itemDefaults, unknownBehavior: true } }, capture, 8));
    assert.throws(() => decodeLspCompletions({ isIncomplete: false, items: [], itemDefaults: { editRange: range(0, 0, 999) } }, capture, 8));
    assert.equal(decodeLspCompletions(response, capture, 8, () => { throw new Error("Unused word fallback must not reject explicit ranges"); }).items.length, 1);
});

test("mixed snippet lists retain supported choices, map stops past additional edits and validate omitted item ranges", async () => {
    const { capture } = await captured("// Header\r\ntemplate"), offset = capture.document.buffer.length;
    const item = { label: "linked", insertTextFormat: 2, textEdit: { range: range(1, 0, 8), newText: '${1:😀name} = "$2"; $1$0' },
        additionalTextEdits: [{ range: range(0, 0, 0), newText: "// Added\r\n" }] };
    const omitted = { label: "variable", insertTextFormat: 2, insertText: "$TM_FILENAME" };
    const result = decodeLspCompletions([{ label: "plain" }, item, omitted], capture, offset);
    assert.deepEqual(result.items.map(item => item.label), ["plain", "linked"]);
    assert.deepEqual(result.omitted.map(item => item.label), ["variable"]);
    const applied = capture.document.buffer.apply(result.items[1]!.replace.edits).buffer;
    assert.equal(applied.text(), '// Added\r\n// Header\r\n😀name = ""; 😀name');
    const stops = result.items[1]!.replace.snippet!;
    assert.deepEqual(stops[0]!.ranges.map(range => applied.slice(range.from, range.to)), ["😀name", "😀name"]);
    assert.equal(result.items[1]!.replace.head, applied.length);
    assert.throws(() => decodeLspCompletions([item, { ...omitted, textEdit: { range: range(1, 0, 999), newText: "$TM_FILENAME" } }], capture, offset));
});

test("lazy completion supplies primary content within captured ranges and keeps identity and edits atomic", async () => {
    const { capture } = await captured("// Header\r\ntemplate"), offset = capture.document.buffer.length;
    const original = decodeLspCompletions([{ label: "lazy", filterText: "template", insertTextFormat: 2, data: { key: 1 } }], capture, offset,
        { from: offset - 8, to: offset, replaceTo: offset }, { resolve: true }).items[0]!;
    const reply = { ...original.resolve as object, textEdit: { range: range(1, 0, 8), newText: 'const ${1:value} = ${2|0,1|};\r\n$1;$0' },
        additionalTextEdits: [{ range: range(0, 0, 0), newText: "// import\r\n" }] };
    const resolved = decodeLspResolvedCompletion(reply, original, capture), text = capture.document.buffer.apply(resolved.replace.edits).buffer;
    assert.equal(text.text(), "// import\r\n// Header\r\nconst value = 0;\r\nvalue;");
    assert.deepEqual(resolved.replace.snippet![0]!.ranges.map(range => text.slice(range.from, range.to)), ["value", "value"]);
    for (const value of [{ ...reply, label: "other" }, { ...reply, filterText: "other" }, { ...reply, data: { key: 2 } },
        { ...reply, textEdit: { range: range(1, 1, 8), newText: "other" } }, { ...reply, additionalTextEdits: [{ range: range(1, 1, 3), newText: "overlap" }] }]) assert.throws(() => decodeLspResolvedCompletion(value, original, capture));
    const direct = decodeLspCompletions([{ label: "lazy", insertText: "old" }], capture, offset, undefined, { resolve: true }).items[0]!;
    assert.equal(decodeLspResolvedCompletion({ ...direct.resolve as object, insertText: "new body" }, direct, capture).primary.text, "new body");
    const unsupported = { ...reply, textEdit: { ...reply.textEdit, newText: "$TM_FILENAME" } };
    assert.throws(() => decodeLspResolvedCompletion(unsupported, original, capture), UnsupportedLspSnippetError);
    assert.throws(() => decodeLspResolvedCompletion({ ...unsupported, additionalTextEdits: [{ range: range(1, 1, 3), newText: "overlap" }] }, original, capture),
        error => error instanceof Error && !(error instanceof UnsupportedLspSnippetError));
});

test("completion catalogues retain every candidate and reject malformed later edits without truncation", async () => {
    const { capture } = await captured("const saMORE\r\n"), fallback = { from: 6, to: 8, replaceTo: 12 };
    const values = Array.from({ length: 1200 }, (_, index) => ({ label: `sample${String(index).padStart(4, "0")}`,
        detail: "A useful catalogue entry with lazily supplied documentation.", data: { index, context: "retained for resolution" } }));
    for (const incomplete of [false, true]) {
        const result = decodeLspCompletions({ isIncomplete: incomplete, items: values }, capture, 8, fallback, { resolve: true });
        assert.equal(result.items.length, 1200); assert.equal(result.incomplete, incomplete);
        const tail = result.items[1199]!;
        assert.equal(capture.document.buffer.apply(tail.replace.edits).buffer.text(), "const sample1199\r\n");
        assert.deepEqual((tail.resolve as { data: unknown }).data, values[1199]!.data);
    }
    assert.throws(() => decodeLspCompletions([...values, { label: "bad tail", textEdit: { range: range(0, 0, 999), newText: "invalid" } }], capture, 8, fallback));
});

test("completion metadata and item defaults retain immutable resolve data with bounded filtering and commit characters", async t => {
    const { capture } = await captured("const saMORE"), response: CompletionList = { isIncomplete: false, itemDefaults: { editRange: { insert: range(0, 6, 8), replace: range(0, 6, 12) }, data: { token: 7 }, commitCharacters: [".", "::", "."] },
        items: [{ label: "sample", filterText: "sampleAlias", sortText: "01", preselect: true, documentation: { kind: "markdown", value: "<b>literal</b>" } }, { label: "second", data: { token: 8 }, commitCharacters: [";"] }] };
    const decoded = decodeLspCompletions(response, capture, 8, undefined, { resolve: true }), item = decoded.items[0]!;
    assert.equal(item.filterText, "sampleAlias"); assert.equal(item.sortText, "01"); assert.equal(item.preselect, true); assert.equal(item.documentation, "<b>literal</b>"); assert.deepEqual(item.commitCharacters, ["."]);
    assert.equal(item.source, capture.document); assert.deepEqual(item.primary, { from: 6, insertTo: 8, replaceTo: 12, text: "sample" });
    const opaque = item.resolve as { data: { token: number }; textEdit: unknown }; assert.equal(opaque.data.token, 7); assert.ok(opaque.textEdit); assert.ok(Object.isFrozen(opaque.data));
    assert.deepEqual(decoded.items[1]!.commitCharacters, [";"]); assert.deepEqual((decoded.items[1]!.resolve as { data: unknown }).data, { token: 8 });
    const incoming = rpcIncoming(t), wire = await incoming(JSON.stringify(response)) as unknown as CompletionList;
    const inherited = decodeLspCompletions(wire, capture, 8, undefined, { resolve: true }).items[0]!.resolve as typeof opaque;
    assert.notEqual(inherited, wire.items[0]); assert.equal(wire.items[0]!.textEdit, undefined); assert.deepEqual(inherited, opaque);
    const plain = await incoming(JSON.stringify([{ label: "standalone", data: { token: 9 } }])) as JsonValue[];
    assert.equal(decodeLspCompletions(plain, capture, 8, undefined, { resolve: true }).items[0]!.resolve, plain[0]);
    response.itemDefaults!.data.token = 99; assert.equal(opaque.data.token, 7);
    assert.deepEqual(decodeLspCompletions([{ label: "sample" }], capture, 8, undefined, { commitCharacters: [";"] }).items[0]!.commitCharacters, [";"]);
    for (const bad of [{ label: "bad", filterText: 1 }, { label: "bad", sortText: false }, { label: "bad", preselect: 1 }, { label: "bad", commitCharacters: null }, { label: "bad", data: { n: NaN } }]) assert.throws(() => decodeLspCompletions([response.items[0], bad], capture, 8, undefined, { resolve: true }));
});

test("completion resolution permits captured display/additional edits but refuses retargeting, overlap and stale documents", async () => {
    const { capture, expire } = await captured("const saMORE"), item = decodeLspCompletions([{ label: "sample", data: { token: 1 }, textEdit: { newText: "sample", insert: range(0, 6, 8), replace: range(0, 6, 12) } }], capture, 8, undefined, { resolve: true }).items[0]!;
    const wire = item.resolve as Record<string, unknown>, reply = { ...wire, detail: "resolved detail", documentation: "literal documentation", additionalTextEdits: [{ range: range(0, 0, 0), newText: "// import\r\n" }] };
    const resolved = decodeLspResolvedCompletion(reply, item, capture); assert.equal(resolved.resolve, null); assert.equal(resolved.detail, "resolved detail"); assert.equal(resolved.documentation, "literal documentation");
    const after = capture.document.buffer.apply(resolved.replace.edits).buffer; assert.equal(after.slice(0, after.length), "// import\r\nconst sample"); assert.equal(resolved.replace.head, after.length);
    const commitItem = { ...resolved, commitCharacters: Object.freeze([";"]) }, committed = lspCompletionPlan(commitItem, "replace", ";"), committedText = capture.document.buffer.apply(committed.edits).buffer;
    assert.equal(committedText.slice(0, committedText.length), "// import\r\nconst sample;"); assert.equal(committed.head, committedText.length); assert.throws(() => lspCompletionPlan(commitItem, "insert", "."));
    for (const invalid of [{ ...reply, label: "other" }, { ...reply, data: { token: 2 } }, { ...reply, textEdit: { newText: "other", range: range(0, 6, 12) } },
        { ...reply, additionalTextEdits: [{ range: range(0, 7, 8), newText: "overlap" }] }, { ...reply, additionalTextEdits: [{ range: range(0, 0, 999), newText: "outside" }] }]) assert.throws(() => decodeLspResolvedCompletion(invalid, item, capture));
    assert.throws(() => decodeLspResolvedCompletion(reply, item, { ...capture, document: { ...capture.document, revision: 71 } }));
    expire(); assert.throws(() => decodeLspResolvedCompletion(reply, item, capture), error => error instanceof RpcError && error.code === -32801);
});

test("compatible prefix rebasing uses exact commit metadata and resolves additions against the newly synchronized snapshot", async () => {
    const { capture } = await captured("const saMORE"), item = decodeLspCompletions([{ label: "sample", data: { token: 1 }, textEdit: { newText: "sample", insert: range(0, 6, 8), replace: range(0, 6, 12) },
        additionalTextEdits: [{ range: range(0, 0, 0), newText: "// import\r\n" }] }], capture, 8, undefined, { resolve: true }).items[0]!;
    const applied = capture.document.buffer.apply([{ from: 8, to: 8, insert: "m" }]), next = Object.freeze({ ...capture.document, revision: 71, buffer: applied.buffer });
    const change = Object.freeze({ previousRevision: 70, transactionId: 1, origin: "human" as const, kind: "typing" as const, mapping: applied.mapping });
    const rebased = rebaseLspCompletion(item, next, change, 8)!; assert.ok(rebased); assert.equal(rebased.source, next); assert.equal(rebased.primary.insertTo, 9); assert.equal(rebased.primary.replaceTo, 13);
    const after = next.buffer.apply(rebased.replace.edits).buffer; assert.equal(after.slice(0, after.length), "// import\r\nconst sample");
    const currentCapture = { ...capture, document: next, version: 4, index: await LspLineIndex.create(next.buffer, async () => {}) };
    const resolved = decodeLspResolvedCompletion({ ...item.resolve as object, additionalTextEdits: [{ range: range(0, 13, 13), newText: ";" }] }, rebased, currentCapture);
    const result = next.buffer.apply(resolved.replace.edits).buffer; assert.equal(result.slice(0, result.length), "const sample;"); assert.equal(resolved.replace.head, 12);
    assert.equal(rebaseLspCompletion(item, next, { ...change, previousRevision: 69 }, 8), undefined);
    assert.equal(rebaseLspCompletion(item, next, { ...change, kind: "undo" }, 8), undefined);
    assert.equal(rebaseLspCompletion(item, next, { ...change, origin: "host" }, 8), undefined);
    const unrelated = capture.document.buffer.apply([{ from: 0, to: 1, insert: "C" }, { from: 8, to: 8, insert: "m" }]);
    assert.equal(rebaseLspCompletion(item, { ...next, buffer: unrelated.buffer }, { ...change, mapping: unrelated.mapping }, 8), undefined);
    const unknown = { oldLength: applied.mapping.oldLength, newLength: applied.mapping.newLength, map: applied.mapping.map.bind(applied.mapping), mapRange: applied.mapping.mapRange.bind(applied.mapping), invert: applied.mapping.invert.bind(applied.mapping) };
    assert.equal(rebaseLspCompletion(item, next, { ...change, mapping: unknown }, 8), undefined);
});

test("diagnostics separate provider freshness from validated snapshot placement and retain unplaceable wire ranges", async () => {
    const { capture, expire } = await captured(), response: PublishDiagnosticsParams = { uri: capture.document.uri, version: 3,
        diagnostics: [{ range: range(1, 21, 25), message: "<img src=x onerror=unsafe()> TODO", severity: 2, source: "fixture",
            code: "fixture/check", codeDescription: { href: "host-help:diagnostic/check" }, tags: [1, 2],
            relatedInformation: [{ location: { uri: "host+fixture:unopened", range: range(42, 1, 3) }, message: "Related definition" }], data: { token: [1, null, "opaque"] } }] };
    const decoded = decodeLspDiagnostics(response, capture); assert.equal(decoded.revision, 70); assert.equal(decoded.items[0]!.from, capture.index.offsetAt({ line: 1, character: 21 }));
    assert.equal(Object.isFrozen(decoded.items[0]), true); assert.deepEqual(decodeLspDiagnostics({ ...response, diagnostics: [] }, capture).items, []);
    const item = decoded.items[0]!;
    assert.equal(item.code, "fixture/check"); assert.deepEqual(item.codeDescription, response.diagnostics[0]!.codeDescription);
    assert.deepEqual(item.relatedInformation, response.diagnostics[0]!.relatedInformation); assert.deepEqual(item.data, { token: [1, null, "opaque"] });
    for (const nested of [item.codeDescription, item.tags, item.relatedInformation, item.relatedInformation![0], item.relatedInformation![0]!.location,
        item.relatedInformation![0]!.location.range.start, item.data, (item.data as { token: unknown }).token]) assert.equal(Object.isFrozen(nested), true);
    response.diagnostics[0]!.relatedInformation![0]!.message = "mutated"; (response.diagnostics[0]!.data as { token: unknown[] }).token.push(2);
    assert.equal(item.relatedInformation![0]!.message, "Related definition"); assert.deepEqual(item.data, { token: [1, null, "opaque"] });
    for (const code of [-2147483648, 2147483647, "", "TS2345"]) {
        const metadata = decodeLspDiagnostics({ ...response, diagnostics: [{ range: range(0, 0, 1), message: "metadata", code, tags: [1, 99, -1], data: null }] }, capture).items[0]!;
        assert.equal(metadata.code, code); assert.deepEqual(metadata.tags, [1, 99, -1]); assert.equal(metadata.data, null);
    }
    for (const bad of [{ code: null }, { code: 2147483648 }, { code: 1.5 }, { codeDescription: null }, { codeDescription: { href: 1 } },
        { tags: [1, "2"] }, { relatedInformation: {} }, { relatedInformation: [{ location: { uri: "host:target", range: range(0, 2, 1) }, message: "bad" }] },
        { data: { nested: Infinity } }]) assert.throws(() => decodeLspDiagnostics({ ...response, diagnostics: [...response.diagnostics, { range: range(0, 0, 1), message: "bad tail", ...bad }] }, capture));
    const { version: _version, ...unversioned } = response; const uncertain = decodeLspDiagnostics(unversioned, capture);
    assert.equal(uncertain.revision, null); assert.equal(uncertain.version, null); assert.equal(uncertain.freshness, "unversioned"); assert.equal(uncertain.snapshotRevision, 70);
    assert.equal(uncertain.items[0]!.from, decoded.items[0]!.from); assert.equal(uncertain.items[0]!.placement, "placed"); assert.deepEqual(uncertain.items[0]!.range, response.diagnostics[0]!.range);
    for (const version of [undefined, 3]) { const outside = decodeLspDiagnostics({ ...response, version, diagnostics: [{ range: range(100, 0, 999), message: "unplaceable" }] }, capture);
        assert.equal(outside.items[0]!.placement, "out-of-bounds"); assert.equal(outside.items[0]!.from, null); assert.deepEqual(outside.items[0]!.range, range(100, 0, 999)); }
    for (const invalid of [{ ...response, version: null }, { ...response, uri: "host+fixture:other" }, { ...response, diagnostics: [...response.diagnostics, { range: range(1, 10, 0), message: "invalid tail" }] }]) assert.throws(() => decodeLspDiagnostics(invalid, capture));
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
    assert.deepEqual(decodeLspHover({ contents: "info", range: range(0, 0, 5) }, capture), { text: "info", content: [{ kind: "markdown", value: "info" }], range: { from: 0, to: 5 } });
    assert.deepEqual(decodeLspHover({ contents: { kind: "plaintext", value: "**literal**" } }, capture)!.content, [{ kind: "plaintext", value: "**literal**" }]);
    const mixed = decodeLspHover({ contents: [{ language: "ts", value: "const x = '<img>';" }, "**Details**"] }, capture)!.content;
    assert.deepEqual(mixed, [{ kind: "code", language: "ts", value: "const x = '<img>';" }, { kind: "markdown", value: "**Details**" }]);
    assert.ok(Object.isFrozen(mixed)); assert.ok(mixed.every(Object.isFrozen));
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
    for (const bad of [[location, { ...location, uri: "custom+host:unknown" }], [location, { ...location, range: range(1, 0, 999) }], [link, location], [{ ...link, targetSelectionRange: range(1, 0, 18) }], [{ ...link, originSelectionRange: range(0, 0, 999) }], link]) assert.throws(() => decodeLspLocations(bad, "definition", origin.capture, resolve));
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

test("workspace edits reject the complete malformed, stale, aliased or annotated batch", async () => {
    const { capture } = await captured("abc\r\ndef"), uri = capture.document.uri, valid = { range: range(0, 0, 1), newText: "x" }, entry = { textDocument: { uri, version: 3 }, edits: [valid] };
    const resolve = (value: string) => value === uri || value === "alias" ? { ...capture, document: { ...capture.document, uri: value } } : undefined;
    for (const value of [null, { changes: null }, { documentChanges: [entry, { ...entry, textDocument: { uri: "unknown", version: 3 } }] },
        { documentChanges: [entry, { ...entry, textDocument: { uri: "alias", version: 3 } }] }, { documentChanges: [{ ...entry, textDocument: { uri, version: 70 } }] },
        { documentChanges: [{ ...entry, textDocument: { uri } }] }, { documentChanges: [entry, { kind: "create", uri: "new" }] }, { changeAnnotations: {}, documentChanges: [entry] },
        { changes: { [uri]: [valid, { ...valid, annotationId: "confirmation" }] } }, { changes: { [uri]: [valid, { range: range(0, 0, 2), newText: "overlap" }] } },
        { changes: { [uri]: [valid, { range: range(1, 0, 999), newText: "invalid final" }] } }]) assert.throws(() => decodeLspWorkspaceEdit(value, resolve));
    assert.equal(capture.document.buffer.slice(0, capture.document.buffer.length), "abc\r\ndef");
});

test("code actions preserve disabled/preferred/command choices and resolve only captured edit properties", async () => {
    const { capture, expire } = await captured("abc\r\n// TODO\n"), resolve = (uri: string) => uri === capture.document.uri ? capture : undefined;
    const edit: WorkspaceEdit = { documentChanges: [{ textDocument: { uri: capture.document.uri, version: 3 }, edits: [{ range: range(0, 0, 1), newText: "😀\r" }] }] };
    const values: (CodeAction | Command)[] = [{ title: "<img> literal", kind: "refactor.custom", isPreferred: true, edit }, { title: "disabled", disabled: { reason: "Not in this context" } },
        { title: "command", command: "host/command", arguments: [{ opaque: "never executed" }] }, { title: "lazy", kind: "quickfix", data: { token: 1, nested: { a: 1, b: "😀" } },
            diagnostics: [{ range: range(0, 0, 1), message: "Fix this", code: "fixture/fix", data: { token: "diagnostic" } }] }];
    const actions = decodeLspCodeActions(values, capture, resolve, true); assert.equal(actions[0]!.title, "<img> literal"); assert.equal(actions[0]!.preferred, true); assert.equal(actions[1]!.disabled, "Not in this context"); assert.equal(actions[2]!.command!.command, "host/command");
    assert.equal(Object.isFrozen(actions[3]!.resolve), true); assert.equal(Object.isFrozen(actions), true); assert.equal(decodeLspCodeActions(values, capture, resolve)[3]!.resolve, null);
    const resolved = decodeLspResolvedCodeAction({ ...values[3], data: { nested: { b: "😀", a: 1 }, token: 1 }, edit }, actions[3]!, capture, resolve); const result = capture.document.buffer.apply(resolved.edit!.documents[0]!.edits).buffer;
    assert.equal(result.slice(0, result.length), "😀\rbc\r\n// TODO\n"); assert.equal(resolved.resolve, null); assert.equal(capture.document.buffer.slice(0, 3), "abc");
    assert.equal(resolved.diagnostics![0]!.code, "fixture/fix"); assert.deepEqual(resolved.diagnostics![0]!.data, { token: "diagnostic" });
    assert.deepEqual(decodeLspCodeActions(null, capture, resolve), []);
    for (const changed of [{ ...values[3], title: "retargeted", edit }, { ...values[3], edit, command: { title: "injected", command: "host/run" } }, { ...values[3], data: { token: 2 }, edit }, values[3]]) assert.throws(() => decodeLspResolvedCodeAction(changed, actions[3]!, capture, resolve));
    expire(); assert.equal(resolved.edit!.isCurrent(), false); assert.throws(() => decodeLspResolvedCodeAction({ ...values[3], edit }, actions[3]!, capture, resolve), error => error instanceof RpcError && error.code === -32801);
});

test("code actions refuse malformed final metadata/targets and incomplete lists before publication", async () => {
    const { capture } = await captured("abc"), resolve = (uri: string) => uri === capture.document.uri ? capture : undefined, edit = { changes: { [capture.document.uri]: [{ range: range(0, 0, 0), newText: "x" }] } };
    for (const bad of [{ title: 1 }, { title: "bad", isPreferred: 1 }, { title: "bad", disabled: {} }, { title: "bad", command: { title: "run", command: "c", arguments: {} } },
        { title: "bad", data: { n: Infinity } }, { title: "bad", edit: { changes: { unknown: [] } } },
        { title: "disabled", disabled: { reason: "Still validate its edits" }, edit: { changes: { unknown: [] } } }, { title: "bad", diagnostics: [{ range: range(0, 0, 99), message: "invalid" }] }]) assert.throws(() => decodeLspCodeActions([{ title: "valid", edit }, bad], capture, resolve, true));
    assert.throws(() => decodeLspCodeActions({ partial: [] }, capture, resolve));
});

test("workspace applyEdit requests retain a literal label and validate every captured target before review", async () => {
    const { capture, expire } = await captured("abc"), resolve = (uri: string) => uri === capture.document.uri ? capture : undefined;
    const value: ApplyWorkspaceEditParams = { label: "<img> review", edit: { documentChanges: [{ textDocument: { uri: capture.document.uri, version: 3 }, edits: [{ range: range(0, 0, 1), newText: "x" }] }] } };
    const request = decodeLspApplyEdit(value, resolve); assert.equal(request.label, "<img> review"); assert.equal(Object.isFrozen(request), true); assert.equal(request.edit.documents[0]!.target.document.revision, 70);
    assert.equal(decodeLspApplyEdit({ edit: {} }, resolve).label, null);
    for (const bad of [{ label: 1, edit: {} }, {}, { ...value, edit: { changes: { unknown: [] } } }]) assert.throws(() => decodeLspApplyEdit(bad, resolve));
    expire(); assert.equal(request.edit.isCurrent(), false); assert.throws(() => decodeLspApplyEdit(value, resolve));
});

test("practical diagnostic, reference, action and edit batches retain every result and validate their tails", async () => {
    const { capture } = await captured("x\n".repeat(1200)), uri = capture.document.uri, resolve = (value: string) => value === uri ? capture : undefined;
    const diagnostics = Array.from({ length: 300 }, (_, line) => ({ range: range(line, 0, 1), message: `${line}: ${"detail ".repeat(800)}` }));
    const decoded = decodeLspDiagnostics({ uri, diagnostics }, capture);
    assert.equal(decoded.items.length, 300); assert.equal(decoded.items[299]!.message, diagnostics[299]!.message); assert.equal(decoded.freshness, "unversioned");
    assert.throws(() => decodeLspDiagnostics({ uri, diagnostics: [...diagnostics, { range: range(0, 1, 0), message: "invalid tail" }] }, capture));
    const locations = Array.from({ length: 1200 }, (_, line) => ({ uri, range: range(line, 0, 1) }));
    const references = decodeLspLocations(locations, "references", capture, resolve); assert.equal(references.length, 1200); assert.equal(references.at(-1)!.from, 2398);
    assert.throws(() => decodeLspLocations([...locations, { uri, range: range(1201, 0, 1) }], "references", capture, resolve));
    const edits = locations.map(item => ({ range: item.range, newText: "y" }));
    const edit = { changes: { [uri]: edits } }, plan = decodeLspWorkspaceEdit(edit, resolve);
    assert.equal(capture.document.buffer.apply(plan.documents[0]!.edits).buffer.text(), "y\n".repeat(1200));
    assert.throws(() => decodeLspWorkspaceEdit({ changes: { [uri]: [...edits, { range: range(0, 0, 1), newText: "overlap" }] } }, resolve));
    const actions = Array.from({ length: 65 }, (_, n) => ({ title: `Action ${n}`, edit: n === 64 ? edit : { changes: { [uri]: edits.slice(0, 20) } } }));
    assert.equal(decodeLspCodeActions(actions, capture, resolve).at(-1)!.edit!.documents[0]!.edits.length, 1200);
    assert.throws(() => decodeLspCodeActions([...actions, { title: "invalid tail", edit: { changes: { unknown: [] } } }], capture, resolve));
    assert.equal(capture.document.buffer.text(), "x\n".repeat(1200));
});

test("large completion content and lazy metadata stay complete while snippet expansion follows session size policy", async () => {
    const { capture } = await captured("x\n".repeat(70)), body = "a".repeat(20000), additionalTextEdits = Array.from({ length: 40 }, (_, n) => ({ range: range(n + 1, 0, 1), newText: "b" }));
    const item = { label: "Generated declaration", detail: body, documentation: body, data: { context: body }, insertText: body, additionalTextEdits };
    const decoded = decodeLspCompletions([item], capture, 1, { from: 0, to: 1, replaceTo: 1 }, { resolve: true }).items[0]!;
    assert.equal(decoded.primary.text, body); assert.equal(decoded.additional.length, 40); assert.equal(decoded.documentation, body);
    const resolved = decodeLspResolvedCompletion({ ...decoded.resolve as object, insertText: body + "z" }, decoded, capture);
    assert.equal(capture.document.buffer.apply(resolved.replace.edits).buffer.text(), body + "z\n" + "b\n".repeat(40) + "x\n".repeat(29));
    const snippet = { label: "Repeated declaration", insertTextFormat: 2, insertText: "${1:" + body + "}$1$0" };
    assert.equal(decodeLspCompletions([snippet], { ...capture, maxDocumentUnits: 50000 }, 1).items[0]!.primary.text.length, 40000);
    assert.equal(decodeLspCompletions([snippet], { ...capture, maxDocumentUnits: 30000 }, 1).omitted.length, 1);
    assert.throws(() => decodeLspCompletions([item, { ...item, additionalTextEdits: [...additionalTextEdits, { range: range(69, 0, 999), newText: "invalid" }] }], capture, 1));
    const lazy = decodeLspCompletions([{ label: "Lazy", insertTextFormat: 2 }], capture, 1, undefined, { resolve: true }).items[0]!;
    assert.throws(() => decodeLspResolvedCompletion({ ...lazy.resolve as object, insertText: snippet.insertText }, lazy, { ...capture, maxDocumentUnits: 30000 }), UnsupportedLspSnippetError);
});
