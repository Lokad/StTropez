import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { Workspace, TextBuffer } from "../src/index.ts";
import type { DocumentSnapshot, TextEdit } from "../src/index.ts";
import { applyLspWorkspaceEdit, readLspEditNotes, LspLineIndex, RpcError } from "../src/protocol/index.ts";
import type { LspWorkspaceEdit } from "../src/protocol/index.ts";

function fixture(t: TestContext, text = "alpha\nbeta") {
    const workspace = new Workspace(), resources = ["Source", "Unmounted"].map(name => workspace.createTextResource(
        { scope: "edit", resource: name, variant: "working" }, name, { value: text }));
    const documents = resources.map(resource => workspace.document(resource.documentId));
    const leases = resources.map(resource => workspace.acquire(resource.id));
    t.after(() => {
        leases.forEach(lease => lease.release()); resources.forEach(resource => workspace.releaseResource(resource.id, true));
        assert.equal(workspace.diagnostics().leases, 0);
    });
    return { workspace, resources, documents };
}
async function capture(documents: readonly DocumentSnapshot[], edits: readonly (readonly TextEdit[])[]): Promise<LspWorkspaceEdit> {
    return Object.freeze({ isCurrent: () => true, documents: Object.freeze(await Promise.all(documents.map(async (doc, i) => Object.freeze({
        target: Object.freeze({ document: Object.freeze({ documentId: doc.id, resourceId: doc.resourceId, revision: doc.revision, buffer: doc.buffer,
            uri: `host+opaque:${doc.id}`, languageId: "generic" }), index: await LspLineIndex.create(doc.buffer, async () => {}), version: null, isCurrent: () => true }),
        edits: Object.freeze(edits[i]!.map(edit => Object.freeze(edit))),
    })))) });
}
const stale = (error: unknown) => error instanceof RpcError && error.code === -32801;

test("decoded workspace edits bind exact resources and share undo with an unmounted target", async t => {
    const f = fixture(t), [a, b] = f.documents as [DocumentSnapshot, DocumentSnapshot], view = f.workspace.createDocumentView(a.id);
    view.setSelections(a.revision, [{ anchor: 1, head: 3 }, { anchor: 8, head: 6 }], 1);
    const selections = view.getSnapshot().selectionSet, plan = await capture(f.documents, [
        [{ from: 0, to: 5, insert: "longer" }], [{ from: 6, to: 10, insert: "B" }],
    ]);
    const transactions: (readonly (number | undefined)[])[] = [];
    const stop = f.workspace.observeDocument(a.id).subscribe(() => {
        // Every participant has committed before the first document observer is delivered.
        transactions.push([f.workspace.document(a.id).change?.transactionId, f.workspace.document(b.id).change?.transactionId]);
    });
    try {
        const changed = applyLspWorkspaceEdit(f.workspace, plan, { origin: "host", source: "rename", requiredOrigins: ["human"], historyKind: "refactor", view });
        assert.ok(Object.isFrozen(changed)); assert.deepEqual(changed.map(doc => doc.id), [a.id, b.id]);
        assert.ok(changed.every(doc => doc.change?.kind === "refactor" && doc.change.source === "rename"));
        assert.equal(changed[0], f.workspace.document(a.id)); assert.equal(changed[1]!.buffer.slice(0, 7), "alpha\nB");
        const afterSelections = view.getSnapshot().selectionSet;
        assert.equal(afterSelections.ranges.length, 2); assert.equal(afterSelections.primary, 1);
        assert.equal(f.workspace.observeHistory(a.id).getSnapshot().undoDepth, 1);
        assert.equal(f.workspace.observeHistory(b.id).getSnapshot().undoDepth, 1);
        assert.throws(() => applyLspWorkspaceEdit(f.workspace, plan, { origin: "host" }), stale);
        assert.ok(f.workspace.undo({ documentId: b.id, expectedRevision: changed[1]!.revision }).applied);
        assert.equal(f.workspace.document(a.id).buffer, a.buffer); assert.equal(f.workspace.document(b.id).buffer, b.buffer);
        assert.deepEqual(view.getSnapshot().selectionSet, selections);
        assert.ok(f.workspace.redo({ documentId: a.id, expectedRevision: f.workspace.document(a.id).revision }).applied);
        assert.deepEqual(view.getSnapshot().selectionSet, afterSelections);
        assert.equal(transactions.length, 3); assert.ok(transactions.every(([left, right]) => left !== undefined && left === right));
    } finally { stop(); view.dispose(); }
});

test("workspace-edit preflight and core validation refuse a bad last target without partial mutation", async t => {
    const f = fixture(t), plan = await capture(f.documents, f.documents.map(() => [{ from: 0, to: 5, insert: "changed" }]));
    const [first, last] = plan.documents, options = { origin: "host" as const, requiredOrigins: ["human" as const] };
    const withLast = (change: typeof last): LspWorkspaceEdit => ({ ...plan, documents: [first!, change!] });
    const unchanged = () => {
        for (const doc of f.documents) {
            assert.equal(f.workspace.document(doc.id).buffer, doc.buffer);
            assert.equal(f.workspace.document(doc.id).revision, doc.revision);
            assert.equal(f.workspace.observeHistory(doc.id).getSnapshot().undoDepth, 0);
        }
    };
    const reject = (edit: LspWorkspaceEdit, pattern: RegExp | typeof stale) => { assert.throws(() => applyLspWorkspaceEdit(f.workspace, edit, options), pattern); unchanged(); };
    reject({ ...plan, isCurrent: () => false }, stale);
    reject(withLast({ ...last!, target: { ...last!.target, isCurrent: () => false } }), stale);
    reject(withLast({ ...last!, target: { ...last!.target, index: first!.target.index } }), stale);
    for (const patch of [{ resourceId: first!.target.document.resourceId }, { revision: 1 }, { buffer: TextBuffer.from("alpha\nbeta") }]) {
        reject(withLast({ ...last!, target: { ...last!.target, document: { ...last!.target.document, ...patch } } }), stale);
    }
    reject(withLast({ ...last!, edits: [{ from: 0, to: 1000, insert: "invalid" }] }), /range|bound|length/i);
    reject({ ...plan, documents: [...plan.documents, first!] }, /once/);
    f.workspace.setCapabilities(f.resources[1]!.id, { edit: ["host"], save: true });
    reject(plan, /read-only/);
    f.workspace.setCapabilities(f.resources[1]!.id, { edit: ["human"], save: true });
    reject(plan, /read-only/);
    f.workspace.setCapabilities(f.resources[1]!.id, { edit: ["human", "host"], save: true });
    const lock = f.workspace.acquireEditLease(f.resources[1]!.id, "locked", "host");
    try { reject(plan, /edit-locked/); } finally { lock.release(); }
    const foreign = new Workspace(), foreignId = foreign.createDocument({ scope: "foreign", resource: "source", variant: "working" }, "Foreign", "text"), foreignView = foreign.createDocumentView(foreignId);
    try { assert.throws(() => applyLspWorkspaceEdit(f.workspace, plan, { ...options, view: foreignView }), /view/); unchanged(); } finally { foreignView.dispose(); }
    const empty = await capture(f.documents, [[], []]);
    assert.deepEqual(applyLspWorkspaceEdit(f.workspace, empty, options), []); unchanged();
    const same = await capture(f.documents, f.documents.map(() => [{ from: 0, to: 5, insert: "alpha" }]));
    assert.deepEqual(applyLspWorkspaceEdit(f.workspace, same, options), []); unchanged();
});

test("workspace edit notes read only the requested ordinals and bound wide replacement excerpts", async t => {
    const f = fixture(t, "abcdefghij\n".repeat(1_000));
    const edits = Array.from({ length: 66 }, (_, i) => ({ from: i * 11, to: i * 11 + 1, insert: "X" }));
    const plan = await capture(f.documents, [edits, [{ from: 0, to: f.documents[1]!.buffer.length, insert: "Y".repeat(16_000) }]]);
    const titles: string[] = [], title = (id: string) => { titles.push(id); return "T".repeat(200); };
    const first = readLspEditNotes(plan, title, 2, 11);
    assert.equal(first.total, 67); assert.equal(first.notes.length, 9); assert.deepEqual(titles, [f.documents[0]!.id]);
    titles.length = 0;
    const second = readLspEditNotes(plan, title, 64, 72);
    assert.equal(second.total, 67); assert.equal(second.notes.length, 3); assert.deepEqual(titles, f.documents.map(doc => doc.id));
    assert.equal(second.notes[0]!.from, 64 * 11);
    const wide = second.notes[2]!;
    assert.equal(wide.title.length, 128); assert.equal(wide.before.length, 257); assert.equal(wide.insert.length, 256);
    assert.equal(wide.insertUnits, 16_000); assert.ok(wide.context.length <= 193); assert.equal(wide.to, f.documents[1]!.buffer.length);
    assert.ok(Object.isFrozen(second) && Object.isFrozen(second.notes) && second.notes.every(Object.isFrozen));
    titles.length = 0;
    assert.deepEqual(readLspEditNotes(plan, title, 12, 12), { total: 67, notes: [] });
    assert.deepEqual(readLspEditNotes(plan, title, 80, 81).notes, []);
    assert.deepEqual(titles, []);
    assert.throws(() => readLspEditNotes(plan, title, -1, 4), RangeError);
    assert.throws(() => readLspEditNotes(plan, title, 3, 2), RangeError);
});
