import assert from "node:assert/strict";
import test from "node:test";
import { Workspace } from "../src/index.ts";
import { DemoProject } from "../examples/demo/project.ts";
import { HostSourceNotes } from "../examples/shared/source-notes.ts";
import type { DraftStore, StoredDraft } from "../examples/shared/draft-store.ts";
import { latch } from "./helpers/latch.ts";

import { demoSample, sampleChoices } from "../examples/demo/samples.ts";
import { corpus, corpusIds } from "./fixtures/workloads.ts";

test("shipped sample files and benchmark corpora fit in 512 KB of UTF-8", () => {
    for (const { id } of sampleChoices) {
        for (const [name, text] of Object.entries(demoSample(id).files)) {
            assert.ok(Buffer.byteLength(text, "utf8") <= 512_000, `${id}/${name}`);
        }
    }
    for (const id of corpusIds) assert.ok(Buffer.byteLength(corpus(id), "utf8") <= 512_000, id);
});

test("source notes follow every edit in a workspace batch", () => {
    const workspace = new Workspace();
    const resource = workspace.createTextResource({ scope: "notes", resource: "rules", variant: "working" },
        "Rules", { value: "one two three" });
    const documentId = resource.documentId;
    const notes = new HostSourceNotes(workspace, documentId);
    notes.add(0, 4, 7, "keep");
    notes.add(0, 8, 13, "remove");
    workspace.createNotificationScope().batch(() => {
        workspace.edit({ documentId, expectedRevision: 0, origin: "host", edits: [{ from: 0, to: 0, insert: "#" }] });
        workspace.edit({ documentId, expectedRevision: 1, origin: "host", edits: [{ from: 9, to: 14, insert: "" }] });
    });
    const state = notes.state.getSnapshot();
    assert.equal(state.revision, 2);
    assert.deepEqual(state.notes.map(({ text, range }) => [text, range.from, range.to]), [["keep", 5, 8]]);
    const save = workspace.captureSave(resource);
    save.start();
    save.accept({ serverVersion: "saved" });
    save.finish();
    const reload = workspace.operations.beginLoad(resource);
    reload.accept({ value: "different text", serverVersion: "external" });
    reload.finish();
    assert.deepEqual(notes.state.getSnapshot(), { revision: workspace.document(documentId).revision, notes: [] });
    workspace.releaseResource(resource.id, true);
    assert.deepEqual(notes.state.getSnapshot(), { revision: null, notes: [] });
    notes.dispose();
});

class MemoryStore implements DraftStore {
    row: StoredDraft | null = null;
    writes = 0;
    closed = false;
    closes = 0;
    read = async () => this.row;
    write = async (row: StoredDraft, expected: string | null) => {
        assert.equal(this.row?.token ?? null, expected); this.row = row; this.writes++;
    };
    remove = async (expected: string) => { assert.equal(this.row?.token, expected); this.row = null; };
    watch = (_changed: () => void) => () => {};
    close = async () => { this.closed = true; this.closes++; };
}

const unusedProvider = async () => { throw new Error("This project fixture never starts a language provider."); };

test("a save supersedes an in-flight peer read and disposal retires its replacement", async () => {
    const store = new MemoryStore(), recovery = new MemoryStore();
    let notify: (() => void) | undefined;
    store.watch = changed => {
        notify = changed;
        return () => { notify = undefined; };
    };
    const seen: string[] = [];
    const project = await DemoProject.open("pricing", () => true, unusedProvider, {
        createStore: name => name === "sttropez-demo-projects-v1" ? store : recovery,
        peerChanged: project => seen.push(project.message),
    });
    try {
        const stale = latch<StoredDraft>();
        store.read = () => stale.promise;
        notify!();
        await project.save(() => {});
        const reread = latch<void>(), fresh = latch<StoredDraft>();
        store.read = () => { reread.resolve(); return fresh.promise; };
        stale.resolve({ ...store.row!, token: "previous" });
        await reread.promise;
        assert.deepEqual(seen, []);
        assert.equal(project.hasConflict(), false);
        project.dispose();
        fresh.resolve({ ...store.row!, token: "newer" });
        await project.language.dispose();
        assert.deepEqual(seen, []);
        assert.equal(project.hasConflict(), false);
        assert.equal(notify, undefined);
    } finally {
        project.dispose();
        await project.language.dispose();
    }
});

test("a missing saved copy can be recreated without overwriting a replacement", { timeout: 5000 }, async () => {
    const store = new MemoryStore(), recovery = new MemoryStore();
    let notify = () => {};
    store.watch = changed => { notify = changed; return () => {}; };
    const noticed = latch<void>();
    const project = await DemoProject.open("pricing", () => true, unusedProvider, {
        createStore: name => name === "sttropez-demo-projects-v1" ? store : recovery,
        peerChanged: () => noticed.resolve()
    });
    try {
        const save = () => project.save(() => {});
        await save();
        const first = store.row!;
        const file = project.files[0]!;
        project.workspace.replaceText(file.resource.documentId, "// keep my edit", { origin: "human", history: "record" });
        await store.remove(first.token);

        const read = store.read;
        store.read = async () => { throw new Error("Cannot read storage"); };
        await save();
        assert.match(project.message, /Could not save/);
        store.read = read;
        await save();
        assert.match(project.message, /saved copy was removed/i);
        assert.equal(project.dirty(), true);
        assert.equal(await store.read(), null);
        await save();
        assert.equal(project.dirty(), false);
        const recreated = (await store.read())!;
        assert.equal((recreated.value as { files: Record<string, string> }).files[file.name], "// keep my edit");

        await store.remove(recreated.token);
        notify();
        await noticed.promise;
        assert.match(project.message, /saved copy was removed/i);
        const peer = { ...first, token: "newer" };
        store.row = peer;
        await save();
        assert.equal(store.row, peer);
        assert.ok(project.reviewConflict());
        await store.remove(peer.token);
        await project.takeReviewedCopy(() => {}, () => true);
        assert.equal(project.canSaveReviewed(), false);
        assert.equal(project.hasConflict(), false);

        await save();
        assert.equal(store.writes, 3);
        const saved = await store.read();
        assert.equal((saved!.value as { files: Record<string, string> }).files[file.name], "// keep my edit");
    } finally {
        project.dispose();
        await project.language.dispose();
    }
});

test("taking a reviewed copy preserves edits and replacement views during the storage read", async () => {
    const store = new MemoryStore(), recovery = new MemoryStore();
    const project = await DemoProject.open("pricing", () => true, unusedProvider,
        { createStore: name => name === "sttropez-demo-projects-v1" ? store : recovery });
    try {
        const files = project.files, workspace = project.workspace, second = files[1]!.resource.documentId;
        const peer = { token: "peer", value: { version: 1, files: Object.fromEntries(files.map(file => [file.name, "// peer " + file.name])) } };
        store.row = peer; await project.save(() => {}); assert.equal(project.reviewConflict(), true);
        const before = files.map(file => workspace.document(file.resource.documentId).buffer);
        const held = latch<StoredDraft>(); store.read = () => held.promise;
        const take = project.takeReviewedCopy(() => {}, () => true);
        workspace.replaceText(second, "// typed during read", { origin: "human", history: "record" });
        held.resolve(peer); await take;
        assert.equal(workspace.document(files[0]!.resource.documentId).buffer, before[0]);
        assert.equal(workspace.document(second).text(), "// typed during read");
        assert.equal(project.canSaveReviewed(), false); assert.match(project.message, /Review the saved copy again/);
        project.reviewConflict();
        const nextRead = latch<StoredDraft>(); store.read = () => nextRead.promise;
        let current = true;
        const pending = project.takeReviewedCopy(() => {}, () => current);
        current = false; nextRead.resolve(peer); await pending;
        assert.equal(workspace.document(second).text(), "// typed during read"); assert.equal(project.hasConflict(), true);
        await project.takeReviewedCopy(() => {}, () => true);
        assert.equal(store.row, peer); assert.equal(store.writes, 0); assert.equal(project.dirty(), false);
        workspace.replaceText(second, "// after adoption", { origin: "human", history: "record" }); await project.save(() => {});
        assert.equal(store.writes, 1); assert.equal(project.dirty(), false);
    } finally { project.dispose(); await project.language.dispose(); }
});

test("demo startup falls back only for unreadable storage and preserves the stored copy", async t => {
    for (const failure of ["read", "decode"] as const) await t.test(failure, async () => {
        const store = new MemoryStore(), recovery = new MemoryStore();
        const original = { token: "saved", value: { version: 99 } };
        store.row = original;
        if (failure === "read") store.read = async () => { throw new Error("Storage is unavailable"); };
        const project = await DemoProject.open("pricing", () => true, unusedProvider,
            { createStore: name => name === "sttropez-demo-projects-v1" ? store : recovery });
        try {
            assert.match(project.message, failure === "read" ? /Storage is unavailable/ : /stored copy has been left untouched/);
            const doc = project.workspace.document(project.files[0]!.resource.documentId);
            assert.equal(project.workspace.edit({ documentId: doc.id, expectedRevision: doc.revision, origin: "human",
                edits: [{ from: 0, to: 0, insert: "// still editable\n" }] }).applied, true);
            await project.save(() => {});
            assert.equal(store.row, original); assert.equal(store.writes, 0); assert.equal(project.dirty(), true);
        } finally { project.dispose(); await project.language.dispose(); }
        assert.equal(store.closed, true); assert.equal(recovery.closed, true);
    });
});

test("demo construction rolls back acquired owners without retrying or replacing the original error", async t => {
    for (const point of ["recovery-store", "file-view", "recovery-watch", "language", "cleanup"] as const) await t.test(point, async t => {
        const store = new MemoryStore(), recovery = new MemoryStore();
        const original = new Error("Project construction failed"), cleanup = new Error("Store close failed");
        let workspace: Workspace | undefined, views = 0, subscriptions = 0, recoveryAttempts = 0, watches = 0;
        const createView = Workspace.prototype.createDocumentView;
        t.mock.method(Workspace.prototype, "createDocumentView", function (this: Workspace, ...args: Parameters<typeof createView>) {
            if (!workspace) {
                const subscribe = this.subscribe;
                t.mock.method(this, "subscribe", (...args: Parameters<typeof subscribe>) => {
                    if ((point === "language" || point === "cleanup") && ++subscriptions === 2) throw original;
                    return subscribe(...args);
                });
            }
            workspace = this;
            if (point === "file-view" && ++views === 2) throw original;
            return createView.apply(this, args);
        });
        recovery.watch = () => {
            if (point === "recovery-watch") throw original;
            watches++; return () => { watches--; };
        };
        if (point === "cleanup") recovery.close = async () => { recovery.closed = true; recovery.closes++; throw cleanup; };
        await assert.rejects(DemoProject.open("pricing", () => true, unusedProvider, { createStore: name => {
            if (name === "sttropez-demo-projects-v1") return store;
            recoveryAttempts++; if (point === "recovery-store") throw original;
            return recovery;
        } }), error => point === "cleanup" ? error instanceof AggregateError && error.errors[0] === original && error.errors.includes(cleanup) : error === original);
        assert.equal(recoveryAttempts, 1); assert.equal(store.closes, 1);
        assert.equal(recovery.closes, point === "recovery-store" ? 0 : 1); assert.equal(watches, 0);
        if (workspace) {
            const { resources, documents, tabs, views, leases, subscriptions } = workspace.diagnostics();
            assert.deepEqual({ resources, documents, tabs, views, leases, subscriptions },
                { resources: 0, documents: 0, tabs: 0, views: 0, leases: 0, subscriptions: 0 });
        }
    });
});

test("demo save releases partial capture and started tickets before retry or project disposal", async t => {
    for (const failure of ["capture", "start"] as const) await t.test(failure, async () => {
        const store = new MemoryStore(), recovery = new MemoryStore();
        const project = await DemoProject.open("pricing", () => true,
            async () => { throw new Error("This save fixture never starts a language provider."); },
            { createStore: name => name === "sttropez-demo-projects-v1" ? store : recovery });
        try {
            const [first, second] = project.files;
            assert.ok(first && second);
            const workspace = project.workspace, permissions = second.resource.metadata.getSnapshot().capabilities;
            const doc = workspace.document(first.resource.documentId);
            workspace.edit({ documentId: doc.id, expectedRevision: doc.revision, origin: "human", edits: [{ from: 0, to: 0, insert: "// keep\n" }] });
            const owners = project.files.map(file => workspace.ownership(file.resource.id));
            // Capture fails after the first acquisition, or start fails after the first writer starts.
            const other = failure === "start" ? workspace.captureSave(second.resource) : undefined;
            other?.start();
            if (failure === "capture") workspace.setCapabilities(second.resource.id, { ...permissions, save: false });
            let renders = 0;
            await project.save(() => { renders++; });
            assert.equal(project.saving, false); assert.equal(store.writes, 0); assert.equal(renders, 1);
            assert.match(project.message, /Could not save/);
            assert.equal(workspace.document(first.resource.documentId).text(), "// keep\n" + doc.text());
            other?.fail(); other?.finish();
            workspace.setCapabilities(second.resource.id, permissions);
            assert.deepEqual(project.files.map(file => workspace.ownership(file.resource.id)), owners);
            await project.save(() => { renders++; });
            assert.equal(store.writes, 1); assert.equal(project.saving, false); assert.equal(project.dirty(), false);
            assert.ok(project.files.every(file => file.resource.metadata.getSnapshot().saveStatus === "idle"));
            assert.deepEqual(project.files.map(file => workspace.ownership(file.resource.id)), owners);
            const saved = store.row!.value as { files: Record<string, string> };
            assert.equal(saved.files[first.name], "// keep\n" + doc.text());
        } finally { project.dispose(); await project.language.dispose(); }
        assert.equal(store.closed, true); assert.equal(recovery.closed, true);
        assert.equal(project.workspace.getSnapshot().resources.length, 0);
    });
});
