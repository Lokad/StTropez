import { isolatedTest as test, expect } from "./fixtures.ts";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import type { JSHandle } from "@playwright/test";
import { WebSocketServer } from "ws";
import { closePackageServer, listenPackageServer } from "../../scripts/package-host.mjs";
// Qualify the wire path with explicit process ownership; Firefox context deletion remains unqualified.

test.beforeEach(async ({ page }) => {  await page.goto("/protocol/"); await page.waitForFunction(() => window.protocolFixture?.ready); });
test("JSON-RPC wire foundation uses the reference peer over real WebSockets without worker fallback", async ({ page }) => {
    const state = await page.evaluate(() => window.protocolFixture.exercise());
    // Feature owners qualify their capabilities; the wire owner permits additive capabilities.
    expect(state.initialization).toMatchObject({ capabilities: { positionEncoding: "utf-16", textDocumentSync: 2 }, serverInfo: { name: "Generic protocol fixture" } });
    expect(state.echoed).toEqual(state.payload); expect(state.roundtrip).toEqual(state.payload); expect(state.notice).toEqual(state.payload);
    expect(state.rejection).toBe(-32001); expect(state.before).toEqual({ held: 1, initialized: true }); expect(state.after).toEqual({ held: 0, initialized: true });
    expect(state.cancelled).toBe(true); expect(state.disconnected).toBe(true); expect(state.reconnect).toEqual({ fresh: true }); expect(state.timers).toBe(0);
    expect(state.released).toEqual({ disposed: true, pendingRequests: 0, incomingRequests: 0, requestHandlers: 0, notificationHandlers: 0 }); expect(page.workers()).toHaveLength(0);
});
test("binary messages close the text transport and release pending requests", async ({ page }) => {
    let closed = 0; page.on("websocket", socket => socket.on("close", () => { closed++; }));
    const state = await page.evaluate(() => window.protocolFixture.binaryRejection()); expect(state.reason).toContain("text messages");
    expect(state.snapshot).toEqual({ disposed: true, pendingRequests: 0, incomingRequests: 0, requestHandlers: 0, notificationHandlers: 0 }); expect(state.timers).toBe(0);
    await expect.poll(() => closed).toBe(1);
});
test("a host pre-protocol text message precedes initialize on every WebSocket connection", async ({ page }) => {
    const connections: string[][] = [];
    page.on("websocket", socket => { const sent: string[] = []; connections.push(sent); socket.on("framesent", frame => sent.push(frame.payload.toString())); });
    const state = await page.evaluate(() => window.protocolFixture.preProtocolJourney());
    expect(state.attempts).toBe(2); expect(state.first).toEqual({ held: 0, initialized: true }); expect(state.second).toEqual(state.first);
    expect(connections).toHaveLength(2);
    for (const sent of connections) {
        expect(sent[0]).toBe("fixture pre-protocol message"); expect(sent.filter(text => text === sent[0])).toHaveLength(1);
        const messages = sent.slice(1).map(text => JSON.parse(text)); expect(messages[0].method).toBe("initialize");
        expect(messages.filter(message => message.method === "initialize")).toHaveLength(1);
    }
    expect(state.timers).toBe(0); expect(state.ownership).toMatchObject({ subscriptions: 0, scheduledTasks: 0, pendingRequests: 0, incomingRequests: 0 });
});
test("disposing a session during a held WebSocket handshake releases pending ownership", async ({ page, browserName, browserErrors }, testInfo) => {
    // Withhold HTTP 101: cancellation must run while the native socket is CONNECTING.
    const server = createServer(), sockets = new Set<Duplex>(), failures: Error[] = []; let upgrades = 0, closed = 0, received = 0;
    const peer = new WebSocketServer({ noServer: true }); let finishHandshake: (() => void) | undefined, disposalStarted = false;
    const recordError = (error: Error) => {
        // A browser can abort its opening TCP connection with a reset instead of FIN.
        if (disposalStarted && "code" in error && error.code === "ECONNRESET") return;
        failures.push(error);
    };
    server.on("upgrade", (request, socket, head) => {
        upgrades++; sockets.add(socket);
        finishHandshake = () => {
            if (socket.destroyed || socket.readableEnded) return;
            peer.handleUpgrade(request, socket, head, connection => {
                connection.on("message", () => { received++; });
                connection.on("error", recordError);
            });
        };
        socket.on("error", recordError);
        // HTTP upgrades transfer the half-open socket to this fixture. Finish our side
        // only after the browser ends its side.
        socket.once("end", () => socket.end());
        socket.once("close", () => { sockets.delete(socket); closed++; });
        socket.resume();
    });
    let session: JSHandle<ReturnType<Window["protocolFixture"]["openingSession"]>> | undefined;
    try {
        await listenPackageServer(server); const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing handshake listener.");
        const endpoint = new URL(`ws://127.0.0.1:${address.port}/held-handshake`);
        const script = new URL("/protocol-fixture.js", page.url()).href;
        if (browserName === "webkit") browserErrors.allowConsoleError(
            `WebSocket connection to '${endpoint.href}' failed: WebSocket is closed before the connection is established.`, script);
        if (browserName === "firefox") {
            // Firefox includes the native constructor's bundle line in its abort diagnostics.
            // Locate that line so each allowance still matches one exact message and source URL.
            const source = await (await page.request.get(script)).text();
            const lines = source.split(/\r?\n/).flatMap((line, index) => /\bnew WebSocket\(/.test(line) ? [index + 1] : []);
            expect(lines).toHaveLength(1);
            for (const message of [`Firefox can’t establish a connection to the server at ${endpoint.href}.`,
                `The connection to ${endpoint.href} was interrupted while the page was loading.`])
                browserErrors.allowConsoleError(`[JavaScript Error: "${message}" {file: "${script}" line: ${lines[0]}}]`, script);
        }
        session = await page.evaluateHandle(endpoint => window.protocolFixture.openingSession(endpoint), endpoint.href);
        await expect.poll(() => upgrades).toBe(1);
        const before = await session.evaluate(owner => owner.snapshot());
        expect(before).toMatchObject({ phase: "connecting", timers: 1,
            ownership: { documents: 1, remoteDocuments: 0, subscriptions: 1, pendingRequests: 0, incomingRequests: 0 } });
        disposalStarted = true;
        const after = await session.evaluate(owner => owner.dispose());
        expect(after).toEqual({ cancelled: true, transportCancelled: true, phase: "disposed", timers: 0,
            ownership: { documents: 0, remoteDocuments: 0, registrations: 0, subscriptions: 0, scheduledTasks: 0, pendingDocumentRequests: 0, pendingRequests: 0, incomingRequests: 0 } });
        // Firefox can retain the native connection until the opening handshake finishes.
        // A late HTTP 101 must not resurrect the disposed session or send initialize.
        expect(finishHandshake).toBeDefined(); finishHandshake!();
        await expect.poll(() => closed).toBe(1);
        expect(upgrades).toBe(1); expect(received).toBe(0); expect(sockets.size).toBe(0); expect(failures).toEqual([]);
        expect(await session.evaluate(owner => owner.snapshot())).toEqual({ phase: after.phase, ownership: after.ownership, timers: after.timers });
        await testInfo.attach("held-handshake", { body: JSON.stringify({ before, after, upgrades, closed, received }), contentType: "application/json" });
    } finally {
        try { await session?.evaluate(owner => owner.dispose()); await session?.dispose(); }
        finally { for (const connection of peer.clients) connection.terminate(); peer.close(); for (const socket of sockets) socket.destroy(); await closePackageServer(server); }
    }
});
for (const large of [false, true]) test(`LSP session synchronizes ${large ? "sparse-edit" : "mixed-newline"} documents and owns registration/reconnect`, async ({ page }, testInfo) => {
    const state = await page.evaluate(large => window.protocolFixture.sessionJourney(large), large);
    expect(state.remote).toEqual({ uri: state.uri, version: 2, length: state.length, text: state.expectedSample, syncFailures: [] });
    expect(state.boundedReads.before).toBeLessThan(128); expect(state.boundedReads.after).toBeLessThan(128);
    expect(state.sent).toHaveLength(1); expect(state.sent[0]!.count).toBe(large ? 2 : 1); expect(state.sent[0]!.units).toBeLessThan(32);
    if (large) expect(state.tail).toMatchObject({ text: state.expectedTail, version: 2, syncFailures: [] });
    expect(state.available).toBe(true); expect(state.withdrawn).toBe(true); expect(state.fresh).toBe(true);
    expect(state.hover).toMatchObject({ contents: { kind: "plaintext", value: expect.stringContaining(state.uri) } }); expect(state.custom).toEqual({ uri: state.uri, extension: "host-owned" });
    expect(state.reopened).toMatchObject({ uri: state.uri, version: 1, text: state.expectedReopened, syncFailures: [] });
    expect(state.ownership).toEqual({ documents: 0, remoteDocuments: 0, registrations: 0, subscriptions: 0, scheduledTasks: 0, pendingDocumentRequests: 0, pendingRequests: 0, incomingRequests: 0 });
    expect(state.timers).toBe(0); expect(page.workers()).toHaveLength(0);
    await testInfo.attach("synchronization", { body: JSON.stringify({ large, sent: state.sent, reads: state.boundedReads, ...state.diagnostic }), contentType: "application/json" });
});
