import { mkdir, writeFile } from "node:fs/promises";
import { openHarness } from "./browser-harness.mjs";

const harness = await openHarness();
try {
    await mkdir("artifacts/inspect", { recursive: true });
    await harness.page.screenshot({ path: "artifacts/inspect/playground.png", fullPage: true });
    const snapshot = await harness.page.evaluate(() => window.sttropez.snapshot());
    await writeFile("artifacts/inspect/state.json", JSON.stringify({ browser: harness.browser.version(), snapshot, errors: harness.errors }, null, 2));
    if (harness.errors.length) throw new Error(harness.errors.join("\n"));
    console.log("Wrote artifacts/inspect/playground.png and state.json");
} finally { await harness.close(); }
