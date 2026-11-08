import test from "node:test";
import assert from "node:assert/strict";
import { Workspace } from "../src/index.ts";
import { createFindController } from "../src/browser/find.ts";
import type { EditingCandidate } from "../src/browser/editing-candidate.ts";

for (const lifetime of ["destroyed", "expired", "view-disposed"] as const) for (const composing of [false, true])
    test(`current replacement stays inert after ${lifetime} with composition ${composing}`, async t => {
        const workspace = new Workspace(), documentId = workspace.createDocument({ scope: "find", resource: "source", variant: "working" }, "Source", "sample sample");
        const tab = workspace.open({ kind: "text", documentId }, "left"), view = workspace.createDocumentView(documentId, { anchor: 0, head: 6 });
        const owner = Object.assign(new EventTarget(), { defaultView: { setTimeout, clearTimeout, performance } });
        // This headless facade exercises controller ownership and notifications. Real DOM/input remains browser coverage.
        const editor = { view, element: { ownerDocument: owner }, input: new EventTarget(), snapshot: () => ({ composing, disposed: false }),
            viewport: { revealOffset: () => { throw new Error("Inactive view must not be revealed."); } },
            focus: () => { throw new Error("Inactive editor must not receive focus."); } } as unknown as EditingCandidate;
        const find = createFindController(workspace, tab, editor); let stop = () => {};
        try {
            find.setQuery("sample");
            for (let turns = 0; find.state.getSnapshot().status !== "ready"; turns++) { assert.ok(turns < 100); await new Promise(resolve => setTimeout(resolve, 1)); }
            if (lifetime === "destroyed") find.destroy();
            else if (lifetime === "expired") workspace.replace(tab, { kind: "panel", resourceId: workspace.resourceForDocument(documentId).id, panelType: "configuration" });
            else view.dispose();
            const before = find.state.getSnapshot(), document = workspace.document(documentId), selected = view.getSnapshot(), history = workspace.observeHistory(documentId).getSnapshot();
            let notifications = 0; stop = find.state.subscribe(() => { notifications++; });
            const returned = find.replaceCurrent("changed"), after = find.state.getSnapshot();
            t.diagnostic(JSON.stringify({ lifetime, composing, returned, notifications, before, after }));
            assert.equal(returned, false); assert.strictEqual(after, before); assert.equal(notifications, 0);
            assert.strictEqual(workspace.document(documentId).buffer, document.buffer); assert.equal(workspace.document(documentId).revision, document.revision);
            assert.deepEqual(view.getSnapshot(), selected); assert.deepEqual(workspace.observeHistory(documentId).getSnapshot(), history);
        } finally {
            stop(); find.destroy(); view.dispose(); workspace.close(tab);
            assert.equal(workspace.diagnostics().views, 0); assert.equal(workspace.diagnostics().subscriptions, 0); assert.equal(workspace.diagnostics().leases, 0);
        }
    });
