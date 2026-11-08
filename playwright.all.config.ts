import { defineConfig } from "@playwright/test";
import base from "./playwright.config.ts";

// The full three-engine matrix includes long integrated workflows; each test keeps its own timeout.
export default defineConfig(base, { globalTimeout: 2_400_000, projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
] });
