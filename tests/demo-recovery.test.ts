import assert from "node:assert/strict";
import test from "node:test";
import { Workspace } from "../src/index.ts";
import { DemoRecovery } from "../examples/demo/recovery.ts";
import type { DraftStore, StoredDraft } from "../examples/hosts/draft-store.ts";

class MemoryDraftStore implements DraftStore {
    row: StoredDraft | null = { token: "draft-1", value: { version: 1, sample: "sample", baseVersion: null, files: { "a.ts": "draft A", "b.ts": "draft B" } } };
    beforeWrite: () => Promise<void> = () => Promise.resolve();
    closed = false;
    writes = 0;
    read = async () => this.row;
    write = async (value: StoredDraft, expected: string | null) => {
        await this.beforeWrite();
        if ((this.row?.token ?? null) !== expected) throw new Error("Draft changed in another page.");
        this.row = value; this.writes++;
    };
    remove = async (expected: string) => {
        if (this.row?.token !== expected) throw new Error("Draft changed in another page."); this.row = null;
    };
    watch = () => () => {};
    close = async () => { this.closed = true; };
}
function fixture(store = new MemoryDraftStore(), inputIdle = () => true) {
    const workspace = new Workspace();
    const files = ["a.ts", "b.ts"].map(name => {
        const resource = workspace.createTextResource({ scope: "test", resource: name, variant: "working" }, name, { value: `original ${name}` });
        const tab = workspace.open({ kind: "text", documentId: resource.documentId }, "editor");
        return { name, resource, tab, view: workspace.createDocumentView(resource.documentId) };
    });
    const recovery = new DemoRecovery(workspace, files, "sample", () => null, inputIdle, store);
    const text = () => files.map(file => workspace.document(file.resource.documentId).text);
    const edit = () => workspace.edit({ documentId: files[0]!.resource.documentId, expectedRevision: workspace.document(files[0]!.resource.documentId).revision,
        origin: "human", edits: [{ from: 0, to: 0, insert: "newer " }] });
    return { workspace, files, recovery, store, text, edit };
}
async function ready(recovery: DemoRecovery): Promise<void> {
    if (!recovery.state.getSnapshot().busy && recovery.state.getSnapshot().status !== "checking") return;
    await new Promise<void>(resolve => {
        const stop = recovery.state.subscribe(() => {
            const state = recovery.state.getSnapshot(); if (!state.busy && state.status !== "checking") { stop(); resolve(); }
        });
    });
}

test("recovery restores the named files atomically with one linked undo unit", async t => {
    const f = fixture(); t.after(() => f.recovery.dispose()); await ready(f.recovery);
    assert.deepEqual(f.text(), ["original a.ts", "original b.ts"]);
    assert.equal(f.recovery.canRestore(), true);
    await f.recovery.restore();
    assert.deepEqual(f.text(), ["draft A", "draft B"]);
    assert.ok(f.files.every(file => file.resource.metadata.getSnapshot().dirty));
    const file = f.files[1]!, document = f.workspace.document(file.resource.documentId);
    assert.equal(f.workspace.undo({ documentId: document.id, expectedRevision: document.revision }).applied, true);
    assert.deepEqual(f.text(), ["original a.ts", "original b.ts"]);
});

test("edits or composition during a delayed recovery claim prevent any restored edit", async t => {
    for (const reason of ["edit", "composition"] as const) {
        let idle = true;
        const f = fixture(new MemoryDraftStore(), () => idle); t.after(() => f.recovery.dispose()); await ready(f.recovery);
        let finish!: () => void; f.store.beforeWrite = () => new Promise<void>(resolve => { finish = resolve; });
        const restoring = f.recovery.restore(); await Promise.resolve();
        if (reason === "edit") f.edit(); else idle = false;
        const before = f.text(); finish(); await restoring;
        assert.deepEqual(f.text(), before);
        assert.equal(f.recovery.canRestore(), false);
        assert.match(f.recovery.download()!, /draft A/);
    }
});

test("stale restore and discard cannot replace or delete another page's newer draft", async t => {
    const f = fixture(); t.after(() => f.recovery.dispose()); await ready(f.recovery);
    const newer = { token: "newer", value: { version: 1, sample: "sample", baseVersion: null, files: { "a.ts": "peer A", "b.ts": "peer B" } } };
    f.store.row = newer;
    await f.recovery.restore(); assert.equal(f.store.row, newer); assert.deepEqual(f.text(), ["original a.ts", "original b.ts"]);
    await f.recovery.keepCurrent(); assert.equal(f.store.row, newer);
    await f.recovery.refresh(); assert.match(f.recovery.download()!, /peer A/);
    await f.recovery.restore(); assert.deepEqual(f.text(), ["peer A", "peer B"]);
});

test("disposal during a pending claim prevents late application after resources are released", async () => {
    const f = fixture(); await ready(f.recovery);
    let finish!: () => void; f.store.beforeWrite = () => new Promise<void>(resolve => { finish = resolve; });
    const restoring = f.recovery.restore(); await Promise.resolve(); f.recovery.dispose();
    for (const file of f.files) { file.view.dispose(); f.workspace.close(file.tab); f.workspace.releaseResource(file.resource.id, true); }
    finish(); await restoring; await f.recovery.refresh();
    assert.equal(f.store.closed, true);
    assert.equal(f.workspace.getSnapshot().documents.length, 0);
});

test("a late recovery read cannot authorize replacing edits made since the read began", async t => {
    const store = new MemoryDraftStore(), draft = store.row;
    let finish!: (row: StoredDraft | null) => void;
    store.read = () => new Promise(resolve => { finish = resolve; });
    const f = fixture(store); t.after(() => f.recovery.dispose()); await Promise.resolve();
    f.edit(); finish(draft); await ready(f.recovery);
    assert.equal(f.recovery.canRestore(), false); assert.match(f.recovery.download()!, /draft A/);
    assert.deepEqual(f.text(), ["newer original a.ts", "original b.ts"]);
});

test("unsupported recovery data remains stored and cannot mutate current files", async t => {
    const store = new MemoryDraftStore(); store.row = { token: "invalid", value: { version: 999, files: {} } };
    const row = store.row, f = fixture(store); t.after(() => f.recovery.dispose()); await ready(f.recovery);
    assert.equal(f.recovery.state.getSnapshot().status, "failed"); assert.equal(f.recovery.canRestore(), false);
    assert.equal(store.row, row); assert.deepEqual(f.text(), ["original a.ts", "original b.ts"]);
});

test("automatic recovery exports text after the edit notification and clears its own saved draft", { timeout: 5000 }, async t => {
    const store = new MemoryDraftStore(); store.row = null;
    const f = fixture(store); t.after(() => f.recovery.dispose()); await ready(f.recovery);
    f.edit();
    assert.equal(f.workspace.document(f.files[0]!.resource.documentId).buffer.readMetrics().textExports, 0);
    await new Promise<void>(resolve => {
        const stop = f.recovery.state.subscribe(() => { if (f.recovery.state.getSnapshot().status === "protected") { stop(); resolve(); } });
    });
    assert.match(JSON.stringify(store.row), /newer original a.ts/);
    assert.equal(store.writes, 1);
    // Notices for other sample slots must not trigger repeated writes of unchanged dirty files.
    await f.recovery.refresh(); await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(store.writes, 1);
    const tickets = f.files.map(file => f.workspace.captureSave(file.resource));
    for (const ticket of tickets) { ticket.start(); ticket.accept({ serverVersion: "saved" }); ticket.finish(); }
    await new Promise<void>(resolve => {
        const stop = f.recovery.state.subscribe(() => { if (f.recovery.state.getSnapshot().message === "All changes are saved.") { stop(); resolve(); } });
    });
    assert.equal(store.row, null);
});
