import { mkdir } from "node:fs/promises";
import { openHarness } from "./browser-harness.mjs";

const directory = "artifacts/inspect";
const harness = await openHarness();
try {
    await mkdir(directory, { recursive: true });
    const { page } = harness;
    await page.goto("/?provider=browser");
    await page.locator("#language-status").filter({ hasText: "Language ready" }).waitFor();
    await page.screenshot({ path: directory + "/demo.png", fullPage: true });

    await page.goto("/reference/");
    await page.getByRole("textbox", { name: "quote.ts" }).waitFor();
    await page.locator(".st-viewport-row").filter({ hasText: "export" }).first().waitFor();
    await page.screenshot({ path: directory + "/reference.png", fullPage: true });
    if (harness.errors.length) throw new Error(harness.errors.join("\n"));
    console.log("Wrote demo.png and reference.png to " + directory);
} finally {
    await harness.close();
}
