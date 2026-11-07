import { defineConfig } from "@playwright/test";
import base from "./playwright.config.ts";

// The matrix includes hundreds of real editing workflows per engine; each test keeps its own timeout.
export default defineConfig(base, { globalTimeout: 1_500_000, projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
] });
