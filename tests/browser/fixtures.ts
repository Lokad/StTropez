import { test as base, expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { captureBrowserErrors } from "../helpers/browser-errors.ts";

export { expect };

export function warnsBeforeUnload(page: Page): Promise<boolean> {
    return page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })));
}

/** Keep zero-delay command continuations beyond the clock's paused tick. */
export async function pauseBetweenCommandTurns(page: Page) {
    await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now() + 1000)));
    const restore = await page.evaluateHandle(() => {
        const host: Window = window;
        const schedule = host.setTimeout;
        host.setTimeout = (callback, delay = 0, ...args) => schedule(callback, Math.max(1, delay), ...args);
        return () => { host.setTimeout = schedule; };
    });
    return async () => {
        await restore.evaluate(reset => reset());
        await restore.dispose();
        await page.clock.resume();
    };
}

export async function expectPanelKeyReserved(control: Locator, key: "Escape" | "Enter" | "ArrowRight") {
    const consumed = await control.evaluate((node, key) => [
        { keyCode: 229 }, { modifierAltGraph: true }, { isComposing: true }, { shiftKey: true },
    ].map(detail => {
        const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...detail });
        node.dispatchEvent(event);
        return event.defaultPrevented;
    }), key);
    expect(consumed).toEqual([false, false, false, false]);
    await expect(control).toBeFocused();
}

/** Scheduled editor work only. Specs separately await services, mount counts and native controls. */
export async function ready(page: Page, timeout = 30_000): Promise<void> {
    await page.waitForFunction(() => (window.hostFixture ?? window.editingFixture ?? window.viewportFixture ?? window.comparisonFixture)?.settled === true,
        undefined, { timeout });
}

export const test = base.extend<{ browserErrors: ReturnType<typeof captureBrowserErrors> }>({
    browserErrors: [async ({ context }, use) => {
        const errors = captureBrowserErrors(context);
        try { await use(errors); }
        finally { errors.dispose(); errors.assertClean(); }
    }, { auto: true }],
});

// Protocol journeys own their background process; teardown avoids the unresolved Firefox
// context-deletion path while still applying the same error guard to their actual context.
export const isolatedTest = test.extend({ context: async ({ playwright, browserName, baseURL }, use) => {
    const browser = await playwright[browserName].launch({ headless: true });
    try { await use(await browser.newContext({ ...(baseURL ? { baseURL } : {}), viewport: { width: 1440, height: 900 } })); }
    finally { await browser.close(); }
} });
