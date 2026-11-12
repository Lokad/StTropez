import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { attachDemoProvider } from "../examples/demo/provider-server.ts";
import type { DemoProviderBootstrap } from "../examples/demo/provider-contract.ts";
import { demoSample } from "../examples/demo/samples.ts";
import { Workspace } from "../src/index.ts";
import { LspWorkspace, createLspActionClient } from "../src/protocol/index.ts";
import type { LspSessionAccess } from "../src/protocol/index.ts";
import { openWebSocketTransport } from "../src/browser/index.ts";

test("real demo provider uses public workspace capture/sync over WebSocket and releases its process and files", { timeout: 30000 }, async () => {
    const server = createServer((request, response) => { void provider.handle(request, response).then(handled => { if (!handled) response.writeHead(404).end(); }); });
    const provider = attachDemoProvider(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}`;
    let owner: LspWorkspace | undefined;
    try {
        const response = await fetch(url + "/demo-provider?sample=errors", { method: "POST" }); assert.equal(response.status, 200);
        const config = await response.json() as DemoProviderBootstrap;
        assert.equal(config.versions.typescript, "5.9.3"); assert.equal(config.versions.server, "5.1.3");
        const workspace = new Workspace(), files = Object.entries(demoSample("errors").files).map(([name, value]) => ({ name,
            resource: workspace.createTextResource({ scope: "demo-test", resource: name, variant: "working" }, name, { value }) }));
        owner = new LspWorkspace(workspace, { connect: () => openWebSocketTransport(url.replace("http:", "ws:") + config.endpoint),
            rootUri: config.rootUri, features: ["textDocument/hover", "textDocument/definition", "workspace/executeCommand"],
            schedule: (ms, callback) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
            documentInfo: document => { const info = config.documents[document.key.resource]; return info && { uri: info.uri, languageId: "typescript" }; } });
        const scope = owner.createScope(); scope.setDocuments(files.map(file => workspace.document(file.resource.documentId)));
        await scope.connect();
        const source = files.find(file => file.name === "main.ts")!;
        const binding = scope.attachDocument(source.resource.documentId);
        const diagnostics = await scope.requestCommand("typescript.tsserverRequest", ["semanticDiagnosticsSync", { file: config.documents["main.ts"]!.path }, {}]).result;
        assert.match(JSON.stringify(diagnostics), /2345/);
        const captured = scope.synchronized(binding); assert.ok(captured); assert.ok(captured.isCurrent());
        const document = workspace.document(source.resource.documentId), from = document.text.indexOf('"10%"');
        assert.ok(from > 0); workspace.edit({ documentId: document.id, expectedRevision: document.revision, origin: "human", edits: [{ from, to: from + 5, insert: "0.1" }] });
        await scope.flush(); assert.equal(captured.isCurrent(), false);
        const fixed = await scope.requestCommand("typescript.tsserverRequest", ["semanticDiagnosticsSync", { file: config.documents["main.ts"]!.path }, {}]).result;
        assert.doesNotMatch(JSON.stringify(fixed), /2345/);
        await assert.rejects(scope.request("demo/probe", { uri: "file:///outside-demo.ts" }).result, /Only this demo/);
        await assert.rejects(scope.requestCommand("typescript.tsserverRequest", ["open", { file: config.documents["main.ts"]!.path }, {}]).result, /captured diagnostic commands/);
        owner.disconnect(); await scope.connect();
        const again = await scope.requestCommand("typescript.tsserverRequest", ["semanticDiagnosticsSync", { file: config.documents["main.ts"]!.path }, {}]).result;
        assert.doesNotMatch(JSON.stringify(again), /2345/);
        owner.dispose(); owner = undefined;
        const removed = await fetch(url + config.endpoint, { method: "DELETE" }); assert.equal(removed.status, 204);
        await assert.rejects(access(fileURLToPath(config.rootUri)));
        assert.deepEqual(provider.snapshot(), { projects: 0, connections: 0, processes: 0, removals: 0 });
    } finally {
        owner?.dispose(); await provider.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});

test("real quick fixes use correlated diagnostic context through the public action client and reject stale context", { timeout: 30000 }, async () => {
    const server = createServer((request, response) => { void provider.handle(request, response).then(handled => { if (!handled) response.writeHead(404).end(); }); });
    const provider = attachDemoProvider(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object"); const url = `http://127.0.0.1:${address.port}`;
    let owner: LspWorkspace | undefined, client: ReturnType<typeof createLspActionClient> | undefined;
    try {
        const config = await (await fetch(url + "/demo-provider?sample=pricing", { method: "POST" })).json() as DemoProviderBootstrap;
        const workspace = new Workspace(), files = Object.entries(demoSample("pricing").files).map(([name, value]) => ({ name,
            resource: workspace.createTextResource({ scope: "fix-test", resource: name, variant: "working" }, name,
                { value: name === "main.ts" ? value.replace("calculateTotal(cart,", "calculateTotl(cart,") : value }) }));
        owner = new LspWorkspace(workspace, { connect: () => openWebSocketTransport(url.replace("http:", "ws:") + config.endpoint), rootUri: config.rootUri,
            features: ["textDocument/codeAction"], diagnostics: false,
            schedule: (ms, callback) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
            documentInfo: document => ({ uri: config.documents[document.key.resource]!.uri, languageId: "typescript" }) });
        const scope = owner.createScope(); scope.setDocuments(files.map(file => workspace.document(file.resource.documentId))); await scope.connect();
        const source = files.find(file => file.name === "main.ts")!, binding = scope.attachDocument(source.resource.documentId), doc = workspace.document(source.resource.documentId), from = doc.text.indexOf("calculateTotl(");
        const request = () => scope.requestDocument("textDocument/codeAction", binding, index => ({ range: { start: index.at(from), end: index.at(from + 13) }, context: { diagnostics: [] } })).result;
        await assert.rejects(request(), /current captured diagnostics/);
        client = createLspActionClient(owner);
        const prepare = async (session: LspSessionAccess) => {
            for (const kind of ["syntactic", "semantic"]) await session.request("sttropez/diagnostics", { uri: config.documents["main.ts"]!.uri, kind }).result;
        };
        let batch = await client.run(files.map(file => workspace.document(file.resource.documentId)), doc.id, from, from + 13, prepare);
        assert.ok(batch.isCurrent());
        const helper = workspace.document(files.find(file => file.name === "pricing.ts")!.resource.documentId);
        assert.ok(workspace.edit({ documentId: helper.id, expectedRevision: helper.revision, origin: "host", edits: [{ from: 0, to: 0, insert: "// Related file changed\n" }] }).applied);
        await scope.flush(); assert.equal(batch.isCurrent(), false); await assert.rejects(request(), /current captured diagnostics/);
        batch = await client.run(files.map(file => workspace.document(file.resource.documentId)), doc.id, from, from + 13, prepare);
        const fix = batch.actions.find(action => action.title === "Change spelling to 'calculateTotal'"); assert.ok(fix?.edit); assert.equal(fix.command, null); assert.ok(batch.isCurrent());
        // The live demo refreshes diagnostics independently of explicit action requests.
        const refresh = scope.request("sttropez/diagnostics", { uri: config.documents["main.ts"]!.uri, kind: "semantic" });
        const [duringRefresh] = await Promise.all([request(), refresh.result]); assert.ok(Array.isArray(duringRefresh));
        const applied = workspace.editDocuments(fix.edit.documents.map(change => ({
            documentId: files.find(file => file.resource.documentId === change.target.document.documentId)!.resource.documentId,
            expectedRevision: change.target.document.revision, origin: "host", edits: change.edits, history: { kind: "refactor" } })));
        assert.ok(applied.applied); assert.match(workspace.document(doc.id).text, /calculateTotal\(cart, 0.1\)/); assert.equal(batch.isCurrent(), false);
        await scope.flush(); await assert.rejects(request(), /current captured diagnostics/);
        const current = workspace.document(doc.id); assert.ok(workspace.undo({ documentId: doc.id, expectedRevision: current.revision }).applied);
        assert.match(workspace.document(doc.id).text, /calculateTotl\(cart, 0.1\)/);
        client.dispose(); client = undefined; owner.dispose(); owner = undefined;
        assert.equal((await fetch(url + config.endpoint, { method: "DELETE" })).status, 204);
        assert.deepEqual(provider.snapshot(), { projects: 0, connections: 0, processes: 0, removals: 0 });
    } finally { client?.dispose(); owner?.dispose(); await provider.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
