import { isolatedTest as test, expect } from "./fixtures.ts";
// Qualify the wire path with explicit process ownership; Firefox context deletion remains unqualified.

test.beforeEach(async ({ page }) => {  await page.goto("/protocol/"); await page.waitForFunction(() => window.protocolFixture?.ready); });
test("JSON-RPC wire foundation uses the reference peer over real WebSockets without worker fallback", async ({ page }) => {
    const state = await page.evaluate(() => window.protocolFixture.exercise());
    expect(state.initialization).toEqual({ capabilities: { positionEncoding: "utf-16", textDocumentSync: 2, hoverProvider: true, completionProvider: { triggerCharacters: ["."] }, signatureHelpProvider: { triggerCharacters: ["("], retriggerCharacters: [","] }, documentLinkProvider: { resolveProvider: true }, colorProvider: true, definitionProvider: true, referencesProvider: true, renameProvider: true, codeActionProvider: { resolveProvider: true, codeActionKinds: ["quickfix", "refactor", "source"] }, executeCommandProvider: { commands: ["fixture.status"] } }, serverInfo: { name: "Generic protocol fixture" } });
    expect(state.echoed).toEqual(state.payload); expect(state.roundtrip).toEqual(state.payload); expect(state.notice).toEqual(state.payload);
    expect(state.rejection).toBe(-32001); expect(state.before).toEqual({ held: 1, initialized: true }); expect(state.after).toEqual({ held: 0, initialized: true });
    expect(state.cancelled).toBe(true); expect(state.disconnected).toBe(true); expect(state.reconnect).toEqual({ fresh: true }); expect(state.timers).toBe(0);
    expect(state.released).toEqual({ disposed: true, pendingRequests: 0, incomingRequests: 0, requestHandlers: 0, notificationHandlers: 0 }); expect(page.workers()).toHaveLength(0);
});
test("binary messages close the text transport and release pending requests", async ({ page }) => {
    const state = await page.evaluate(() => window.protocolFixture.binaryRejection()); expect(state.reason).toContain("text messages");
    expect(state.snapshot).toEqual({ disposed: true, pendingRequests: 0, incomingRequests: 0, requestHandlers: 0, notificationHandlers: 0 }); expect(state.timers).toBe(0);
});
test("cancelling socket opening rejects without creating protocol ownership", async ({ page, browserName, browserErrors }) => {
    const endpoint = new URL("/lsp-fixture", page.url()); endpoint.protocol = "ws:";
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
    expect(await page.evaluate(() => window.protocolFixture.abortOpening())).toBe(true);
});
for (const large of [false, true]) test(`LSP session synchronizes ${large ? "100k-line" : "mixed-newline"} documents and owns registration/reconnect`, async ({ page }) => {
    const state = await page.evaluate(large => window.protocolFixture.sessionJourney(large), large);
    expect(state.remote).toEqual({ uri: state.uri, version: 2, length: state.length, text: state.expectedSample, syncFailures: [] });
    expect(state.boundedReads.exports).toBe(0); expect(state.boundedReads.before).toBeLessThan(64); expect(state.boundedReads.after).toBeLessThan(64);
    expect(state.available).toBe(true); expect(state.withdrawn).toBe(true); expect(state.fresh).toBe(true);
    expect(state.hover).toMatchObject({ contents: { kind: "plaintext", value: expect.stringContaining(state.uri) } }); expect(state.custom).toEqual({ uri: state.uri, extension: "host-owned" });
    expect(state.reopened).toMatchObject({ uri: state.uri, version: 1, text: state.expectedReopened, syncFailures: [] });
    expect(state.ownership).toEqual({ documents: 0, remoteDocuments: 0, registrations: 0, subscriptions: 0, scheduledTasks: 0, pendingDocumentRequests: 0, pendingRequests: 0, incomingRequests: 0 });
    expect(state.timers).toBe(0); expect(page.workers()).toHaveLength(0);
});
