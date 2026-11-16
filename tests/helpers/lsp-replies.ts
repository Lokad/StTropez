import { expect, type Page } from "@playwright/test";

/** Hold a completed response so cancellation cannot prevent the stale reply being tested. */
export async function holdLspReplies(page: Page, method: string) {
    let hold = false, heldId: number | undefined, release: (() => void) | undefined, cancelled = false;
    await page.routeWebSocket("**/lsp-fixture", client => {
        const server = client.connectToServer();
        client.onMessage(message => {
            const value = JSON.parse(message.toString());
            if (hold && value.method === method) { hold = false; heldId = value.id; }
            if (value.method === "$/cancelRequest" && value.params.id === heldId) cancelled = true;
            server.send(message);
        });
        server.onMessage(message => {
            const value = JSON.parse(message.toString());
            if (heldId !== undefined && value.id === heldId) {
                expect(value.error).toBeUndefined(); expect(value.result).toBeTruthy();
                release = () => client.send(message);
            } else client.send(message);
        });
    });
    return {
        hold: () => { expect(hold).toBe(false); expect(release).toBeUndefined(); hold = true; heldId = undefined; cancelled = false; },
        waiting: () => release !== undefined, cancelled: () => cancelled,
        release: async () => {
            expect(release).toBeDefined(); const send = release!; release = undefined; send();
            // A later reply on the same stream fences delivery before checking presentation.
            await page.evaluate(() => window.hostFixture.providerCustom("fixture/state", {}));
        },
    };
}
