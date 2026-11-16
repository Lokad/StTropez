import assert from "node:assert/strict";
import test from "node:test";
import { DemoProject } from "../examples/demo/project.ts";
import type { DraftStore, StoredDraft } from "../examples/hosts/draft-store.ts";

class MemoryStore implements DraftStore {
    row: StoredDraft | null = null;
    writes = 0;
    closed = false;
    read = async () => this.row;
    write = async (row: StoredDraft, expected: string | null) => {
        assert.equal(this.row?.token ?? null, expected); this.row = row; this.writes++;
    };
    remove = async (expected: string) => { assert.equal(this.row?.token, expected); this.row = null; };
    watch = () => () => {};
    close = async () => { this.closed = true; };
}

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
            assert.equal(workspace.document(first.resource.documentId).text, "// keep\n" + doc.text);
            other?.fail(); other?.finish();
            workspace.setCapabilities(second.resource.id, permissions);
            assert.deepEqual(project.files.map(file => workspace.ownership(file.resource.id)), owners);
            await project.save(() => { renders++; });
            assert.equal(store.writes, 1); assert.equal(project.saving, false); assert.equal(project.dirty(), false);
            assert.ok(project.files.every(file => file.resource.metadata.getSnapshot().saveStatus === "idle"));
            assert.deepEqual(project.files.map(file => workspace.ownership(file.resource.id)), owners);
            const saved = store.row!.value as { files: Record<string, string> };
            assert.equal(saved.files[first.name], "// keep\n" + doc.text);
        } finally { project.dispose(); await project.language.dispose(); }
        assert.equal(store.closed, true); assert.equal(recovery.closed, true);
        assert.equal(project.workspace.getSnapshot().resources.length, 0);
    });
});
