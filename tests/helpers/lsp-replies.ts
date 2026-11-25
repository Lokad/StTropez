import { expect, type Page, type WebSocketRoute } from "@playwright/test";

/** Hold a completed response so cancellation cannot prevent the stale reply being tested. */
export async function holdLspReplies(page: Page, method: string, kind?: "prepared" | "background") {
    let requests = 0;
    let hold = false, heldId: number | undefined, heldRoute: WebSocketRoute | undefined, release: (() => void) | undefined, cancelled = false;
    await page.routeWebSocket("**/lsp-fixture", client => {
        const server = client.connectToServer();
        client.onMessage(message => {
            const value = JSON.parse(message.toString());
            if (value.method === method && (!kind || (value.params?._fixture !== undefined) === (kind === "prepared"))) {
                requests++;
                if (hold) {
                    hold = false;
                    heldId = value.id;
                    heldRoute = client;
                }
            }
            if (client === heldRoute && value.method === "$/cancelRequest" && value.params.id === heldId) cancelled = true;
            server.send(message);
        });
        server.onMessage(message => {
            const value = JSON.parse(message.toString());
            if (client === heldRoute && heldId !== undefined && value.id === heldId) {
                expect(value.error).toBeUndefined(); expect(value.result).toBeTruthy();
                release = () => client.send(message);
            } else client.send(message);
        });
    });
    return {
        requestCount: () => requests,
        hold: () => { expect(hold).toBe(false); expect(release).toBeUndefined(); hold = true; heldId = undefined; heldRoute = undefined; cancelled = false; },
        waiting: () => release !== undefined, cancelled: () => cancelled,
        release: async () => {
            expect(release).toBeDefined(); const send = release!; release = undefined; heldId = undefined; heldRoute = undefined; send();
            // A later reply on the same stream fences delivery before checking presentation.
            await page.evaluate(() => window.hostFixture.providerCustom("fixture/state", {}));
        },
    };
}
