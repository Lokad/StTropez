import assert from "node:assert/strict";
import test from "node:test";
import { Workspace } from "../src/index.ts";
import { DemoRecovery } from "../examples/demo/recovery.ts";
import type { DraftStore, StoredDraft } from "../examples/hosts/draft-store.ts";
import type { DemoFile } from "../examples/demo/project.ts";

class MemoryDraftStore implements DraftStore {
    row: StoredDraft | null = { token: "draft-1", value: { version: 1, sample: "sample", baseVersion: null, files: { "a.ts": "draft A", "b.ts": "draft B" } } };
    beforeWrite: () => Promise<void> = () => Promise.resolve();
    beforeRemove: () => Promise<void> = () => Promise.resolve();
    closed = false;
    writes = 0;
    read = async () => this.row;
    write = async (value: StoredDraft, expected: string | null) => {
        await this.beforeWrite();
        if ((this.row?.token ?? null) !== expected) throw new Error("Draft changed in another page.");
        this.row = value; this.writes++;
    };
    remove = async (expected: string) => {
        await this.beforeRemove();
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

test("partial editor inventories checkpoint every file and restore only against the original read intent", async t => {
    for (const scenario of ["checkpoint", "load-during-checkpoint", "restore", "stale", "redundant", "loaded-during-read"] as const) {
        const workspace = new Workspace(), store = new MemoryDraftStore(), files: DemoFile[] = [], unloaded: Record<string, string> = { "a.ts": "original a.ts", "b.ts": "original b.ts" };
        let recovery: DemoRecovery | undefined;
        const load = (name: string) => {
            const resource = workspace.createTextResource({ scope: "partial", resource: name, variant: "working" }, name, { value: unloaded[name]! });
            const tab = workspace.open({ kind: "text", documentId: resource.documentId }, "editor");
            files.push({ name, resource, tab, view: workspace.createDocumentView(resource.documentId) }); delete unloaded[name]; recovery?.filesChanged();
        };
        load("a.ts");
        if (scenario === "checkpoint" || scenario === "load-during-checkpoint") store.row = null;
        if (scenario === "redundant") store.row = { token: "redundant", value: { version: 1, sample: "sample", baseVersion: null, files: { "a.ts": "original a.ts", "b.ts": "original b.ts" } } };
        if (scenario === "loaded-during-read") store.row = { token: "genuine", value: { version: 1, sample: "sample", baseVersion: null, files: { "a.ts": "original a.ts", "b.ts": "draft B" } } };
        let finish!: (row: StoredDraft | null) => void;
        if (scenario === "stale" || scenario === "loaded-during-read") store.read = () => new Promise(resolve => { finish = resolve; });
        recovery = new DemoRecovery(workspace, () => files, "sample", () => null, () => true, store,
            { names: ["a.ts", "b.ts"], unloaded: () => unloaded, prepare: () => { for (const name of Object.keys(unloaded)) load(name); } });
        const captured = recovery; t.after(() => captured.dispose());
        const edit = () => workspace.edit({ documentId: files[0]!.resource.documentId, expectedRevision: 0, origin: "human", edits: [{ from: 0, to: 0, insert: "newer " }] });
        if (scenario === "stale") { await Promise.resolve(); edit(); finish(store.row); }
        if (scenario === "loaded-during-read") { await Promise.resolve(); load("b.ts"); finish(store.row); }
        await ready(recovery);
        if (scenario === "checkpoint" || scenario === "load-during-checkpoint") {
            if (scenario === "load-during-checkpoint") {
                const stop = captured.state.subscribe(() => { if (captured.state.getSnapshot().status === "writing") { stop(); load("b.ts"); } });
            }
            edit(); await new Promise<void>(resolve => { const stop = captured.state.subscribe(() => { if (captured.state.getSnapshot().status === "protected") { stop(); resolve(); } }); });
            assert.equal(files.length, scenario === "checkpoint" ? 1 : 2); assert.equal(store.writes, 1);
            assert.deepEqual((store.row!.value as { files: unknown }).files, { "a.ts": "newer original a.ts", "b.ts": "original b.ts" });
        } else if (scenario === "redundant") {
            assert.equal(files.length, 2); assert.equal(store.row, null); assert.equal(recovery.state.getSnapshot().present, false);
        } else if (scenario === "loaded-during-read") {
            assert.equal(files.length, 2); assert.equal(recovery.canRestore(), false); assert.equal(store.row?.token, "genuine");
            assert.match(recovery.download()!, /draft B/); await recovery.restore();
            assert.deepEqual(files.map(file => workspace.document(file.resource.documentId).text), ["original a.ts", "original b.ts"]);
        } else {
            assert.equal(files.length, 2); assert.equal(recovery.canRestore(), scenario === "restore"); await recovery.restore();
            assert.deepEqual(files.map(file => workspace.document(file.resource.documentId).text), scenario === "restore" ? ["draft A", "draft B"] : ["newer original a.ts", "original b.ts"]);
        }
    }
});

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

test("an already-saved draft is removed on reopen without an offer or document edits", async t => {
    const store = new MemoryDraftStore();
    store.row = { token: "saved-draft", value: { version: 1, sample: "sample", baseVersion: "older-save",
        files: { "a.ts": "original a.ts", "b.ts": "original b.ts" } } };
    const f = fixture(store); t.after(() => f.recovery.dispose()); await ready(f.recovery);
    assert.equal(store.row, null);
    assert.equal(f.recovery.state.getSnapshot().present, false);
    assert.equal(f.recovery.state.getSnapshot().status, "idle");
    assert.ok(f.files.every(file => f.workspace.document(file.resource.documentId).revision === 0 && !file.resource.metadata.getSnapshot().dirty));
    assert.ok(f.files.every(file => f.workspace.document(file.resource.documentId).buffer.readMetrics().textExports === 0));
});

test("redundant-draft cleanup cannot remove a newer peer draft", async t => {
    const store = new MemoryDraftStore();
    store.row = { token: "saved-draft", value: { version: 1, sample: "sample", baseVersion: null,
        files: { "a.ts": "original a.ts", "b.ts": "original b.ts" } } };
    let finish!: () => void, began!: () => void;
    const removing = new Promise<void>(resolve => { began = resolve; });
    store.beforeRemove = () => new Promise(resolve => { finish = resolve; began(); });
    const f = fixture(store); t.after(() => f.recovery.dispose());
    await removing;
    const newer = { token: "newer-peer", value: { version: 1, sample: "sample", baseVersion: null, files: { "a.ts": "peer A", "b.ts": "peer B" } } };
    store.row = newer; finish(); await ready(f.recovery);
    assert.equal(store.row, newer); assert.equal(f.recovery.state.getSnapshot().status, "failed");
    await f.recovery.refresh(); assert.match(f.recovery.download()!, /peer A/);
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
    const restoring = f.recovery.restore(); await Promise.resolve(); const disposal = f.recovery.dispose();
    assert.equal(f.recovery.dispose(), disposal); assert.equal(f.store.closed, false);
    for (const file of f.files) { file.view.dispose(); f.workspace.close(file.tab); f.workspace.releaseResource(file.resource.id, true); }
    finish(); await restoring; await disposal; await f.recovery.refresh();
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
    // A peer notice can start a read before the scheduled cleanup. Reading must not cancel it.
    await f.recovery.refresh();
    assert.equal(f.recovery.state.getSnapshot().message, "All changes are saved.");
    assert.equal(store.row, null);
});

test("save completion awaits exact-token cleanup of an older owned draft and preserves peer replacements", { timeout: 5000 }, async t => {
    for (const peer of [false, true]) {
        const store = new MemoryDraftStore(); store.row = null;
        const f = fixture(store); t.after(() => f.recovery.dispose()); await ready(f.recovery); f.edit();
        await new Promise<void>(resolve => {
            const stop = f.recovery.state.subscribe(() => { if (f.recovery.state.getSnapshot().status === "protected") { stop(); resolve(); } });
        });
        const owned = store.row; f.edit(); // Saved text differs from the owned draft, before its next checkpoint.
        const tickets = f.files.map(file => f.workspace.captureSave(file.resource));
        for (const ticket of tickets) { ticket.start(); ticket.accept({ serverVersion: "saved" }); ticket.finish(); }
        let release!: () => void, began!: () => void, settled = false;
        const removing = new Promise<void>(resolve => { began = resolve; });
        store.beforeRemove = () => new Promise(resolve => { release = resolve; began(); });
        const save = f.recovery.settleSavedDraft().then(() => { settled = true; });
        await removing; assert.equal(settled, false); assert.equal(store.row, owned);
        const newer: StoredDraft = { token: "peer", value: { version: 1, sample: "sample", baseVersion: "saved", files: { "a.ts": "peer A", "b.ts": "peer B" } } };
        if (peer) store.row = newer;
        release(); await save;
        assert.equal(store.row, peer ? newer : null);
        assert.equal(f.recovery.state.getSnapshot().status, peer ? "failed" : "idle");
    }
});
