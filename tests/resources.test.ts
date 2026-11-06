import { test } from "node:test";
import assert from "node:assert/strict";
import { Workspace, WorkspaceCommands } from "../src/index.ts";
import type { SaveResponse, SaveSubmission } from "../src/index.ts";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function fixture() {
    const workspace = new Workspace();
    const source = workspace.createTextResource({ scope: "scope", resource: "source", variant: "working" }, "Same label", { value: "abc", serverVersion: "v0" });
    const form = workspace.createResource<{ path: string; nested: { enabled: boolean } }>({ scope: "scope", resource: "configuration", variant: "working" }, "Same label", { value: { path: "in.csv", nested: { enabled: true } }, serverVersion: "c0" });
    const tab = workspace.open({ kind: "text", documentId: source.documentId }, "left");
    const edit = (text: string, origin: "human" | "agent" | "host" = "human") => workspace.edit({ documentId: source.documentId,
        expectedRevision: workspace.document(source.documentId).revision, origin,
        edits: [{ from: 0, to: workspace.document(source.documentId).text.length, insert: text }] });
    return { workspace, source, form, tab, edit };
}

test("typed resources need no document, isolate scopes/variants and expose immutable content", () => {
    const { workspace, form } = fixture();
    workspace.open({ kind: "panel", resourceId: form.id, panelType: "configuration" }, "right");
    assert.equal(workspace.getSnapshot().documents.length, 1);
    const value = { path: "other.csv", nested: { enabled: false } };
    workspace.updateResource(form, { expectedRevision: 0, value, origin: "human" });
    value.nested.enabled = true;
    const state = form.getSnapshot();
    assert.ok(state.state === "ready");
    assert.equal(state.value.nested.enabled, false);
    assert.throws(() => { Object.assign(state.value.nested, { enabled: true }); }, TypeError);
    assert.equal(state.metadata.dirty, true);
    assert.throws(() => workspace.createResource(state.metadata.key, "Duplicate"));
    workspace.createResource({ ...state.metadata.key, scope: "other" }, "Same label");
    workspace.createResource({ ...state.metadata.key, variant: "history" }, "Same label");
    const foreign = new Workspace();
    assert.deepEqual(foreign.updateResource(form, { expectedRevision: 1, value, origin: "host" }), { applied: false, reason: "missing-resource" });
    assert.equal(foreign.resolveResource(workspace.captureResource(form.id)), undefined);
});

test("a non-text panel traverses load failure, retry, ownership and release without allocating a buffer", () => {
    const workspace = new Workspace();
    const form = workspace.createResource<{ path: string }>({ scope: "probe", resource: "form", variant: "working" }, "Form");
    const tab = workspace.open({ kind: "panel", resourceId: form.id, panelType: "form" }, "left");
    const first = workspace.beginLoad(form);
    workspace.move(tab, "right"); assert.equal(first.fail("Temporary failure"), true);
    assert.equal(form.getSnapshot().state, "failed"); assert.equal(workspace.getSnapshot().documents.length, 0);
    const retry = workspace.beginLoad(form), value = { path: "loaded.csv" };
    workspace.close(tab); assert.throws(() => workspace.releaseResource(form.id));
    assert.equal(retry.accept({ value, serverVersion: "f1" }), true);
    value.path = "later host mutation";
    const ready = form.getSnapshot(); assert.ok(ready.state === "ready"); assert.equal(ready.value.path, "loaded.csv");
    assert.equal(workspace.getSnapshot().documents.length, 0);
    workspace.releaseResource(form.id); assert.equal(form.getSnapshot().state, "released");
});

test("loads distinguish readiness, ignore superseded responses and retain cancelled ownership until settlement", () => {
    const workspace = new Workspace();
    const handle = workspace.createTextResource({ scope: "probe", resource: "loading", variant: "working" }, "Loading");
    const tab = workspace.open({ kind: "text", documentId: handle.documentId }, "left");
    assert.equal(handle.getSnapshot().state, "loading");
    assert.throws(() => workspace.document(handle.documentId));
    assert.equal(workspace.edit({ documentId: handle.documentId, expectedRevision: 0, origin: "human", edits: [] }).applied, false);
    const first = workspace.beginLoad(handle), second = workspace.beginLoad(handle);
    workspace.move(tab, "right"); workspace.close(tab);
    assert.equal(first.isCancelled(), true);
    assert.throws(() => workspace.releaseResource(handle.id));
    assert.equal(second.fail("Synthetic failure"), true);
    assert.equal(handle.getSnapshot().state, "failed");
    const retry = workspace.beginLoad(handle);
    const reopened = workspace.open({ kind: "text", documentId: handle.documentId }, "right");
    assert.equal(retry.accept({ value: "ready", serverVersion: "v1" }), true);
    assert.equal(first.accept({ value: "stale", serverVersion: "old" }), false);
    assert.equal(workspace.document(handle.documentId).text, "ready");
    assert.equal(workspace.ownership(handle.id).leases, 0);
    const target = workspace.captureResource(handle.id);
    workspace.close(reopened); workspace.releaseResource(handle.id);
    assert.equal(handle.getSnapshot().state, "released");
    assert.equal(workspace.resolveResource(target), undefined);
    const fresh = workspace.createTextResource({ scope: "probe", resource: "loading", variant: "working" }, "Fresh", { value: "new" });
    assert.notEqual(fresh.id, handle.id);
});

test("scoped subscriptions keep unrelated handles and metadata stable, deliver despite errors and reject reentrant writes", () => {
    const errors: unknown[] = [], workspace = new Workspace({ onListenerError: error => { errors.push(error); throw new Error("Reporter failed"); } });
    const source = workspace.createTextResource({ scope: "probe", resource: "source", variant: "working" }, "Source", { value: "a" });
    const form = workspace.createResource({ scope: "probe", resource: "form", variant: "working" }, "Form", { value: { field: "one" } });
    const write = (insert: string) => workspace.edit({ documentId: source.documentId, expectedRevision: workspace.document(source.documentId).revision,
        origin: "human", edits: [{ from: 0, to: 1, insert }] });
    write("b"); // Make dirty before measuring unchanged metadata.
    const meta = source.metadata.getSnapshot(), formSnapshot = form.getSnapshot(), tabs = workspace.tabState.getSnapshot();
    let formCalls = 0, metadataCalls = 0, delivered = 0;
    form.subscribe(() => formCalls++); source.metadata.subscribe(() => metadataCalls++);
    const observations: string[] = [];
    source.subscribe(() => { observations.push(workspace.document(source.documentId).text); throw new Error("Listener failed"); });
    source.subscribe(() => { write("illegal"); });
    const unsubscribe = source.subscribe(() => { delivered++; observations.push(workspace.document(source.documentId).text); });
    write("c");
    assert.deepEqual(observations, ["c", "c"]);
    assert.equal(errors.length, 2);
    assert.equal(delivered, 1); assert.equal(formCalls, 0); assert.equal(metadataCalls, 0);
    assert.equal(source.metadata.getSnapshot(), meta); assert.equal(form.getSnapshot(), formSnapshot); assert.equal(workspace.tabState.getSnapshot(), tabs);
    unsubscribe(); write("d"); assert.equal(delivered, 1);
    assert.equal(workspace.document(source.documentId).text, "d");
});

test("dirty close confirmations capture generations/revisions and hold ownership after closure", () => {
    const { workspace, source, form, tab, edit } = fixture();
    edit("dirty");
    const first = workspace.beginClose(tab);
    workspace.move(tab, "right"); edit("newer");
    assert.equal(first.complete("close"), false);
    assert.ok(workspace.resolveTab(workspace.captureTab(tab)));
    const second = workspace.beginClose(tab);
    workspace.replace(tab, { kind: "panel", resourceId: form.id, panelType: "form" });
    assert.equal(second.complete("close"), false);
    workspace.replace(tab, { kind: "text", documentId: source.documentId });
    const third = workspace.beginClose(tab);
    workspace.close(tab);
    assert.throws(() => workspace.releaseResource(source.id, true));
    assert.equal(third.complete("close"), false);
    assert.throws(() => workspace.releaseResource(source.id));
    workspace.releaseResource(source.id, true);
    assert.equal(source.getSnapshot().state, "released");
});

test("capabilities reject all edit origins and prevent stale refresh from erasing local work", () => {
    const { workspace, source, edit } = fixture();
    workspace.setCapabilities(source.id, { edit: [], save: false, run: false });
    for (const origin of ["human", "agent", "host"] as const) assert.deepEqual(edit("blocked", origin), { applied: false, reason: "read-only" });
    assert.throws(() => workspace.captureSave(source));
    workspace.setCapabilities(source.id, { edit: ["human"], save: true, run: true });
    edit("new work");
    assert.throws(() => workspace.beginLoad(source));
    assert.equal(workspace.document(source.documentId).text, "new work");
});

test("two queued saves capture exact contents; canonical replies and close/reopen never overwrite later typing", async () => {
    const { workspace, source, tab, edit } = fixture();
    const commands = new WorkspaceCommands(workspace), responses = [deferred<SaveResponse<string>>(), deferred<SaveResponse<string>>()];
    const calls: SaveSubmission<string>[] = [];
    const port = { save: (submission: SaveSubmission<string>) => { calls.push(submission); return responses[calls.length - 1]!.promise; } };
    edit("first"); const first = commands.save(source, port);
    edit("second"); const second = commands.save(source, port);
    edit("human correction"); workspace.move(tab, "right"); workspace.close(tab);
    assert.throws(() => workspace.releaseResource(source.id, true));
    assert.throws(() => workspace.beginLoad(source));
    await Promise.resolve(); assert.equal(calls.length, 1); assert.equal(calls[0]!.value, "first");
    responses[0]!.resolve({ kind: "saved", serverVersion: "v1", canonical: "FIRST" });
    const receipt = await first;
    assert.equal(receipt.kind, "saved");
    if (receipt.kind === "saved") { assert.equal(receipt.receipt.submission.revision, 1); assert.equal(receipt.receipt.canonicalApplied, false); }
    await Promise.resolve();
    assert.equal(calls.length, 2); assert.equal(calls[1]!.value, "second"); assert.equal(calls[1]!.expectedServerVersion, "v1");
    workspace.open({ kind: "text", documentId: source.documentId }, "left");
    responses[1]!.resolve({ kind: "saved", serverVersion: "v2" }); await second;
    assert.equal(workspace.document(source.documentId).text, "human correction");
    assert.equal(source.metadata.getSnapshot().dirty, true); assert.equal(source.metadata.getSnapshot().serverVersion, "v2");
    edit("second"); assert.equal(source.metadata.getSnapshot().dirty, false);
    assert.equal(workspace.ownership(source.id).leases, 0);
});

test("canonical saves apply only without later edits or a revoked edit capability; failures/conflicts preserve the baseline", async () => {
    const { workspace, source, edit } = fixture();
    const errors: unknown[] = [], commands = new WorkspaceCommands(workspace, error => errors.push(error));
    edit("local");
    const saved = await commands.save(source, { save: async () => ({ kind: "saved", serverVersion: "v1", canonical: "LOCAL" }) });
    assert.equal(saved.kind, "saved"); assert.equal(workspace.document(source.documentId).text, "LOCAL"); assert.equal(source.metadata.getSnapshot().dirty, false);
    edit("retry");
    const conflict = await commands.save(source, { save: async () => ({ kind: "conflict", serverVersion: "remote" }) });
    assert.equal(conflict.kind, "conflict"); assert.equal(source.metadata.getSnapshot().saveStatus, "conflict"); assert.equal(source.metadata.getSnapshot().serverVersion, "v1");
    const failed = await commands.save(source, { save: async () => { throw new Error("Synthetic transport failure"); } });
    assert.equal(failed.kind, "failed"); assert.equal(errors.length, 1); assert.equal(workspace.ownership(source.id).leases, 0);
    const response = deferred<SaveResponse<string>>();
    const pending = commands.save(source, { save: () => response.promise }); await Promise.resolve();
    workspace.setCapabilities(source.id, { edit: [], save: true, run: true });
    response.resolve({ kind: "saved", serverVersion: "v2", canonical: "RETRY" }); await pending;
    assert.equal(workspace.document(source.documentId).text, "retry"); assert.equal(source.metadata.getSnapshot().dirty, true);
});

test("Run captures source/configuration/settings before awaiting and retains both resources without saving", async () => {
    const { workspace, source, form, tab, edit } = fixture();
    const commands = new WorkspaceCommands(workspace), result = deferred<string>(), settings = { mode: "preview" };
    let captured: unknown;
    const run = commands.run(source, form, settings, { run: submission => { captured = submission; return result.promise; } });
    settings.mode = "changed"; edit("after run");
    workspace.updateResource(form, { expectedRevision: 0, origin: "human", value: { path: "new.csv", nested: { enabled: false } } });
    workspace.close(tab);
    assert.throws(() => workspace.releaseResource(source.id, true)); assert.throws(() => workspace.releaseResource(form.id, true));
    assert.deepEqual(JSON.parse(JSON.stringify(captured)), { source: { target: { id: source.id }, key: source.metadata.getSnapshot().key,
        revision: 0, value: "abc", serverVersion: "v0" }, configuration: { target: { id: form.id }, key: form.metadata.getSnapshot().key,
        revision: 0, value: { path: "in.csv", nested: { enabled: true } }, serverVersion: "c0" }, settings: { mode: "preview" } });
    result.resolve("run-id"); assert.equal(await run, "run-id");
    assert.equal(source.metadata.getSnapshot().serverVersion, "v0"); assert.equal(form.metadata.getSnapshot().serverVersion, "c0");
    assert.equal(workspace.ownership(source.id).leases, 0); assert.equal(workspace.ownership(form.id).leases, 0);
});

test("invalid host values publish nothing and mismatched operation presentations acquire no ownership", () => {
    const { workspace, source, form, tab } = fixture();
    const before = form.getSnapshot();
    const cycle: { self?: unknown } = {}; cycle.self = cycle;
    for (const value of [cycle, new Date(), { callback: () => {} }, { get field() { throw new Error("Accessor must not execute"); } }, [Number.NaN]]) {
        assert.throws(() => workspace.updateResource(form, { expectedRevision: 0, origin: "host", value: value as never }));
        assert.equal(form.getSnapshot(), before);
    }
    assert.throws(() => workspace.beginOperation(form.id, "preview", workspace.captureTab(tab)));
    assert.equal(workspace.ownership(form.id).leases, 0);
    const operation = workspace.beginOperation(source.id, "preview", workspace.captureTab(tab));
    workspace.move(tab, "right"); assert.equal(operation.presentationCurrent(), true);
    workspace.replace(tab, { kind: "panel", resourceId: form.id, panelType: "form" });
    assert.equal(operation.isCurrent(), true); assert.equal(operation.presentationCurrent(), false);
    operation.cancel(); assert.equal(operation.isCurrent(), false);
    assert.equal(workspace.ownership(source.id).leases, 1);
    operation.finish(); operation.finish(); assert.equal(workspace.ownership(source.id).leases, 0);
});

test("save permission is rechecked before queued submission, and host error recovery retains the document", async () => {
    const { workspace, source, edit } = fixture();
    let calls = 0, errors = 0;
    const commands = new WorkspaceCommands(workspace, () => { errors++; edit("host recovery"); throw new Error("Reporter failure"); });
    edit("unsaved");
    const pending = commands.save(source, { save: async () => { calls++; return { kind: "saved", serverVersion: "unexpected" }; } });
    workspace.setCapabilities(source.id, { edit: ["human", "host"], save: false, run: true });
    assert.equal((await pending).kind, "failed"); assert.equal(calls, 0); assert.equal(errors, 1);
    assert.equal(workspace.document(source.documentId).text, "host recovery");
    assert.equal(source.metadata.getSnapshot().serverVersion, "v0"); assert.equal(workspace.ownership(source.id).leases, 0);
    workspace.setCapabilities(source.id, { edit: ["human", "host"], save: true, run: true });
    const retry = await commands.save(source, { save: async () => ({ kind: "saved", serverVersion: "v1" }) });
    assert.equal(retry.kind, "saved"); assert.equal(source.metadata.getSnapshot().dirty, false);
});

test("subscription diagnostics count independent registrations even after a resource is released", () => {
    const workspace = new Workspace();
    const form = workspace.createResource({ scope: "fixture", resource: "form", variant: "working" }, "Form", { value: { path: "x" } });
    let calls = 0; const listener = () => { calls++; };
    const first = form.subscribe(listener), second = form.subscribe(listener);
    assert.equal(workspace.diagnostics().subscriptions, 2);
    workspace.releaseResource(form.id); assert.equal(calls, 2); assert.equal(workspace.diagnostics().subscriptions, 2);
    first(); first(); assert.equal(workspace.diagnostics().subscriptions, 1);
    second(); assert.equal(workspace.diagnostics().subscriptions, 0);
});
