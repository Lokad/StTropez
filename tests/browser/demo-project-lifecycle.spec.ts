import { build } from "esbuild";
import { test, expect } from "./fixtures.ts";

test("the focused sample picker can move past a pending project and return to the same load", async ({ page }) => {
    type Probe = { reads: number; release?: () => void };
    await page.addInitScript(() => {
        const get = IDBObjectStore.prototype.get;
        const probe: Probe = { reads: 0 };
        Object.assign(window, { shippingLoad: probe });
        IDBObjectStore.prototype.get = function (key) {
            const request = get.call(this, key);
            if (this.transaction.db.name === "sttropez-demo-projects-v1" && key === "shipping") {
                probe.reads++;
                this.transaction.addEventListener("complete", event => {
                    event.stopImmediatePropagation();
                    const tx = this.transaction;
                    probe.release = () => tx.dispatchEvent(new Event("complete"));
                }, { capture: true, once: true });
            }
            return request;
        };
    });
    await page.goto("/"); const picker = page.locator("#sample");
    await expect(picker).toBeEnabled(); await picker.focus();
    const step = async (key: string, id: string) => {
        await page.keyboard.press(key);
        await expect(picker).toHaveValue(id);
        await expect(picker).toBeFocused();
    };
    await step("ArrowDown", "shipping");
    await expect.poll(() => page.evaluate(() => (window as unknown as { shippingLoad: Probe }).shippingLoad.release !== undefined)).toBe(true);
    await step("ArrowDown", "errors");
    await expect(page.locator("#description")).toHaveText(/error/i);
    await step("ArrowUp", "shipping");
    await step("ArrowDown", "errors");
    await page.evaluate(async () => {
        (window as unknown as { shippingLoad: Probe }).shippingLoad.release!();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await expect(picker).toHaveValue("errors");
    await expect(page.locator("#description")).toHaveText(/error/i);
    await step("ArrowUp", "shipping");
    await expect(page.getByRole("textbox", { name: "shipping.ts", exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { shippingLoad: Probe }).shippingLoad.reads)).toBe(1);
    await expect(picker).toBeFocused();
});

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
    const compare = page.getByRole("button", { name: "Compare", exact: true });
    const panels = page.locator("[data-panel]"), save = page.getByRole("button", { name: "Save locally" });
    await expect(compare).toBeDisabled(); await expect(save).toBeDisabled();
    await expect(page.locator("[data-panel]:disabled")).toHaveCount(await panels.count());
    await sample.selectOption("errors");
    await expect(compare).toBeEnabled(); await expect(save).toBeEnabled();
    await expect(page.locator("[data-panel]:disabled")).toHaveCount(0);
    await expect(source).toBeVisible(); await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30_000 });
    await sample.selectOption("pricing");
    await expect(source).toBeVisible(); await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30_000 });
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
    await expect(page.locator("#language-status")).toHaveText("Language ready", { timeout: 30_000 });
    await sample.selectOption("pricing"); await expect(page.locator("#editor")).toContainText("/* retained edit */");
});
