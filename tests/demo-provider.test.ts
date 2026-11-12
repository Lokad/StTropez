import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { attachDemoProvider } from "../examples/demo/provider-server.ts";
import type { DemoProviderBootstrap } from "../examples/demo/provider-contract.ts";
import { demoSample } from "../examples/demo/samples.ts";
import { Workspace } from "../src/index.ts";
import { LspWorkspace } from "../src/protocol/index.ts";
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
