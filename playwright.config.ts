import { defineConfig } from "@playwright/test";
import { availableParallelism } from "node:os";

const baseURL = `http://127.0.0.1:${process.env.STTROPEZ_PORT ?? "4173"}`;
export default defineConfig({
    testDir: "tests/browser",
    testIgnore: "static-demo.spec.ts",
    timeout: 30_000,
    // The expanded inventory includes long integrated journeys; individual deadlines stay separate.
    globalTimeout: 1_800_000,
    forbidOnly: true,
    retries: 0,
    workers: Math.min(4, availableParallelism()),
    reporter: [["list"], ["json", { outputFile: "artifacts/browser-results.json" }]],
    use: { baseURL, headless: true, viewport: { width: 1440, height: 900 },
        trace: "retain-on-failure", screenshot: "only-on-failure" },
    projects: [{ name: "chromium", use: { browserName: "chromium" } }],
    webServer: { command: "npm run dev", url: baseURL, reuseExistingServer: false, timeout: 30_000 },
});
