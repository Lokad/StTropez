import { defineConfig } from "@playwright/test";
import { availableParallelism } from "node:os";

const port = process.env.STTROPEZ_PORT ?? "4183";
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
    testDir: "tests/browser",
    testIgnore: "static-demo.spec.ts",
    timeout: 30_000,
    globalTimeout: 1_800_000,
    forbidOnly: true,
    retries: 0,
    workers: Math.min(4, availableParallelism()),
    reporter: process.argv.includes("--list") ? "list" : [["list"], ["json", { outputFile: "artifacts/browser-results.json" }]],
    use: { baseURL, headless: true, viewport: { width: 1440, height: 900 },
        trace: "retain-on-failure", screenshot: "only-on-failure" },
    projects: (["chromium", "firefox", "webkit"] as const).map(browserName => ({
        name: browserName,
        use: { browserName },
    })),
    webServer: { command: "node scripts/serve.mjs", env: { STTROPEZ_PORT: port }, url: baseURL, reuseExistingServer: false, timeout: 30_000 },
});
