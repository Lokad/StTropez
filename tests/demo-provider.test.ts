import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { access, rmdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { attachDemoProvider } from "../examples/demo/provider-server.ts";
import type { DemoProviderBootstrap } from "../examples/demo/provider-contract.ts";
import { demoSample } from "../examples/demo/samples.ts";
import { Workspace } from "../src/index.ts";
import { LspWorkspace, createLspActionClient, decodeLspCompletions, decodeLspResolvedCompletion, lspCompletionPlan } from "../src/protocol/index.ts";
import type { LspDocumentCapture, LspScopeAccess } from "../src/protocol/index.ts";
import { openWebSocketTransport } from "../src/browser/index.ts";

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
        const workspace = new Workspace(), files = Object.entries(demoSample("errors").files).map(([name, value]) => ({ name,
            resource: workspace.createTextResource({ scope: "demo-test", resource: name, variant: "working" }, name, { value }) }));
        owner = new LspWorkspace(workspace, { connect: () => openWebSocketTransport(url.replace("http:", "ws:") + config.endpoint),
            rootUri: config.rootUri, features: ["textDocument/hover", "textDocument/definition", "workspace/executeCommand"],
            schedule: (ms, callback) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
            documentInfo: document => { const info = config.documents[document.key.resource]; return info && { uri: info.uri, languageId: "typescript" }; } });
        const scope = owner.createScope(); scope.setDocuments(files.map(file => workspace.document(file.resource.documentId)));
        await scope.ensureConnected();
        const source = files.find(file => file.name === "main.ts")!;
        const binding = scope.attachDocument(source.resource.documentId);
        const diagnostics = await scope.requestCommand("typescript.tsserverRequest", ["semanticDiagnosticsSync", { file: config.documents["main.ts"]!.path }, {}]).result;
        assert.match(JSON.stringify(diagnostics), /2345/);
        const captured = scope.synchronized(binding); assert.ok(captured); assert.ok(captured.isCurrent());
        const document = workspace.document(source.resource.documentId), from = document.text().indexOf('"10%"');
        assert.ok(from > 0); workspace.edit({ documentId: document.id, expectedRevision: document.revision, origin: "human", edits: [{ from, to: from + 5, insert: "0.1" }] });
        await scope.flush(); assert.equal(captured.isCurrent(), false);
        const fixed = await scope.requestCommand("typescript.tsserverRequest", ["semanticDiagnosticsSync", { file: config.documents["main.ts"]!.path }, {}]).result;
        assert.doesNotMatch(JSON.stringify(fixed), /2345/);
        await assert.rejects(scope.request("demo/probe", { uri: "file:///outside-demo.ts" }).result, /Only this demo/);
        await assert.rejects(scope.requestCommand("typescript.tsserverRequest", ["open", { file: config.documents["main.ts"]!.path }, {}]).result, /captured diagnostic commands/);
        await assert.rejects(scope.requestCommand("_typescript.applyRefactoring", [{ file: config.documents["main.ts"]!.path,
            refactor: "Extract Symbol", action: "constant_scope_0" }]).result, /captured diagnostic commands/);
        owner.disconnect(); await scope.ensureConnected();
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

test("real lazy imports, snippets and reviewed command edits use public clients and atomic history", { timeout: 30000 }, async () => {
    const server = createServer((request, response) => { void provider.handle(request, response).then(handled => { if (!handled) response.writeHead(404).end(); }); });
    const provider = attachDemoProvider(server, { refactoring: true }); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object"); const url = `http://127.0.0.1:${address.port}`;
    let owner: LspWorkspace | undefined, actions: ReturnType<typeof createLspActionClient> | undefined;
    try {
        const config = await (await fetch(url + "/demo-provider?sample=pricing", { method: "POST" })).json() as DemoProviderBootstrap;
        const workspace = new Workspace(), files = Object.entries(demoSample("pricing").files).map(([name, value]) => ({ name,
            resource: workspace.createTextResource({ scope: "completion-test", resource: name, variant: "working" }, name, { value: name === "main.ts" ? "calculateT" : value }) }));
        owner = new LspWorkspace(workspace, { connect: () => openWebSocketTransport(url.replace("http:", "ws:") + config.endpoint), rootUri: config.rootUri,
            features: ["textDocument/completion", "textDocument/codeAction", "workspace/executeCommand"], applyEdit: true,
            documentInfo: document => ({ uri: config.documents[document.key.resource]!.uri, languageId: "typescript" }),
            schedule: (ms, callback) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); } });
        const scope = owner.createScope(); scope.setDocuments(files.map(file => workspace.document(file.resource.documentId))); await scope.ensureConnected();
        const source = files.find(file => file.name === "main.ts")!, before = workspace.document(source.resource.documentId), binding = scope.attachDocument(before.id);
        let capture: LspDocumentCapture | undefined;
        const response = await scope.requestDocument("textDocument/completion", binding, (index, _document, current) => {
            capture = current; return { position: index.at(before.buffer.length) };
        }).result;
        assert.ok(capture); const choices = decodeLspCompletions(response, capture, before.buffer.length,
            { from: 0, to: before.buffer.length, replaceTo: before.buffer.length }, { resolve: true });
        const choice = choices.items.find(item => item.label === "calculateTotal"); assert.ok(choice?.resolve); assert.equal(choice.additional.length, 0);
        const wire = await scope.request("completionItem/resolve", choice.resolve).result;
        const resolved = decodeLspResolvedCompletion(wire, choice, capture); assert.equal(resolved.additional.length, 1);
        assert.equal(resolved.additional[0]!.from, 0); assert.equal(resolved.additional[0]!.to, 0);
        const plan = lspCompletionPlan(resolved, "replace"), view = workspace.createDocumentView(before.id, { anchor: before.buffer.length, head: before.buffer.length });
        assert.ok(workspace.edit({ documentId: before.id, expectedRevision: before.revision, origin: "human", edits: plan.edits, view, selectionSet: plan.selectionSet, history: { kind: "replace" } }).applied);
        const after = workspace.document(before.id); assert.equal(after.text(), 'import { calculateTotal } from "./pricing";\n\ncalculateTotal');
        assert.equal(view.getSnapshot().selection.head, after.buffer.length); assert.equal(capture.isCurrent(), false);
        assert.ok(workspace.undo({ documentId: before.id, expectedRevision: after.revision }).applied); assert.equal(workspace.document(before.id).text(), "calculateT");
        const replace = (text: string) => {
            const doc = workspace.document(before.id);
            assert.ok(workspace.edit({ documentId: doc.id, expectedRevision: doc.revision, origin: "host", edits: [{ from: 0, to: doc.buffer.length, insert: text }] }).applied);
            return workspace.document(doc.id);
        };
        const snippetSource = "class Base { method(value: number): number { return value; } }\nclass Derived extends Base {\n    met";
        const snippetBefore = replace(snippetSource); let snippetCapture: LspDocumentCapture | undefined;
        const snippetResponse = await scope.requestDocument("textDocument/completion", binding, (index, _document, current) => {
            snippetCapture = current; return { position: index.at(snippetBefore.buffer.length) };
        }).result;
        assert.ok(snippetCapture); const method = decodeLspCompletions(snippetResponse, snippetCapture, snippetBefore.buffer.length, undefined, { resolve: true }).items.find(item => item.label === "method");
        assert.ok(method?.resolve); assert.ok(method.snippet);
        const snippetWire = await scope.request("completionItem/resolve", method.resolve).result;
        const snippetPlan = lspCompletionPlan(decodeLspResolvedCompletion(snippetWire, method, snippetCapture), "replace");
        assert.ok(workspace.edit({ documentId: before.id, expectedRevision: snippetBefore.revision, origin: "human", edits: snippetPlan.edits,
            view, selectionSet: snippetPlan.selectionSet, history: { kind: "replace" } }).applied);
        const snippetAfter = workspace.document(before.id); assert.equal(snippetAfter.text(),
            snippetSource.slice(0, -3) + "method(value: number): number {\n        \n    }");
        assert.equal(snippetAfter.buffer.slice(snippetPlan.head - 8, snippetPlan.head + 1), "        \n");
        assert.equal(view.getSnapshot().selection.head, snippetPlan.head);
        assert.ok(workspace.undo({ documentId: before.id, expectedRevision: snippetAfter.revision }).applied); assert.equal(workspace.document(before.id).text(), snippetSource);

        const refactorSource = "export function price(count: number) {\n    return count * (1 + 2);\n}\n", refactorBefore = replace(refactorSource);
        const snapshots = () => files.map(file => workspace.document(file.resource.documentId));
        const pathKey = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
        let renameHints = 0;
        scope.onRequest("_typescript.rename", (params, context) => {
            const hint = params as { textDocument: { uri: string }; position: { line: number; character: number } };
            assert.equal(context.isCurrent(), true); assert.equal(hint.textDocument.uri, config.documents["main.ts"]!.uri);
            assert.ok(hint.position.line >= 0 && hint.position.character >= 0); renameHints++; return null;
        });
        actions = createLspActionClient(owner, { commandPolicy: invocation => {
            const file = (invocation.arguments[0] as { file?: unknown } | undefined)?.file;
            return invocation.command === "_typescript.applyRefactoring" && typeof file === "string"
                && pathKey(file) === pathKey(config.documents["main.ts"]!.path) ? { kind: "server" } : null;
        } });
        const from = refactorSource.indexOf("1 + 2"), batch = await actions.run(snapshots(), before.id, from, from + 5, async session => {
            for (const kind of ["syntactic", "semantic"]) await session.request("sttropez/diagnostics", { uri: config.documents["main.ts"]!.uri, kind }).result;
        });
        await assert.rejects(scope.requestCommand("_typescript.applyRefactoring", [{ file: config.documents["main.ts"]!.path + ".outside",
            refactor: "Extract Symbol", action: "constant_scope_0" }]).result, /Only this demo/);
        const action = batch.actions.find(item => !item.disabled && item.command?.command === "_typescript.applyRefactoring" && item.kind === "refactor.extract.constant");
        assert.ok(action?.command, JSON.stringify(batch.actions.map(item => ({ title: item.title, kind: item.kind, command: item.command?.command }))));
        assert.equal(action.edit, null); assert.equal(batch.supports(action.command), true, JSON.stringify({ command: action.command, expected: config.documents["main.ts"]!.path }));
        let approve = false, reviews = 0;
        const commandScope = { snapshots, isCurrent: () => true, review: async (request: import("../src/protocol/index.ts").LspApplyEdit, context: import("../src/protocol/index.ts").LspRequestContext) => {
            reviews++; assert.equal(context.isCurrent(), true); assert.equal(request.edit.isCurrent(), true); assert.equal(request.edit.documents.length, 1);
            assert.equal(request.edit.documents[0]!.target.document.documentId, before.id);
            if (!approve) return { applied: false, failureReason: "Review declined" };
            return workspace.editDocuments(request.edit.documents.map(change => ({ documentId: before.id, expectedRevision: change.target.document.revision,
                origin: "host", edits: change.edits, history: { kind: "refactor" } })));
        } };
        const declined = await batch.execute(action, commandScope); assert.equal(declined.decision?.applied, false); assert.equal(workspace.document(before.id), refactorBefore);
        approve = true; const depth = workspace.observeHistory(before.id).getSnapshot().undoDepth;
        const applied = await batch.execute(action, commandScope); assert.equal(applied.decision?.applied, true); assert.equal(reviews, 2); assert.equal(renameHints, 1);
        const refactorAfter = workspace.document(before.id); assert.match(refactorAfter.text(), /const \w+ = 1 \+ 2;/); assert.doesNotMatch(refactorAfter.text(), /return count \* \(1 \+ 2\)/);
        assert.equal(workspace.observeHistory(before.id).getSnapshot().undoDepth, depth + 1); assert.equal(batch.isCurrent(), false);
        assert.ok(workspace.undo({ documentId: before.id, expectedRevision: refactorAfter.revision }).applied); assert.equal(workspace.document(before.id).text(), refactorSource);
        actions.dispose(); actions = undefined;
        view.dispose(); owner.dispose(); owner = undefined; assert.equal((await fetch(url + config.endpoint, { method: "DELETE" })).status, 204);
        assert.deepEqual(provider.snapshot(), { projects: 0, connections: 0, processes: 0, removals: 0 });
    } finally { actions?.dispose(); owner?.dispose(); await provider.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
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
        const scope = owner.createScope(); scope.setDocuments(files.map(file => workspace.document(file.resource.documentId))); await scope.ensureConnected();
        const source = files.find(file => file.name === "main.ts")!, binding = scope.attachDocument(source.resource.documentId), doc = workspace.document(source.resource.documentId), from = doc.text().indexOf("calculateTotl(");
        const request = () => scope.requestDocument("textDocument/codeAction", binding, index => ({ range: { start: index.at(from), end: index.at(from + 13) }, context: { diagnostics: [] } })).result;
        await assert.rejects(request(), /current captured diagnostics/);
        client = createLspActionClient(owner);
        const prepare = async (session: LspScopeAccess) => {
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
        assert.ok(applied.applied); assert.match(workspace.document(doc.id).text(), /calculateTotal\(cart, 0.1\)/); assert.equal(batch.isCurrent(), false);
        await scope.flush(); await assert.rejects(request(), /current captured diagnostics/);
        const current = workspace.document(doc.id); assert.ok(workspace.undo({ documentId: doc.id, expectedRevision: current.revision }).applied);
        assert.match(workspace.document(doc.id).text(), /calculateTotl\(cart, 0.1\)/);
        client.dispose(); client = undefined; owner.dispose(); owner = undefined;
        assert.equal((await fetch(url + config.endpoint, { method: "DELETE" })).status, 204);
        assert.deepEqual(provider.snapshot(), { projects: 0, connections: 0, processes: 0, removals: 0 });
    } finally { client?.dispose(); owner?.dispose(); await provider.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
