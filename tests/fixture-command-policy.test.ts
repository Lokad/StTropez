import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { attachProtocolFixture } from "../fixtures/protocol/fixture-server.ts";
import { FixtureLspWorkspace } from "../fixtures/protocol/fixture-workspace.ts";
import { Workspace } from "../src/index.ts";
import { openWebSocketTransport } from "../src/browser/index.ts";
import { RpcError } from "../src/protocol/index.ts";
import type { JsonValue } from "../src/protocol/index.ts";

const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const cancelled = (error: unknown) => error instanceof RpcError && error.code === -32800;
type Packet = { id?: number; method?: string; params?: { id?: number; command?: string; arguments?: JsonValue[]; _fixture?: unknown } };
async function fixture() {
    const server = createServer(), detach = attachProtocolFixture(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    const workspace = new Workspace(), sent: Packet[] = [], transitions: string[] = [];
    let intercept: ((deliver: () => void) => void) | undefined;
    const owner = new FixtureLspWorkspace(workspace, {
        connect: async () => {
            const transport = await openWebSocketTransport(`ws://127.0.0.1:${address.port}/lsp-fixture`);
            return { dispose: () => transport.dispose(), send: message => { sent.push(JSON.parse(message)); transport.send(message); },
                subscribe: listener => transport.subscribe({ ...listener, message: message => {
                    const packet = JSON.parse(message) as Packet;
                    if (packet.method === "client/registerCapability" || packet.method === "client/unregisterCapability") {
                        transitions.push(packet.method); const hold = intercept; intercept = undefined;
                        if (hold) { hold(() => listener.message(message)); return; }
                    }
                    listener.message(message);
                } }) };
        },
        features: ["workspace/executeCommand"], applyEdit: true, rpc: { maxPending: 128 },
        documentInfo: doc => ({ uri: `host+fixture:${doc.resourceId}`, languageId: "fixture" }),
        schedule: (ms, callback) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
    });
    const first = owner.createScope(), second = owner.createScope();
    return { owner, first, second, sent, transitions, holdNext() {
        assert.equal(intercept, undefined); const entered = gate(); let deliver: (() => void) | undefined;
        intercept = forward => { deliver = forward; entered.release(); };
        return { entered: entered.promise, release: () => { const forward = deliver; deliver = undefined; forward?.(); } };
    }, async dispose() {
        owner.dispose(); detach(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        assert.equal(workspace.diagnostics().leases, 0);
    } };
}

test("fixture review registration serializes acknowledgements, bounds pending work and distinguishes queued from dispatched cancellation", { timeout: 15000 }, async () => {
    const f = await fixture(), register = (registered: boolean) => f.first.request("fixture/reviewRegistration", { registered });
    try {
        await f.first.connect(); await f.second.connect();
        const held = f.holdNext(), first = register(true), others = Array.from({ length: 63 }, () => f.second.request("fixture/reviewRegistration", { registered: true }));
        const results = Promise.allSettled([first, ...others].map(call => call.result));
        await Promise.race([held.entered, first.result.then(() => assert.fail("Registration completed before its held acknowledgement"))]);
        await assert.rejects(register(true).result, error => error instanceof RpcError && error.code === -32000);
        assert.deepEqual(f.transitions, ["client/registerCapability"]); held.release();
        for (const result of await results) { assert.equal(result.status, "fulfilled"); if (result.status === "fulfilled") assert.deepEqual(result.value, { registered: true }); }
        assert.ok(f.first.commandNames().includes("fixture.review"));

        // Cancellation after dispatch cannot release the transition before its acknowledgement.
        const withdrawing = f.holdNext(), withdraw = register(false), withdrew = assert.rejects(withdraw.result, cancelled);
        await withdrawing.entered; withdraw.cancel(); await withdrew;
        let restored = false;
        const restore = register(true).result.then(value => { restored = true; return value; });
        const discarded = register(false), rejected = assert.rejects(discarded.result, cancelled); discarded.cancel(); await rejected;
        await f.second.request("fixture/state").result;
        assert.equal(restored, false); assert.deepEqual(f.transitions, ["client/registerCapability", "client/unregisterCapability"]);
        withdrawing.release(); assert.deepEqual(await restore, { registered: true });
        // A barrier through the same queue proves the cancelled queued withdrawal never dispatches.
        assert.deepEqual(await register(true).result, { registered: true });
        assert.deepEqual(f.transitions, ["client/registerCapability", "client/unregisterCapability", "client/registerCapability"]);
        await assert.rejects(f.first.request("fixture/reviewRegistration", { registered: false, _fixture: { delay: 0, fault: "failure" } }).result,
            error => error instanceof RpcError && error.code === -32001);
        assert.ok(f.first.commandNames().includes("fixture.review"));
        assert.deepEqual(await register(false).result, { registered: false }); assert.equal(f.first.commandNames().includes("fixture.review"), false);
        for (const params of [{}, { registered: 1 }, { registered: true, _fixture: { delay: -1 } }]) await assert.rejects(
            f.first.request("fixture/reviewRegistration", params).result, error => error instanceof RpcError && error.code === -32602);
    } finally { await f.dispose(); }
});

test("fixture command policy preserves authorized arguments, request ids and cancellation without leaking across scopes or reconnect", { timeout: 15000 }, async () => {
    const f = await fixture(), command = "fixture.status", args = [{ uri: "host+fixture:source", opaque: { note: "😀" } }];
    const authorization = { command, arguments: args, isCurrent: () => true };
    const commands = () => f.sent.filter(packet => packet.method === "workspace/executeCommand");
    try {
        await f.first.connect(); await f.second.connect();
        const policy = { delay: 0, fault: "failure" };
        await f.owner.prepareCommand(f.first, command, policy); policy.fault = "ack";
        await f.owner.prepareCommand(f.second, command, { delay: 0 });
        const successful = f.second.requestCommand(command, args, undefined, authorization);
        assert.equal(commands().at(-1)!.id, successful.id); assert.deepEqual(await successful.result, { documents: 0 });
        const failed = f.first.requestCommand(command, args, undefined, authorization);
        assert.equal(commands().at(-1)!.id, failed.id);
        await assert.rejects(failed.result, error => error instanceof RpcError && error.code === -32001);
        assert.deepEqual(commands().map(packet => packet.params?._fixture), [{ delay: 0 }, { delay: 0, fault: "failure" }]);
        assert.ok(commands().every(packet => JSON.stringify(packet.params?.arguments) === JSON.stringify(args)));
        const receipt = await f.first.request("fixture/lastCommand").result;
        assert.ok(receipt !== null && typeof receipt === "object" && "arguments" in receipt); assert.deepEqual(receipt.arguments, args);

        await f.owner.prepareCommand(f.first, command, { delay: 0, fault: "failure" });
        const before = commands().length;
        assert.throws(() => f.first.requestCommand(command, [], undefined, authorization), error => error instanceof RpcError && error.code === -32601);
        assert.equal(commands().length, before);
        assert.deepEqual(await f.first.requestCommand(command).result, { documents: 0 }); assert.equal(commands().at(-1)!.params?._fixture, undefined);
        await f.owner.prepareCommand(f.first, command, { delay: 0, fault: "failure" }); f.first.disconnect(); await f.first.connect();
        assert.deepEqual(await f.first.requestCommand(command).result, { documents: 0 });

        await f.owner.prepareCommand(f.first, command, { delay: 1000, fault: "failure" });
        const delayed = f.first.requestCommand(command, args), rejected = assert.rejects(delayed.result, cancelled);
        delayed.cancel(); await rejected;
        assert.ok(f.sent.some(packet => packet.method === "$/cancelRequest" && packet.params?.id === delayed.id));
        assert.equal(f.owner.state.getSnapshot().commandRequiresReconnect, true);
        f.owner.disconnect(); await f.first.connect();
        assert.deepEqual(await f.first.requestCommand(command).result, { documents: 0 }); assert.equal(commands().at(-1)!.params?._fixture, undefined);
        assert.ok(f.sent.every(packet => packet.params?._fixture === undefined || packet.method === "workspace/executeCommand"));
    } finally { await f.dispose(); }
});
