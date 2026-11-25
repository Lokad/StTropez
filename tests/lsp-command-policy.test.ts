import test from "node:test";
import assert from "node:assert/strict";
import type { LspCommandScope, LspHostCommandContext } from "../src/protocol/index.ts";
import { applyLspWorkspaceEdit } from "../src/kernels/index.ts";
import { retainLspDocument } from "../src/protocol/lsp-client.ts";
import { actionClient } from "../src/protocol/lsp-actions.ts";
import { clientFixture, protocol, settled } from "./helpers/lsp-client.ts";
import { latch } from "./helpers/latch.ts";
const { RpcError } = protocol;
const stale = (error: unknown) => error instanceof RpcError && error.code === -32801;
const scopeFor = (f: ReturnType<typeof clientFixture>): LspCommandScope => ({ snapshots: () => [f.document()], isCurrent: () => true,
    review: async (request, context) => {
        assert.ok(context.isCurrent()); assert.ok(request.edit.isCurrent());
        applyLspWorkspaceEdit(f.workspace, request.edit, { origin: "host", historyKind: "refactor" });
        return { applied: true };
    } });
const run = async (client: ReturnType<typeof actionClient>, f: ReturnType<typeof clientFixture>) => {
    const doc = f.document(); return client.run({ document: doc, from: 0, to: 0 }).result;
};

test("the direct runner snapshots command identity and arguments before host preparation", async t => {
    const f = clientFixture(t, undefined, undefined, { applyEdit: false });
    const scope = f.provider.createScope(), runner = protocol.createLspCommandRunner(scope);
    t.after(() => { runner.dispose(); scope.dispose(); }); await scope.ensureConnected();
    const invocation = { title: "captured", command: "host.allowed", arguments: [{ token: 1 }] };
    await runner.runAuthorized(invocation, { ...scopeFor(f), prepare: () => { invocation.command = "other"; invocation.arguments[0]!.token = 2; } }, { kind: "server" });
    assert.deepEqual(f.sent("workspace/executeCommand")[0]!.params, { command: "host.allowed", arguments: [{ token: 1 }] });
});

test("host server authority captures one immutable invocation, refuses other arguments and can be revoked", async t => {
    const f = clientFixture(t); let permitted = true, policies = 0;
    const client = actionClient(f.provider, { commandPolicy: command => {
        policies++; assert.ok(Object.isFrozen(command.arguments[0]));
        return command.command === "host.allowed" && (command.arguments[0] as { token: number }).token === 1
            ? { kind: "server", isCurrent: () => permitted } : null;
    } }); t.after(client.dispose);
    f.peer.onRequest("textDocument/codeAction", () => [1, 2].map(token => ({ title: "command", command: "host.allowed", arguments: [{ token }] })));
    const batch = await run(client, f), first = batch.actions[0]!, other = batch.actions[1]!;
    assert.equal(batch.supports(first.command!), true); assert.equal(batch.supports(other.command!), false);
    assert.equal(batch.supports({ ...first.command! }), false);
    assert.throws(() => { (first.command!.arguments[0] as { token: number }).token = 2; }, TypeError);
    await assert.rejects(batch.execute(other, scopeFor(f)), stale);
    await batch.execute(first, scopeFor(f));
    assert.deepEqual(f.sent("workspace/executeCommand").map(call => call.params), [{ command: "host.allowed", arguments: [{ token: 1 }] }]);
    permitted = false; assert.equal(batch.supports(first.command!), false);
    let prepared = false; await assert.rejects(batch.execute(first, { ...scopeFor(f), prepare: () => { prepared = true; } }), stale);
    assert.equal(prepared, false); assert.equal(policies, 2); assert.equal(f.provider.getSnapshot().commandRequiresReconnect, false);
    const raw = f.provider.createScope(); t.after(raw.dispose);
    assert.throws(() => raw.requestCommand("host.allowed", [{ token: 2 }], 1000, { command: "host.allowed", arguments: [{ token: 1 }], isCurrent: () => true }), /does not match/);
    assert.equal(f.sent("workspace/executeCommand").length, 1);
});

test("explicit server route retains captured applyEdit ownership and does not authorize unsolicited edits", async t => {
    const f = clientFixture(t), client = actionClient(f.provider, { commandPolicy: () => ({ kind: "server" }) }); t.after(client.dispose);
    f.peer.onRequest("textDocument/codeAction", () => [{ title: "command", command: "host.allowed" }]);
    const other = f.workspace.document(f.other.documentId);
    const snapshots = () => [f.document(), f.workspace.document(other.id)];
    const batch = await client.run({ document: f.document(), project: snapshots(), from: 0, to: 0 }).result;
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } };
    const edit = { edit: { changes: {
        [f.document().language!.uri]: [{ range, newText: "changed" }],
        [other.language!.uri]: [{ range, newText: "second" }],
    } } };
    assert.equal((await f.peer.sendRequest("workspace/applyEdit", edit) as { applied: boolean }).applied, false);
    f.peer.onRequest("workspace/executeCommand", async () => {
        assert.equal((await f.peer.sendRequest("workspace/applyEdit", edit) as { applied: boolean }).applied, true); return "done";
    });
    const receipt = await batch.execute(batch.actions[0]!, { ...scopeFor(f), snapshots });
    assert.equal(receipt.decision?.applied, true); assert.equal(f.document().buffer.slice(0, 7), "changed");
    const changed = f.workspace.document(other.id);
    assert.equal(changed.buffer.line(0).text, "second delta");
    assert.ok(f.workspace.undo({ documentId: other.id, expectedRevision: changed.revision }).applied);
    assert.equal(f.document().buffer.line(0).text, "alpha beta");
    assert.equal(f.workspace.document(other.id).buffer, other.buffer);
    assert.equal((await f.peer.sendRequest("workspace/applyEdit", edit) as { applied: boolean }).applied, false);
    assert.equal(f.provider.getSnapshot().commandAvailable, true);
});

test("an action command cannot borrow a sibling feature's edit targets on the same scope", async t => {
    const f = clientFixture(t, undefined, undefined, { maxScopes: 1 });
    const owner = retainLspDocument(f.provider, f.source.documentId);
    const other = f.workspace.document(f.other.documentId);
    const sibling = owner.replace(new Map(), [other]);
    const client = actionClient(owner);
    t.after(() => {
        client.dispose();
        owner.release(sibling);
        owner.dispose();
    });
    f.peer.onRequest("textDocument/codeAction", () => [{ title: "Run", command: "fixture.command" }]);
    const batch = await run(client, f);
    const at = { line: 0, character: 0 };
    const edit = { changes: { [other.language!.uri]: [{ range: { start: at, end: at }, newText: "outside" }] } };
    f.peer.onRequest("workspace/executeCommand", async () => {
        const decision = await f.peer.sendRequest<{ applied: boolean }>("workspace/applyEdit", { edit });
        assert.equal(decision.applied, false);
        return null;
    });
    let reviewed = false;
    const receipt = await batch.execute(batch.actions[0]!, {
        ...scopeFor(f), review: async () => {
            reviewed = true;
            return { applied: true };
        }
    });
    assert.equal(reviewed, false);
    assert.equal(receipt.decision?.applied, false);
    assert.equal(f.workspace.document(other.id), other);
    const handle = sibling.get(other.id)!;
    assert.equal(owner.scope.synchronized(handle)?.document.uri, other.language!.uri);
});

test("host handlers see initial edits, reuse captured edit validation, and release the lane after a known failure", async t => {
    const f = clientFixture(t), client = actionClient(f.provider, { commandPolicy: () => ({ kind: "host", run: async (_command, context) => {
        assert.equal(context.snapshots()[0]!.buffer.slice(0, 7), "prefix ");
        const uri = (f.sent("textDocument/didOpen")[0]!.params as { textDocument: { uri: string } }).textDocument.uri;
        const request = { edit: { changes: { [uri]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, newText: "reviewed" }] } } };
        assert.equal((await f.peer.sendRequest("workspace/applyEdit", request) as { applied: boolean }).applied, false);
        assert.equal((await context.applyEdit(request)).applied, true);
        throw new Error("Deliberate later phase failure");
    } }) }); t.after(client.dispose);
    f.peer.onRequest("textDocument/codeAction", () => [{ title: "host", command: "host.local" }]);
    const batch = await run(client, f);
    await assert.rejects(batch.execute(batch.actions[0]!, { ...scopeFor(f), prepare: () => { f.edit(); } }), /later phase failure/);
    assert.equal(f.document().buffer.slice(0, 8), "reviewed"); assert.equal(f.sent("workspace/executeCommand").length, 0);
    assert.equal(f.provider.getSnapshot().commandAvailable, true); assert.equal(f.provider.getSnapshot().commandRequiresReconnect, false);
    const fresh = actionClient(f.provider, { commandPolicy: () => ({ kind: "host", run: () => "recovered" }) }); t.after(fresh.dispose);
    const next = await run(fresh, f); assert.equal((await next.execute(next.actions[0]!, scopeFor(f))).value, "recovered");
});

test("cancelling a hanging host handler rejects its late edits and permits a fresh action without reconnect", async t => {
    const f = clientFixture(t), entered = latch<void>(), late = latch<null>(), cancelled = latch<void>(); let captured: LspHostCommandContext | undefined, calls = 0;
    const client = actionClient(f.provider, { commandPolicy: () => ({ kind: "host", run: (_command, context) => {
        if (++calls > 1) return "fresh";
        captured = context; context.onCancel(() => { cancelled.resolve(); throw new Error("Host cancellation failure"); }); entered.resolve(); return late.promise;
    } }) }); t.after(() => { late.resolve(null); client.dispose(); });
    f.peer.onRequest("textDocument/codeAction", () => [{ title: "host", command: "host.local" }]);
    const batch = await run(client, f), pending = batch.execute(batch.actions[0]!, scopeFor(f));
    const rejected = assert.rejects(pending, error => error instanceof RpcError && error.code === -32800);
    await entered.promise; assert.equal(client.isBusy(), true); client.cancel(); await rejected; await cancelled.promise;
    assert.equal(client.isBusy(), false);
    captured!.onCancel(() => { throw new Error("Late host cancellation failure"); }); await settled();
    assert.deepEqual(f.errors.splice(0), ["Host cancellation failure", "Late host cancellation failure"]);
    assert.equal(captured!.isCurrent(), false); assert.equal((await captured!.applyEdit({ edit: { changes: {} } })).applied, false);
    late.resolve(null); await settled(); assert.equal(f.provider.getSnapshot().commandAvailable, true);
    assert.equal(f.provider.getSnapshot().commandRequiresReconnect, false); assert.equal(f.sent("workspace/executeCommand").length, 0);
    const next = await run(client, f); assert.equal((await next.execute(next.actions[0]!, scopeFor(f))).value, "fresh");
});

test("a later successful edit cannot erase an earlier refusal from the command receipt", async t => {
    const f = clientFixture(t), client = actionClient(f.provider, { commandPolicy: () => ({ kind: "host", run: async (_command, context) => {
        assert.equal((await context.applyEdit({ edit: { changes: { "unknown:resource": [] } } })).applied, false);
        assert.equal((await context.applyEdit({ edit: { changes: {} } })).applied, true); return null;
    } }) }); t.after(client.dispose);
    f.peer.onRequest("textDocument/codeAction", () => [{ title: "host", command: "host.local" }]);
    const batch = await run(client, f), receipt = await batch.execute(batch.actions[0]!, scopeFor(f));
    assert.equal(receipt.decision?.applied, false); assert.equal(f.document().revision, 0);
});
