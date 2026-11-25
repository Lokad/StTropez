import test from "node:test";
import assert from "node:assert/strict";
import { actionClient } from "../../src/protocol/lsp-actions.ts";
import { highlightClient } from "../../src/protocol/lsp-highlights.ts";
import { withProtocolFixture } from "../helpers/protocol-fixture.ts";
import { reviewHeader, reviewFooter } from "../../fixtures/language/project-commands.ts";
import { Workspace } from "../../src/index.ts";
import { openWebSocketTransport } from "../../src/browser/index.ts";
import { LspWorkspace, RpcError, lspCompletionPlan } from "../../src/protocol/index.ts";
import { decodeLspCompletions, decodeLspResolvedCompletion } from "../../src/protocol/lsp-features.ts";
import type { LspDocumentCapture, LspCommandScope, LspWorkspaceEdit } from "../../src/protocol/index.ts";

test("fixture diagnostics address the requested URI and reject missing, unknown or closed targets", { timeout: 15000 }, async () => withProtocolFixture(async ({ url, defer }) => {
    const firstUri = "host+fixture:first", uri = "host+fixture:second%20document";
    const workspace = new Workspace(), first = workspace.createTextResource({ scope: "diagnostics", resource: "first", variant: "working" }, "First", { value: "TODO first" }, undefined, { language: { uri: firstUri, languageId: "fixture" } });
    const second = workspace.createTextResource({ scope: "diagnostics", resource: "second", variant: "working" }, "Second", { value: "header\nTODO second" }, undefined, { language: { uri: uri, languageId: "fixture" } });
    defer(() => assert.equal(workspace.diagnostics().leases, 0));
    const owner = new LspWorkspace(workspace, { connect: () => openWebSocketTransport(url), diagnostics: true,
        schedule: (ms, callback) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); } });
    defer(() => owner.dispose());
    const scope = owner.createScope(), pushes: { uri: string; version?: number; diagnostics: { range: unknown; message: string }[] }[] = [];
    scope.onNotification("textDocument/publishDiagnostics", value => { pushes.push(value as typeof pushes[number]); });
    scope.setDocuments([workspace.document(first.documentId), workspace.document(second.documentId)]); await scope.ensureConnected(); await scope.flush();
    assert.ok(workspace.edit({ documentId: second.documentId, expectedRevision: 0, origin: "human", edits: [{ from: 0, to: 0, insert: "// " }] }).applied);
    await scope.flush(); const secondVersion = scope.captureProject().get(uri)!.version;
    await scope.request("fixture/state").result; pushes.length = 0;
    const firstDiagnostics = scope.observeDiagnostics(scope.attachDocument(first.documentId)), untouched = firstDiagnostics.getSnapshot();
    for (const mode of ["normal", "clear", "stale", "unversioned", "html", "malformed", "out-of-bounds"] as const) {
        const before = pushes.length;
        assert.deepEqual(await scope.request("fixture/diagnostics", { uri, mode }).result, { version: secondVersion });
        assert.equal(pushes.length, before + 1); const push = pushes.at(-1)!;
        assert.equal(push.uri, uri); assert.equal(firstDiagnostics.getSnapshot(), untouched);
        assert.equal(push.version, mode === "unversioned" ? undefined : mode === "stale" ? secondVersion - 1 : secondVersion);
        if (mode === "clear") assert.deepEqual(push.diagnostics, []);
        else assert.deepEqual(push.diagnostics[0], { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } }, message: "Resolve this placeholder.", severity: 2 });
        assert.equal(push.diagnostics.length, ["html", "malformed", "out-of-bounds"].includes(mode) ? 2 : mode === "clear" ? 0 : 1);
    }
    const beforeInvalid = pushes.length;
    for (const params of [{}, { mode: "clear" }, { uri: 7, mode: "clear" }, { uri: "host+fixture:unknown", mode: "clear" }, { uri, mode: "unknown" }]) {
        await assert.rejects(scope.request("fixture/diagnostics", params).result, error => error instanceof RpcError && error.code === -32602);
    }
    assert.equal(pushes.length, beforeInvalid);
    scope.setDocuments([workspace.document(first.documentId)]); await scope.flush();
    await assert.rejects(scope.request("fixture/diagnostics", { uri, mode: "clear" }).result, error => error instanceof RpcError && error.code === -32602);
    assert.equal(pushes.length, beforeInvalid);
    await scope.request("fixture/diagnostics", { uri: firstUri, mode: "clear" }).result;
    assert.equal(pushes.at(-1)!.uri, firstUri); assert.deepEqual(pushes.at(-1)!.diagnostics, []);
}));

test("generic host profile joins selector registration, space-triggered lazy snippets, occurrences and an explicitly authorized command", { timeout: 15000 }, async () => withProtocolFixture(async ({ url, defer }) => {
    const workspace = new Workspace(), initial = "const sample = 1;\nsample; ";
    const source = workspace.createTextResource({ scope: "profile", resource: "source", variant: "working" }, "Source", { value: initial }, undefined, { language: { uri: "host+fixture:source", languageId: "fixture" } });
    const other = workspace.createTextResource({ scope: "profile", resource: "other", variant: "working" }, "Other", { value: "sample" }, undefined, { language: { uri: "host+fixture:other", languageId: "other" } });
    defer(() => assert.equal(workspace.diagnostics().leases, 0));
    const document = () => workspace.document(source.documentId), snapshots = () => [document()];
    const owner = new LspWorkspace(workspace, {
        connect: () => openWebSocketTransport(url), initializationOptions: { fixtureHostProfile: true },
        features: ["textDocument/completion", "textDocument/documentHighlight", "textDocument/codeAction", "workspace/executeCommand"], applyEdit: true,
        schedule: (ms, callback) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); }
    });
    defer(() => owner.dispose());
    const scope = owner.createScope(), highlights = highlightClient(owner); defer(() => highlights.dispose());
    const defaultActions = actionClient(owner); defer(() => defaultActions.dispose());
    const actions = actionClient(owner, { commandPolicy: invocation => invocation.command === "fixture.unadvertised" ? { kind: "server" } : null });
    defer(() => actions.dispose());
    const apply = (edit: LspWorkspaceEdit) => workspace.editDocuments(edit.documents.map(change => {
        assert.equal(change.target.document.documentId, source.documentId);
        return { documentId: source.documentId, expectedRevision: change.target.document.revision, origin: "host", edits: change.edits, history: { kind: "refactor" } };
    }));
    scope.setDocuments([document(), workspace.document(other.documentId)]); await scope.ensureConnected();
    const binding = scope.attachDocument(source.documentId), nonmatching = scope.attachDocument(other.documentId);
    assert.equal(scope.canRequest("textDocument/completion", binding), false);
    await scope.request("fixture/completionStyle", { style: "interactive" }).result;
    assert.equal(scope.canRequest("textDocument/completion", binding), true);
    assert.equal(scope.canRequest("textDocument/completion", nonmatching), false);
    assert.deepEqual(scope.featureOptions("textDocument/completion", binding).map(options => options.triggerCharacters), [[".", " "]]);
    const before = document(); let capture: LspDocumentCapture | undefined;
    const response = await scope.requestDocument("textDocument/completion", binding, (index, _doc, current) => {
        capture = current; return { position: index.at(before.buffer.length), context: { triggerKind: 2, triggerCharacter: " " } };
    }).result;
    assert.ok(capture);
    const choice = decodeLspCompletions(response, capture, before.buffer.length, undefined, { resolve: true }).items.find(item => item.label === "sampleSnippet");
    assert.ok(choice?.snippet); assert.ok(choice.resolve); assert.equal(choice.additional.length, 0);
    const resolved = decodeLspResolvedCompletion(await scope.request("completionItem/resolve", choice.resolve).result, choice, capture);
    assert.equal(resolved.additional.length, 1); const plan = lspCompletionPlan(resolved, "replace");
    assert.ok(workspace.edit({ documentId: before.id, expectedRevision: before.revision, origin: "human", edits: plan.edits, history: { kind: "replace" } }).applied);
    assert.equal(document().text(), "// resolved import\r\nconst sample = 1;\nsample; sample(value)");
    assert.ok(workspace.undo({ documentId: before.id, expectedRevision: document().revision }).applied); assert.equal(document().text(), initial);
    const occurrences = await highlights.run({ document: document(), offset: 19 }).result;
    assert.deepEqual(occurrences.items, [{ from: 6, to: 12, kind: "text" }, { from: 18, to: 24, kind: "text" }]);
    await scope.request("fixture/completionStyle", { style: "edits" }).result;
    assert.equal(scope.canRequest("textDocument/completion", binding), false);
    scope.setDocuments(snapshots()); await scope.flush();

    const denied = await defaultActions.run({ document: document(), from: 0, to: 0 }).result, unavailable = denied.actions.find(item => item.command?.command === "fixture.unadvertised");
    assert.ok(unavailable?.command); assert.equal(denied.supports(unavailable.command), false); defaultActions.dispose();
    const batch = await actions.run({ document: document(), from: 0, to: 0 }).result, action = batch.actions.find(item => item.command?.command === "fixture.unadvertised");
    assert.ok(action?.edit); assert.ok(action.command); assert.equal(batch.supports(action.command), true);
    assert.equal(scope.commandNames().includes("fixture.unadvertised"), false);
    let reviews = 0;
    const commandScope: LspCommandScope = { snapshots, isCurrent: () => true,
        prepare: () => { assert.ok(apply(action.edit!).applied); },
        review: async (request, context) => { reviews++; assert.ok(context.isCurrent()); assert.ok(request.edit.isCurrent()); return apply(request.edit); }
    };
    const receipt = await batch.execute(action, commandScope); assert.equal(receipt.decision?.applied, true); assert.equal(reviews, 1);
    assert.equal(document().text(), reviewHeader + "// fixture action\r\n" + initial + reviewFooter);
    const last = await scope.request("fixture/lastCommand").result as { command: string; documents: { prefix: string }[] };
    assert.equal(last.command, "fixture.unadvertised"); assert.ok(last.documents[0]!.prefix.startsWith("// fixture action\r\n"));
    // Initial action and later server edits are separate, explicitly undoable phases.
    assert.ok(workspace.undo({ documentId: before.id, expectedRevision: document().revision }).applied);
    assert.equal(document().text(), "// fixture action\r\n" + initial);
    assert.ok(workspace.undo({ documentId: before.id, expectedRevision: document().revision }).applied); assert.equal(document().text(), initial);
}));
