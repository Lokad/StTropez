import { test } from "@playwright/test";
import { runDemoHostIntegrations } from "./demo-host-integrations.ts";

test("host language, structured/literal insertion and mapped notes share editing and review", async ({ page }) => {
    await runDemoHostIntegrations(page);
});
