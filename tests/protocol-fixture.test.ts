import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { attachProtocolFixture } from "../examples/protocol/fixture-server.ts";
import { reviewHeader, reviewFooter } from "../examples/probes/project-commands.ts";
import { Workspace } from "../src/index.ts";
import { openWebSocketTransport } from "../src/browser/index.ts";
import { LspWorkspace, createLspActionClient, createLspHighlightClient, decodeLspCompletions, decodeLspResolvedCompletion, lspCompletionPlan } from "../src/protocol/index.ts";
import type { LspDocumentCapture, LspCommandScope, LspWorkspaceEdit } from "../src/protocol/index.ts";

test("generic host profile joins selector registration, space-triggered lazy snippets, occurrences and an explicitly authorized command", { timeout: 15000 }, async () => {
    const server = createServer(), detach = attachProtocolFixture(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    const workspace = new Workspace(), initial = "const sample = 1;\nsample; ";
    const source = workspace.createTextResource({ scope: "profile", resource: "source", variant: "working" }, "Source", { value: initial });
    const other = workspace.createTextResource({ scope: "profile", resource: "other", variant: "working" }, "Other", { value: "sample" });
    const document = () => workspace.document(source.documentId), snapshots = () => [document()];
    const owner = new LspWorkspace(workspace, {
        connect: () => openWebSocketTransport(`ws://127.0.0.1:${address.port}/lsp-fixture`), initializationOptions: { fixtureHostProfile: true },
        features: ["textDocument/completion", "textDocument/documentHighlight", "textDocument/codeAction", "workspace/executeCommand"], applyEdit: true,
        documentInfo: doc => ({ uri: `host+fixture:${doc.resourceId}`, languageId: doc.id === source.documentId ? "fixture" : "other" }),
        schedule: (ms, callback) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); }
    });
    const scope = owner.createScope(), highlights = createLspHighlightClient(owner), defaultActions = createLspActionClient(owner);
    const actions = createLspActionClient(owner, { commandPolicy: invocation => invocation.command === "fixture.unadvertised" ? { kind: "server" } : null });
    const apply = (edit: LspWorkspaceEdit) => workspace.editDocuments(edit.documents.map(change => {
        assert.equal(change.target.document.documentId, source.documentId);
        return { documentId: source.documentId, expectedRevision: change.target.document.revision, origin: "host", edits: change.edits, history: { kind: "refactor" } };
    }));
    try {
        scope.setDocuments([document(), workspace.document(other.documentId)]); await scope.connect();
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
        assert.equal(document().text, "// resolved import\r\nconst sample = 1;\nsample; sample(value)");
        assert.ok(workspace.undo({ documentId: before.id, expectedRevision: document().revision }).applied); assert.equal(document().text, initial);
        const occurrences = await highlights.run(document(), 19).result;
        assert.deepEqual(occurrences.items, [{ from: 6, to: 12, kind: "text" }, { from: 18, to: 24, kind: "text" }]);
        await scope.request("fixture/completionStyle", { style: "edits" }).result;
        assert.equal(scope.canRequest("textDocument/completion", binding), false);
        scope.setDocuments(snapshots()); await scope.flush();

        const denied = await defaultActions.run(snapshots(), before.id, 0, 0), unavailable = denied.actions.find(item => item.command?.command === "fixture.unadvertised");
        assert.ok(unavailable?.command); assert.equal(denied.supports(unavailable.command), false); defaultActions.dispose();
        const batch = await actions.run(snapshots(), before.id, 0, 0), action = batch.actions.find(item => item.command?.command === "fixture.unadvertised");
        assert.ok(action?.edit); assert.ok(action.command); assert.equal(batch.supports(action.command), true);
        assert.equal(scope.commandNames().includes("fixture.unadvertised"), false);
        let reviews = 0;
        const commandScope: LspCommandScope = { snapshots, isCurrent: () => true,
            prepare: () => { assert.ok(apply(action.edit!).applied); },
            review: async (request, context) => { reviews++; assert.ok(context.isCurrent()); assert.ok(request.edit.isCurrent()); return apply(request.edit); }
        };
        const receipt = await batch.execute(action, commandScope); assert.equal(receipt.decision?.applied, true); assert.equal(reviews, 1);
        assert.equal(document().text, reviewHeader + "// fixture action\r\n" + initial + reviewFooter);
        const last = await scope.request("fixture/lastCommand").result as { command: string; documents: { prefix: string }[] };
        assert.equal(last.command, "fixture.unadvertised"); assert.ok(last.documents[0]!.prefix.startsWith("// fixture action\r\n"));
        // Initial action and later server edits are separate, explicitly undoable phases.
        assert.ok(workspace.undo({ documentId: before.id, expectedRevision: document().revision }).applied);
        assert.equal(document().text, "// fixture action\r\n" + initial);
        assert.ok(workspace.undo({ documentId: before.id, expectedRevision: document().revision }).applied); assert.equal(document().text, initial);
    } finally {
        actions.dispose(); defaultActions.dispose(); highlights.dispose(); owner.dispose(); detach();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        assert.equal(workspace.diagnostics().leases, 0);
    }
});
