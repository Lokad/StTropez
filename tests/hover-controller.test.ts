import test from "node:test";
import assert from "node:assert/strict";
import { Workspace } from "../src/index.ts";
import type { EditingCandidate } from "../src/browser/index.ts";
import { createHoverController } from "../examples/shared/language/hover-controller.ts";
import { provideHover } from "../fixtures/language/hover.ts";
import type { HoverInput } from "../fixtures/language/hover.ts";
import type { AbsoluteHover, HoverBackend } from "../examples/shared/language/hover-backend.ts";
class FixtureWorker extends EventTarget {
    readonly sent: HoverInput[] = []; terminated = false;
    postMessage(text: string): void { this.sent.push(JSON.parse(text) as HoverInput); }
    terminate(): void { this.terminated = true; }
    reply(value: unknown): void { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
}
function asynchronousBackend() {
    const calls: { revision: number; offset: number; cancelled: boolean; resolve: (value: AbsoluteHover | null) => void }[] = [];
    const listeners = new Set<() => void>(); let disposed = false;
    const backend: HoverBackend = {
        run: (document, offset) => {
            let resolve!: (value: AbsoluteHover | null) => void, pending = true;
            const result = new Promise<AbsoluteHover | null>(yes => { resolve = yes; });
            const call = { revision: document.revision, offset, cancelled: false,
                resolve: (value: AbsoluteHover | null) => { pending = false; resolve(value); } };
            calls.push(call);
            // Cancellation does not prevent the test from delivering an already computed reply.
            return { result, cancel: () => { if (pending) { pending = false; call.cancelled = true; } } };
        },
        subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        disconnect: () => {}, dispose: () => { disposed = true; }, snapshot: () => ({ connected: !disposed, transport: "lsp3.17" }),
    };
    return { backend, calls, changed: () => { for (const listener of listeners) listener(); },
        assertDisposed: () => { assert.equal(disposed, true); assert.equal(listeners.size, 0); } };
}
function fixture(text = "const café", backend?: HoverBackend) {
    const workspace = new Workspace(), documentId = workspace.createDocument({ scope: "hover", resource: "source", variant: "working" }, "Source", text), tab = workspace.open({ kind: "text", documentId }, "left"), view = workspace.createDocumentView(documentId);
    const timers = new Map<number, () => void>(), workers: FixtureWorker[] = []; let serial = 0;
    const owner = Object.assign(new EventTarget(), { defaultView: { setTimeout: (work: () => void) => { timers.set(++serial, work); return serial; }, clearTimeout: (id: number) => timers.delete(id) } });
    const editor = { view, element: { ownerDocument: owner }, input: new EventTarget(), activity: () => ({ composing: false, disposed: false }), focus: () => { throw new Error("Hover must not focus an editor."); } } as unknown as EditingCandidate;
    const hover = createHoverController(workspace, tab, editor, { ...(backend ? { backend } : {}), createWorker: () => { const worker = new FixtureWorker(); workers.push(worker); return worker as unknown as Worker; } });
    return { workspace, documentId, tab, view, hover, timers, workers, leasesBefore: workspace.diagnostics().leases, finish: () => { hover.destroy(); view.dispose(); workspace.close(tab); assert.equal(timers.size, 0); assert.equal(workspace.diagnostics().leases, 0); assert.equal(workspace.diagnostics().subscriptions, 0); } };
}
test("hover creates a lazy independent lane, rejects old responses and never edits or focuses source", () => {
    const f = fixture(), before = f.workspace.document(f.documentId), selected = f.view.getSnapshot().selectionSet;
    try {
        assert.equal(f.workers.length, 0); assert.equal(f.workspace.diagnostics().leases, f.leasesBefore);
        assert.equal(f.workspace.diagnostics().subscriptions, 0);
        assert.equal(f.hover.request(0, 1), true); const worker = f.workers[0]!, first = worker.sent[0]!; assert.equal(f.workspace.diagnostics().leases, f.leasesBefore + 1);
        assert.equal(f.hover.request(0, 8), true); const second = worker.sent[1]!; worker.reply(provideHover(first));
        assert.equal(f.hover.snapshot().stale, 1); assert.equal(f.hover.state.getSnapshot().status, "pending"); assert.equal(f.workspace.diagnostics().leases, f.leasesBefore + 1);
        worker.reply(provideHover(second)); const state = f.hover.state.getSnapshot(); assert.equal(state.status, "ready"); assert.deepEqual(state.range, { from: 6, to: 11 });
        assert.ok(Object.isFrozen(state)); assert.ok(Object.isFrozen(state.range)); assert.equal(f.workspace.diagnostics().leases, f.leasesBefore); assert.strictEqual(f.workspace.document(f.documentId), before); assert.strictEqual(f.view.getSnapshot().selectionSet, selected);
        assert.equal(f.workspace.observeHistory(f.documentId).getSnapshot().undoDepth, 0); assert.equal(before.buffer.readMetrics().textExports, 0);
        f.hover.cancel(); assert.equal(f.workspace.diagnostics().subscriptions, 0);
    } finally { f.finish(); }
    assert.equal(f.workers[0]!.terminated, true);
});

test("an asynchronous hover backend accepts absent ranges and expires its guarded result without a worker", async () => {
    const controlled = asynchronousBackend(), f = fixture("const value", controlled.backend), before = f.workspace.document(f.documentId); let live = true;
    try { assert.equal(f.hover.request(0, 2), true); controlled.calls[0]!.resolve({ revision: 0, range: null, text: "<img> literal", isCurrent: () => live }); await Promise.resolve();
        assert.equal(f.hover.state.getSnapshot().status, "ready"); assert.equal(f.hover.state.getSnapshot().range, null); assert.equal(f.workspace.diagnostics().leases, f.leasesBefore); assert.equal(f.workers.length, 0);
        live = false; controlled.changed(); await Promise.resolve(); assert.equal(f.hover.state.getSnapshot().status, "expired");
        live = true; f.hover.request(0, 2); f.view.setSelection(0, { anchor: 8, head: 8 }); await Promise.resolve(); assert.equal(controlled.calls[1]!.cancelled, true); controlled.calls[1]!.resolve({ revision: 0, range: null, text: "late" }); await Promise.resolve();
        assert.equal(f.hover.state.getSnapshot().status, "expired"); assert.equal(f.workspace.document(f.documentId), before);
    } finally { f.finish(); controlled.assertDisposed(); }
});
test("deferred invalidation releases old leases without cancelling a newer captured intent", async () => {
    const controlled = asynchronousBackend(), f = fixture("const café", controlled.backend);
    try {
        f.hover.request(0, 1); const first = controlled.calls[0]!;
        f.workspace.edit({ documentId: f.documentId, expectedRevision: 0, origin: "human", edits: [{ from: 11, to: 11, insert: "!" }] });
        assert.equal(f.hover.request(1, 2), true); await Promise.resolve(); assert.equal(f.hover.snapshot().pending, true); assert.equal(f.workspace.diagnostics().leases, f.leasesBefore + 1);
        const second = controlled.calls[1]!; assert.equal(first.cancelled, true); assert.equal(second.cancelled, false); assert.equal(second.revision, 1);
        first.resolve({ revision: 0, range: null, text: "obsolete" }); await Promise.resolve(); assert.equal(f.hover.snapshot().pending, true);
        second.resolve({ revision: 1, range: { from: 0, to: 5 }, text: "current" }); await Promise.resolve(); assert.equal(f.hover.state.getSnapshot().status, "ready");
        assert.equal(f.hover.state.getSnapshot().text, "current");
        f.hover.request(1, 2); f.view.setSelection(1, { anchor: 8, head: 8 }); await Promise.resolve(); assert.equal(f.hover.state.getSnapshot().status, "expired"); assert.equal(f.workspace.diagnostics().leases, f.leasesBefore);
        assert.equal(controlled.calls[2]!.cancelled, true);
        f.hover.request(1, 8); f.workspace.replace(f.tab, { kind: "panel", resourceId: f.workspace.resourceForDocument(f.documentId).id, panelType: "configuration" }); await Promise.resolve();
        assert.equal(f.hover.state.getSnapshot().status, "expired"); assert.equal(f.workspace.diagnostics().leases, f.leasesBefore); assert.equal(f.hover.request(1, 8), false);
        assert.equal(controlled.calls[3]!.cancelled, true); assert.equal(f.workers.length, 0);
    } finally { f.finish(); controlled.assertDisposed(); }
});
test("fold visibility expires captured symbol replies without requiring a text or selection change", async () => {
    const controlled = asynchronousBackend(), f = fixture("const alpha\r\nconst beta\r\nend", controlled.backend);
    try {
        const folds = f.view.folding, buffer = f.workspace.document(f.documentId).buffer;
        folds.setRanges(folds.getSnapshot(), [{ id: "body", from: 0, to: buffer.offsetAt(2) }]);
        f.hover.request(0, 2); const old = controlled.calls[0]!;
        folds.setCollapsed(folds.getSnapshot(), "body", true); await Promise.resolve();
        assert.equal(f.hover.state.getSnapshot().status, "expired"); assert.equal(f.workspace.diagnostics().leases, f.leasesBefore);
        assert.equal(old.cancelled, true); assert.equal(f.hover.request(0, buffer.offsetAt(1) + 2), false); assert.equal(controlled.calls.length, 1);
        f.view.setSelection(0, { anchor: buffer.offsetAt(1) + 2, head: buffer.offsetAt(1) + 2 });
        assert.equal(folds.getSnapshot().regions[0]!.collapsed, false); assert.equal(f.hover.request(0, buffer.offsetAt(1) + 2), true);
        const current = controlled.calls[1]!; assert.equal(current.offset, buffer.offsetAt(1) + 2);
        old.resolve({ revision: 0, range: { from: 0, to: 5 }, text: "folded" }); await Promise.resolve(); assert.equal(f.hover.state.getSnapshot().status, "pending");
        current.resolve({ revision: 0, range: { from: buffer.offsetAt(1), to: buffer.offsetAt(1) + 5 }, text: "revealed" }); await Promise.resolve();
        assert.equal(f.hover.state.getSnapshot().status, "ready"); assert.equal(f.hover.state.getSnapshot().text, "revealed");
        assert.equal(f.workers.length, 0); assert.equal(buffer.readMetrics().textExports, 0);
    } finally { f.finish(); controlled.assertDisposed(); }
});

test("hover aligns bounded windows, validates whole payloads, recovers workers and expires timed out requests", () => {
    const text = " ".repeat(3000) + "𐐀" + " ".repeat(2045) + "const" + " ".repeat(2042) + "𐐀" + " ".repeat(4000), f = fixture(text);
    try {
        f.hover.request(0, 5048); const worker = f.workers[0]!, input = worker.sent[0]!;
        assert.equal(input.text.length, 4096); assert.equal(input.text.startsWith("𐐀"), true); assert.equal(input.text.endsWith("𐐀"), true);
        worker.reply(provideHover(input)); assert.deepEqual(f.hover.state.getSnapshot().range, { from: 5047, to: 5052 });
        f.hover.request(0, 5048); worker.reply({ ...provideHover(worker.sent.at(-1)!), text: '<img onerror="execute()">' }); assert.equal(f.hover.state.getSnapshot().text, '<img onerror="execute()">'); // Rendering remains a browser requirement.
        f.hover.request(0, 5048); worker.reply({ ...provideHover(worker.sent.at(-1)!), range: { from: -1, to: 1 }, text: "partial" });
        assert.equal(f.hover.state.getSnapshot().status, "failed"); assert.equal(f.hover.state.getSnapshot().text, ""); assert.equal(f.workspace.diagnostics().leases, f.leasesBefore);
        f.hover.request(0, 5048); worker.reply(null); assert.equal(f.hover.state.getSnapshot().status, "failed"); assert.equal(f.workspace.diagnostics().leases, f.leasesBefore);
        f.hover.request(0, 5048); worker.dispatchEvent(new Event("error", { cancelable: true })); assert.equal(worker.terminated, true); assert.equal(f.workspace.diagnostics().leases, f.leasesBefore);
        assert.equal(f.hover.request(0, 5048), true); const retry = f.workers[1]!, late = retry.sent[0]!;
        const timeout = f.timers.values().next().value!; timeout(); assert.equal(f.hover.state.getSnapshot().status, "failed"); assert.equal(f.workspace.diagnostics().leases, f.leasesBefore);
        retry.reply(provideHover(late)); assert.equal(f.hover.state.getSnapshot().status, "failed"); assert.equal(f.hover.snapshot().stale, 1);
        assert.equal(f.workspace.document(f.documentId).buffer.readMetrics().textExports, 0);
    } finally { f.finish(); }
});
