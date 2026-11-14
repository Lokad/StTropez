import { test as base } from "@playwright/test";
import { captureBrowserErrors } from "../helpers/browser-errors.ts";

export { expect } from "@playwright/test";
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
