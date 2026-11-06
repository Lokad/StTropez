import { defineConfig } from "@playwright/test";
import base from "./playwright.config.ts";

// Visual navigation adds hundreds of actual key sequences per engine; each test keeps its own timeout.
export default defineConfig(base, { globalTimeout: 660_000, projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
] });
