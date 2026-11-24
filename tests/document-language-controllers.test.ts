import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
    attachEditorLanguage, createCodeActionController, createDocumentColorController,
    createDocumentLinkController, createRenameController,
    type TextEditor,
} from "../src/browser/index.ts";
import { createDecorationLayers } from "../src/browser/decoration-layers.ts";
import { editorState } from "./helpers/editor-state.ts";
import { latch } from "./helpers/latch.ts";
import { clientFixture, settled } from "./helpers/lsp-client.ts";
import { ResponseError } from "vscode-languageserver-protocol/node.js";

const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } };

async function fixture(t: TestContext) {
    const f = clientFixture(t);
    const { workspace, provider } = f;
    const scope = provider.createScope();
    const binding = scope.attachDocument(f.source.documentId);
    const tab = workspace.tabs.open({ kind: "text", documentId: f.source.documentId }, "source");
    const view = workspace.createDocumentView(f.source.documentId);
    const lifetime = new AbortController();
    const editor = {
        ...editorState(), workspace, view, tab: workspace.tabs.capture(tab), signal: lifetime.signal,
        element: { isConnected: true, ownerDocument: { defaultView: { setTimeout, clearTimeout } } },
        activity: () => ({ composing: false, pendingInput: false, pendingCommand: false }),
    } as unknown as TextEditor;
    t.after(() => {
        lifetime.abort();
        view.dispose();
        workspace.tabs.close(tab);
        scope.dispose();
    });
    f.peer.onRequest("test/barrier", () => null);
    await provider.connect();
    return {
        ...f, editor,
        flush: () => scope.request("test/barrier").result,
        synchronizedVersion: async () => {
            await scope.flush([binding]);
            return scope.synchronized(binding)!.version;
        },
        select: () => view.setSelection(f.document().revision, { anchor: 1, head: 1 }),
        replace: () => {
            lifetime.abort();
            view.dispose();
            workspace.tabs.replace(tab, { kind: "text", documentId: f.other.documentId });
        },
    };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function holdReply(f: Fixture, method: string, reply: unknown) {
    const received = latch<void>();
    const release = latch<void>();
    f.peer.onRequest(method, async () => {
        received.resolve();
        await release.promise;
        return reply;
    });
    return { received: received.promise, send: () => release.resolve() };
}

const sourceChanges = {
    selection: (f: Fixture) => f.select(),
    typing: (f: Fixture) => f.edit(),
    "tab replacement": (f: Fixture) => f.replace(),
};

for (const [cause, interrupt] of Object.entries(sourceChanges)) {
    test(`a delayed code action cannot edit its former source after ${cause}`, { timeout: 5000 }, async t => {
        const f = await fixture(t);
        const actions = createCodeActionController(f.editor, f.provider);
        const lazy = { title: "Replace word", data: { id: 1 } };
        const resolved = { ...lazy, edit: { changes: { "generic:source": [{ range, newText: "late" }] } } };
        f.peer.onRequest("textDocument/codeAction", () => [lazy]);
        const held = holdReply(f, "codeAction/resolve", resolved);
        const list = await actions.request();
        assert.equal(list.status, "done");
        assert.equal(list.value, actions.getSnapshot().choices);
        const choice = list.value[0];
        assert.ok(choice?.needsResolve);
        choice.select(() => true);
        await held.received;
        interrupt(f);
        if (cause === "typing") {
            const { id, revision } = f.document();
            assert.ok(f.workspace.undo({ documentId: id, expectedRevision: revision }).applied);
        }
        await settled();
        const source = f.document();
        assert.equal(f.sent("$/cancelRequest").length, 1);
        held.send();
        await f.flush();
        assert.equal(actions.getSnapshot().preview, null);
        assert.equal(f.document(), source);
    });

    test(`a delayed rename cannot offer an edit after ${cause}`, { timeout: 5000 }, async t => {
        const f = await fixture(t);
        const rename = createRenameController(f.editor, f.provider);
        const edit = { changes: { "generic:source": [{ range, newText: "replacement" }] } };
        const held = holdReply(f, "textDocument/rename", edit);
        const pending = rename.request("replacement");
        await held.received;
        interrupt(f);
        assert.deepEqual(await pending, { status: "stale" });
        assert.equal(f.sent("$/cancelRequest").length, 1);
        const source = f.document();
        held.send();
        await f.flush();
        assert.equal(rename.getSnapshot().preview, null);
        assert.equal(f.document(), source);
    });
}

test("code action discovery settles before a cancelled or superseded provider replies", { timeout: 5000 }, async t => {
    const f = await fixture(t);
    let available = false;
    const actions = createCodeActionController(f.editor, f.provider, { canCapture: () => available });
    assert.deepEqual(await actions.request(), { status: "refused", reason: "unavailable-view" });
    available = true;
    const held = holdReply(f, "textDocument/codeAction", [{ title: "Retired" }]);
    const previous = actions.request();
    await held.received;
    const next = holdReply(f, "textDocument/codeAction", [{ title: "Also retired" }]);
    const pending = actions.request();
    assert.deepEqual(await previous, { status: "stale" });
    await next.received;
    actions.cancel();
    assert.deepEqual(await pending, { status: "stale" });
    f.peer.onRequest("textDocument/codeAction", () => []);
    assert.deepEqual(await actions.request(), { status: "done", value: [] });
    const ready = actions.getSnapshot();
    held.send();
    next.send();
    await f.flush();
    assert.equal(actions.getSnapshot(), ready);
    f.peer.onRequest("textDocument/codeAction", () => { throw new ResponseError(-32801, "Content changed"); });
    assert.deepEqual(await actions.request(), { status: "stale" });
    f.peer.onRequest("textDocument/codeAction", () => { throw new Error("Discovery failed"); });
    const failure = await actions.request();
    assert.equal(failure.status, "failed");
    assert.ok(failure.error instanceof Error);
    assert.match(failure.error.message, /Discovery failed/);
});

test("a rename request returns its preview, refusal or provider error", async t => {
    const f = await fixture(t);
    const rename = createRenameController(f.editor, f.provider);
    assert.deepEqual(await rename.request(""), { status: "refused", reason: "empty-name" });
    assert.equal(f.sent("textDocument/rename").length, 0);
    const before = f.document();
    f.peer.onRequest("textDocument/rename", () => {
        throw new Error("Rename provider failed");
    });
    const failure = await rename.request("next");
    assert.equal(failure.status, "failed");
    assert.ok(failure.error instanceof Error);
    assert.match(failure.error.message, /Rename provider failed/);
    assert.equal(rename.getSnapshot().status, "failed");
    f.peer.onRequest("textDocument/rename", () => { throw new ResponseError(-32801, "Content changed"); });
    assert.deepEqual(await rename.request("next"), { status: "stale" });
    const held = holdReply(f, "textDocument/rename", null);
    const previous = rename.request("earlier");
    await held.received;
    f.peer.onRequest("textDocument/rename", () => ({ changes: { "generic:source": [{ range, newText: "next" }] } }));
    const latest = rename.request("next");
    assert.deepEqual(await previous, { status: "stale" });
    held.send();
    const done = await latest;
    assert.equal(done.status, "done");
    assert.equal(done.value, rename.getSnapshot().preview);
    assert.equal(done.value.count, 1);
    assert.equal(f.document(), before);
    assert.deepEqual(done.value.confirm(), { applied: true });
    assert.equal(f.document().buffer.slice(0, 4), "next");
});

for (const method of ["textDocument/codeAction", "textDocument/rename", "textDocument/documentColor", "textDocument/colorPresentation"] as const) {
    test(`a ${method} deadline settles during host preparation and releases its capture`, { timeout: 5000 }, async t => {
        const f = await fixture(t);
        const started = latch<void>();
        const finish = latch<void>();
        const clock = f.editor.element.ownerDocument.defaultView!;
        let deadline: (() => void) | undefined;
        t.mock.method(clock, "setTimeout", (callback: () => void) => { deadline = callback; return 1; });
        t.mock.method(clock, "clearTimeout", () => { deadline = undefined; });
        const prepare = async () => {
            started.resolve();
            await finish.promise;
        };
        const before = f.workspace.diagnostics().leases;
        const controller = method === "textDocument/codeAction" ? createCodeActionController(f.editor, f.provider, { prepareRequest: prepare })
            : method === "textDocument/rename" ? createRenameController(f.editor, f.provider, { prepareRequest: () => prepare })
            : createDocumentColorController(f.editor, f.provider, {
                prepareRequest: kind => (kind === "discovery") === (method === "textDocument/documentColor") ? prepare : undefined,
            });
        if ("setName" in controller) controller.setName("next");
        const run = async () => {
            if (method !== "textDocument/colorPresentation" || !("dismissPreview" in controller)) return controller.request();
            const color = { red: 1, green: 0, blue: 0, alpha: 1 };
            f.peer.onRequest("textDocument/documentColor", () => [{ range, color }]);
            const items = await controller.request();
            assert.equal(items.status, "done");
            return items.value[0]!.preview(color);
        };
        try {
            const pending = run();
            await started.promise;
            assert.ok(deadline);
            deadline();
            const result = await pending;
            assert.equal(result.status, "failed");
            assert.ok(result.error instanceof Error);
            assert.match(result.error.message, /timed out/);
            assert.equal(controller.getSnapshot().status, "failed");
            assert.equal(f.workspace.diagnostics().leases, before);
        } finally {
            finish.resolve();
        }
        await f.flush();
        assert.equal(f.sent(method).length, 0);
    });
}

test("rename rejects an obsolete project capture before sending it to the provider", async t => {
    const f = await fixture(t);
    const other = f.workspace.document(f.other.documentId);
    const rename = createRenameController(f.editor, f.provider, { documents: () => [other] });
    f.workspace.edit({ documentId: other.id, expectedRevision: other.revision,
        edits: [{ from: 0, to: 0, insert: "new " }], origin: "human" });
    assert.deepEqual(await rename.request("next"), { status: "stale" });
    assert.equal(rename.getSnapshot().status, "expired");
    assert.equal(f.sent("textDocument/rename").length, 0);
});

const colorChanges = {
    ...sourceChanges,
    "edit authority": (f: Fixture) => f.workspace.acquireEditLease(f.source.id, "test", "host").release(),
};
for (const [cause, interrupt] of Object.entries(colorChanges)) {
    test(`a delayed color presentation loses its edit target after ${cause}`, { timeout: 5000 }, async t => {
        const f = await fixture(t);
        const colors = createDocumentColorController(f.editor, f.provider);
        const red = { red: 1, green: 0, blue: 0, alpha: 1 };
        const presentation = [{ label: "red", textEdit: { range, newText: "#f00" } }];
        f.peer.onRequest("textDocument/documentColor", () => [{ range, color: red }]);
        f.peer.onRequest("textDocument/colorPresentation", () => presentation);
        const list = await colors.request();
        assert.equal(list.status, "done");
        assert.equal(list.value, colors.getSnapshot().colors);
        const reference = list.value[0];
        assert.ok(reference);
        const choices = await reference.preview(red);
        assert.equal(choices.status, "done");
        const oldReview = choices.value[0]?.select();
        assert.equal(oldReview, colors.getSnapshot().review);
        assert.ok(oldReview?.canApply);

        const held = holdReply(f, "textDocument/colorPresentation", presentation);
        const pending = reference.preview(red);
        await held.received;
        interrupt(f);
        await settled();
        const source = f.document();
        const other = f.workspace.document(f.other.documentId);
        assert.equal(f.sent("$/cancelRequest").length, 1);
        assert.deepEqual(await pending, { status: "stale" });
        held.send();
        await f.flush();
        assert.equal(colors.getSnapshot().review, null);
        assert.deepEqual(oldReview.apply(), { applied: false, reason: "expired" });
        assert.equal(f.document(), source);
        assert.equal(f.workspace.document(other.id), other);
    });
}

test("color choices belong to the presentation request that returned them", { timeout: 5000 }, async t => {
    const f = await fixture(t);
    const colors = createDocumentColorController(f.editor, f.provider);
    const red = { red: 1, green: 0, blue: 0, alpha: 1 };
    f.peer.onRequest("textDocument/documentColor", () => [{ range, color: red }]);
    const list = await colors.request();
    assert.equal(list.status, "done");
    const item = list.value[0]!;
    f.peer.onRequest("textDocument/colorPresentation", () => [{ label: "first" }]);
    const first = await item.preview(red);
    assert.equal(first.status, "done");
    const held = holdReply(f, "textDocument/colorPresentation", [{ label: "late" }]);
    const superseded = item.preview(red);
    await held.received;
    f.peer.onRequest("textDocument/colorPresentation", () => []);
    const empty = await item.preview(red);
    assert.equal(empty.status, "done");
    assert.deepEqual(empty.value, []);
    assert.equal(empty.value, colors.getSnapshot().presentations);
    assert.deepEqual(await superseded, { status: "stale" });
    f.peer.onRequest("textDocument/colorPresentation", () => [{ label: "#f00" }, { label: "red" }]);
    const current = await item.preview(red);
    assert.equal(current.status, "done");
    const review = current.value[1]?.select();
    assert.ok(review);
    held.send();
    await f.flush();
    assert.equal(first.value[0]?.select(), undefined);
    assert.deepEqual(await item.preview({ ...red, alpha: 2 }), { status: "refused", reason: "invalid-color" });
    assert.equal(review, colors.getSnapshot().review);
    const before = f.document();
    assert.deepEqual(review.apply(), { applied: true });
    assert.equal(f.document().buffer.slice(0, 3), "red");
    assert.ok(f.workspace.undo({ documentId: before.id, expectedRevision: f.document().revision }).applied);
    assert.equal(f.document().buffer.text(), before.buffer.text());
});

const linkChanges = {
    ...sourceChanges,
    "target edit": (f: Fixture) => {
        const target = f.workspace.document(f.other.documentId);
        f.workspace.edit({ documentId: target.id, expectedRevision: target.revision, origin: "host",
            edits: [{ from: 0, to: 0, insert: "new " }] });
    },
    "target edit authority": (f: Fixture) => f.workspace.acquireEditLease(f.other.id, "test", "host").release(),
};
for (const [cause, interrupt] of Object.entries(linkChanges)) {
    test(`a delayed link reply leaves no destination after ${cause}`, { timeout: 5000 }, async t => {
        const f = await fixture(t);
        const links = createDocumentLinkController(f.editor, f.provider, {
            documents: () => [f.workspace.document(f.other.documentId)],
        });
        const answer = [{ range, target: "generic:other" }];
        const held = holdReply(f, "textDocument/documentLink", answer);
        const pending = links.request();
        await held.received;
        interrupt(f);
        assert.deepEqual(await pending, { status: "stale" });
        assert.equal(f.sent("$/cancelRequest").length, 1);
        held.send();
        await f.flush();
        assert.deepEqual(links.getSnapshot().links, []);
        assert.equal(links.linkAt(1), undefined);
    });
}

test("a captured link cannot open a replacement at the same range", { timeout: 5000 }, async t => {
    const f = await fixture(t);
    const links = createDocumentLinkController(f.editor, f.provider);
    const lazy = { range, data: 1 };
    f.peer.onRequest("textDocument/documentLink", () => [lazy]);
    const first = await links.request();
    assert.equal(first.status, "done");
    const original = first.value[0]!;
    const visits: string[] = [];
    const visit = (uri: string) => { visits.push(uri); };
    const held = holdReply(f, "documentLink/resolve", { ...lazy, target: "generic:old" });
    const opening = original.open(visit);
    await held.received;
    assert.deepEqual(await original.open(visit), { status: "refused", reason: "resolving" });

    f.peer.onRequest("textDocument/documentLink", () => [{ range, target: "generic:new" }]);
    const next = await links.request();
    assert.equal(next.status, "done");
    assert.equal(next.value, links.getSnapshot().links);
    assert.deepEqual(await opening, { status: "stale" });
    assert.deepEqual(await original.open(visit), { status: "stale" });
    held.send();
    await f.flush();
    assert.deepEqual(visits, []);
    assert.deepEqual(await next.value[0]!.open(visit), { status: "done", value: "generic:new" });
    assert.deepEqual(visits, ["generic:new"]);
});

test("a diagnostic tracks its text through an edit and a fresh push replaces the selectable range", async t => {
    const f = await fixture(t);
    const layers = createDecorationLayers(f.document, () => {}, () => !f.editor.signal.aborted);
    const reveals: Parameters<TextEditor["reveal"]>[] = [];
    const editor: TextEditor = {
        ...f.editor,
        decorations: layers.handle,
        reveal: (range, options) => {
            reveals.push([range, options]);
            return "from" in range ? range : null;
        },
    };
    const before = f.provider.snapshot();
    const language = attachEditorLanguage(editor, f.provider, { diagnostics: {}, hover: {} });
    const controller = language.diagnostics;
    t.after(() => { language.dispose(); layers.dispose(); });
    const marks = () => {
        const doc = f.document();
        const line = { documentId: doc.id, revision: doc.revision, line: 0, lineStart: 0,
            from: 0, to: doc.buffer.length, text: doc.text() };
        return layers.present(line).map(({ from, to, className }) => ({ from, to, className }));
    };
    async function publish(message: string, from: number, to: number,
        metadata: { source?: string; severity?: number; code?: number; tags?: number[] } = {}) {
        f.peer.sendNotification("textDocument/publishDiagnostics", {
            uri: "generic:source", version: await f.synchronizedVersion(),
            diagnostics: [{ message, ...metadata, range: { start: { line: 0, character: from }, end: { line: 0, character: to } } }],
        });
        await f.flush();
    }
    const metadata = { severity: 2, code: 0, source: "example", tags: [2, 97] };
    await publish("Check beta", 6, 10, metadata);
    const original = controller.getSnapshot().diagnostics[0]!;
    const warning = "st-diagnostic st-diagnostic-warning st-deprecated";
    assert.deepEqual(marks(), [{ from: 6, to: 10, className: warning }]);
    assert.ok(language.hover.request({ revision: f.document().revision, offset: 7 }));
    await settled();
    assert.match(language.hover.getSnapshot().text, /Check beta/);
    assert.equal(f.provider.snapshot().scopes, before.scopes + 1);
    assert.equal(f.provider.snapshot().documentParticipants, before.documentParticipants + 1);
    assert.ok(f.edit().applied);
    await f.flush();
    const pending = controller.getSnapshot();
    assert.ok(pending.diagnosticsPending);
    assert.equal(original.select(), false);
    assert.deepEqual(marks(), [{ from: 13, to: 17, className: warning }]);
    const mapped = pending.diagnostics[0]!;
    assert.deepEqual({ severity: mapped.severity, code: mapped.code, source: mapped.source, tags: mapped.tags }, metadata);
    assert.ok(Object.isFrozen(mapped.tags));
    assert.ok(mapped.select());
    await publish("Check alpha", 7, 12);
    const fresh = controller.getSnapshot();
    assert.equal(fresh.diagnosticsPending, false);
    assert.equal(mapped.select(), false);
    assert.equal(fresh.diagnostics[0]!.message, "Check alpha");
    assert.ok(fresh.diagnostics[0]!.select());
    const options = { expectedRevision: f.document().revision, select: true, focus: true };
    assert.deepEqual(reveals, [[{ from: 13, to: 17 }, options], [{ from: 7, to: 12 }, options]]);
    assert.deepEqual(marks(), [{ from: 7, to: 12, className: "st-diagnostic st-diagnostic-error" }]);
    f.replace();
    assert.equal(fresh.diagnostics[0]!.select(), false);
    assert.deepEqual(marks(), []);
    assert.equal(f.provider.snapshot().scopes, before.scopes);
});
