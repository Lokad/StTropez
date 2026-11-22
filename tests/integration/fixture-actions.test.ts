import test from "node:test";
import assert from "node:assert/strict";
import { withProtocolFixture, type ProtocolFixture } from "../helpers/protocol-fixture.ts";
import { Workspace } from "../../src/index.ts";
import { openWebSocketTransport } from "../../src/browser/index.ts";
import { JsonRpcConnection, LspWorkspace, RpcError, createLspActionClient } from "../../src/protocol/index.ts";
import type { JsonValue, LspWorkspaceEdit } from "../../src/protocol/index.ts";
import { isRecord } from "../../src/protocol/wire.ts";

function fixture({ url, defer }: ProtocolFixture) {
    const workspace = new Workspace(), resources = ["first", "second"].map(name => workspace.createTextResource(
        { scope: "actions", resource: name, variant: "working" }, name, { value: "const sample = 1; // TODO" }, undefined, { language: { uri: `host+fixture:${name}`, languageId: "fixture" } }));
    defer(() => assert.equal(workspace.diagnostics().leases, 0));
    const documents = () => resources.map(resource => workspace.document(resource.documentId));
    const endpoint = url;
    const owner = new LspWorkspace(workspace, {
        connect: () => openWebSocketTransport(endpoint),
        features: ["textDocument/codeAction"], workspaceEdits: true,
        schedule: (ms, callback) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
    });
    defer(() => owner.dispose());
    const scope = owner.createScope();
    return { workspace, documents, endpoint, owner, scope };
}

test("independent action clients retain repeatable lazy previews on an unchanged source", { timeout: 15000 }, async () => withProtocolFixture(async context => {
    const f = fixture(context), first = createLspActionClient(f.owner); context.defer(() => first.dispose());
    const second = createLspActionClient(f.owner); context.defer(() => second.dispose());
    const documents = f.documents(), source = documents[0]!;
    const one = await first.run(documents, source.id, 21, 25), action = one.actions.find(item => item.resolve);
    assert.ok(action);
    const two = await second.run(documents, source.id, 21, 25), other = two.actions.find(item => item.resolve);
    assert.ok(other); assert.equal(one.isCurrent(), true); assert.equal(two.isCurrent(), true);
    const resolved = await one.resolve(action); assert.ok(resolved.edit);
    assert.deepEqual(resolved.edit.documents[0]!.edits, [{ from: 21, to: 25, insert: "DONE" }]);
    const changes = (edit: LspWorkspaceEdit | null) => edit?.documents.map(change => ({ documentId: change.target.document.documentId,
        revision: change.target.document.revision, edits: change.edits }));
    assert.deepEqual(changes((await two.resolve(other)).edit), changes(resolved.edit));
    assert.deepEqual(changes((await one.resolve(action)).edit), changes(resolved.edit));
    assert.equal(f.workspace.document(source.id).revision, source.revision);
}));

test("fixture action retention falls back to eager edits and expires only the changed or closed source", { timeout: 15000 }, async () => withProtocolFixture(async context => {
    const f = fixture(context), transport = await openWebSocketTransport(f.endpoint); context.defer(() => transport.dispose());
    const rpc = new JsonRpcConnection(transport, {
        schedule: (ms, callback) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
    });
    context.defer(() => rpc.dispose());
    const actionObject = (value: JsonValue | undefined) => {
        assert.ok(isRecord(value)); return value;
    };
    const uri = (index: number) => `host+fixture:source-${index}`;
    const open = (index: number) => rpc.notify("textDocument/didOpen", { textDocument: { uri: uri(index), languageId: "fixture", version: 1, text: "const sample = 1; // TODO" } });
    const discover = async (index = 0, policy?: JsonValue) => {
        const actions = await rpc.request("textDocument/codeAction", { textDocument: { uri: uri(index) },
            range: { start: { line: 0, character: 21 }, end: { line: 0, character: 25 } }, context: { diagnostics: [] },
            ...(policy === undefined ? {} : { _fixture: policy }) }).result;
        assert.ok(Array.isArray(actions)); return actionObject(actions[2]);
    };
    const resolve = async (action: ReturnType<typeof actionObject>) => actionObject(await rpc.request("codeAction/resolve", action).result);
    const expired = (error: unknown) => error instanceof RpcError && error.code === -32602;
    await rpc.request("initialize", { processId: null, rootUri: null, capabilities: { workspace: { workspaceEdit: { documentChanges: true } },
        textDocument: { codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: [] } }, dataSupport: true, resolveSupport: { properties: ["edit"] } } } } }).result;
    rpc.notify("initialized", {}); open(0); open(1);
    const other = await discover(1), first = await discover(); assert.ok(other.data); assert.ok(first.data);
    const expected = (await resolve(first)).edit;
    // The fixture admits 64 lazy batches; later offers remain usable without evicting one.
    for (let i = 2; i < 64; i++) assert.ok((await discover()).data);
    const overflow = await discover(); assert.equal(overflow.data, undefined); assert.deepEqual(overflow.edit, expected);
    assert.deepEqual((await resolve(first)).edit, expected);
    rpc.notify("textDocument/didChange", { textDocument: { uri: uri(0), version: 2 }, contentChanges: [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: "// " }] });
    await assert.rejects(resolve(first), expired); assert.ok((await resolve(other)).edit);
    const changed = await discover(); assert.ok(changed.data); assert.ok((await resolve(changed)).edit);
    // Closing and reopening the same URI must not make its former tokens valid again.
    rpc.notify("textDocument/didClose", { textDocument: { uri: uri(0) } }); open(0);
    await assert.rejects(resolve(changed), expired); assert.ok((await resolve(other)).edit);
    assert.ok((await discover()).data);

    // A delayed old discovery cannot repopulate the cache after close/reopen.
    const delayed = discover(0, { delay: 100 }), stale = assert.rejects(delayed, error => error instanceof RpcError && error.code === -32801 && error.message.includes("source changed"));
    rpc.notify("textDocument/didClose", { textDocument: { uri: uri(0) } }); open(0); await stale;
    assert.ok((await resolve(await discover())).edit);
    const synchronization = actionObject(await rpc.request("fixture/synchronization").result);
    assert.deepEqual(synchronization.failures, []);
}));
