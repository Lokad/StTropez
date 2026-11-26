import test from "node:test";
import assert from "node:assert/strict";
import { completionClient, type LspCompletionBatch } from "../src/protocol/lsp-completion.ts";
import { clientFixture, protocol, settled } from "./helpers/lsp-client.ts";
import { latch } from "./helpers/latch.ts";
const { ProtocolDecodeError, RpcError } = protocol;
const stale = (error: unknown) => error instanceof RpcError && error.code === -32801;
const cancelled = (error: unknown) => error instanceof RpcError && error.code === -32800;
const range = (from: number, to: number) => ({ start: { line: 0, character: from }, end: { line: 0, character: to } });
const choice = (label = "alphaNext") => ({ label, data: { token: label }, textEdit: { newText: label, insert: range(0, 2), replace: range(0, 5) } });
const type = (f: ReturnType<typeof clientFixture>, at = 2, insert = "x") => {
    const document = f.document(); assert.equal(f.workspace.edit({ documentId: document.id, expectedRevision: document.revision,
        edits: [{ from: at, to: at, insert }], origin: "human", history: { kind: "typing" } }).status, "done");
};

test("completion owns immutable sorted choices, captured options and lazy fallback without browser state", async t => {
    const f = clientFixture(t), client = completionClient(f.provider); t.after(client.dispose);
    const indentation = { tabSize: 2, insertSpaces: false }, options = { indentation, fallback: { from: 0, to: 2, replaceTo: 5 } };
    f.peer.onRequest("textDocument/completion", () => [{ label: "z", sortText: "2" }, { label: "first", sortText: "1" }, { label: "second", sortText: "1" }]);
    const call = client.run({ document: f.document(), offset: 2, ...options }); indentation.tabSize = 8; options.fallback.replaceTo = 10;
    const batch = await call.result;
    assert.deepEqual(batch.items.map(item => item.label), ["first", "second", "z"]);
    assert.ok(Object.isFrozen(batch)); assert.ok(Object.isFrozen(batch.items)); assert.ok(batch.items.every(Object.isFrozen));
    assert.equal(batch.items[0]!.insertion.tabSize, 2); assert.equal(batch.items[0]!.primary.replaceTo, 5);
    assert.deepEqual(batch.items[0]!.commitCharacters, [";"]); assert.ok(batch.isCurrent()); call.cancel(); assert.ok(batch.isCurrent());
    let fallbackReads = 0;
    f.peer.onRequest("textDocument/completion", () => [choice()]);
    await client.run({ document: f.document(), offset: 2, fallback: () => { fallbackReads++; throw new Error("Unused fallback"); } }).result;
    assert.equal(fallbackReads, 0);
    assert.equal(batch.isCurrent(), false);
    assert.equal(f.sent("textDocument/didOpen").length, 1); assert.equal(f.workspace.diagnostics().leases, 1);
});

test("proved prefix adoption reads the actual Core change during notification and resolves against fresh synchronized text", async t => {
    const f = clientFixture(t), client = completionClient(f.provider); t.after(client.dispose);
    const wire = choice(); f.peer.onRequest("textDocument/completion", () => [wire]);
    const initial = await client.run({ document: f.document(), offset: 2 }).result; let rebased: LspCompletionBatch | undefined;
    const stop = f.workspace.observeDocument(f.source.id).subscribe(() => {
        assert.equal(initial.isCurrent(), false); assert.equal(initial.isBindingCurrent(), true);
        rebased = client.rebase(initial, { ...f.document(), change: null }); // The supplied change cannot replace Core's proof.
    }); t.after(stop);
    type(f); stop(); assert.ok(rebased); assert.equal(rebased.offset, 3); assert.ok(rebased.isCurrent());
    assert.equal(initial.isCurrent(), false); assert.deepEqual(rebased.items[0]!.resolve, wire);
    assert.equal(rebased.items[0]!.primary.insertTo, 3); assert.equal(rebased.items[0]!.primary.replaceTo, 6);
    f.peer.onRequest("completionItem/resolve", (value: unknown) => {
        assert.deepEqual(value, wire); assert.equal(f.sent("textDocument/didChange").length, 1);
        return { ...wire, detail: "resolved", additionalTextEdits: [{ range: range(0, 0), newText: "import; " }] };
    });
    const resolved = await client.resolve(rebased, rebased.items[0]!).result;
    assert.equal(resolved.item!.primary.insertTo, 3); assert.equal(resolved.item!.source.buffer, f.document().buffer);
    assert.equal(resolved.item!.detail, "resolved"); assert.ok(resolved.batch.isCurrent()); assert.equal(rebased.isCurrent(), false);
    assert.equal(f.document().buffer.apply(resolved.item!.replace.edits).buffer.text(), "import; alphaNext beta");
    assert.equal(f.sent("textDocument/didOpen").length, 1); assert.equal(f.sent("textDocument/didClose").length, 0);
    assert.equal(f.workspace.diagnostics().leases, 1);
});

test("incomplete refresh can retain a choice, cancel its replacement, and never publish the late list", async t => {
    const f = clientFixture(t), client = completionClient(f.provider); t.after(client.dispose);
    const wire = choice(); f.peer.onRequest("textDocument/completion", () => ({ isIncomplete: true, items: [wire] }));
    const initial = await client.run({ document: f.document(), offset: 2 }).result; type(f); const rebased = client.rebase(initial, f.document())!; assert.ok(rebased);
    const entered = latch<void>(), answer = latch<unknown>(); t.after(() => answer.resolve([]));
    f.peer.onRequest("textDocument/completion", () => { entered.resolve(); return answer.promise; });
    const refresh = client.run({ document: f.document(), offset: 3, retain: rebased, context: { triggerKind: 3 } }), rejected = assert.rejects(refresh.result, cancelled);
    await entered.promise; assert.ok(rebased.isCurrent()); refresh.cancel(); await rejected; assert.ok(rebased.isCurrent());
    f.peer.onRequest("completionItem/resolve", () => ({ ...wire, detail: "kept" }));
    const resolved = await client.resolve(rebased, rebased.items[0]!).result; assert.ok(resolved.batch.isCurrent());
    answer.resolve({ isIncomplete: false, items: [choice("late")] }); await settled();
    assert.equal(resolved.batch.items[0]!.detail, "kept"); assert.ok(resolved.batch.isCurrent());
    assert.deepEqual((f.sent("textDocument/completion")[1]!.params as { context: unknown }).context, { triggerKind: 3 });
    assert.equal(f.sent("$/cancelRequest").length, 1);
});

test("prefix adoption cancels an old resolve while a replacement resolves the rebased item", async t => {
    const f = clientFixture(t), client = completionClient(f.provider); t.after(client.dispose);
    const wire = choice(); f.peer.onRequest("textDocument/completion", () => [wire]);
    const initial = await client.run({ document: f.document(), offset: 2 }).result, entered = latch<void>(), answer = latch<unknown>(); t.after(() => answer.resolve(wire));
    f.peer.onRequest("completionItem/resolve", () => { entered.resolve(); return answer.promise; });
    const first = client.resolve(initial, initial.items[0]!), rejected = assert.rejects(first.result, cancelled); await entered.promise;
    type(f); const rebased = client.rebase(initial, f.document())!; assert.ok(rebased); await rejected;
    f.peer.onRequest("completionItem/resolve", () => ({ ...wire, detail: "fresh" }));
    const result = await client.resolve(rebased, rebased.items[0]!).result;
    answer.resolve({ ...wire, detail: "late" }); await settled(); assert.equal(result.item!.detail, "fresh"); assert.ok(result.batch.isCurrent());
    assert.throws(() => client.resolve(result.batch, initial.items[0]!), /captured unresolved/);
});

test("shortening a typed prefix cancels resolution and stops at the provider's original query", async t => {
    const f = clientFixture(t), client = completionClient(f.provider); t.after(client.dispose);
    const wire = choice(); f.peer.onRequest("textDocument/completion", () => [wire]);
    const queried = await client.run({ document: f.document(), offset: 2 }).result;
    type(f); const extended = client.rebase(queried, f.document())!;
    const entered = latch<void>(), answer = latch<unknown>(); t.after(() => answer.resolve(wire));
    f.peer.onRequest("completionItem/resolve", () => { entered.resolve(); return answer.promise; });
    const old = client.resolve(extended, extended.items[0]!), rejected = assert.rejects(old.result, cancelled);
    await entered.promise;
    const erase = (from: number, to: number) => f.workspace.edit({ documentId: f.source.id, expectedRevision: f.document().revision,
        edits: [{ from, to, insert: "" }], origin: "human", history: { kind: "delete" } });
    assert.ok(erase(2, 3).status === "done");
    const shortened = client.rebase(extended, f.document())!;
    await rejected; answer.resolve({ ...wire, detail: "obsolete" }); await settled();
    assert.ok(shortened.isCurrent()); assert.equal(shortened.offset, 2); assert.deepEqual(shortened.items[0]!.primary, queried.items[0]!.primary);
    assert.ok(erase(1, 2).status === "done");
    assert.equal(client.rebase(shortened, f.document()), undefined); assert.equal(shortened.isCurrent(), false);
});

test("host edits, copied batches and failed preparation never acquire fresh completion authority", async t => {
    const f = clientFixture(t), client = completionClient(f.provider); t.after(client.dispose);
    f.peer.onRequest("textDocument/completion", () => [choice()]);
    const batch = await client.run({ document: f.document(), offset: 2 }).result;
    assert.throws(() => client.resolve({ ...batch }, batch.items[0]!), stale);
    const before = f.document(); f.workspace.edit({ documentId: before.id, expectedRevision: before.revision, origin: "host",
        edits: [{ from: 2, to: 2, insert: "x" }] });
    assert.equal(client.rebase(batch, { ...f.document(), change: { ...f.document().change!, origin: "human", kind: "typing" } }), undefined);
    assert.equal(batch.isCurrent(), false); assert.throws(() => client.resolve(batch, batch.items[0]!), stale);
    for (const error of [new TypeError("host"), new RangeError("host")]) {
        await assert.rejects(client.run({ document: f.document(), offset: 3, prepare: async () => { throw error; } }).result, actual => actual === error);
    }
    assert.equal(f.sent("textDocument/completion").length, 1);
    assert.equal(f.sent("completionItem/resolve").length, 0);
});

test("cancellation skips unstarted preparation, supersedes held work and preserves decode failures", async t => {
    const f = clientFixture(t), client = completionClient(f.provider); t.after(client.dispose);
    const entered = latch<void>(), prepared = latch<void>(); t.after(() => prepared.resolve());
    f.peer.onRequest("textDocument/completion", () => [choice()]);
    let preparations = 0;
    const unstarted = client.run({ document: f.document(), offset: 2, prepare: async () => { preparations++; } });
    const stopped = assert.rejects(unstarted.result, cancelled); unstarted.cancel(); await stopped; await settled();
    assert.equal(preparations, 0); assert.equal(f.sent("textDocument/completion").length, 0);
    const first = client.run({ document: f.document(), offset: 2, prepare: async () => { entered.resolve(); await prepared.promise; } }), rejected = assert.rejects(first.result, cancelled);
    await entered.promise; const second = await client.run({ document: f.document(), offset: 2 }).result; await rejected; prepared.resolve(); await settled();
    assert.ok(second.isCurrent()); assert.equal(f.sent("textDocument/completion").length, 1);
    f.peer.onRequest("textDocument/completion", () => [null]);
    await assert.rejects(client.run({ document: f.document(), offset: 2 }).result, ProtocolDecodeError);
    assert.equal(second.isCurrent(), false);
    assert.equal(f.provider.snapshot().documents, 0);
});

test("unsupported lazy snippets omit one choice and preserve current alternatives", async t => {
    const f = clientFixture(t), client = completionClient(f.provider); t.after(client.dispose);
    const unsupported = { ...choice("a"), insertTextFormat: 2 }, other = choice("b");
    f.peer.onRequest("textDocument/completion", () => [unsupported, other]);
    const batch = await client.run({ document: f.document(), offset: 2 }).result;
    f.peer.onRequest("completionItem/resolve", () => ({ ...unsupported, textEdit: { ...unsupported.textEdit, newText: "${TM_FILENAME}" } }));
    const result = await client.resolve(batch, batch.items[0]!).result;
    assert.equal(result.item, null); assert.ok(result.reason); assert.deepEqual(result.batch.items.map(item => item.label), ["b"]);
    assert.ok(result.batch.isCurrent()); assert.equal(result.batch.omitted.length, 1);
    f.peer.onRequest("completionItem/resolve", () => ({ ...other, detail: "available" }));
    assert.equal((await client.resolve(result.batch, result.batch.items[0]!).result).item!.detail, "available");
});

test("registration and URI replacement expire retained choices, while cancellation leaves diagnostic participation", async t => {
    const f = clientFixture(t),
        client = completionClient(f.provider), diagnostics = f.provider.createScope();
    t.after(() => { client.dispose(); diagnostics.dispose(); }); const binding = diagnostics.attachDocument(f.source.id);
    f.peer.onRequest("textDocument/completion", () => [choice()]); const batch = await client.run({ document: f.document(), offset: 2 }).result;
    assert.equal(f.workspace.diagnostics().leases, 1);
    await f.peer.sendRequest("client/registerCapability", { registrations: [{ id: "completion", method: "textDocument/completion", registerOptions: { documentSelector: null, resolveProvider: true } }] });
    assert.equal(batch.isBindingCurrent(), false); assert.throws(() => client.resolve(batch, batch.items[0]!), stale);
    const fresh = await client.run({ document: f.document(), offset: 2 }).result;
    const original = f.document().language!;
    f.workspace.setDocumentLanguage(f.source.id, { ...original, languageId: "other" });
    f.workspace.setDocumentLanguage(f.source.id, original);
    assert.equal(fresh.isBindingCurrent(), false);
    assert.equal(diagnostics.captureBinding(binding), undefined);
    const replacing = f.provider.createScope(); t.after(replacing.dispose); replacing.attachDocument(f.source.id);
    assert.equal(fresh.isCurrent(), false); assert.throws(() => client.resolve(fresh, fresh.items[0]!), stale);
    const next = await client.run({ document: f.document(), offset: 2 }).result; client.cancel(); assert.equal(next.isCurrent(), false);
    client.dispose(); assert.ok(f.provider.snapshot().documents > 0); assert.equal(f.provider.getSnapshot().phase, "ready");
    assert.equal(diagnostics.synchronized(binding), undefined, "URI replacement expired the original diagnostics binding.");
});
