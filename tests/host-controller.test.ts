import test from "node:test";
import assert from "node:assert/strict";
import { HostController } from "../examples/hosts/controller.ts";

test("host disposal waits for accepted queued state and in-flight command settlement", async () => {
    const host = new HostController(); host.demonstrateOrdering();
    assert.equal(host.settings.getSnapshot().mode, "preview");
    await host.dispose();
    assert.equal(host.settings.getSnapshot().mode, "inspect");
    const stopped = host.debug(); assert.equal(stopped.pendingCommands, 0); assert.equal(stopped.diagnostics.leases, 0);
    assert.equal(stopped.activity.lastRun, null); assert.equal(stopped.disposed, true);
    await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(host.debug(), stopped);
    host.demonstrateOrdering(); host.startBackground(); await host.dispose(); assert.deepEqual(host.debug(), stopped);
});

test("parallel Run captures, denied submission and older results keep independent counts and targets", async () => {
    const host = new HostController();
    try {
        const first = host.run(); host.setPath("second.csv");
        host.workspace.edit({ documentId: host.source.documentId, expectedRevision: 0, origin: "human", edits: [{ from: 0, to: 5, insert: "second source" }] });
        const second = host.run();
        assert.equal(host.debug().activity.pendingRuns, 2);
        assert.deepEqual(host.runCapture(0), { source: "start", configuration: { path: "source.csv", format: "csv" }, settings: { mode: "preview" } });
        assert.deepEqual(host.runCapture(1), { source: "second source", configuration: { path: "second.csv", format: "csv" }, settings: { mode: "preview" } });
        host.workspace.setCapabilities(host.source.id, { edit: ["human", "host", "agent"], save: true, run: false });
        await host.run(); assert.equal(host.debug().activity.pendingRuns, 2); assert.equal(host.debug().activity.errors, 1);
        const latest = host.debug().activity.lastRun;
        host.finishRun(); await first;
        assert.equal(host.debug().activity.pendingRuns, 1); assert.equal(host.debug().activity.completedRuns, 1);
        assert.deepEqual(host.debug().activity.lastRun, latest);
        host.failRun(); await second;
        assert.equal(host.debug().activity.pendingRuns, 0); assert.equal(host.debug().activity.completedRuns, 1);
        assert.equal(host.debug().activity.errors, 2); assert.equal(host.debug().pendingCommands, 0); assert.equal(host.debug().diagnostics.leases, 0);
    } finally { await host.dispose(); }
});
