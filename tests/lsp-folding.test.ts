import test from "node:test";
import assert from "node:assert/strict";
import { clientFixture, latch, protocol, settled } from "./helpers/lsp-client.ts";
const { createLspFoldingClient, RpcError } = protocol;
test("LSP folding negotiates whole lines and validates the entire response against its captured buffer", async t => {
    const f = clientFixture(t), client = createLspFoldingClient(f.provider); t.after(client.dispose);
    f.workspace.edit({ documentId: f.source.documentId, expectedRevision: 0, edits: [{ from: 0, to: 10, insert: "root 👩‍💻\r\n  child\r\nend" }], origin: "host" });
    let value: unknown = [{ startLine: 0, endLine: 1, kind: "host-group", startCharacter: 4, endCharacter: 2 }, { startLine: 1, endLine: 10 }];
    f.peer.onRequest("textDocument/foldingRange", () => value);
    const result = await client.run(f.document()).result;
    assert.deepEqual(result.ranges, [{ from: 0, to: f.document().buffer.offsetAt(2), group: "host-group" }]);
    const init = f.sent("initialize")[0]!.params as { capabilities: { textDocument: { foldingRange: unknown } } };
    assert.deepEqual(init.capabilities.textDocument.foldingRange, { dynamicRegistration: true, lineFoldingOnly: true, foldingRangeKind: { valueSet: ["comment", "imports", "region"] } });
    assert.deepEqual(f.sent("textDocument/foldingRange")[0]!.params, { textDocument: { uri: `generic:${f.source.id}` } });
    value = [{ startLine: 0, endLine: 1 }, { startLine: 0, endLine: "bad" }];
    await assert.rejects(client.run(f.document()).result, /Malformed/); assert.equal(result.isCurrent(), false);
    value = null; assert.deepEqual((await client.run(f.document()).result).ranges, []);
});
test("fold discovery cancellation and edits cannot publish obsolete provider ranges", async t => {
    const f = clientFixture(t), client = createLspFoldingClient(f.provider), entered = latch<void>(), answer = latch<unknown>();
    t.after(() => { answer.resolve([]); client.dispose(); });
    f.peer.onRequest("textDocument/foldingRange", () => { entered.resolve(); return answer.promise; });
    const call = client.run(f.document()), rejected = assert.rejects(call.result, error => error instanceof RpcError && error.code === -32800);
    await entered.promise; call.cancel(); await rejected; await settled(); assert.equal(f.sent("$/cancelRequest").length, 1);
    answer.resolve([]); await settled(); f.peer.onRequest("textDocument/foldingRange", () => []);
    const result = await client.run(f.document()).result; assert.equal(result.isCurrent(), true); f.edit(); assert.equal(result.isCurrent(), false);
});
