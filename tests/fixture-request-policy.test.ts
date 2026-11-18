import test from "node:test";
import assert from "node:assert/strict";
import { FixtureLspWorkspace } from "../fixtures/protocol/fixture-workspace.ts";
import { Workspace } from "../src/index.ts";
import { openWebSocketTransport } from "../src/browser/index.ts";
import { RpcError, createLspActionClient, createLspColorClient, createLspHoverClient, createLspLinkClient, createLspNavigationClient, createLspRenameClient, createLspSignatureClient } from "../src/protocol/index.ts";
import type { JsonValue, LspDocumentFeature, LspPrepare } from "../src/protocol/index.ts";
import { latch } from "./helpers/latch.ts";
import { withProtocolFixture } from "./helpers/protocol-fixture.ts";

const cancelled = (error: unknown) => error instanceof RpcError && error.code === -32800;

test("fixture hover policy belongs to the captured request across overlapping scopes, cancellation and retry", { timeout: 15000 }, async () => withProtocolFixture(async ({ url, defer }) => {
    const workspace = new Workspace(), documents = ["first", "second"].map(name => workspace.document(workspace.createTextResource(
        { scope: "requests", resource: name, variant: "working" }, name, { value: "const sample = 1;" }).documentId));
    defer(() => assert.equal(workspace.diagnostics().leases, 0));
    const packets: { id?: number; method?: string; params?: { id?: number; _fixture?: unknown; textDocument?: { uri: string } } }[] = [];
    let onHoverSent = () => {};
    const owner = new FixtureLspWorkspace(workspace, {
        connect: async () => { const transport = await openWebSocketTransport(url);
            return { ...transport, send: message => { const packet = JSON.parse(message); packets.push(packet); transport.send(message);
                if (packet.method === "textDocument/hover") onHoverSent(); } }; },
        features: ["textDocument/hover"], documentInfo: doc => ({ uri: `host+fixture:${doc.resourceId}`, languageId: "fixture" }),
        schedule: (ms, callback) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
    });
    defer(() => owner.dispose());
    const scope = owner.createScope(), first = createLspHoverClient(owner); defer(() => first.dispose());
    const second = createLspHoverClient(owner); defer(() => second.dispose());
    const held = latch<void>(); defer(held.resolve);
    scope.setDocuments(documents); await scope.ensureConnected();
    // Same-document views also need separate request ownership: a URI alone cannot key policy.
    for (const other of documents) {
        const prepared = latch<void>(); let count = 0;
        const rendezvous = () => { if (++count === 2) prepared.resolve(); return prepared.promise; };
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
    const started = latch<void>(), beforeHeld = packets.filter(packet => packet.method === "textDocument/hover").length;
    const old = first.run(documents[0]!, 8, async session => {
        await owner.prepareRequest(session, "textDocument/hover", { delay: 0, fault: "failure" }); started.resolve(); await held.promise;
    });
    const rejected = assert.rejects(old.result, cancelled); await started.promise; old.cancel(); await rejected;
    const replacement = await first.run(documents[0]!, 8, session => owner.prepareRequest(session, "textDocument/hover", { delay: 0, fault: "markup" })).result;
    assert.ok(replacement?.text.includes("<img")); held.resolve();
    await scope.request("fixture/state").result;
    assert.equal(packets.filter(packet => packet.method === "textDocument/hover").length, beforeHeld + 1);

    // Wait for the actual wire request, not an arbitrary sleep, before cancelling its delay.
    const sent = latch<void>(); onHoverSent = sent.resolve;
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
}));

test("fixture language requests retain their own faults, module aliases and resolve policies", { timeout: 15000 }, async () => withProtocolFixture(async ({ url, defer }) => {
    const workspace = new Workspace(), source = workspace.createTextResource({ scope: "language", resource: "source", variant: "working" }, "Source",
        { value: 'lookup("a", );\nimport "sample-utils";\nconst color = "#abc";' });
    defer(() => assert.equal(workspace.diagnostics().leases, 0));
    const document = workspace.document(source.documentId), defaultUri = "host+fixture:default", firstUri = "host+fixture:first", secondUri = "host+fixture:second";
    const owner = new FixtureLspWorkspace(workspace, {
        connect: () => openWebSocketTransport(url),
        initializationOptions: { fixtureModuleUris: [{ module: "sample-utils", uri: defaultUri }] },
        features: ["textDocument/signatureHelp", "textDocument/documentLink", "textDocument/documentColor", "textDocument/colorPresentation", "textDocument/completion", "textDocument/definition", "textDocument/references", "textDocument/rename", "textDocument/codeAction"], workspaceEdits: true,
        documentInfo: doc => ({ uri: `host+fixture:${doc.resourceId}`, languageId: "fixture" }),
        schedule: (ms, callback) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
    });
    defer(() => owner.dispose());
    const own = <T extends { dispose(): void }>(client: T): T => { defer(() => client.dispose()); return client; };
    const completionScope = () => { const scope = owner.createScope(); defer(() => scope.release()); return scope; };
    const scope = owner.createScope(), signatures = [own(createLspSignatureClient(owner)), own(createLspSignatureClient(owner))],
        links = [own(createLspLinkClient(owner)), own(createLspLinkClient(owner))], colors = [own(createLspColorClient(owner)), own(createLspColorClient(owner))],
        navigation = [own(createLspNavigationClient(owner)), own(createLspNavigationClient(owner))], renames = [own(createLspRenameClient(owner)), own(createLspRenameClient(owner))],
        completion = [completionScope(), completionScope()], actions = [own(createLspActionClient(owner)), own(createLspActionClient(owner))];
    type Run = (index: number, prepare: LspPrepare) => Promise<unknown>;
    const overlap = async (method: LspDocumentFeature, run: Run) => {
        const prepared = latch<void>(); let count = 0;
        const outcomes = await Promise.allSettled([0, 1].map(index => run(index, async session => {
            await owner.prepareRequest(session, method, { delay: 0, ...(index === 0 ? { fault: "failure" } : {}) });
            if (++count === 2) prepared.resolve(); await prepared.promise;
        })));
        assert.equal(outcomes[0]!.status, "rejected", method);
        if (outcomes[0]!.status === "rejected") assert.ok(outcomes[0]!.reason instanceof RpcError && outcomes[0]!.reason.code === -32001, method);
        assert.equal(outcomes[1]!.status, "fulfilled", method);
        if (outcomes[1]!.status === "fulfilled") assert.ok(outcomes[1]!.value, method);
    };
    scope.setDocuments([document]); await scope.ensureConnected();
    const offset = document.text().indexOf("color") + 2;
    await overlap("textDocument/completion", async (index, prepare) => {
        const session = completion[index]!; session.setDocuments([document]); await session.flush(); await prepare(session);
        return session.requestDocument("textDocument/completion", session.attachDocument(document.id), index => ({ position: index.at(offset) })).result;
    });
    for (const kind of ["definition", "references"] as const) await overlap(`textDocument/${kind}`, (index, prepare) => navigation[index]!.run([document], document.id, offset, kind, true, prepare));
    await overlap("textDocument/rename", (index, prepare) => renames[index]!.run([document], document.id, offset, "shade", prepare));
    await overlap("textDocument/codeAction", (index, prepare) => actions[index]!.run([document], document.id, offset, offset, prepare));
    await overlap("textDocument/signatureHelp", (index, prepare) => signatures[index]!.run(document, 12, undefined, prepare).result);
    await overlap("textDocument/documentLink", (index, prepare) => links[index]!.run(document, prepare));
    await overlap("textDocument/documentColor", (index, prepare) => colors[index]!.run(document, prepare));
    const discovered = await Promise.all(colors.map(client => client.run(document)));
    assert.ok(discovered.every(batch => batch.items.length === 1));
    await overlap("textDocument/colorPresentation", (index, prepare) => discovered[index]!.presentations(discovered[index]!.items[0]!, { red: 0, green: 0, blue: 1, alpha: 1 }, prepare));

    // Distinct views of the same source capture different alias maps, including nested data.
    const prepared = latch<void>(); let count = 0;
    const batches = await Promise.all(links.map((client, index) => client.run(document, async session => {
        const policy = { delay: 0, aliases: [{ module: "sample-utils", uri: index ? secondUri : firstUri }] };
        await owner.prepareRequest(session, "textDocument/documentLink", policy); policy.aliases[0]!.uri = "host+fixture:mutated";
        if (++count === 2) prepared.resolve(); await prepared.promise;
    })));
    const resolved = await Promise.all(batches.map(batch => batch.resolve(batch.items[0]!)));
    assert.deepEqual(resolved.map(link => link.target), [firstUri, secondUri]);

    // Resolve policy belongs to the actual resolve message, independently of discovery.
    const item = batches[0]!.items[0]!, values = item.resolve as Readonly<Record<string, JsonValue>>;
    const responses = await Promise.all([
        scope.request("documentLink/resolve", { ...values, _fixture: { delay: 0, fault: "outside" } }).result,
        scope.request("documentLink/resolve", values).result,
    ]) as { target: string; _fixture?: unknown }[];
    assert.deepEqual(responses.map(link => link.target), ["host+fixture:outside-project", firstUri]);
    assert.ok(responses.every(link => link._fixture === undefined));
    const unconfigured = await links[0]!.run(document);
    assert.equal((await unconfigured.resolve(unconfigured.items[0]!)).target, defaultUri);

    const binding = scope.attachDocument(document.id);
    const actionBatches = await Promise.all(actions.map((client, index) => client.run([document], document.id, offset, offset,
        session => owner.prepareRequest(session, "textDocument/codeAction", { delay: 0, module: index ? "other-utils" : "first-utils" }))));
    for (const [index, batch] of actionBatches.entries()) assert.ok(batch.actions[0]!.edit!.documents[0]!.edits[0]!.insert.includes(index ? "other-utils" : "first-utils"));
    const actionResults = await Promise.allSettled(actionBatches.map((batch, index) => batch.resolve(batch.actions[2]!,
        session => owner.prepareRequest(session, "codeAction/resolve", { delay: 0, ...(index ? {} : { fault: "failure" }) }))));
    assert.equal(actionResults[0]!.status, "rejected");
    if (actionResults[0]!.status === "rejected") assert.ok(actionResults[0]!.reason instanceof RpcError && actionResults[0]!.reason.code === -32001);
    assert.equal(actionResults[1]!.status, "fulfilled");
    if (actionResults[1]!.status === "fulfilled") assert.ok(actionResults[1]!.value.edit);
    for (const module of [null, 7, "invalid module"]) await assert.rejects(scope.requestDocument("textDocument/codeAction", binding, () => ({
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, context: { diagnostics: [] }, _fixture: { delay: 0, module },
    })).result, error => error instanceof RpcError && error.code === -32602);
    for (const aliases of [null, [{ uri: firstUri }], [{ module: "sample-utils", uri: "" }], [{ module: "not a module", uri: firstUri }], Array(101).fill({ module: "sample-utils", uri: firstUri })]) {
        await assert.rejects(scope.requestDocument("textDocument/documentLink", binding, () => ({ _fixture: { delay: 0, aliases } })).result,
            error => error instanceof RpcError && error.code === -32602);
    }
    await assert.rejects(scope.request("documentLink/resolve", { ...values, _fixture: { delay: 0, fault: "failure" } }).result,
        error => error instanceof RpcError && error.code === -32602);
}));
