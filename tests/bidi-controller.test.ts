import test from "node:test";
import assert from "node:assert/strict";
import { createBidiIndexController, TextBuffer, Workspace } from "../src/index.ts";
import type { BidiIndexController } from "../src/index.ts";
const finish = (controller: BidiIndexController) => { let s = controller.getSnapshot(); while (s.status === "running") s = controller.advance(4096); assert.equal(s.status, "ready"); return s; };
function fixture(text = "abc אבג\r\nsecond") {
    const workspace = new Workspace(), resource = workspace.createTextResourceFromBuffer({ scope: "bidi", resource: "source", variant: "working" }, "Source", { buffer: TextBuffer.from(text), serverVersion: "1" });
    const tab = workspace.open({ kind: "text", documentId: resource.documentId }, "main"), controller = createBidiIndexController(workspace, tab);
    return { workspace, resource, tab, controller, edit: () => workspace.edit({ documentId: resource.documentId, expectedRevision: workspace.document(resource.documentId).revision, origin: "host", edits: [{ from: 0, to: 0, insert: "!" }] }) };
}

test("bidi controllers expose stable observable handles, captured ranges and retained immutable indexes", () => {
    const { workspace, resource, tab, controller } = fixture(), subscribe = controller.subscribe, get = controller.getSnapshot;
    let calls = 0; const unsubscribe = subscribe(() => calls++), generation = controller.request({ expectedRevision: 0, from: 0, to: 9 })!; workspace.move(tab, "other");
    const state = finish(controller); assert.equal(state.revision, 0); assert.equal(state.generation, generation); assert.equal(controller.isCurrent(generation), true);
    assert.equal(state.index!.to, 9); assert.equal(state.index!.levelAt(4), 1); assert.ok(Object.isFrozen(state)); assert.ok(Object.isFrozen(state.range)); assert.ok(Object.isFrozen(state.progress));
    assert.equal(subscribe, controller.subscribe); assert.equal(get, controller.getSnapshot); assert.ok(calls > 1);
    const retained = state.index!; controller.dispose(); assert.equal(controller.isCurrent(generation), false); assert.equal(retained.levelAt(4), 1);
    assert.equal(workspace.document(resource.documentId).buffer.readMetrics().textExports, 0); assert.equal(workspace.diagnostics().leases, 0); unsubscribe();
});

test("revision changes cancel running and ready analysis instead of reusing shifted ranges", () => {
    for (const when of ["running", "ready"] as const) {
        const { controller, edit } = fixture("x".repeat(100_000) + " אבג"); const generation = controller.request({ expectedRevision: 0, from: 0, to: 100_004 })!;
        if (when === "ready") finish(controller); else assert.equal(controller.advance(256).status, "running");
        edit(); assert.equal(controller.getSnapshot().status, "stale"); assert.equal(controller.getSnapshot().index, null); assert.equal(controller.isCurrent(generation), false);
        assert.equal(controller.advance().status, "stale"); const stale = controller.getSnapshot();
        assert.equal(controller.request({ expectedRevision: 0, from: 0, to: 8 }), null); assert.equal(controller.getSnapshot(), stale);
        controller.request({ expectedRevision: 1, from: 0, to: 8 }); assert.equal(finish(controller).range!.to, 8); controller.dispose();
    }
});

test("tab replacement expires analysis even for the same document and disposal releases ownership", () => {
    const { workspace, resource, tab, controller } = fixture("x".repeat(100_000)); controller.request({ expectedRevision: 0, from: 0, to: 100_000 }); controller.advance(256);
    workspace.replace(tab, { kind: "text", documentId: resource.documentId });
    assert.equal(controller.getSnapshot().status, "expired"); assert.equal(controller.getSnapshot().index, null); assert.throws(() => controller.request({ expectedRevision: 0, from: 0, to: 4 }));
    controller.dispose(); controller.dispose(); assert.equal(workspace.diagnostics().leases, 0); assert.equal(controller.advance().status, "disposed");
});

test("unrelated resources and metadata do not restart analysis; cancellation publishes no partial result", () => {
    const { workspace, resource, controller } = fixture("x".repeat(100_000)), other = workspace.createDocument({ scope: "bidi", resource: "other", variant: "working" }, "Other", "other");
    controller.request({ expectedRevision: 0, from: 0, to: 100_000 }); const state = controller.advance(256);
    workspace.edit({ documentId: other, expectedRevision: 0, origin: "host", edits: [{ from: 0, to: 0, insert: "!" }] });
    workspace.setCapabilities(resource.id, { edit: ["host"], save: true, run: false }); assert.equal(controller.getSnapshot(), state);
    controller.cancel(); assert.equal(controller.getSnapshot().status, "cancelled"); assert.equal(controller.getSnapshot().index, null);
    assert.equal(controller.advance().status, "cancelled"); controller.dispose();
});
