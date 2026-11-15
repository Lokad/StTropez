import test from "node:test";
import assert from "node:assert/strict";
import { NotificationScope, Store } from "../src/core/observable.ts";
import { Workspace } from "../src/index.ts";

test("one shared observer sees the complete atomic edit and each history publication once", () => {
    const errors: unknown[] = [], workspace = new Workspace({ onListenerError: error => errors.push(error) });
    const sources = ["a", "b"].map(name => workspace.createTextResource({ scope: "test", resource: name, variant: "text" }, name, { value: name }));
    const views = sources.map(source => workspace.createDocumentView(source.documentId, { anchor: 1, head: 1 }));
    const channels = sources.flatMap((source, i) => [source, source.metadata, workspace.observeDocument(source.documentId),
        workspace.observeHistory(source.documentId), views[i]!, views[i]!.folding]);
    const observations: { text: string[]; revisions: number[]; heads: number[]; viewRevisions: number[] }[] = [];
    const observe = () => observations.push({ text: sources.map(source => { const buffer = workspace.document(source.documentId).buffer; return buffer.slice(0, buffer.length); }),
        revisions: sources.map(source => workspace.document(source.documentId).revision), heads: views.map(view => view.getSnapshot().selection.head),
        viewRevisions: views.map(view => view.getSnapshot().revision) });
    let published = 0;
    const stops = [...channels, workspace].flatMap(channel => [channel.subscribe(observe), channel.subscribe(() => { published++; })]);
    try {
        assert.equal(workspace.editDocuments(sources.map(source => ({ documentId: source.documentId, expectedRevision: 0,
            origin: "human" as const, edits: [{ from: 0, to: 0, insert: "+" }] }))).applied, true);
        assert.equal(published, channels.length + 1);
        assert.deepEqual(observations, [{ text: ["+a", "+b"], revisions: [1, 1], heads: [2, 2], viewRevisions: [1, 1] }]);
        assert.equal(workspace.undo({ documentId: sources[0]!.documentId, expectedRevision: 1 }).applied, true);
        assert.equal(observations.length, 2); assert.deepEqual(observations[1], { text: ["a", "b"], revisions: [2, 2], heads: [1, 1], viewRevisions: [2, 2] });
        assert.equal(workspace.redo({ documentId: sources[1]!.documentId, expectedRevision: 2 }).applied, true);
        assert.equal(observations.length, 3); assert.deepEqual(observations[2], { text: ["+a", "+b"], revisions: [3, 3], heads: [2, 2], viewRevisions: [3, 3] });
        assert.deepEqual(errors, []);
    } finally { stops.forEach(stop => stop()); views.forEach(view => view.dispose()); sources.forEach(source => workspace.releaseResource(source.id, true)); }
    assert.equal(workspace.diagnostics().subscriptions, 0);
});

test("delivery captures unique callbacks in order while registration changes affect the next publication", () => {
    const reported: unknown[] = [], failure = new Error("listener failed"), order: string[] = [];
    const scope = new NotificationScope(error => { reported.push(error); throw new Error("reporter failed"); });
    const a = new Store(0, scope), b = new Store(0, scope), shared = () => { order.push("shared"); assert.deepEqual([a.get(), b.get()], [1, 2]); };
    const late = () => { order.push("late"); }, broken = () => { order.push("broken"); throw failure; };
    let stopLate = () => {}, changedRegistration = false; const sharedStops: (() => void)[] = [];
    const stops = [a.observable.subscribe(() => {
        order.push("first"); assert.throws(() => scope.assertWritable(), /Reentrant/);
        if (!changedRegistration) { changedRegistration = true; sharedStops.forEach(stop => stop()); stopLate = a.observable.subscribe(late); }
    })];
    sharedStops.push(a.observable.subscribe(shared), a.observable.subscribe(shared), b.observable.subscribe(shared));
    stops.push(a.observable.subscribe(broken), b.observable.subscribe(broken), b.observable.subscribe(() => { order.push("tail"); }));
    assert.equal(scope.subscriptionCount(), 7);
    const publish = (value: number) => { const changed = new Set<Store<unknown>>(); a.set(value, changed); b.set(value + 1, changed); scope.deliver([...changed]); };
    try {
        publish(1); assert.deepEqual(order, ["first", "shared", "broken", "tail"]); assert.deepEqual(reported, [failure]);
        assert.equal(scope.subscriptionCount(), 5); assert.doesNotThrow(() => scope.assertWritable());
        order.length = 0; publish(3);
        assert.deepEqual(order, ["first", "broken", "late", "tail"]); assert.deepEqual(reported, [failure, failure]);
    } finally { [...stops, ...sharedStops, stopLate].forEach(stop => { stop(); stop(); }); }
    assert.equal(scope.subscriptionCount(), 0);
});

test("nested controller publications deliver their new state while sharing the parent write guard", () => {
    const errors: unknown[] = [], parent = new NotificationScope(error => errors.push(error)), child = new NotificationScope(error => errors.push(error), parent);
    const source = new Store(0, parent), derived = new Store(0, child), seen: number[][] = [];
    const shared = () => { seen.push([source.get(), derived.get()]); assert.throws(() => parent.assertWritable(), /Reentrant/); assert.throws(() => child.assertWritable(), /Reentrant/); };
    const stops = [source.observable.subscribe(shared), derived.observable.subscribe(shared), source.observable.subscribe(() => {
        const changed = new Set<Store<unknown>>(); derived.set(source.get() * 2, changed); child.deliver([...changed]);
    })];
    try {
        const changed = new Set<Store<unknown>>(); source.set(1, changed); parent.deliver([...changed]);
        assert.deepEqual(seen, [[1, 0], [1, 2]]); assert.deepEqual(errors, []);
        assert.doesNotThrow(() => parent.assertWritable()); assert.doesNotThrow(() => child.assertWritable());
    } finally { stops.forEach(stop => stop()); }
    assert.equal(parent.subscriptionCount(), 0); assert.equal(child.subscriptionCount(), 0);
});
