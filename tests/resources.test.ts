import { test } from "node:test";
import assert from "node:assert/strict";
import { TextBuffer, Workspace } from "../src/index.ts";
import { HostSaveQueue } from "./fixtures/save-queue.ts";
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
    const edit = (text: string, origin: "human" | "agent" | "host" = "human") => workspace.edit({ documentId: source.id,
        expectedRevision: workspace.document(source.id).revision, origin,
        edits: [{ from: 0, to: workspace.document(source.id).text().length, insert: text }] });
    return { workspace, source, edit };
}

test("internal resources keep captured ownership while workspace inventories contain only host resources", async () => {
    const { workspace, source } = fixture(), before = workspace.getSnapshot();
    const options = { visibility: "internal" as const }, buffer = TextBuffer.from("immutable reference");
    const reference = workspace.createTextResource({ scope: "test", resource: "reference", variant: "one" }, "Reference",
        { value: buffer, capabilities: { edit: [], save: false }, ...options });
    const scratch = workspace.createTextResource({ scope: "test", resource: "scratch", variant: "one" }, "Scratch", {
        value: "x",
        ...options,
    });
    const resourceTarget = workspace.captureResource(reference.id);
    const inventory = workspace.getSnapshot();
    assert.deepEqual(inventory.resources.map(resource => resource.id), [source.id]);
    assert.deepEqual(inventory.documents.map(document => document.id), [source.id]);
    assert.equal(before.resources.length, 1);
    assert.equal(reference.metadata.getSnapshot().visibility, "internal");
    assert.equal(workspace.resolveResource(resourceTarget), reference);
    assert.equal(workspace.document(reference.id).buffer, buffer);
    assert.notEqual(workspace.edit({ documentId: reference.id, expectedRevision: 0, edits: [{ from: 0, to: 0, insert: "x" }], origin: "human" }).status, "done");
    // Inventory visibility is independent of edit permissions.
    assert.equal(workspace.edit({ documentId: scratch.id, expectedRevision: 0, edits: [{ from: 0, to: 1, insert: "y" }], origin: "human" }).status, "done");
    const view = workspace.createDocumentView(reference.id), lease = workspace.acquire(reference.id);
    workspace.releaseResourceWhenUnowned(reference.id);
    await Promise.resolve(); assert.equal(reference.getSnapshot().state, "ready");
    lease.release(); await Promise.resolve(); assert.equal(reference.getSnapshot().state, "ready");
    view.dispose(); await Promise.resolve(); assert.equal(reference.getSnapshot().state, "released");
    assert.equal(workspace.resolveResource(resourceTarget), undefined);
    workspace.releaseResource(scratch.id, true);
    assert.deepEqual(workspace.getSnapshot().resources.map(resource => resource.id), [source.id]);
    assert.equal(workspace.diagnostics().documents, 1);
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
        const handle = workspace.createTextResource(key, "Document", { value: "" });
        assert.throws(() => workspace.createTextResource({ ...key }, "Duplicate", { value: "" }), /already exists/);
        foreign.createTextResource(key, "Independent", { value: "" });
        assert.deepEqual(handle.metadata.getSnapshot().key, key);
    }
    const key = { scope: "lifecycle", resource: "item", variant: "working" }, before = workspace.getSnapshot();
    assert.throws(() => workspace.createTextResource(key, "Bad value", { value: NaN as never }), TypeError);
    assert.equal(workspace.getSnapshot(), before);
    const handle = workspace.createTextResource(key, "Valid", { value: "" }), capturedKey = { ...key }, target = workspace.captureResource(handle.id);
    key.resource = "mutated";
    assert.deepEqual(handle.metadata.getSnapshot().key, capturedKey); assert.ok(Object.isFrozen(handle.metadata.getSnapshot().key));
    const lease = workspace.acquire(handle.id);
    assert.throws(() => workspace.releaseResource(handle.id), /leases/); lease.release();
    workspace.replaceText(handle.id, "1", { expectedRevision: 0, history: "record", origin: "human" });
    assert.throws(() => workspace.releaseResource(handle.id), /discard/);
    assert.throws(() => workspace.createTextResource(capturedKey, "Still owned"), /already exists/);
    workspace.releaseResource(handle.id, true);
    const replacement = workspace.createTextResource(capturedKey, "Replacement", { value: "new" });
    assert.notEqual(replacement.id, handle.id); assert.equal(workspace.resolveResource(target), undefined);
    assert.equal(handle.getSnapshot().state, "released");

    const generated = new Workspace();
    // The first document consumes ID 1; the next generated variant must skip the host-owned "2".
    generated.createTextResource({ scope: "generated", resource: "item", variant: "2" }, "Host");
    const next = generated.createResourceKey("generated", "item"), later = generated.createResourceKey("generated", "item");
    assert.notEqual(next.variant, "2"); assert.notDeepEqual(next, later); assert.ok(Object.isFrozen(next));
    generated.createTextResource(next, "Generated");
});

test("resource-key allocation and duplicate checks do not traverse the workspace inventory", t => {
    const workspace = new Workspace();
    for (let i = 0; i < 1000; i++) workspace.createTextResource({ scope: "many", resource: String(i), variant: "working" }, "Document");
    const values = Map.prototype.values; let visits = 0;
    Map.prototype.values = function () {
        const iterator = values.call(this), next = iterator.next.bind(iterator);
        iterator.next = (...args) => { const item = next(...args); if (!item.done) visits++; return item; };
        return iterator;
    };
    try {
        const key = workspace.createResourceKey("many", "new"), allocation = visits; visits = 0;
        workspace.createTextResource(key, "New"); const creation = visits; visits = 0;
        assert.throws(() => workspace.createTextResource({ ...key }, "Duplicate"), /already exists/);
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
    assert.notEqual(workspace.edit({ documentId: handle.id, expectedRevision: 0, origin: "human", edits: [] }).status, "done");
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

test("abandoning superseded refreshes restores the saved text with current permissions", () => {
    const { workspace, source } = fixture(), before = source.getSnapshot();
    assert.ok(before.state === "ready");
    const older = workspace.beginLoad(source), latest = workspace.beginLoad(source);
    older.dispose(); assert.equal(source.getSnapshot().state, "loading");
    workspace.setCapabilities(source.id, { edit: [], save: false });
    latest.dispose();
    const after = source.getSnapshot();
    assert.ok(after.state === "ready"); assert.equal(after.value, before.value);
    assert.equal(after.revision, before.revision); assert.equal(after.metadata.serverVersion, "v0");
    assert.deepEqual(after.metadata.capabilities, { edit: [], save: false });
    assert.equal(older.accept({ value: "late" }), false);
    assert.equal(workspace.ownership(source.id).leases, 0);
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
    const other = workspace.createTextResource({ scope: "probe", resource: "other", variant: "working" }, "Other", { value: "one" });
    const write = (insert: string) => workspace.edit({ documentId: source.id, expectedRevision: workspace.document(source.id).revision,
        origin: "human", edits: [{ from: 0, to: 1, insert }] });
    write("b"); // Make dirty before measuring unchanged metadata.
    const meta = source.metadata.getSnapshot(), otherSnapshot = other.getSnapshot();
    let otherCalls = 0, metadataCalls = 0, delivered = 0;
    other.subscribe(() => otherCalls++); source.metadata.subscribe(() => metadataCalls++);
    const observations: string[] = [];
    source.subscribe(() => { observations.push(workspace.document(source.id).text()); throw new Error("Listener failed"); });
    source.subscribe(() => { write("illegal"); });
    const unsubscribe = source.subscribe(() => { delivered++; observations.push(workspace.document(source.id).text()); });
    write("c");
    assert.deepEqual(observations, ["c", "c"]);
    assert.equal(errors.length, 2);
    assert.equal(delivered, 1); assert.equal(otherCalls, 0); assert.equal(metadataCalls, 0);
    assert.equal(source.metadata.getSnapshot(), meta); assert.equal(other.getSnapshot(), otherSnapshot);
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
    assert.equal(workspace.diagnostics().documents, 0); assert.equal(workspace.diagnostics().leases, 0);
});

test("capabilities reject all edit origins and prevent stale refresh from erasing local work", () => {
    const { workspace, source, edit } = fixture();
    workspace.setCapabilities(source.id, { edit: [], save: false });
    for (const origin of ["human", "agent", "host"] as const) assert.deepEqual(edit("blocked", origin), { status: "refused", reason: "read-only" });
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
    const commands = new HostSaveQueue(workspace), responses = [deferred<SaveResponse>(), deferred<SaveResponse>()];
    const calls: SaveSubmission[] = [];
    const port = { save: (submission: SaveSubmission) => { calls.push(submission); return responses[calls.length - 1]!.promise; } };
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

test("a lost receipt preserves the queued draft and a second runner cannot release the active ticket", async () => {
    const { workspace, source, edit } = fixture();
    edit("first");
    const first = workspace.captureSave(source);
    const reply = deferred<SaveResponse>();
    let stored = "abc";
    const writing = first.run(submission => {
        stored = submission.value;
        return reply.promise;
    });
    await assert.rejects(first.run(() => assert.fail("second write ran")));
    assert.equal(source.metadata.getSnapshot().saveStatus, "saving");
    edit("second");
    const second = workspace.captureSave(source);
    reply.resolve({ kind: "unknown", serverVersion: "v1", storedValue: stored });
    const recovered = await writing;
    assert.equal(recovered.kind, "saved");
    assert.equal(stored, "first");
    assert.equal(source.metadata.getSnapshot().serverVersion, "v1");
    assert.equal(source.metadata.getSnapshot().dirty, true);
    const result = await second.run(submission => {
        assert.equal(submission.value, "second");
        assert.equal(submission.expectedServerVersion, "v1");
        return { kind: "unknown", serverVersion: "v2", storedValue: "peer" };
    });
    assert.deepEqual(result, { kind: "conflict", serverVersion: "v2" });
    assert.equal(workspace.document(source.id).text(), "second");
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
    const response = deferred<SaveResponse>();
    const pending = commands.save(workspace.captureSave(source), { save: () => response.promise }); await Promise.resolve();
    workspace.setCapabilities(source.id, { edit: [], save: true });
    response.resolve({ kind: "saved", serverVersion: "v2", canonical: "RETRY" }); await pending;
    assert.equal(workspace.document(source.id).text(), "retry"); assert.equal(source.metadata.getSnapshot().dirty, true);
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
    const other = workspace.createTextResource({ scope: "fixture", resource: "other", variant: "working" }, "Other", { value: "x" });
    let calls = 0; const listener = () => { calls++; };
    const first = other.subscribe(listener), second = other.subscribe(listener);
    assert.equal(workspace.diagnostics().subscriptions, 2);
    assert.equal(workspace.replaceText(other.id, "y", { expectedRevision: 0, origin: "human", history: "record" }).status, "done");
    assert.equal(calls, 1);
    first(); first(); assert.equal(workspace.diagnostics().subscriptions, 1);
    assert.equal(workspace.replaceText(other.id, "z", { expectedRevision: 1, origin: "human", history: "record" }).status, "done");
    assert.equal(calls, 2); const third = other.subscribe(listener);
    workspace.releaseResource(other.id, true); assert.equal(calls, 3); assert.equal(workspace.diagnostics().subscriptions, 2);
    second(); second(); assert.equal(workspace.diagnostics().subscriptions, 1);
    third(); assert.equal(workspace.diagnostics().subscriptions, 0);
});
