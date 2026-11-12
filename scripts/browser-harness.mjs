import { chromium } from "@playwright/test";
import { startServer } from "./serve.mjs";

export async function openHarness() {
    const server = await startServer(0);
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
        await page.goto(new URL("/workspace/", server.url).href);
        await page.waitForFunction(() => window.sttropez?.ready === true);
        return { browser, page, errors, close: async () => { await browser.close(); await server.close(); } };
    } catch (error) {
        await browser?.close();
        await server.close();
        throw error;
    }
}
