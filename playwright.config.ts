import { defineConfig } from "@playwright/test";

export default defineConfig({
    testDir: "tests/browser",
    timeout: 30_000,
    // Page-wide keyboard workflows add traversal time; each test keeps its 30s limit.
    globalTimeout: 480_000,
    forbidOnly: true,
    retries: 0,
    workers: 1,
    reporter: [["list"], ["json", { outputFile: "artifacts/browser-results.json" }]],
    use: { baseURL: "http://127.0.0.1:4173", headless: true, viewport: { width: 1440, height: 900 },
        trace: "retain-on-failure", screenshot: "only-on-failure" },
    projects: [{ name: "chromium", use: { browserName: "chromium" } }],
    webServer: { command: "npm run dev", url: "http://127.0.0.1:4173", reuseExistingServer: false, timeout: 30_000 },
});
