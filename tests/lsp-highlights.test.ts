import test from "node:test";
import assert from "node:assert/strict";
import { clientFixture, latch, protocol, settled } from "./helpers/lsp-client.ts";
const { createLspHighlightClient, RpcError } = protocol;
const range = (line: number, from: number, to: number) => ({ start: { line, character: from }, end: { line, character: to } });

test("occurrences negotiate UTF-16 ranges, text/read/write and validate malformed tails atomically", async t => {
    const f = clientFixture(t), client = createLspHighlightClient(f.provider); t.after(client.dispose);
    f.workspace.edit({ documentId: f.source.documentId, expectedRevision: 0, origin: "host", edits: [{ from: 0, to: 10, insert: "a😀\r\nalpha alpha" }] });
    let value: unknown = [{ range: range(1, 6, 11), kind: 2 }, { range: range(0, 1, 3) }, { range: range(1, 0, 5), kind: 3 }];
    f.peer.onRequest("textDocument/documentHighlight", () => value);
    const result = await client.run(f.document(), 6).result;
    assert.deepEqual(result.items, [{ from: 1, to: 3, kind: "text" }, { from: 5, to: 10, kind: "write" }, { from: 11, to: 16, kind: "read" }]);
    assert.ok(Object.isFrozen(result.items)); assert.ok(result.items.every(Object.isFrozen));
    assert.deepEqual(f.sent("textDocument/documentHighlight")[0]!.params, { textDocument: { uri: `generic:${f.source.id}` }, position: { line: 1, character: 1 } });
    const init = f.sent("initialize")[0]!.params as { capabilities: { textDocument: { documentHighlight: unknown } } };
    assert.deepEqual(init.capabilities.textDocument.documentHighlight, { dynamicRegistration: true });
    for (const bad of [{ range: range(1, 0, 99) }, { range: range(1, 4, 1) }, { range: range(7, 0, 1) }, { range: range(1, 0, 1), kind: 4 }, { range: range(1, 0, 1), kind: "read" }, null]) {
        value = [{ range: range(1, 0, 5) }, bad]; await assert.rejects(client.run(f.document(), 6).result);
    }
    assert.equal(result.isCurrent(), false);
    value = null; assert.deepEqual((await client.run(f.document(), 6).result).items, []);
});

test("large occurrence results retain every range and query overlapping intervals at exclusive boundaries", async t => {
    const f = clientFixture(t), client = createLspHighlightClient(f.provider); t.after(client.dispose);
    f.workspace.edit({ documentId: f.source.documentId, expectedRevision: 0, origin: "host", edits: [{ from: 0, to: 10, insert: "x\n".repeat(10000) }] });
    const ranges = Array.from({ length: 10000 }, (_, line) => ({ range: range(line, 0, 1), kind: 2 }));
    ranges.push({ range: { start: { line: 0, character: 0 }, end: { line: 9999, character: 1 } }, kind: 1 }, { range: range(5000, 0, 0), kind: 3 });
    f.peer.onRequest("textDocument/documentHighlight", () => ranges.reverse());
    const result = await client.run(f.document(), 10000).result;
    assert.equal(result.items.length, 10002);
    for (const [from, to] of [[0, 1], [0, 0], [2, 5], [9999, 10001], [10000, 10000], [19998, 20000], [19999, 20000]]) {
        assert.deepEqual(result.intersect(from!, to!), from === to ? [] : result.items.filter(item => item.from < item.to && item.from < to! && item.to > from!));
    }
    assert.throws(() => result.intersect(-1, 10)); assert.throws(() => result.intersect(10, 9)); assert.throws(() => result.intersect(0, 20001));
});

test("occurrence cancellation preserves one synchronization binding until document replacement or disposal", async t => {
    const f = clientFixture(t), client = createLspHighlightClient(f.provider), entered = latch<void>(), answer = latch<unknown>();
    t.after(() => { answer.resolve([]); client.dispose(); });
    f.peer.onRequest("textDocument/documentHighlight", () => { entered.resolve(); return answer.promise; });
    const call = client.run(f.document(), 1), rejected = assert.rejects(call.result, error => error instanceof RpcError && error.code === -32800);
    await entered.promise; call.cancel(); await rejected; await settled(); assert.equal(f.sent("$/cancelRequest").length, 1);
    assert.equal(f.provider.snapshot().documentParticipants, 1); assert.equal(f.sent("textDocument/didClose").length, 0);
    answer.resolve([]); await settled(); f.peer.onRequest("textDocument/documentHighlight", () => [{ range: range(0, 0, 5) }]);
    const result = await client.run(f.document(), 1).result; assert.equal(result.isCurrent(), true); f.edit(); assert.equal(result.isCurrent(), false);
    for (let i = 0; i < 5; i++) {
        client.cancel(); f.edit(); client.options(f.document());
        const latest = await client.run(f.document(), 1).result; assert.equal(latest.isCurrent(), true);
        client.cancel(); assert.equal(latest.isCurrent(), false);
    }
    assert.equal(f.sent("textDocument/didOpen").length, 1); assert.equal(f.sent("textDocument/didClose").length, 0);
    assert.equal(f.provider.snapshot().documentParticipants, 1);
    await client.run(f.workspace.document(f.other.documentId), 1).result; await f.provider.flush();
    assert.equal(f.sent("textDocument/didOpen").length, 2); assert.equal(f.sent("textDocument/didClose").length, 1);
    client.dispose(); await settled(); assert.equal(f.provider.snapshot().documentParticipants, 0); assert.equal(f.workspace.diagnostics().leases, 0);
    await f.provider.flush(); assert.equal(f.sent("textDocument/didClose").length, 2);
});
