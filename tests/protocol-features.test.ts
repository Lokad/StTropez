import test from "node:test";
import assert from "node:assert/strict";
import { TextDocument } from "vscode-languageserver-protocol/node.js";
import type { ApplyWorkspaceEditParams, CodeAction, Command, CompletionList, PublishDiagnosticsParams, WorkspaceEdit } from "vscode-languageserver-protocol/node.js";
import { TextBuffer } from "../src/core/text-buffer.ts";
import type { LspDocumentCapture } from "../src/protocol/index.ts";

const { LspLineIndex, decodeLspCompletions, decodeLspResolvedCompletion, rebaseLspCompletion, lspCompletionPlan, decodeLspDiagnostics, decodeLspHover, decodeLspLocations, decodeLspWorkspaceEdit, decodeLspApplyEdit, decodeLspCodeActions, decodeLspResolvedCodeAction, lspRangeOffsets, RpcError } = await import(process.env.STTROPEZ_PROTOCOL_TEST_MODULE ?? "../src/protocol/index.ts") as typeof import("../src/protocol/index.ts");
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

test("completion metadata and item defaults retain immutable resolve data with bounded filtering and commit characters", async () => {
    const { capture } = await captured("const saMORE"), response: CompletionList = { isIncomplete: false, itemDefaults: { editRange: { insert: range(0, 6, 8), replace: range(0, 6, 12) }, data: { token: 7 }, commitCharacters: [".", "::", "."] },
        items: [{ label: "sample", filterText: "sampleAlias", sortText: "01", preselect: true, documentation: { kind: "markdown", value: "<b>literal</b>" } }, { label: "second", data: { token: 8 }, commitCharacters: [";"] }] };
    const decoded = decodeLspCompletions(response, capture, 8, undefined, { resolve: true }), item = decoded.items[0]!;
    assert.equal(item.filterText, "sampleAlias"); assert.equal(item.sortText, "01"); assert.equal(item.preselect, true); assert.equal(item.documentation, "<b>literal</b>"); assert.deepEqual(item.commitCharacters, ["."]);
    assert.equal(item.source, capture.document); assert.deepEqual(item.primary, { from: 6, insertTo: 8, replaceTo: 12, text: "sample" });
    const opaque = item.resolve as { data: { token: number }; textEdit: unknown }; assert.equal(opaque.data.token, 7); assert.ok(opaque.textEdit); assert.ok(Object.isFrozen(opaque.data));
    assert.deepEqual(decoded.items[1]!.commitCharacters, [";"]); assert.deepEqual((decoded.items[1]!.resolve as { data: unknown }).data, { token: 8 });
    response.itemDefaults!.data.token = 99; assert.equal(opaque.data.token, 7);
    assert.deepEqual(decodeLspCompletions([{ label: "sample" }], capture, 8, undefined, { commitCharacters: [";"] }).items[0]!.commitCharacters, [";"]);
    for (const bad of [{ label: "bad", filterText: 1 }, { label: "bad", sortText: false }, { label: "bad", preselect: 1 }, { label: "bad", commitCharacters: null }, { label: "bad", data: "x".repeat(8193) }]) assert.throws(() => decodeLspCompletions([response.items[0], bad], capture, 8, undefined, { resolve: true }));
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
        diagnostics: [{ range: range(1, 21, 25), message: "<img src=x onerror=unsafe()> TODO", severity: 2, source: "fixture" }] };
    const decoded = decodeLspDiagnostics(response, capture); assert.equal(decoded.revision, 70); assert.equal(decoded.items[0]!.from, capture.index.offsetAt({ line: 1, character: 21 }));
    assert.equal(Object.isFrozen(decoded.items[0]), true); assert.deepEqual(decodeLspDiagnostics({ ...response, diagnostics: [] }, capture).items, []);
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

test("code actions preserve disabled/preferred/command choices and resolve only captured edit properties", async () => {
    const { capture, expire } = await captured("abc\r\n// TODO\n"), resolve = (uri: string) => uri === capture.document.uri ? capture : undefined;
    const edit: WorkspaceEdit = { documentChanges: [{ textDocument: { uri: capture.document.uri, version: 3 }, edits: [{ range: range(0, 0, 1), newText: "😀\r" }] }] };
    const values: (CodeAction | Command)[] = [{ title: "<img> literal", kind: "refactor.custom", isPreferred: true, edit }, { title: "disabled", disabled: { reason: "Not in this context" } },
        { title: "command", command: "host/command", arguments: [{ opaque: "never executed" }] }, { title: "lazy", kind: "quickfix", data: { token: 1, nested: { a: 1, b: "😀" } } }];
    const actions = decodeLspCodeActions(values, capture, resolve, true); assert.equal(actions[0]!.title, "<img> literal"); assert.equal(actions[0]!.preferred, true); assert.equal(actions[1]!.disabled, "Not in this context"); assert.equal(actions[2]!.command!.command, "host/command");
    assert.equal(Object.isFrozen(actions[3]!.resolve), true); assert.equal(Object.isFrozen(actions), true); assert.equal(decodeLspCodeActions(values, capture, resolve)[3]!.resolve, null);
    const resolved = decodeLspResolvedCodeAction({ ...values[3], data: { nested: { b: "😀", a: 1 }, token: 1 }, edit }, actions[3]!, capture, resolve); const result = capture.document.buffer.apply(resolved.edit!.documents[0]!.edits).buffer;
    assert.equal(result.slice(0, result.length), "😀\rbc\r\n// TODO\n"); assert.equal(resolved.resolve, null); assert.equal(capture.document.buffer.slice(0, 3), "abc");
    assert.deepEqual(decodeLspCodeActions(null, capture, resolve), []);
    for (const changed of [{ ...values[3], title: "retargeted", edit }, { ...values[3], edit, command: { title: "injected", command: "host/run" } }, { ...values[3], data: { token: 2 }, edit }, values[3]]) assert.throws(() => decodeLspResolvedCodeAction(changed, actions[3]!, capture, resolve));
    expire(); assert.equal(resolved.edit!.isCurrent(), false); assert.throws(() => decodeLspResolvedCodeAction({ ...values[3], edit }, actions[3]!, capture, resolve), error => error instanceof RpcError && error.code === -32801);
});

test("code actions refuse malformed final metadata/targets, incomplete lists and aggregate limits before publication", async () => {
    const { capture } = await captured("abc"), resolve = (uri: string) => uri === capture.document.uri ? capture : undefined, edit = { changes: { [capture.document.uri]: [{ range: range(0, 0, 0), newText: "x" }] } };
    for (const bad of [{ title: 1 }, { title: "bad", isPreferred: 1 }, { title: "bad", disabled: {} }, { title: "bad", command: { title: "run", command: "c", arguments: {} } },
        { title: "bad", data: { n: Infinity } }, { title: "bad", data: "x".repeat(8193) }, { title: "bad", edit: { changes: { unknown: [] } } },
        { title: "disabled", disabled: { reason: "Still validate its edits" }, edit: { changes: { unknown: [] } } }, { title: "bad", diagnostics: [{ range: range(0, 0, 99), message: "invalid" }] }]) assert.throws(() => decodeLspCodeActions([{ title: "valid", edit }, bad], capture, resolve, true));
    assert.throws(() => decodeLspCodeActions({ partial: [] }, capture, resolve)); assert.throws(() => decodeLspCodeActions(Array(65).fill({ title: "many", edit }), capture, resolve));
    const large = { title: "budget", edit: { changes: { [capture.document.uri]: [{ range: range(0, 0, 0), newText: "x".repeat(16384) }] } } };
    assert.throws(() => decodeLspCodeActions(Array(5).fill(large), capture, resolve));
});

test("workspace applyEdit requests retain a literal label and validate every captured target before review", async () => {
    const { capture, expire } = await captured("abc"), resolve = (uri: string) => uri === capture.document.uri ? capture : undefined;
    const value: ApplyWorkspaceEditParams = { label: "<img> review", edit: { documentChanges: [{ textDocument: { uri: capture.document.uri, version: 3 }, edits: [{ range: range(0, 0, 1), newText: "x" }] }] } };
    const request = decodeLspApplyEdit(value, resolve); assert.equal(request.label, "<img> review"); assert.equal(Object.isFrozen(request), true); assert.equal(request.edit.documents[0]!.target.document.revision, 70);
    assert.equal(decodeLspApplyEdit({ edit: {} }, resolve).label, null);
    for (const bad of [{ label: 1, edit: {} }, { label: "x".repeat(257), edit: {} }, {}, { ...value, edit: { changes: { unknown: [] } } }]) assert.throws(() => decodeLspApplyEdit(bad, resolve));
    expire(); assert.equal(request.edit.isCurrent(), false); assert.throws(() => decodeLspApplyEdit(value, resolve));
});
