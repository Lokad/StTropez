import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { attachProtocolFixture } from "../examples/protocol/fixture-server.ts";
import { FixtureLspWorkspace } from "../examples/protocol/fixture-workspace.ts";
import { Workspace } from "../src/index.ts";
import { openWebSocketTransport } from "../src/browser/index.ts";
import { RpcError, createLspHoverClient } from "../src/protocol/index.ts";

const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const cancelled = (error: unknown) => error instanceof RpcError && error.code === -32800;

test("fixture hover policy belongs to the captured request across overlapping scopes, cancellation and retry", { timeout: 15000 }, async () => {
    const server = createServer(), detach = attachProtocolFixture(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    const workspace = new Workspace(), documents = ["first", "second"].map(name => workspace.document(workspace.createTextResource(
        { scope: "requests", resource: name, variant: "working" }, name, { value: "const sample = 1;" }).documentId));
    const packets: { id?: number; method?: string; params?: { id?: number; _fixture?: unknown; textDocument?: { uri: string } } }[] = [];
    let onHoverSent = () => {};
    const owner = new FixtureLspWorkspace(workspace, {
        connect: async () => { const transport = await openWebSocketTransport(`ws://127.0.0.1:${address.port}/lsp-fixture`);
            return { ...transport, send: message => { const packet = JSON.parse(message); packets.push(packet); transport.send(message);
                if (packet.method === "textDocument/hover") onHoverSent(); } }; },
        features: ["textDocument/hover"], documentInfo: doc => ({ uri: `host+fixture:${doc.resourceId}`, languageId: "fixture" }),
        schedule: (ms, callback) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
    });
    const scope = owner.createScope(), first = createLspHoverClient(owner), second = createLspHoverClient(owner), held = gate();
    try {
        scope.setDocuments(documents); await scope.connect();
        // Same-document views also need separate request ownership: a URI alone cannot key policy.
        for (const other of documents) {
            const prepared = gate(); let count = 0;
            const rendezvous = () => { if (++count === 2) prepared.release(); return prepared.promise; };
            const outcomes = await Promise.allSettled([
                first.run(documents[0]!, 8, async session => {
                    const policy = { delay: 0, fault: "failure" };
                    await owner.prepareRequest(session, "textDocument/hover", policy); policy.fault = "markup";
                    await rendezvous();
                }).result,
                second.run(other, 8, async session => { await owner.prepareRequest(session, "textDocument/hover", { delay: 0 }); await rendezvous(); }).result,
            ]);
            assert.equal(outcomes[0]!.status, "rejected");
            if (outcomes[0]!.status === "rejected") assert.ok(outcomes[0]!.reason instanceof RpcError && outcomes[0]!.reason.code === -32001);
            assert.equal(outcomes[1]!.status, "fulfilled");
            if (outcomes[1]!.status === "fulfilled") assert.deepEqual(outcomes[1]!.value?.range, { from: 6, to: 12 });
        }

        // Cancellation during preparation discards unsent policy; a held old hook cannot block retry.
        const started = gate(), beforeHeld = packets.filter(packet => packet.method === "textDocument/hover").length;
        const old = first.run(documents[0]!, 8, async session => {
            await owner.prepareRequest(session, "textDocument/hover", { delay: 0, fault: "failure" }); started.release(); await held.promise;
        });
        const rejected = assert.rejects(old.result, cancelled); await started.promise; old.cancel(); await rejected;
        const replacement = await first.run(documents[0]!, 8, session => owner.prepareRequest(session, "textDocument/hover", { delay: 0, fault: "markup" })).result;
        assert.ok(replacement?.text.includes("<img")); held.release();
        await scope.request("fixture/state").result;
        assert.equal(packets.filter(packet => packet.method === "textDocument/hover").length, beforeHeld + 1);

        // Wait for the actual wire request, not an arbitrary sleep, before cancelling its delay.
        const sent = gate(); onHoverSent = sent.release;
        const delayed = first.run(documents[0]!, 8, session => owner.prepareRequest(session, "textDocument/hover", { delay: 1000, fault: "failure" }));
        const delayRejected = assert.rejects(delayed.result, cancelled); await sent.promise; onHoverSent = () => {};
        const wire = packets.filter(packet => packet.method === "textDocument/hover").at(-1)!;
        assert.deepEqual(wire.params?._fixture, { delay: 1000, fault: "failure" }); delayed.cancel(); await delayRejected;
        assert.ok(packets.some(packet => packet.method === "$/cancelRequest" && packet.params?.id === wire.id));
        assert.ok((await second.run(documents[0]!, 8, session => owner.prepareRequest(session, "textDocument/hover", { delay: 0 })).result)?.text.includes("sample"));
        assert.ok((await first.run(documents[0]!, 8).result)?.text.startsWith("Fixture host+fixture:"));
        assert.equal(packets.filter(packet => packet.method === "textDocument/hover").at(-1)!.params?._fixture, undefined);

        const binding = scope.attachDocument(documents[0]!.id);
        for (const policy of [null, {}, { delay: -1 }, { delay: 1001 }, { delay: 0, fault: "unknown" }]) {
            await assert.rejects(scope.requestDocument("textDocument/hover", binding, () => ({ position: { line: 0, character: 8 }, _fixture: policy })).result,
                error => error instanceof RpcError && error.code === -32602);
        }
        assert.equal(packets.filter(packet => packet.method === "initialize").length, 1);
        assert.equal(packets.some(packet => packet.method === "fixture/hoverConfig"), false);
    } finally {
        held.release(); first.dispose(); second.dispose(); owner.dispose(); detach();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        assert.equal(workspace.diagnostics().leases, 0);
    }
});
