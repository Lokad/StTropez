import test from "node:test";
import assert from "node:assert/strict";
import { Workspace } from "../src/index.ts";
import { findForView } from "../src/browser/find.ts";
import type { FindHost } from "../src/browser/find.ts";

for (const change of ["permission", "lease", "read-only"] as const) test(`queued replacement respects ${change} changes and requires explicit retry`, () => {
    const workspace = new Workspace(), source = workspace.createTextResource({ scope: "find", resource: "authority", variant: "working" }, "Source", { value: "cat cat" });
    const tab = workspace.tabs.open({ kind: "text", documentId: source.documentId }, "left"), view = workspace.createDocumentView(source.documentId);
    let serial = 0; const tasks = new Map<number, () => void>();
    const owner = Object.assign(new EventTarget(), { defaultView: { performance, setTimeout: (work: () => void) => { tasks.set(++serial, work); return serial; }, clearTimeout: (id: number) => tasks.delete(id) } });
    const editor = { view, element: { ownerDocument: owner }, input: Object.assign(new EventTarget(), { readOnly: false }), activity: () => ({ disposed: false, composing: false }),
        viewport: { revealRange: () => {} }, focus: () => {} } satisfies FindHost;
    const find = findForView(workspace, workspace.tabs.capture(tab), editor), drain = () => { while (tasks.size) { const [id, work] = tasks.entries().next().value!; tasks.delete(id); work(); } };
    try {
        find.setQuery("cat"); drain(); view.setSelections(0, [{ anchor: 0, head: 3 }, { anchor: 7, head: 7 }]);
        const before = workspace.document(source.documentId), selected = view.getSnapshot().selectionSet, history = workspace.observeHistory(source.documentId).getSnapshot(), idleSubscriptions = workspace.diagnostics().subscriptions;
        find.replaceAll("dog"); assert.equal(find.getSnapshot().status, "replacing"); assert.equal(find.getSnapshot().reason, null);
        if (change === "permission") {
            const original = source.metadata.getSnapshot().capabilities; workspace.setCapabilities(source.id, { ...original, edit: ["host"] }); workspace.setCapabilities(source.id, original);
        } else if (change === "lease") { const lease = workspace.acquireEditLease(source.id, "temporary", "host"); lease.release(); }
        else editor.input.readOnly = true;
        drain(); const after = workspace.document(source.documentId);
        assert.equal(after.buffer.slice(0, after.buffer.length), "cat cat"); assert.strictEqual(after.buffer, before.buffer); assert.equal(after.revision, before.revision);
        assert.deepEqual(view.getSnapshot().selectionSet, selected); assert.deepEqual(workspace.observeHistory(source.documentId).getSnapshot(), history);
        assert.match(find.getSnapshot().message, /cancelled/i); assert.equal(workspace.diagnostics().subscriptions, idleSubscriptions);
        assert.equal(find.getSnapshot().reason, "editing-unavailable");
        editor.input.readOnly = false;
        find.replaceAll("dog"); assert.equal(find.getSnapshot().reason, null); drain(); assert.equal(workspace.document(source.documentId).buffer.slice(0, 7), "dog dog");
        assert.equal(find.getSnapshot().reason, "replaced");
        assert.equal(workspace.observeHistory(source.documentId).getSnapshot().undoDepth, history.undoDepth + 1); assert.equal(workspace.diagnostics().subscriptions, idleSubscriptions);
        find.setQuery("dog"); drain(); find.replaceAll("dog"); drain();
        assert.equal(workspace.diagnostics().subscriptions, idleSubscriptions); assert.equal(workspace.observeHistory(source.documentId).getSnapshot().undoDepth, history.undoDepth + 1);
    } finally { find.dispose(); view.dispose(); workspace.tabs.close(tab); assert.equal(tasks.size, 0); assert.equal(workspace.diagnostics().subscriptions, 0); assert.equal(workspace.diagnostics().leases, 0); }
});
