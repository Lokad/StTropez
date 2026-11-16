import assert from "node:assert/strict";
import test from "node:test";
import { Workspace } from "../src/index.ts";
import { DemoProject } from "../examples/demo/project.ts";
import type { DraftStore, StoredDraft } from "../examples/hosts/draft-store.ts";

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
    watch = () => () => {};
    close = async () => { this.closed = true; this.closes++; };
}

const unusedProvider = async () => { throw new Error("This project fixture never starts a language provider."); };

test("demo startup falls back only for unreadable storage and preserves the stored copy", async t => {
    for (const failure of ["read", "decode"] as const) await t.test(failure, async () => {
        const store = new MemoryStore(), recovery = new MemoryStore();
        const original = { token: "saved", value: { version: 99 } };
        store.row = original;
        if (failure === "read") store.read = async () => { throw new Error("Storage is unavailable"); };
        const project = await DemoProject.open("pricing", () => true, unusedProvider,
            name => name === "sttropez-demo-projects-v1" ? store : recovery);
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
        await assert.rejects(DemoProject.open("pricing", () => true, unusedProvider, name => {
            if (name === "sttropez-demo-projects-v1") return store;
            recoveryAttempts++; if (point === "recovery-store") throw original;
            return recovery;
        }), error => point === "cleanup" ? error instanceof AggregateError && error.errors[0] === original && error.errors.includes(cleanup) : error === original);
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
            name => name === "sttropez-demo-projects-v1" ? store : recovery);
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
