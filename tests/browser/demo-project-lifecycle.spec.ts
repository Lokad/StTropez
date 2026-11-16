import { build } from "esbuild";
import { test, expect } from "./fixtures.ts";

test("failed project opening leaves startup and the current sample retryable", async ({ page }) => {
    // Patch only the project factory boundary; model tests own construction/rollback faults.
    const built = await build({ stdin: { resolveDir: process.cwd(), contents: `
        import { DemoProject } from "./examples/demo/project.ts";
        const state = { armed: true, reported: 0, failure: new Error("Injected project startup failure") };
        window.demoProjectFailure = state;
        const open = DemoProject.open, report = console.error;
        DemoProject.open = async (...args) => {
            if (state.armed) { state.armed = false; throw state.failure; }
            return open(...args);
        };
        console.error = (...args) => {
            if (args.length === 1 && args[0] === state.failure) { state.reported++; return; }
            report(...args);
        };
        await import("./examples/demo/main.ts");
    ` }, outdir: "artifacts/demo-project-lifecycle", bundle: true, format: "esm", platform: "browser", target: "es2022", write: false });
    await page.route("**/app.js", route => route.fulfill({ contentType: "text/javascript", body: built.outputFiles.find(file => file.path.endsWith(".js"))!.text }));
    await page.goto("/");
    const sample = page.locator("#sample"), source = page.getByRole("textbox", { name: "main.ts", exact: true });
    await expect(page.locator("#status")).toContainText("Could not open this sample");
    await expect(sample).toBeEnabled(); await expect(source).toHaveCount(0);
    await sample.selectOption("errors");
    await expect(source).toBeVisible(); await expect(page.locator("#language-status")).toHaveText("Language ready");
    await sample.selectOption("pricing");
    await expect(source).toBeVisible(); await expect(page.locator("#language-status")).toHaveText("Language ready");
    await source.press("Control+Home"); await source.pressSequentially("/* retained edit */");
    await page.evaluate(() => { (window as unknown as { demoProjectFailure: { armed: boolean } }).demoProjectFailure.armed = true; });
    await sample.selectOption("unicode");
    await expect(page.locator("#status")).toContainText("Could not open this sample");
    await expect(sample).toBeEnabled(); await expect(sample).toHaveValue("pricing");
    await expect(source).toBeVisible(); await expect(page.locator("#editor")).toContainText("/* retained edit */");
    await source.press("Control+z"); await expect(page.locator("#editor")).not.toContainText("/* retained edit */");
    await source.press("Control+y"); await source.press("Control+s");
    await expect(page.locator("#status")).toContainText("Saved in this browser");
    expect(await page.evaluate(() => (window as unknown as { demoProjectFailure: { reported: number } }).demoProjectFailure.reported)).toBe(2);
    await sample.selectOption("unicode");
    await expect(page.getByRole("textbox", { name: "greetings.ts", exact: true })).toBeVisible();
    await expect(page.locator("#language-status")).toHaveText("Language ready");
    await sample.selectOption("pricing"); await expect(page.locator("#editor")).toContainText("/* retained edit */");
});
