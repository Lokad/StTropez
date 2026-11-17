import { chromium } from "@playwright/test";
import { startServer } from "./serve.mjs";

export async function openHarness() {
    const server = await startServer(0, { watch: false });
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ baseURL: server.url, viewport: { width: 1440, height: 900 } });
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
        // Callers own the initial route, readiness and any deliberate warm-up.
        return { browser, page, errors, buildMode: server.buildMode, close: async () => { try { await browser.close(); } finally { await server.close(); } } };
    } catch (error) {
        try { await browser?.close(); } finally { await server.close(); }
        throw error;
    }
}
