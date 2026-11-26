import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { access, rmdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { attachDemoProvider } from "../fixtures/demo/provider-server.ts";
import type { DemoProviderBootstrap } from "../../examples/demo/provider-contract.ts";
import { demoSample } from "../../examples/demo/samples.ts";
import { Workspace } from "../../src/index.ts";
import { LspWorkspace } from "../../src/protocol/index.ts";
import { openWebSocketTransport } from "../../src/browser/index.ts";

test("demo capacity reclaims idle workspaces while retaining connected clients and bounding concurrent allocation", { timeout: 15000 }, async () => {
    const server = createServer((request, response) => { void provider.handle(request, response).then(handled => { if (!handled) response.writeHead(404).end(); }); });
    const provider = attachDemoProvider(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}`;
    const open = async () => {
        const response = await fetch(url + "/demo-provider?sample=pricing", { method: "POST" });
        assert.equal(response.status, 200); assert.ok(provider.snapshot().projects <= 32);
        return await response.json() as DemoProviderBootstrap;
    };
    let connection: WebSocket | undefined;
    try {
        const active = await open(); connection = new WebSocket(url.replace("http:", "ws:") + active.endpoint);
        await new Promise<void>((resolve, reject) => { connection!.onopen = () => resolve(); connection!.onerror = () => reject(new Error("Provider connection failed")); });
        const idle = await open();
        for (let i = 0; i < 30; i++) await open();
        assert.equal(provider.snapshot().projects, 32);
        await open(); await assert.rejects(access(fileURLToPath(idle.rootUri)));
        const opened = await Promise.allSettled(Array.from({ length: 16 }, () => open()));
        for (const result of opened) assert.equal(result.status, "fulfilled");
        assert.equal(provider.snapshot().projects, 32); assert.equal(provider.snapshot().connections, 1);
        await access(fileURLToPath(active.rootUri)); assert.equal(connection.readyState, WebSocket.OPEN);
    } finally {
        connection?.close(); await provider.close();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    assert.deepEqual(provider.snapshot(), { projects: 0, connections: 0, processes: 0, removals: 0 });
});

test("Windows demo cleanup awaits a briefly locked workspace directory", { skip: process.platform !== "win32", timeout: 10000 }, async () => {
    const server = createServer((request, response) => { void provider.handle(request, response).then(handled => { if (!handled) response.writeHead(404).end(); }); });
    const provider = attachDemoProvider(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}`;
    const config = await (await fetch(url + "/demo-provider?sample=pricing", { method: "POST" })).json() as DemoProviderBootstrap;
    const directory = fileURLToPath(config.rootUri);
    const holder = spawn(process.execPath, ["-e", "process.send('ready'); process.on('message', () => process.exit(0));"],
        { cwd: directory, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const stopped = once(holder, "close"); let release: ReturnType<typeof setTimeout> | undefined;
    try {
        await once(holder, "message");
        await assert.rejects(rmdir(directory), { code: "EBUSY" });
        const removing = fetch(url + config.endpoint, { method: "DELETE" });
        release = setTimeout(() => { if (holder.connected) holder.send("release"); }, 250);
        assert.equal((await removing).status, 204); await stopped;
        await assert.rejects(access(directory));
        assert.deepEqual(provider.snapshot(), { projects: 0, connections: 0, processes: 0, removals: 0 });
    } finally {
        clearTimeout(release); if (holder.exitCode === null) holder.kill(); await stopped;
        await provider.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});

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
        const comments = "\n// Example row".repeat(300);
        const workspace = new Workspace(), files = Object.entries(demoSample("errors").files).map(([name, value]) => ({ name,
            resource: workspace.createTextResource({ scope: "demo-test", resource: name, variant: "working" }, name, {
                value: name === "main.ts" ? value + comments : value,
                language: { uri: config.documents[name]!.uri, languageId: "typescript" },
            }) }));
        owner = new LspWorkspace(workspace, { connect: () => openWebSocketTransport(url.replace("http:", "ws:") + config.endpoint),
            rootUri: config.rootUri, features: ["textDocument/hover", "textDocument/definition", "workspace/executeCommand"],
            schedule: (ms, callback) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); } });
        const scope = owner.createScope(); scope.setDocuments(files.map(file => workspace.document(file.resource.id)));
        await scope.ensureConnected();
        const source = files.find(file => file.name === "main.ts")!;
        const binding = scope.attachDocument(source.resource.id);
        const diagnostics = await scope.requestCommand("typescript.tsserverRequest", ["semanticDiagnosticsSync", { file: config.documents["main.ts"]!.path }, {}]).result;
        assert.match(JSON.stringify(diagnostics), /2551/);
        const captured = scope.synchronized(binding); assert.ok(captured); assert.ok(captured.isCurrent());
        const document = workspace.document(source.resource.id), from = document.text().indexOf("quanity");
        assert.ok(from > 0);
        const rows = [...document.text().matchAll(/Example row/g)].map(({ index }) => ({ from: index, to: index + 11, insert: "Updated" }));
        assert.equal(rows.length, 300);
        workspace.edit({ documentId: document.id, expectedRevision: document.revision, origin: "human", edits: [{ from, to: from + "quanity".length, insert: "quantity" }, ...rows] });
        await scope.flush(); assert.equal(captured.isCurrent(), false);
        const uri = config.documents["main.ts"]!.uri;
        assert.deepEqual(await scope.request("sttropez/readDocument", { uri }).result, { uri, text: workspace.document(document.id).text() });
        const fixed = await scope.requestCommand("typescript.tsserverRequest", ["semanticDiagnosticsSync", { file: config.documents["main.ts"]!.path }, {}]).result;
        assert.doesNotMatch(JSON.stringify(fixed), /2551/);
        await assert.rejects(scope.request("demo/probe", { uri: "file:///outside-demo.ts" }).result, /Only this demo/);
        await assert.rejects(scope.requestCommand("typescript.tsserverRequest", ["open", { file: config.documents["main.ts"]!.path }, {}]).result, /captured diagnostic commands/);
        await assert.rejects(scope.requestCommand("_typescript.applyRefactoring", [{ file: config.documents["main.ts"]!.path,
            refactor: "Extract Symbol", action: "constant_scope_0" }]).result, /captured diagnostic commands/);
        owner.disconnect(); await scope.ensureConnected();
        const again = await scope.requestCommand("typescript.tsserverRequest", ["semanticDiagnosticsSync", { file: config.documents["main.ts"]!.path }, {}]).result;
        assert.doesNotMatch(JSON.stringify(again), /2551/);
        owner.dispose(); owner = undefined;
        const removed = await fetch(url + config.endpoint, { method: "DELETE" }); assert.equal(removed.status, 204);
        await assert.rejects(access(fileURLToPath(config.rootUri)));
        assert.deepEqual(provider.snapshot(), { projects: 0, connections: 0, processes: 0, removals: 0 });
    } finally {
        owner?.dispose(); await provider.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});
