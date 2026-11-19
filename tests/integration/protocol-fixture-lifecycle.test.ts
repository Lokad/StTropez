import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { Workspace } from "../../src/index.ts";
import { openWebSocketTransport } from "../../src/browser/index.ts";
import { FixtureLspWorkspace } from "../../fixtures/protocol/fixture-workspace.ts";
import { closePackageServer, listenPackageServer } from "../../scripts/package-host.mjs";
import { withProtocolFixture } from "../helpers/protocol-fixture.ts";

test("partial protocol setup releases the listener and leases while preserving setup and cleanup failures", { timeout: 15000 }, async t => {
    const primary = new Error("Later client setup failed"), cleanup = new Error("Scope cleanup reported failure"), order: string[] = [];
    let retired: Server | undefined, acquired: FixtureLspWorkspace | undefined, port = 0;
    t.after(async () => { acquired?.dispose(); if (retired) await closePackageServer(retired); });
    await assert.rejects(withProtocolFixture(async ({ url, server, defer }) => {
        retired = server; port = Number(new URL(url).port);
        const workspace = new Workspace(), source = workspace.createTextResource({ scope: "cleanup", resource: "source", variant: "working" }, "Source", { value: "sample" });
        defer(() => { order.push("leases"); assert.equal(workspace.diagnostics().leases, 0); });
        const owner = new FixtureLspWorkspace(workspace, {
            connect: () => openWebSocketTransport(url), features: ["textDocument/hover"],
            documentInfo: document => ({ uri: `fixture:${document.resourceId}`, languageId: "fixture" }),
            schedule: (ms, callback) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
        });
        acquired = owner;
        defer(() => { order.push("owner"); owner.dispose(); });
        const scope = owner.createScope();
        defer(() => { order.push("scope"); scope.dispose(); throw cleanup; });
        scope.setDocuments([workspace.document(source.documentId)]); await scope.ensureConnected();
        assert.ok(workspace.diagnostics().leases > 0);
        throw primary;
    }), error => {
        assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [primary, cleanup]); return true;
    });
    assert.deepEqual(order, ["scope", "owner", "leases"]);
    assert.ok(retired); assert.equal(retired.listening, false); assert.equal(retired.listenerCount("upgrade"), 0);
    const rebound = createServer(); t.after(() => closePackageServer(rebound));
    await listenPackageServer(rebound, port);
});
