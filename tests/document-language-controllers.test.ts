import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { attachEditorLanguage, type TextEditor } from "../src/browser/index.ts";
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
    const tab = workspace.tabs.open({ kind: "text", documentId: f.source.documentId });
    const view = workspace.createDocumentView(f.source.documentId);
    const lifetime = new AbortController();
    const editor = {
        ...editorState(), workspace, view, tab: workspace.tabs.capture(tab), signal: lifetime.signal,
        element: { isConnected: true, ownerDocument: { defaultView: { setTimeout, clearTimeout } } },
        viewport: { revealOffset() {} }, focus() {},
        activity: () => ({ input: "idle" }),
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
        const actions = attachEditorLanguage(f.editor, f.provider, { codeActions: {} }).codeActions;
        const scopes = f.provider.snapshot().scopes;
        const lazy = { title: "Replace word", data: { id: 1 } };
        const resolved = { ...lazy, edit: { changes: { "generic:source": [{ range, newText: "late" }] } } };
        f.peer.onRequest("textDocument/codeAction", () => [lazy]);
        const held = holdReply(f, "codeAction/resolve", resolved);
        const list = await actions.request();
        assert.equal(list.status, "done");
        assert.equal(list.value, actions.getSnapshot().choices);
        const choice = list.value[0];
        assert.ok(choice?.needsResolve);
        const selected = choice.select();
        await held.received;
        assert.equal(f.provider.snapshot().scopes, scopes);
        interrupt(f);
        if (cause === "typing") {
            const { id, revision } = f.document();
            assert.ok(f.workspace.undo({ documentId: id, expectedRevision: revision }).applied);
        }
        assert.deepEqual(await selected, { status: "stale" });
        const source = f.document();
        assert.equal(f.sent("$/cancelRequest").length, 1);
        held.send();
        await f.flush();
        assert.equal(actions.getSnapshot().preview, null);
        assert.equal(f.document(), source);
    });

    const review = cause === "typing";
    test(`a delayed rename ${review ? "preview" : "edit"} expires after ${cause}`, { timeout: 5000 }, async t => {
        const f = await fixture(t);
        const rename = attachEditorLanguage(f.editor, f.provider, { rename: {} }).rename;
        const edit = { changes: { "generic:source": [{ range, newText: "replacement" }] } };
        const held = holdReply(f, "textDocument/rename", edit);
        const pending = rename.request("replacement", { review });
        await held.received;
        interrupt(f);
        assert.deepEqual(await pending, { status: "stale" });
        assert.equal(f.sent("$/cancelRequest").length, 1);
        const source = f.document();
        held.send();
        await f.flush();
        assert.equal(rename.getSnapshot().preview, null);
        assert.equal(f.document(), source);
        if (review) {
            assert.equal(f.sent("textDocument/prepareRename").length, 0);
            assert.equal(source.buffer.slice(0, source.buffer.length), "prefix alpha beta");
        }
    });
}

test("a direct selection supersedes a pending review and applies the single resolved edit", { timeout: 5000 }, async t => {
    const f = await fixture(t);
    const { codeActions } = attachEditorLanguage(f.editor, f.provider, { codeActions: {} });
    const lazy = { title: "Change word", data: 1 };
    f.peer.onRequest("textDocument/codeAction", () => [lazy]);
    const replacement = { range: { ...range, end: { line: 0, character: 5 } }, newText: "gamma" };
    const held = holdReply(f, "codeAction/resolve", { ...lazy, edit: { changes: { "generic:source": [replacement] } } });
    const choices = await codeActions.request();
    assert.equal(choices.status, "done");
    const choice = choices.value[0]!;
    const review = choice.select({ review: true });
    await held.received;
    const direct = choice.select();
    assert.deepEqual(await review, { status: "stale" });
    assert.equal(f.document().buffer.text(), "alpha beta");
    held.send();
    assert.deepEqual(await direct, { status: "done", value: [{ document: f.document().id, title: f.document().title }] });
    assert.equal(f.document().buffer.text(), "gamma beta");
    assert.equal(f.sent("codeAction/resolve").length, 1);
});

test("code action discovery settles before a cancelled or superseded provider replies", { timeout: 5000 }, async t => {
    const f = await fixture(t);
    let available = false;
    const actions = attachEditorLanguage(f.editor, f.provider, { codeActions: { canCapture: () => available } }).codeActions;
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
    const rename = attachEditorLanguage(f.editor, f.provider, { rename: {} }).rename;
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
    f.peer.onRequest("textDocument/rename", () => null);
    const empty = await rename.request("next", { review: true });
    assert.equal(empty.status, "done");
    assert.deepEqual(empty.value.apply(), { status: "refused", reason: "no-changes" });
    const held = holdReply(f, "textDocument/rename", null);
    const previous = rename.request("earlier");
    await held.received;
    f.peer.onRequest("textDocument/rename", () => ({ changes: { "generic:source": [{ range, newText: "next" }] } }));
    const latest = rename.request("next", { review: true });
    assert.deepEqual(await previous, { status: "stale" });
    held.send();
    const done = await latest;
    assert.equal(done.status, "done");
    assert.equal(done.value, rename.getSnapshot().preview);
    assert.deepEqual(done.value.readEdits(0, 0), { total: 1, notes: [] });
    assert.equal(f.document(), before);
    assert.deepEqual(done.value.apply(), { status: "done", value: [{ document: before.id, title: before.title }] });
    assert.equal(f.document().buffer.slice(0, 4), "next");
});

test("a rename preview expires when its attachment closes or the provider disconnects", async t => {
    const f = await fixture(t);
    const source = f.document();
    f.peer.onRequest("textDocument/rename", () => ({ changes: { "generic:source": [{ range, newText: "next" }] } }));
    const attach = () => attachEditorLanguage(f.editor, f.provider, { rename: {} });
    const original = attach();
    const first = await original.rename.request("next", { review: true });
    assert.equal(first.status, "done");
    assert.equal(first.value.canApply, true);
    original.dispose();

    const replacement = attach();
    const second = await replacement.rename.request("next", { review: true });
    assert.equal(second.status, "done");
    assert.deepEqual(first.value.apply(), { status: "stale" });
    assert.equal(first.value.readEdits(0, 1), undefined);
    assert.equal(second.value.readEdits(0, 1)?.total, 1);

    f.provider.disconnect();
    assert.deepEqual(second.value.apply(), { status: "stale" });
    assert.equal(second.value.readEdits(0, 1), undefined);
    assert.equal(f.document(), source);
});

test("direct rename applies its whole project in one undo step or refuses it", async t => {
    const f = await fixture(t);
    const other = () => f.workspace.document(f.other.documentId);
    const { rename } = attachEditorLanguage(f.editor, f.provider, { rename: { documents: () => [other()] } });
    let previews = 0;
    rename.subscribe(() => { if (rename.getSnapshot().preview) previews++; });
    const before = [f.document(), other()];
    const replacement = { range, newText: "next" };
    f.peer.onRequest("textDocument/rename", () => ({
        changes: { "generic:source": [replacement], "generic:other": [replacement] }
    }));
    f.workspace.setCapabilities(f.other.id, { edit: ["host"], save: true });
    assert.deepEqual(await rename.request("next"), { status: "refused", reason: "not-writable" });
    assert.deepEqual([f.document().buffer, other().buffer], before.map(doc => doc.buffer));
    f.workspace.setCapabilities(f.other.id, { edit: ["host", "human"], save: true });
    const result = await rename.request("next");
    assert.equal(result.status, "done");
    assert.deepEqual(result.value, before.map(({ id, title }) => ({ document: id, title })));
    assert.equal(result.value, rename.getSnapshot().changes);
    assert.deepEqual([f.document(), other()].map(doc => doc.buffer.slice(0, 4)), ["next", "next"]);
    assert.deepEqual(await rename.request("next"), { status: "refused", reason: "no-changes" });
    assert.equal(previews, 0);
    assert.ok(f.workspace.undo({ documentId: other().id, expectedRevision: other().revision }).applied);
    assert.deepEqual([f.document(), other()].map(doc => doc.buffer.text()), before.map(doc => doc.buffer.text()));
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
        const controller = method === "textDocument/codeAction" ? attachEditorLanguage(f.editor, f.provider, { codeActions: { prepareRequest: prepare } }).codeActions
            : method === "textDocument/rename" ? attachEditorLanguage(f.editor, f.provider, { rename: { prepareRequest: () => prepare } }).rename
            : attachEditorLanguage(f.editor, f.provider, { colors: {
                prepareRequest: kind => (kind === "discovery") === (method === "textDocument/documentColor") ? prepare : undefined,
            } }).colors;
        const run = async () => {
            if (!("dismissPreview" in controller)) return controller.request("next");
            if (method === "textDocument/documentColor") return controller.request();
            const color = { red: 1, green: 0, blue: 0, alpha: 1 };
            f.peer.onRequest("textDocument/documentColor", () => [{ range, color }]);
            const items = await controller.request();
            assert.equal(items.status, "done");
            return items.value[0]!.presentations(color);
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

test("requests expire an obsolete project capture before contacting the provider", async t => {
    const f = await fixture(t);
    const other = f.workspace.document(f.other.documentId);
    const project = { documents: () => [other] };
    const { rename, links, codeActions } = attachEditorLanguage(f.editor, f.provider, {
        rename: project, links: project, codeActions: project,
    });
    f.workspace.edit({ documentId: other.id, expectedRevision: other.revision,
        edits: [{ from: 0, to: 0, insert: "new " }], origin: "human" });
    assert.deepEqual(await rename.request("next"), { status: "stale" });
    assert.equal(rename.getSnapshot().status, "expired");
    assert.equal(f.sent("textDocument/rename").length, 0);
    assert.deepEqual(await links.request(), { status: "stale" });
    assert.equal(links.getSnapshot().status, "expired");
    assert.equal(f.sent("textDocument/documentLink").length, 0);
    assert.deepEqual(await codeActions.request(), { status: "stale" });
    assert.equal(codeActions.getSnapshot().status, "expired");
    assert.equal(f.sent("textDocument/codeAction").length, 0);
});

const colorChanges = {
    ...sourceChanges,
    "edit authority": (f: Fixture) => f.workspace.setCapabilities(f.source.id, { edit: [], save: true }),
};
for (const [cause, interrupt] of Object.entries(colorChanges)) {
    test(`a delayed color presentation loses its edit target after ${cause}`, { timeout: 5000 }, async t => {
        const f = await fixture(t);
        const { colors } = attachEditorLanguage(f.editor, f.provider, { colors: {} });
        const red = { red: 1, green: 0, blue: 0, alpha: 1 };
        const presentation = [{ label: "red", textEdit: { range, newText: "#f00" } }];
        f.peer.onRequest("textDocument/documentColor", () => [{ range, color: red }]);
        f.peer.onRequest("textDocument/colorPresentation", () => presentation);
        const list = await colors.request();
        assert.equal(list.status, "done");
        assert.equal(list.value, colors.getSnapshot().colors);
        const reference = list.value[0];
        assert.ok(reference);
        const choices = await reference.presentations(red);
        assert.equal(choices.status, "done");
        const oldReview = choices.value[0]!.select({ review: true });
        assert.equal(oldReview.status, "done");
        assert.equal(oldReview.value, colors.getSnapshot().review);
        assert.ok(oldReview.value.canApply);

        const held = holdReply(f, "textDocument/colorPresentation", presentation);
        const pending = reference.presentations(red);
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
        assert.deepEqual(oldReview.value.apply(), { status: "stale" });
        assert.deepEqual(choices.value[0]!.select(), { status: "stale" });
        assert.equal(f.document(), source);
        assert.equal(f.workspace.document(other.id), other);
    });
}

test("color choices belong to the presentation request that returned them", { timeout: 5000 }, async t => {
    const f = await fixture(t);
    const language = attachEditorLanguage(f.editor, f.provider, { colors: {}, hover: {} });
    const { colors } = language;
    const attached = f.provider.snapshot();
    const red = { red: 1, green: 0, blue: 0, alpha: 1 };
    f.peer.onRequest("textDocument/documentColor", () => [{ range, color: red }]);
    const list = await colors.request();
    assert.equal(list.status, "done");
    const item = list.value[0]!;
    f.peer.onRequest("textDocument/colorPresentation", () => [{ label: "first" }]);
    const first = await item.presentations(red);
    assert.equal(first.status, "done");
    assert.equal(f.provider.snapshot().scopes, attached.scopes);
    assert.equal(f.provider.snapshot().documentParticipants, attached.documentParticipants);
    const held = holdReply(f, "textDocument/colorPresentation", [{ label: "late" }]);
    const superseded = item.presentations(red);
    await held.received;
    f.peer.onRequest("textDocument/colorPresentation", () => []);
    const empty = await item.presentations(red);
    assert.equal(empty.status, "done");
    assert.deepEqual(empty.value, []);
    assert.equal(empty.value, colors.getSnapshot().presentations);
    assert.deepEqual(await superseded, { status: "stale" });
    f.peer.onRequest("textDocument/colorPresentation", () => [{ label: "#f00" }, { label: "red" }]);
    const current = await item.presentations(red);
    assert.equal(current.status, "done");
    assert.equal(colors.getSnapshot().review, null);
    const review = current.value[0]!.select({ review: true });
    assert.equal(review.status, "done");
    held.send();
    await f.flush();
    assert.deepEqual(first.value[0]!.select(), { status: "stale" });
    assert.deepEqual(await item.presentations({ ...red, alpha: 2 }), { status: "refused", reason: "invalid-color" });
    assert.equal(review.value, colors.getSnapshot().review);
    const before = f.document();
    assert.deepEqual(current.value[1]!.select(), { status: "done", value: [{ document: before.id, title: before.title }] });
    assert.deepEqual(review.value.apply(), { status: "stale" });
    assert.equal(f.document().buffer.slice(0, 3), "red");
    assert.ok(f.workspace.undo({ documentId: before.id, expectedRevision: f.document().revision }).applied);
    assert.equal(f.document().buffer.text(), before.buffer.text());
    language.dispose();
});

test("a second pane takes over a shared color scan when the first pane closes", { timeout: 5000 }, async t => {
    const f = await fixture(t);
    const method = "textDocument/documentColor";
    const red = { red: 1, green: 0, blue: 0, alpha: 1 };
    const green = { ...red, red: 0, green: 1 };
    const old = holdReply(f, method, [{ range, color: red }]);
    const painted = latch<void>();
    const initial = f.provider.snapshot().scopes;
    const secondView = f.workspace.createDocumentView(f.source.documentId);
    const firstLayers = createDecorationLayers(f.document, () => {}, () => true);
    const secondLayers = createDecorationLayers(f.document, () => painted.resolve(), () => true);
    const first = attachEditorLanguage({ ...f.editor, decorations: firstLayers.handle }, f.provider, { colors: { swatches: true } });
    const second = attachEditorLanguage({ ...f.editor, view: secondView, decorations: secondLayers.handle }, f.provider, { colors: { swatches: true } });
    try {
        await old.received;
        f.select();
        second.colors.cancel();
        assert.equal(f.sent(method).length, 1);
        assert.equal(f.provider.snapshot().scopes, initial + 2);
        f.peer.onRequest(method, () => [{ range, color: green }]);
        first.dispose();
        await painted.promise;
        old.send();
        await f.flush();
        assert.equal(f.sent(method).length, 2);
        assert.deepEqual(second.colors.colorAt(1)?.color, green);
        assert.equal(second.colors.colorAt(0.5), undefined);
        assert.equal(first.colors.colorAt(1), undefined);
    } finally {
        old.send();
        first.dispose();
        second.dispose();
        firstLayers.dispose();
        secondLayers.dispose();
        secondView.dispose();
    }
    assert.equal(f.provider.snapshot().scopes, initial);
});

test("a painted link resolves on its clicked pane after the scanning pane closes", { timeout: 5000 }, async t => {
    const f = await fixture(t);
    const lazy = { range, data: { token: "original" } };
    const method = "textDocument/documentLink";
    const scan = holdReply(f, method, [lazy]);
    const painted = latch<void>();
    const sibling = f.workspace.createDocumentView(f.source.documentId);
    const a = createDecorationLayers(f.document, () => {}, () => true);
    const b = createDecorationLayers(f.document, () => painted.resolve(), () => true);
    const initial = f.provider.snapshot().scopes;
    const first = attachEditorLanguage({ ...f.editor, decorations: a.handle }, f.provider, { links: { paint: true } });
    const second = attachEditorLanguage({ ...f.editor, view: sibling, decorations: b.handle }, f.provider, { links: { paint: true } });
    try {
        await scan.received;
        f.select();
        scan.send();
        await painted.promise;
        const choice = second.links.linkAt(1)!;
        assert.equal(choice, second.links.linkAt(2));
        const held = holdReply(f, "documentLink/resolve", { ...lazy, target: "generic:accepted" });
        const visits: string[] = [];
        const open = choice.open(uri => visits.push(uri));
        await held.received;
        first.dispose();
        held.send();
        assert.deepEqual(await open, { status: "done", value: "generic:accepted" });
        assert.equal(f.sent(method).length, 1);
        assert.equal(f.provider.snapshot().scopes, initial + 1);
        const replaced = holdReply(f, "documentLink/resolve", { ...lazy, target: "generic:late" });
        const late = choice.open(uri => visits.push(uri));
        await replaced.received;
        f.edit();
        replaced.send();
        assert.deepEqual(await late, { status: "stale" });
        assert.deepEqual(await choice.open(uri => visits.push(uri)), { status: "stale" });
        assert.deepEqual(visits, ["generic:accepted"]);
    } finally {
        scan.send();
        first.dispose();
        second.dispose();
        a.dispose();
        b.dispose();
        sibling.dispose();
    }
    assert.equal(f.provider.snapshot().scopes, initial);
});

const linkChanges = {
    ...sourceChanges,
    "target edit": (f: Fixture) => {
        const target = f.workspace.document(f.other.documentId);
        f.workspace.edit({ documentId: target.id, expectedRevision: target.revision, origin: "host",
            edits: [{ from: 0, to: 0, insert: "new " }] });
    },
    "target edit authority": (f: Fixture) => f.workspace.setCapabilities(f.other.id, { edit: [], save: true }),
};
for (const [cause, interrupt] of Object.entries(linkChanges)) {
    test(`a delayed link reply leaves no destination after ${cause}`, { timeout: 5000 }, async t => {
        const f = await fixture(t);
        const { links } = attachEditorLanguage(f.editor, f.provider, { links: {
            documents: () => [f.workspace.document(f.other.documentId)],
        } });
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
    const { links } = attachEditorLanguage(f.editor, f.provider, { links: {} });
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

test("cancelling while collecting link targets releases the project and permits a fresh lookup", async t => {
    const f = await fixture(t);
    let cancel = true;
    const { links } = attachEditorLanguage(f.editor, f.provider, { links: {
        documents() {
            if (cancel) links.cancel();
            return [f.workspace.document(f.other.documentId)];
        },
    } });
    f.peer.onRequest("textDocument/documentLink", () => [{ range, target: "generic:other" }]);
    const leases = f.workspace.diagnostics().leases;
    assert.deepEqual(await links.request(), { status: "stale" });
    assert.equal(f.workspace.diagnostics().leases, leases);
    assert.equal(links.getSnapshot().status, "idle");
    assert.equal(f.sent("textDocument/documentLink").length, 0);
    cancel = false;
    const next = await links.request();
    assert.equal(next.status, "done");
    assert.equal(next.value[0]?.target, "generic:other");
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
    const lookup = holdReply(f, "textDocument/hover", { contents: "Symbol documentation" });
    const request = language.hover.request({ revision: f.document().revision, offset: 7 });
    await lookup.received;
    assert.equal(language.hover.getSnapshot().text, "Check beta");
    lookup.send();
    const hover = await request;
    assert.equal(hover.status, "done");
    assert.equal(hover.value.text, "Check beta\n\nSymbol documentation");
    f.peer.onRequest("textDocument/hover", () => { throw new Error("Symbol provider unavailable"); });
    assert.equal((await language.hover.request({ revision: f.document().revision, offset: 7 })).status, "failed");
    assert.equal(language.hover.getSnapshot().text, "Check beta");
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
