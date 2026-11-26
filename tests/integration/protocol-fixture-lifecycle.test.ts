import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { Workspace } from "../../src/index.ts";
import { BrowserLspWorkspace, openWebSocketTransport } from "../../src/browser/index.ts";
import type { RpcTransport } from "../../src/protocol/index.ts";
import { FixtureLspWorkspace } from "../fixtures/protocol/fixture-workspace.ts";
import { closePackageServer, listenPackageServer } from "../../scripts/package-host.mjs";
import { withProtocolFixture } from "../helpers/protocol-fixture.ts";

test("a cancelled browser opening releases a late transport and leaves its replacement connected", { timeout: 15000 }, async () => {
    await withProtocolFixture(async ({ url, defer }) => {
        const signals: AbortSignal[] = [];
        let started!: () => void, deliver!: (transport: RpcTransport) => void, released!: () => void;
        const firstStarted = new Promise<void>(resolve => { started = resolve; });
        const firstTransport = new Promise<RpcTransport>(resolve => { deliver = resolve; });
        const firstReleased = new Promise<void>(resolve => { released = resolve; });
        const provider = new BrowserLspWorkspace(new Workspace(), {
            connect(signal) {
                signals.push(signal);
                if (signals.length === 1) { started(); return firstTransport; }
                return openWebSocketTransport(url, { signal });
            },
        });
        defer(() => provider.dispose());
        const cancelled = assert.rejects(provider.connect(), { name: "RpcError" });
        await firstStarted;
        const replacement = provider.reconnect();
        assert.equal(signals[0]!.aborted, true);
        await cancelled;
        await replacement;
        assert.equal(signals.length, 2);
        assert.notEqual(signals[0], signals[1]);
        assert.equal(signals[1]!.aborted, false);

        let sends = 0;
        deliver({ send: () => { sends++; }, subscribe: () => () => {}, dispose: released });
        await firstReleased;
        assert.equal(sends, 0);
        const scope = provider.createScope();
        assert.deepEqual(await scope.request("fixture/echo", { fresh: true }).result, { fresh: true });
        await provider.shutdown();
    });
});

test("partial protocol setup releases the listener and leases while preserving setup and cleanup failures", { timeout: 15000 }, async t => {
    const primary = new Error("Later client setup failed"), cleanup = new Error("Scope cleanup reported failure"), order: string[] = [];
    let retired: Server | undefined, acquired: FixtureLspWorkspace | undefined, port = 0;
    t.after(async () => { acquired?.dispose(); if (retired) await closePackageServer(retired); });
    await assert.rejects(withProtocolFixture(async ({ url, server, defer }) => {
        retired = server; port = Number(new URL(url).port);
        const workspace = new Workspace(), source = workspace.createTextResource({ scope: "cleanup", resource: "source", variant: "working" }, "Source", {
            value: "sample",
            language: { uri: "fixture:source", languageId: "fixture" },
        });
        defer(() => { order.push("leases"); assert.equal(workspace.diagnostics().leases, 0); });
        const owner = new FixtureLspWorkspace(workspace, {
            connect: () => openWebSocketTransport(url), features: ["textDocument/hover"],
            schedule: (ms, callback) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
        });
        acquired = owner;
        defer(() => { order.push("owner"); owner.dispose(); });
        const scope = owner.createScope();
        defer(() => { order.push("scope"); scope.dispose(); throw cleanup; });
        scope.setDocuments([workspace.document(source.id)]); await scope.ensureConnected();
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
