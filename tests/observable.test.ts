import test from "node:test";
import assert from "node:assert/strict";
import { NotificationScope, Store } from "../src/core/observable.ts";
import { Workspace } from "../src/index.ts";

test("a workspace reports listener exceptions by default and finishes delivery", t => {
    const report = t.mock.method(console, "error", () => {});
    const scope = new Workspace().createNotificationScope(), store = new Store(0, scope);
    const problem = new Error("observer failed");
    store.observable.subscribe(() => { throw problem; });
    let observed = 0;
    store.observable.subscribe(() => { observed = store.get(); });
    scope.publish(store, 1);
    assert.equal(observed, 1);
    assert.deepEqual(report.mock.calls.map(call => call.arguments), [[problem]]);
});

test("single-store publication preserves snapshot identity and SameValue suppression", () => {
    const scope = new NotificationScope(), initial = Object.freeze({ value: 1 }), store = new Store<unknown>(initial, scope);
    const seen: unknown[] = [], stop = store.observable.subscribe(() => seen.push(store.get()));
    try {
        scope.publish(store, initial); assert.deepEqual(seen, []);
        const next = Object.freeze({ value: 1 }); scope.publish(store, next); scope.publish(store, next);
        assert.equal(seen.length, 1); assert.equal(seen[0], next); assert.equal(store.observable.getSnapshot(), next);
        scope.publish(store, NaN); scope.publish(store, NaN); scope.publish(store, 0); scope.publish(store, -0);
        assert.deepEqual(seen, [next, NaN, 0, -0]);
    } finally { stop(); stop(); }
    scope.publish(store, initial); assert.equal(seen.length, 4); assert.equal(scope.subscriptionCount(), 0);
});

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
        a.clearSnapshotListeners();
        assert.equal(scope.subscriptionCount(), 2);
        order.length = 0;
        publish(5);
        assert.deepEqual(order, ["broken", "tail"]);
    } finally { [...stops, ...sharedStops, stopLate].forEach(stop => { stop(); stop(); }); }
    assert.equal(scope.subscriptionCount(), 0);
});

test("nested controller publications deliver their new state while sharing the parent write guard", () => {
    const errors: unknown[] = [], parent = new NotificationScope(error => errors.push(error)), child = new NotificationScope(error => errors.push(error), parent);
    const source = new Store(0, parent), derived = new Store(0, child), seen: number[][] = [];
    const shared = () => { seen.push([source.get(), derived.get()]); assert.throws(() => parent.assertWritable(), /Reentrant/); assert.throws(() => child.assertWritable(), /Reentrant/); };
    const stops = [source.observable.subscribe(shared), derived.observable.subscribe(shared), source.observable.subscribe(() => {
        child.publish(derived, source.get() * 2);
    })];
    try {
        parent.publish(source, 1);
        assert.deepEqual(seen, [[1, 0], [1, 2]]); assert.deepEqual(errors, []);
        assert.doesNotThrow(() => parent.assertWritable()); assert.doesNotThrow(() => child.assertWritable());
    } finally { stops.forEach(stop => stop()); }
    assert.equal(parent.subscriptionCount(), 0); assert.equal(child.subscriptionCount(), 0);
});

test("nested scope batches deliver final state once with captured registrations and each listener's error policy", () => {
    const parentErrors: unknown[] = [], childErrors: unknown[] = [], order: string[] = [];
    const parent = new NotificationScope(error => parentErrors.push(error));
    const child = new NotificationScope(error => { childErrors.push(error); throw new Error("reporter"); }, parent);
    const independent = new NotificationScope(() => {}), outside = new Store(0, independent);
    const a = new Store(0, parent), b = new Store(0, child), failure = new Error("listener");
    const shared = () => {
        order.push("shared"); assert.deepEqual([a.get(), b.get()], [2, 3]);
        assert.throws(() => child.batch(() => {}), /Reentrant/);
    };
    const broken = () => { order.push("broken"); throw failure; };
    const stops = [a.observable.subscribe(shared), b.observable.subscribe(shared), b.observable.subscribe(broken),
        a.observable.subscribe(broken), outside.observable.subscribe(() => order.push("outside"))];
    let stopLate = () => {};
    try {
        const result = child.batch(() => {
            child.publish(b, 1); stops[1]!();
            stopLate = b.observable.subscribe(() => order.push("late"));
            parent.batch(() => { parent.publish(a, 2); child.publish(b, 3); });
            assert.deepEqual(order, []);
            independent.publish(outside, 1); assert.deepEqual(order, ["outside"]);
            return 7;
        });
        assert.equal(result, 7); assert.deepEqual(order, ["outside", "shared", "broken", "late"]);
        assert.deepEqual(parentErrors, []); assert.deepEqual(childErrors, [failure]);
        assert.doesNotThrow(() => parent.assertWritable());
    } finally { stops.forEach(stop => stop()); stopLate(); }
    assert.equal(parent.subscriptionCount() + child.subscriptionCount() + independent.subscriptionCount(), 0);
});

test("a failed synchronous batch publishes committed workspace changes and releases the notification boundary", () => {
    const workspace = new Workspace(), scope = workspace.createNotificationScope();
    const source = workspace.createTextResource({ scope: "batch", resource: "source", variant: "working" }, "Source", { value: "a" });
    const seen: string[] = [], failure = new Error("command");
    const stop = source.subscribe(() => {
        seen.push(workspace.document(source.documentId).text());
        assert.throws(() => scope.batch(() => workspace.setCapabilities(source.id, { edit: [], save: false })), /Reentrant/);
    });
    const edit = (revision: number, insert: string) => workspace.edit({ documentId: source.documentId, expectedRevision: revision,
        origin: "human", edits: [{ from: 0, to: 1, insert }] });
    try {
        assert.throws(() => scope.batch(() => { edit(0, "b"); assert.deepEqual(seen, []); throw failure; }), error => error === failure);
        assert.deepEqual(seen, ["b"]);
        edit(1, "c"); assert.deepEqual(seen, ["b", "c"]);
    } finally { stop(); workspace.releaseResource(source.id, true); }
});
