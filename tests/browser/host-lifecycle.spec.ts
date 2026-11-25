import { fixtureModules } from "../helpers/fixture-modules.ts";
import { test, expect } from "./fixtures.ts";

for (const mode of ["plain", "react"] as const) test(`${mode} boots without fixture installation and retains cached-page state until final hide`, async ({ page }, testInfo) => {
    testInfo.annotations.push({ type: "page-transition-policy", description: "Synthetic persisted/final pagehide events exercise host policy; real back/forward-cache eligibility is not asserted." });
    const serveModules = fixtureModules({ [`host-${mode}`]: `tests/fixtures/hosts/${mode}-entry.ts` }, [{
        name: "omit-fixture-installation",
        setup(builder) {
            builder.onLoad({ filter: /[\\/]hosts[\\/]harness\.ts$/ }, () => ({
                contents: "export function installHostHarness() {}", loader: "ts",
            }));
        },
    }]);
    await serveModules(page, "/");
    await page.goto(`/hosts/${mode}/`);
    const primary = page.getByRole("textbox", { name: "Primary source", exact: true });
    await expect(primary).toBeVisible(); expect(await page.evaluate(() => typeof window.hostFixture)).toBe("undefined");
    await primary.press("End"); await primary.pressSequentially(" kept"); await expect(primary).toHaveValue("start kept");
    await primary.evaluate(node => { node.dataset.retained = "yes"; });
    for (let index = 0; index < 2; index++) {
        await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })); window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); });
        await expect(primary).toHaveAttribute("data-retained", "yes"); await expect(primary).toHaveValue("start kept");
    }
    await primary.pressSequentially(" later"); await expect(primary).toHaveValue("start kept later");
    await page.getByRole("button", { name: "Recover views", exact: true }).click();
    await expect(primary).toHaveValue("start kept later");
    await primary.focus();
    await expect(page.getByRole("button", { name: "Disconnect provider", exact: true })).toBeEnabled();
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false })));
    await expect(page.locator("#host")).toBeEmpty();
    await page.getByRole("button", { name: "Recover views", exact: true }).click();
    await expect(page.locator("#host")).toBeEmpty();
});
