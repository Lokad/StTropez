import test from "node:test";
import assert from "node:assert/strict";
import { createComparisonController, TextBuffer, Workspace } from "../src/index.ts";
import { createFindController } from "../src/browser/find.ts";
import type { FindHost } from "../src/browser/index.ts";

test("controller and workspace notifications reject cross-owner writes through nested delivery", () => {
    const errors: unknown[] = [], workspace = new Workspace({ onListenerError: error => errors.push(error) });
    const documentId = workspace.createDocument({ scope: "find", resource: "notifications", variant: "working" }, "Source", "cat");
    const tab = workspace.open({ kind: "text", documentId }, "left"), view = workspace.createDocumentView(documentId), tasks = new Map<number, () => void>();
    let serial = 0;
    const owner = Object.assign(new EventTarget(), { defaultView: { performance,
        setTimeout: (work: () => void) => { tasks.set(++serial, work); return serial; }, clearTimeout: (id: number) => tasks.delete(id) } });
    const editor = { view, element: { ownerDocument: owner }, input: Object.assign(new EventTarget(), { readOnly: false }), activity: () => ({ composing: false, disposed: false }),
        viewport: { revealOffset: () => {} }, focus: () => {} } satisfies FindHost;
    const find = createFindController(workspace, tab, editor), comparison = createComparisonController(workspace, tab, { buffer: TextBuffer.from("cat"), version: "one" });
    const other = new Workspace(), independent = other.createDocument({ scope: "find", resource: "other", variant: "working" }, "Other", "a");
    const write = () => workspace.edit({ documentId, expectedRevision: workspace.document(documentId).revision, origin: "human", edits: [{ from: 0, to: 0, insert: "x" }] });
    const rejected: string[] = [], attempt = (name: string, command: () => unknown) => { try { command(); } catch (error) { if (error instanceof Error && /Reentrant mutation/.test(error.message)) rejected.push(name); else errors.push(error); } };
    let attempted = false;
    const stops = [find.subscribe(() => {
        if (attempted) return; attempted = true;
        attempt("workspace", write); attempt("comparison", () => comparison.advance()); attempt("find", () => find.cancel());
        other.edit({ documentId: independent, expectedRevision: 0, origin: "human", edits: [{ from: 0, to: 1, insert: "b" }] });
    })];
    try {
        find.setQuery("cat"); assert.deepEqual(rejected, ["workspace", "comparison", "find"]);
        assert.equal(workspace.document(documentId).revision, 0); assert.equal(other.document(independent).text(), "b");
        const seen: number[] = [];
        stops.push(workspace.subscribe(() => { seen.push(workspace.document(documentId).revision);
            attempt("after nested workspace", write); attempt("after nested find", () => find.cancel());
        }));
        write(); assert.deepEqual(seen, [1]); assert.equal(find.getSnapshot().revision, 1);
        assert.deepEqual(rejected, ["workspace", "comparison", "find", "after nested workspace", "after nested find"]);
        assert.equal(find.getSnapshot().status, "searching"); assert.equal(workspace.document(documentId).text(), "xcat");
        find.cancel(); assert.equal(find.getSnapshot().status, "cancelled"); assert.equal(comparison.advance().status, "ready");
        assert.deepEqual(errors, []);
    } finally {
        stops.forEach(stop => stop()); find.dispose(); comparison.dispose(); view.dispose(); workspace.close(tab);
        assert.equal(tasks.size, 0); assert.equal(workspace.diagnostics().subscriptions, 0); assert.equal(workspace.diagnostics().leases, 0);
    }
});

test("changing whole-word mode cancels captured replacement and excludes selected substring matches", () => {
    const workspace = new Workspace(), original = "cat scatter cat_ cat", documentId = workspace.createDocument({ scope: "find", resource: "options", variant: "working" }, "Source", original);
    const tab = workspace.open({ kind: "text", documentId }, "left"), view = workspace.createDocumentView(documentId);
    const tasks = new Map<number, () => void>(); let serial = 0, focused = 0;
    const owner = Object.assign(new EventTarget(), { defaultView: { performance,
        setTimeout: (work: () => void) => { tasks.set(++serial, work); return serial; }, clearTimeout: (id: number) => tasks.delete(id) } });
    const editor = { view, element: { ownerDocument: owner }, input: Object.assign(new EventTarget(), { readOnly: false }), activity: () => ({ composing: false, disposed: false }),
        viewport: { revealOffset: () => {} }, focus: () => { focused++; } } satisfies FindHost;
    const find = createFindController(workspace, tab, editor);
    const drain = () => { for (let turns = 0; tasks.size; turns++) { assert.ok(turns < 100); const [id, work] = tasks.entries().next().value!; tasks.delete(id); work(); } };
    try {
        find.setQuery("cat"); drain(); assert.equal(find.getSnapshot().count, 4);
        const before = workspace.document(documentId), history = workspace.observeHistory(documentId).getSnapshot();
        find.replaceAll("changed"); assert.equal(find.getSnapshot().status, "replacing");
        find.setFlags({ wholeWord: true }); drain();
        assert.equal(find.getSnapshot().wholeWord, true); assert.equal(find.getSnapshot().count, 2);
        assert.equal(workspace.document(documentId).revision, before.revision); assert.deepEqual(workspace.observeHistory(documentId).getSnapshot(), history); assert.equal(focused, 0);
        view.setSelection(before.revision, { anchor: 5, head: 8 });
        assert.equal(find.replaceCurrent("dog"), true); drain();
        assert.equal(workspace.document(documentId).revision, before.revision + 1);
        assert.equal(view.getSnapshot().selection.anchor, 0);
        assert.equal(view.getSnapshot().selection.head, 3);
        assert.equal(workspace.document(documentId).buffer.slice(0, original.length), "cat scatter cat_ dog");
        assert.equal(workspace.observeHistory(documentId).getSnapshot().undoDepth, history.undoDepth + 1);
        assert.equal(find.getSnapshot().wholeWord, true); assert.equal(find.getSnapshot().count, 1);
    } finally {
        find.dispose(); view.dispose(); workspace.close(tab);
        assert.equal(tasks.size, 0); assert.equal(workspace.diagnostics().views, 0); assert.equal(workspace.diagnostics().subscriptions, 0); assert.equal(workspace.diagnostics().leases, 0);
    }
});

for (const lifetime of ["destroyed", "expired", "view-disposed"] as const) for (const composing of [false, true])
    test(`current replacement stays inert after ${lifetime} with composition ${composing}`, async t => {
        const workspace = new Workspace(), documentId = workspace.createDocument({ scope: "find", resource: "source", variant: "working" }, "Source", "sample sample");
        const tab = workspace.open({ kind: "text", documentId }, "left"), view = workspace.createDocumentView(documentId, { anchor: 0, head: 6 });
        const owner = Object.assign(new EventTarget(), { defaultView: { setTimeout: (work: () => void, delay: number) => Number(setTimeout(work, delay)), clearTimeout, performance } });
        // This headless facade exercises controller ownership and notifications. Real DOM/input remains browser coverage.
        let inactive = false;
        const editor = { view, element: { ownerDocument: owner }, input: Object.assign(new EventTarget(), { readOnly: true }), activity: () => ({ composing: inactive && composing, disposed: false }),
            viewport: { revealOffset: () => { assert.equal(inactive, false, "Inactive view must not be revealed."); } },
            focus: () => { assert.equal(inactive, false, "Inactive editor must not receive focus."); } } satisfies FindHost;
        const find = createFindController(workspace, tab, editor); let stop = () => {};
        try {
            find.setQuery("sample");
            for (let turns = 0; find.getSnapshot().status !== "ready"; turns++) { assert.ok(turns < 100); await new Promise(resolve => setTimeout(resolve, 1)); }
            find.next(); assert.notEqual(find.getSnapshot().current, null); inactive = true;
            if (lifetime === "destroyed") find.dispose();
            else if (lifetime === "expired") workspace.replace(tab, { kind: "panel", resourceId: workspace.resourceForDocument(documentId).id, panelType: "configuration" });
            else view.dispose();
            const before = find.getSnapshot(), document = workspace.document(documentId), selected = view.getSnapshot(), history = workspace.observeHistory(documentId).getSnapshot();
            if (lifetime !== "view-disposed") assert.equal(before.current, null);
            assert.equal(before.reason, lifetime === "expired" ? "view-unavailable" : null);
            let notifications = 0; stop = find.subscribe(() => { notifications++; });
            const returned = find.replaceCurrent("changed"), after = find.getSnapshot();
            t.diagnostic(JSON.stringify({ lifetime, composing, returned, notifications, before, after }));
            assert.equal(returned, false); assert.strictEqual(after, before); assert.equal(notifications, 0);
            assert.strictEqual(workspace.document(documentId).buffer, document.buffer); assert.equal(workspace.document(documentId).revision, document.revision);
            assert.deepEqual(view.getSnapshot(), selected); assert.deepEqual(workspace.observeHistory(documentId).getSnapshot(), history);
        } finally {
            stop(); find.dispose(); view.dispose(); workspace.close(tab);
            assert.equal(workspace.diagnostics().views, 0); assert.equal(workspace.diagnostics().subscriptions, 0); assert.equal(workspace.diagnostics().leases, 0);
        }
    });

test("case options retain raw Unicode matches, cancel captured plans and preserve complete shared history", () => {
    const workspace = new Workspace(), original = "K k K_ 𐐀 𐐨 café café SS ß", documentId = workspace.createDocument({ scope: "find", resource: "case", variant: "working" }, "Source", original);
    const tab = workspace.open({ kind: "text", documentId }, "left"), view = workspace.createDocumentView(documentId), peer = workspace.createDocumentView(documentId);
    const tasks = new Map<number, () => void>(); let serial = 0;
    const owner = Object.assign(new EventTarget(), { defaultView: { performance,
        setTimeout: (work: () => void) => { tasks.set(++serial, work); return serial; }, clearTimeout: (id: number) => tasks.delete(id) } });
    const editor = { view, element: { ownerDocument: owner }, input: Object.assign(new EventTarget(), { readOnly: false }), activity: () => ({ composing: false, disposed: false }),
        viewport: { revealOffset: () => {} }, focus: () => {} } satisfies FindHost;
    const find = createFindController(workspace, tab, editor), text = () => { const buffer = workspace.document(documentId).buffer; return buffer.slice(0, buffer.length); };
    const runOne = () => { const [id, work] = tasks.entries().next().value!; tasks.delete(id); work(); };
    const drain = () => { for (let turns = 0; tasks.size; turns++) { assert.ok(turns < 100); runOne(); } };
    try {
        find.setQuery("k"); assert.equal(find.getSnapshot().matchCase, true);
        find.setFlags({ matchCase: false }); drain(); assert.equal(find.getSnapshot().count, 3);
        const before = workspace.document(documentId), history = workspace.observeHistory(documentId).getSnapshot();
        find.replaceAll("x"); find.setFlags({ matchCase: false, wholeWord: true }); drain();
        assert.equal(find.getSnapshot().count, 2); assert.equal(workspace.document(documentId), before); assert.deepEqual(workspace.observeHistory(documentId).getSnapshot(), history);
        view.setSelections(before.revision, [{ anchor: 0, head: 1 }, { anchor: original.length, head: original.length }]);
        const set = view.getSnapshot().selectionSet;
        assert.equal(find.replaceCurrent("x"), true);
        // A caret move while the updated match index is pending takes precedence.
        view.setSelection(workspace.document(documentId).revision, { anchor: 3, head: 3 });
        const moved = view.getSnapshot().selectionSet;
        drain(); assert.equal(text(), "x" + original.slice(1));
        assert.strictEqual(view.getSnapshot().selectionSet, moved);
        assert.equal(workspace.observeHistory(documentId).getSnapshot().undoDepth, history.undoDepth + 1);
        assert.equal(workspace.undo({ documentId, expectedRevision: workspace.document(documentId).revision }).applied, true); drain();
        assert.equal(text(), original); assert.deepEqual(view.getSnapshot().selectionSet, set);
        find.setQuery("𐐨"); drain(); assert.equal(find.getSnapshot().count, 2); assert.equal(find.next(), true);
        assert.equal(view.getSnapshot().selection.anchor, original.indexOf("𐐀")); assert.equal(view.getSnapshot().selection.head, original.indexOf("𐐀") + 2);
        find.replaceAll("Ω"); drain(); assert.equal(text(), original.replace("𐐀", "Ω").replace("𐐨", "Ω"));
        assert.equal(workspace.undo({ documentId, expectedRevision: workspace.document(documentId).revision }).applied, true); drain(); assert.equal(text(), original);
        const many = "K k K_\n".repeat(1100);
        workspace.edit({ documentId, expectedRevision: workspace.document(documentId).revision, origin: "human", edits: [{ from: 0, to: original.length, insert: many }] });
        find.setFlags({ matchCase: false, wholeWord: false }); find.setQuery("k"); drain(); assert.equal(find.getSnapshot().count, 3300);
        find.next(-1); assert.equal(view.getSnapshot().selection.anchor, many.lastIndexOf("K"));
        const revision = workspace.document(documentId).revision; find.replaceAll("x"); runOne();
        const primary = view.getSnapshot().selection;
        view.setSelections(revision, [primary, { anchor: many.length, head: many.length }]); drain();
        assert.equal(workspace.document(documentId).revision, revision); assert.equal(text(), many);
        const complete = view.getSnapshot().selectionSet, depth = workspace.observeHistory(documentId).getSnapshot().undoDepth;
        find.replaceAll("x"); drain(); assert.equal(text(), "x x x_\n".repeat(1100)); assert.equal(workspace.observeHistory(documentId).getSnapshot().undoDepth, depth + 1);
        assert.equal(workspace.undo({ documentId, expectedRevision: workspace.document(documentId).revision }).applied, true); drain(); assert.equal(text(), many); assert.deepEqual(view.getSnapshot().selectionSet, complete);
        assert.equal(workspace.document(documentId).buffer.readMetrics().textExports, 0);
    } finally {
        find.dispose(); view.dispose(); peer.dispose(); workspace.close(tab);
        assert.equal(tasks.size, 0); assert.equal(workspace.diagnostics().subscriptions, 0); assert.equal(workspace.diagnostics().leases, 0); assert.equal(workspace.diagnostics().views, 0);
    }
});
