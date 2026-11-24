import { defineConfig, type Project } from "@playwright/test";
import { availableParallelism } from "node:os";

const port = process.env.STTROPEZ_PORT ?? "4183";
const baseURL = `http://127.0.0.1:${port}`;
export const visibleScrollbars: Project = {
    name: "chromium-scrollbars",
    testMatch: ["editor-pointer-focus.spec.ts", "host-pointer.spec.ts", "viewport.spec.ts", "comparison.spec.ts", "folding.spec.ts"],
    use: { browserName: "chromium", launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } },
};
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
    projects: [{ name: "chromium", use: { browserName: "chromium" } }, visibleScrollbars],
    webServer: { command: "npm run dev", env: { STTROPEZ_PORT: port }, url: baseURL, reuseExistingServer: false, timeout: 30_000 },
});
