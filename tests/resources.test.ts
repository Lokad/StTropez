import { runWithResources, type RunSettings } from "./fixtures/hosts/run-command.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { TextBuffer, Workspace } from "../src/index.ts";
import { HostSaveQueue } from "./fixtures/save-queue.ts";
import type { SaveSubmission } from "../src/index.ts";
import type { SaveResponse } from "./fixtures/save-queue.ts";

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
    const edit = (text: string, origin: "human" | "agent" | "host" = "human") => workspace.edit({ documentId: source.id,
        expectedRevision: workspace.document(source.id).revision, origin,
        edits: [{ from: 0, to: workspace.document(source.id).text().length, insert: text }] });
    return { workspace, source, form, edit };
}

test("typed resources need no document, isolate scopes/variants and expose immutable content", () => {
    const { workspace, form } = fixture();

    assert.equal(workspace.getSnapshot().documents.length, 1);
    const value = { path: "other.csv", nested: { enabled: false } };
    workspace.updateResource(form, { expectedRevision: 0, value, origin: "human" });
    value.nested.enabled = true;
    const state = form.getSnapshot();
    assert.ok(state.state === "ready");
    assert.equal(state.value().nested.enabled, false);
    assert.throws(() => { Object.assign(state.value().nested, { enabled: true }); }, TypeError);
    const read = state.value, captured = read();
    JSON.stringify(state); assert.equal(({ ...state }).value(), captured);
    workspace.updateResource(form, { expectedRevision: 1, value: { path: "latest.csv", nested: { enabled: true } }, origin: "human" });
    assert.equal(read(), captured); assert.equal(read().path, "other.csv");
    assert.equal(state.metadata.dirty, true);
    assert.throws(() => workspace.createResource(state.metadata.key, "Duplicate"));
    workspace.createResource({ ...state.metadata.key, scope: "other" }, "Same label");
    workspace.createResource({ ...state.metadata.key, variant: "history" }, "Same label");
    const foreign = new Workspace();
    assert.deepEqual(foreign.updateResource(form, { expectedRevision: 1, value, origin: "host" }), { applied: false, reason: "missing-resource" });
    assert.equal(foreign.resolveResource(workspace.captureResource(form.id)), undefined);
});

test("typed resource equality preserves no-op identity and compares independently copied saved values", () => {
    const workspace = new Workspace(), shared = { number: -0 };
    const form = workspace.createResource({ scope: "test", resource: "equality", variant: "working" }, "Form",
        { value: { left: shared, right: shared }, serverVersion: "v0" });
    const initial = form.getSnapshot(); assert.ok(initial.state === "ready");
    shared.number = 1;
    assert.ok(Object.is(initial.value().left.number, -0)); assert.ok(Object.is(initial.value().right.number, -0));
    const seen: { revision: number; dirty: boolean }[] = [];
    const stop = form.subscribe(() => { const state = form.getSnapshot(); seen.push({ revision: state.revision, dirty: state.metadata.dirty }); });
    try {
        // Key order and aliasing in the caller's graph are not resource changes.
        assert.deepEqual(workspace.updateResource(form, { expectedRevision: 0, origin: "human",
            value: { right: { number: -0 }, left: { number: -0 } } }), { applied: true, revision: 0 });
        assert.equal(form.getSnapshot(), initial); assert.deepEqual(seen, []);
        assert.deepEqual(workspace.updateResource(form, { expectedRevision: 0, origin: "human",
            value: { left: { number: -0 }, right: { number: 0 } } }), { applied: true, revision: 1 });
        assert.deepEqual(seen, [{ revision: 1, dirty: true }]);
        assert.deepEqual(workspace.updateResource(form, { expectedRevision: 1, origin: "human",
            value: { right: { number: -0 }, left: { number: -0 } } }), { applied: true, revision: 2 });
        assert.deepEqual(seen, [{ revision: 1, dirty: true }, { revision: 2, dirty: false }]);
        assert.equal(form.metadata.getSnapshot().serverVersion, "v0");
        assert.equal(workspace.ownership(form.id).leases, 0);
    } finally { stop(); }
});

test("typed array snapshots reject accessors without invoking code or publishing partial state", () => {
    const workspace = new Workspace(), key = { scope: "test", resource: "array", variant: "working" };
    const handle = workspace.createResource({ ...key, resource: "existing" }, "Array", { value: { rows: [1, 2] } });
    const before = handle.getSnapshot(), inventory = workspace.getSnapshot();
    let calls = 0, publications = 0;
    const stop = handle.subscribe(() => publications++);
    const accessor = Object.defineProperty([0], "0", { get() { calls++; return 42; } });
    const inherited = new Array<number>(1);
    Object.setPrototypeOf(inherited, Object.create(Array.prototype, { "0": { get() { calls++; return 42; } } }));
    try {
        for (const rows of [accessor, inherited, new Array<number>(1)]) {
            assert.throws(() => workspace.createResource(key, "Invalid", { value: { rows } }), TypeError);
            assert.throws(() => workspace.updateResource(handle, { expectedRevision: 0, origin: "human", value: { rows } }), TypeError);
            assert.equal(calls, 0); assert.equal(publications, 0);
            assert.equal(handle.getSnapshot(), before); assert.equal(workspace.getSnapshot(), inventory);
        }
        // Snapshot array elements, without consulting a host-defined iteration hook.
        const rows = Object.defineProperty([3, 4], Symbol.iterator, { get() { calls++; throw new Error("Iterator must not run"); } });
        const valid = workspace.createResource(key, "Valid", { value: { rows } }).getSnapshot();
        assert.ok(valid.state === "ready"); rows[0] = 99;
        assert.deepEqual(valid.value().rows, [3, 4]); assert.ok(Object.isFrozen(valid.value().rows)); assert.equal(calls, 0);
    } finally { stop(); }
});

test("internal resources keep captured ownership while workspace inventories contain only host resources", async () => {
    const { workspace, source, form } = fixture(), before = workspace.getSnapshot();
    const options = { visibility: "internal" as const }, buffer = TextBuffer.from("immutable reference");
    const reference = workspace.createTextResource({ scope: "test", resource: "reference", variant: "one" }, "Reference",
        { value: buffer, capabilities: { edit: [], save: false }, ...options });
    const scratch = workspace.createTextResource({ scope: "test", resource: "scratch", variant: "one" }, "Scratch", {
        value: "x",
        ...options,
    });
    const panel = workspace.createResource({ scope: "test", resource: "panel", variant: "one" }, "Panel", { value: { count: 0 } }, undefined, options);
            const resourceTarget = workspace.captureResource(reference.id);
    const inventory = workspace.getSnapshot();
    assert.deepEqual(inventory.resources.map(resource => resource.id), [source.id, form.id]);
    assert.deepEqual(inventory.documents.map(document => document.id), [source.id]);
    assert.equal(before.resources.length, 2);
    assert.equal(reference.metadata.getSnapshot().visibility, "internal");
    assert.equal(workspace.resolveResource(resourceTarget), reference);
    assert.equal(workspace.document(reference.id).buffer, buffer);
    assert.equal(workspace.edit({ documentId: reference.id, expectedRevision: 0, edits: [{ from: 0, to: 0, insert: "x" }], origin: "human" }).applied, false);
    // Inventory visibility is independent of permissions and text/value mutation.
    assert.equal(workspace.edit({ documentId: scratch.id, expectedRevision: 0, edits: [{ from: 0, to: 1, insert: "y" }], origin: "human" }).applied, true);
    assert.equal(workspace.updateResource(panel, { expectedRevision: 0, value: { count: 1 }, origin: "human" }).applied, true);
    assert.equal(panel.metadata.getSnapshot().visibility, "internal");
    const view = workspace.createDocumentView(reference.id), lease = workspace.acquire(reference.id);
    workspace.releaseResourceWhenUnowned(reference.id);
    await Promise.resolve(); assert.equal(reference.getSnapshot().state, "ready");
    lease.release(); await Promise.resolve(); assert.equal(reference.getSnapshot().state, "ready");
    view.dispose(); await Promise.resolve(); assert.equal(reference.getSnapshot().state, "released");
    assert.equal(workspace.resolveResource(resourceTarget), undefined);
    workspace.releaseResource(panel.id, true); workspace.releaseResource(scratch.id, true);
    assert.deepEqual(workspace.getSnapshot().resources.map(resource => resource.id), [source.id, form.id]);
    assert.equal(workspace.diagnostics().resources, 2);
});

test("a value resource traverses load failure, retry, ownership and release without allocating a buffer", () => {
    const workspace = new Workspace();
    const form = workspace.createResource<{ path: string }>({ scope: "probe", resource: "form", variant: "working" }, "Form");
    const first = workspace.beginLoad(form);
    assert.equal(first.fail("Temporary failure"), true);
    assert.equal(form.getSnapshot().state, "failed"); assert.equal(workspace.getSnapshot().documents.length, 0);
    workspace.beginLoad(form).dispose();
    assert.equal(form.metadata.getSnapshot().failure, "Temporary failure");
    const retry = workspace.beginLoad(form), value = { path: "loaded.csv" };
    assert.throws(() => workspace.releaseResource(form.id));
    assert.equal(retry.accept({ value, serverVersion: "f1" }), true);
    value.path = "later host mutation";
    const ready = form.getSnapshot(); assert.ok(ready.state === "ready"); assert.equal(ready.value().path, "loaded.csv");
    assert.equal(workspace.getSnapshot().documents.length, 0);
    const ordinary = workspace.acquire(form.id), protectedWork = workspace.acquire(form.id, { preventReload: true });
    assert.throws(() => workspace.beginLoad(form)); protectedWork.release(); protectedWork.release();
    const refresh = workspace.beginLoad(form); refresh.accept({ value: { path: "refreshed.csv" } });
    assert.equal(workspace.ownership(form.id).leases, 1); ordinary.release();
    workspace.releaseResource(form.id); assert.equal(form.getSnapshot().state, "released");
});

test("resource keys retain exact component identity through failed creation and release", () => {
    const workspace = new Workspace(), foreign = new Workspace();
    const keys = [
        { scope: "a:b", resource: "c", variant: "d" }, { scope: "a", resource: "b:c", variant: "d" },
        { scope: "a", resource: "b", variant: "c:d" }, { scope: "a\0b", resource: "c", variant: "d" },
        { scope: "a", resource: "b\0c", variant: "d" }, { scope: "", resource: "", variant: "" },
        { scope: "__proto__", resource: '["x", "y"]', variant: "\ud800" },
        { scope: "__proto__", resource: '["x", "y"]', variant: "\ufffd" },
    ];
    for (const key of keys) {
        const handle = workspace.createResource(key, "Panel", { value: 0 });
        assert.throws(() => workspace.createTextResource({ ...key }, "Duplicate", { value: "" }), /already exists/);
        foreign.createTextResource(key, "Independent", { value: "" });
        assert.deepEqual(handle.metadata.getSnapshot().key, key);
    }
    const key = { scope: "lifecycle", resource: "item", variant: "working" }, before = workspace.getSnapshot();
    assert.throws(() => workspace.createResource(key, "Bad value", { value: NaN }), TypeError);
    assert.equal(workspace.getSnapshot(), before);
    const handle = workspace.createResource(key, "Valid", { value: 0 }), capturedKey = { ...key }, target = workspace.captureResource(handle.id);
    key.resource = "mutated";
    assert.deepEqual(handle.metadata.getSnapshot().key, capturedKey); assert.ok(Object.isFrozen(handle.metadata.getSnapshot().key));
    const lease = workspace.acquire(handle.id);
    assert.throws(() => workspace.releaseResource(handle.id), /leases/); lease.release();
    workspace.updateResource(handle, { expectedRevision: 0, value: 1, origin: "human" });
    assert.throws(() => workspace.releaseResource(handle.id), /discard/);
    assert.throws(() => workspace.createResource(capturedKey, "Still owned"), /already exists/);
    workspace.releaseResource(handle.id, true);
    const replacement = workspace.createResource(capturedKey, "Replacement", { value: 2 });
    assert.notEqual(replacement.id, handle.id); assert.equal(workspace.resolveResource(target), undefined);
    assert.equal(handle.getSnapshot().state, "released");

    const generated = new Workspace();
    // The first panel consumes ID 1; the next generated variant must skip the host-owned "2".
    generated.createResource({ scope: "generated", resource: "item", variant: "2" }, "Host");
    const next = generated.createResourceKey("generated", "item"), later = generated.createResourceKey("generated", "item");
    assert.notEqual(next.variant, "2"); assert.notDeepEqual(next, later); assert.ok(Object.isFrozen(next));
    generated.createResource(next, "Generated");
});

test("resource-key allocation and duplicate checks do not traverse the workspace inventory", t => {
    const workspace = new Workspace();
    for (let i = 0; i < 1000; i++) workspace.createResource({ scope: "many", resource: String(i), variant: "panel" }, "Panel");
    const values = Map.prototype.values; let visits = 0;
    Map.prototype.values = function () {
        const iterator = values.call(this), next = iterator.next.bind(iterator);
        iterator.next = (...args) => { const item = next(...args); if (!item.done) visits++; return item; };
        return iterator;
    };
    try {
        const key = workspace.createResourceKey("many", "new"), allocation = visits; visits = 0;
        workspace.createResource(key, "New"); const creation = visits; visits = 0;
        assert.throws(() => workspace.createResource({ ...key }, "Duplicate"), /already exists/);
        const duplicate = visits;
        t.diagnostic(JSON.stringify({ allocation, creation, duplicate }));
        assert.deepEqual({ allocation, creation, duplicate }, { allocation: 0, creation: 0, duplicate: 0 });
    } finally { Map.prototype.values = values; }
});

test("loads distinguish readiness, ignore superseded responses and release ownership on disposal", () => {
    const workspace = new Workspace();
    const handle = workspace.createTextResource({ scope: "probe", resource: "loading", variant: "working" }, "Loading");
    assert.equal(handle.getSnapshot().state, "loading");
    assert.throws(() => workspace.document(handle.id));
    assert.equal(workspace.edit({ documentId: handle.id, expectedRevision: 0, origin: "human", edits: [] }).applied, false);
    const abandoned = workspace.beginLoad(handle); abandoned.dispose();
    assert.equal(handle.getSnapshot().state, "failed"); assert.ok(handle.metadata.getSnapshot().failure);
    abandoned.dispose(); assert.equal(workspace.ownership(handle.id).leases, 0);
    const first = workspace.beginLoad(handle), second = workspace.beginLoad(handle);

    assert.equal(workspace.ownership(handle.id).leases, 1);
    assert.throws(() => workspace.releaseResource(handle.id));
    assert.equal(second.fail("Synthetic failure"), true);
    assert.equal(handle.getSnapshot().state, "failed");
    const retry = workspace.beginLoad(handle);
    assert.equal(retry.accept({ value: "ready", serverVersion: "v1" }), true);
    assert.equal(first.accept({ value: "stale", serverVersion: "old" }), false);
    const interrupted = workspace.beginLoad(handle);
    assert.equal(interrupted.accept({ value: "older", get serverVersion() {
        workspace.beginLoad(handle).accept({ value: "ready", serverVersion: "v2" });
        return "v1";
    } }), false);
    assert.equal(handle.metadata.getSnapshot().serverVersion, "v2");
    assert.equal(workspace.document(handle.id).text(), "ready");
    assert.equal(workspace.ownership(handle.id).leases, 0);
    const target = workspace.captureResource(handle.id);
    workspace.releaseResource(handle.id);
    assert.equal(handle.getSnapshot().state, "released");
    assert.equal(workspace.resolveResource(target), undefined);
    const fresh = workspace.createTextResource({ scope: "probe", resource: "loading", variant: "working" }, "Fresh", { value: "new" });
    assert.notEqual(fresh.id, handle.id);
});

test("abandoning superseded refreshes restores the saved panel value with current permissions", () => {
    const { workspace, form } = fixture(), before = form.getSnapshot();
    assert.ok(before.state === "ready");
    const older = workspace.beginLoad(form), latest = workspace.beginLoad(form);
    older.dispose(); assert.equal(form.getSnapshot().state, "loading");
    workspace.setCapabilities(form.id, { edit: [], save: false });
    latest.dispose();
    const after = form.getSnapshot();
    assert.ok(after.state === "ready"); assert.equal(after.value, before.value);
    assert.equal(after.revision, before.revision); assert.equal(after.metadata.serverVersion, "c0");
    assert.deepEqual(after.metadata.capabilities, { edit: [], save: false });
    assert.equal(older.accept({ value: { path: "late", nested: { enabled: false } } }), false);
    assert.equal(workspace.ownership(form.id).leases, 0);
});

test("text reload resets every view's folds and selection at the accepted document revision", () => {
    const errors: unknown[] = [], workspace = new Workspace({ onListenerError: error => errors.push(error) }), initial = "header\nbody\nlast\n";
    const resource = workspace.createTextResource({ scope: "load", resource: "source", variant: "working" }, "Source", { value: initial });
    const views = [workspace.createDocumentView(resource.id), workspace.createDocumentView(resource.id)];
    const old = views.map(view => {
        view.setSelection(0, { anchor: initial.length, head: initial.length });
        view.folding.setRanges(view.folding.getSnapshot(), [{ id: "old", from: 0, to: initial.length, collapsed: true }]);
        return view.folding.getSnapshot();
    });
    let publications = 0;
    const stop = workspace.observeDocument(resource.id).subscribe(() => {
        const document = workspace.observeDocument(resource.id).getSnapshot(); if (!document) return;
        publications++;
        for (const view of views) {
            const folds = view.folding.getSnapshot();
            assert.equal(folds.revision, document.revision); assert.equal(folds.index.lineCount, document.buffer.lineCount);
            assert.deepEqual(folds.regions, []);
            assert.deepEqual(view.getSnapshot().selection, { anchor: 0, head: 0, anchorAffinity: "after", headAffinity: "after" });
        }
    });
    for (const value of ["", "a\nb\nc\nd\ne\n", "short"]) {
        assert.equal(workspace.beginLoad(resource).accept({ value }), true);
        const document = workspace.document(resource.id);
        for (const [i, view] of views.entries()) {
            const folds = view.folding.getSnapshot();
            assert.equal(folds.revision, document.revision); assert.equal(folds.generation, old[i]!.generation + document.revision);
            assert.equal(folds.index.lineCount, document.buffer.lineCount); assert.equal(folds.index.collapsedCount, 0);
            for (let row = 0; row < folds.index.visibleLineCount; row++) assert.doesNotThrow(() => document.buffer.offsetAt(folds.index.lineAt(row)));
            assert.equal(view.folding.setCollapsed(old[i]!, "old", false), false);
        }
    }
    assert.equal(publications, 3); assert.deepEqual(errors, []);
    stop(); views.forEach(view => view.dispose()); workspace.releaseResource(resource.id);
});

test("scoped subscriptions keep unrelated handles and metadata stable, deliver despite errors and reject reentrant writes", () => {
    const errors: unknown[] = [], workspace = new Workspace({ onListenerError: error => { errors.push(error); throw new Error("Reporter failed"); } });
    const source = workspace.createTextResource({ scope: "probe", resource: "source", variant: "working" }, "Source", { value: "a" });
    const form = workspace.createResource({ scope: "probe", resource: "form", variant: "working" }, "Form", { value: { field: "one" } });
    const write = (insert: string) => workspace.edit({ documentId: source.id, expectedRevision: workspace.document(source.id).revision,
        origin: "human", edits: [{ from: 0, to: 1, insert }] });
    write("b"); // Make dirty before measuring unchanged metadata.
    const meta = source.metadata.getSnapshot(), formSnapshot = form.getSnapshot();
    let formCalls = 0, metadataCalls = 0, delivered = 0;
    form.subscribe(() => formCalls++); source.metadata.subscribe(() => metadataCalls++);
    const observations: string[] = [];
    source.subscribe(() => { observations.push(workspace.document(source.id).text()); throw new Error("Listener failed"); });
    source.subscribe(() => { write("illegal"); });
    const unsubscribe = source.subscribe(() => { delivered++; observations.push(workspace.document(source.id).text()); });
    write("c");
    assert.deepEqual(observations, ["c", "c"]);
    assert.equal(errors.length, 2);
    assert.equal(delivered, 1); assert.equal(formCalls, 0); assert.equal(metadataCalls, 0);
    assert.equal(source.metadata.getSnapshot(), meta); assert.equal(form.getSnapshot(), formSnapshot);
    unsubscribe(); write("d"); assert.equal(delivered, 1);
    assert.equal(workspace.document(source.id).text(), "d");
});

test("deferred resource release follows final ownership and preserves later unsaved work", async () => {
    const workspace = new Workspace(), keys = [workspace.createResourceKey("test", "display"), workspace.createResourceKey("test", "display")];
    assert.notDeepEqual(keys[0], keys[1]); assert.ok(Object.isFrozen(keys[0]));
    const source = workspace.createTextResource(keys[0]!, "Reference", { value: "base" }), target = workspace.captureResource(source.id);
    const view = workspace.createDocumentView(source.id), lease = workspace.acquire(source.id);
    workspace.releaseResourceWhenUnowned(source.id); view.dispose(); await Promise.resolve();
    assert.equal(workspace.resolveResource(target), source); assert.equal(workspace.document(source.id).text(), "base");
    lease.release(); const replacementLease = workspace.acquire(source.id); await Promise.resolve();
    assert.equal(workspace.resolveResource(target), source); replacementLease.release(); await Promise.resolve();
    assert.equal(workspace.resolveResource(target), undefined); assert.equal(source.getSnapshot().state, "released"); lease.release();

    const observed = workspace.createTextResource(workspace.createResourceKey("test", "display"), "Observed", { value: "read" });
    const observedView = workspace.createDocumentView(observed.id);
    workspace.releaseResourceWhenUnowned(observed.id);
    const stop = workspace.subscribe(() => observedView.dispose());
    const trigger = workspace.createTextResource(workspace.createResourceKey("test", "trigger"), "Trigger", { value: "change" });
    stop(); await Promise.resolve(); assert.equal(observed.getSnapshot().state, "released"); workspace.releaseResource(trigger.id);

    const edited = workspace.createTextResource(keys[1]!, "Edited", { value: "base" }), held = workspace.acquire(edited.id), editedTarget = workspace.captureResource(edited.id);
    workspace.releaseResourceWhenUnowned(edited.id);
    workspace.edit({ documentId: edited.id, expectedRevision: 0, origin: "human", edits: [{ from: 0, to: 0, insert: "keep " }] });
    held.release(); await Promise.resolve(); assert.equal(workspace.resolveResource(editedTarget), edited);
    assert.equal(workspace.document(edited.id).text(), "keep base"); assert.throws(() => workspace.releaseResourceWhenUnowned(edited.id), /Explicit discard/);
    workspace.releaseResourceWhenUnowned(edited.id, true); assert.equal(edited.getSnapshot().state, "released");
    assert.equal(workspace.diagnostics().resources, 0); assert.equal(workspace.diagnostics().leases, 0);
});

test("capabilities reject all edit origins and prevent stale refresh from erasing local work", () => {
    const { workspace, source, edit } = fixture();
    workspace.setCapabilities(source.id, { edit: [], save: false });
    for (const origin of ["human", "agent", "host"] as const) assert.deepEqual(edit("blocked", origin), { applied: false, reason: "read-only" });
    assert.throws(() => workspace.captureSave(source));
    workspace.setCapabilities(source.id, { edit: ["human"], save: true });
    edit("new work");
    assert.throws(() => workspace.beginLoad(source));
    assert.equal(workspace.document(source.id).text(), "new work");
});

test("failing an unstarted save leaves the submitted write in control of its status", () => {
    const { workspace, source, edit } = fixture();
    edit("unsaved");
    const writing = workspace.captureSave(source);
    const queued = workspace.captureSave(source);
    writing.start();
    assert.throws(() => queued.start());
    queued.fail();
    assert.equal(source.metadata.getSnapshot().saveStatus, "saving");
    writing.conflict();
    writing.finish();
    assert.throws(() => queued.start());
    queued.finish();
    assert.equal(source.metadata.getSnapshot().saveStatus, "conflict");
    assert.equal(source.metadata.getSnapshot().serverVersion, "v0");
    assert.equal(workspace.document(source.id).text(), "unsaved");
});

test("two queued saves capture exact contents; canonical replies preserve later typing", async () => {
    const { workspace, source, edit } = fixture();
    const commands = new HostSaveQueue(workspace), responses = [deferred<SaveResponse<string>>(), deferred<SaveResponse<string>>()];
    const calls: SaveSubmission<string>[] = [];
    const port = { save: (submission: SaveSubmission<string>) => { calls.push(submission); return responses[calls.length - 1]!.promise; } };
    edit("first"); const first = commands.save(workspace.captureSave(source), port);
    edit("second"); const second = commands.save(workspace.captureSave(source), port);
    edit("human correction");
    assert.throws(() => workspace.releaseResource(source.id, true));
    assert.throws(() => workspace.beginLoad(source));
    await Promise.resolve(); assert.equal(calls.length, 1); assert.equal(calls[0]!.value, "first");
    responses[0]!.resolve({ kind: "saved", serverVersion: "v1", canonical: "FIRST" });
    const receipt = await first;
    assert.equal(receipt.kind, "saved");
    if (receipt.kind === "saved") { assert.equal(receipt.receipt.submission.revision, 1); assert.equal(receipt.receipt.canonicalApplied, false); }
    await Promise.resolve();
    assert.equal(calls.length, 2); assert.equal(calls[1]!.value, "second"); assert.equal(calls[1]!.expectedServerVersion, "v1");

    responses[1]!.resolve({ kind: "saved", serverVersion: "v2" }); await second;
    assert.equal(workspace.document(source.id).text(), "human correction");
    assert.equal(source.metadata.getSnapshot().dirty, true); assert.equal(source.metadata.getSnapshot().serverVersion, "v2");
    edit("second"); assert.equal(source.metadata.getSnapshot().dirty, false);
    assert.equal(workspace.ownership(source.id).leases, 0);
});

test("canonical saves apply only without later edits or a revoked edit capability; failures/conflicts preserve the baseline", async () => {
    const { workspace, source, edit } = fixture();
    const errors: unknown[] = [], commands = new HostSaveQueue(workspace, error => errors.push(error));
    edit("local");
    const saved = await commands.save(workspace.captureSave(source), { save: async () => ({ kind: "saved", serverVersion: "v1", canonical: "LOCAL" }) });
    assert.equal(saved.kind, "saved"); assert.equal(workspace.document(source.id).text(), "LOCAL"); assert.equal(source.metadata.getSnapshot().dirty, false);
    edit("retry");
    const conflict = await commands.save(workspace.captureSave(source), { save: async () => ({ kind: "conflict", serverVersion: "remote" }) });
    assert.equal(conflict.kind, "conflict"); assert.equal(source.metadata.getSnapshot().saveStatus, "conflict"); assert.equal(source.metadata.getSnapshot().serverVersion, "v1");
    const failed = await commands.save(workspace.captureSave(source), { save: async () => { throw new Error("Synthetic transport failure"); } });
    assert.equal(failed.kind, "failed"); assert.equal(errors.length, 1); assert.equal(workspace.ownership(source.id).leases, 0);
    const response = deferred<SaveResponse<string>>();
    const pending = commands.save(workspace.captureSave(source), { save: () => response.promise }); await Promise.resolve();
    workspace.setCapabilities(source.id, { edit: [], save: true });
    response.resolve({ kind: "saved", serverVersion: "v2", canonical: "RETRY" }); await pending;
    assert.equal(workspace.document(source.id).text(), "retry"); assert.equal(source.metadata.getSnapshot().dirty, true);
});

test("Run captures source/configuration/settings before awaiting and retains both resources without saving", async () => {
    const { workspace, source, form, edit } = fixture();
    const result = deferred<string>(), settings: { mode: RunSettings["mode"] } = { mode: "preview" };
    let captured: unknown;
    const run = runWithResources(workspace, source, form, settings, submission => { captured = submission; return result.promise; });
    settings.mode = "inspect"; edit("after run");
    workspace.updateResource(form, { expectedRevision: 0, origin: "human", value: { path: "new.csv", nested: { enabled: false } } });

    assert.throws(() => workspace.releaseResource(source.id, true)); assert.throws(() => workspace.releaseResource(form.id, true));
    assert.deepEqual(JSON.parse(JSON.stringify(captured)), { source: { target: { id: source.id }, key: source.metadata.getSnapshot().key,
        revision: 0, value: "abc", serverVersion: "v0" }, configuration: { target: { id: form.id }, key: form.metadata.getSnapshot().key,
        revision: 0, value: { path: "in.csv", nested: { enabled: true } }, serverVersion: "c0" }, settings: { mode: "preview" } });
    result.resolve("run-id"); assert.equal(await run, "run-id");
    assert.equal(source.metadata.getSnapshot().serverVersion, "v0"); assert.equal(form.metadata.getSnapshot().serverVersion, "c0");
    assert.equal(workspace.ownership(source.id).leases, 0); assert.equal(workspace.ownership(form.id).leases, 0);
});

test("invalid host values publish nothing", () => {
    const { workspace, form } = fixture();
    const before = form.getSnapshot();
    const cycle: { self?: unknown } = {}; cycle.self = cycle;
    for (const value of [cycle, new Date(), { callback: () => {} }, { get field() { throw new Error("Accessor must not execute"); } }, [Number.NaN]]) {
        assert.throws(() => workspace.updateResource(form, { expectedRevision: 0, origin: "host", value: value as never }));
        assert.equal(form.getSnapshot(), before);
    }
});

test("save permission is rechecked before queued submission, and host error recovery retains the document", async () => {
    const { workspace, source, edit } = fixture();
    let calls = 0, errors = 0;
    const commands = new HostSaveQueue(workspace, () => { errors++; edit("host recovery"); throw new Error("Reporter failure"); });
    edit("unsaved");
    const pending = commands.save(workspace.captureSave(source), { save: async () => { calls++; return { kind: "saved", serverVersion: "unexpected" }; } });
    workspace.setCapabilities(source.id, { edit: ["human", "host"], save: false });
    assert.equal((await pending).kind, "failed"); assert.equal(calls, 0); assert.equal(errors, 1);
    assert.equal(workspace.document(source.id).text(), "host recovery");
    assert.equal(source.metadata.getSnapshot().serverVersion, "v0"); assert.equal(workspace.ownership(source.id).leases, 0);
    workspace.setCapabilities(source.id, { edit: ["human", "host"], save: true });
    const retry = await commands.save(workspace.captureSave(source), { save: async () => ({ kind: "saved", serverVersion: "v1" }) });
    assert.equal(retry.kind, "saved"); assert.equal(source.metadata.getSnapshot().dirty, false);
});

test("subscription diagnostics count independent registrations even after a resource is released", () => {
    const workspace = new Workspace();
    const form = workspace.createResource({ scope: "fixture", resource: "form", variant: "working" }, "Form", { value: { path: "x" } });
    let calls = 0; const listener = () => { calls++; };
    const first = form.subscribe(listener), second = form.subscribe(listener);
    assert.equal(workspace.diagnostics().subscriptions, 2);
    assert.equal(workspace.updateResource(form, { expectedRevision: 0, value: { path: "y" }, origin: "human" }).applied, true);
    assert.equal(calls, 1);
    first(); first(); assert.equal(workspace.diagnostics().subscriptions, 1);
    assert.equal(workspace.updateResource(form, { expectedRevision: 1, value: { path: "z" }, origin: "human" }).applied, true);
    assert.equal(calls, 2); const third = form.subscribe(listener);
    workspace.releaseResource(form.id, true); assert.equal(calls, 3); assert.equal(workspace.diagnostics().subscriptions, 2);
    second(); second(); assert.equal(workspace.diagnostics().subscriptions, 1);
    third(); assert.equal(workspace.diagnostics().subscriptions, 0);
});
