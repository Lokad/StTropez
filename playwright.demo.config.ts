import { defineConfig } from "@playwright/test";

const published = process.env.STTROPEZ_DEMO_URL;
const baseURL = published ?? `http://127.0.0.1:${process.env.STTROPEZ_DEMO_PORT ?? "4174"}/StTropez/`;
export default defineConfig({
    testDir: "tests/browser", testMatch: "static-demo.spec.ts", timeout: 120000, retries: 0, workers: 1, forbidOnly: true,
    outputDir: "artifacts/pages-test-results",
    reporter: [["list"], ["json", { outputFile: "artifacts/pages-browser-results.json" }]],
    use: { baseURL, headless: true, viewport: { width: 1440, height: 900 },
        screenshot: "only-on-failure", trace: "retain-on-failure" },
    projects: ["chromium", "firefox", "webkit"].map(name => ({ name, use: { browserName: name as "chromium" | "firefox" | "webkit" } })),
    webServer: published ? [] : { command: "npm run preview:demo", url: baseURL, reuseExistingServer: !process.env.CI, timeout: 30000 },
});
