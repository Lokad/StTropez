import { chromium } from "@playwright/test";
import { startServer } from "./serve.mjs";

export async function openHarness() {
    const server = await startServer(0, { watch: false });
    /** @type {import("@playwright/test").Browser | undefined} */
    let browser;
    try {
        const owner = (browser = await chromium.launch({ headless: true }));
        const page = await owner.newPage({ baseURL: server.url, viewport: { width: 1440, height: 900 } });
        /** @type {string[]} */
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
            if (message.type() === "error") errors.push(message.text());
        });
        // Callers own the initial route, readiness and any deliberate warm-up.
        return {
            browser: owner,
            page,
            errors,
            buildMode: server.buildMode,
            close: async () => {
                try {
                    await owner.close();
                } finally {
                    await server.close();
                }
            }
        };
    } catch (error) {
        try {
            await browser?.close();
        } finally {
            await server.close();
        }
        throw error;
    }
}
