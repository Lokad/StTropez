import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/** Delay actual provider metadata until another feature has a visible captured result. */
export async function holdDemoFolds(page: Page, name: string): Promise<() => Promise<void>> {
    const replies: (() => void)[] = []; let held = true;
    await page.routeWebSocket("**/demo-provider/*", client => {
        const server = client.connectToServer(), requests = new Set<number>();
        client.onMessage(message => { const value = JSON.parse(message.toString());
            if (value.method === "textDocument/foldingRange" && value.params.textDocument.uri.endsWith(`/${name}`)) requests.add(value.id);
            server.send(message);
        });
        server.onMessage(message => { const value = JSON.parse(message.toString());
            if (requests.delete(value.id) && held) replies.push(() => client.send(message)); else client.send(message);
        });
    });
    return async () => { await expect.poll(() => replies.length).toBeGreaterThan(0); held = false; for (const reply of replies.splice(0)) reply(); };
}
